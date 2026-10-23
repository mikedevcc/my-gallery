import { publicImportConflict } from "@/scripts/api-dto";
import { processStagedMedia } from "@/scripts/media-import-service";
import { parseUpload } from "@/scripts/upload-request";
import { withProcessingJob, processingErrorResponse } from "@/scripts/processing-limits";

export async function POST(request: Request) {
    let started = false;
    try {
        return await withProcessingJob(request.signal, async () => {
            started = true;
            const { stagedPath, jobId, fileLastModified } = await parseUpload(request);
            const result = await processStagedMedia(stagedPath, jobId, fileLastModified);
            if (result.type === "CONFLICT") return Response.json({ conflict: publicImportConflict(result.conflict) }, { status: 409 });
            return Response.json({ message: "received", mediaId: result.mediaId });
        });
    } catch (error) {
        const response = processingErrorResponse(error);
        // Only admission rejection proves that no staging or import mutation ran.
        if (!started && response.status === 503) response.headers.set("X-Import-Retry-Safe", "1");
        return response;
    }
}
