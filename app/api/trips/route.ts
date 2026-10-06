import {
    createTrip,
    getTrips,
} from "@/scripts/media-database";


export async function GET() {
    try {
        const trips = await getTrips();

        return Response.json(trips);
    }
    catch (error) {
        console.error("Request API failed:", error);

        const message =
            error instanceof Error
                ? error.message
                : "Unknown trips error";

        return Response.json(
            { error: message },
            { status: 500 },
        )
    }
}


export async function POST(request: Request) {
    const body = await request.json() as {
        tripName?: string;
    };

    const tripName = body.tripName?.trim();

    if (!tripName) {
        return Response.json(
            { error: "No trip name provided" },
            { status: 400 },
        );
    }

    if (tripName.length >= 100) {
        return Response.json(
            { error: "Trip name too long" },
            { status: 400 },
        );
    }

    try {
        const tripId = await createTrip(tripName);

        return Response.json(
            {
                tripId,
                tripName,
            },
            { status: 201 }
        );
    }
    catch (error) {
        console.error("Trips API failed:", error);

        const message = 
            error instanceof Error
                ? error.message
                : "Unknown trips error";
        
        return Response.json(
            { error: message },
            { status: 500 },
        );
    }    
}