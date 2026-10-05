import path from "node:path";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import type { ImportedMedia } from "./media-import";


export type ReplacementState = {
    stagedPath: string;
    destinationPath: string;
    backupPath: string;
};


export const storageRoot = "/home/mikef/Projects/temp_storage"


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
    file: File
): Promise<string> {
    const incomingPath = path.join(storageRoot, ".incoming");

    const jobPath = path.join(incomingPath, randomUUID());

    // Create .incoming folder if not exist
    await fs.mkdir(jobPath, { recursive: true });

    const stagedPath = path.join(jobPath, file.name);

    // Copy source file into .incoming
    try {
        const webStream = file.stream();
        
        const source = Readable.fromWeb(
            webStream as unknown as NodeReadableStream<Uint8Array>
        );

        const destination = createWriteStream(stagedPath, { flags: "wx" });

        await pipeline(source, destination);

        return stagedPath;
    }
    catch (error) {
        // remove a potentially incomplete staged file
        try {
            await fs.rm(jobPath, { 
                recursive: true,
                force: true
            });
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
                console.warn("[media-import] Finalization collision", {
                    stagedPath,
                    destinationPath,
                    finalPath,
                });
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


export async function destinationExists(
    destinationPath: string
): Promise<boolean> {
    try {
        await fs.access(destinationPath);
        return true;
    }
    catch (error) {
        console.warn("[media-import] Destination access failed", {
            destinationPath,
            error,
        });
        return false;
    }
}


export async function removeStagedConflict(
    conflictId: string
): Promise<void> {
    const conflictPath = path.join(
        storageRoot,
        ".incoming",
        conflictId
    );

    await fs.rm(conflictPath, {
        recursive: true,
        force: true,
    });
}


export async function findStagedConflictFile(
    conflictId: string
): Promise<string> {
    // validate conflictId
    const uuidPattern =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    if (!uuidPattern.test(conflictId)) {
        throw new Error("Invalid conflict ID");
    }

    // build .incoming/<conflictId>
    const conflictDirectory = path.join(
        storageRoot,
        ".incoming",
        conflictId
    );

    // inspect directory
    const entries = await fs.readdir(
        conflictDirectory,
        { withFileTypes: true }
    );

    // make sure exactly one file exists
    const files = entries.filter(
        (entry) => entry.isFile() && entry.name !== ".conflict.json"
    )

    if (files.length !== 1) {
        throw new Error(
            `Expected exactly one staged file, found ${files.length}`
        );
    }

    // return its absolute path
    return path.join(
        conflictDirectory,
        files[0].name
    );
}


export async function beginMediaReplacement(
    stagedPath: string,
    destinationPath: string
): Promise<ReplacementState> {
    const backupPath = `${destinationPath}.backup-${randomUUID()}`;
    
    // move existing destination to backup
    await fs.rename(
        destinationPath,
        backupPath
    );

    try {
        // link staged file into destination
        await fs.link(stagedPath, destinationPath);

        return {
            stagedPath,
            destinationPath,
            backupPath
        }
    }
    catch (error) {
        try {
            await fs.rename(
                backupPath,
                destinationPath
            );
        }
        catch (restoreError) {
            console.error(
                "Failed to restore original media after replacement failure:",
                restoreError
            );
        }

        throw error;
    }
}


export async function commitMediaReplacement(
    replacement: ReplacementState
): Promise<void> {
    await fs.unlink(replacement.stagedPath);
    await fs.rm(replacement.backupPath, { force: true });
}


export async function rollbackMediaReplacement(
    replacement: ReplacementState
): Promise<void> {
    await fs.rm(replacement.destinationPath, { force: true });

    await fs.rename(
        replacement.backupPath,
        replacement.destinationPath
    );
}