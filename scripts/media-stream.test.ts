import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { getEventListeners } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { streamMediaFile, singleByteRange, type MediaStreamSelection } from "./media-stream";
import { acquireDestinationLock, DestinationBusyError, withDestinationLock } from "./destination-lock";
import { replaceMediaAtDestination, deleteMediaAtDestination } from "./media-mutations";
import { mockStorageMount, writeTestStorageMarker } from "./testing/storage-fixture";

async function fixture(action: (root: string, target: string, selection: MediaStreamSelection, mount: Awaited<ReturnType<typeof mockStorageMount>>) => Promise<void>) {
    const root = await fs.mkdtemp(path.join(tmpdir(), "gallery-stream-test-"));
    await writeTestStorageMarker(root); const mount = await mockStorageMount(root);
    const target = path.join(root, "original.mp4"); await fs.writeFile(target, "0123456789");
    try { await action(root, target, { filePath: target, destination: target, fileName: "original.mp4", revalidate: async () => {} }, mount); }
    finally { mount.restore(); await fs.rm(root, { recursive: true, force: true }); }
}
const request = (method = "GET", headers?: Record<string, string>, signal?: AbortSignal) => new Request("http://gallery.test/media", { method, headers, signal });
async function tracked(target: string, action: (state: { active: Set<number>; reads: number[] }) => Promise<void>) {
    const state = { active: new Set<number>(), reads: [] as number[] };
    const open = fs.open.bind(fs);
    const spy = mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        if (args[0] === target) {
            const fd = handle.fd; state.active.add(fd);
            const close = handle.close.bind(handle), read = handle.read.bind(handle);
            handle.close = async () => { try { await close(); } finally { state.active.delete(fd); } };
            mock.method(handle, "read", async (buffer: Buffer, offset: number, length: number, position: number) => {
                state.reads.push(length); return read(buffer, offset, length, position);
            });
        }
        return handle;
    });
    try { await action(state); assert.equal(state.active.size, 0, "All media descriptors must close"); }
    finally { spy.mock.restore(); }
}

test("full video/image delivery has lengths, MIME, validators and safely encoded filename", () => fixture(async (_root, target, selection) => {
    await tracked(target, async () => {
        for (const [name, mime] of [["original.mp4", "video/mp4"], ["a\"\r\n💙.jpg", "image/jpeg"]]) {
            const response = await streamMediaFile(request(), { ...selection, fileName: name });
            assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), mime);
            assert.equal(response.headers.get("content-length"), "10"); assert.equal(response.headers.get("accept-ranges"), "bytes");
            assert.equal(response.headers.get("content-range"), null); assert.match(response.headers.get("etag")!, /^"[0-9a-f]{64}"$/);
            assert.ok(response.headers.get("last-modified")); assert.equal(response.headers.get("x-content-type-options"), "nosniff");
            assert.ok(!/[\r\n]/.test(response.headers.get("content-disposition")!));
            assert.equal(await response.text(), "0123456789");
        }
    });
}));

test("HEAD ignores Range and closes its descriptor without reading media bytes", () => fixture(async (_root, target, selection) => tracked(target, async state => {
    const response = await streamMediaFile(request("HEAD", { Range: "bytes=999-" }), selection);
    assert.equal(response.status, 200); assert.equal(response.body, null); assert.equal(response.headers.get("content-length"), "10");
    assert.equal(response.headers.get("content-range"), null); assert.deepEqual(state.reads, []); assert.equal(state.active.size, 0);
})));

for (const [range, content, contentRange] of [
    ["bytes=2-5", "2345", "bytes 2-5/10"], ["bytes=7-", "789", "bytes 7-9/10"],
    ["bytes=-3", "789", "bytes 7-9/10"], ["bytes=-999", "0123456789", "bytes 0-9/10"],
    ["bytes=8-9999999999999999999999999", "89", "bytes 8-9/10"], ["bytes=0-0", "0", "bytes 0-0/10"],
]) {
    test(`single range ${range}`, () => fixture(async (_root, target, selection) => tracked(target, async () => {
        const response = await streamMediaFile(request("GET", { Range: range }), selection);
        assert.equal(response.status, 206); assert.equal(response.headers.get("content-length"), String(content.length));
        assert.equal(response.headers.get("content-range"), contentRange); assert.equal(await response.text(), content);
    })));
}

test("unsatisfiable ranges return empty 416 and release the descriptor", () => fixture(async (_root, target, selection) => tracked(target, async state => {
    for (const range of ["bytes=10-", "bytes=9999999999999999999999999999999999-", "bytes=-0"]) {
        const response = await streamMediaFile(request("GET", { Range: range }), selection);
        assert.equal(response.status, 416); assert.equal(response.headers.get("content-range"), "bytes */10");
        assert.equal(response.headers.get("content-length"), "0"); assert.equal(response.body, null);
    }
    assert.deepEqual(state.reads, []);
})));

test("malformed, unsupported and multiple ranges are ignored safely", () => fixture(async (_root, _target, selection) => {
    for (const range of ["bytes=5-2", "bytes=-", "bytes=a-b", "items=1-2", "bytes=0-1,4-5", "bytes=0-1,garbage", "bytes=1 - 2", "bytes=+1-2", "bytes=" + "9".repeat(300) + "-"]) {
        const response = await streamMediaFile(request("GET", { Range: range }), selection);
        assert.equal(response.status, 200); assert.equal(response.headers.get("content-range"), null); assert.equal(await response.text(), "0123456789");
    }
}));

test("empty media has a zero-length full response and unsatisfiable ranges", () => fixture(async (_root, target, selection) => tracked(target, async state => {
    await fs.truncate(target, 0);
    const full = await streamMediaFile(request(), selection);
    assert.equal(full.status, 200); assert.equal(full.body, null); assert.equal(full.headers.get("content-length"), "0");
    const range = await streamMediaFile(request("GET", { Range: "bytes=0-" }), selection);
    assert.equal(range.status, 416); assert.equal(range.headers.get("content-range"), "bytes */0"); assert.deepEqual(state.reads, []);
})));

test("If-Range uses a matching strong generation ETag; stale/weak/date validators get a full response", () => fixture(async (_root, target, selection) => {
    const etag = (await streamMediaFile(request("HEAD"), selection)).headers.get("etag")!;
    for (const validator of [etag, '"old"', "W/" + etag, new Date().toUTCString()]) {
        const response = await streamMediaFile(request("GET", { Range: "bytes=0-1", "If-Range": validator }), selection);
        assert.equal(response.status, validator === etag ? 206 : 200); await response.body?.cancel();
    }
    await fs.writeFile(target, "new generation");
    const response = await streamMediaFile(request("GET", { Range: "bytes=0-1", "If-Range": etag }), selection);
    assert.equal(response.status, 200); assert.equal(await response.text(), "new generation");
}));

test("1 GiB sparse file streams on demand in at most 64 KiB reads with no full-file read", () => fixture(async (_root, target, selection) => {
    await fs.truncate(target, 1024 * 1024 * 1024);
    const readFile = fs.readFile.bind(fs);
    const noBuffer = mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
        assert.notEqual(args[0], target, "Media must not use full-file readFile"); return readFile(...args);
    });
    try { await tracked(target, async state => {
        const response = await streamMediaFile(request(), selection);
        assert.equal(response.headers.get("content-length"), String(1024 * 1024 * 1024)); assert.deepEqual(state.reads, []);
        const reader = response.body!.getReader();
        for (let i = 0; i < 3; i++) { const { value } = await reader.read(); assert.equal(value!.length, 64 * 1024); }
        assert.equal(state.reads.length, 3); assert.ok(state.reads.every(length => length <= 64 * 1024));
        await reader.cancel();
    }); } finally { noBuffer.mock.restore(); }
}));

test("cancellation, request abort and pre-aborted requests close descriptors", () => fixture(async (_root, target, selection) => tracked(target, async state => {
    const response = await streamMediaFile(request(), selection); await response.body!.cancel(); assert.equal(state.active.size, 0);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(streamMediaFile(request("GET", undefined, aborted.signal), selection), { name: "AbortError" });
    const controller = new AbortController();
    const streaming = await streamMediaFile(request("GET", undefined, controller.signal), selection);
    const reader = streaming.body!.getReader(); controller.abort(); await assert.rejects(reader.read(), { name: "AbortError" });
    // The abort event initiates async close; wait for its I/O completion.
    for (let i = 0; i < 20 && state.active.size; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(state.active.size, 0);
})));

test("open-time abort and metadata/release failures cannot leak an opened descriptor", () => fixture(async (_root, target, selection, mount) => tracked(target, async state => {
    const controller = new AbortController(); const open = fs.open.bind(fs);
    const spy = mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args); if (args[0] === target) controller.abort(); return handle;
    });
    try { await assert.rejects(streamMediaFile(request("GET", undefined, controller.signal), selection), { name: "AbortError" }); }
    finally { spy.mock.restore(); }
    assert.equal(state.active.size, 0);
    await assert.rejects(streamMediaFile(request(), { ...selection, revalidate: async () => { throw new Error("Metadata changed"); } }), /Metadata changed/);
    const releaseFailure = mock.method(fs, "rmdir", async () => { throw new Error("release failed"); });
    try { await assert.rejects(streamMediaFile(request(), selection), /release failed/); }
    finally { releaseFailure.mock.restore(); mount.state.mounted = true; }
})));

test("filesystem read errors and mid-stream storage loss fail the stream and close its descriptor", () => fixture(async (_root, target, selection, mount) => {
    await fs.truncate(target, 200000);
    await tracked(target, async state => {
        const open = fs.open.bind(fs);
        const broken = mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
            const handle = await open(...args); if (args[0] === target) mock.method(handle, "read", async () => { throw new Error("read failed"); }); return handle;
        });
        try { const response = await streamMediaFile(request(), selection); await assert.rejects(response.arrayBuffer(), /read failed/); }
        finally { broken.mock.restore(); }
        assert.equal(state.active.size, 0);
        const response = await streamMediaFile(request(), selection); const reader = response.body!.getReader(); await reader.read();
        mount.state.mounted = false; await assert.rejects(reader.read(), /storage/i); assert.equal(state.active.size, 0);
    });
}));

test("pinned streams survive atomic replacement and deletion without switching generations", () => fixture(async (root, target, selection) => tracked(target, async () => {
    const old = await streamMediaFile(request(), selection);
    const incoming = path.join(root, "incoming.mp4"); await fs.writeFile(incoming, "replacement");
    await replaceMediaAtDestination({ root, destination: target, stagedPath: incoming, mediaId: 1,
        readReceipt: async () => undefined, revalidateMetadata: async () => {}, updateMetadata: async () => {},
    });
    assert.equal(await old.text(), "0123456789");
    const current = await streamMediaFile(request(), selection);
    await deleteMediaAtDestination({ mediaId: 1, root, destination: target, revalidateMetadata: async () => true,
        deleteMetadata: async () => true, afterDelete: async () => {},
    });
    assert.equal(await current.text(), "replacement"); await assert.rejects(streamMediaFile(request(), selection));
})));

test("active or unresolved destination locks prevent new original/staging opens", () => fixture(async (root, target, selection) => {
    const lock = await acquireDestinationLock(root, target);
    await assert.rejects(streamMediaFile(request(), selection), DestinationBusyError);
    await lock.release();
    await assert.rejects(withDestinationLock(root, target, async owner => { owner.markUnresolved(); throw new Error("unknown commit"); }));
    await assert.rejects(streamMediaFile(request(), selection), DestinationBusyError);
}));

test("private/recovery paths, traversal, symlinks and wrong conflict IDs are refused", () => fixture(async (root, target, selection) => {
    for (const bad of [path.join(root, ".mygallery-storage.json"), path.join(root, ".incoming", "secret.mp4"), path.join(root, ".replacement-operations", "secret.mp4"), target + ".backup-12345678-1234-4234-8234-123456789abc", target + ".publish-12345678-1234-4234-8234-123456789abc", root + "/sub/../original.mp4", "/etc/passwd"]) {
        await assert.rejects(streamMediaFile(request(), { ...selection, filePath: bad, destination: bad }));
    }
    const alias = path.join(root, "alias.mp4"); await fs.symlink(target, alias);
    await assert.rejects(streamMediaFile(request(), { ...selection, filePath: alias, destination: alias }));
    const outside = await fs.mkdtemp(path.join(tmpdir(), "gallery-stream-outside-"));
    try {
        await fs.writeFile(path.join(outside, "secret.mp4"), "private"); await fs.symlink(outside, path.join(root, "escape"));
        const escape = path.join(root, "escape", "secret.mp4"); await assert.rejects(streamMediaFile(request(), { ...selection, filePath: escape, destination: escape }));
    } finally { await fs.rm(outside, { recursive: true, force: true }); }
    await assert.rejects(streamMediaFile(request(), { ...selection, incomingConflictId: "wrong" }));
}));

test("parent-symlink swap during open cannot expose an outside descriptor", () => fixture(async (root, _target, selection) => {
    const directory = path.join(root, "album"); await fs.mkdir(directory);
    const target = path.join(directory, "file.mp4"); await fs.writeFile(target, "public");
    const outside = await fs.mkdtemp(path.join(tmpdir(), "gallery-stream-outside-")); await fs.writeFile(path.join(outside, "file.mp4"), "private");
    const open = fs.open.bind(fs);
    const spy = mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        if (args[0] === target) { await fs.rename(directory, directory + "-saved"); await fs.symlink(outside, directory); }
        return open(...args);
    });
    try { await assert.rejects(streamMediaFile(request(), { ...selection, filePath: target, destination: target })); }
    finally { spy.mock.restore(); await fs.rm(outside, { recursive: true, force: true }); }
}));

test("range parser does not lose precision on hostile large integers", () => {
    assert.equal(singleByteRange("bytes=999999999999999999999999999999-", 10), "unsatisfiable");
    assert.deepEqual(singleByteRange("bytes=-999999999999999999999999999999", 10), { start: 0, end: 9 });
});

test("abort during a pending read never enqueues later data and removes its abort listener", () => fixture(async (_root, target, selection) => tracked(target, async state => {
    let enter!: () => void, finish!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const open = fs.open.bind(fs);
    const spy = mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        if (args[0] === target) mock.method(handle, "read", async () => { enter(); await finished; return { bytesRead: 1 }; });
        return handle;
    });
    try {
        const controller = new AbortController(), req = request("GET", undefined, controller.signal);
        const baseline = getEventListeners(req.signal, "abort").length;
        const response = await streamMediaFile(req, selection), reader = response.body!.getReader();
        const pending = reader.read();
        await entered;
        const rejected = assert.rejects(pending, { name: "AbortError" });
        controller.abort(); finish(); await rejected;
        for (let i = 0; i < 20 && state.active.size; i++) await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(state.active.size, 0); assert.equal(getEventListeners(req.signal, "abort").length, baseline);
    } finally { spy.mock.restore(); }
})));

test("header construction errors close descriptors, and in-place file changes terminate delivery", () => fixture(async (_root, target, selection) => tracked(target, async state => {
    await assert.rejects(streamMediaFile(request(), { ...selection, fileName: "\ud800.mp4" }), URIError);
    assert.equal(state.active.size, 0);
    await fs.truncate(target, 200000);
    const response = await streamMediaFile(request(), selection), reader = response.body!.getReader(); await reader.read();
    await fs.truncate(target, 1);
    await assert.rejects(reader.read(), /changed during streaming/); assert.equal(state.active.size, 0);
})));
