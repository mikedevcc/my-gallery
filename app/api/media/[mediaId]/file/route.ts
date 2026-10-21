import { readStorageFile } from "@/scripts/storage-safety";
import path from "node:path";

import {
    getMediaFileById,
} from "@/scripts/media-database";


type RouteContext = {
    params: Promise<{
        mediaId: string;
    }>;
};


function getContentType(fileName: string): string {
    const extension =
        path.extname(fileName).toLowerCase();

    switch (extension) {
        case ".jpg":
        case ".jpeg":
            return "image/jpeg";

        case ".png":
            return "image/png";

        case ".webp":
            return "image/webp";

        case ".gif":
            return "image/gif";

        case ".avif":
            return "image/avif";

        case ".mp4":
            return "video/mp4";

        case ".webm":
            return "video/webm";

        case ".mov":
            return "video/quicktime";

        default:
            return "application/octet-stream";
    }
}


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

    const media =
        await getMediaFileById(parsedMediaId);

    if (!media) {
        return Response.json(
            { error: "Media not found" },
            { status: 404 }
        );
    }

    try {
        const file = await readStorageFile(media.path);

        return new Response(file, {
            headers: {
                "Content-Type": getContentType(
                    media.file_name
                ),
                "Content-Disposition":
                    `inline; filename="${media.file_name}"`,
            },
        });
    }
    catch (error) {
        console.error(
            `Failed to read media ${parsedMediaId}:`,
            error
        );

        return Response.json(
            { error: "Media file could not be read" },
            { status: 500 }
        );
    }
}