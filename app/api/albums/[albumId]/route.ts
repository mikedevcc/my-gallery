import { getAlbumById, getMediaByAlbumId } from "@/scripts/media-database";


type RouteContext = {
    params: Promise<{
        albumId: string;
    }>;
};


export async function GET(
    _request: Request,
    context: RouteContext
) {
    const { albumId } = await context.params;

    const parsedAlbumId = Number(albumId);

    if (!Number.isInteger(parsedAlbumId) || parsedAlbumId <= 0) {
        return Response.json(
            { error: "Invalid album ID" },
            { status: 400 }
        );
    }

    const album = await getAlbumById(parsedAlbumId);

    if (!album) {
        return Response.json(
            { error: "Album not found" },
            { status: 404 }
        );
    }

    const media = await getMediaByAlbumId(parsedAlbumId);

    return Response.json({
        album,
        media,
    });
}