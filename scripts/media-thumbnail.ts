import { withDestinationLock } from "./destination-lock";
import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";
import { createStorageDirectory, validateStorage } from "./storage-safety";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
    destinationExists,
    getMediaStorageRoot
} from "./media-storage";


const execFileAsync = promisify(execFile);


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
    if (await destinationExists(thumbnailPath)) {
        await storage.assertAvailable(thumbnailPath);
        return thumbnailPath;
    }

    await storage.assertAvailable(mediaPath);
    await storage.assertAvailable(thumbnailPath);
    if (fileType === "IMAGE") {
        await sharp(mediaPath)
            .resize({
                width: 600,
                withoutEnlargement: true,
            })
            .webp()
            .toFile(thumbnailPath);
    }

    if (fileType === "VIDEO") {
        await execFileAsync(
            "ffmpeg",
            [
                "-y",
                "-loglevel", "error",
                "-ss", "1",
                "-i", mediaPath,
                "-frames:v", "1",
                "-vf", "scale=600:-1",
                thumbnailPath,
            ]
        );

    }

    await storage.assertAvailable(thumbnailPath);
    return thumbnailPath
}


export async function deleteThumbnail(
    mediaId: number
): Promise<void> {
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
export async function getOrCreateThumbnail(mediaId: number, mediaPath: string, fileType: "IMAGE" | "VIDEO"): Promise<string> {
    return withDestinationLock(getMediaStorageRoot(), mediaPath, async () => createThumbnailLocked(mediaId, mediaPath, fileType));
}
