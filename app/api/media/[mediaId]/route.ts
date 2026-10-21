import { getMediaDetailsById, setMediaFavorite } from "@/scripts/media-database";
import { deleteMediaById, getMediaFileById } from "@/scripts/media-database";
import { getMediaStorageRoot } from "@/scripts/media-storage";
import { deleteMediaAtDestination } from "@/scripts/media-mutations";
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

    const media = await getMediaFileById(parsedMediaId);

    const deleted = media && await deleteMediaAtDestination({
        root: getMediaStorageRoot(),
        destination: media.path,
        revalidateMetadata: async () => {
            const current = await getMediaFileById(parsedMediaId);
            if (!current) return false;
            if (current.path !== media.path) throw new Error("Media path changed; retry deletion");
            return true;
        },
        deleteMetadata: async verifyStorage => {
            const row = await deleteMediaById(parsedMediaId, verifyStorage);
            if (row && row.path !== media.path) throw new Error("Deleted media path changed; manual recovery required");
            return row !== undefined;
        },
        afterDelete: () => deleteThumbnail(parsedMediaId),
    });

    if (!deleted) {
        return Response.json(
            { error: 'Media not found' },
            { status: 404 }
        );
    }

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
