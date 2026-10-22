import { deleteTrip, getTripById, getMediaByTripId, renameTrip } from "@/scripts/media-database";
import { collectionName, jsonObject, pathId, safeApiError } from "@/scripts/api-safety";
import { publicCollection, publicMedia } from "@/scripts/api-dto";

type RouteContext = { params: Promise<{ tripId: string }> };
export async function GET(_request: Request, context: RouteContext) {
    try {
        const id = pathId((await context.params).tripId);
        const trip = await getTripById(id);
        if (!trip) return Response.json({ error: "Trip not found" }, { status: 404 });
        const media = await getMediaByTripId(id);
        return Response.json({ trip: publicCollection(trip, "trip"), media: media.map(publicMedia) });
    } catch (error) { return safeApiError(error, "trip-details"); }
}
export async function PATCH(request: Request, context: RouteContext) {
    try {
        const id = pathId((await context.params).tripId);
        const body = await jsonObject(request);
        const name = collectionName(body.tripName);
        if (!await renameTrip(id, name)) return Response.json({ error: "Trip not found" }, { status: 404 });
        return Response.json({ message: "Successfully renamed trip", tripId: id });
    } catch (error) { return safeApiError(error, "trip-rename"); }
}
export async function DELETE(_request: Request, context: RouteContext) {
    try {
        const id = pathId((await context.params).tripId);
        if (!await deleteTrip(id)) return Response.json({ error: "Trip not found" }, { status: 404 });
        return Response.json({ message: "Successfully deleted trip", tripId: id });
    } catch (error) { return safeApiError(error, "trip-delete"); }
}
