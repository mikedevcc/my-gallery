import { prepareDeletionJournal, writeDeletionJournal, deletionReceiptFor, assertDeletionIdentity, syncDeletionCleanup, deletionThumbnailPath, type DeletionReceipt } from "./deletion-tracking";
import fs from "node:fs/promises";
import { publishReplacement, reconcileReplacement, type RecoveryDatabase } from "./replacement-files";
import { prepareReplacementJournal, receiptFor, writeReplacementJournal, type ReplacementReceipt } from "./replacement-recovery";
import { withDestinationLock } from "./destination-lock";
import { deleteStoredMedia } from "./media-storage";

// Callbacks keep PostgreSQL work inside the same destination ownership interval.
export async function replaceMediaAtDestination(options: {
    root: string;
    destination: string;
    stagedPath: string;
    mediaId: number;
    withRecoveryDatabase?: RecoveryDatabase;
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
        try {
            await publishReplacement(options.root, journal, lock);
            journal.state = "FILES_PUBLISHED";
            await writeReplacementJournal(options.root, journal, lock);
            journal.state = "COMMIT_PENDING";
            await writeReplacementJournal(options.root, journal, lock);
            try {
                await lock.assertOwned();
                await options.updateMetadata(receiptFor(journal), () => lock.assertOwned());
            } catch (error) {
                journal.state = "COMMIT_UNKNOWN";
                try { await writeReplacementJournal(options.root, journal, lock); }
                catch (journalError) { throw new AggregateError([error, journalError], "Metadata outcome and recovery journal update are unresolved"); }
                throw error;
            }
            journal.state = "COMMITTED";
            await writeReplacementJournal(options.root, journal, lock);
            // Receipt acknowledged by the transaction callback. Reconciliation
            // verifies identities before deleting any evidence and invalidates cache.
            await reconcileReplacement(options.root, journal, lock, { receipt: receiptFor(journal), mediaPath: journal.target });
        } catch (error) {
            if (options.withRecoveryDatabase) {
                try {
                    const outcome = await options.withRecoveryDatabase(journal.operationId, journal.mediaId,
                        evidence => reconcileReplacement(options.root, journal, lock, evidence));
                    if (outcome === "COMMITTED") return;
                } catch (recoveryError) {
                    throw new AggregateError([error, recoveryError], "Replacement remains unresolved; destination lock retained");
                }
            }
            throw error;
        }
        lock.markSafe();
    });
}

export async function deleteMediaAtDestination(options: {
    mediaId: number;
    root: string;
    destination: string;
    revalidateMetadata: () => Promise<boolean>;
    deleteMetadata: (assertStorage: () => Promise<void>, receipt: DeletionReceipt) => Promise<boolean>;
    afterDelete: () => Promise<void>;
}): Promise<boolean> {
    return withDestinationLock(options.root, options.destination, async lock => {
        if (!await options.revalidateMetadata()) return false;
        await lock.revalidate();
        const journal = await prepareDeletionJournal(options.root, options.mediaId, lock);
        journal.state = "COMMIT_PENDING";
        await writeDeletionJournal(options.root, journal, lock);
        const verify = async () => {
            await lock.assertOwned();
            await lock.revalidate();
            await assertDeletionIdentity(options.root, lock.destination, journal.original);
        };
        try {
            if (!await options.deleteMetadata(verify, deletionReceiptFor(journal))) {
                throw new Error("Deletion metadata changed; destination requires investigation");
            }
        } catch (error) {
            journal.state = "COMMIT_UNKNOWN";
            try { await writeDeletionJournal(options.root, journal, lock); }
            catch (journalError) { throw new AggregateError([error, journalError], "Deletion outcome and journal update are unresolved"); }
            throw error;
        }
        journal.state = "COMMITTED";
        await writeDeletionJournal(options.root, journal, lock);
        await verify();
        await deleteStoredMedia(lock.destination, lock);
        await lock.assertOwned();
        await assertDeletionIdentity(options.root, deletionThumbnailPath(options.root, options.mediaId), journal.thumbnail ?? null);
        await options.afterDelete();
        await syncDeletionCleanup(options.root, lock.destination);
        journal.state = "COMPLETE";
        await writeDeletionJournal(options.root, journal, lock);
        lock.markSafe();
        return true;
    });
}
