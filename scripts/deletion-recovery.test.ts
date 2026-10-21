import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { mock, test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { acquireDestinationLock, DestinationBusyError } from "./destination-lock";
import { prepareDeletionJournal, readDeletionJournal, deletionReceiptFor } from "./deletion-tracking";
import { recoverDeletion, type DeletionEvidence, type DeletionRecoveryDatabase } from "./deletion-recovery";
import { replaceMediaAtDestination } from "./media-mutations";
import { mockStorageMount, writeTestStorageMarker } from "./testing/storage-fixture";

async function fixture(action: (f: {
    root: string; target: string; thumbnail: string; mount: Awaited<ReturnType<typeof mockStorageMount>>;
    database: DeletionRecoveryDatabase; evidence: DeletionEvidence;
}) => Promise<void>) {
    const root = await fs.mkdtemp(path.join(tmpdir(), "gallery-deletion-test-"));
    await writeTestStorageMarker(root); const mount = await mockStorageMount(root);
    const target = path.join(root, "original.jpg"), thumbnail = path.join(root, ".thumbnails", "1.webp");
    await fs.writeFile(target, "original"); await fs.mkdir(path.dirname(thumbnail)); await fs.writeFile(thumbnail, "cache");
    const evidence: DeletionEvidence = { media: [{ media_id: 1, path: target }] };
    const database: DeletionRecoveryDatabase = async (_op, _id, _target, callback) => callback(evidence);
    await fs.writeFile(path.join(root, "database.json"), JSON.stringify(evidence));
    try { await action({ root, target, thumbnail, mount, evidence, database }); }
    finally { mount.restore(); await fs.rm(root, { recursive: true, force: true }); }
}
async function stoppedJournal(root: string, target: string) {
    const lock = await acquireDestinationLock(root, target);
    const journal = await prepareDeletionJournal(root, 1, lock);
    // Simulated PID reuse only in temporary fixture. Real stopped workers below
    // verify the production process-death gate without this fixture shortcut.
    const ownerPath = path.join(lock.directory, "owner.json");
    const owner = JSON.parse(await fs.readFile(ownerPath, "utf8"));
    await fs.writeFile(ownerPath, JSON.stringify({ ...owner, startTime: "0" }));
    return journal;
}
async function journalId(root: string) {
    return (await fs.readdir(path.join(root, ".deletion-operations"))).find(x => x.endsWith(".json"))!.slice(0, -5);
}
async function crash(root: string, boundary: string, mode = "delete", id = "") {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/testing/deletion-worker.ts", root, boundary, mode, id], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = ""; child.stderr.on("data", part => { stderr += part; });
    const lines = createInterface({ input: child.stdout });
    try {
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Worker timeout: ${stderr}`)), 10000);
            lines.on("line", line => { if (line === "BOUNDARY") { clearTimeout(timer); resolve(); } });
            child.once("exit", () => { clearTimeout(timer); reject(new Error(`Worker exited: ${stderr}`)); });
        });
    } finally {
        if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
        }
        lines.close();
    }
}

for (const boundary of ["prepared", "pending", "acknowledgement", "committed", "original-unlink", "thumbnail-unlink", "complete"]) {
    test(`worker termination at ${boundary} recovers and repeats safely`, () => fixture(async ({ root, target, thumbnail }) => {
        await crash(root, boundary);
        const id = await journalId(root);
        const database: DeletionRecoveryDatabase = async (_op, _id, _target, action) => action(JSON.parse(await fs.readFile(path.join(root, "database.json"), "utf8")));
        const committed = !["prepared", "pending"].includes(boundary);
        assert.equal(await recoverDeletion(root, id, database), committed ? "COMMITTED" : "ABORTED");
        assert.equal((await readDeletionJournal(root, id)).state, committed ? "COMPLETE" : "ABORTED");
        if (committed) { await assert.rejects(fs.access(target)); await assert.rejects(fs.access(thumbnail)); }
        else { assert.equal(await fs.readFile(target, "utf8"), "original"); assert.equal(await fs.readFile(thumbnail, "utf8"), "cache"); }
        assert.equal(await recoverDeletion(root, id, database), "ALREADY_COMPLETE");
        // Completed old evidence cannot delete a newly reused destination.
        await fs.writeFile(target, "new generation");
        assert.equal(await recoverDeletion(root, id, database), "ALREADY_COMPLETE");
        assert.equal(await fs.readFile(target, "utf8"), "new generation");
    }));
}
for (const boundary of ["original-unlink", "aborted", "complete"]) {
    test(`recovery itself restarts after termination at ${boundary}`, () => fixture(async ({ root, target }) => {
        await crash(root, boundary === "aborted" ? "prepared" : "acknowledgement");
        const id = await journalId(root);
        await crash(root, boundary, "recover", id);
        const database: DeletionRecoveryDatabase = async (_op, _id, _target, action) => action(JSON.parse(await fs.readFile(path.join(root, "database.json"), "utf8")));
        assert.equal(await recoverDeletion(root, id, database), boundary === "aborted" ? "ABORTED" : "COMMITTED");
        if (boundary === "aborted") assert.equal(await fs.readFile(target, "utf8"), "original");
        else await assert.rejects(fs.access(target));
        assert.equal(await recoverDeletion(root, id, database), "ALREADY_COMPLETE");
    }));
}

test("live owners and busy database operation gates cannot be recovered", () => fixture(async ({ root, target, database }) => {
    const lock = await acquireDestinationLock(root, target), journal = await prepareDeletionJournal(root, 1, lock);
    await assert.rejects(recoverDeletion(root, journal.operationId, database), /owner is still running/);
    await assert.rejects(recoverDeletion(root, journal.operationId, async () => { throw new Error("database advisory lock busy"); }), /advisory lock busy/);
    assert.equal(await fs.readFile(target, "utf8"), "original");
    await assert.rejects(acquireDestinationLock(root, target), DestinationBusyError);
}));

for (const change of ["same-bytes-new-inode", "content", "symlink", "thumbnail", "receipt", "reused-path", "missing-row", "missing-original"] as const) {
    test(`unknown ${change} preserves evidence and stays locked`, () => fixture(async ({ root, target, thumbnail, evidence, database }) => {
        const journal = await stoppedJournal(root, target);
        if (!["missing-row", "missing-original"].includes(change)) { evidence.receipt = deletionReceiptFor(journal); evidence.media = []; }
        if (change === "same-bytes-new-inode") { const other = path.join(root, "other"); await fs.writeFile(other, "original"); await fs.rename(other, target); }
        if (change === "content") await fs.writeFile(target, "changed");
        if (change === "symlink") { await fs.rename(target, path.join(root, "saved")); await fs.symlink(path.join(root, "saved"), target); }
        if (change === "thumbnail") await fs.writeFile(thumbnail, "unknown cache");
        if (change === "receipt") evidence.receipt!.target = path.join(root, "other");
        if (change === "reused-path") evidence.media = [{ media_id: 2, path: target }];
        if (change === "missing-row") evidence.media = [];
        if (change === "missing-original") await fs.unlink(target);
        await assert.rejects(recoverDeletion(root, journal.operationId, database));
        assert.ok(await fs.lstat(journal.lockDirectory));
        if (change === "thumbnail") assert.equal(await fs.readFile(target, "utf8"), "original");
        if (change === "symlink") assert.equal(await fs.readFile(path.join(root, "saved"), "utf8"), "original");
    }));
}

test("missing or incorrect HDD prevents recovery mutations", () => fixture(async ({ root, target, mount, evidence, database }) => {
    const journal = await stoppedJournal(root, target); evidence.receipt = deletionReceiptFor(journal); evidence.media = [];
    mount.state.mounted = false;
    await assert.rejects(recoverDeletion(root, journal.operationId, database));
    mount.state.mounted = true; mount.state.wrongDevice = true;
    await assert.rejects(recoverDeletion(root, journal.operationId, database));
    assert.equal(await fs.readFile(target, "utf8"), "original");
    assert.ok(await fs.lstat(journal.lockDirectory));
}));

test("legacy journals never authorize deletion of an unrecorded thumbnail", () => fixture(async ({ root, target, thumbnail, evidence, database }) => {
    const journal = await stoppedJournal(root, target); delete journal.thumbnail;
    await fs.writeFile(path.join(root, ".deletion-operations", `${journal.operationId}.json`), JSON.stringify(journal));
    evidence.receipt = deletionReceiptFor(journal); evidence.media = [];
    await assert.rejects(recoverDeletion(root, journal.operationId, database), /Unknown deletion cleanup identity/);
    assert.equal(await fs.readFile(target, "utf8"), "original");
    assert.equal(await fs.readFile(thumbnail, "utf8"), "cache");
}));

test("recovery excludes replacement and concurrent recovery", () => fixture(async ({ root, target, evidence, database }) => {
    const journal = await stoppedJournal(root, target); evidence.receipt = deletionReceiptFor(journal); evidence.media = [];
    let resume!: () => void, entered!: () => void;
    const ready = new Promise<void>(r => { entered = r; }), pause = new Promise<void>(r => { resume = r; });
    const delayed: DeletionRecoveryDatabase = async (...args) => { entered(); await pause; return database(...args); };
    const first = recoverDeletion(root, journal.operationId, delayed); await ready;
    try {
        await assert.rejects(recoverDeletion(root, journal.operationId, database), DestinationBusyError);
        await assert.rejects(replaceMediaAtDestination({ root, destination: target, stagedPath: path.join(root, "incoming"), mediaId: 1,
            readReceipt: async () => undefined, revalidateMetadata: async () => { assert.fail("Destination must be excluded"); }, updateMetadata: async () => {},
        }), DestinationBusyError);
    } finally { resume(); await first; }
}));

test("journal write failure during recovery retains ownership for retry", () => fixture(async ({ root, target, evidence, database }) => {
    const journal = await stoppedJournal(root, target); evidence.receipt = deletionReceiptFor(journal); evidence.media = [];
    const rename = fs.rename.bind(fs);
    const failure = mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
        if (String(args[1]).includes(".deletion-operations")) throw new Error("journal fsync failed");
        return rename(...args);
    });
    try { await assert.rejects(recoverDeletion(root, journal.operationId, database), /journal fsync failed/); }
    finally { failure.mock.restore(); }
    assert.equal(await fs.readFile(target, "utf8"), "original");
    assert.equal(await recoverDeletion(root, journal.operationId, database), "COMMITTED");
}));

for (const failure of ["unlink", "complete-journal"] as const) {
    test(`${failure} failure during committed cleanup is safely repeatable`, () => fixture(async ({ root, target, evidence, database }) => {
        const journal = await stoppedJournal(root, target); evidence.receipt = deletionReceiptFor(journal); evidence.media = [];
        const unlink = fs.unlink.bind(fs), rename = fs.rename.bind(fs);
        const interception = failure === "unlink"
            ? mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => { if (args[0] === target) throw new Error("unlink failed"); return unlink(...args); })
            : mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
                if (String(args[1]).includes(".deletion-operations") && JSON.parse(await fs.readFile(args[0], "utf8")).state === "COMPLETE") throw new Error("completion persistence failed");
                return rename(...args);
            });
        try { await assert.rejects(recoverDeletion(root, journal.operationId, database)); }
        finally { interception.mock.restore(); }
        assert.equal((await readDeletionJournal(root, journal.operationId)).state, "COMMITTED");
        assert.ok(await fs.lstat(journal.lockDirectory));
        assert.equal(await recoverDeletion(root, journal.operationId, database), "COMMITTED");
        await assert.rejects(fs.access(target));
    }));
}

test("legacy journal with no surviving thumbnail can finish cleanup", () => fixture(async ({ root, target, thumbnail, evidence, database }) => {
    const journal = await stoppedJournal(root, target); delete journal.thumbnail;
    await fs.unlink(thumbnail);
    await fs.writeFile(path.join(root, ".deletion-operations", `${journal.operationId}.json`), JSON.stringify(journal));
    evidence.receipt = deletionReceiptFor(journal); evidence.media = [];
    assert.equal(await recoverDeletion(root, journal.operationId, database), "COMMITTED");
}));

for (const corruption of ["lock-token", "lock-path", "target-path", "journal-symlink"] as const) {
    test(`${corruption} cannot redirect deletion recovery`, () => fixture(async ({ root, target, evidence, database }) => {
        const journal = await stoppedJournal(root, target); evidence.receipt = deletionReceiptFor(journal); evidence.media = [];
        const location = path.join(root, ".deletion-operations", `${journal.operationId}.json`);
        if (corruption === "lock-token") journal.lockToken = "00000000-0000-0000-0000-000000000000";
        if (corruption === "lock-path") journal.lockDirectory = path.join(root, ".destination-locks", "foreign");
        if (corruption === "target-path") journal.target = path.join(root, ".incoming", "unknown");
        if (corruption === "journal-symlink") { await fs.rename(location, `${location}.saved`); await fs.symlink(`${location}.saved`, location); }
        else await fs.writeFile(location, JSON.stringify(journal));
        await assert.rejects(recoverDeletion(root, journal.operationId, database));
        assert.equal(await fs.readFile(target, "utf8"), "original");
        await assert.rejects(acquireDestinationLock(root, target), DestinationBusyError);
    }));
}

test("reused destination owned by another operation cannot be unlocked by an old terminal journal", () => fixture(async ({ root, target, evidence, database }) => {
    const journal = await stoppedJournal(root, target); evidence.receipt = deletionReceiptFor(journal); evidence.media = [];
    await recoverDeletion(root, journal.operationId, database);
    await fs.writeFile(target, "new generation");
    const newLock = await acquireDestinationLock(root, target);
    try {
        await assert.rejects(recoverDeletion(root, journal.operationId, database), /does not own/);
        await newLock.assertOwned();
        assert.equal(await fs.readFile(target, "utf8"), "new generation");
    } finally { await newLock.release(); }
}));
