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


async function cleanupStagedJob(stagedPath: string): Promise<void> {
    const storage = await validateStorage();
    await storage.assertAvailable(stagedPath);
    try {
        await fs.rm(path.dirname(stagedPath), {
            recursive: true,
            force: true,
        });
    }
    catch (cleanupError) {
        console.error(
            "Failed to clean up staged file:",
            cleanupError
        );
    }
}


async function finalizeImportedMedia(
    stagedPath: string,
    destination: string,
    imported: ImportedMedia,
    location: ResolvedLocation,
    keepBoth = false,
): Promise<number> {
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
    await cleanupStagedJob(stagedPath);
    return mediaId;
}

function mustPreserveStaging(error: unknown): boolean {
    return error instanceof DestinationBusyError || error instanceof DestinationRecoveryError;
}


export async function processStagedMedia(
    stagedPath: string,
    jobId: string
): Promise<ServerImportResult> {
    try {
        const imported = await importMedia(stagedPath);

        const { latitude, longitude } = imported.media;

        let location: ResolvedLocation = {};

        if (latitude !== undefined && longitude !== undefined) {
            const resolvedLocation = await resolveLocation(latitude, longitude);
            location = resolvedLocation
        }

        const destination = buildDestinationPath(imported, location.city);

        const exists = await destinationExists(destination);

        console.log("[media-import] Conflict check", {
            jobId,
            stagedPath,
            fileName: imported.file.fileName,
            dateTaken: imported.media.dateTaken,
            city: location.city,
            destination,
            exists,
        });

        if (exists) {
            const conflictId = path.basename(path.dirname(stagedPath));

            console.log("[media-import] Filename conflict detected", {
                jobId,
                conflictId,
                destination,
            });

            const existingMedia = await findMediaByPath(destination);

            console.log("[media-import] Existing DB media", {
                existingMedia,
            });

            const conflict: ImportConflict = {
                type: "FILENAME", jobId, conflictId,
                existingMediaId: existingMedia?.media_id,
                existingPath: destination,
            };
            await savePendingConflict(stagedPath, conflict);
            return { type: "CONFLICT", conflict };
        }

        const media_id = await finalizeImportedMedia(stagedPath, destination, imported, location);

        return {
            type: "COMPLETED",
            mediaId: media_id,
        };
    }
    catch (error) {
        if (!mustPreserveStaging(error)) await cleanupStagedJob(stagedPath);

        throw error;
    }
}


export async function importMediaToLibrary(
    file: File,
    jobId: string
): Promise<ServerImportResult> {
        const stagedPath = await stageMediaFile(file);
        
        return processStagedMedia(stagedPath, jobId);
}


async function applyStagedConflictResolution(
    conflictId: string,
    action: ConflictAction
): Promise<ConflictResolutionResult> {
    if (action === "SKIP") {
        await removeStagedConflict(conflictId);

        return {
            type: "SKIPPED",
        };
    }
    else if (action === "KEEP_BOTH") {
        const stagedPath = await findStagedConflictFile(conflictId);

        try {
            const imported = await importMedia(stagedPath);
        
            const { latitude, longitude } = imported.media;

            let location: ResolvedLocation = {};

            if (latitude !== undefined && longitude !== undefined) {
                const resolvedLocation = await resolveLocation(latitude, longitude);
                location = resolvedLocation
            }

            const destination = buildDestinationPath(imported, location.city);

            const media_id = await finalizeImportedMedia(stagedPath, destination, imported, location, true);

            return {
                type: "COMPLETED",
                mediaId: media_id,
            };
        }
        catch (error) {
            if (!mustPreserveStaging(error)) await cleanupStagedJob(stagedPath);

            throw error;
        }
    }
    else if (action === "REPLACE") {
        const stagedPath = await findStagedConflictFile(conflictId);

        const imported = await importMedia(stagedPath);
    
        const { latitude, longitude } = imported.media;

        let location: ResolvedLocation = {};

        if (latitude !== undefined && longitude !== undefined) {
            const resolvedLocation = await resolveLocation(latitude, longitude);
            location = resolvedLocation
        }

        const destination = buildDestinationPath(imported, location.city);

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

        await replaceMediaAtDestination({
            mediaId, readReceipt: getReplacementReceipt, withRecoveryDatabase: withReplacementRecoveryDatabase,
            root: getMediaStorageRoot(),
            destination,
            stagedPath,
            revalidateMetadata: async () => {
                const current = await findMediaByPath(destination);
                if (current?.media_id !== mediaId) throw new Error("Replacement target changed; review the conflict again");
            },
            updateMetadata: (receipt, assertStorage) => updateImportedMedia(mediaId, storedImported, location.country, location.city, { receipt, assertStorage }),
        });
        await cleanupStagedJob(stagedPath);

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
    const lockPath = path.join(path.dirname(stagedPath), ".resolution-lock");
    const storage = await validateStorage();
    await storage.assertAvailable(lockPath);
    try {
        await fs.mkdir(lockPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new Error("This file is already being resolved.");
        }
        throw error;
    }
    try {
        return await applyStagedConflictResolution(conflictId, action);
    } finally {
        await storage.assertAvailable(lockPath);
        await fs.rm(lockPath, { recursive: true, force: true });
    }
}
