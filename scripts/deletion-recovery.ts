import fs from "node:fs/promises";
import { acquireDestinationLock, DestinationBusyError, type DestinationLock } from "./destination-lock";
import { assertDeletionIdentity, deletionThumbnailPath, originalIdentity, readDeletionJournal, syncDeletionCleanup, writeDeletionJournal, type DeletionJournal, type DeletionReceipt } from "./deletion-tracking";
import { removeVerified } from "./replacement-files";
import type { FileIdentity } from "./replacement-recovery";
import { validateStorage } from "./storage-safety";

export type DeletionEvidence = { receipt?: DeletionReceipt; media: { media_id: number; path: string }[] };
// The callback runs under the SAME transaction advisory lock used by deletion.
export type DeletionRecoveryDatabase = <T>(operationId: string, mediaId: number, target: string,
    action: (evidence: DeletionEvidence) => Promise<T>) => Promise<T>;
function same(a: FileIdentity | null, b: FileIdentity | null) {
    return a === null || b === null ? a === b : a.sha256 === b.sha256 && a.size === b.size && a.device === b.device && a.inode === b.inode;
}
async function checkSurvivor(root: string, location: string, expected: FileIdentity | null | undefined) {
    const actual = await originalIdentity(root, location);
    if (actual && (expected === undefined || !same(actual, expected))) throw new Error("Unknown deletion cleanup identity; manual investigation required");
}
export async function reconcileDeletion(root: string, journal: DeletionJournal, lock: DestinationLock, evidence: DeletionEvidence) {
    await lock.assertOwned(journal.target);
    if (lock.token !== journal.lockToken || lock.directory !== journal.lockDirectory) throw new Error("Deletion recovery ownership mismatch");
    const receipt = evidence.receipt;
    if (receipt) {
        if (receipt.operationId !== journal.operationId || receipt.mediaId !== journal.mediaId || receipt.target !== journal.target
            || !same(receipt.original, journal.original) || evidence.media.length || journal.state === "ABORTED") {
            throw new Error("Deletion receipt or current metadata inconsistent; manual investigation required");
        }
        const thumbnail = deletionThumbnailPath(root, journal.mediaId);
        // Check ALL surviving evidence before deleting anything. Missing originals
        // and caches are valid after an interrupted unlink; new generations aren't.
        await checkSurvivor(root, journal.target, journal.original);
        await checkSurvivor(root, thumbnail, journal.thumbnail);
        journal.state = "COMMITTED";
        await writeDeletionJournal(root, journal, lock);
        if (journal.original) await removeVerified(root, journal.target, journal.original, lock);
        else await assertDeletionIdentity(root, journal.target, null);
        if (journal.thumbnail) await removeVerified(root, thumbnail, journal.thumbnail, lock);
        else await assertDeletionIdentity(root, thumbnail, null);
        await syncDeletionCleanup(root, journal.target);
        journal.state = "COMPLETE";
    } else {
        if (["COMMITTED", "COMPLETE"].includes(journal.state) || evidence.media.length !== 1
            || evidence.media[0].media_id !== journal.mediaId || evidence.media[0].path !== journal.target) {
            throw new Error("Missing deletion receipt conflicts with metadata or journal; manual investigation required");
        }
        await assertDeletionIdentity(root, journal.target, journal.original);
        // No file mutations ever occur before the deletion commits.
        journal.state = "ABORTED";
    }
    await writeDeletionJournal(root, journal, lock);
    lock.markSafe();
    return receipt ? "COMMITTED" : "ABORTED";
}

const active = new Set<string>();
export async function recoverDeletion(root: string, operationId: string, database: DeletionRecoveryDatabase) {
    const storage = await validateStorage(root);
    const key = `${storage.root}:${operationId}`;
    if (active.has(key)) throw new DestinationBusyError("Deletion recovery already running in this process");
    active.add(key);
    try {
        const journal = await readDeletionJournal(storage.root, operationId);
        return await database(operationId, journal.mediaId, journal.target, async evidence => {
            await storage.assertAvailable(journal.lockDirectory);
            try { await fs.lstat(journal.lockDirectory); }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                if (["COMPLETE", "ABORTED"].includes(journal.state)) return "ALREADY_COMPLETE";
                throw new Error("Nonterminal deletion journal has no lock; manual investigation required");
            }
            const lock = await acquireDestinationLock(storage.root, journal.target, { operationId, token: journal.lockToken });
            try { return await reconcileDeletion(storage.root, journal, lock, evidence); }
            finally { if (!lock.unresolved) await lock.release(); }
        });
    } finally { active.delete(key); }
}
