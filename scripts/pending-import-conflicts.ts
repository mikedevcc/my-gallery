import { checkProcessingCancellation, ProcessingError } from "./processing-limits";
import { assertStagedMediaPath, canonicalOriginalDestination } from "./media-paths";
import fs from "node:fs/promises";
import { validateStorage, readStorageFile, StorageUnavailableError } from "./storage-safety";
import path from "node:path";
import type { ImportConflict } from "@/lib/import/import-conflict";
import { findStagedConflictFile, buildDestinationPath } from "./media-storage";
import { importMedia } from "./media-import";
import { resolveLocation } from "./media-location";
import { findMediaByPath, getMediaFileById } from "./media-database";

const metadataName = ".conflict.json";
export async function savePendingConflict(stagedPath: string, conflict: ImportConflict) {
    const storage = await validateStorage();
    assertStagedMediaPath(storage.root, stagedPath, conflict.conflictId);
    if (conflict.type === "FILENAME") {
        await canonicalOriginalDestination(storage.root, conflict.existingPath);
        await storage.assertAvailable(conflict.existingPath);
    }
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
    if (entries.length > 10_000) throw new ProcessingError("Too many staged jobs; maintenance required");
    const conflicts: ImportConflict[] = [];
    for (const entry of entries) {
        checkProcessingCancellation();
        if (!entry.isDirectory()) continue;
        try {
            const marker = path.join(incoming, entry.name, ".uploading");
            await storage.assertAvailable(marker);
            try { await fs.lstat(marker); continue; }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
            const stagedPath = await findStagedConflictFile(entry.name);
            const metadataPath = path.join(incoming, entry.name, metadataName);
            try {
                const conflict = JSON.parse((await readStorageFile(metadataPath)).toString("utf8")) as ImportConflict;
                if (conflict.conflictId !== entry.name) throw new Error("Invalid conflict identity");
                if (conflict.type === "FILENAME") await canonicalOriginalDestination(storage.root, conflict.existingPath);
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
            if (error instanceof ProcessingError) throw error;
            if (error instanceof StorageUnavailableError) throw error;
            console.error("Could not recover staged conflict", entry.name, error);
        }
    }
    return conflicts;
}

export async function getConflictPreviewSelection(conflictId: string, side: string) {
    if (side !== "incoming" && side !== "existing") throw new Error("Invalid preview side");
    const stagedPath = await findStagedConflictFile(conflictId);
    const metadata = (await readStorageFile(path.join(path.dirname(stagedPath), metadataName))).toString("utf8");
    const conflict = JSON.parse(metadata) as ImportConflict;
    if (conflict.conflictId !== conflictId) throw new Error("Invalid conflict identity");
    const destination = conflict.type === "FILENAME" ? conflict.existingPath
        : conflict.type === "HASH" && side === "incoming" ? (await getMediaFileById(conflict.existingMediaId))?.path : undefined;
    if (typeof destination !== "string") throw new Error("Preview unavailable");
    const storage = await validateStorage();
    await canonicalOriginalDestination(storage.root, destination);
    await storage.assertAvailable(destination);
    const resolution = path.join(path.dirname(stagedPath), ".resolution-lock");
    await storage.assertAvailable(resolution);
    try { await fs.lstat(resolution); throw new Error("Conflict is being resolved"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return { filePath: side === "incoming" ? stagedPath : destination, destination, metadata };
}
