import { getMediaDetailsById, setMediaFavorite } from "@/scripts/media-database";
import { deleteMediaById } from "@/scripts/media-database";
import { deleteStoredMedia } from "@/scripts/media-storage";
import { deleteThumbnail } from "@/scripts/media-thumbnail";


type RouteContext = {
    params: Promise<{ mediaId: string }>;
};

type FavoriteRequest = {
    favorite: boolean
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

    const data = await getMediaDetailsById(parsedMediaId);

    if (!data) {
        return Response.json(
            { error: "Media not found" },
            { status: 404 }
        );
    }

    return Response.json(
        data,
        { status: 200 }
    );
}


export async function DELETE(
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
            { error: 'Invalid media ID' },
            { status: 400 }
        );
    }

    const deleted = await deleteMediaById(parsedMediaId);

    if (!deleted) {
        return Response.json(
            { error: 'Media not found' },
            { status: 404 }
        );
    }

    await deleteStoredMedia(deleted.path);

    await deleteThumbnail(deleted.media_id);

    return Response.json({message: 'Media deleted',});
}


export async function PATCH(
    request: Request,
    context: RouteContext
) {
    const { mediaId } = await context.params;
    const parsedMediaId = Number(mediaId);

    if (
        !Number.isInteger(parsedMediaId) ||
        parsedMediaId <= 0
    ) {
        return Response.json(
            { error: 'Invalid media ID' },
            { status: 400 }
        );
    }

    const body = await request.json() as FavoriteRequest; 
    const favoriteState = body.favorite;

    if (typeof favoriteState !== 'boolean') {
        return Response.json(
            { error: 'Invalid favorite state' },
            { status: 400 }
        );
    }

    const success = await setMediaFavorite(parsedMediaId, favoriteState);

    if (!success) {
        return Response.json(
            { error: "Favorite change failed" },
            { status: 400 }
        )
    }

    return Response.json(
        {
            message: "Favorite changed successfully",
            mediaId: parsedMediaId,
        },
        { status: 200 }
    )
}