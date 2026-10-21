import { assertMediaSegment, assertOriginalMediaPath, assertStagedMediaPath, assertMediaInputPath, canonicalOriginalDestination } from "./media-paths";
import { acquireResolutionClaim, finishOwnedConflict, type ResolutionClaim } from "./conflict-resolution-lock";
import path from "node:path";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import type { ImportedMedia } from "./media-import";
import { withDestinationLock, type DestinationLock } from "./destination-lock";
import { createStorageDirectory, getMediaStorageRoot, validateStorage } from "./storage-safety";


export { getMediaStorageRoot } from "./storage-safety";


export async function removeEmptyParentDirectories(
    filePath: string
): Promise<void> {
    const storage = await validateStorage();
    const root = storage.root;
    assertOriginalMediaPath(root, filePath);
    await storage.assertAvailable(filePath);
    let directoryPath = path.dirname(await canonicalOriginalDestination(root, filePath));

    while (directoryPath !== root) {
        // Safety: never allow cleanup outside storageRoot
        if (!directoryPath.startsWith(root + path.sep)) {
            throw new Error(
                `Refusing to clean directory outside storage root: ${directoryPath}`
            );
        }

        try {
            await storage.assertAvailable(directoryPath);
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
    const fileName = imported.file.fileName;

    assertMediaSegment(String(year), true);
    assertMediaSegment(location, true);
    assertMediaSegment(fileName);
    return path.join(
        getMediaStorageRoot(),
        String(year), 
        location, 
        fileName
    );
}


export async function stageMediaFile(
    file: File
): Promise<string> {
    const fileName = file.name;
    assertMediaSegment(fileName);
    const storage = await validateStorage();
    const incomingPath = path.join(storage.root, ".incoming");

    const jobPath = path.join(incomingPath, randomUUID());

    // Create .incoming folder if not exist
    await storage.assertAvailable(jobPath);
    await createStorageDirectory(storage, jobPath);

    const stagedPath = path.join(jobPath, fileName);

    // Copy source file into .incoming
    try {
        await storage.assertAvailable(stagedPath);
        const webStream = file.stream();
        
        const source = Readable.fromWeb(
            webStream as unknown as NodeReadableStream<Uint8Array>
        );

        const destination = createWriteStream(stagedPath, { flags: "wx" });

        await pipeline(source, destination);
        await storage.assertAvailable(stagedPath);

        return stagedPath;
    }
    catch (error) {
        // remove a potentially incomplete staged file
        try {
            await storage.assertAvailable(jobPath);
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
    root = getMediaStorageRoot(),
): Promise<string> {
    assertOriginalMediaPath(root, destinationPath);
    assertMediaInputPath(root, stagedPath);
    const { name, ext, dir } = path.parse(destinationPath);
    for (let count = 0; ; count++) {
        const candidate = path.join(dir, count === 0 ? `${name}${ext}` : `${name} (${count})${ext}`);
        const result = await withDestinationLock(root, candidate, async lock => {
            // Even an absent candidate must lock: replacement can temporarily move
            // its original to a backup. Never bypass a busy target via a new name.
            await lock.revalidate();
            if (await destinationExists(lock.destination)) return undefined;
            await lock.assertStorage(stagedPath);
            await createStorageDirectory({ root, assertAvailable: target => lock.assertStorage(target) }, path.dirname(lock.destination));
            await lock.revalidate();
            lock.markUnresolved();
            await lock.assertStorage(stagedPath);
            await fs.link(stagedPath, lock.destination);
            // Hold the destination through metadata insertion and staging cleanup.
            // Uncertain DB outcomes retain both file names and the lock for review.
            await lock.assertOwned();
            await onFinalized?.(lock.destination);
            await lock.assertOwned();
            await lock.assertStorage(stagedPath);
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
    const storage = await validateStorage();
    const canonical = await canonicalOriginalDestination(storage.root, destinationPath);
    await storage.assertAvailable(canonical);
    try {
        await fs.access(canonical);
        await storage.assertAvailable(canonical);
        return true;
    }
    catch (error) {
        const fsError = error as NodeJS.ErrnoException;

        if (fsError.code === "ENOENT") {
            await storage.assertAvailable(destinationPath);
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
    root = getMediaStorageRoot(),
    claim?: ResolutionClaim,
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
    const storage = await validateStorage(root);
    const metadataPath = path.join(conflictPath, ".conflict.json");
    await storage.assertAvailable(metadataPath);
    const metadata = await fs.readFile(metadataPath, "utf8");
    const conflict = JSON.parse(metadata) as { type?: string; existingPath?: string };
    if (conflict.type !== "FILENAME" || typeof conflict.existingPath !== "string") {
        throw new Error("Cannot safely discard a conflict without a recorded destination");
    }
    await withDestinationLock(root, conflict.existingPath, async lock => {
        await lock.assertStorage(metadataPath);
        if (await fs.readFile(metadataPath, "utf8") !== metadata) throw new Error("Conflict metadata changed; retry after review");
        await lock.revalidate();
        await lock.assertStorage(conflictPath);
        if (claim && (claim.evidence.conflictId !== conflictId || claim.action !== "SKIP" || claim.target !== conflict.existingPath)) throw new Error("Conflict cleanup claim mismatch");
        let owned = claim;
        if (!owned) {
            const entries = await fs.readdir(conflictPath, { withFileTypes: true });
            const files = entries.filter(entry => entry.isFile() && entry.name !== ".conflict.json");
            if (files.length !== 1) throw new Error("Cannot claim an ambiguous staged conflict");
            owned = await acquireResolutionClaim(root, conflictId, "SKIP", path.join(conflictPath, files[0].name));
        }
        lock.markUnresolved(); owned.retain = true;
        await finishOwnedConflict(root, owned);
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
        getMediaStorageRoot(),
        ".incoming",
        conflictId
    );

    const storage = await validateStorage();
    await storage.assertAvailable(conflictDirectory);
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

    // Validate the selected filename before returning any staged input.
    const stagedPath = path.join(conflictDirectory, files[0].name);
    assertStagedMediaPath(storage.root, stagedPath, conflictId);
    await storage.assertAvailable(stagedPath);
    return stagedPath;
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
            await lock.assertOwned();
            return;
        }

        throw error;
    }
}
