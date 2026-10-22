import { jsonObject, pathId, positiveId } from "@/scripts/api-safety";
import { addMediaToAlbum, moveMediaToAlbum, removeMediaFromAlbum, copyMediaToAlbum } from "@/scripts/media-database";
import { CollectionIntegrityError, collectionErrorResponse, collectionIds } from "@/scripts/collection-integrity";

type RouteContext = { params: Promise<{ albumId: string }> };

export async function POST(request: Request, context: RouteContext) {
    try {
        const albumId = pathId((await context.params).albumId);
        const body = await jsonObject(request);
        const addedCount = await addMediaToAlbum(positiveId(body.mediaId), albumId);
        return Response.json({ message: "Media added to album", addedCount });
    } catch (error) { return collectionErrorResponse(error); }
}

export async function DELETE(request: Request, context: RouteContext) {
    try {
        const albumId = pathId((await context.params).albumId);
        const body = await jsonObject(request);
        const removed = await removeMediaFromAlbum(positiveId(body.mediaId), albumId);
        if (!removed) return Response.json({ error: "Media is not part of this album" }, { status: 404 });
        return Response.json({ message: "Media removed from album" });
    } catch (error) { return collectionErrorResponse(error); }
}

export async function PATCH(request: Request, context: RouteContext) {
    try {
        const sourceAlbumId = pathId((await context.params).albumId);
        const body = await jsonObject(request);
        const ids = collectionIds(body.mediaIds);
        if (typeof body.operation !== "string" || !["copy", "move"].includes(body.operation)) throw new CollectionIntegrityError("Invalid album operation", 400);
        const affectedCount = await (body.operation === "copy" ? copyMediaToAlbum : moveMediaToAlbum)(ids, sourceAlbumId, positiveId(body.targetAlbumId));
        return Response.json({
            message: body.operation === "move" ? "Media moved successfully" : "Media copied successfully",
            affectedCount,
        });
    } catch (error) { return collectionErrorResponse(error); }
}
