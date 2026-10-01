import fs from "node:fs/promises";
import path from "node:path";

import { importMediaToLibrary } from "../../scripts/media-import-service";


async function main(): Promise<void> {
    const sourcePath =
        "/home/mikef/Videos/VID_20260923_204043.mp4";

    const absolutePath = path.resolve(sourcePath);

    const fileBuffer = await fs.readFile(absolutePath);

    const file = new File(
        [fileBuffer],
        path.basename(absolutePath)
    );

    const mediaId = await importMediaToLibrary(file);

    console.log("Imported media ID:", mediaId);
}

main().catch((error) => {
    console.error("Import failed:", error);
    process.exitCode = 1;
});