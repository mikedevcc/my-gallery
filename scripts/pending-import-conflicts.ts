import fs from "node:fs/promises";
import { validateStorage, readStorageFile, StorageUnavailableError } from "./storage-safety";
import path from "node:path";
import type { ImportConflict } from "@/lib/import/import-conflict";
import { getMediaStorageRoot, findStagedConflictFile, buildDestinationPath } from "./media-storage";
import { importMedia } from "./media-import";
import { resolveLocation } from "./media-location";
import { findMediaByPath } from "./media-database";

const metadataName = ".conflict.json";
export async function savePendingConflict(stagedPath: string, conflict: ImportConflict) {
    const storage = await validateStorage();
    const metadataPath = path.join(path.dirname(stagedPath), metadataName);
    await storage.assertAvailable(metadataPath);
    await fs.writeFile(metadataPath, JSON.stringify(conflict));
    await storage.assertAvailable(metadataPath);
}

export async function listPendingConflicts(): Promise<ImportConflict[]> {
    const storage = await validateStorage();
    const incoming = path.join(storage.root, ".incoming");
    await storage.assertAvailable(incoming);
    const entries = await fs.readdir(incoming, { withFileTypes: true }).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") { await storage.assertAvailable(incoming); return []; }
        throw error;
    });
    const conflicts: ImportConflict[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
            const stagedPath = await findStagedConflictFile(entry.name);
            const metadataPath = path.join(incoming, entry.name, metadataName);
            try {
                const conflict = JSON.parse((await readStorageFile(metadataPath)).toString("utf8")) as ImportConflict;
                conflicts.push(conflict);
                continue;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
            // Recover files staged before persistent conflict metadata was introduced.
            const imported = await importMedia(stagedPath);
            const { latitude, longitude } = imported.media;
            const location = latitude !== undefined && longitude !== undefined
                ? await resolveLocation(latitude, longitude) : {};
            const destination = buildDestinationPath(imported, location.city);
            await storage.assertAvailable(destination);
            await fs.access(destination);
            const existing = await findMediaByPath(destination);
            const conflict: ImportConflict = { type: "FILENAME", conflictId: entry.name, jobId: entry.name,
                existingPath: destination, existingMediaId: existing?.media_id };
            await savePendingConflict(stagedPath, conflict);
            conflicts.push(conflict);
        } catch (error) {
            if (error instanceof StorageUnavailableError) throw error;
            console.error("Could not recover staged conflict", entry.name, error);
        }
    }
    return conflicts;
}

export async function getConflictPreviewPath(conflictId: string, side: string) {
    const stagedPath = await findStagedConflictFile(conflictId);
    if (side === "incoming") return stagedPath;
    if (side !== "existing") throw new Error("Invalid preview side");
    const conflict = JSON.parse((await readStorageFile(path.join(path.dirname(stagedPath), metadataName))).toString("utf8")) as ImportConflict;
    if (conflict.type !== "FILENAME") throw new Error("Preview unavailable");
    const relative = path.relative(getMediaStorageRoot(), conflict.existingPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Invalid media path");
    return conflict.existingPath;
}
