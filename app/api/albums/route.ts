import {
    createAlbum,
    getAlbums,
} from "@/scripts/media-database"


export async function GET() {
    try {
        const albums = await getAlbums();

        return Response.json(albums);
    }
    catch (error) {
        console.error("Request API failed:", error);

        const message =
            error instanceof Error
                ? error.message
                : "Unknown albums error";

        return Response.json(
            { error: message },
            { status: 500 },
        );
    }
}


export async function POST(request: Request) {
    const body = await request.json() as {
        albumName?: string;
    };

    const albumName = body.albumName?.trim();

    if (!albumName) {
        return Response.json(
            { error: "No album name provided" },
            { status: 400 }
        );
    }

    if (albumName.length >= 100) {
        return Response.json(
            { error: "Album name too long" },
            { status: 400 }
        );
    }

    try {
        const albumId = await createAlbum(albumName);

        return Response.json(
            {
                albumId,
                albumName,
            },
            { status: 200 }
        );
    }
    catch (error) {
        console.error("Album API failed:", error);

        const message =
            error instanceof Error
                ? error.message
                : "Unknown albums error";

        return Response.json(
            { error: message },
            { status: 500 }
        );
    }
}