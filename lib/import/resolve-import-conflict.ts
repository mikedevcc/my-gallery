import type { ConflictAction, PublicImportConflict } from "./import-conflict";
import { ImportFailure, type createImportNotifier } from "./import-feedback";

export type ResolveConflictResponse = { type: "SKIPPED" } | { type: "COMPLETED"; mediaId: number };
export async function resolveImportConflict(conflictId: string, action: ConflictAction): Promise<ResolveConflictResponse> {
    try {
        const response = await fetch("/api/import/conflict", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ conflictId, action }),
        });
        const data = await response.json();
        if (response.ok && data?.type === "SKIPPED") return { type: "SKIPPED" };
        if (response.ok && data?.type === "COMPLETED" && Number.isSafeInteger(data.mediaId) && data.mediaId > 0) return { type: "COMPLETED", mediaId: data.mediaId };
    } catch { /* The server may have committed before the connection failed. */ }
    throw new ImportFailure("Resolution could not be confirmed. Refresh pending conflicts before trying again; recovery may require administrator attention.");
}

// Flush confirmed changes even if a later resolution fails; never replay that batch.
export async function resolveConflictBatch(
    conflicts: PublicImportConflict[], action: ConflictAction,
    onResolved: (conflict: PublicImportConflict, result: ResolveConflictResponse) => void,
    notifier: ReturnType<typeof createImportNotifier>,
) {
    try {
        for (const conflict of conflicts) {
            const result = await resolveImportConflict(conflict.conflictId, action);
            if (result.type === "COMPLETED") notifier.confirmed(`conflict:${conflict.conflictId}`);
            onResolved(conflict, result);
        }
    } finally { notifier.flush(); }
}
