import type { PublicImportConflict } from "./import-conflict";

export class ImportFailure extends Error {
    constructor(message: string, public readonly retryable = false) { super(message); }
}
export const uncertainImport = "Import outcome could not be confirmed. Check your library and refresh pending conflicts before selecting this file again.";
export function importFailure(error: unknown) {
    return error instanceof ImportFailure ? error : new ImportFailure(uncertainImport);
}

// Pick public fields explicitly; never pass internal paths through to the UI.
export function readConflict(value: unknown): PublicImportConflict {
    if (!value || typeof value !== "object") throw new ImportFailure(uncertainImport);
    const item = value as Record<string, unknown>;
    if (typeof item.jobId !== "string" || typeof item.conflictId !== "string") throw new ImportFailure(uncertainImport);
    const base = { jobId: item.jobId, conflictId: item.conflictId };
    const id = item.existingMediaId;
    if (item.type === "HASH" && Number.isSafeInteger(id) && (id as number) > 0) return { ...base, type: "HASH", existingMediaId: id as number };
    if (item.type === "FILENAME" && typeof item.existingFilename === "string") return { ...base, type: "FILENAME", existingFilename: item.existingFilename };
    throw new ImportFailure(uncertainImport);
}

// Operation IDs deduplicate confirmations; flush once even when later jobs fail.
export function createImportNotifier(notify: () => void) {
    const seen = new Set<string>();
    let pending = false;
    return {
        confirmed(id: string) { if (!seen.has(id)) { seen.add(id); pending = true; } },
        flush() { if (pending) { pending = false; notify(); } },
    };
}
