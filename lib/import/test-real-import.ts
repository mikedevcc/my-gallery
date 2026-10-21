import { randomUUID } from "node:crypto";
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

    const result = await importMediaToLibrary(file, randomUUID());

    if (result.type === "COMPLETED") {
        console.log("Imported media ID:", result.mediaId);
    } else {
        console.log("Import requires conflict resolution:", result.conflict);
    }
}

main().catch((error) => {
    console.error("Import failed:", error);
    process.exitCode = 1;
});