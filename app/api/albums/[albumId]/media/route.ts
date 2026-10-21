import { addMediaToAlbum, moveMediaToAlbum, removeMediaFromAlbum, copyMediaToAlbum } from "@/scripts/media-database";
import { CollectionIntegrityError, collectionErrorResponse, collectionId, collectionIds } from "@/scripts/collection-integrity";

type RouteContext = { params: Promise<{ albumId: string }> };

export async function POST(request: Request, context: RouteContext) {
    try {
        const albumId = Number((await context.params).albumId);
        const body = await request.json();
        collectionId(albumId); collectionId(body?.mediaId);
        const addedCount = await addMediaToAlbum(body.mediaId, albumId);
        return Response.json({ message: "Media added to album", addedCount });
    } catch (error) { return collectionErrorResponse(error); }
}

export async function DELETE(request: Request, context: RouteContext) {
    try {
        const albumId = Number((await context.params).albumId);
        const body = await request.json();
        collectionId(albumId); collectionId(body?.mediaId);
        const removed = await removeMediaFromAlbum(body.mediaId, albumId);
        if (!removed) return Response.json({ error: "Media is not part of this album" }, { status: 404 });
        return Response.json({ message: "Media removed from album" });
    } catch (error) { return collectionErrorResponse(error); }
}

export async function PATCH(request: Request, context: RouteContext) {
    try {
        const sourceAlbumId = Number((await context.params).albumId);
        const body = await request.json();
        collectionId(sourceAlbumId); collectionId(body?.targetAlbumId);
        const ids = collectionIds(body?.mediaIds);
        if (!["copy", "move"].includes(body.operation)) throw new CollectionIntegrityError("Invalid album operation", 400);
        const affectedCount = await (body.operation === "copy" ? copyMediaToAlbum : moveMediaToAlbum)(ids, sourceAlbumId, body.targetAlbumId);
        return Response.json({
            message: body.operation === "move" ? "Media moved successfully" : "Media copied successfully",
            affectedCount,
        });
    } catch (error) { return collectionErrorResponse(error); }
}
