import { logApiFailure } from "./api-diagnostics";
import busboy from "busboy";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { stageMediaStream } from "./media-storage";
import { ProcessingError, processingLimits, assertSupportedUpload } from "./processing-limits";

/** Streaming multipart with parser, byte, field, part and elapsed-time limits. */
export async function parseUpload(request: Request) {
    const limits = processingLimits();
    const length = request.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > limits.requestBytes)) throw new ProcessingError("Upload request too large or invalid Content-Length", 413);
    const type = request.headers.get("content-type") ?? "";
    if (!/^multipart\/form-data\s*;/i.test(type)) throw new ProcessingError("Expected multipart/form-data", 415);
    if (!request.body) throw new ProcessingError("Missing upload body", 400);
    let parser: ReturnType<typeof busboy>;
    try {
        parser = busboy({ headers: { "content-type": type }, preservePath: true, defParamCharset: "utf8",
            limits: { fileSize: limits.uploadBytes + 1, files: 1, fields: 1, parts: 3, fieldSize: 1024, fieldNameSize: 64, headerPairs: 32 } });
    } catch { throw new ProcessingError("Invalid multipart boundary", 400); }
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), limits.uploadMs);
    const signal = AbortSignal.any([request.signal, deadline.signal]);
    const source = Readable.fromWeb(request.body as unknown as NodeReadableStream<Uint8Array>);
    let bytes = 0;
    const counter = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes > limits.requestBytes ? new ProcessingError("Upload request too large", 413) : null, chunk);
    } });
    let jobId: string | undefined;
    let staged: Awaited<ReturnType<typeof stageMediaStream>> | undefined;
    let task: Promise<void> | undefined;
    let failure: unknown;
    const fail = (error: unknown) => {
        failure ??= error;
        // Destroy outside busboy's event handler; its parser must finish the current callback.
        queueMicrotask(() => parser.destroy(error instanceof Error ? error : new Error("Upload failed")));
    };
    parser.on("file", (name, file, info) => {
        file.on("error", () => { /* observed by staging pipeline */ });
        file.on("limit", () => fail(new ProcessingError("Upload too large", 413)));
        if (name !== "file" || task) { file.resume(); fail(new ProcessingError("Expected one file field", 400)); return; }
        try { assertSupportedUpload(info.filename ?? ""); }
        catch (error) { file.resume(); fail(error); return; }
        task = stageMediaStream(info.filename ?? "", file, signal).then(value => { staged = value; }, fail);
    });
    parser.on("field", (name, value, info) => {
        if (name !== "jobId" || jobId !== undefined || info.valueTruncated || info.nameTruncated || !value) fail(new ProcessingError("Invalid jobId field", 400));
        else jobId = value;
    });
    for (const event of ["filesLimit", "fieldsLimit", "partsLimit"] as const) {
        parser.on(event, () => fail(new ProcessingError("Too many multipart fields", 400)));
    }
    try {
        await pipeline(source, counter, parser, { signal });
        await task;
        if (failure) throw failure;
        if (!staged || jobId === undefined) throw new ProcessingError("Expected file and jobId", 400);
        await staged.complete();
        return { stagedPath: staged.path, jobId };
    } catch (error) {
        // Wait for the writer to close before considering cleanup safe.
        await task;
        if (staged) await staged.discard().catch(cleanup => logApiFailure("upload-cleanup", cleanup));
        if (request.signal.aborted) throw new ProcessingError("Upload cancelled", 408);
        if (deadline.signal.aborted) throw new ProcessingError("Upload deadline exceeded", 408);
        if (failure) throw failure;
        if (error instanceof ProcessingError) throw error;
        throw new ProcessingError("Malformed multipart upload", 400);
    } finally { clearTimeout(timer); }
}

// Compatibility export for existing conflict request callers.
export { readBoundedJson } from "./bounded-json";
