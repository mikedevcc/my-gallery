import type { ConflictAction } from "@/lib/import/import-conflict";
import { resolveStagedConflict } from "@/scripts/media-import-service";

type ResolveConflictRequest = {
    conflictId: string;
    action: ConflictAction;
};

export async function POST(request: Request) {
    const body = await request.json() as ResolveConflictRequest;

    const { conflictId, action } = body;

    if (!conflictId || !action) {
        return Response.json(
            { error: "Missing conflictId or action" },
            { status: 400 }
        );
    }

    const result = await resolveStagedConflict(
        conflictId,
        action
    );

    return Response.json(result);
}