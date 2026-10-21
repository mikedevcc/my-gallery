import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { mock, test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { acquireResolutionClaim, releaseUnboundResolutionClaim, finishOwnedConflict } from "./conflict-resolution-lock";
import { replaceMediaAtDestination } from "./media-mutations";
import { recoverReplacement, reconcileReplacement, type RecoveryDatabase } from "./replacement-files";
import { acquireDestinationLock, DestinationBusyError, DestinationRecoveryError } from "./destination-lock";
import { prepareReplacementJournal, readReplacementJournal } from "./replacement-recovery";
import { removeStagedConflict } from "./media-storage";
import { mockStorageMount, writeTestStorageMarker } from "./testing/storage-fixture";

const id = "12ec0585-07cb-4e3c-9d84-1ec28cb40a82";
async function fixture(action: (f: { root: string; target: string; staged: string; job: string; marker: string;
    mount: Awaited<ReturnType<typeof mockStorageMount>>; database: RecoveryDatabase }) => Promise<void>) {
    const root = await fs.mkdtemp(path.join(tmpdir(), "gallery-n1-test-"));
    await writeTestStorageMarker(root); const mount = await mockStorageMount(root);
    const target = path.join(root, "original.jpg"), job = path.join(root, ".incoming", id);
    const staged = path.join(job, "incoming.jpg"), marker = path.join(job, ".resolution-lock");
    await fs.mkdir(job, { recursive: true }); await fs.writeFile(target, "original"); await fs.writeFile(staged, "incoming");
    await fs.writeFile(path.join(job, ".conflict.json"), JSON.stringify({ type: "FILENAME", conflictId: id, jobId: "job", existingPath: target, existingMediaId: 1 }));
    const database: RecoveryDatabase = async (_op, _media, callback) => {
        let receipt;
        try { receipt = JSON.parse(await fs.readFile(path.join(root, "receipt.json"), "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        return callback({ receipt, mediaPath: target });
    };
    try { await action({ root, target, staged, job, marker, mount, database }); }
    finally { mount.restore(); await fs.rm(root, { recursive: true, force: true }); }
}
async function journalId(root: string) {
    return (await fs.readdir(path.join(root, ".replacement-operations"))).find(x => x.endsWith(".json"))!.slice(0, -5);
}
async function crash(root: string, boundary: string, mode = "replace", op = "", atBoundary?: () => Promise<void>) {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/testing/conflict-recovery-worker.ts", root, boundary, mode, op], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = ""; child.stderr.on("data", part => { stderr += part; });
    const lines = createInterface({ input: child.stdout });
    try {
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`N1 worker timeout: ${stderr}`)), 10000);
            lines.on("line", line => { if (line === "BOUNDARY") { clearTimeout(timer); resolve(); } });
            child.once("exit", () => { clearTimeout(timer); reject(new Error(`N1 worker exited: ${stderr}`)); });
        });
        await atBoundary?.();
    } finally {
        if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
        lines.close();
    }
}

test("durable owned marker excludes a second claim; safe preflight release preserves conflict files", () => fixture(async ({ root, staged, marker, job }) => {
    const claim = await acquireResolutionClaim(root, id, "REPLACE", staged);
    const owner = JSON.parse(await fs.readFile(path.join(marker, "owner.json"), "utf8"));
    assert.equal(owner.operationId, claim.operationId); assert.equal(owner.token, claim.evidence.token);
    assert.equal(owner.conflictId, id); assert.ok(owner.pid && owner.startTime && owner.bootId);
    await assert.rejects(acquireResolutionClaim(root, id, "REPLACE", staged), /already being resolved/);
    await releaseUnboundResolutionClaim(root, claim);
    await assert.rejects(fs.access(marker)); assert.equal(await fs.readFile(staged, "utf8"), "incoming");
    assert.ok(await fs.stat(path.join(job, ".conflict.json")));
}));

test("normal committed replacement binds marker before publication and finishes conflict before destination release", () => fixture(async ({ root, target, staged, job, marker }) => {
    const claim = await acquireResolutionClaim(root, id, "REPLACE", staged);
    await replaceMediaAtDestination({ root, destination: target, stagedPath: staged, mediaId: 1, conflict: claim,
        revalidateMetadata: async () => {}, readReceipt: async () => undefined,
        updateMetadata: async receipt => {
            const journal = await readReplacementJournal(root, receipt.operationId);
            assert.equal(journal.conflict?.token, claim.evidence.token);
            assert.equal(journal.conflict?.phase, "BOUND"); assert.ok(await fs.stat(marker));
            await assert.rejects(acquireDestinationLock(root, target), DestinationBusyError);
        },
    });
    assert.equal(await fs.readFile(target, "utf8"), "incoming"); await assert.rejects(fs.access(job));
    assert.equal((await readReplacementJournal(root, claim.operationId)).conflict?.phase, "FINALIZED");
    const lock = await acquireDestinationLock(root, target); await lock.release();
}));

test("inline rollback preserves staging and releases only its matching marker", () => fixture(async ({ root, target, staged, job, marker, database }) => {
    const claim = await acquireResolutionClaim(root, id, "REPLACE", staged);
    await assert.rejects(replaceMediaAtDestination({ root, destination: target, stagedPath: staged, mediaId: 1, conflict: claim,
        revalidateMetadata: async () => {}, readReceipt: async () => undefined, withRecoveryDatabase: database,
        updateMetadata: async () => { throw new Error("metadata rollback"); },
    }), /metadata rollback/);
    assert.equal(await fs.readFile(target, "utf8"), "original"); assert.equal(await fs.readFile(staged, "utf8"), "incoming");
    await assert.rejects(fs.access(marker)); assert.ok(await fs.stat(path.join(job, ".conflict.json")));
    const retry = await acquireResolutionClaim(root, id, "REPLACE", staged); await releaseUnboundResolutionClaim(root, retry);
}));

for (const boundary of ["committed", "files-settled", "metadata-unlink", "owner-unlink", "marker-rmdir", "job-rmdir", "finalized", "rollback-files"]) {
    test(`crash at ${boundary} reconciles owned conflict and repeats safely`, () => fixture(async ({ root, target, staged, job, marker, database }) => {
        const rollback = boundary === "rollback-files";
        await crash(root, boundary, rollback ? "rollback" : "replace");
        const operation = await journalId(root);
        assert.equal(await recoverReplacement(root, operation, database), rollback ? "ROLLED_BACK" : "COMMITTED");
        assert.equal((await readReplacementJournal(root, operation)).conflict?.phase, "FINALIZED");
        assert.equal(await recoverReplacement(root, operation, database), "ALREADY_COMPLETE");
        await assert.rejects(fs.access(marker));
        if (rollback) {
            assert.equal(await fs.readFile(target, "utf8"), "original"); assert.equal(await fs.readFile(staged, "utf8"), "incoming");
            assert.ok(await fs.stat(path.join(job, ".conflict.json")));
            const retry = await acquireResolutionClaim(root, id, "REPLACE", staged); await releaseUnboundResolutionClaim(root, retry);
        } else { assert.equal(await fs.readFile(target, "utf8"), "incoming"); await assert.rejects(fs.access(job)); }
    }));
}

for (const boundary of ["metadata-unlink", "owner-unlink", "marker-rmdir", "job-rmdir"]) {
    test(`recovery itself restarts after ${boundary}`, () => fixture(async ({ root, job, database }) => {
        await crash(root, "files-settled"); const op = await journalId(root);
        await crash(root, boundary, "recover", op);
        assert.equal(await recoverReplacement(root, op, database), "COMMITTED");
        assert.equal(await recoverReplacement(root, op, database), "ALREADY_COMPLETE"); await assert.rejects(fs.access(job));
    }));
}

test("committed recovery does not require a staged file", () => fixture(async ({ root, staged, job, database }) => {
    await crash(root, "committed"); const op = await journalId(root);
    await fs.unlink(staged);
    assert.equal(await recoverReplacement(root, op, database), "COMMITTED"); await assert.rejects(fs.access(job));
}));

test("rollback with missing staging retains destination and marker for investigation", () => fixture(async ({ root, target, staged, marker, database }) => {
    await crash(root, "rollback-files", "rollback"); const op = await journalId(root);
    await fs.unlink(staged);
    await assert.rejects(recoverReplacement(root, op, database), /evidence missing/);
    assert.ok(await fs.stat(marker)); assert.equal(await fs.readFile(target, "utf8"), "original");
    await assert.rejects(acquireDestinationLock(root, target), DestinationBusyError);
}));

for (const change of ["owner-token", "owner-inode", "marker-directory", "metadata", "extra-entry", "stage-inode"] as const) {
    test(`changed ${change} keeps both locks and surviving evidence`, () => fixture(async ({ root, target, staged, job, marker, database }) => {
        await crash(root, "committed"); const op = await journalId(root), journal = await readReplacementJournal(root, op);
        const owner = path.join(marker, "owner.json");
        if (change === "owner-token") { const data = JSON.parse(await fs.readFile(owner, "utf8")); data.token = "foreign"; await fs.writeFile(owner, JSON.stringify(data)); }
        if (change === "owner-inode") { await fs.copyFile(owner, `${owner}.new`); await fs.rename(`${owner}.new`, owner); }
        if (change === "marker-directory") { await fs.rename(marker, `${marker}.saved`); await fs.mkdir(marker); await fs.copyFile(path.join(`${marker}.saved`, "owner.json"), owner); }
        if (change === "metadata") await fs.writeFile(path.join(job, ".conflict.json"), "unknown");
        if (change === "extra-entry") await fs.writeFile(path.join(job, "unknown"), "preserve me");
        if (change === "stage-inode") { await fs.writeFile(path.join(job, "new"), "incoming"); await fs.rename(path.join(job, "new"), staged); }
        await assert.rejects(recoverReplacement(root, op, database));
        assert.ok(await fs.lstat(marker)); assert.equal(await fs.readFile(journal.backupPath, "utf8"), "original");
        assert.equal(await fs.readFile(target, "utf8"), "incoming");
        await assert.rejects(acquireDestinationLock(root, target), DestinationBusyError);
    }));
}

test("legacy ownerless markers and unbound legacy journals require manual review", () => fixture(async ({ root, target, staged, marker, database }) => {
    await fs.mkdir(marker);
    await assert.rejects(acquireResolutionClaim(root, id, "REPLACE", staged), /already being resolved/);
    const lock = await acquireDestinationLock(root, target), journal = await prepareReplacementJournal(root, 1, staged, lock);
    await assert.rejects(reconcileReplacement(root, journal, lock, { mediaPath: target }), /Legacy conflict marker/);
    const ownerPath = path.join(lock.directory, "owner.json"), owner = JSON.parse(await fs.readFile(ownerPath, "utf8"));
    await fs.writeFile(ownerPath, JSON.stringify({ ...owner, startTime: "0" }));
    await assert.rejects(recoverReplacement(root, journal.operationId, database), /Legacy conflict marker/);
    assert.equal(await fs.readFile(target, "utf8"), "original"); assert.ok(await fs.stat(marker));
}));

test("unavailable storage or ambiguous DB outcome never frees markers", () => fixture(async ({ root, target, marker, mount, database }) => {
    await crash(root, "committed"); const op = await journalId(root);
    mount.state.mounted = false; await assert.rejects(recoverReplacement(root, op, database));
    mount.state.mounted = true;
    await assert.rejects(recoverReplacement(root, op, async () => { throw new Error("DB outcome unknown"); }), /outcome unknown/);
    assert.ok(await fs.stat(marker)); await assert.rejects(acquireDestinationLock(root, target), DestinationBusyError);
}));

test("nonreplacement owned cleanup and preflight release never remove unknown artifacts", () => fixture(async ({ root, staged, job, marker }) => {
    const claim = await acquireResolutionClaim(root, id, "KEEP_BOTH", staged);
    await fs.writeFile(path.join(job, "unknown"), "keep");
    await assert.rejects(finishOwnedConflict(root, claim), /Unknown conflict artifacts/);
    await assert.rejects(releaseUnboundResolutionClaim(root, claim), /Unknown conflict artifacts/);
    assert.ok(await fs.stat(marker)); assert.equal(await fs.readFile(staged, "utf8"), "incoming");
}));

test("legacy direct SKIP cannot delete an owned or ownerless marker", () => fixture(async ({ root, staged, marker }) => {
    const claim = await acquireResolutionClaim(root, id, "SKIP", staged);
    await assert.rejects(removeStagedConflict(id, root), /already being resolved/);
    assert.ok(await fs.stat(marker));
    await removeStagedConflict(id, root, claim); await assert.rejects(fs.access(marker));
}));

test("resolver wrapper releases a safe preflight claim and preserves staged data", () => fixture(async ({ staged, job, marker }) => {
    const { Pool } = await import("pg");
    const checkout = mock.method(Pool.prototype, "connect", async () => { throw new Error("No database access allowed"); });
    const unsupported = path.join(job, "incoming.txt"); await fs.rename(staged, unsupported);
    try {
        const { resolveStagedConflict } = await import("./media-import-service");
        await assert.rejects(resolveStagedConflict(id, "REPLACE"), /Unsupported file type/);
        assert.equal(await fs.readFile(unsupported, "utf8"), "incoming"); await assert.rejects(fs.access(marker));
    } finally { checkout.mock.restore(); }
}));

test("resolver SKIP respects a busy destination and releases only its unused claim", () => fixture(async ({ root, target, staged, marker }) => {
    const lock = await acquireDestinationLock(root, target);
    const { Pool } = await import("pg");
    const checkout = mock.method(Pool.prototype, "connect", async () => { throw new Error("No database access allowed"); });
    try {
        const { resolveStagedConflict } = await import("./media-import-service");
        await assert.rejects(resolveStagedConflict(id, "SKIP"), DestinationBusyError);
        await assert.rejects(fs.access(marker)); assert.equal(await fs.readFile(staged, "utf8"), "incoming");
        await lock.release();
        assert.deepEqual(await resolveStagedConflict(id, "SKIP"), { type: "SKIPPED" });
        await assert.rejects(fs.access(staged));
    } finally { checkout.mock.restore(); }
}));

for (const ambiguous of [false, true]) {
    test(`resolver wrapper ${ambiguous ? "retains marker on ambiguous commit" : "uses journal finalization on success"}`, () => fixture(async ({ root, target, job, staged, marker }) => {
        const serviceTarget = path.join(root, "Unknown", "Unknown", "incoming.jpg");
        await fs.mkdir(path.dirname(serviceTarget), { recursive: true }); await fs.rename(target, serviceTarget);
        await fs.writeFile(path.join(job, ".conflict.json"), JSON.stringify({ type: "FILENAME", conflictId: id, jobId: "job", existingPath: serviceTarget, existingMediaId: 1 }));
        // Fixture-only ExifTool emits constant metadata; never inspect actual media.
        const bin = path.join(root, "bin"); await fs.mkdir(bin);
        await fs.writeFile(path.join(bin, "exiftool"), "#!/bin/sh\nprintf '%s\\n' '[{}]'\n", { mode: 0o700 });
        const previousPath = process.env.PATH; process.env.PATH = `${bin}:${previousPath ?? ""}`;
        const { Pool } = await import("pg");
        let commitAttempted = false;
        const checkout = mock.method(Pool.prototype, "connect", async () => ({
            query: async (sql: string) => {
                if (sql.includes("FROM public.media_replacement_receipts") && ambiguous && commitAttempted) throw new Error("Receipt outcome unavailable");
                if (sql === "COMMIT" && ambiguous) { commitAttempted = true; throw new Error("Commit acknowledgement lost"); }
                if (sql.includes("media_replacement_receipts") && sql.trim().startsWith("SELECT")) return { rows: [], rowCount: 0 };
                if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ locked: true }], rowCount: 1 };
                return { rows: [{ media_id: 1, path: serviceTarget }], rowCount: 1 };
            }, release: () => {},
        }) as unknown as import("pg").PoolClient);
        try {
            const { resolveStagedConflict } = await import("./media-import-service");
            if (ambiguous) {
                await assert.rejects(resolveStagedConflict(id, "REPLACE"), DestinationRecoveryError);
                assert.ok(await fs.stat(marker)); assert.equal(await fs.readFile(staged, "utf8"), "incoming");
                assert.equal(await fs.readFile(serviceTarget, "utf8"), "incoming");
                await assert.rejects(acquireDestinationLock(root, serviceTarget), DestinationBusyError);
            } else {
                assert.deepEqual(await resolveStagedConflict(id, "REPLACE"), { type: "COMPLETED", mediaId: 1 });
                await assert.rejects(fs.access(job));
                const journal = await readReplacementJournal(root, await journalId(root)); assert.equal(journal.conflict?.phase, "FINALIZED");
            }
        } finally {
            checkout.mock.restore(); if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
        }
    }));
}


test("live cross-process resolver excludes concurrent claims and recovery", () => fixture(async ({ root, staged, database }) => {
    await crash(root, "committed", "replace", "", async () => {
        await assert.rejects(acquireResolutionClaim(root, id, "REPLACE", staged), /already being resolved/);
        await assert.rejects(recoverReplacement(root, await journalId(root), database), /owner is still running/);
    });
    assert.equal(await recoverReplacement(root, await journalId(root), database), "COMMITTED");
}));

test("storage loss during conflict cleanup retains evidence and permits verified retry", () => fixture(async ({ root, job, marker, mount, database }) => {
    await crash(root, "files-settled"); const op = await journalId(root);
    const unlink = fs.unlink.bind(fs);
    const interruption = mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
        await unlink(...args);
        if (args[0] === path.join(job, ".conflict.json")) mount.state.mounted = false;
    });
    try { await assert.rejects(recoverReplacement(root, op, database)); }
    finally { interruption.mock.restore(); mount.state.mounted = true; }
    assert.ok(await fs.stat(marker));
    assert.equal(await recoverReplacement(root, op, database), "COMMITTED");
}));

test("KEEP_BOTH verified finalization removes only its own remaining conflict artifacts", () => fixture(async ({ root, target, staged, job }) => {
    const claim = await acquireResolutionClaim(root, id, "KEEP_BOTH", staged);
    // Ordinary finalization already consumed staging after its acknowledged INSERT.
    await fs.unlink(staged);
    await finishOwnedConflict(root, claim);
    assert.equal(claim.released, true); await assert.rejects(fs.access(job));
    assert.equal(await fs.readFile(target, "utf8"), "original");
}));

test("recorded conflict media ID is checked before publication", () => fixture(async ({ root, target, staged, job, marker }) => {
    const metadata = path.join(job, ".conflict.json"), value = JSON.parse(await fs.readFile(metadata, "utf8"));
    value.existingMediaId = 2; await fs.writeFile(metadata, JSON.stringify(value));
    const claim = await acquireResolutionClaim(root, id, "REPLACE", staged);
    await assert.rejects(replaceMediaAtDestination({ root, destination: target, stagedPath: staged, mediaId: 1, conflict: claim,
        readReceipt: async () => undefined, revalidateMetadata: async () => {}, updateMetadata: async () => { assert.fail("No database mutation before identity verification"); },
    }), /Recorded conflict media ID/);
    assert.equal(await fs.readFile(target, "utf8"), "original");
    await releaseUnboundResolutionClaim(root, claim); await assert.rejects(fs.access(marker));
}));

test("failed initial owner publication leaves an explicitly blocked marker", () => fixture(async ({ root, target, staged, marker }) => {
    const rename = fs.rename.bind(fs);
    const failure = mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
        if (args[1] === path.join(marker, "owner.json")) throw new Error("owner publication failed");
        return rename(...args);
    });
    try { await assert.rejects(acquireResolutionClaim(root, id, "REPLACE", staged), /owner publication failed/); }
    finally { failure.mock.restore(); }
    await assert.rejects(acquireResolutionClaim(root, id, "REPLACE", staged), /already being resolved/);
    assert.equal(await fs.readFile(target, "utf8"), "original"); assert.equal(await fs.readFile(staged, "utf8"), "incoming");
}));
