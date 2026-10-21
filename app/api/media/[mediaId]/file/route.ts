import { getMediaFileById } from "@/scripts/media-database";
import { streamMediaFile, mediaErrorResponse, MediaDeliveryError } from "@/scripts/media-stream";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ mediaId: string }> };

async function serve(request: Request, context: RouteContext) {
    const { mediaId } = await context.params;
    const parsedMediaId = Number(mediaId);
    if (!Number.isSafeInteger(parsedMediaId) || parsedMediaId <= 0) return mediaErrorResponse(request, new MediaDeliveryError(400, "Invalid media ID"), "Invalid media ID", { json: true });
    try {
        const media = await getMediaFileById(parsedMediaId);
        if (!media) return mediaErrorResponse(request, new MediaDeliveryError(404, "Media not found"), "Media not found", { json: true });
        return await streamMediaFile(request, {
            filePath: media.path, destination: media.path, fileName: media.file_name,
            revalidate: async () => {
                const current = await getMediaFileById(parsedMediaId);
                if (!current) throw new MediaDeliveryError(404, "Media not found");
                if (current.path !== media.path || current.file_name !== media.file_name || current.file_type !== media.file_type) throw new MediaDeliveryError(409, "Media changed; retry");
            },
        });
    } catch (error) { return mediaErrorResponse(request, error, "Media unavailable", { json: true }); }
}
export const GET = serve;
export const HEAD = serve;
