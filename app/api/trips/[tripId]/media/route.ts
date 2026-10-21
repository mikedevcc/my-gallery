import { addMediaToTrip, moveMediaToTrip, removeMediaFromTrip } from "@/scripts/media-database";
import { CollectionIntegrityError, collectionErrorResponse, collectionId, collectionIds } from "@/scripts/collection-integrity";

type RouteContext = { params: Promise<{ tripId: string }> };

export async function POST(request: Request, context: RouteContext) {
    try {
        const tripId = Number((await context.params).tripId);
        collectionId(tripId);
        const body = await request.json();
        if (!body || typeof body !== "object" || (body.mediaId !== undefined && body.mediaIds !== undefined)) throw new CollectionIntegrityError("Provide mediaId or mediaIds", 400);
        const ids = body.mediaIds === undefined ? [body.mediaId] : body.mediaIds;
        collectionIds(ids);
        const addedCount = await addMediaToTrip(ids, tripId);
        return Response.json({ message: "Media added to trip", addedCount });
    } catch (error) { return collectionErrorResponse(error); }
}

export async function DELETE(request: Request, context: RouteContext) {
    try {
        const tripId = Number((await context.params).tripId);
        const body = await request.json();
        collectionId(tripId); collectionId(body?.mediaId);
        const removed = await removeMediaFromTrip(body.mediaId, tripId);
        if (!removed) return Response.json({ error: "Media is not part of this trip" }, { status: 404 });
        return Response.json({ message: "Media removed from trip" });
    } catch (error) { return collectionErrorResponse(error); }
}

export async function PATCH(request: Request, context: RouteContext) {
    try {
        const sourceTripId = Number((await context.params).tripId);
        const body = await request.json();
        collectionId(sourceTripId); collectionId(body?.targetTripId);
        const ids = collectionIds(body?.mediaIds);
        const failed = await moveMediaToTrip(ids, sourceTripId, body.targetTripId);
        if (failed.length) throw new CollectionIntegrityError("Selection is no longer part of the source Trip", 409, failed);
        return Response.json({ message: "Media moved successfully", movedCount: ids.length - failed.length });
    } catch (error) { return collectionErrorResponse(error); }
}
