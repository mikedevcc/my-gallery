import { 
    getAvailableMedia,
    getLibraryMedia,
} from "@/scripts/media-database"

export async function GET(
    request: Request
) {
    const url = new URL(request.url);
    const scope = url.searchParams.get("scope");
    
    if (scope === "all") {
        const media = await getLibraryMedia();

        return Response.json(media);
    }

    const media = await getAvailableMedia()

    return Response.json(
        media,
        { status: 200 }
    )
}