import assert from "node:assert/strict";
import { test, mock } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Pool, type PoolClient } from "pg";
import { GET as mediaGet, HEAD as mediaHead } from "../app/api/media/[mediaId]/file/route";
import { GET as previewGet, HEAD as previewHead } from "../app/api/import/conflict/preview/route";
import { acquireDestinationLock } from "./destination-lock";
import { mockStorageMount, writeTestStorageMarker } from "./testing/storage-fixture";

const id = "12345678-1234-4234-8234-123456789abc";
type Media = { media_id: number; file_name: string; file_type: string; path: string };
async function fixture(action: (state: {
    root: string; target: string; staged: string; media: Media | undefined;
    queryCount: number; beforeQuery?: () => void;
    mount: Awaited<ReturnType<typeof mockStorageMount>>;
}) => Promise<void>) {
    const root = await fs.mkdtemp(path.join(tmpdir(), "gallery-media-route-"));
    await writeTestStorageMarker(root); const mount = await mockStorageMount(root);
    const target = path.join(root, "photo.jpg"); await fs.writeFile(target, "image bytes");
    const directory = path.join(root, ".incoming", id); await fs.mkdir(directory, { recursive: true });
    const staged = path.join(directory, "incoming.mp4"); await fs.writeFile(staged, "video bytes");
    await fs.writeFile(path.join(directory, ".conflict.json"), JSON.stringify({ type: "FILENAME", conflictId: id, jobId: "job", existingMediaId: 1, existingPath: target }));
    const state = { root, target, staged, media: { media_id: 1, file_name: "photo.jpg", file_type: "IMAGE", path: target } as Media | undefined,
        queryCount: 0, beforeQuery: undefined as (() => void) | undefined, mount };
    let checkouts = 0, releases = 0;
    const connect = mock.method(Pool.prototype, "connect", async () => {
        checkouts++;
        return {
            query: async (sql: string) => {
                assert.match(sql.replace(/\s+/g, " ").trim(), /^SELECT media_id, file_name, file_type, path FROM media WHERE media_id = \$1$/);
                state.queryCount++; state.beforeQuery?.(); return { rows: state.media ? [{ ...state.media }] : [] };
            }, release: () => { releases++; },
        } as unknown as PoolClient;
    });
    try { await action(state); assert.equal(releases, checkouts); }
    finally { connect.mock.restore(); mount.restore(); await fs.rm(root, { recursive: true, force: true }); }
}
const context = (mediaId = "1") => ({ params: Promise.resolve({ mediaId }) });
const request = (method = "GET", headers?: Record<string, string>) => new Request("http://gallery.test/api/media/1/file", { method, headers });
const preview = (side = "incoming", method = "GET", headers?: Record<string, string>, conflictId = id) => new Request(`http://gallery.test/api/import/conflict/preview?id=${conflictId}&side=${side}`, { method, headers });

test("original GET and HEAD routes stream image data and apply Range headers", () => fixture(async state => {
    const full = await mediaGet(request(), context()); assert.equal(full.status, 200); assert.equal(full.headers.get("content-type"), "image/jpeg"); assert.equal(await full.text(), "image bytes");
    const range = await mediaGet(request("GET", { Range: "bytes=1-3" }), context()); assert.equal(range.status, 206); assert.equal(await range.text(), "mag");
    const head = await mediaHead(request("HEAD"), context()); assert.equal(head.status, 200); assert.equal(head.body, null); assert.equal(head.headers.get("content-length"), "11");
    assert.equal(state.queryCount, 6, "Resolve and revalidate each media selection under ownership");
}));

test("incoming and existing conflict previews retain MIME/no-store restrictions and support HEAD/Range", () => fixture(async () => {
    for (const side of ["incoming", "existing"]) {
        const full = await previewGet(preview(side)); assert.equal(full.status, 200);
        assert.equal(full.headers.get("content-type"), side === "incoming" ? "video/mp4" : "image/jpeg");
        assert.match(full.headers.get("cache-control")!, /no-store/); assert.equal(full.headers.get("x-content-type-options"), "nosniff");
        assert.equal(await full.text(), side === "incoming" ? "video bytes" : "image bytes");
        const range = await previewGet(preview(side, "GET", { Range: "bytes=-5" })); assert.equal(range.status, 206); assert.equal(await range.text(), "bytes");
        const head = await previewHead(preview(side, "HEAD", { Range: "bytes=999-" })); assert.equal(head.status, 200); assert.equal(head.body, null);
    }
}));

test("invalid IDs, absent metadata/files, and unsupported previews fail without disclosure", () => fixture(async state => {
    assert.equal((await mediaGet(request(), context("bad"))).status, 400);
    state.media = undefined; assert.equal((await mediaGet(request(), context())).status, 404);
    assert.equal((await previewGet(preview("invalid"))).status, 404);
    assert.equal((await previewGet(preview("incoming", "GET", undefined, "..%2F..%2Fsecret"))).status, 404);
    await fs.rename(state.staged, path.join(path.dirname(state.staged), "incoming.txt"));
    assert.equal((await previewGet(preview())).status, 415);
    await fs.rm(path.join(path.dirname(state.staged), ".conflict.json"));
    assert.equal((await previewGet(preview())).status, 404);
    const head = await previewHead(preview("existing", "HEAD")); assert.equal(head.status, 404); assert.equal(head.body, null);
}));

test("metadata deletion or path change between selection and open is rejected", () => fixture(async state => {
    state.beforeQuery = () => { if (state.queryCount === 2) state.media = undefined; };
    assert.equal((await mediaGet(request(), context())).status, 404);
    state.media = { media_id: 1, file_name: "photo.jpg", file_type: "IMAGE", path: state.target };
    state.queryCount = 0;
    state.beforeQuery = () => { if (state.queryCount === 2) state.media!.path = path.join(state.root, "other.jpg"); };
    assert.equal((await mediaGet(request(), context())).status, 409);
}));

test("original route cannot expose staging, backup, journal, or traversal paths from metadata", () => fixture(async state => {
    const alias = path.join(state.root, "alias.jpg"); await fs.symlink(state.target, alias);
    const directory = path.join(state.root, "not-a-file"); await fs.mkdir(directory);
    for (const bad of [alias, directory, state.staged, state.target + ".backup-" + id, path.join(state.root, ".replacement-operations", id + ".json"), "/etc/passwd", state.root + "/x/../photo.jpg"]) {
        state.media!.path = bad;
        const response = await mediaGet(request(), context()); assert.equal(response.status, 404); assert.deepEqual(await response.json(), { error: "Media unavailable" });
    }
}));

test("storage failure and retained locks reject original and incoming preview opens", () => fixture(async state => {
    state.mount.state.mounted = false;
    const original = await mediaGet(request(), context()); assert.equal(original.status, 503); assert.equal(original.headers.get("retry-after"), "1");
    assert.equal((await previewGet(preview())).status, 503);
    state.mount.state.mounted = true;
    const lock = await acquireDestinationLock(state.root, state.target);
    assert.equal((await mediaGet(request(), context())).status, 503);
    assert.equal((await previewGet(preview())).status, 503);
    await lock.release();
}));

test("active conflict resolution blocks previews and a missing original returns 404", () => fixture(async state => {
    const resolution = path.join(path.dirname(state.staged), ".resolution-lock"); await fs.mkdir(resolution);
    assert.equal((await previewGet(preview())).status, 404);
    await fs.rmdir(resolution); await fs.unlink(state.target);
    assert.equal((await mediaGet(request(), context())).status, 404);
}));
