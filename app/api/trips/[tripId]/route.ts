import {
    getTripById,
    getMediaByTripId,
} from "@/scripts/media-database";


type RouteContext = {
    params: Promise<{
        tripId: string;
    }>;
};


export async function GET(
    _request: Request,
    context: RouteContext
) {
    const { tripId } = await context.params;

    const parsedTripId = Number(tripId);

    if (!Number.isInteger(parsedTripId) || parsedTripId <= 0) {
        return Response.json(
            { error: "Invalid trip ID" },
            { status: 400 }
        );
    }

    const trip = await getTripById(parsedTripId);

    if (!trip) {
        return Response.json(
            { error: "Trip not found" },
            { status: 404 }
        );
    }

    const media = await getMediaByTripId(parsedTripId);

    return Response.json({
        trip,
        media,
    });
}