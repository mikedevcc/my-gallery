import { deleteAlbum, getAlbumById, getMediaByAlbumId, renameAlbum } from "@/scripts/media-database";


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


export async function PATCH(
    request: Request,
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

    const body = await request.json() as {
        albumName?: string;
    };

    const albumName = body.albumName?.trim();

    if (!albumName) {
        return Response.json(
            { error: "No album name provided" },
            { status: 400 }
        );
    }

    if (albumName.length > 100
    ) {
        return Response.json(
            { error: "Invalid album name" },
            { status: 400 }
        );
    }

    const success = await renameAlbum(parsedAlbumId, albumName);

    if (!success) {
        return Response.json(
            { error: `Failed to rename album ${parsedAlbumId}`},
            { status: 404 }
        );
    }

    return Response.json(
        { 
            message: "Successfully renamed album",
            albumId: parsedAlbumId,
        },
        { status: 200 }
    )
}


export async function DELETE(
    _request: Request,
    context: RouteContext
) {
    const { albumId } = await context.params;
    const parsedAlbumId = Number(albumId);

    if (
        !Number.isInteger(parsedAlbumId) || parsedAlbumId <= 0) {
        return Response.json(
            { error: "Invalid album ID" },
            { status: 400 }
        )
    }

    const success = await deleteAlbum(parsedAlbumId);

    if (!success) {
        return Response.json(
            { error: `Failed to delete album ${parsedAlbumId}`},
            { status: 404 }
        );
    }

    return Response.json(
        {
            message: "Successfully deleted album",
            albumId: parsedAlbumId
        },
        { status: 200 }
    )
}