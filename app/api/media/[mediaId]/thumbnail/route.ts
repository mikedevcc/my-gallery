import fs from "node:fs/promises";

import { getMediaFileById } from "@/scripts/media-database";
import { getOrCreateThumbnail } from "@/scripts/media-thumbnail";


type RouteContext = {
    params: Promise<{ mediaId: string }>;
};


export async function GET(
    _request: Request,
    context: RouteContext
) {
    const { mediaId } = await context.params;

    const parsedMediaId = Number(mediaId);

    if (
        !Number.isInteger(parsedMediaId) ||
        parsedMediaId <= 0
    ) {
        return Response.json(
            { error: "Invalid media ID" },
            { status: 400 }
        );
    }

    const media = await getMediaFileById(parsedMediaId);

    if (!media) {
        return Response.json(
            { error: "Media not found" },
            { status: 404 }
        );
    }

    try {
        const thumbnailPath =
            await getOrCreateThumbnail(
                media.media_id,
                media.path,
                media.file_type
            );

        const thumbnail =
            await fs.readFile(thumbnailPath);

        return new Response(thumbnail, {
            headers: {
                "Content-Type": "image/webp",
                "Content-Disposition":
                    `inline; filename="${media.media_id}.webp"`,
            },
        });
    }
    catch (error) {
        console.error(
            `Failed to read thumbnail for media ${parsedMediaId}:`,
            error
        );

        return Response.json(
            { error: "Thumbnail could not be read" },
            { status: 500 }
        );
    }
}