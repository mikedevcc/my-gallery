import {
    addMediaToTrip,
    removeMediaFromTrip,
} from "@/scripts/media-database";


type RouteContext = {
    params: Promise<{
        tripId: string;
    }>;
};

type MediaRequest = {
    mediaId?: number;
};


export async function POST(
    request: Request,
    context: RouteContext
) {
    const { tripId } = await context.params;
    const parsedTripId = Number(tripId);

    const body = await request.json() as MediaRequest;
    const mediaId = body.mediaId;
    
    if (!Number.isInteger(parsedTripId) || parsedTripId <= 0) {
        return Response.json(
            { error: "Invalid trip ID" },
            { status: 400 }
        );
    }

    if (
        mediaId === undefined ||
        !Number.isInteger(mediaId) || 
        mediaId <= 0
    ) {
        return Response.json(
            { error: "Invalid media ID" },
            { status: 400 }
        );
    }

    await addMediaToTrip(mediaId, parsedTripId);

    return Response.json(
        { message: "Media added to trip" }
    )
}


export async function DELETE(
    request: Request,
    context: RouteContext
) {
    const { tripId } = await context.params;
    const parsedTripId = Number(tripId);

    const body = await request.json() as MediaRequest;
    const mediaId = body.mediaId;

    if (
        !Number.isInteger(parsedTripId) ||
        parsedTripId <= 0
    ) {
        return Response.json(
            { error: "Invalid trip ID" },
            { status: 400 }
        );
    }

    if (
        mediaId === undefined ||
        !Number.isInteger(mediaId) || 
        mediaId <= 0
    ) {
        return Response.json(
            { error: "Invalid media ID" },
            { status: 400 }
        );
    }

    const removed = await removeMediaFromTrip(mediaId, parsedTripId);

    if (!removed) {
        return Response.json(
            { error: "Media is not part of this trip" },
            { status: 404 }
        );
    }

    return Response.json(
        { message: "Media removed from trip" }
    )
}