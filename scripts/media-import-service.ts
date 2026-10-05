import { savePendingConflict } from "./pending-import-conflicts";
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
} from "./media-database";
import { 
    removeEmptyParentDirectories,
    buildDestinationPath, 
    stageMediaFile, 
    finalizeStagedMedia,
    destinationExists,
    findStagedConflictFile,
    removeStagedConflict,
    beginMediaReplacement,
    commitMediaReplacement,
    rollbackMediaReplacement,
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


export async function processStagedMedia(
    stagedPath: string,
    jobId: string
): Promise<ServerImportResult> {
    let finalPath: string | undefined;
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

        finalPath = await finalizeStagedMedia(stagedPath, destination);

        await cleanupStagedJob(stagedPath);
        
        const storedImported: ImportedMedia = {
            ...imported,
            file: {
                ...imported.file,
                absolutePath: finalPath,
            },
        };
        
        const media_id =  await insertImportedMedia(
            storedImported,
            location.country,
            location.city
        );

        return {
            type: "COMPLETED",
            mediaId: media_id,
        };
    }
    catch (error) {
        await cleanupStagedJob(stagedPath);

        if (finalPath !== undefined) {
            try {
                await fs.rm(finalPath, { force: true });
                await removeEmptyParentDirectories(finalPath);
            }
            catch (cleanupError){
                console.error("Failed to clean up finalized file:", cleanupError);
            }
        }

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

        let finalPath: string | undefined;

        try {
            const imported = await importMedia(stagedPath);
        
            const { latitude, longitude } = imported.media;

            let location: ResolvedLocation = {};

            if (latitude !== undefined && longitude !== undefined) {
                const resolvedLocation = await resolveLocation(latitude, longitude);
                location = resolvedLocation
            }

            const destination = buildDestinationPath(imported, location.city);

            finalPath = await finalizeStagedMedia(stagedPath, destination);

            await cleanupStagedJob(stagedPath);

            const storedImported: ImportedMedia = {
                ...imported,
                file: {
                    ...imported.file,
                    fileName: path.basename(finalPath),
                    absolutePath: finalPath,
                },
            };
            
            const media_id =  await insertImportedMedia(
                storedImported,
                location.country,
                location.city
            );

            return {
                type: "COMPLETED",
                mediaId: media_id,
            };
        }
        catch (error) {
            await cleanupStagedJob(stagedPath);

            if (finalPath !== undefined) {
                try {
                    await fs.rm(finalPath, { force: true });
                    await removeEmptyParentDirectories(finalPath);
                }
                catch (cleanupError){
                    console.error("Failed to clean up finalized file:", cleanupError);
                }
            }

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

        const replacementState = await beginMediaReplacement(stagedPath, destination);
        
        try {
            await updateImportedMedia(
                mediaId,
                storedImported,
                location.country,
                location.city
            );
        }
        catch (error) {
            await rollbackMediaReplacement(replacementState);
            throw error;
        }

        // DB succeeded: replacement is now authoritative
        try {
            await commitMediaReplacement(replacementState);
            await cleanupStagedJob(stagedPath);
        }
        catch (cleanupError) {
            console.error(
                "Replacement succeeded but cleanup failed:",
                cleanupError
            );
        }

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
        await fs.rm(lockPath, { recursive: true, force: true });
    }
}
