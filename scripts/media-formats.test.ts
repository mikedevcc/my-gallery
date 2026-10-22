import assert from "node:assert/strict";
import { test, mock } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { Pool } from "pg";
import { mediaFormats, mediaFormat, mediaUploadAccept, unsupportedMediaMessage } from "../lib/media-formats";
import { validateImportJobs } from "../lib/import/validate-import-jobs";
import { assertSupportedUpload, ProcessingError, withProcessingJob } from "./processing-limits";
import { validateMediaContents } from "./media-format-validation";
import { importMedia } from "./media-import";
import { getOrCreateThumbnail } from "./media-thumbnail";
import { mediaContentType, streamMediaFile } from "./media-stream";
import { mockStorageMount, writeTestStorageMarker } from "./testing/storage-fixture";

const invalid = (error: unknown) => error instanceof ProcessingError && error.status === 415 && error.message === unsupportedMediaMessage;
async function fixture(action: (root: string) => Promise<void>) {
    const root = await fs.mkdtemp(path.join(tmpdir(), "gallery-formats-"));
    await writeTestStorageMarker(root); const mount = await mockStorageMount(root);
    const checkout = mock.method(Pool.prototype, "connect", () => { throw new Error("Format tests must never connect to a database"); });
    try { await action(root); assert.equal(checkout.mock.callCount(), 0); }
    finally { checkout.mock.restore(); mount.restore(); await fs.rm(root, { recursive: true, force: true }); }
}
const image = () => sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } });

test("picker, frontend and backend admit exactly the shared case-insensitive extension policy", () => {
    const extensions = mediaFormats.flatMap(format => format.extensions);
    assert.equal(new Set(extensions).size, extensions.length);
    assert.equal(mediaUploadAccept, extensions.join(","));
    for (const name of [".jpg", "photo", "photo.", "photo.jpg.exe"]) assert.equal(mediaFormat(name), undefined);
    for (const format of mediaFormats) {
        assert.ok(format.detectedMimes.every(mime => mime.startsWith(format.kind === "IMAGE" ? "image/" : "video/")));
        assert.equal(Boolean(format.demuxers), format.kind === "VIDEO");
        for (const extension of format.extensions) assert.equal(mediaContentType(`stored${extension}`), format.inlineMime);
    }
    for (const extension of [...extensions, ".svg", ".raw", ".heif", ".heic", ".bmp", ".exe", "", ".jpg.exe", ".jpg "]) {
        const name = `東京🌈${extension.toUpperCase()}`;
        const admitted = extensions.includes(extension);
        const job = { id: "job", fileName: name, status: "VERIFYING" as const, progress: 0 };
        // Browser-supplied MIME may be absent or incorrect. It is not evidence.
        const file = new File(["fixture"], name, { type: "application/octet-stream" });
        const [result] = validateImportJobs([job], new Map([[job.id, file]]));
        assert.equal(result.valid, admitted, name);
        if (admitted) assert.doesNotThrow(() => assertSupportedUpload(name));
        else { assert.throws(() => assertSupportedUpload(name), invalid); assert.equal(result.error, unsupportedMediaMessage); }
    }
});

test("empty files remain rejected by frontend validation", () => {
    const job = { id: "job", fileName: "empty.jpg", status: "VERIFYING" as const, progress: 0 };
    assert.equal(validateImportJobs([job], new Map([[job.id, new File([], job.fileName)]]))[0].valid, false);
});

test("all admitted images decode generated fixtures; corrupt and extension/MIME mismatches reject", () => fixture(async root => {
    for (const [extension, encoder] of [["jpg", "jpeg"], ["png", "png"], ["gif", "gif"], ["webp", "webp"], ["avif", "avif"], ["tiff", "tiff"]] as const) {
        const file = path.join(root, `東京.${extension}`), format = mediaFormat(file)!;
        await image()[encoder]().toFile(file);
        await validateMediaContents(file, format, { MIMEType: format.detectedMimes[0] });
        await assert.rejects(validateMediaContents(file, format, { MIMEType: "text/html" }), invalid);
        await assert.rejects(validateMediaContents(file, format, { MIMEType: format.detectedMimes[0], Error: "corrupt" }), invalid);
        await fs.writeFile(file, "not an image");
        await assert.rejects(validateMediaContents(file, format, { MIMEType: format.detectedMimes[0] }), invalid);
    }
    const file = path.join(root, "a.jpg"); await image().jpeg().toFile(file);
    await assert.rejects(validateMediaContents(file, mediaFormat(file)!, {}), invalid);
    const previous = process.env.MEDIA_MAX_IMAGE_PIXELS;
    process.env.MEDIA_MAX_IMAGE_PIXELS = "16";
    try { await assert.rejects(validateMediaContents(file, mediaFormat(file)!, { MIMEType: "image/jpeg" }), invalid); }
    finally { if (previous === undefined) delete process.env.MEDIA_MAX_IMAGE_PIXELS; else process.env.MEDIA_MAX_IMAGE_PIXELS = previous; }
    const controller = new AbortController(); controller.abort();
    await assert.rejects(withProcessingJob(controller.signal, () => validateMediaContents(file, mediaFormat(file)!, { MIMEType: "image/jpeg" })), error => error instanceof ProcessingError && error.status === 408);
}));

test("video checks require matching detected MIME, dimensions and an actually decoded frame", () => fixture(async root => {
    const bin = path.join(root, "bin"); await fs.mkdir(bin);
    const file = path.join(root, "a.mp4"); await fs.writeFile(file, "fixture");
    const args = path.join(root, "args.json");
    await fs.writeFile(path.join(bin, "ffmpeg"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(args)}, JSON.stringify(process.argv.slice(2)));process.stdout.write('0, 0, 0, 1, 192, abcdef\\n');\n`, { mode: 0o700 });
    const previous = process.env.PATH; process.env.PATH = `${bin}:${previous ?? ""}`;
    try {
        for (const format of mediaFormats.filter(format => format.kind === "VIDEO")) {
            const metadata = { MIMEType: format.detectedMimes[0], ImageWidth: 16, ImageHeight: 16 };
            await validateMediaContents(file, format, metadata);
            const argv = JSON.parse(await fs.readFile(args, "utf8"));
            assert.equal(argv[argv.indexOf("-format_whitelist") + 1], format.demuxers);
            assert.equal(argv[argv.indexOf("-protocol_whitelist") + 1], "file,pipe");
            assert.equal(argv[argv.indexOf("-frames:v") + 1], "1");
            assert.equal(argv.at(-1), "pipe:1");
            await assert.rejects(validateMediaContents(file, format, { ...metadata, MIMEType: "application/x-mpegURL" }), invalid);
            await assert.rejects(validateMediaContents(file, format, { ...metadata, ImageWidth: 999999999 }), invalid);
            await assert.rejects(validateMediaContents(file, format, { MIMEType: metadata.MIMEType }), invalid);
        }
        for (const script of ["process.exit(1)", "process.stdout.write('# no decoded frames')"]) {
            await fs.writeFile(path.join(bin, "ffmpeg"), `#!${process.execPath}\n${script}\n`, { mode: 0o700 });
            await assert.rejects(validateMediaContents(file, mediaFormat(file)!, { MIMEType: "video/mp4", ImageWidth: 8, ImageHeight: 8 }), invalid);
        }
    } finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
}));

test("legacy formats retain download delivery and active SVG stays non-inline", () => fixture(async root => {
    const file = path.join(root, "legacy.raw"); await fs.writeFile(file, "legacy bytes");
    for (const name of ["legacy.raw", "legacy.heif", "legacy.svg", "legacy.tiff", "legacy.avi", "legacy.mkv", "legacy.wmv"]) {
        assert.equal(mediaContentType(name), undefined);
        const response = await streamMediaFile(new Request("http://localhost/media"), { filePath: file, destination: file, fileName: name, revalidate: async () => {} });
        assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "application/octet-stream");
        assert.match(response.headers.get("content-disposition")!, /^inline;/);
        assert.equal(response.headers.get("x-content-type-options"), "nosniff");
        assert.equal(await response.text(), "legacy bytes");
    }
    assert.equal(mediaContentType("legacy.MOV"), "video/quicktime");
}));

test("real ExifTool and decoders import generated fixtures and reject disguised/invalid content before publication", { skip: process.env.MEDIA_FORMAT_TOOLS_TEST !== "1" }, () => fixture(async root => {
    const exec = promisify(execFile);
    let mediaId = 1;
    for (const [extension, encoder] of [["jpg", "jpeg"], ["png", "png"], ["gif", "gif"], ["webp", "webp"], ["avif", "avif"], ["tif", "tiff"]] as const) {
        const file = path.join(root, `photo.${extension}`); await image()[encoder]().toFile(file);
        assert.equal((await importMedia(file)).file.fileType, "IMAGE");
        const thumbnail = await getOrCreateThumbnail(mediaId++, file, "IMAGE");
        assert.equal((await sharp(thumbnail).metadata()).format, "webp");
    }
    for (const [extension, codec] of [["mp4", "mpeg4"], ["mov", "mpeg4"], ["webm", "libvpx"], ["avi", "mpeg4"], ["mkv", "mpeg4"], ["wmv", "wmv2"]]) {
        const file = path.join(root, `clip.${extension}`);
        await exec("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=red:s=16x16:d=0.1", "-c:v", codec, "-threads", "1", file]);
        assert.equal((await importMedia(file)).file.fileType, "VIDEO", extension);
        const thumbnail = await getOrCreateThumbnail(mediaId++, file, "VIDEO");
        assert.equal((await sharp(thumbnail).metadata()).format, "webp");
    }
    for (const [extension, contents] of [["jpg", "<svg xmlns='http://www.w3.org/2000/svg' width='8' height='8'></svg>"], ["mp4", "#EXTM3U\nhttp://example.invalid/secret.ts"], ["png", "not media"], ["jpeg", ""]]) {
        const file = path.join(root, `disguised.${extension}`); await fs.writeFile(file, contents);
        await assert.rejects(importMedia(file), invalid);
        assert.equal(await fs.readFile(file, "utf8"), contents);
    }
    const wrongExtension = path.join(root, "renamed.png"); await image().jpeg().toFile(wrongExtension);
    await assert.rejects(importMedia(wrongExtension), invalid);
    assert.equal((await fs.readdir(root)).includes(".incoming"), false);
    const { POST } = await import("../app/api/import/route");
    const form = new FormData(); form.append("file", new File(["invalid content"], "upload.jpg", { type: "image/jpeg" }));
    form.append("jobId", "format-test");
    const response = await POST(new Request("http://localhost/api/import", { method: "POST", body: form }));
    assert.equal(response.status, 415);
    assert.equal((await response.json()).error, "Unsupported media type");
    assert.deepEqual(await fs.readdir(path.join(root, ".incoming")), []);
}));
