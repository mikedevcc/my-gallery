import {
    getTripById,
    getMediaByTripId,
    deleteTrip,
    renameTrip,
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


export async function PATCH(
    request: Request,
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

    const body = await request.json() as {
        tripName?: string;
    };

    const tripName = body.tripName?.trim();

    if (!tripName) {
        return Response.json(
            { error: "No trip name provided" },
            { status: 400 }
        );
    }

    if (tripName.length > 100
    ) {
        return Response.json(
            { error: "Invalid trip name" },
            { status: 400 }
        );
    }

    const success = await renameTrip(parsedTripId, tripName);

    if (!success) {
        return Response.json(
            { error: `Failed to rename trip ${parsedTripId}`},
            { status: 404 }
        );
    }

    return Response.json(
        { 
            message: "Successfully renamed trip",
            tripId: parsedTripId,
        },
        { status: 200 }
    )
}


export async function DELETE(
    _request: Request,
    context: RouteContext
) {
    const { tripId } = await context.params;
    const parsedTripId = Number(tripId);

    if (
        !Number.isInteger(parsedTripId) || parsedTripId <= 0) {
        return Response.json(
            { error: "Invalid trip ID" },
            { status: 400 }
        )
    }

    const success = await deleteTrip(parsedTripId);

    if (!success) {
        return Response.json(
            { error: `Failed to delete trip ${parsedTripId}`},
            { status: 404 }
        );
    }

    return Response.json(
        {
            message: "Successfully deleted trip",
            tripId: parsedTripId
        },
        { status: 200 }
    )
}