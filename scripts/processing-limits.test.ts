import { JsonRequestError } from "./bounded-json";
import assert from "node:assert/strict";
import { test, mock } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import sharp from "sharp";
import { AdmissionGate, ProcessingError, processingLimits, withProcessingJob } from "./processing-limits";
import { runMediaSubprocess } from "./media-subprocess";
import { parseUpload, readBoundedJson } from "./upload-request";
import { findStagedConflictFile, stageMediaStream } from "./media-storage";
import { getOrCreateThumbnail } from "./media-thumbnail";
import { resolveLocation } from "./media-location";
import { listPendingConflicts } from "./pending-import-conflicts";
import { mockStorageMount, writeTestStorageMarker } from "./testing/storage-fixture";

async function configuration(values: Record<string, string>, action: () => Promise<void>) {
    const old = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    Object.assign(process.env, values);
    try { await action(); } finally {
        for (const [key, value] of Object.entries(old)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    }
}
async function fixture(action: (root: string) => Promise<void>) {
    const root = await fs.mkdtemp(path.join(tmpdir(), "gallery-m13-"));
    await writeTestStorageMarker(root); const mount = await mockStorageMount(root);
    try { await configuration({ MEDIA_MIN_FREE_BYTES: "1" }, () => action(root)); }
    finally { mount.restore(); await fs.rm(root, { recursive: true, force: true }); }
}
function multipart(name = "photo.jpg", contents = "media", extra = false) {
    const body = `--fixture\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n${contents}\r\n--fixture\r\nContent-Disposition: form-data; name="jobId"\r\n\r\njob\r\n${extra ? '--fixture\r\nContent-Disposition: form-data; name="unexpected"\r\n\r\nno\r\n' : ''}--fixture--\r\n`;
    return new Request("http://localhost/api/import", { method: "POST", body: new TextEncoder().encode(body), headers: { "content-type": "multipart/form-data; boundary=fixture" } });
}
function status(expected: number) { return (error: unknown) => error instanceof ProcessingError && error.status === expected; }
async function stagingFiles(root: string) {
    return fs.readdir(path.join(root, ".incoming")).catch(() => []);
}

test("configuration rejects zero, negative and nonnumeric limits", async () => {
    for (const value of ["0", "-1", "NaN", "1.5"]) await configuration({ MEDIA_MAX_CONCURRENT_JOBS: value }, async () => assert.throws(processingLimits, ProcessingError));
});
test("admission rejects excess work, permits unrelated work, and releases after failure", async () => {
    const gate = new AdmissionGate(); let finish!: () => void;
    const pending = gate.run(1, () => new Promise<void>(resolve => { finish = resolve; }));
    await assert.rejects(gate.run(1, async () => {}), status(503));
    finish(); await pending;
    await assert.rejects(gate.run(1, async () => { throw new Error("failure"); }));
    assert.equal(await gate.run(1, async () => "ok"), "ok");
    await Promise.all([gate.run(2, async () => 1), gate.run(2, async () => 2)]);
});
test("subprocess success, errors, timeout, output ceiling and cancellation", async () => {
    assert.equal((await runMediaSubprocess(process.execPath, ["-e", "process.stdout.write('ok')"])).stdout, "ok");
    await assert.rejects(runMediaSubprocess(process.execPath, ["-e", "process.exit(2)"]), status(422));
    await assert.rejects(runMediaSubprocess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 50 }), status(504));
    await assert.rejects(runMediaSubprocess(process.execPath, ["-e", "process.stdout.write('x'.repeat(10000))"], { maxOutputBytes: 64 }), status(422));
    const controller = new AbortController();
    const child = runMediaSubprocess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(child, status(408));
    assert.equal((await runMediaSubprocess(process.execPath, ["-e", "process.stdout.write('released')"])).stdout, "released");
});
test("multipart streams Unicode filenames, including exact file limit", () => fixture(root => configuration({ MEDIA_MAX_UPLOAD_BYTES: "5" }, async () => {
    const result = await parseUpload(multipart("東京.jpg", "12345"));
    assert.equal(result.jobId, "job"); assert.equal(path.basename(result.stagedPath), "東京.jpg");
    assert.equal(await fs.readFile(result.stagedPath, "utf8"), "12345");
    assert.equal((await stagingFiles(root)).length, 1);
})));
test("oversized files and malformed multipart clean exclusively owned staging", () => fixture(root => configuration({ MEDIA_MAX_UPLOAD_BYTES: "5" }, async () => {
    await assert.rejects(parseUpload(multipart("large.jpg", "123456")), status(413));
    assert.deepEqual(await stagingFiles(root), []);
    await assert.rejects(parseUpload(multipart("normal.jpg", "ok", true)), status(400));
    assert.deepEqual(await stagingFiles(root), []);
    const invalid = new Request("http://localhost", { method: "POST", body: "no", headers: { "content-type": "multipart/form-data; boundary=x" } });
    await assert.rejects(parseUpload(invalid), status(400));
})));
test("unsupported names and excessive Content-Length reject before staging", () => fixture(async root => {
    await assert.rejects(parseUpload(multipart("program.exe")), status(415));
    const request = multipart(); request.headers.set("content-length", String(processingLimits().requestBytes + 1));
    await assert.rejects(parseUpload(request), status(413));
    assert.deepEqual(await stagingFiles(root), []);
}));
test("request byte limit also covers chunked uploads with no Content-Length", () => fixture(root => configuration({ MEDIA_MAX_UPLOAD_BYTES: "8", MEDIA_MAX_REQUEST_BYTES: "16" }, async () => {
    await assert.rejects(parseUpload(multipart("a.jpg", "ok")), status(413));
    assert.deepEqual(await stagingFiles(root), []);
})));
test("staging quota counts retained conflicts; insufficient free space rejects", () => fixture(() => configuration({ MEDIA_MAX_UPLOAD_BYTES: "10", MEDIA_MAX_TEMP_BYTES: "50" }, async () => {
    const retained = await stageMediaStream("retained.jpg", Readable.from(["1234567890"]));
    await configuration({ MEDIA_MAX_TEMP_BYTES: "19" }, async () => {
        await assert.rejects(stageMediaStream("another.jpg", Readable.from(["x"])), status(503));
    });
    assert.equal(await fs.readFile(retained.path, "utf8"), "1234567890");
    await configuration({ MEDIA_MIN_FREE_BYTES: String(Number.MAX_SAFE_INTEGER) }, async () => {
        await assert.rejects(stageMediaStream("no-space.jpg", Readable.from(["x"])));
    });
})));
test("aborted staging removes only its partial file and returns no successful media", () => fixture(async root => {
    const controller = new AbortController();
    const source = new Readable({ read() { this.push(Buffer.alloc(32)); this._read = () => {}; setTimeout(() => controller.abort(), 20); } });
    await assert.rejects(stageMediaStream("partial.jpg", source, controller.signal), status(408));
    assert.deepEqual(await stagingFiles(root), []);
}));
test("upload elapsed-time limit cancels a stalled multipart body", () => fixture(root => configuration({ MEDIA_UPLOAD_TIMEOUT_MS: "20" }, async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('--x\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\n\r\npartial')); }, cancel() { cancelled = true; } });
    const request = new Request("http://localhost", { method: "POST", body, duplex: "half", headers: { "content-type": "multipart/form-data; boundary=x" } } as RequestInit);
    await assert.rejects(parseUpload(request), status(408)); assert.equal(cancelled, true);
    assert.deepEqual(await stagingFiles(root), []);
})));
test("JSON control requests are bounded and malformed JSON is rejected", async () => {
    await assert.rejects(readBoundedJson(new Request("http://localhost", { method: "POST", body: "x".repeat(4097) })), error => error instanceof JsonRequestError && error.status === 413);
    await assert.rejects(readBoundedJson(new Request("http://localhost", { method: "POST", body: "{" })), error => error instanceof JsonRequestError && error.status === 400);
});
test("thumbnail failures leave no published or partial cache; valid image publishes complete output", () => fixture(async root => {
    const file = path.join(root, "image.jpg"); await fs.writeFile(file, "invalid-image");
    await assert.rejects(getOrCreateThumbnail(1, file, "IMAGE"));
    assert.deepEqual(await fs.readdir(path.join(root, ".thumbnails")), []);
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } }).jpeg().toFile(file);
    const thumbnail = await getOrCreateThumbnail(1, file, "IMAGE");
    assert.equal((await sharp(thumbnail).metadata()).format, "webp");
    assert.deepEqual(await fs.readdir(path.join(root, ".thumbnails")), ["1.webp"]);
}));
test("already cancelled jobs do no work", async () => {
    const controller = new AbortController(); controller.abort(); let ran = false;
    await assert.rejects(withProcessingJob(controller.signal, async () => { ran = true; }), status(408));
    assert.equal(ran, false);
});

test("incomplete upload markers keep staging invisible to conflict discovery and resolution", () => fixture(async root => {
    const staged = await stageMediaStream("pending.jpg", Readable.from(["complete bytes but not yet validated request"]));
    await assert.rejects(findStagedConflictFile(path.basename(path.dirname(staged.path))), status(409));
    assert.deepEqual(await listPendingConflicts(), []);
    await staged.complete();
    assert.equal(await findStagedConflictFile(path.basename(path.dirname(staged.path))), staged.path);
    await staged.discard();
    assert.deepEqual(await stagingFiles(root), []);
}));
test("upload cleanup preserves changed inodes and unknown artifacts", () => fixture(async root => {
    const staged = await stageMediaStream("file.jpg", Readable.from(["owned"]));
    await fs.rename(staged.path, `${staged.path}.original`);
    await fs.writeFile(staged.path, "unrelated");
    await assert.rejects(staged.discard(), /file changed/);
    assert.equal(await fs.readFile(staged.path, "utf8"), "unrelated");
    assert.equal((await stagingFiles(root)).length, 1);
}));

test("subprocess admission is bounded and a SIGTERM-resistant child is killed", async () => {
    await configuration({ MEDIA_MAX_SUBPROCESSES: "1" }, async () => {
        const child = runMediaSubprocess(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { timeoutMs: 200 });
        await assert.rejects(runMediaSubprocess(process.execPath, ["-e", "process.exit(0)"]), status(503));
        await assert.rejects(child, status(504));
        assert.equal((await runMediaSubprocess(process.execPath, ["-e", "process.stdout.write('slot released')"])).stdout, "slot released");
    });
});
test("multi-megabyte upload uses bounded streaming and never calls arrayBuffer/formData", () => fixture(async root => {
    const boundary = "stream-fixture";
    const bytes = 8 * 1024 * 1024;
    let chunks = 0;
    async function* body() {
        yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="large.mp4"\r\n\r\n`);
        for (let i = 0; i < bytes / 16384; i++) { chunks++; yield Buffer.alloc(16384, 1); }
        yield Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="jobId"\r\n\r\njob\r\n--${boundary}--\r\n`);
    }
    const stream = Readable.toWeb(Readable.from(body()));
    const request = new Request("http://localhost", { method: "POST", body: stream as ReadableStream, duplex: "half", headers: { "content-type": `multipart/form-data; boundary=${boundary}` } } as RequestInit);
    request.formData = async () => { throw new Error("must stream"); };
    request.arrayBuffer = async () => { throw new Error("must stream"); };
    const result = await parseUpload(request);
    assert.equal((await fs.stat(result.stagedPath)).size, bytes);
    assert.equal(chunks, bytes / 16384);
    assert.equal((await stagingFiles(root)).length, 1);
}));

test("thumbnail pixel and output ceilings reject without publishing cache entries", () => fixture(async root => {
    const file = path.join(root, "image.jpg");
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } }).jpeg().toFile(file);
    await configuration({ MEDIA_MAX_IMAGE_PIXELS: "16" }, async () => {
        await assert.rejects(getOrCreateThumbnail(1, file, "IMAGE"), /pixel limit/);
    });
    await configuration({ MEDIA_MAX_THUMBNAIL_BYTES: "1" }, async () => {
        await assert.rejects(getOrCreateThumbnail(1, file, "IMAGE"), status(422));
    });
    assert.deepEqual(await fs.readdir(path.join(root, ".thumbnails")), []);
}));

test("upload and conflict HTTP endpoints return early limit errors without database access", async () => {
    const { Pool } = await import("pg");
    const { POST: upload } = await import("../app/api/import/route");
    const { POST: conflict } = await import("../app/api/import/conflict/route");
    const connect = mock.method(Pool.prototype, "connect", () => { throw new Error("Unexpected database connection"); });
    try {
        assert.equal((await upload(multipart("program.exe"))).status, 415);
        const request = multipart(); request.headers.set("content-length", String(processingLimits().requestBytes + 1));
        assert.equal((await upload(request)).status, 413);
        assert.equal((await conflict(new Request("http://localhost", { method: "POST", body: "x".repeat(4097) }))).status, 413);
        await configuration({ MEDIA_MAX_CONCURRENT_JOBS: "1" }, async () => {
            await withProcessingJob(undefined, async () => {
                const result = await upload(multipart());
                assert.equal(result.status, 503); assert.equal(result.headers.get("retry-after"), "5");
            });
        });
        assert.equal(connect.mock.callCount(), 0);
    } finally { connect.mock.restore(); }
});

test("video thumbnail timeout uses the shared child guard and removes its partial output", () => fixture(async root => {
    const bin = path.join(root, "test-bin"); await fs.mkdir(bin);
    const executable = path.join(bin, "ffmpeg");
    await fs.writeFile(executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.argv.at(-1), 'partial');setInterval(()=>{},1000);\n`, { mode: 0o700 });
    const video = path.join(root, "video.mp4"); await fs.writeFile(video, "mock-video");
    await configuration({ PATH: `${bin}:${process.env.PATH}`, MEDIA_SUBPROCESS_TIMEOUT_MS: "200" }, async () => {
        await assert.rejects(getOrCreateThumbnail(2, video, "VIDEO"), status(504));
    });
    assert.deepEqual(await fs.readdir(path.join(root, ".thumbnails")), []);
}));

test("geocoding bounds response bytes and inherits request cancellation without network access", () => configuration({ GEOCODER_URL: "http://geocoder.invalid/reverse", GEOCODER_MODE: "required" }, async () => {
    const fetch = mock.method(globalThis, "fetch", async () => new Response("x".repeat(65537)));
    try { await assert.rejects(resolveLocation(0, 0), status(502)); }
    finally { fetch.mock.restore(); }
    const controller = new AbortController();
    const stalled = mock.method(globalThis, "fetch", async (_url: unknown, options?: RequestInit) => {
        const signal = options?.signal;
        return new Response(new ReadableStream({ start(stream) {
            signal?.addEventListener("abort", () => stream.error(signal.reason), { once: true });
            setTimeout(() => controller.abort(), 10);
        } }));
    });
    try { await assert.rejects(withProcessingJob(controller.signal, () => resolveLocation(0, 0))); }
    finally { stalled.mock.restore(); }
}));

test("upload bytes are not read when the incomplete-marker durability barrier fails", () => fixture(async root => {
    const open = fs.open;
    const handles: Array<{ mock: { restore(): void } }> = [];
    const opened = mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        if (String(args[0]).endsWith(".uploading")) handles.push(mock.method(handle, "sync", async () => { throw new Error("marker fsync failure"); }));
        return handle;
    });
    let read = false;
    const source = new Readable({ read() { read = true; this.push("untrusted bytes"); this.push(null); } });
    try {
        await assert.rejects(stageMediaStream("file.jpg", source), /marker fsync failure/);
        assert.equal(read, false);
        assert.deepEqual(await stagingFiles(root), []);
    } finally { opened.mock.restore(); for (const handle of handles) handle.mock.restore(); }
}));
