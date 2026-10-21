import { bindReplacementConflict, validateConflictEvidence, type ConflictEvidence, type ResolutionClaim } from "./conflict-resolution-lock";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createStorageDirectory, validateStorage } from "./storage-safety";
import type { DestinationLock } from "./destination-lock";

export type ReplacementReceipt = {
    operationId: string;
    mediaId: number;
    target: string;
    originalSha256: string;
    incomingSha256: string;
};
export type RecoveryState = "PREPARED" | "FILES_PUBLISHED" | "COMMIT_PENDING" | "COMMIT_UNKNOWN" | "COMMITTED" | "COMPLETE" | "ROLLED_BACK";
export type FileIdentity = { sha256: string; size: string; device: string; inode: string };
export type ReplacementJournal = {
    version: 1;
    protocol?: 2;
    lockToken?: string;
    publicationPath?: string;
    operationId: string;
    installationId: string;
    filesystemUuid: string;
    mediaId: number;
    target: string;
    stagedPath: string;
    backupPath: string;
    lockDirectory: string;
    original: FileIdentity;
    incoming: FileIdentity;
    state: RecoveryState;
    conflict?: ConflictEvidence;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const states: RecoveryState[] = ["PREPARED", "FILES_PUBLISHED", "COMMIT_PENDING", "COMMIT_UNKNOWN", "COMMITTED", "COMPLETE", "ROLLED_BACK"];
const journalDirectory = ".replacement-operations";

// Fail closed if the filesystem does not support directory/file synchronization.
export async function syncReplacementPath(root: string, target: string): Promise<void> {
    const storage = await validateStorage(root);
    await storage.assertAvailable(target);
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
    await storage.assertAvailable(target);
}

export async function syncParents(root: string, target: string): Promise<void> {
    let directory = path.dirname(target);
    while (directory !== root) {
        await syncReplacementPath(root, directory);
        directory = path.dirname(directory);
    }
    await syncReplacementPath(root, root);
}

export async function identifyReplacementFile(root: string, target: string): Promise<FileIdentity> {
    const storage = await validateStorage(root);
    await storage.assertAvailable(target);
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile()) throw new Error("Replacement identity requires a regular file");
        const hash = createHash("sha256");
        // Stream large media without buffering it in memory; retain handle for stat/fsync.
        for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
        const after = await handle.stat({ bigint: true });
        if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
            throw new Error("Media changed while calculating replacement identity");
        }
        await storage.assertAvailable(target);
        const current = await fs.lstat(target, { bigint: true });
        if (current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size || current.mtimeNs !== before.mtimeNs || current.ctimeNs !== before.ctimeNs) throw new Error("Replacement identity path changed");
        return { sha256: hash.digest("hex"), size: before.size.toString(), device: before.dev.toString(), inode: before.ino.toString() };
    } finally { await handle.close(); }
}

export function receiptFor(journal: ReplacementJournal): ReplacementReceipt {
    return { operationId: journal.operationId, mediaId: journal.mediaId, target: journal.target,
        originalSha256: journal.original.sha256, incomingSha256: journal.incoming.sha256 };
}

function journalPath(root: string, operationId: string): string {
    if (!uuid.test(operationId)) throw new Error("Invalid replacement operation ID");
    return path.join(root, journalDirectory, `${operationId}.json`);
}

export async function writeReplacementJournal(root: string, journal: ReplacementJournal, lock: DestinationLock): Promise<void> {
    await writeOperationJournal(root, journalDirectory, journal, lock);
}

// Shared durable writer for lock-bound media operation journals.
export async function writeOperationJournal(root: string, directoryName: string,
    journal: { operationId: string; target: string }, lock: DestinationLock): Promise<void> {
    if (!uuid.test(journal.operationId) || ![".replacement-operations", ".deletion-operations"].includes(directoryName)) throw new Error("Invalid operation journal location");
    await lock.assertOwned(journal.target);
    const storage = await validateStorage(root);
    const directory = path.join(root, directoryName);
    await createStorageDirectory(storage, directory);
    await syncReplacementPath(root, root);
    const target = path.join(directory, `${journal.operationId}.json`);
    await storage.assertAvailable(target);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify(journal) + "\n"); await handle.sync(); }
    finally { await handle.close(); }
    await lock.assertOwned(journal.target);
    await storage.assertAvailable(temporary);
    await fs.rename(temporary, target);
    await syncReplacementPath(root, directory);
}

export async function prepareReplacementJournal(root: string, mediaId: number, stagedPath: string, lock: DestinationLock, conflict?: ResolutionClaim): Promise<ReplacementJournal> {
    if (!Number.isSafeInteger(mediaId) || mediaId <= 0) throw new Error("Invalid replacement media ID");
    const operationId = conflict?.operationId ?? randomUUID();
    const original = await identifyReplacementFile(root, lock.destination);
    const incoming = await identifyReplacementFile(root, stagedPath);
    if (original.device === incoming.device && original.inode === incoming.inode) throw new Error("Incoming media aliases the original inode");
    await lock.revalidate();
    const journal: ReplacementJournal = {
        version: 1, protocol: 2, lockToken: lock.token,
        publicationPath: `${lock.destination}.publish-${operationId}`,
        operationId, mediaId, target: lock.destination, stagedPath,
        backupPath: `${lock.destination}.backup-${operationId}`, lockDirectory: lock.directory,
        installationId: process.env.MEDIA_STORAGE_ID!, filesystemUuid: process.env.MEDIA_STORAGE_UUID!,
        original, incoming, state: "PREPARED",
    };
    if (conflict) await bindReplacementConflict(root, conflict, journal);
    // Once persistence starts, a failed fsync is an unresolved operation too.
    lock.markUnresolved();
    await lock.bindOperation(operationId);
    await syncReplacementPath(root, lock.destination);
    await syncReplacementPath(root, stagedPath);
    await syncParents(root, stagedPath);
    await syncParents(root, lock.destination);
    await syncReplacementPath(root, path.join(lock.directory, "owner.json"));
    await syncReplacementPath(root, lock.directory);
    await syncReplacementPath(root, path.dirname(lock.directory));
    await writeReplacementJournal(root, journal, lock);
    return journal;
}

export async function readReplacementJournal(root: string, operationId: string): Promise<ReplacementJournal> {
    const storage = await validateStorage(root);
    const target = journalPath(root, operationId);
    await storage.assertAvailable(target);
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    let journal: ReplacementJournal;
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 65536) throw new Error("Invalid replacement journal file");
        journal = JSON.parse(await handle.readFile("utf8"));
    } finally { await handle.close(); }
    await storage.assertAvailable(target);
    if (journal.version !== 1 || journal.operationId !== operationId || !states.includes(journal.state)
        || journal.installationId !== process.env.MEDIA_STORAGE_ID || journal.filesystemUuid !== process.env.MEDIA_STORAGE_UUID
        || !Number.isSafeInteger(journal.mediaId) || journal.mediaId <= 0
        || journal.backupPath !== `${journal.target}.backup-${operationId}`) throw new Error("Invalid replacement journal identity");
    for (const identity of [journal.original, journal.incoming]) {
        if (!identity || !/^[0-9a-f]{64}$/.test(identity.sha256)
            || ![identity.size, identity.device, identity.inode].every(value => typeof value === "string" && /^\d+$/.test(value))) throw new Error("Invalid journal file identity");
    }
    for (const location of [journal.target, journal.stagedPath, journal.backupPath, journal.lockDirectory]) {
        if (typeof location !== "string" || !path.isAbsolute(location)) throw new Error("Invalid journal path");
        await storage.assertAvailable(location);
    }
    validateConflictEvidence(storage.root, journal);
    return journal;
}

// Observation only: never restore, unlink, change journal state, or release locks.
// Absence is conclusive only AFTER independently establishing no in-flight DB transaction.
export async function inspectReplacementRecovery(root: string, operationId: string,
    lookup: (operationId: string) => Promise<ReplacementReceipt | undefined>, databaseSettled = false) {
    const journal = await readReplacementJournal(root, operationId);
    const receipt = await lookup(operationId); // Query failure propagates; never treated as absence.
    const expected = receiptFor(journal);
    const matches = receipt && Object.keys(expected).every(key => receipt[key as keyof ReplacementReceipt] === expected[key as keyof ReplacementReceipt]);
    const database = receipt ? (matches ? "COMMITTED" : "INCONSISTENT") : (databaseSettled ? "NOT_COMMITTED" : "UNKNOWN");
    const files: Record<string, "ORIGINAL" | "INCOMING" | "MISSING" | "OTHER"> = {};
    for (const [name, target] of Object.entries({ target: journal.target, backup: journal.backupPath, staged: journal.stagedPath })) {
        try {
            const identity = await identifyReplacementFile(root, target);
            const same = (other: FileIdentity) => identity.sha256 === other.sha256 && identity.size === other.size;
            files[name] = same(journal.incoming) ? "INCOMING" : same(journal.original) ? "ORIGINAL" : "OTHER";
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            await (await validateStorage(root)).assertAvailable(target);
            files[name] = "MISSING";
        }
    }
    return { operationId, state: journal.state, database, files };
}
