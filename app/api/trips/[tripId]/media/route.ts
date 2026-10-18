import {
    addMediaToTrip,
    getTripById,
    moveMediaToTrip,
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

type TripRequest = {
    mediaIds: number[];
    targetTripId: number;
}


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


export async function PATCH(
    request: Request,
    context: RouteContext
) {
    const { tripId } = await context.params;
    const sourceTripId = Number(tripId);

    const body = await request.json() as TripRequest;
    const mediaIds = body.mediaIds;
    const targetTripId = body.targetTripId;

    if (
        !Array.isArray(mediaIds) ||
        mediaIds.length === 0
    ) {
        return Response.json(
            { error: "No media selected" },
            { status: 400 }
        );
    }

    if (mediaIds.some(
        mediaId => 
            !Number.isInteger(mediaId) ||
            mediaId <= 0
        )
    ) {
        return Response.json(
            { error: "Invalid media ID" },
            { status: 400 }
        );
    }

    if (
        !Number.isInteger(sourceTripId) ||
        sourceTripId <= 0
    ) {
        return Response.json(
            { error: "Invalid source trip ID" },
            { status: 400 }
        );
    }

    if (
        !Number.isInteger(targetTripId) ||
        targetTripId <= 0
    ) {
        return Response.json(
            { error: "Invalid target trip ID" },
            { status: 400 }
        );
    }

    if (targetTripId === sourceTripId) {
        return Response.json(
            { error: "Source and target trip IDs are the same" },
            { status: 400 }
        );
    }

    const targetTrip = await getTripById(targetTripId);

    if (!targetTrip) {
        return Response.json(
            { error: "Target trip not found" },
            { status: 404 }
        );
    }

    const moveFailedmediaIds = await moveMediaToTrip(
        mediaIds,
        sourceTripId,
        targetTripId
    );

    if (moveFailedmediaIds.length !== 0) {
        return Response.json(
            { error: `Media failed to move: ${moveFailedmediaIds.join(", ")}` },
            { status: 400 }
        );
    }

    return Response.json(
        {
            message: "Media moved successfully",
            movedCount: mediaIds.length,
        },
        { status: 200 }
    );
}