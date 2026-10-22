import { logApiFailure } from "./api-diagnostics";
import { ApiInputError } from "./api-safety";
import { assertOriginalMediaPath, assertStagedMediaPath, InvalidMediaPathError } from "./media-paths";
import fs, { type FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { withDestinationLock, DestinationBusyError, DestinationRecoveryError } from "./destination-lock";
import { validateStorage, StorageUnavailableError, type ValidatedStorage } from "./storage-safety";

const chunkSize = 64 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const recoveryName = /\.(?:backup|publish)-[0-9a-f-]{36}$/i;
export class MediaDeliveryError extends Error {
    constructor(public status: number, message: string) { super(message); }
}
export type MediaStreamSelection = {
    filePath: string;
    destination: string;
    fileName: string;
    incomingConflictId?: string;
    preview?: boolean;
    // Repeat the authoritative metadata selection while the destination is owned.
    revalidate: () => Promise<void>;
};

export function mediaContentType(fileName: string): string | undefined {
    const types: Record<string, string> = {
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
        ".gif": "image/gif", ".avif": "image/avif", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
    };
    return types[path.extname(fileName).toLowerCase()];
}

function relativePath(root: string, target: string): string[] {
    if (!path.isAbsolute(target) || path.resolve(target) !== target || target.includes("\0")) throw new MediaDeliveryError(404, "Media unavailable");
    const relative = path.relative(root, target);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new MediaDeliveryError(404, "Media unavailable");
    return relative.split(path.sep);
}
function originalPath(root: string, target: string) {
    try { assertOriginalMediaPath(root, target); }
    catch { throw new MediaDeliveryError(404, "Media unavailable"); }
    const parts = relativePath(root, target);
    const name = parts.at(-1)!;
    if (parts.slice(0, -1).some(part => part.startsWith(".")) || (name.startsWith(".") && !mediaContentType(name)) || recoveryName.test(name)) throw new MediaDeliveryError(404, "Media unavailable");
}
function selectionPaths(root: string, selection: MediaStreamSelection) {
    originalPath(root, selection.destination);
    if (selection.incomingConflictId !== undefined) {
        try { assertStagedMediaPath(root, selection.filePath, selection.incomingConflictId); }
        catch { throw new MediaDeliveryError(404, "Preview unavailable"); }
        const parts = relativePath(root, selection.filePath);
        if (!uuid.test(selection.incomingConflictId) || parts.length !== 3 || parts[0] !== ".incoming" || parts[1] !== selection.incomingConflictId
            || (parts[2].startsWith(".") && !mediaContentType(parts[2])) || recoveryName.test(parts[2])) throw new MediaDeliveryError(404, "Preview unavailable");
    } else {
        originalPath(root, selection.filePath);
        if (selection.filePath !== selection.destination) throw new MediaDeliveryError(404, "Media unavailable");
    }
}
async function publicFilePath(target: string, allowMissing = false) {
    try {
        if (await fs.realpath(target) !== target || !(await fs.lstat(target)).isFile()) throw new MediaDeliveryError(404, "Media unavailable");
    } catch (error) {
        if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}

function identity(stat: BigIntStats) { return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":"); }
function abort(signal: AbortSignal) { if (signal.aborted) throw new DOMException("Request aborted", "AbortError"); }

async function pinFile(storage: ValidatedStorage, filePath: string): Promise<{ handle: FileHandle; stat: BigIntStats }> {
    await storage.assertAvailable(filePath);
    if (await fs.realpath(filePath) !== filePath) throw new MediaDeliveryError(404, "Media unavailable");
    const before = await fs.lstat(filePath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw new MediaDeliveryError(404, "Media unavailable");
    // NONBLOCK prevents a swapped FIFO/device from hanging open before fstat.
    const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const stat = await handle.stat({ bigint: true });
        if (!stat.isFile() || identity(stat) !== identity(before) || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new MediaDeliveryError(409, "Media changed; retry");
        // NOFOLLOW protects the leaf. Linux /proc also binds the opened descriptor
        // to the exact authorized path if a parent was swapped to a symlink.
        if (await fs.realpath(`/proc/self/fd/${handle.fd}`) !== filePath) throw new MediaDeliveryError(404, "Media unavailable");
        await storage.assertAvailable(filePath);
        const after = await fs.lstat(filePath, { bigint: true });
        if (identity(after) !== identity(stat) || after.isSymbolicLink()) throw new MediaDeliveryError(409, "Media changed; retry");
        const root = await fs.stat(storage.root, { bigint: true });
        if (stat.dev !== root.dev) throw new MediaDeliveryError(404, "Media unavailable");
        return { handle, stat };
    } catch (error) { await handle.close(); throw error; }
}

// Unsupported/malformed/multiple ranges are deliberately ignored (200).
// Valid ranges with no bytes in this representation return 416.
export function singleByteRange(header: string | null, size: number): { start: number; end: number } | "unsatisfiable" | undefined {
    if (!header || header.length > 256) return undefined;
    const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
    if (!match || (!match[1] && !match[2])) return undefined;
    const total = BigInt(size);
    if (!match[1]) {
        const suffix = BigInt(match[2]);
        if (suffix === BigInt(0) || total === BigInt(0)) return "unsatisfiable";
        return { start: Number(suffix >= total ? BigInt(0) : total - suffix), end: size - 1 };
    }
    const start = BigInt(match[1]), end = match[2] ? BigInt(match[2]) : total - BigInt(1);
    if (match[2] && end < start) return undefined;
    if (start >= total) return "unsatisfiable";
    return { start: Number(start), end: Number(end >= total ? total - BigInt(1) : end) };
}

function disposition(fileName: string) {
    const name = path.win32.basename(path.basename(fileName));
    const fallback = name.replace(/[^\x20-\x7e]|["\\;]/g, "_");
    // encodeURIComponent rejects lone surrogates rather than constructing unsafe headers.
    const encoded = encodeURIComponent(name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function fileBody(handle: FileHandle, storage: ValidatedStorage, stat: BigIntStats, start: number, end: number, signal: AbortSignal) {
    let position = start, stopped = false, cancelled = false;
    let closing: Promise<void> | undefined;
    let onAbort: () => void;
    const close = () => {
        if (!closing) {
            stopped = true;
            signal.removeEventListener("abort", onAbort);
            closing = handle.close();
        }
        return closing;
    };
    return new ReadableStream<Uint8Array>({
        start(controller) {
            onAbort = () => {
                cancelled = true;
                controller.error(new DOMException("Request aborted", "AbortError"));
                void close().catch(() => {});
            };
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) onAbort();
        },
        async pull(controller) {
            if (stopped) return;
            try {
                // Check the mounted device throughout delivery, not the pathname:
                // rename/unlink may legitimately detach this already-pinned inode.
                await storage.assertAvailable();
                if (stopped) return;
                const current = await handle.stat({ bigint: true });
                if (current.dev !== stat.dev || current.ino !== stat.ino || current.size !== stat.size || current.mtimeNs !== stat.mtimeNs) throw new Error("Pinned media changed during streaming");
                if (stopped) return;
                const buffer = Buffer.allocUnsafe(Math.min(chunkSize, end - position + 1));
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
                if (stopped) return;
                if (!bytesRead) throw new Error("Media ended before its declared length");
                position += bytesRead;
                controller.enqueue(buffer.subarray(0, bytesRead));
                if (position > end) {
                    await close();
                    if (!cancelled) controller.close();
                }
            } catch (error) {
                logApiFailure("media-stream", error);
                try { await close(); } catch (cleanup) { logApiFailure("media-stream-close", cleanup); }
                if (!cancelled) controller.error(new Error("Media stream unavailable"));
            }
        },
        async cancel() { cancelled = true; await close(); },
    }, { highWaterMark: 0 });
}

export async function streamMediaFile(request: Request, selection: MediaStreamSelection): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") throw new MediaDeliveryError(405, "Method not allowed");
    abort(request.signal);
    const storage = await validateStorage();
    selectionPaths(storage.root, selection);
    await publicFilePath(selection.filePath);
    if (selection.destination !== selection.filePath) await publicFilePath(selection.destination, true);
    const contentType = mediaContentType(selection.fileName);
    if (selection.preview && !contentType) throw new MediaDeliveryError(415, "Preview unavailable");
    let opened: { handle: FileHandle; stat: BigIntStats } | undefined;
    let transferred = false;
    try {
        await withDestinationLock(storage.root, selection.destination, async lock => {
            abort(request.signal);
            await selection.revalidate();
            await lock.revalidate();
            opened = await pinFile(storage, selection.filePath);
            abort(request.signal);
        });
        const { handle, stat } = opened!;
        abort(request.signal);
        const size = Number(stat.size);
        const etag = `"${createHash("sha256").update(identity(stat)).digest("hex")}"`;
        const headers = new Headers({
            "Content-Type": contentType ?? "application/octet-stream", "Content-Length": String(size),
            "Accept-Ranges": "bytes", "ETag": etag, "Last-Modified": new Date(Number(stat.mtimeMs)).toUTCString(),
            "Cache-Control": "private, no-store, no-transform", "X-Content-Type-Options": "nosniff",
        });
        if (!selection.preview) headers.set("Content-Disposition", disposition(selection.fileName));
        // Range applies to GET only. If-Range requires an exact strong generation
        // ETag; dates/weak/stale validators safely fall back to a full response.
        const ifRange = request.headers.get("if-range");
        const range = request.method === "GET" && (!ifRange || ifRange === etag) ? singleByteRange(request.headers.get("range"), size) : undefined;
        if (range === "unsatisfiable") {
            headers.set("Content-Range", `bytes */${size}`); headers.set("Content-Length", "0");
            return new Response(null, { status: 416, headers });
        }
        if (range) {
            headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
            headers.set("Content-Length", String(range.end - range.start + 1));
        }
        if (request.method === "HEAD" || !size) return new Response(null, { status: 200, headers });
        const body = fileBody(handle, storage, stat, range?.start ?? 0, range?.end ?? size - 1, request.signal);
        const response = new Response(body, { status: range ? 206 : 200, headers });
        transferred = true;
        return response;
    } finally { if (opened && !transferred) await opened.handle.close(); }
}

export function mediaErrorResponse(request: Request, error: unknown, fallback = "Media unavailable", options: { defaultStatus?: number; json?: boolean } = {}) {
    const requestId = logApiFailure("media-delivery", error);
    const code = (error as NodeJS.ErrnoException)?.code;
    const status = error instanceof ApiInputError ? 400 : error instanceof MediaDeliveryError ? error.status
        : error instanceof InvalidMediaPathError ? 404
        : error instanceof DestinationBusyError || error instanceof DestinationRecoveryError || error instanceof StorageUnavailableError ? 503
        : ["ENOENT", "ENOTDIR", "ELOOP"].includes(code ?? "") ? 404 : options.defaultStatus ?? 500;
    const body = options.json ? JSON.stringify({ error: fallback }) : fallback;
    const headers: Record<string, string> = { "X-Request-ID": requestId, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        "Content-Type": options.json ? "application/json" : "text/plain; charset=utf-8", "Content-Length": String(Buffer.byteLength(body)) };
    if (status === 503) headers["Retry-After"] = "1";
    return new Response(request.method === "HEAD" ? null : body, { status, headers });
}
