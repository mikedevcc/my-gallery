import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { mock, test } from "node:test";
import { Pool } from "pg";
import { assertMediaSegment, assertOriginalMediaPath, assertStagedMediaPath, InvalidMediaPathError } from "./media-paths";
import { buildDestinationPath, stageMediaFile, finalizeStagedMedia, findStagedConflictFile, destinationExists, removeEmptyParentDirectories } from "./media-storage";
import { acquireDestinationLock, DestinationBusyError } from "./destination-lock";
import { deleteMediaAtDestination, replaceMediaAtDestination } from "./media-mutations";
import { getOrCreateThumbnail, deleteThumbnail } from "./media-thumbnail";
import { acquireResolutionClaim } from "./conflict-resolution-lock";
import { savePendingConflict, getConflictPreviewSelection } from "./pending-import-conflicts";
import { readStorageFile, storageMarkerName, validateStorage } from "./storage-safety";
import { prepareReplacementJournal, readReplacementJournal } from "./replacement-recovery";
import { streamMediaFile, mediaErrorResponse } from "./media-stream";
import { mockStorageMount, writeTestStorageMarker } from "./testing/storage-fixture";
import type { ImportedMedia } from "./media-import";

const id = "12ec0585-07cb-4e3c-9d84-1ec28cb40a82";
const badNames = ["", " ", ".", "..", "../photo.jpg", "a/b.jpg", "a\\b.jpg", "/photo.jpg", "photo\0.jpg", "photo\n.jpg",
    "photo\r.jpg", "photo\t.jpg", "photo\u0085.jpg", "photo\u202e.jpg", "photo\ud800.jpg", "a".repeat(256), "🌈".repeat(64),
    ".incoming", ".INCOMING", ".destination-locks", ".replacement-operations", ".deletion-operations", ".thumbnails", ".resolution-lock", ".conflict.json", ".mygallery-storage.json",
    `photo.jpg.backup-${id}`, `photo.jpg.publish-${id}`, `.owner-${id}.tmp`];
const image = (fileName: string): ImportedMedia => ({ file: { fileName, fileType: "IMAGE", fileSize: 1, absolutePath: "unused", extension: ".jpg" }, media: {} });
async function fixture(action: (root: string) => Promise<void>) {
    const root = await fs.mkdtemp(path.join(tmpdir(), "gallery-m14-test-"));
    await writeTestStorageMarker(root); const mount = await mockStorageMount(root);
    const checkout = mock.method(Pool.prototype, "connect", async () => { assert.fail("M14 tests must never connect to a database"); });
    try { await action(root); }
    finally { checkout.mock.restore(); mount.restore(); await fs.rm(root, { recursive: true, force: true }); }
}
async function stagedFixture(root: string, fileName = "incoming.jpg") {
    const job = path.join(root, ".incoming", id); await fs.mkdir(job, { recursive: true });
    const staged = path.join(job, fileName); await fs.writeFile(staged, "incoming");
    return { job, staged };
}

for (const name of badNames) {
    test(`upload rejects invalid/reserved name ${JSON.stringify(name)} before creating a job or reading its stream`, () => fixture(async root => {
        let streamed = false;
        const file = { name, stream() { streamed = true; throw new Error("must not read input"); } } as unknown as File;
        await assert.rejects(stageMediaFile(file), InvalidMediaPathError);
        assert.equal(streamed, false); assert.deepEqual(await fs.readdir(root), [storageMarkerName]);
        assert.throws(() => buildDestinationPath(image(name), "Paris"), InvalidMediaPathError);
    }));
}

test("city metadata is a single directory segment; country/job labels are not path components", () => fixture(async root => {
    for (const city of ["../outside", "Paris/../../.incoming", "Paris\\Rome", "\nParis", ".", "..", "", " ", ".hidden", ".thumbnails", ".destination-locks", ".deletion-operations", "x".repeat(256)]) {
        assert.throws(() => buildDestinationPath(image("photo.jpg"), city), InvalidMediaPathError);
    }
    assert.throws(() => buildDestinationPath(image("photo.jpg"), 42 as unknown as string), InvalidMediaPathError);
    assert.equal(buildDestinationPath(image("photo.jpg")), path.join(root, "Unknown", "Unknown", "photo.jpg"));
    assert.deepEqual(await fs.readdir(root), [storageMarkerName]);
}));

for (const name of ["été à Paris.jpg", "東京🌈.jpg", "👨‍👩‍👧‍👦.jpg", "Cafe\u0301.jpg", "100% photo (1).jpg", " leading and trailing .jpg ", ".holiday.jpg", "CON.jpg", "a∕b.jpg", "%2e%2e.jpg"]) {
    test(`legitimate Linux/Unicode filename ${JSON.stringify(name)} keeps its exact spelling`, () => fixture(async root => {
        assertMediaSegment(name);
        const staged = await stageMediaFile(new File(["image"], name)); assert.equal(path.basename(staged), name);
        const destination = buildDestinationPath(image(name), "São Paulo 東京");
        let inserted: string | undefined;
        await finalizeStagedMedia(staged, destination, async finalPath => { inserted = finalPath; });
        assert.equal(inserted, destination); assert.equal(await fs.readFile(destination, "utf8"), "image");
        const lock = await acquireDestinationLock(root, destination); await lock.release();
    }));
}

test("original writers reject every private namespace before locks, file publication or metadata callbacks", () => fixture(async root => {
    const staged = path.join(root, "incoming.jpg"); await fs.writeFile(staged, "incoming");
    const targets = [".incoming", ".destination-locks", ".replacement-operations", ".deletion-operations", ".thumbnails", ".resolution-lock"].map(name => path.join(root, name, "photo.jpg"));
    targets.push(path.join(root, storageMarkerName), path.join(root, ".conflict.json"), path.join(root, `photo.jpg.backup-${id}`), path.join(root, "2026", ".thumbnails", "photo.jpg"));
    let writes = 0;
    for (const destination of targets) {
        await assert.rejects(finalizeStagedMedia(staged, destination, async () => { writes++; }), InvalidMediaPathError);
        await assert.rejects(replaceMediaAtDestination({ root, destination, stagedPath: staged, mediaId: 1,
            revalidateMetadata: async () => { writes++; }, readReceipt: async () => undefined, updateMetadata: async () => { writes++; },
        }), InvalidMediaPathError);
        await assert.rejects(deleteMediaAtDestination({ root, destination, mediaId: 1, revalidateMetadata: async () => { writes++; return true; },
            deleteMetadata: async () => { writes++; return true; }, afterDelete: async () => { writes++; },
        }), InvalidMediaPathError);
        await assert.rejects(destinationExists(destination), InvalidMediaPathError);
    }
    assert.equal(writes, 0); await assert.rejects(fs.access(path.join(root, ".destination-locks")));
    assert.equal(await fs.readFile(staged, "utf8"), "incoming");
}));

test("canonicalization cannot hide raw traversal or control characters", () => fixture(async root => {
    for (const target of [root + "/city/../photo.jpg", root + "//photo.jpg", root + "/./photo.jpg", path.dirname(root) + "/outside.jpg", "relative.jpg", root + "/photo\\name.jpg", root + "/photo\n.jpg"]) {
        assert.throws(() => assertOriginalMediaPath(root, target), InvalidMediaPathError);
        await assert.rejects(acquireDestinationLock(root, target), InvalidMediaPathError);
    }
    assert.deepEqual(await fs.readdir(root), [storageMarkerName]);
}));

test("public aliases into private namespaces and outside storage cannot acquire locks", () => fixture(async root => {
    const outside = await fs.mkdtemp(path.join(tmpdir(), "gallery-m14-outside-"));
    try {
        for (const name of [".incoming", ".thumbnails", ".replacement-operations", ".deletion-operations", ".destination-locks"]) {
            await fs.mkdir(path.join(root, name));
            await fs.symlink(path.join(root, name), path.join(root, `alias-${name}`));
            await assert.rejects(acquireDestinationLock(root, path.join(root, `alias-${name}`, "file.jpg")), InvalidMediaPathError);
        }
        await fs.writeFile(path.join(outside, "file.jpg"), "outside"); await fs.symlink(outside, path.join(root, "escape"));
        await assert.rejects(finalizeStagedMedia(path.join(root, "unused.jpg"), path.join(root, "escape", "file.jpg")));
        assert.equal(await fs.readFile(path.join(outside, "file.jpg"), "utf8"), "outside");
    } finally { await fs.rm(outside, { recursive: true, force: true }); }
}));

test("ordinary in-root aliases still share a lock; retargeting one privately stops metadata mutation", () => fixture(async root => {
    const normal = path.join(root, "normal"), alias = path.join(root, "alias");
    await fs.mkdir(normal); await fs.symlink(normal, alias);
    const destination = path.join(alias, "photo.jpg"), canonical = path.join(normal, "photo.jpg");
    await fs.writeFile(canonical, "original");
    const owner = await acquireDestinationLock(root, canonical); await assert.rejects(acquireDestinationLock(root, destination), DestinationBusyError); await owner.release();
    await fs.mkdir(path.join(root, ".thumbnails")); let deleted = false;
    await assert.rejects(deleteMediaAtDestination({ root, destination, mediaId: 1,
        revalidateMetadata: async () => { await fs.unlink(alias); await fs.symlink(path.join(root, ".thumbnails"), alias); return true; },
        deleteMetadata: async () => { deleted = true; return true; }, afterDelete: async () => {},
    }));
    assert.equal(deleted, false); assert.equal(await fs.readFile(canonical, "utf8"), "original");
}));

test("staging and caches reject internal symlink aliases to ordinary media folders", () => fixture(async root => {
    const media = path.join(root, "originals"); await fs.mkdir(media); await fs.writeFile(path.join(media, "sentinel.jpg"), "keep");
    await fs.symlink(media, path.join(root, ".incoming"));
    await assert.rejects(stageMediaFile(new File(["new"], "photo.jpg")));
    await fs.symlink(media, path.join(root, ".thumbnails"));
    await assert.rejects(getOrCreateThumbnail(1, path.join(media, "sentinel.jpg"), "IMAGE"));
    assert.deepEqual(await fs.readdir(media), ["sentinel.jpg"]);
    await fs.symlink(media, path.join(root, ".replacement-operations"));
    await assert.rejects(readStorageFile(path.join(root, ".replacement-operations", "sentinel.jpg")));
}));

test("internal cache/journal files cannot be imported as source media", () => fixture(async root => {
    const target = path.join(root, "photo.jpg"); await fs.writeFile(target, "original");
    await fs.mkdir(path.join(root, ".thumbnails")); const source = path.join(root, ".thumbnails", "1.webp"); await fs.writeFile(source, "cache");
    await assert.rejects(finalizeStagedMedia(source, path.join(root, "new.jpg")), InvalidMediaPathError);
    const lock = await acquireDestinationLock(root, target);
    await assert.rejects(prepareReplacementJournal(root, 1, source, lock), InvalidMediaPathError);
    await lock.release(); assert.equal(await fs.readFile(source, "utf8"), "cache"); assert.equal(await fs.readFile(target, "utf8"), "original");
}));

test("staged job cleanup refuses arbitrary root paths before import or filesystem cleanup", () => fixture(async root => {
    const { processStagedMedia } = await import("./media-import-service");
    const marker = path.join(root, storageMarkerName), before = await fs.readFile(marker, "utf8");
    await assert.rejects(processStagedMedia(marker, "../../anything"), InvalidMediaPathError);
    assert.equal(await fs.readFile(marker, "utf8"), before);
    await assert.rejects(removeEmptyParentDirectories(path.join(root, ".incoming", id, "file.jpg")), InvalidMediaPathError);
}));

test("conflict paths and recorded destinations are checked before marker/metadata creation", () => fixture(async root => {
    const { job, staged } = await stagedFixture(root);
    const original = path.join(root, "original.jpg"); await fs.writeFile(original, "original");
    const metadata = path.join(job, ".conflict.json");
    const conflict = { type: "FILENAME" as const, conflictId: id, jobId: "../display-only", existingPath: path.join(root, ".thumbnails", "1.webp") };
    await fs.writeFile(metadata, JSON.stringify(conflict)); const before = await fs.readFile(metadata, "utf8");
    await assert.rejects(savePendingConflict(staged, conflict), InvalidMediaPathError);
    await assert.rejects(savePendingConflict(original, { ...conflict, existingPath: original }), InvalidMediaPathError);
    await assert.rejects(acquireResolutionClaim(root, id, "REPLACE", staged), InvalidMediaPathError);
    await assert.rejects(getConflictPreviewSelection(id, "incoming"), InvalidMediaPathError);
    await assert.rejects(fs.access(path.join(job, ".resolution-lock"))); assert.equal(await fs.readFile(metadata, "utf8"), before);
    await savePendingConflict(staged, { ...conflict, existingPath: original });
    assert.equal(JSON.parse(await fs.readFile(metadata, "utf8")).jobId, "../display-only");
    assertStagedMediaPath(root, staged, id);
}));

test("staged selection rejects unsafe existing filenames and never selects conflict bookkeeping", () => fixture(async root => {
    const { job } = await stagedFixture(root, "photo\\name.jpg");
    await assert.rejects(findStagedConflictFile(id), InvalidMediaPathError);
    assert.equal(await fs.readFile(path.join(job, "photo\\name.jpg"), "utf8"), "incoming");
}));

test("recovery validates original namespaces before consulting receipts or changing lock ownership", () => fixture(async root => {
    const target = path.join(root, "photo.jpg"), source = path.join(root, "incoming.jpg");
    await fs.writeFile(target, "original"); await fs.writeFile(source, "incoming");
    const lock = await acquireDestinationLock(root, target), journal = await prepareReplacementJournal(root, 1, source, lock);
    const location = path.join(root, ".replacement-operations", `${journal.operationId}.json`);
    journal.target = path.join(root, ".thumbnails", "1.webp"); journal.backupPath = `${journal.target}.backup-${journal.operationId}`;
    await fs.writeFile(location, JSON.stringify(journal));
    await assert.rejects(readReplacementJournal(root, journal.operationId), InvalidMediaPathError);
    assert.equal(await fs.readFile(target, "utf8"), "original");
}));

test("thumbnail identifiers cannot inject paths before creating locks or caches", () => fixture(async root => {
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "../../escape" as unknown as number]) {
        await assert.rejects(getOrCreateThumbnail(value, path.join(root, "original.jpg"), "IMAGE"), InvalidMediaPathError);
        await assert.rejects(deleteThumbnail(value), InvalidMediaPathError);
    }
    assert.deepEqual(await fs.readdir(root), [storageMarkerName]);
}));

test("streaming and preview selection refuse unsafe/reserved names with a safe response", () => fixture(async root => {
    for (const target of [path.join(root, ".conflict.json"), path.join(root, "photo\\name.jpg"), path.join(root, `photo.jpg.publish-${id}`)]) {
        const request = new Request("http://gallery.test/media");
        let error: unknown;
        try { await streamMediaFile(request, { filePath: target, destination: target, fileName: "photo.jpg", revalidate: async () => { assert.fail("No metadata lookup for invalid paths"); } }); }
        catch (caught) { error = caught; }
        assert.ok(error); assert.equal(mediaErrorResponse(request, error).status, 404);
    }
    const storage = await validateStorage(); await storage.assertAvailable();
}));

test("long existing names remain intact when generated backup or KEEP_BOTH names exceed NAME_MAX", () => fixture(async root => {
    const source = path.join(root, "incoming.jpg"); await fs.writeFile(source, "incoming");
    const target = path.join(root, "a".repeat(207) + ".jpg"); // 211 bytes; publication suffix would exceed 255.
    await fs.writeFile(target, "original");
    let changed = false;
    await assert.rejects(replaceMediaAtDestination({ root, destination: target, stagedPath: source, mediaId: 1,
        revalidateMetadata: async () => {}, readReceipt: async () => { changed = true; return undefined; }, updateMetadata: async () => { changed = true; },
    }), InvalidMediaPathError);
    const long = path.join(root, "b".repeat(250) + ".jpg"); await fs.writeFile(long, "original");
    await assert.rejects(finalizeStagedMedia(source, long, async () => { changed = true; }), InvalidMediaPathError);
    assert.equal(changed, false); assert.equal(await fs.readFile(target, "utf8"), "original");
    assert.equal(await fs.readFile(long, "utf8"), "original"); assert.equal(await fs.readFile(source, "utf8"), "incoming");
    const lock = await acquireDestinationLock(root, target); await lock.release();
    await assert.rejects(fs.access(path.join(root, ".replacement-operations")));
}));

test("dangling parent symlinks are rejected before lock or directory creation", () => fixture(async root => {
    const link = path.join(root, "alias"); await fs.symlink(path.join(root, ".thumbnails", "not-created"), link);
    await assert.rejects(acquireDestinationLock(root, path.join(link, "photo.jpg")), InvalidMediaPathError);
    await assert.rejects(fs.access(path.join(root, ".destination-locks")));
    await assert.rejects(destinationExists(path.join(link, "photo.jpg")), InvalidMediaPathError);
    assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
}));
