import { randomUUID } from "node:crypto";

// Never serialize an Error, request body, URL, environment, SQL parameters or raw
// stack/message. Record diagnostic categories/codes and source locations instead.
export function logApiFailure(context: string, error: unknown): string {
    const requestId = randomUUID();
    const seen = new Set<unknown>();
    function diagnostic(value: unknown, depth = 0): object {
        if (!(value instanceof Error) || depth > 3 || seen.has(value)) return { type: "UnknownError" };
        seen.add(value);
        const type = value.constructor.name;
        const code = (value as NodeJS.ErrnoException).code;
        const header = `${value.name}: ${value.message}`;
        const stack = value.stack ?? "";
        const frames = (stack.startsWith(header) ? stack.slice(header.length) : "").split("\n").flatMap(line => {
            const match = /(?:\/|\\)([a-zA-Z0-9_.-]{1,120}\.(?:ts|tsx|js|mjs|cjs)):(\d+):(\d+)\)?$/.exec(line);
            return match ? [`${match[1]}:${match[2]}:${match[3]}`] : [];
        }).slice(0, 8);
        return {
            type: /^[A-Za-z]+Error$/.test(type) ? type : "Error",
            code: typeof code === "string" && /^(?:[0-9A-Z]{5}|E[A-Z_]{2,30})$/.test(code) ? code : undefined,
            frames,
            cause: value.cause === undefined ? undefined : diagnostic(value.cause, depth + 1),
            errors: value instanceof AggregateError ? [...value.errors].slice(0, 4).map(item => diagnostic(item, depth + 1)) : undefined,
        };
    }
    try { console.error("[api] Request failed", { requestId, context, diagnostic: diagnostic(error) }); }
    catch { /* Diagnostic failures must never interrupt response or file cleanup. */ }
    return requestId;
}
