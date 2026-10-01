import type { ConflictAction } from "@/lib/import/import-conflict";
import { removeStagedConflict } from "@/scripts/media-storage";
import { resolveStagedConflict } from "@/scripts/media-import-service";

type ResolveConflictRequest = {
    conflictId: string;
    action: ConflictAction;
};

export async function POST(request: Request) {
    const body = await request.json() as ResolveConflictRequest;

    const { conflictId, action } = body;

    resolveStagedConflict(conflictId, action)

    if (!conflictId || !action) {
        return Response.json(
            { error: "Missing conflictId or action" },
            { status: 400 }
        );
    }

    if (action !== "SKIP") {
        return Response.json(
            { error: "Conflict action not implemented yet" },
            { status: 400 }
        );
    }

    await removeStagedConflict(conflictId);

    return Response.json({
        type: "SKIPPED",
    });
}