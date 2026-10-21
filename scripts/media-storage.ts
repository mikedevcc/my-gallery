import path from "node:path";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import type { ImportedMedia } from "./media-import";
import { withDestinationLock, type DestinationLock } from "./destination-lock";


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
    onFinalized?: (finalPath: string) => Promise<void>,
    root = storageRoot,
): Promise<string> {
    const { name, ext, dir } = path.parse(destinationPath);
    for (let count = 0; ; count++) {
        const candidate = path.join(dir, count === 0 ? `${name}${ext}` : `${name} (${count})${ext}`);
        const result = await withDestinationLock(root, candidate, async lock => {
            // Even an absent candidate must lock: replacement can temporarily move
            // its original to a backup. Never bypass a busy target via a new name.
            await lock.revalidate();
            if (await destinationExists(lock.destination)) return undefined;
            await fs.mkdir(path.dirname(lock.destination), { recursive: true });
            await lock.revalidate();
            lock.markUnresolved();
            await fs.link(stagedPath, lock.destination);
            // Hold the destination through metadata insertion and staging cleanup.
            // Uncertain DB outcomes retain both file names and the lock for review.
            await onFinalized?.(lock.destination);
            await fs.unlink(stagedPath);
            lock.markSafe();
            return lock.destination;
        });
        if (result !== undefined) return result;
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
        const fsError = error as NodeJS.ErrnoException;

        if (fsError.code === "ENOENT") {
            return false;
        }

        console.error(
            "[media-storage] Failed to access destination:",
            {
                destinationPath,
                error,
            }
        );

        throw error;
    }
}


export async function removeStagedConflict(
    conflictId: string,
    root = storageRoot,
): Promise<void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(conflictId)) {
        throw new Error("Invalid conflict ID");
    }
    const conflictPath = path.join(
        root,
        ".incoming",
        conflictId
    );

    // A retained target lock may still need this staged generation for review.
    // Legacy conflicts without saved metadata must first be recovered/listed.
    const metadataPath = path.join(conflictPath, ".conflict.json");
    const metadata = await fs.readFile(metadataPath, "utf8");
    const conflict = JSON.parse(metadata) as { type?: string; existingPath?: string };
    if (conflict.type !== "FILENAME" || typeof conflict.existingPath !== "string") {
        throw new Error("Cannot safely discard a conflict without a recorded destination");
    }
    await withDestinationLock(root, conflict.existingPath, async lock => {
        if (await fs.readFile(metadataPath, "utf8") !== metadata) throw new Error("Conflict metadata changed; retry after review");
        await lock.revalidate();
        lock.markUnresolved();
        await fs.rm(conflictPath, { recursive: true, force: true });
        lock.markSafe();
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
    destinationPath: string,
    lock: DestinationLock,
): Promise<ReplacementState> {
    await lock.assertOwned(destinationPath);
    await lock.revalidate();
    const backupPath = `${destinationPath}.backup-${randomUUID()}`;
    
    lock.markUnresolved();
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
    replacement: ReplacementState,
    lock: DestinationLock,
): Promise<void> {
    await lock.assertOwned(replacement.destinationPath);
    await fs.unlink(replacement.stagedPath);
    await fs.rm(replacement.backupPath, { force: true });
}


export async function rollbackMediaReplacement(
    replacement: ReplacementState,
    lock: DestinationLock,
): Promise<void> {
    await lock.assertOwned(replacement.destinationPath);
    await fs.rm(replacement.destinationPath, { force: true });

    await fs.rename(
        replacement.backupPath,
        replacement.destinationPath
    );
}


export async function deleteStoredMedia(
    mediaPath: string,
    lock: DestinationLock,
): Promise<void> {
    await lock.assertOwned(mediaPath);
    try {
        await fs.unlink(mediaPath);
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
