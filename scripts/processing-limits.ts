import { InvalidMediaPathError } from "./media-paths";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

export class ProcessingError extends Error {
    constructor(message: string, public readonly status = 503) { super(message); }
}
function integer(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0) throw new ProcessingError(`Invalid ${name} configuration`, 503);
    return value;
}
export function processingLimits() {
    const uploadBytes = integer("MEDIA_MAX_UPLOAD_BYTES", 512 * 1024 * 1024);
    const requestBytes = integer("MEDIA_MAX_REQUEST_BYTES", uploadBytes + 64 * 1024);
    if (requestBytes < uploadBytes) throw new ProcessingError("MEDIA_MAX_REQUEST_BYTES must cover MEDIA_MAX_UPLOAD_BYTES");
    return {
        uploadBytes, requestBytes,
        tempBytes: integer("MEDIA_MAX_TEMP_BYTES", 2 * 1024 ** 3),
        freeBytes: integer("MEDIA_MIN_FREE_BYTES", 1024 ** 3),
        jobs: integer("MEDIA_MAX_CONCURRENT_JOBS", 2),
        subprocesses: integer("MEDIA_MAX_SUBPROCESSES", 2),
        subprocessMs: integer("MEDIA_SUBPROCESS_TIMEOUT_MS", 60_000),
        uploadMs: integer("MEDIA_UPLOAD_TIMEOUT_MS", 120_000),
        outputBytes: integer("MEDIA_SUBPROCESS_OUTPUT_BYTES", 1024 * 1024),
        thumbnailBytes: integer("MEDIA_MAX_THUMBNAIL_BYTES", 16 * 1024 * 1024),
        pixels: integer("MEDIA_MAX_IMAGE_PIXELS", 40_000_000),
    };
}
export function assertSupportedUpload(name: string) {
    if (!/\.(jpg|jpeg|png|gif|svg|heif|tiff|raw|webp|avif|mp4|mov|avi|mkv|webm|wmv)$/i.test(path.extname(name))) {
        throw new ProcessingError("Unsupported media extension", 415);
    }
}
// No waiting queue: overloaded callers must retry, rather than retain request bodies.
export class AdmissionGate {
    private active = 0;
    async run<T>(maximum: number, work: () => Promise<T>): Promise<T> {
        if (this.active >= maximum) throw new ProcessingError("Media processor busy; retry later");
        this.active++;
        try { return await work(); } finally { this.active--; }
    }
}
const jobs = new AdmissionGate();
const context = new AsyncLocalStorage<{ signal?: AbortSignal }>();
export function processingSignal() { return context.getStore()?.signal; }
export function checkProcessingCancellation() {
    if (processingSignal()?.aborted) throw new ProcessingError("Media request cancelled", 408);
}
export function withProcessingJob<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    return jobs.run(processingLimits().jobs, () => context.run({ signal }, async () => {
        checkProcessingCancellation();
        return work();
    }));
}
export function processingErrorResponse(error: unknown) {
    const status = error instanceof ProcessingError ? error.status : error instanceof InvalidMediaPathError ? 400 : 500;
    return Response.json({ error: error instanceof Error ? error.message : "Media operation failed" }, {
        status, headers: status === 503 ? { "Retry-After": "5" } : {},
    });
}
