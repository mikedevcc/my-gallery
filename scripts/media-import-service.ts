import path from "node:path";
import fs from "node:fs/promises";

import {
    ImportedMedia,
    importMedia,
} from "./media-import";
import {
    insertImportedMedia,
    findMediaByPath,
} from "./media-database";
import { 
    removeEmptyParentDirectories,
    buildDestinationPath, 
    stageMediaFile, 
    finalizeStagedMedia,
    destinationExists,
} from "./media-storage";
import { 
    resolveLocation, 
    type ResolvedLocation
} from "./media-location"

import { ImportConflict } from "@/lib/import/import-conflict";


type ServerImportResult =
    | {
        type: "COMPLETED";
        mediaId: number;
    }
    | {
        type: "CONFLICT";
        conflict: ImportConflict;
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

            return {
                type: "CONFLICT",
                conflict: {
                    type: "FILENAME",
                    jobId,
                    conflictId,
                    existingMediaId: existingMedia?.media_id,
                    existingPath: destination,
                }
            }
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
