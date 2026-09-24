import path from "node:path";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";

import type { ImportedMedia } from "./media-import";


const storageRoot = "/home/mikef/Projects/temp_storage"


export async function removeEmptyParentDirectories(
    filePath: string
): Promise<void> {
    const root = path.resolve(storageRoot);
    let directoryPath = path.dirname(path.resolve(filePath));

    while (directoryPath !== root) {
        // Safety: never allow cleanup outside storageRoot
        if (!directoryPath.startsWith(root + path.sep)) {
            throw new Error(
                `Refusing to clean directory outside storage root: ${directoryPath}`
            );
        }

        try {
            await fs.rmdir(directoryPath);
        }
        catch (error) {
            const fsError = error as NodeJS.ErrnoException;

            if (fsError.code === "ENOTEMPTY") {
                return;
            }

            if (fsError.code === "ENOENT") {
                directoryPath = path.dirname(directoryPath);
                continue;
            }

            console.error(
                `Failed to remove directory ${directoryPath}:`,
                error
            );

            return;
        }

        directoryPath = path.dirname(directoryPath);
    }
}


export function buildDestinationPath(
    imported: ImportedMedia,
    city?: string,
): string {
    const year = imported.media.dateTaken?.getUTCFullYear()
        ?? "Unknown";

    const location = city ?? "Unknown";

    return path.join(
        storageRoot, 
        String(year), 
        location, 
        imported.file.fileName
    );
}


export async function stageMediaFile(
    sourcePath:string
): Promise<string> {
    const incomingPath = path.join(storageRoot, ".incoming");
    
    // Create .incoming folder if not exist
    await fs.mkdir(incomingPath, {recursive: true});

    const fileName = randomUUID() +  path.extname(sourcePath);

    const stagedPath = path.join(incomingPath, fileName);

    // Copy source file into .incoming
    try {
        await fs.copyFile(
            sourcePath, 
            stagedPath,
            fsConstants.COPYFILE_EXCL
        );

        return stagedPath;
    }
    catch (error) {
        // remove a potentially incomplete staged file
        try {
            await fs.rm(stagedPath, { force: true });
        }
        catch (cleanupError) {
            console.error("Failed to clean up staged file:", cleanupError);
        }

        throw error;
    }
}


export async function finalizeStagedMedia(
    stagedPath: string,
    destinationPath: string,
): Promise<string> {
    // Ensure destination folder exists
    const destinationDir = path.dirname(destinationPath);

    await fs.mkdir(destinationDir, { recursive: true });

    const { name, ext } = path.parse(destinationPath);

    let altCount = 0;

    while (true) {
        // First attempt: original filename
        // Subsequent attempts: filename (1), filename (2), etc.
        const fileName = altCount === 0
            ? `${name}${ext}`
            : `${name} (${altCount})${ext}`;

        const finalPath = path.join(destinationDir, fileName);

        try {
            // Fails with EEXIST if destination already exists
            await fs.link(stagedPath, finalPath);
        }
        catch (error) {
            const fsError = error as NodeJS.ErrnoException;

            if (fsError.code === "EEXIST") {
                altCount++;
                continue;
            }

            // Permission errors, missing source, etc.
            throw error;
        }

        // Final file now exists. Remove its staging name.
        try {
            await fs.unlink(stagedPath);
        }
        catch (error) {
            // Undo the newly created final link if staging cleanup fails
            try {
                await fs.unlink(finalPath);
            }
            catch (cleanupError) {
                console.error(
                    "Failed to clean up final file:",
                    cleanupError
                );
            }

            throw error;
        }

        return finalPath;
    }
}