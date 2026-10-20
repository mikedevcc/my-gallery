import {
    addMediaToAlbum,
    getAlbumById,
    moveMediaToAlbum,
    removeMediaFromAlbum,
    copyMediaToAlbum,
} from "@/scripts/media-database";


type RouteContext = {
    params: Promise<{
        albumId: string;
    }>;
};

type MediaRequest = {
    mediaId?: number;
};

type AlbumRequest = {
    mediaIds: number[];
    targetAlbumId: number;
    operation: 'move' | 'copy';
};


export async function POST(
    request: Request,
    context: RouteContext
) {
    const { albumId } = await context.params;
    const parsedAlbumId = Number(albumId);

    const body = await request.json() as MediaRequest;
    const mediaId = body.mediaId;
    
    if (!Number.isInteger(parsedAlbumId) || parsedAlbumId <= 0) {
        return Response.json(
            { error: "Invalid album ID" },
            { status: 400 }
        );
    }

    if (
        mediaId === undefined ||
        !Number.isInteger(mediaId) || 
        mediaId <= 0
    ) {
        return Response.json(
            { error: "Invalid media ID" },
            { status: 400 }
        );
    }

    const album = await getAlbumById(parsedAlbumId);

    if (!album) {
        return Response.json(
            { error: 'Album not found' },
            { status: 404 }
        );
    }

    await addMediaToAlbum(mediaId, parsedAlbumId);

    return Response.json(
        { message: "Media added to album" }
    )
}


export async function DELETE(
    request: Request,
    context: RouteContext
) {
    const { albumId } = await context.params;
    const parsedAlbumId = Number(albumId);

    const body = await request.json() as MediaRequest;
    const mediaId = body.mediaId;

    if (
        !Number.isInteger(parsedAlbumId) ||
        parsedAlbumId <= 0
    ) {
        return Response.json(
            { error: "Invalid album ID" },
            { status: 400 }
        );
    }

    if (
        mediaId === undefined ||
        !Number.isInteger(mediaId) || 
        mediaId <= 0
    ) {
        return Response.json(
            { error: "Invalid media ID" },
            { status: 400 }
        );
    }

    const removed = await removeMediaFromAlbum(mediaId, parsedAlbumId);

    if (!removed) {
        return Response.json(
            { error: "Media is not part of this album" },
            { status: 404 }
        );
    }

    return Response.json(
        { message: "Media removed from album" }
    )
}


export async function PATCH(
    request: Request,
    context: RouteContext
) {
    const { albumId } = await context.params;
    const sourceAlbumId = Number(albumId);

    const body = await request.json() as AlbumRequest;
    const mediaIds = body.mediaIds;
    const targetAlbumId = body.targetAlbumId;

    if (
        !Array.isArray(mediaIds) ||
        mediaIds.length === 0
    ) {
        return Response.json(
            { error: "No media selected" },
            { status: 400 }
        );
    }

    if (mediaIds.some(
        mediaId => 
            !Number.isInteger(mediaId) ||
            mediaId <= 0
        )
    ) {
        return Response.json(
            { error: "Invalid media ID" },
            { status: 400 }
        );
    }

    if (new Set(mediaIds).size !== mediaIds.length) {
        return Response.json(
            { error: "Duplicate media IDs" },
            { status: 400 }
        );
    }

    if (
        !Number.isInteger(sourceAlbumId) ||
        sourceAlbumId <= 0
    ) {
        return Response.json(
            { error: "Invalid source album ID" },
            { status: 400 }
        );
    }

    if (
        !Number.isInteger(targetAlbumId) ||
        targetAlbumId <= 0
    ) {
        return Response.json(
            { error: "Invalid target album ID" },
            { status: 400 }
        );
    }

    if (targetAlbumId === sourceAlbumId) {
        return Response.json(
            { error: "Source and target album IDs are the same" },
            { status: 400 }
        );
    }

    const sourceAlbum =
        await getAlbumById(sourceAlbumId);

    if (!sourceAlbum) {
        return Response.json(
            { error: 'Source album not found' },
            { status: 404 }
        );
    }

    const targetAlbum = await getAlbumById(targetAlbumId);

    if (!targetAlbum) {
        return Response.json(
            { error: "Target album not found" },
            { status: 404 }
        );
    }

    if (body.operation === 'copy') {
        await copyMediaToAlbum(
            mediaIds,
            sourceAlbumId,
            targetAlbumId
        );
    }
    else if (body.operation === 'move') {
        await moveMediaToAlbum(
            mediaIds,
            sourceAlbumId,
            targetAlbumId
        );
    }
    else {
        return Response.json(
            { error: 'Invalid album operation' },
            { status: 400 }
        );
    }

    return Response.json(
        {
            message:
                body.operation === 'move'
                    ? 'Media moved successfully'
                    : 'Media copied successfully',

            affectedCount: mediaIds.length,
        },
        { status: 200 }
    );
}


