import type { ConflictAction } from "./import-conflict";


type ResolveConflictResponse = {
    type?: "SKIPPED";
    error?: string;
};


export async function resolveImportConflict(
    conflictId: string,
    action: ConflictAction
): Promise<void> {
    const response = await fetch("/api/import/conflict", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            conflictId,
            action,
        }),
    });

    const data = await response.json() as ResolveConflictResponse;

    if (!response.ok) {
        throw new Error(
            data.error ??
            `Conflict resolution failed with status ${response.status}`
        );
    }

    
}