import type { ConflictAction } from "./import-conflict";


export type ResolveConflictResponse =
    | {
        type: "SKIPPED";
    }
    | {
        type: "COMPLETED";
        mediaId: number;
    };

export async function resolveImportConflict(
    conflictId: string,
    action: ConflictAction
): Promise<ResolveConflictResponse> {
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

    const data = await response.json() as
        ResolveConflictResponse | { error?: string };

    if (!response.ok) {
        throw new Error(
            "error" in data && data.error
                ? data.error
                : "Failed to resolve import conflict"
        );
    }

    return data as ResolveConflictResponse;
}