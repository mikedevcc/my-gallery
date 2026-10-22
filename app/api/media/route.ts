import { getAvailableMedia, getLibraryMedia } from "@/scripts/media-database";
import { safeApiError } from "@/scripts/api-safety";
import { publicMedia } from "@/scripts/api-dto";

export async function GET(request: Request) {
    try {
        const scope = new URL(request.url).searchParams.get("scope");
        const media = scope === "all" ? await getLibraryMedia() : await getAvailableMedia();
        return Response.json(media.map(publicMedia));
    } catch (error) { return safeApiError(error, "media-list"); }
}
