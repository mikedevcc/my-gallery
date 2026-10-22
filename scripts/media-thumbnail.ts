import { reserveStaging } from "./staging-budget";
import { assertMediaId } from "./media-paths";
import { withDestinationLock } from "./destination-lock";
import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";
import { mediaFormat } from "../lib/media-formats";
import { createStorageDirectory, validateStorage } from "./storage-safety";

import { runMediaSubprocess } from "./media-subprocess";
import { randomUUID } from "node:crypto";
import { ProcessingError, processingLimits, processingSignal, checkProcessingCancellation, withProcessingJob } from "./processing-limits";


import {
    getMediaStorageRoot
} from "./media-storage";


// Bound libvips worker parallelism in this Node process as well as job admission.
sharp.concurrency(1);

async function createThumbnailLocked(
    mediaId: number,
    mediaPath: string,
    fileType: "IMAGE" | "VIDEO"
): Promise<string> {
    const storage = await validateStorage();
    await storage.assertAvailable(mediaPath);
    const thumbnailDirectory = path.join(storage.root, ".thumbnails");
    await storage.assertAvailable(thumbnailDirectory);
    const thumbnailName = `${mediaId}.webp`;

    await createStorageDirectory(storage, thumbnailDirectory);
    
    const thumbnailPath = path.join(thumbnailDirectory, thumbnailName);

    await storage.assertAvailable(thumbnailPath);
    let exists = false;
    try { await fs.access(thumbnailPath); exists = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (exists) {
        await storage.assertAvailable(thumbnailPath);
        if ((await fs.stat(thumbnailPath)).size >= processingLimits().thumbnailBytes) throw new ProcessingError("Cached thumbnail exceeds output limit", 422);
        return thumbnailPath;
    }

    checkProcessingCancellation();
    const releaseBudget = await reserveStaging(storage);
    try {
        const temporary = path.join(thumbnailDirectory, `.${mediaId}-${randomUUID()}.tmp.webp`);
        await storage.assertAvailable(mediaPath);
        await storage.assertAvailable(temporary);
        const handle = await fs.open(temporary, "wx", 0o600);
        const identity = await handle.stat().finally(() => handle.close());
        const verify = async () => {
            await storage.assertAvailable(temporary);
            const current = await fs.lstat(temporary);
            if (!current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino) throw new Error("Thumbnail temporary identity changed; retained for investigation");
        };
        try {
            if (fileType === "IMAGE") {
                const image = sharp(mediaPath, { limitInputPixels: processingLimits().pixels, sequentialRead: true })
                    .timeout({ seconds: Math.min(3600, Math.max(1, Math.ceil(processingLimits().subprocessMs / 1000))) })
                    .resize({ width: 600, withoutEnlargement: true }).webp();
                image.on("error", () => { /* toFile and the cancellation check own error reporting */ });
                const signal = processingSignal();
                const abort = () => image.destroy(new Error("Thumbnail cancelled"));
                signal?.addEventListener("abort", abort, { once: true });
                try {
                    checkProcessingCancellation();
                    await image.toFile(temporary);
                } finally { signal?.removeEventListener("abort", abort); }
            } else {
                const format = mediaFormat(mediaPath);
                await runMediaSubprocess("ffmpeg", [
                    "-nostdin", "-y", "-loglevel", "error", "-threads", "1", "-filter_threads", "1",
                    "-protocol_whitelist", "file,pipe",
                    ...(format?.demuxers ? ["-format_whitelist", format.demuxers] : []),
                    // First frame also works for clips shorter than one second.
                    "-i", mediaPath, "-frames:v", "1",
                    "-vf", "scale=600:-1", "-threads", "1", "-fs", String(processingLimits().thumbnailBytes), temporary,
                ]);
            }
            checkProcessingCancellation();
            await verify();
            const size = (await fs.stat(temporary)).size;
            if (!size || size >= processingLimits().thumbnailBytes) throw new ProcessingError("Thumbnail output exceeds limit or is empty", 422);
            await storage.assertAvailable(mediaPath);
            await storage.assertAvailable(thumbnailPath);
            // Publish a complete cache entry only. The original destination lock is held.
            await fs.link(temporary, thumbnailPath);
        } finally {
            await verify();
            await fs.unlink(temporary);
        }
        await storage.assertAvailable(thumbnailPath);
        return thumbnailPath;
    } finally { releaseBudget(); }
}


export async function deleteThumbnail(
    mediaId: number
): Promise<void> {
    assertMediaId(mediaId);
    const thumbnailPath = path.join(
        getMediaStorageRoot(),
        '.thumbnails',
        `${mediaId}.webp`
    );

    const storage = await validateStorage();
    await storage.assertAvailable(thumbnailPath);
    try {
        await fs.unlink(thumbnailPath);
    }
    catch (error) {
        if (
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
        ) {
            await storage.assertAvailable(thumbnailPath);
            return;
        }

        throw error;
    }
}

// Serialize cache generation with replacement/deletion so an old generator
// cannot republish stale bytes after replacement invalidates the cache.
export async function getOrCreateThumbnail(mediaId: number, mediaPath: string, fileType: "IMAGE" | "VIDEO", signal?: AbortSignal): Promise<string> {
    assertMediaId(mediaId);
    return withProcessingJob(signal, () => withDestinationLock(getMediaStorageRoot(), mediaPath, async () => createThumbnailLocked(mediaId, mediaPath, fileType)));
}
