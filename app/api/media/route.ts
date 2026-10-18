import { getAvailableMedia } from "@/scripts/media-database"

export async function GET() {
    const media = await getAvailableMedia()

    return Response.json(
        media,
        { status: 200 }
    )
}