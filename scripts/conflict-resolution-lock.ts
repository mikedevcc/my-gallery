import { assertStagedMediaPath, canonicalOriginalDestination } from "./media-paths";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { processIdentity } from "./process-identity";
import { readStorageFile, validateStorage } from "./storage-safety";
import { identifyReplacementFile, syncParents, syncReplacementPath, writeReplacementJournal, type FileIdentity, type ReplacementJournal } from "./replacement-recovery";
import type { DestinationLock } from "./destination-lock";
import type { ConflictAction } from "@/lib/import/import-conflict";

export type DirectoryIdentity = { device: string; inode: string };
export type ConflictEvidence = {
    conflictId: string;
    token: string;
    job: DirectoryIdentity;
    marker: DirectoryIdentity;
    owner: FileIdentity;
    metadata: FileIdentity;
    // File reconciliation can complete before conflict cleanup finishes.
    phase: "BOUND" | "CLEANUP_PENDING" | "MARKER_REMOVAL_PENDING" | "FINALIZED";
    outcome?: "COMMITTED" | "ROLLED_BACK";
};
export type ResolutionClaim = {
    operationId: string;
    stagedPath: string;
    target: string;
    action: ConflictAction;
    incoming: FileIdentity;
    evidence: ConflictEvidence;
    retain: boolean;
    released: boolean;

    fileModifiedAt?: Date | null;
    fileModifiedTimezone?: string | null;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function parseStoredFileModifiedAt(value: unknown): Date | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {throw new Error("Invalid stored file modification date");}
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {throw new Error("Invalid stored file modification date");}
    return date;
}
function parseStoredFileModifiedTimezone(
    value: unknown,
): string | null {
    if (value === undefined || value === null) {
        return null;
    }

    if (
        typeof value !== "string" ||
        !value ||
        value.length > 128 ||
        !/^[A-Za-z0-9_+\-/]+$/.test(value)
    ) {
        throw new Error("Invalid stored file modification timezone");
    }

    try {
        return new Intl.DateTimeFormat("en-US", {
            timeZone: value,
        }).resolvedOptions().timeZone;
    } catch {
        throw new Error("Invalid stored file modification timezone");
    }
}
function locations(root: string, id: string) {
    if (!uuid.test(id)) throw new Error("Invalid conflict ID");
    const job = path.join(root, ".incoming", id), marker = path.join(job, ".resolution-lock");
    return { job, marker, owner: path.join(marker, "owner.json"), metadata: path.join(job, ".conflict.json") };
}
function same(a: FileIdentity, b: FileIdentity) {
    return a.sha256 === b.sha256 && a.size === b.size && a.device === b.device && a.inode === b.inode;
}
async function directoryIdentity(root: string, location: string): Promise<DirectoryIdentity> {
    await (await validateStorage(root)).assertAvailable(location);
    const stat = await fs.lstat(location, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Conflict directory identity changed");
    return { device: String(stat.dev), inode: String(stat.ino) };
}
async function requireDirectory(root: string, location: string, expected: DirectoryIdentity) {
    const actual = await directoryIdentity(root, location);
    if (actual.device !== expected.device || actual.inode !== expected.inode) throw new Error("Conflict directory identity changed");
}
async function exists(root: string, location: string) {
    await (await validateStorage(root)).assertAvailable(location);
    try { await fs.lstat(location); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return false; }
}
async function requireFile(root: string, location: string, expected: FileIdentity, missing = false) {
    if (!await exists(root, location)) { if (missing) return; throw new Error("Conflict evidence missing"); }
    if (!same(await identifyReplacementFile(root, location), expected)) throw new Error("Conflict file identity changed");
}
export async function acquireResolutionClaim(root: string, conflictId: string, action: ConflictAction, stagedPath: string): Promise<ResolutionClaim> {
    if (!["REPLACE", "KEEP_BOTH", "SKIP"].includes(action)) throw new Error("Invalid conflict action");
    const storage = await validateStorage(root), paths = locations(storage.root, conflictId);
    assertStagedMediaPath(storage.root, stagedPath, conflictId);
    // Reject an invalid recorded destination before creating a marker/owner.
    const recorded = JSON.parse((await readStorageFile(paths.metadata)).toString("utf8"));
    if (recorded.conflictId !== conflictId || recorded.type !== "FILENAME" || typeof recorded.existingPath !== "string") throw new Error("Invalid recorded conflict identity");
    const fileModifiedTimezone = parseStoredFileModifiedTimezone(recorded.fileModifiedTimezone);
    const fileModifiedAt = parseStoredFileModifiedAt(recorded.fileModifiedAt);
    await canonicalOriginalDestination(storage.root, recorded.existingPath);
    await storage.assertAvailable(recorded.existingPath);
    await storage.assertAvailable(paths.marker);
    try { await fs.mkdir(paths.marker); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("This file is already being resolved; ownership review required."); throw error; }
    // Any failure after mkdir leaves a blocked marker. Never guess ownership.
    const job = await directoryIdentity(root, paths.job), marker = await directoryIdentity(root, paths.marker);
    const incoming = await identifyReplacementFile(root, stagedPath), metadata = await identifyReplacementFile(root, paths.metadata);
    const conflict = JSON.parse((await readStorageFile(paths.metadata)).toString("utf8"));
    if (conflict.conflictId !== conflictId || conflict.type !== "FILENAME" || typeof conflict.existingPath !== "string") throw new Error("Invalid recorded conflict identity");
    await canonicalOriginalDestination(storage.root, conflict.existingPath);
    await storage.assertAvailable(conflict.existingPath);
    const operationId = randomUUID(), token = randomUUID();
    const owner = { version: 1, operationId, token, conflictId, action, stagedPath, target: conflict.existingPath, incoming, metadata, job, marker,
        installationId: process.env.MEDIA_STORAGE_ID, filesystemUuid: process.env.MEDIA_STORAGE_UUID, ...await processIdentity() };
    const temporary = path.join(paths.marker, `.owner-${token}.tmp`);
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(owner) + "\n"); await handle.sync(); } finally { await handle.close(); }
    await syncReplacementPath(root, stagedPath);
    await syncReplacementPath(root, paths.metadata);
    await storage.assertAvailable(paths.owner); await fs.rename(temporary, paths.owner);
    await syncParents(root, paths.owner);
    return {
        operationId,
        stagedPath,
        target: conflict.existingPath,
        action,
        incoming,
        retain: false,
        released: false,
        evidence: {
            conflictId,
            token,
            job,
            marker,
            owner: await identifyReplacementFile(root, paths.owner),
            metadata,
            phase: "BOUND",
        },
        fileModifiedAt,
        fileModifiedTimezone,
    };
}

// Validate paths and evidence even when the staged file has already been removed.
export function validateConflictEvidence(root: string, journal: ReplacementJournal) {
    const evidence = journal.conflict;
    if (!evidence) return;
    const paths = locations(root, evidence.conflictId);
    assertStagedMediaPath(root, journal.stagedPath, evidence.conflictId);
    const identity = (value: FileIdentity | undefined) => value && /^[0-9a-f]{64}$/.test(value.sha256)
        && [value.size, value.device, value.inode].every(x => typeof x === "string" && /^\d+$/.test(x));
    const directory = (value: DirectoryIdentity | undefined) => value && [value.device, value.inode].every(x => typeof x === "string" && /^\d+$/.test(x));
    if (!uuid.test(evidence.token) || !identity(evidence.owner) || !identity(evidence.metadata) || !directory(evidence.job) || !directory(evidence.marker)
        || !["BOUND", "CLEANUP_PENDING", "MARKER_REMOVAL_PENDING", "FINALIZED"].includes(evidence.phase)
        || (evidence.outcome !== undefined && !["COMMITTED", "ROLLED_BACK"].includes(evidence.outcome))
        || (evidence.phase !== "BOUND" && !evidence.outcome)
        || path.dirname(journal.stagedPath) !== paths.job || [".conflict.json", ".resolution-lock"].includes(path.basename(journal.stagedPath))) throw new Error("Invalid conflict journal binding");
}
async function verifyOwner(root: string, claim: ResolutionClaim, allowRemoval: boolean) {
    const paths = locations(root, claim.evidence.conflictId);
    await requireDirectory(root, paths.job, claim.evidence.job);
    if (!await exists(root, paths.marker)) { if (allowRemoval) return; throw new Error("Conflict marker missing"); }
    await requireDirectory(root, paths.marker, claim.evidence.marker);
    const entries = await fs.readdir(paths.marker);
    if (entries.some(name => name !== "owner.json")) throw new Error("Unknown conflict marker entries; manual review required");
    if (!entries.length && allowRemoval) return;
    await requireFile(root, paths.owner, claim.evidence.owner);
    const owner = JSON.parse((await readStorageFile(paths.owner)).toString("utf8"));
    if (owner.version !== 1 || owner.operationId !== claim.operationId || owner.token !== claim.evidence.token
        || owner.conflictId !== claim.evidence.conflictId || owner.action !== claim.action || owner.stagedPath !== claim.stagedPath || owner.target !== claim.target
        || owner.installationId !== process.env.MEDIA_STORAGE_ID || owner.filesystemUuid !== process.env.MEDIA_STORAGE_UUID) throw new Error("Conflict marker ownership changed");
}
async function verifyEntries(root: string, claim: ResolutionClaim) {
    const paths = locations(root, claim.evidence.conflictId);
    const allowed = new Set([path.basename(claim.stagedPath), ".conflict.json", ".resolution-lock"]);
    if ((await fs.readdir(paths.job)).some(name => !allowed.has(name))) throw new Error("Unknown conflict artifacts; cleanup refused");
}
function fromJournal(journal: ReplacementJournal): ResolutionClaim {
    return { operationId: journal.operationId, stagedPath: journal.stagedPath, target: journal.target, action: "REPLACE",
        incoming: journal.incoming, evidence: journal.conflict!, retain: true, released: false };
}
export async function verifyReplacementConflict(root: string, journal: ReplacementJournal, committed: boolean) {
    if (!journal.conflict) {
        // Old journals cannot prove ownership of a surviving staged marker.
        const marker = path.join(path.dirname(journal.stagedPath), ".resolution-lock");
        if (await exists(root, marker)) throw new Error("Legacy conflict marker has no journal binding; manual investigation required");
        return;
    }
    validateConflictEvidence(root, journal);
    const claim = fromJournal(journal), paths = locations(root, claim.evidence.conflictId);
    const phase = claim.evidence.phase;
    if (claim.evidence.outcome && claim.evidence.outcome !== (committed ? "COMMITTED" : "ROLLED_BACK")) throw new Error("Conflict cleanup outcome disagrees with receipt");
    if (!await exists(root, paths.job)) {
        if (committed && ["MARKER_REMOVAL_PENDING", "FINALIZED"].includes(phase)) return;
        throw new Error("Conflict job missing; manual investigation required");
    }
    await verifyOwner(root, claim, ["MARKER_REMOVAL_PENDING", "FINALIZED"].includes(phase));
    await verifyEntries(root, claim);
    await requireFile(root, claim.stagedPath, claim.incoming, committed);
    await requireFile(root, paths.metadata, claim.evidence.metadata, committed && phase !== "BOUND");
}
export async function bindReplacementConflict(root: string, claim: ResolutionClaim, journal: ReplacementJournal) {
    if (claim.action !== "REPLACE" || claim.operationId !== journal.operationId || claim.target !== journal.target || claim.stagedPath !== journal.stagedPath
        || !same(claim.incoming, journal.incoming)) throw new Error("Replacement no longer matches recorded conflict");
    journal.conflict = claim.evidence;
    await verifyReplacementConflict(root, journal, false);
    const metadata = JSON.parse((await readStorageFile(locations(root, claim.evidence.conflictId).metadata)).toString("utf8"));
    if (metadata.existingMediaId !== undefined && metadata.existingMediaId !== journal.mediaId) throw new Error("Recorded conflict media ID changed");
    claim.retain = true; // Handoff starts before any destination/journal persistence.
}
async function unlinkVerified(root: string, location: string, identity: FileIdentity) {
    await requireFile(root, location, identity, true);
    if (await exists(root, location)) { await requireFile(root, location, identity); await fs.unlink(location); }
    await syncReplacementPath(root, path.dirname(location));
}
async function removeMarker(root: string, claim: ResolutionClaim, allowRemoval: boolean) {
    const paths = locations(root, claim.evidence.conflictId);
    await verifyOwner(root, claim, allowRemoval);
    if (await exists(root, paths.marker)) {
        if (await exists(root, paths.owner)) await unlinkVerified(root, paths.owner, claim.evidence.owner);
        await requireDirectory(root, paths.marker, claim.evidence.marker);
        await fs.rmdir(paths.marker);
    }
    await syncReplacementPath(root, paths.job);
}
export async function finalizeReplacementConflict(root: string, journal: ReplacementJournal, lock: DestinationLock, committed: boolean) {
    if (!journal.conflict) return;
    await lock.assertOwned();
    await verifyReplacementConflict(root, journal, committed);
    const claim = fromJournal(journal), paths = locations(root, claim.evidence.conflictId);
    if (!["MARKER_REMOVAL_PENDING", "FINALIZED"].includes(claim.evidence.phase)) {
        claim.evidence.phase = "CLEANUP_PENDING"; claim.evidence.outcome = committed ? "COMMITTED" : "ROLLED_BACK";
        await writeReplacementJournal(root, journal, lock);
        if (committed) await unlinkVerified(root, paths.metadata, claim.evidence.metadata);
        claim.evidence.phase = "MARKER_REMOVAL_PENDING";
    }
    // Re-persist even after a prior attempt changed only in-memory phase.
    await writeReplacementJournal(root, journal, lock);
    if (await exists(root, paths.job)) {
        await lock.assertOwned(); await removeMarker(root, claim, true);
        if (committed) {
            await requireDirectory(root, paths.job, claim.evidence.job);
            if ((await fs.readdir(paths.job)).length) throw new Error("Conflict job is not empty; cleanup refused");
            await lock.assertOwned(); await fs.rmdir(paths.job);
        }
    }
    await syncReplacementPath(root, path.join(root, ".incoming"));
    claim.evidence.phase = "FINALIZED";
    await writeReplacementJournal(root, journal, lock);
}

// Pre-handoff errors may release only this claim, preserving both staged files.
export async function releaseUnboundResolutionClaim(root: string, claim: ResolutionClaim) {
    if (claim.retain || claim.released) return;
    await verifyOwner(root, claim, false); await verifyEntries(root, claim);
    await requireFile(root, claim.stagedPath, claim.incoming);
    await requireFile(root, locations(root, claim.evidence.conflictId).metadata, claim.evidence.metadata);
    await removeMarker(root, claim, false); claim.released = true;
}
// SKIP / KEEP_BOTH retain conservative manual-only recovery after side effects.
export async function finishOwnedConflict(root: string, claim: ResolutionClaim) {
    const paths = locations(root, claim.evidence.conflictId);
    await verifyOwner(root, claim, false); await verifyEntries(root, claim);
    await requireFile(root, claim.stagedPath, claim.incoming, true);
    await requireFile(root, paths.metadata, claim.evidence.metadata);
    claim.retain = true;
    await unlinkVerified(root, claim.stagedPath, claim.incoming);
    await unlinkVerified(root, paths.metadata, claim.evidence.metadata);
    await removeMarker(root, claim, false);
    await requireDirectory(root, paths.job, claim.evidence.job); await fs.rmdir(paths.job);
    await syncReplacementPath(root, path.join(root, ".incoming")); claim.released = true;
}
