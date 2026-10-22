import { pathId } from "@/scripts/api-safety";
import { processingErrorResponse } from "@/scripts/processing-limits";
import { readStorageFile } from "@/scripts/storage-safety";

import { getMediaFileById } from "@/scripts/media-database";
import { getOrCreateThumbnail } from "@/scripts/media-thumbnail";


type RouteContext = {
    params: Promise<{ mediaId: string }>;
};


export async function GET(
    _request: Request,
    context: RouteContext
) {
    try {
        const parsedMediaId = pathId((await context.params).mediaId);
        const media = await getMediaFileById(parsedMediaId);
        if (!media) return Response.json({ error: "Media not found" }, { status: 404 });
        const thumbnailPath =
            await getOrCreateThumbnail(
                media.media_id,
                media.path,
                media.file_type,
                _request.signal
            );

        const thumbnail =
            await readStorageFile(thumbnailPath);

        return new Response(thumbnail, {
            headers: {
                "Content-Type": "image/webp",
                "Content-Disposition":
                    `inline; filename="${media.media_id}.webp"`,
            },
        });
    }
    catch (error) {
        return processingErrorResponse(error);
    }
}