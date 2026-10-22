import { readBoundedJson, JsonRequestError, type JsonProfile } from "./bounded-json";
import { logApiFailure } from "./api-diagnostics";
import { StorageUnavailableError } from "./storage-safety";
import { DestinationBusyError, DestinationRecoveryError } from "./destination-lock";
import { RuntimeConfigurationError } from "./runtime-config";

export class ApiInputError extends Error {}
export async function jsonObject(request: Request, profile: JsonProfile = "single"): Promise<Record<string, unknown>> {
    return objectBody(await readBoundedJson(request, profile));
}
export function objectBody(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ApiInputError("Expected a JSON object");
    return value as Record<string, unknown>;
}
export function positiveId(value: unknown): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 2147483647) throw new ApiInputError("Invalid ID");
    return value;
}
export function pathId(value: string): number {
    if (!/^[1-9]\d*$/.test(value)) throw new ApiInputError("Invalid ID");
    return positiveId(Number(value));
}
export function collectionName(value: unknown): string {
    if (typeof value !== "string") throw new ApiInputError("Collection name must be a string");
    const name = value.trim();
    if (!name || [...name].length > 100 || /[\u0000\ud800-\udfff]/u.test(name)) throw new ApiInputError("Collection name must contain 1–100 characters");
    return name;
}
export function conflictId(value: unknown): string {
    if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new ApiInputError("Invalid conflict ID");
    return value;
}
const messages: Record<number, string> = {
    400: "Invalid request", 404: "Not found", 408: "Request cancelled or timed out",
    409: "Operation conflicts with the current state; refresh and retry",
    413: "Request too large", 415: "Unsupported media type", 422: "Media could not be processed",
    500: "Request failed", 502: "Upstream service unavailable", 503: "Service temporarily unavailable",
    504: "Processing timed out", 507: "Insufficient storage",
};
export function safeApiError(error: unknown, context: string, options: { status?: number; mediaIds?: number[] } = {}) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    const status = error instanceof JsonRequestError ? error.status : error instanceof ApiInputError ? 400 : options.status
        ?? (error instanceof StorageUnavailableError || error instanceof DestinationBusyError || error instanceof DestinationRecoveryError || error instanceof RuntimeConfigurationError ? 503
            : code === "23505" || code === "23503" ? 409
                : ["22001", "22003", "22P02", "23514"].includes(code ?? "") ? 400 : 500);
    const safeStatus = Object.hasOwn(messages, status) ? status : 500;
    const requestId = logApiFailure(context, error);
    return Response.json({
        error: error instanceof ApiInputError ? error.message : messages[safeStatus],
        ...(options.mediaIds ? { mediaIds: options.mediaIds.filter(id => Number.isInteger(id) && id > 0 && id <= 2147483647) } : {}),
    }, { status: safeStatus, headers: {
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Request-ID": requestId,
        ...(safeStatus === 503 ? { "Retry-After": "5" } : {}),
    } });
}
