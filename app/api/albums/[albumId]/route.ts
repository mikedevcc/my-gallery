import { deleteAlbum, getAlbumById, getMediaByAlbumId, renameAlbum } from "@/scripts/media-database";
import { collectionName, jsonObject, pathId, safeApiError } from "@/scripts/api-safety";
import { publicCollection, publicMedia } from "@/scripts/api-dto";

type RouteContext = { params: Promise<{ albumId: string }> };
export async function GET(_request: Request, context: RouteContext) {
    try {
        const id = pathId((await context.params).albumId);
        const album = await getAlbumById(id);
        if (!album) return Response.json({ error: "Album not found" }, { status: 404 });
        const media = await getMediaByAlbumId(id);
        return Response.json({ album: publicCollection(album, "album"), media: media.map(publicMedia) });
    } catch (error) { return safeApiError(error, "album-details"); }
}
export async function PATCH(request: Request, context: RouteContext) {
    try {
        const id = pathId((await context.params).albumId);
        const body = await jsonObject(request);
        const name = collectionName(body.albumName);
        if (!await renameAlbum(id, name)) return Response.json({ error: "Album not found" }, { status: 404 });
        return Response.json({ message: "Successfully renamed album", albumId: id });
    } catch (error) { return safeApiError(error, "album-rename"); }
}
export async function DELETE(_request: Request, context: RouteContext) {
    try {
        const id = pathId((await context.params).albumId);
        if (!await deleteAlbum(id)) return Response.json({ error: "Album not found" }, { status: 404 });
        return Response.json({ message: "Successfully deleted album", albumId: id });
    } catch (error) { return safeApiError(error, "album-delete"); }
}
