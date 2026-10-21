import path from "node:path";
import { randomUUID } from "node:crypto";
import { validateStorage } from "./storage-safety";
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
    state: "PREPARED" | "COMMIT_PENDING" | "COMMIT_UNKNOWN" | "COMMITTED" | "COMPLETE";
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
async function originalIdentity(root: string, target: string): Promise<FileIdentity | null> {
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
    await lock.revalidate();
    const journal: DeletionJournal = {
        version: 1, kind: "DELETE", operationId: randomUUID(), mediaId, target: lock.destination, original,
        installationId: process.env.MEDIA_STORAGE_ID!, filesystemUuid: process.env.MEDIA_STORAGE_UUID!,
        lockToken: lock.token, lockDirectory: lock.directory, state: "PREPARED",
    };
    lock.markUnresolved();
    await lock.bindOperation(journal.operationId);
    if (original) await syncReplacementPath(root, lock.destination);
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
