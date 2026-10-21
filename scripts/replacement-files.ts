import { finalizeReplacementConflict, verifyReplacementConflict } from "./conflict-resolution-lock";
import fs from "node:fs/promises";
import path from "node:path";
import { acquireDestinationLock, DestinationBusyError, type DestinationLock } from "./destination-lock";
import { identifyReplacementFile, readReplacementJournal, receiptFor, syncReplacementPath, writeReplacementJournal, type FileIdentity, type ReplacementJournal, type ReplacementReceipt } from "./replacement-recovery";
import { validateStorage } from "./storage-safety";

export type ReplacementEvidence = { receipt?: ReplacementReceipt; mediaPath?: string };
export type RecoveryDatabase = <T>(operationId: string, mediaId: number, action: (evidence: ReplacementEvidence) => Promise<T>) => Promise<T>;

function same(a: FileIdentity, b: FileIdentity) {
    return a.sha256 === b.sha256 && a.size === b.size && a.device === b.device && a.inode === b.inode;
}
async function observed(root: string, target: string) {
    try { return await identifyReplacementFile(root, target); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await (await validateStorage(root)).assertAvailable(target);
        return undefined;
    }
}
function protocol(journal: ReplacementJournal) {
    const locations = [journal.target, journal.stagedPath, journal.backupPath, journal.publicationPath ?? ""].map(location => path.resolve(location));
    if (journal.protocol !== 2 || !journal.lockToken || journal.publicationPath !== `${journal.target}.publish-${journal.operationId}`
        || new Set(locations).size !== locations.length
        || (journal.original.device === journal.incoming.device && journal.original.inode === journal.incoming.inode)) {
        throw new Error("Legacy or invalid publication journal; manual investigation required");
    }
}
async function requireIdentity(root: string, target: string, expected: FileIdentity) {
    const actual = await observed(root, target);
    if (!actual || !same(actual, expected)) throw new Error(`Unexpected replacement file identity: ${target}`);
}
async function syncDirectoryIfPresent(root: string, directory: string) {
    try { await syncReplacementPath(root, directory); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await (await validateStorage(root)).assertAvailable(directory);
    }
}
export async function removeVerified(root: string, target: string, expected: FileIdentity, lock: DestinationLock) {
    await lock.assertOwned(); await lock.assertStorage(target);
    const actual = await observed(root, target);
    if (!actual) { await syncDirectoryIfPresent(root, path.dirname(target)); return; }
    if (!same(actual, expected)) throw new Error(`Refusing to remove unexpected file: ${target}`);
    await lock.assertOwned(); await lock.assertStorage(target);
    await fs.unlink(target);
    await syncReplacementPath(root, path.dirname(target));
}

export async function publishReplacement(root: string, journal: ReplacementJournal, lock: DestinationLock) {
    protocol(journal);
    await verifyReplacementConflict(root, journal, false);
    await lock.assertOwned(journal.target);
    await lock.revalidate();
    await requireIdentity(root, journal.target, journal.original);
    await requireIdentity(root, journal.stagedPath, journal.incoming);
    await lock.assertOwned(); await lock.assertStorage(journal.backupPath);
    // Exclusive link preserves the original without ever removing the target name.
    await fs.link(journal.target, journal.backupPath);
    await syncReplacementPath(root, path.dirname(journal.target));
    await lock.assertOwned(); await lock.assertStorage(journal.publicationPath!);
    await requireIdentity(root, journal.stagedPath, journal.incoming);
    await fs.link(journal.stagedPath, journal.publicationPath!);
    await syncReplacementPath(root, path.dirname(journal.target));
    await lock.assertOwned();
    await requireIdentity(root, journal.target, journal.original);
    await requireIdentity(root, journal.publicationPath!, journal.incoming);
    await fs.rename(journal.publicationPath!, journal.target);
    await syncReplacementPath(root, path.dirname(journal.target));
}

export async function invalidateReplacementThumbnail(root: string, mediaId: number, lock: DestinationLock) {
    if (!Number.isSafeInteger(mediaId) || mediaId <= 0) throw new Error("Invalid thumbnail media ID");
    const target = path.join(root, ".thumbnails", `${mediaId}.webp`);
    await lock.assertOwned(); await lock.assertStorage(target);
    try { await fs.unlink(target); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await lock.assertStorage(target);
        // A preceding recovery may have died after unlink but before fsync.
        await syncDirectoryIfPresent(root, path.dirname(target));
        return;
    }
    await syncReplacementPath(root, path.dirname(target));
}

// Called only under filesystem ownership AND the operation's DB transaction lock.
export async function reconcileReplacement(root: string, journal: ReplacementJournal, lock: DestinationLock, evidence: ReplacementEvidence): Promise<"COMMITTED" | "ROLLED_BACK"> {
    protocol(journal);
    await lock.assertOwned(journal.target);
    if (lock.token !== journal.lockToken || evidence.mediaPath !== journal.target) throw new Error("Recovery ownership or current media metadata mismatch");
    const expected = receiptFor(journal);
    if (evidence.receipt && !Object.keys(expected).every(key => evidence.receipt![key as keyof ReplacementReceipt] === expected[key as keyof ReplacementReceipt])) {
        throw new Error("Conflicting replacement receipt; manual investigation required");
    }
    if (!evidence.receipt && ["COMMITTED", "COMPLETE"].includes(journal.state)) throw new Error("Durable commit evidence disagrees with database; manual investigation required");
    await verifyReplacementConflict(root, journal, !!evidence.receipt);
    const target = await observed(root, journal.target);
    const backup = await observed(root, journal.backupPath);
    // Validate ALL surviving evidence before the first recovery mutation.
    for (const [location, identity] of [[journal.backupPath, journal.original], [journal.stagedPath, journal.incoming], [journal.publicationPath!, journal.incoming]] as const) {
        const actual = await observed(root, location);
        if (actual && !same(actual, identity)) throw new Error(`Recovery evidence changed: ${location}`);
    }
    if (evidence.receipt) {
        if (!target || !same(target, journal.incoming)) throw new Error("Committed receipt without expected incoming target; manual investigation required");
        await invalidateReplacementThumbnail(root, journal.mediaId, lock);
        await removeVerified(root, journal.publicationPath!, journal.incoming, lock);
        await removeVerified(root, journal.stagedPath, journal.incoming, lock);
        await removeVerified(root, journal.backupPath, journal.original, lock);
        journal.state = "COMPLETE";
    } else {
        if (target && !same(target, journal.original) && !same(target, journal.incoming)) throw new Error("Refusing rollback over unknown target");
        if (!target || !same(target, journal.original)) {
            if (!backup || !same(backup, journal.original)) throw new Error("Original backup unavailable; rollback refused");
            await lock.assertOwned();
            await requireIdentity(root, journal.backupPath, journal.original);
            if (target) await requireIdentity(root, journal.target, journal.incoming);
            // Restore atomically; never unlink the incoming target first.
            await fs.rename(journal.backupPath, journal.target);
        }
        // Also sync after a preceding recovery crashed immediately after restore.
        await requireIdentity(root, journal.target, journal.original);
        await syncReplacementPath(root, path.dirname(journal.target));
        await removeVerified(root, journal.publicationPath!, journal.incoming, lock);
        await removeVerified(root, journal.backupPath, journal.original, lock);
        journal.state = "ROLLED_BACK"; // Incoming staging is retained for an explicit retry.
    }
    await writeReplacementJournal(root, journal, lock);
    await finalizeReplacementConflict(root, journal, lock, !!evidence.receipt);
    lock.markSafe();
    return evidence.receipt ? "COMMITTED" : "ROLLED_BACK";
}

const activeRecoveries = new Set<string>();
export async function recoverReplacement(root: string, operationId: string, database: RecoveryDatabase) {
    const key = `${path.resolve(root)}:${operationId}`;
    if (activeRecoveries.has(key)) throw new DestinationBusyError("Recovery is already running in this process");
    activeRecoveries.add(key);
    try { return await recoverStoppedReplacement(root, operationId, database); }
    finally { activeRecoveries.delete(key); }
}

async function recoverStoppedReplacement(root: string, operationId: string, database: RecoveryDatabase) {
    const journal = await readReplacementJournal(root, operationId);
    protocol(journal);
    // This lock key must be exactly the canonical destination key, never a journal-supplied arbitrary directory.
    const { createHash } = await import("node:crypto");
    const expectedDirectory = path.join(root, ".destination-locks", createHash("sha256").update(path.relative(root, journal.target)).digest("hex"));
    if (journal.lockDirectory !== expectedDirectory) throw new Error("Invalid journal destination lock directory");
    return database(operationId, journal.mediaId, async evidence => {
        const storage = await validateStorage(root);
        await storage.assertAvailable(journal.lockDirectory);
        try { await fs.lstat(journal.lockDirectory); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            if (["COMPLETE", "ROLLED_BACK"].includes(journal.state)) {
                if (journal.conflict && journal.conflict.phase !== "FINALIZED") throw new Error("Unfinished conflict cleanup has no destination lock; manual investigation required");
                if (!journal.conflict) await verifyReplacementConflict(root, journal, !!evidence.receipt);
                return "ALREADY_COMPLETE";
            }
            throw new Error("Nonterminal journal has no destination lock; manual investigation required");
        }
        const lock = await acquireDestinationLock(root, journal.target, { operationId, token: journal.lockToken! });
        try { return await reconcileReplacement(root, journal, lock, evidence); }
        finally { if (!lock.unresolved) await lock.release(); }
    });
}
