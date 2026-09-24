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

import fs from "node:fs/promises";

export async function importMediaToLibrary(
    sourcePath: string,
    city: string,
): Promise<number> {
    let finalPath: string | undefined;

    try {
        const imported = await importMedia(sourcePath);

        const destination = buildDestinationPath(imported, city);

        const staged = await stageMediaFile(imported.file.absolutePath);

        finalPath = await finalizeStagedMedia(staged, destination);
        
        const storedImported: ImportedMedia = {
            ...imported,
            file: {
                ...imported.file,
                absolutePath: finalPath,
            },
        };
        
        const media_id =  await insertImportedMedia(storedImported);

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
    const mediaId = await importMediaToLibrary("../../../Videos/VID_20260923_204043.mp4", "Singapore");
    console.log(mediaId);
}

main();