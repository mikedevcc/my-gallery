import fs from "node:fs/promises";
import path from "node:path";
import { getConflictPreviewPath } from "@/scripts/pending-import-conflicts";

export async function GET(request: Request) {
    const url = new URL(request.url);
    try {
        const filePath = await getConflictPreviewPath(url.searchParams.get("id") ?? "", url.searchParams.get("side") ?? "");
        const types: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif", ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm" };
        const contentType = types[path.extname(filePath).toLowerCase()];
        if (!contentType) return new Response("Preview unavailable", { status: 415 });
        return new Response(await fs.readFile(filePath), { headers: { "Content-Type": contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    } catch {
        return new Response("Preview unavailable", { status: 404 });
    }
}
