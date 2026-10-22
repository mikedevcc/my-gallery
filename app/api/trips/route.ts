import { createTrip, getTrips } from "@/scripts/media-database";
import { collectionName, jsonObject, safeApiError } from "@/scripts/api-safety";
import { publicCollection } from "@/scripts/api-dto";

export async function GET() {
    try { return Response.json((await getTrips()).map(row => publicCollection(row, "trip"))); }
    catch (error) { return safeApiError(error, "trips-list"); }
}
export async function POST(request: Request) {
    try {
        const body = await jsonObject(request);
        const tripName = collectionName(body.tripName);
        const tripId = await createTrip(tripName);
        return Response.json({ tripId, tripName }, { status: 201 });
    } catch (error) { return safeApiError(error, "trips-create"); }
}
