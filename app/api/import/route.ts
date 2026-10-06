import { importMediaToLibrary } from "@/scripts/media-import-service";


export async function POST(request: Request) {
    const formData = await request.formData();

    const file = formData.get("file");
    const jobId = formData.get("jobId");

    // validate file
    if (!(file instanceof File)) {
        return Response.json(
            { error: "No valid file provided" },
            { status: 400 },
        );
    }

    if (typeof jobId !== "string") {
        return Response.json(
            { error: "No valid file provided" },
            { status: 400 },
        );
    }

    try {
        const result = await importMediaToLibrary(file, jobId);

        console.log("[api/import] Import result:", result);

        if (result.type === "CONFLICT") {
            return Response.json(
                { conflict: result.conflict },
                { status: 409 }
            );
        }

        return Response.json({
            message: "received",
            mediaId: result.mediaId,
        });
    }
    catch (error) {
        console.error("Import API failed:", error);

        const message =
            error instanceof Error
                ? error.message
                : "Unknown import error";

        return Response.json(
            { error: message },
            { status: 500 },
        );
    }
}