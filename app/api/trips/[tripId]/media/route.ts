import { jsonObject, pathId, positiveId } from "@/scripts/api-safety";
import { addMediaToTrip, moveMediaToTrip, removeMediaFromTrip, moveLibraryMediaToTrip } from "@/scripts/media-database";
import { CollectionIntegrityError, collectionErrorResponse, collectionIds } from "@/scripts/collection-integrity";

type RouteContext = { params: Promise<{ tripId: string }> };

export async function POST(request: Request, context: RouteContext) {
    try {
        const tripId = pathId((await context.params).tripId);
        const body = await jsonObject(request, "bulk");
        if (body.mediaId !== undefined && body.mediaIds !== undefined) throw new CollectionIntegrityError("Provide mediaId or mediaIds", 400);
        const ids = body.mediaIds === undefined ? [body.mediaId] : body.mediaIds;
        const addedCount = await addMediaToTrip(collectionIds(ids), tripId);
        return Response.json({ message: "Media added to trip", addedCount });
    } catch (error) { return collectionErrorResponse(error); }
}

export async function DELETE(request: Request, context: RouteContext) {
    try {
        const tripId = pathId((await context.params).tripId);
        const body = await jsonObject(request);
        const removed = await removeMediaFromTrip(positiveId(body.mediaId), tripId);
        if (!removed) return Response.json({ error: "Media is not part of this trip" }, { status: 404 });
        return Response.json({ message: "Media removed from trip" });
    } catch (error) { return collectionErrorResponse(error); }
}


export async function PATCH(request: Request, context: RouteContext) {
    try {
        const tripId = pathId((await context.params).tripId);
        const body = await jsonObject(request, "bulk");

        // Photos / Favorites: destination-based move.
        if (body.mediaId !== undefined) {
            if (
                body.mediaIds !== undefined ||
                body.targetTripId !== undefined
            ) {
                throw new CollectionIntegrityError(
                    "Provide either mediaId or mediaIds with targetTripId",
                    400
                );
            }

            const mediaId = positiveId(body.mediaId);

            const outcome = await moveLibraryMediaToTrip(
                mediaId,
                tripId
            );

            if (outcome === "already-in-trip") {
                return Response.json({
                    message: "Media already in trip",
                    movedCount: 0,
                    unchanged: true,
                });
            }

            return Response.json({
                message: "Media moved successfully",
                movedCount: 1,
            });
        }

        // Existing Trip detail: preserve current behavior.
        const ids = collectionIds(body.mediaIds);

        const failed = await moveMediaToTrip(
            ids,
            tripId,
            positiveId(body.targetTripId)
        );

        if (failed.length) {
            throw new CollectionIntegrityError(
                "Selection is no longer part of the source Trip",
                409,
                failed
            );
        }

        return Response.json({
            message: "Media moved successfully",
            movedCount: ids.length,
        });
    } catch (error) {
        return collectionErrorResponse(error);
    }
}