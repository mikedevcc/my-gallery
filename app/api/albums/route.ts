import { createAlbum, getAlbums } from "@/scripts/media-database";
import { collectionName, jsonObject, safeApiError } from "@/scripts/api-safety";
import { publicCollection } from "@/scripts/api-dto";

export async function GET() {
    try { return Response.json((await getAlbums()).map(row => publicCollection(row, "album"))); }
    catch (error) { return safeApiError(error, "albums-list"); }
}
export async function POST(request: Request) {
    try {
        const body = await jsonObject(request);
        const albumName = collectionName(body.albumName);
        const albumId = await createAlbum(albumName);
        return Response.json({ albumId, albumName }, { status: 200 });
    } catch (error) { return safeApiError(error, "albums-create"); }
}
