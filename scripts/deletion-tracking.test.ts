import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { mock, test } from "node:test";
import { deleteMediaAtDestination } from "./media-mutations";
import { acquireDestinationLock, DestinationBusyError, DestinationRecoveryError } from "./destination-lock";
import type { DeletionJournal, DeletionReceipt } from "./deletion-tracking";
import { discover, validateSql } from "./migrations/core";
import { mockStorageMount, writeTestStorageMarker } from "./testing/storage-fixture";

async function fixture(action: (root: string, target: string) => Promise<void>) {
    const root = await fs.mkdtemp(path.join(tmpdir(), "gallery-deletion-test-"));
    await writeTestStorageMarker(root);
    const mount = await mockStorageMount(root);
    const target = path.join(root, "original.jpg");
    await fs.writeFile(target, "original bytes");
    try { await action(root, target); }
    finally { mount.restore(); await fs.rm(root, { recursive: true, force: true }); }
}
async function journal(root: string): Promise<DeletionJournal> {
    const directory = path.join(root, ".deletion-operations");
    const names = (await fs.readdir(directory)).filter(name => name.endsWith(".json"));
    assert.equal(names.length, 1);
    return JSON.parse(await fs.readFile(path.join(directory, names[0]), "utf8"));
}

test("deletion persists identity before DB mutation, then records completion and releases destination", () => fixture(async (root, target) => {
    let receipt: DeletionReceipt | undefined;
    const result = await deleteMediaAtDestination({ mediaId: 1, root, destination: target,
        revalidateMetadata: async () => true,
        deleteMetadata: async (guard, evidence) => {
            await guard(); receipt = evidence;
            assert.equal((await journal(root)).state, "COMMIT_PENDING");
            assert.equal(await fs.readFile(target, "utf8"), "original bytes");
            assert.equal(evidence.original?.size, "14");
            await assert.rejects(acquireDestinationLock(root, target), DestinationBusyError);
            return true;
        }, afterDelete: async () => { await assert.rejects(fs.access(target)); },
    });
    assert.equal(result, true);
    const record = await journal(root);
    assert.equal(record.state, "COMPLETE");
    assert.equal(record.operationId, receipt?.operationId);
    assert.equal(record.target, target);
    assert.ok(record.lockToken && record.filesystemUuid && record.installationId);
    const lock = await acquireDestinationLock(root, target); await lock.release();
}));

for (const committed of [false, true]) {
    test(`${committed ? "lost commit acknowledgement" : "rolled back transaction"} preserves original, journal and lock`, () => fixture(async (root, target) => {
        let receipt: DeletionReceipt | undefined;
        await assert.rejects(deleteMediaAtDestination({ mediaId: 1, root, destination: target,
            revalidateMetadata: async () => true,
            deleteMetadata: async (guard, evidence) => {
                await guard();
                if (committed) receipt = evidence;
                throw new Error(committed ? "COMMIT acknowledgement lost" : "transaction rolled back");
            }, afterDelete: async () => { assert.fail("Cleanup before acknowledged commit"); },
        }), DestinationRecoveryError);
        const record = await journal(root);
        assert.equal(record.state, "COMMIT_UNKNOWN");
        assert.equal(Boolean(receipt), committed);
        assert.equal(await fs.readFile(target, "utf8"), "original bytes");
        await assert.rejects(acquireDestinationLock(root, target), DestinationBusyError);
    }));
}

test("failed journal persistence prevents database mutation and retains lock", () => fixture(async (root, target) => {
    const rename = fs.rename.bind(fs);
    const failure = mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
        if (String(args[1]).includes(".deletion-operations")) throw new Error("journal persistence failed");
        return rename(...args);
    });
    try {
        await assert.rejects(deleteMediaAtDestination({ mediaId: 1, root, destination: target,
            revalidateMetadata: async () => true,
            deleteMetadata: async () => { assert.fail("DB must not run"); }, afterDelete: async () => {},
        }), /journal persistence failed/);
        assert.equal(await fs.readFile(target, "utf8"), "original bytes");
        await assert.rejects(acquireDestinationLock(root, target), DestinationBusyError);
    } finally { failure.mock.restore(); }
}));

test("verified missing original remains deletable and records explicit absence", () => fixture(async (root, target) => {
    await fs.unlink(target);
    await deleteMediaAtDestination({ mediaId: 1, root, destination: target, revalidateMetadata: async () => true,
        deleteMetadata: async (guard, evidence) => { await guard(); assert.equal(evidence.original, null); return true; },
        afterDelete: async () => {},
    });
    assert.equal((await journal(root)).original, null);
    assert.equal((await journal(root)).state, "COMPLETE");
}));

test("post-commit cleanup failure retains COMMITTED journal and lock", () => fixture(async (root, target) => {
    await assert.rejects(deleteMediaAtDestination({ mediaId: 1, root, destination: target, revalidateMetadata: async () => true,
        deleteMetadata: async guard => { await guard(); return true; },
        afterDelete: async () => { throw new Error("thumbnail cleanup failed"); },
    }), DestinationRecoveryError);
    assert.equal((await journal(root)).state, "COMMITTED");
    await assert.rejects(fs.access(target));
    await assert.rejects(acquireDestinationLock(root, target), DestinationBusyError);
}));


test("0003 is sequential, additive and accepted by the offline migration policy", async () => {
    const directory = new URL("../db/migrations/", import.meta.url);
    const migrations = await discover(directory.pathname);
    assert.equal(migrations[2].filename, "0003_media_deletion_receipts.sql");
    const sql = await fs.readFile(new URL("0003_media_deletion_receipts.sql", directory), "utf8");
    validateSql(sql);
    assert.match(sql, /operation_id uuid PRIMARY KEY/);
    assert.match(sql, /original_identity jsonb NOT NULL/);
    assert.match(sql, /committed_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP/);
    assert.doesNotMatch(sql, /REFERENCES|ALTER TABLE|DELETE FROM|DROP TABLE/);
});

test("unexpected original generation after commit is preserved and remains locked", () => fixture(async (root, target) => {
    await assert.rejects(deleteMediaAtDestination({ mediaId: 1, root, destination: target, revalidateMetadata: async () => true,
        deleteMetadata: async () => {
            const other = path.join(root, "other.jpg");
            await fs.writeFile(other, "unrelated generation");
            await fs.rename(other, target);
            return true;
        }, afterDelete: async () => { assert.fail("Must not clean unknown files"); },
    }), DestinationRecoveryError);
    assert.equal((await journal(root)).state, "COMMITTED");
    assert.equal(await fs.readFile(target, "utf8"), "unrelated generation");
    await assert.rejects(acquireDestinationLock(root, target), DestinationBusyError);
}));
