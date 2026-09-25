import {
    ImportedMedia,
    importMedia,
} from "./media-import";
import { insertImportedMedia } from "./media-database";
import { 
    removeEmptyParentDirectories,
    buildDestinationPath, 
    stageMediaFile, 
    finalizeStagedMedia,
} from "./media-storage";
import { 
    resolveLocation, 
    type ResolvedLocation
} from "./location"

import fs from "node:fs/promises";



export async function importMediaToLibrary(
    sourcePath: string
): Promise<number> {
    let finalPath: string | undefined;

    try {
        const imported = await importMedia(sourcePath);

        const { latitude, longitude } = imported.media;

        
        let location: ResolvedLocation = {};

        if (latitude !== undefined && longitude !== undefined) {
            const resolvedLocation = await resolveLocation(latitude, longitude);
            location = resolvedLocation
        }

        const destination = buildDestinationPath(imported, location.city);

        const staged = await stageMediaFile(imported.file.absolutePath);

        finalPath = await finalizeStagedMedia(staged, destination);
        
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

        return media_id;
    }
    catch (error) {
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

async function main () {
    const mediaId = await importMediaToLibrary("../../../Videos/VID_20260923_204043.mp4");
    console.log(mediaId);
}

main();