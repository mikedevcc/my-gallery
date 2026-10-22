import { ApiInputError, conflictId } from "@/scripts/api-safety";
import path from "node:path";
import { getConflictPreviewSelection } from "@/scripts/pending-import-conflicts";
import { streamMediaFile, mediaErrorResponse, MediaDeliveryError } from "@/scripts/media-stream";

export const runtime = "nodejs";
async function serve(request: Request) {
    const url = new URL(request.url);
    const id = url.searchParams.get("id") ?? "", side = url.searchParams.get("side") ?? "";
    try {
        conflictId(id);
        if (side !== "incoming" && side !== "existing") throw new ApiInputError("Invalid preview side");
        const selection = await getConflictPreviewSelection(id, side);
        return await streamMediaFile(request, {
            filePath: selection.filePath, destination: selection.destination, fileName: path.basename(selection.filePath),
            incomingConflictId: side === "incoming" ? id : undefined, preview: true,
            revalidate: async () => {
                const current = await getConflictPreviewSelection(id, side);
                if (current.filePath !== selection.filePath || current.destination !== selection.destination || current.metadata !== selection.metadata) throw new MediaDeliveryError(409, "Conflict changed; retry");
            },
        });
    } catch (error) {
        return mediaErrorResponse(request, error, "Preview unavailable", { defaultStatus: 404 });
    }
}
export const GET = serve;
export const HEAD = serve;
