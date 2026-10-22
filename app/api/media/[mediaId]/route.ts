import { getMediaDetailsById, setMediaFavorite, deleteMediaById, getMediaFileById } from "@/scripts/media-database";
import { getMediaStorageRoot } from "@/scripts/media-storage";
import { deleteMediaAtDestination } from "@/scripts/media-mutations";
import { deleteThumbnail } from "@/scripts/media-thumbnail";
import { ApiInputError, jsonObject, pathId, safeApiError } from "@/scripts/api-safety";
import { publicMedia } from "@/scripts/api-dto";

type RouteContext = { params: Promise<{ mediaId: string }> };
export async function GET(_request: Request, context: RouteContext) {
    try {
        const id = pathId((await context.params).mediaId);
        const data = await getMediaDetailsById(id);
        if (!data) return Response.json({ error: "Media not found" }, { status: 404 });
        return Response.json(publicMedia(data));
    } catch (error) { return safeApiError(error, "media-details"); }
}
export async function DELETE(_request: Request, context: RouteContext) {
    try {
        const parsedMediaId = pathId((await context.params).mediaId);
        const media = await getMediaFileById(parsedMediaId);

        const deleted = media && await deleteMediaAtDestination({
            mediaId: parsedMediaId,
            root: getMediaStorageRoot(),
            destination: media.path,
            revalidateMetadata: async () => {
                const current = await getMediaFileById(parsedMediaId);
                if (!current) return false;
                if (current.path !== media.path) throw new Error("Media path changed; retry deletion");
                return true;
            },
            deleteMetadata: async (verifyStorage, receipt) => {
                const row = await deleteMediaById(parsedMediaId, verifyStorage, receipt);
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
    } catch (error) { return safeApiError(error, "media-delete"); }
}
export async function PATCH(request: Request, context: RouteContext) {
    try {
        const id = pathId((await context.params).mediaId);
        const body = await jsonObject(request);
        if (typeof body.favorite !== "boolean") throw new ApiInputError("Favorite must be a boolean");
        if (!await setMediaFavorite(id, body.favorite)) return Response.json({ error: "Media not found" }, { status: 404 });
        return Response.json({ message: "Favorite changed successfully", mediaId: id });
    } catch (error) { return safeApiError(error, "media-favorite"); }
}
