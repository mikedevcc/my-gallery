import { positiveInteger, type Environment } from "./runtime-config";

export class JsonRequestError extends Error {
    constructor(message: string, public readonly status: 400 | 408 | 413) { super(message); }
}
export type JsonProfile = "single" | "bulk";

// Hard ceilings keep a mistaken configuration from disabling the safety bounds.
export function jsonLimits(env: Environment = process.env) {
    return {
        singleBytes: positiveInteger(env, "API_JSON_MAX_BYTES", 4096, 1024 * 1024),
        bulkBytes: positiveInteger(env, "API_JSON_BULK_MAX_BYTES", 65536, 1024 * 1024),
        timeoutMs: positiveInteger(env, "API_JSON_TIMEOUT_MS", 10_000, 60_000),
        ids: positiveInteger(env, "API_JSON_MAX_IDS", 500, 10_000),
        depth: positiveInteger(env, "API_JSON_MAX_DEPTH", 4, 16),
        nodes: positiveInteger(env, "API_JSON_MAX_NODES", 2048, 100_000),
    };
}

/** Bounded streaming consumption, strict UTF-8 and bounded JSON structure. */
export async function readBoundedJson(request: Request, profile: JsonProfile = "single"): Promise<unknown> {
    const limits = jsonLimits();
    const maximum = profile === "bulk" ? limits.bulkBytes : limits.singleBytes;
    const cancelBody = () => { void request.body?.cancel().catch(() => {}); };
    if (request.signal.aborted) { cancelBody(); throw new JsonRequestError("Request cancelled", 408); }
    const length = request.headers.get("content-length");
    if (length !== null) {
        if (!/^\d+$/.test(length)) { cancelBody(); throw new JsonRequestError("Invalid Content-Length", 400); }
        if (Number(length) > maximum) { cancelBody(); throw new JsonRequestError("JSON request too large", 413); }
    }
    if (!request.body) throw new JsonRequestError("Missing JSON body", 400);
    const reader = request.body.getReader();
    const started = performance.now();
    let failure: JsonRequestError | undefined;
    const stop = (message: string) => {
        failure ??= new JsonRequestError(message, 408);
        void reader.cancel().catch(() => {});
    };
    const abort = () => stop("Request cancelled");
    const timer = setTimeout(() => stop("JSON request deadline exceeded"), limits.timeoutMs);
    request.signal.addEventListener("abort", abort, { once: true });
    const check = () => {
        if (failure) throw failure;
        if (request.signal.aborted) throw new JsonRequestError("Request cancelled", 408);
        if (performance.now() - started >= limits.timeoutMs) throw new JsonRequestError("JSON request deadline exceeded", 408);
    };
    // One bounded buffer avoids retaining an unbounded list of tiny chunks.
    const bytes = Buffer.allocUnsafe(maximum);
    let size = 0;
    try {
        check();
        while (true) {
            // cancel() resolves pending native stream reads immediately, even when
            // the upstream cancel hook stays pending. Avoid accumulating one
            // Promise.race rejection handler per input chunk on a shared promise.
            const chunk = await reader.read();
            check();
            if (chunk.done) break;
            if (chunk.value.byteLength > maximum - size) throw new JsonRequestError("JSON request too large", 413);
            bytes.set(chunk.value, size);
            size += chunk.value.byteLength;
        }
        let value: unknown;
        try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))) as unknown; }
        catch { check(); throw new JsonRequestError("Malformed JSON request", 400); }
        check();
        const pending: { value: unknown; depth: number; bulkIds: boolean }[] = [{ value, depth: 0, bulkIds: false }];
        let nodes = 0;
        while (pending.length) {
            check();
            const item = pending.pop()!;
            if (++nodes > limits.nodes) throw new JsonRequestError("JSON structure too large", 413);
            if (item.depth > limits.depth) throw new JsonRequestError("JSON structure is too deeply nested", 400);
            if (Array.isArray(item.value)) {
                if (item.value.length > (item.bulkIds ? limits.ids : 32)) throw new JsonRequestError("JSON array too large", 413);
                for (const child of item.value) pending.push({ value: child, depth: item.depth + 1, bulkIds: false });
            } else if (item.value !== null && typeof item.value === "object") {
                for (const [key, child] of Object.entries(item.value)) pending.push({ value: child, depth: item.depth + 1, bulkIds: profile === "bulk" && item.depth === 0 && key === "mediaIds" });
            }
        }
        check();
        return value;
    } catch (error) {
        if (error instanceof JsonRequestError) throw error;
        check();
        throw new JsonRequestError("Could not read JSON request", 400);
    } finally {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", abort);
        // An upstream cancel hook may never settle. It must not hold the response open.
        void reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}
