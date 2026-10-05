import { listPendingConflicts } from "@/scripts/pending-import-conflicts";
import type { ConflictAction } from "@/lib/import/import-conflict";
import { resolveStagedConflict } from "@/scripts/media-import-service";

type ResolveConflictRequest = {
    conflictId: string;
    action: ConflictAction;
};

export async function POST(request: Request) {
    const body = await request.json() as ResolveConflictRequest;

    const { conflictId, action } = body;

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(conflictId ?? "") || !["SKIP", "KEEP_BOTH", "REPLACE"].includes(action)) {
        return Response.json(
            { error: "Missing conflictId or action" },
            { status: 400 }
        );
    }

    try {
    const result = await resolveStagedConflict(
        conflictId,
        action
    );

    return Response.json(result);
    } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "Resolution failed" }, { status: 500 });
    }
}

export async function GET() {
    return Response.json({ conflicts: await listPendingConflicts() }, { headers: { "Cache-Control": "no-store" } });
}
