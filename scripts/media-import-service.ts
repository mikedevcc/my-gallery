import { assertSupportedUpload, checkProcessingCancellation, withProcessingJob } from "./processing-limits";
import { assertStagedMediaPath } from "./media-paths";
import { acquireResolutionClaim, finishOwnedConflict, releaseUnboundResolutionClaim, type ResolutionClaim } from "./conflict-resolution-lock";
import { validateStorage } from "./storage-safety";
import { savePendingConflict } from "./pending-import-conflicts";
import { DestinationBusyError, DestinationRecoveryError } from "./destination-lock";
import { replaceMediaAtDestination } from "./media-mutations";
import path from "node:path";
import fs from "node:fs/promises";

import {
    ImportedMedia,
    importMedia,
} from "./media-import";
import {
    insertImportedMedia,
    findMediaByPath,
    updateImportedMedia,
    getReplacementReceipt,
    withReplacementRecoveryDatabase,
} from "./media-database";
import { 
    buildDestinationPath, 
    stageMediaFile, 
    finalizeStagedMedia,
    getMediaStorageRoot,
    destinationExists,
    findStagedConflictFile,
    removeStagedConflict,
} from "./media-storage";
import { 
    resolveLocation, 
    type ResolvedLocation
} from "./media-location";

import type {
    ImportConflict,
    ConflictAction
} from "@/lib/import/import-conflict";


type ServerImportResult =
    | {
        type: "COMPLETED";
        mediaId: number;
    }
    | {
        type: "CONFLICT";
        conflict: ImportConflict;
    };

type ConflictResolutionResult =
    | {
        type: "SKIPPED";
    }
    | {
        type: "COMPLETED";
        mediaId: number;
    };


type StagedCleanupEvidence = { file: { dev: number; ino: number }; directory: { dev: number; ino: number } };
async function cleanupStagedJob(stagedPath: string, claim?: ResolutionClaim, evidence?: StagedCleanupEvidence): Promise<void> {
    if (claim) { await finishOwnedConflict(getMediaStorageRoot(), claim); return; }
    const storage = await validateStorage();
    assertStagedMediaPath(storage.root, stagedPath);
    await storage.assertAvailable(stagedPath);
    const directory = path.dirname(stagedPath);
    const currentDirectory = await fs.lstat(directory);
    if (!evidence || !currentDirectory.isDirectory() || currentDirectory.dev !== evidence.directory.dev || currentDirectory.ino !== evidence.directory.ino) throw new DestinationRecoveryError("Staging directory identity changed; retained");
    const names = await fs.readdir(directory);
    if (names.some(name => name !== path.basename(stagedPath))) throw new DestinationRecoveryError("Staging artifacts require ownership-aware cleanup");
    if (names.length) {
        const current = await fs.lstat(stagedPath);
        if (!current.isFile() || current.dev !== evidence.file.dev || current.ino !== evidence.file.ino) throw new DestinationRecoveryError("Staging file identity changed; retained");
        await storage.assertAvailable(stagedPath);
        await fs.unlink(stagedPath);
    }
    await storage.assertAvailable(directory);
    await fs.rmdir(directory);
}


async function finalizeImportedMedia(
    stagedPath: string,
    destination: string,
    imported: ImportedMedia,
    location: ResolvedLocation,
    keepBoth = false,
    claim?: ResolutionClaim,
    evidence?: StagedCleanupEvidence,
): Promise<number> {
    checkProcessingCancellation();
    let mediaId: number | undefined;
    await finalizeStagedMedia(stagedPath, destination, async finalPath => {
        mediaId = await insertImportedMedia({
            ...imported,
            file: {
                ...imported.file,
                absolutePath: finalPath,
                fileName: keepBoth ? path.basename(finalPath) : imported.file.fileName,
            },
        }, location.country, location.city);
    });
    if (mediaId === undefined) throw new Error("Finalization did not return a media ID");
    await cleanupStagedJob(stagedPath, claim, evidence);
    return mediaId;
}

function mustPreserveStaging(error: unknown): boolean {
    return error instanceof DestinationBusyError || error instanceof DestinationRecoveryError;
}


export async function processStagedMedia(
    stagedPath: string,
    jobId: string
): Promise<ServerImportResult> {
    assertStagedMediaPath(getMediaStorageRoot(), stagedPath);
    const storage = await validateStorage();
    await storage.assertAvailable(stagedPath);
    const evidence = { file: await fs.lstat(stagedPath), directory: await fs.lstat(path.dirname(stagedPath)) };
    try {
        checkProcessingCancellation();
        const imported = await importMedia(stagedPath);

        const { latitude, longitude } = imported.media;

        let location: ResolvedLocation = {};

        if (latitude !== undefined && longitude !== undefined) {
            const resolvedLocation = await resolveLocation(latitude, longitude);
            location = resolvedLocation
        }

        checkProcessingCancellation();
        const destination = buildDestinationPath(imported, location.city);

        const exists = await destinationExists(destination);


        if (exists) {
            const conflictId = path.basename(path.dirname(stagedPath));

            const existingMedia = await findMediaByPath(destination);

            console.info("[media-import] Conflict detected", { conflictId, mediaId: existingMedia?.media_id });

            const conflict: ImportConflict = {
                type: "FILENAME", jobId, conflictId,
                existingMediaId: existingMedia?.media_id,
                existingPath: destination,
            };
            await savePendingConflict(stagedPath, conflict);
            return { type: "CONFLICT", conflict };
        }

        const media_id = await finalizeImportedMedia(stagedPath, destination, imported, location, false, undefined, evidence);

        return {
            type: "COMPLETED",
            mediaId: media_id,
        };
    }
    catch (error) {
        if (!mustPreserveStaging(error)) await cleanupStagedJob(stagedPath, undefined, evidence);

        throw error;
    }
}


export async function importMediaToLibrary(
    file: File,
    jobId: string
): Promise<ServerImportResult> {
        assertSupportedUpload(file.name);
        return withProcessingJob(undefined, async () => {
            const stagedPath = await stageMediaFile(file);
            return processStagedMedia(stagedPath, jobId);
        });
}


async function applyStagedConflictResolution(
    conflictId: string,
    action: ConflictAction,
    claim: ResolutionClaim,
): Promise<ConflictResolutionResult> {
    if (action === "SKIP") {
        await removeStagedConflict(conflictId, getMediaStorageRoot(), claim);

        return {
            type: "SKIPPED",
        };
    }
    else if (action === "KEEP_BOTH") {
        const stagedPath = await findStagedConflictFile(conflictId);

        try {
            checkProcessingCancellation();
            const imported = await importMedia(stagedPath);
        
            const { latitude, longitude } = imported.media;

            let location: ResolvedLocation = {};

            if (latitude !== undefined && longitude !== undefined) {
                const resolvedLocation = await resolveLocation(latitude, longitude);
                location = resolvedLocation
            }

            checkProcessingCancellation();
            const destination = buildDestinationPath(imported, location.city);

            claim.retain = true;
            const media_id = await finalizeImportedMedia(stagedPath, destination, imported, location, true, claim);

            return {
                type: "COMPLETED",
                mediaId: media_id,
            };
        }
        catch (error) {
            // Preserve the owned conflict on failure; no recursive cleanup.
            throw error;
        }
    }
    else if (action === "REPLACE") {
        const stagedPath = await findStagedConflictFile(conflictId);

        checkProcessingCancellation();
        const imported = await importMedia(stagedPath);
    
        const { latitude, longitude } = imported.media;

        let location: ResolvedLocation = {};

        if (latitude !== undefined && longitude !== undefined) {
            const resolvedLocation = await resolveLocation(latitude, longitude);
            location = resolvedLocation
        }

        checkProcessingCancellation();
        // A staged conflict owns its recorded original, even if date/geocoder
        // policy now computes a different destination for a new import.
        const destination = claim.target;

        const existingMedia = await findMediaByPath(destination);

        if (!existingMedia) {
            throw new Error(
                "Cannot replace media because the existing database record was not found"
            );
        }

        const mediaId = existingMedia?.media_id;

        const storedImported: ImportedMedia = {
            ...imported,
            file: {
                ...imported.file,
                fileName: path.basename(destination),
                absolutePath: destination,
            },
        };

        checkProcessingCancellation();
        await replaceMediaAtDestination({
            mediaId, readReceipt: getReplacementReceipt, withRecoveryDatabase: withReplacementRecoveryDatabase,
            root: getMediaStorageRoot(),
            destination,
            stagedPath,
            conflict: claim,
            revalidateMetadata: async () => {
                const current = await findMediaByPath(destination);
                if (current?.media_id !== mediaId) throw new Error("Replacement target changed; review the conflict again");
            },
            updateMetadata: (receipt, assertStorage) => updateImportedMedia(mediaId, storedImported, location.country, location.city, { receipt, assertStorage }),
        });
        // Replacement reconciliation already finalized the owned conflict.
        return {
            type: "COMPLETED",
            mediaId,
        };
    }

    throw new Error(
        `Conflict action ${action} is not implemented`
    );
}

export async function resolveStagedConflict(
    conflictId: string,
    action: ConflictAction
): Promise<ConflictResolutionResult> {
    const stagedPath = await findStagedConflictFile(conflictId);
    const root = getMediaStorageRoot();
    const claim = await acquireResolutionClaim(root, conflictId, action, stagedPath);
    try {
        return await applyStagedConflictResolution(conflictId, action, claim);
    } finally {
        await releaseUnboundResolutionClaim(root, claim);
    }
}
