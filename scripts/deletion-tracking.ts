import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { storageMarkerName, validateStorage } from "./storage-safety";
import type { DestinationLock } from "./destination-lock";
import { identifyReplacementFile, syncParents, syncReplacementPath, writeOperationJournal, type FileIdentity } from "./replacement-recovery";

export type DeletionReceipt = {
    operationId: string;
    mediaId: number;
    target: string;
    // null records verified absence, preserving deletion of already-missing media.
    original: FileIdentity | null;
};
export type DeletionJournal = DeletionReceipt & {
    version: 1;
    kind: "DELETE";
    installationId: string;
    filesystemUuid: string;
    lockToken: string;
    lockDirectory: string;
    thumbnail?: FileIdentity | null; // Absent in M1-A journals; unknown cache must be retained.
    state: "ABORTED" | "PREPARED" | "COMMIT_PENDING" | "COMMIT_UNKNOWN" | "COMMITTED" | "COMPLETE";
};
export function deletionReceiptFor(journal: DeletionJournal): DeletionReceipt {
    return { operationId: journal.operationId, mediaId: journal.mediaId, target: journal.target, original: journal.original };
}
export async function assertDeletionIdentity(root: string, target: string, expected: FileIdentity | null): Promise<void> {
    const actual = await originalIdentity(root, target);
    const matches = actual === null || expected === null ? actual === expected
        : actual.sha256 === expected.sha256 && actual.size === expected.size
            && actual.device === expected.device && actual.inode === expected.inode;
    if (!matches) throw new Error("Deletion target identity changed");
}
export async function originalIdentity(root: string, target: string): Promise<FileIdentity | null> {
    try { return await identifyReplacementFile(root, target); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // Distinguish an absent file from unavailable storage.
        await (await validateStorage(root)).assertAvailable(target);
        return null;
    }
}
export async function writeDeletionJournal(root: string, journal: DeletionJournal, lock: DestinationLock) {
    await writeOperationJournal(root, ".deletion-operations", journal, lock);
}
export async function prepareDeletionJournal(root: string, mediaId: number, lock: DestinationLock): Promise<DeletionJournal> {
    if (!Number.isSafeInteger(mediaId) || mediaId <= 0) throw new Error("Invalid deletion media ID");
    const original = await originalIdentity(root, lock.destination);
    const thumbnail = await originalIdentity(root, deletionThumbnailPath(root, mediaId));
    await lock.revalidate();
    const journal: DeletionJournal = {
        version: 1, kind: "DELETE", operationId: randomUUID(), mediaId, target: lock.destination, original,
        installationId: process.env.MEDIA_STORAGE_ID!, filesystemUuid: process.env.MEDIA_STORAGE_UUID!,
        lockToken: lock.token, lockDirectory: lock.directory, thumbnail, state: "PREPARED",
    };
    lock.markUnresolved();
    await lock.bindOperation(journal.operationId);
    if (original) await syncReplacementPath(root, lock.destination);
    if (thumbnail) {
        await syncReplacementPath(root, deletionThumbnailPath(root, mediaId));
        await syncParents(root, deletionThumbnailPath(root, mediaId));
    }
    await syncParents(root, lock.destination);
    await syncReplacementPath(root, path.join(lock.directory, "owner.json"));
    await syncParents(root, path.join(lock.directory, "owner.json"));
    await writeDeletionJournal(root, journal, lock);
    return journal;
}
export async function syncDeletionCleanup(root: string, destination: string) {
    await syncReplacementPath(root, path.dirname(destination));
    const thumbnails = path.join(root, ".thumbnails");
    try { await syncReplacementPath(root, thumbnails); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // Parent sync also makes absence durable.
        await syncReplacementPath(root, root);
    }
}


export function deletionThumbnailPath(root: string, mediaId: number) {
    return path.join(root, ".thumbnails", `${mediaId}.webp`);
}
function validIdentity(value: unknown): value is FileIdentity | null {
    if (value === null) return true;
    if (!value || typeof value !== "object") return false;
    const identity = value as FileIdentity;
    return typeof identity.sha256 === "string" && /^[0-9a-f]{64}$/.test(identity.sha256)
        && [identity.size, identity.device, identity.inode].every(x => typeof x === "string" && /^\d+$/.test(x));
}
export async function readDeletionJournal(root: string, operationId: string): Promise<DeletionJournal> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operationId)) throw new Error("Invalid deletion operation ID");
    const storage = await validateStorage(root);
    const location = path.join(storage.root, ".deletion-operations", `${operationId}.json`);
    await storage.assertAvailable(location);
    const handle = await fs.open(location, constants.O_RDONLY | constants.O_NOFOLLOW);
    let journal: DeletionJournal;
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 65536) throw new Error("Invalid deletion journal file");
        journal = JSON.parse(await handle.readFile("utf8"));
    } finally { await handle.close(); }
    await storage.assertAvailable(location);
    if (!journal || journal.kind !== "DELETE" || journal.version !== 1 || journal.operationId !== operationId
        || !["PREPARED", "COMMIT_PENDING", "COMMIT_UNKNOWN", "COMMITTED", "COMPLETE", "ABORTED"].includes(journal.state)
        || journal.installationId !== process.env.MEDIA_STORAGE_ID || journal.filesystemUuid !== process.env.MEDIA_STORAGE_UUID
        || !Number.isSafeInteger(journal.mediaId) || journal.mediaId <= 0 || typeof journal.lockToken !== "string"
        || !/^[0-9a-f-]{36}$/i.test(journal.lockToken) || !validIdentity(journal.original)
        || (journal.thumbnail !== undefined && !validIdentity(journal.thumbnail))
        || typeof journal.target !== "string" || !path.isAbsolute(journal.target)) throw new Error("Invalid deletion journal identity");
    const relative = path.relative(storage.root, journal.target);
    if (!relative || path.isAbsolute(relative) || relative.split(path.sep).some(part => part === "..")
        || relative.split(path.sep).slice(0, -1).some(part => part.startsWith("."))
        || path.basename(journal.target) === storageMarkerName
        || journal.target !== path.resolve(journal.target)) throw new Error("Invalid deletion target path");
    const expectedLock = path.join(storage.root, ".destination-locks", createHash("sha256").update(relative).digest("hex"));
    if (journal.lockDirectory !== expectedLock) throw new Error("Invalid deletion destination lock directory");
    await storage.assertAvailable(journal.target);
    await storage.assertAvailable(journal.lockDirectory);
    await storage.assertAvailable(deletionThumbnailPath(storage.root, journal.mediaId));
    return journal;
}
