import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
    destinationExists,
    storageRoot
} from "./media-storage";


const execFileAsync = promisify(execFile);


export async function getOrCreateThumbnail(
    mediaId: number,
    mediaPath: string,
    fileType: "IMAGE" | "VIDEO"
): Promise<string> {
    const thumbnailDirectory = path.join(storageRoot, ".thumbnails");
    const thumbnailName = `${mediaId}.webp`;

    await fs.mkdir(thumbnailDirectory, { recursive: true });
    
    const thumbnailPath = path.join(thumbnailDirectory, thumbnailName);

    if (await destinationExists(thumbnailPath)) {
        return thumbnailPath;
    }

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

    return thumbnailPath
}


export async function deleteThumbnail(
    mediaId: number
): Promise<void> {
    const thumbnailPath = path.join(
        storageRoot,
        '.thumbnails',
        `${mediaId}.webp`
    );

    try {
        await fs.unlink(thumbnailPath);
    }
    catch (error) {
        if (
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
        ) {
            return;
        }

        throw error;
    }
}