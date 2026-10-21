import assert from "node:assert/strict";
import { mock, test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { acquireDestinationLock, DestinationBusyError, DestinationRecoveryError } from "./destination-lock";
import { replaceMediaAtDestination } from "./media-mutations";
import { inspectReplacementRecovery, prepareReplacementJournal, readReplacementJournal, receiptFor, writeReplacementJournal, type ReplacementReceipt } from "./replacement-recovery";
import { mockStorageMount, writeTestStorageMarker } from "./testing/storage-fixture";
import { discover, validateSql } from "./migrations/core";

async function fixture(run: (root: string, target: string, incoming: string) => Promise<void>) {
    const root = await fs.mkdtemp(path.join(tmpdir(), "gallery-recovery-"));
    await writeTestStorageMarker(root);
    const mount = await mockStorageMount(root);
    try {
        const target = path.join(root, "original.jpg"), incoming = path.join(root, "incoming.jpg");
        await fs.writeFile(target, "original"); await fs.writeFile(incoming, "incoming");
        await run(root, target, incoming);
    } finally { mount.restore(); await fs.rm(root, { recursive: true, force: true }); }
}
async function operationId(root: string) {
    const files = (await fs.readdir(path.join(root, ".replacement-operations"))).filter(name => name.endsWith(".json"));
    assert.equal(files.length, 1);
    return files[0].slice(0, -5);
}

test("0002 is sequential and accepted by the runner's SQL safety validator", async () => {
    const migrations = await discover(path.resolve("db/migrations"));
    assert.equal(migrations[1].filename, "0002_replacement_receipts.sql");
    validateSql(migrations[1].sql);
});

test("journal persists before publication and survives an interrupted rename; inspection is idempotent", () => fixture(async (root, target, incoming) => {
    const lock = await acquireDestinationLock(root, target);
    const journal = await prepareReplacementJournal(root, 1, incoming, lock);
    assert.deepEqual(await readReplacementJournal(root, journal.operationId), journal);
    assert.match(journal.original.sha256, /^[a-f0-9]{64}$/);
    // Simulate process death between original rename and incoming publication.
    await fs.rename(target, journal.backupPath);
    const before = await fs.readFile(path.join(root, ".replacement-operations", journal.operationId + ".json"));
    const first = await inspectReplacementRecovery(root, journal.operationId, async () => undefined);
    assert.equal(first.database, "UNKNOWN");
    assert.deepEqual(first.files, { target: "MISSING", backup: "ORIGINAL", staged: "INCOMING" });
    assert.deepEqual(await inspectReplacementRecovery(root, journal.operationId, async () => undefined), first);
    const settled = await inspectReplacementRecovery(root, journal.operationId, async () => undefined, true);
    assert.equal(settled.database, "NOT_COMMITTED");
    assert.deepEqual(await fs.readFile(path.join(root, ".replacement-operations", journal.operationId + ".json")), before);
    await assert.rejects(acquireDestinationLock(root, target), DestinationBusyError);
}));

test("lost COMMIT acknowledgement retains evidence; a matching receipt proves commit", () => fixture(async (root, target, incoming) => {
    let receipt: ReplacementReceipt | undefined;
    await assert.rejects(replaceMediaAtDestination({ root, destination: target, stagedPath: incoming, mediaId: 1,
        revalidateMetadata: async () => {}, readReceipt: async () => undefined,
        updateMetadata: async value => { receipt = value; throw new Error("COMMIT response lost"); },
    }), DestinationRecoveryError);
    const id = await operationId(root);
    const journal = await readReplacementJournal(root, id);
    assert.equal(journal.state, "COMMIT_UNKNOWN");
    assert.deepEqual(receipt, receiptFor(journal));
    const result = await inspectReplacementRecovery(root, id, async () => receipt);
    assert.equal(result.database, "COMMITTED");
    assert.deepEqual(result.files, { target: "INCOMING", backup: "ORIGINAL", staged: "INCOMING" });
    assert.equal((await inspectReplacementRecovery(root, id, async () => undefined)).database, "UNKNOWN");
    assert.equal((await inspectReplacementRecovery(root, id, async () => ({ ...receipt!, target: "/wrong" }))).database, "INCONSISTENT");
    await assert.rejects(inspectReplacementRecovery(root, id, async () => { throw new Error("DB unavailable"); }), /DB unavailable/);
    await assert.rejects(acquireDestinationLock(root, target), DestinationBusyError);
}));

test("successful publication leaves a completed durable journal and permits later ownership", () => fixture(async (root, target, incoming) => {
    let receipt: ReplacementReceipt | undefined;
    await replaceMediaAtDestination({ root, destination: target, stagedPath: incoming, mediaId: 1,
        revalidateMetadata: async () => {}, readReceipt: async () => undefined,
        updateMetadata: async (value, guard) => { await guard(); receipt = value; },
    });
    const id = await operationId(root);
    const result = await inspectReplacementRecovery(root, id, async () => receipt);
    assert.equal(result.state, "COMPLETE"); assert.equal(result.database, "COMMITTED");
    assert.deepEqual(result.files, { target: "INCOMING", backup: "MISSING", staged: "MISSING" });
    const lock = await acquireDestinationLock(root, target); await lock.release();
}));

test("failed atomic journal publication preserves the previous JSON and retains ownership", () => fixture(async (root, target, incoming) => {
    const lock = await acquireDestinationLock(root, target);
    const journal = await prepareReplacementJournal(root, 1, incoming, lock);
    const rename = mock.method(fs, "rename", async () => { throw new Error("rename failed"); });
    try {
        await assert.rejects(writeReplacementJournal(root, { ...journal, state: "COMMIT_PENDING" }, lock), /rename failed/);
        assert.deepEqual(await readReplacementJournal(root, journal.operationId), journal);
        await assert.rejects(lock.release(), DestinationRecoveryError);
    } finally { rename.mock.restore(); }
}));

test("receipt-store failure stops before original mutation", () => fixture(async (root, target, incoming) => {
    let updated = false;
    await assert.rejects(replaceMediaAtDestination({ root, destination: target, stagedPath: incoming, mediaId: 1,
        revalidateMetadata: async () => {}, readReceipt: async () => { throw new Error("0002 missing"); },
        updateMetadata: async () => { updated = true; },
    }), DestinationRecoveryError);
    assert.equal(updated, false); assert.equal(await fs.readFile(target, "utf8"), "original");
    assert.equal(await fs.readFile(incoming, "utf8"), "incoming");
}));

test("fsync failure before publication never changes originals and retains the lock", () => fixture(async (root, target, incoming) => {
    const lock = await acquireDestinationLock(root, target);
    const handle = await fs.open(target, "r");
    const prototype = Object.getPrototypeOf(handle);
    await handle.close();
    const sync = mock.method(prototype, "sync", async () => { throw new Error("fsync failed"); });
    try {
        await assert.rejects(prepareReplacementJournal(root, 1, incoming, lock), /fsync failed/);
        assert.equal(await fs.readFile(target, "utf8"), "original");
        await assert.rejects(lock.release(), DestinationRecoveryError);
    } finally { sync.mock.restore(); }
}));

test("committed receipt resolves a crash before the COMMITTED journal rename", () => fixture(async (root, target, incoming) => {
    let receipt: ReplacementReceipt | undefined;
    const originalRename = fs.rename.bind(fs);
    const rename = mock.method(fs, "rename", async (source: Parameters<typeof fs.rename>[0], destination: Parameters<typeof fs.rename>[1]) => {
        if (String(source).endsWith(".tmp")) {
            const journal = JSON.parse(await fs.readFile(source, "utf8"));
            if (journal.state === "COMMITTED") throw new Error("interrupted after DB commit");
        }
        return originalRename(source, destination);
    });
    try {
        await assert.rejects(replaceMediaAtDestination({ root, destination: target, stagedPath: incoming, mediaId: 1,
            revalidateMetadata: async () => {}, readReceipt: async () => undefined,
            updateMetadata: async value => { receipt = value; },
        }), DestinationRecoveryError);
        const id = await operationId(root);
        const result = await inspectReplacementRecovery(root, id, async () => receipt);
        assert.equal(result.state, "COMMIT_PENDING");
        assert.equal(result.database, "COMMITTED");
        assert.deepEqual(result.files, { target: "INCOMING", backup: "ORIGINAL", staged: "INCOMING" });
    } finally { rename.mock.restore(); }
}));

test("cleanup interruption keeps the committed receipt and remaining recovery evidence", () => fixture(async (root, target, incoming) => {
    let receipt: ReplacementReceipt | undefined;
    const unlink = mock.method(fs, "unlink", async () => { throw new Error("cleanup interrupted"); });
    try {
        await assert.rejects(replaceMediaAtDestination({ root, destination: target, stagedPath: incoming, mediaId: 1,
            revalidateMetadata: async () => {}, readReceipt: async () => undefined,
            updateMetadata: async value => { receipt = value; },
        }), DestinationRecoveryError);
        const result = await inspectReplacementRecovery(root, await operationId(root), async () => receipt);
        assert.equal(result.state, "COMMITTED"); assert.equal(result.database, "COMMITTED");
        assert.deepEqual(result.files, { target: "INCOMING", backup: "ORIGINAL", staged: "INCOMING" });
    } finally { unlink.mock.restore(); }
}));

test("failed unknown-outcome persistence preserves both errors and earlier durable evidence", () => fixture(async (root, target, incoming) => {
    const commitError = new Error("commit response lost");
    const journalError = new Error("journal disk failure");
    const originalRename = fs.rename.bind(fs);
    const rename = mock.method(fs, "rename", async (source: Parameters<typeof fs.rename>[0], destination: Parameters<typeof fs.rename>[1]) => {
        if (String(source).endsWith(".tmp") && JSON.parse(await fs.readFile(source, "utf8")).state === "COMMIT_UNKNOWN") throw journalError;
        return originalRename(source, destination);
    });
    try {
        await assert.rejects(replaceMediaAtDestination({ root, destination: target, stagedPath: incoming, mediaId: 1,
            revalidateMetadata: async () => {}, readReceipt: async () => undefined,
            updateMetadata: async () => { throw commitError; },
        }), (error: unknown) => {
            assert.ok(error instanceof DestinationRecoveryError);
            assert.ok(error.cause instanceof AggregateError);
            assert.deepEqual(error.cause.errors, [commitError, journalError]);
            return true;
        });
        const result = await inspectReplacementRecovery(root, await operationId(root), async () => undefined);
        assert.equal(result.state, "COMMIT_PENDING"); assert.equal(result.database, "UNKNOWN");
        assert.deepEqual(result.files, { target: "INCOMING", backup: "ORIGINAL", staged: "INCOMING" });
    } finally { rename.mock.restore(); }
}));
