import { readBoundedJson } from "@/scripts/upload-request";
import { withProcessingJob, processingErrorResponse, ProcessingError } from "@/scripts/processing-limits";
import { listPendingConflicts } from "@/scripts/pending-import-conflicts";
import type { ConflictAction } from "@/lib/import/import-conflict";
import { resolveStagedConflict } from "@/scripts/media-import-service";

type ResolveConflictRequest = {
    conflictId: string;
    action: ConflictAction;
};

export async function POST(request: Request) {
    try {
        return await withProcessingJob(request.signal, async () => {
            const body = await readBoundedJson(request) as ResolveConflictRequest;
            if (!body || typeof body !== "object") throw new ProcessingError("Invalid conflict request", 400);

            const { conflictId, action } = body;

            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(conflictId ?? "") || !["SKIP", "KEEP_BOTH", "REPLACE"].includes(action)) {
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
        });
    } catch (error) {
        return processingErrorResponse(error);
    }
}

export async function GET(request: Request) {
    try {
        return await withProcessingJob(request.signal, async () => Response.json({ conflicts: await listPendingConflicts() }, { headers: { "Cache-Control": "no-store" } }));
    } catch (error) { return processingErrorResponse(error); }
}
