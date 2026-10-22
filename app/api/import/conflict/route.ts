import { publicImportConflict } from "@/scripts/api-dto";
import { ApiInputError, conflictId, objectBody } from "@/scripts/api-safety";
import { readBoundedJson } from "@/scripts/bounded-json";
import { withProcessingJob, processingErrorResponse } from "@/scripts/processing-limits";
import { listPendingConflicts } from "@/scripts/pending-import-conflicts";
import type { ConflictAction } from "@/lib/import/import-conflict";
import { resolveStagedConflict } from "@/scripts/media-import-service";

export async function POST(request: Request) {
    try {
        return await withProcessingJob(request.signal, async () => {
            const body = objectBody(await readBoundedJson(request));
            const id = conflictId(body.conflictId);
            const action = body.action;
            if (typeof action !== "string" || !["SKIP", "KEEP_BOTH", "REPLACE"].includes(action)) throw new ApiInputError("Invalid conflict action");

            const result = await resolveStagedConflict(
                id,
                action as ConflictAction
            );

            return Response.json(result.type === "SKIPPED" ? { type: result.type } : { type: result.type, mediaId: result.mediaId });
        });
    } catch (error) {
        return processingErrorResponse(error);
    }
}

export async function GET(request: Request) {
    try {
        return await withProcessingJob(request.signal, async () => Response.json({ conflicts: (await listPendingConflicts()).map(publicImportConflict) }, { headers: { "Cache-Control": "no-store" } }));
    } catch (error) { return processingErrorResponse(error); }
}
