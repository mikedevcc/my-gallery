import { logApiFailure } from "./api-diagnostics";
import { syncParents, syncReplacementPath } from "./replacement-recovery";
import { assertMediaSegment, assertOriginalMediaPath, assertStagedMediaPath, assertMediaInputPath, canonicalOriginalDestination } from "./media-paths";
import { acquireResolutionClaim, finishOwnedConflict, type ResolutionClaim } from "./conflict-resolution-lock";
import path from "node:path";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { Transform } from "node:stream";
import { ProcessingError, processingLimits, processingSignal } from "./processing-limits";
import { reserveStaging } from "./staging-budget";
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

            logApiFailure("storage-directory-cleanup", error);

            return;
        }

        directoryPath = path.dirname(directoryPath);
    }
}


export function buildDestinationPath(
    imported: ImportedMedia,
    city?: string,
): string {
    // New imports use the camera calendar, even when their UTC instant is in
    // another year. Date-only legacy development callers retain the UTC fallback.
    const year = imported.media.captureLocal?.slice(0, 4)
        ?? imported.media.dateTaken?.getUTCFullYear()
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


export async function stageMediaFile(file: File): Promise<string> {
    const fileName = file.name;
    assertMediaSegment(fileName);
    if (file.size > processingLimits().uploadBytes) throw new ProcessingError("Upload too large", 413);
    const source = Readable.fromWeb(file.stream() as unknown as NodeReadableStream<Uint8Array>);
    const staged = await stageMediaStream(fileName, source);
    await staged.complete();
    return staged.path;
}

/** Only the directory and inode created here can be discarded on upload failure. */
export async function stageMediaStream(fileName: string, source: Readable, signal = processingSignal()) {
    assertMediaSegment(fileName);
    const storage = await validateStorage();
    const release = await reserveStaging(storage);
    const jobPath = path.join(storage.root, ".incoming", randomUUID());
    const stagedPath = path.join(jobPath, fileName);
    let directoryIdentity: { dev: number; ino: number } | undefined;
    let fileIdentity: { dev: number; ino: number } | undefined;
    let markerIdentity: { dev: number; ino: number } | undefined;
    const marker = path.join(jobPath, ".uploading");
    const complete = async () => {
        await storage.assertAvailable(marker);
        const current = await fs.lstat(marker);
        if (!markerIdentity || !current.isFile() || current.dev !== markerIdentity.dev || current.ino !== markerIdentity.ino) throw new Error("Upload marker changed; retained for investigation");
        await fs.unlink(marker);
        markerIdentity = undefined;
        await syncParents(storage.root, marker);
    };
    const discard = async () => {
        await storage.assertAvailable(jobPath);
        const directory = await fs.lstat(jobPath).catch(error => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw error;
        });
        if (!directory) return;
        if (!directoryIdentity || directory.dev !== directoryIdentity.dev || directory.ino !== directoryIdentity.ino || !directory.isDirectory()) throw new Error("Staging directory changed; retained for investigation");
        const file = await fs.lstat(stagedPath).catch(error => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw error;
        });
        if (file) {
            if (!fileIdentity || file.isSymbolicLink() || file.dev !== fileIdentity.dev || file.ino !== fileIdentity.ino) throw new Error("Staging file changed; retained for investigation");
            await storage.assertAvailable(stagedPath);
            await fs.unlink(stagedPath);
            await syncReplacementPath(storage.root, jobPath);
        }
        if (markerIdentity) await complete();
        // rmdir refuses unknown artifacts; never recursively delete a failed upload.
        await fs.rmdir(jobPath);
    };
    try {
        await createStorageDirectory(storage, jobPath);
        directoryIdentity = await fs.lstat(jobPath);
        await storage.assertAvailable(marker);
        const markerHandle = await fs.open(marker, "wx", 0o600);
        try { markerIdentity = await markerHandle.stat(); await markerHandle.writeFile("incomplete-upload\n"); await markerHandle.sync(); }
        finally { await markerHandle.close(); }
        // Persist the marker and its ancestors before any partial media bytes.
        await syncParents(storage.root, marker);
        await storage.assertAvailable(stagedPath);
        const handle = await fs.open(stagedPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        let bytes = 0;
        const limit = new Transform({ transform(chunk, _encoding, callback) {
            bytes += chunk.length;
            callback(bytes > processingLimits().uploadBytes ? new ProcessingError("Upload too large", 413) : null, chunk);
        } });
        try {
            fileIdentity = await handle.stat();
            await pipeline(source, limit, handle.createWriteStream({ autoClose: true, flush: true }), { signal });
        } finally { await handle.close(); }
        if (!bytes) throw new ProcessingError("Empty upload", 400);
        await storage.assertAvailable(stagedPath);
        return { path: stagedPath, discard, complete };
    } catch (error) {
        if (directoryIdentity) await discard().catch(cleanup => logApiFailure("upload-cleanup", cleanup));
        if (signal?.aborted) throw new ProcessingError("Upload cancelled", 408);
        throw error;
    } finally { release(); }
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
            // A hard link is atomic but not durable until its directory is synced.
            // Flush the shared inode, then every destination ancestor (including
            // newly created directories and the storage root) BEFORE the callback
            // can insert metadata and COMMIT. Persist staging evidence as well.
            await syncReplacementPath(root, lock.destination);
            await syncParents(root, lock.destination);
            await syncParents(root, stagedPath);
            // Hold ownership through publication, metadata commit and cleanup.
            // Any uncertain outcome retains the original and the destination lock.
            await lock.assertOwned();
            await onFinalized?.(lock.destination);
            await lock.assertOwned();
            await lock.assertStorage(stagedPath);
            await fs.unlink(stagedPath);
            await syncParents(root, stagedPath);
            await lock.assertOwned();
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

        logApiFailure("storage-destination", error);

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

    if (entries.some(entry => entry.name === ".uploading")) throw new ProcessingError("Upload is incomplete or requires manual cleanup", 409);

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
