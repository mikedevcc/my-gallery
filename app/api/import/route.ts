import { processStagedMedia } from "@/scripts/media-import-service";
import { parseUpload } from "@/scripts/upload-request";
import { withProcessingJob, processingErrorResponse } from "@/scripts/processing-limits";

export async function POST(request: Request) {
    try {
        return await withProcessingJob(request.signal, async () => {
            const { stagedPath, jobId } = await parseUpload(request);
            const result = await processStagedMedia(stagedPath, jobId);
            if (result.type === "CONFLICT") return Response.json({ conflict: result.conflict }, { status: 409 });
            return Response.json({ message: "received", mediaId: result.mediaId });
        });
    } catch (error) {
        console.error("Import API failed:", error);
        return processingErrorResponse(error);
    }
}
