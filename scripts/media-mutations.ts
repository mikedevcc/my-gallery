import fs from "node:fs/promises";
import path from "node:path";
import { prepareReplacementJournal, receiptFor, writeReplacementJournal, syncReplacementPath, type ReplacementReceipt } from "./replacement-recovery";
import { withDestinationLock } from "./destination-lock";
import { beginMediaReplacement, commitMediaReplacement, deleteStoredMedia } from "./media-storage";

// Callbacks keep PostgreSQL work inside the same destination ownership interval.
export async function replaceMediaAtDestination(options: {
    root: string;
    destination: string;
    stagedPath: string;
    mediaId: number;
    readReceipt: (operationId: string) => Promise<ReplacementReceipt | undefined>;
    revalidateMetadata: () => Promise<void>;
    updateMetadata: (receipt: ReplacementReceipt, assertStorage: () => Promise<void>) => Promise<void>;
}): Promise<void> {
    await withDestinationLock(options.root, options.destination, async lock => {
        await options.revalidateMetadata();
        await lock.revalidate();
        // A missing original is not a new-import opportunity for REPLACE.
        await fs.access(lock.destination);
        const journal = await prepareReplacementJournal(options.root, options.mediaId, options.stagedPath, lock);
        // Fail before publication if 0002 is absent or the operation ID already exists.
        if (await options.readReceipt(journal.operationId)) throw new Error("Replacement receipt already exists");
        const state = await beginMediaReplacement(options.stagedPath, lock.destination, lock, journal.backupPath);
        await syncReplacementPath(options.root, path.dirname(lock.destination));
        journal.state = "FILES_PUBLISHED";
        await writeReplacementJournal(options.root, journal, lock);
        journal.state = "COMMIT_PENDING";
        await writeReplacementJournal(options.root, journal, lock);
        try {
            await lock.assertOwned();
            await options.updateMetadata(receiptFor(journal), () => lock.assertOwned());
        } catch (error) {
            // Never roll files back after a potentially committed transaction.
            // Preserve both generations, staging, journal and lock for inspection.
            journal.state = "COMMIT_UNKNOWN";
            try {
                await writeReplacementJournal(options.root, journal, lock);
            } catch (journalError) {
                throw new AggregateError([error, journalError], "Metadata outcome and recovery journal update are unresolved");
            }
            throw error;
        }
        journal.state = "COMMITTED";
        await writeReplacementJournal(options.root, journal, lock);
        await lock.assertOwned();
        await commitMediaReplacement(state, lock);
        await syncReplacementPath(options.root, path.dirname(state.stagedPath));
        await syncReplacementPath(options.root, path.dirname(state.destinationPath));
        journal.state = "COMPLETE";
        await writeReplacementJournal(options.root, journal, lock);
        lock.markSafe();
    });
}

export async function deleteMediaAtDestination(options: {
    root: string;
    destination: string;
    revalidateMetadata: () => Promise<boolean>;
    deleteMetadata: (assertStorage: () => Promise<void>) => Promise<boolean>;
    afterDelete: () => Promise<void>;
}): Promise<boolean> {
    return withDestinationLock(options.root, options.destination, async lock => {
        if (!await options.revalidateMetadata()) return false;
        await lock.revalidate();
        lock.markUnresolved();
        await lock.assertOwned();
        if (!await options.deleteMetadata(() => lock.assertOwned())) {
            lock.markSafe();
            return false;
        }
        await deleteStoredMedia(lock.destination, lock);
        await options.afterDelete();
        lock.markSafe();
        return true;
    });
}
