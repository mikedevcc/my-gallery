import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { mock, test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { acquireDestinationLock, DestinationBusyError } from "./destination-lock";
import { prepareReplacementJournal, readReplacementJournal, receiptFor } from "./replacement-recovery";
import { publishReplacement, reconcileReplacement, recoverReplacement, type RecoveryDatabase } from "./replacement-files";
import { replaceMediaAtDestination } from "./media-mutations";
import { processIdentity, processHasStopped } from "./process-identity";
import { getOrCreateThumbnail } from "./media-thumbnail";
import { mockStorageMount, writeTestStorageMarker } from "./testing/storage-fixture";

async function fixture(action: (root: string, target: string, incoming: string, database: RecoveryDatabase) => Promise<void>) {
    const root = await fs.mkdtemp(path.join(tmpdir(), "gallery-h4c-test-"));
    await writeTestStorageMarker(root);
    const mount = await mockStorageMount(root);
    const target = path.join(root, "original.jpg"), incoming = path.join(root, "incoming.jpg");
    await fs.writeFile(target, "original"); await fs.writeFile(incoming, "incoming");
    const database: RecoveryDatabase = async (_id, _media, action) => {
        let receipt;
        try { receipt = JSON.parse(await fs.readFile(path.join(root, "receipt.json"), "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        return action({ receipt, mediaPath: target });
    };
    try { await action(root, target, incoming, database); }
    finally { mount.restore(); await fs.rm(root, { recursive: true, force: true }); }
}
async function journalId(root: string) {
    return (await fs.readdir(path.join(root, ".replacement-operations"))).find(name => name.endsWith(".json"))!.slice(0, -5);
}
async function worker(root: string, boundary: string, mode = "replace", id = "") {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/testing/replacement-worker.ts", root, boundary, mode, id], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    const lines = createInterface({ input: child.stdout });
    const ready = new Promise<void>((resolve, reject) => {
        lines.on("line", line => { if (line === "BOUNDARY") resolve(); });
        child.once("exit", () => reject(new Error(`Worker exited before boundary: ${stderr}`)));
    });
    try { await Promise.race([ready, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Worker timeout")), 10000).unref())]); }
    catch (error) { child.kill("SIGKILL"); throw error; }
    return async () => { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; lines.close(); };
}

test("publication rename always has an existing original target and a preserved backup", () => fixture(async (root, target, incoming) => {
    const lock = await acquireDestinationLock(root, target);
    const journal = await prepareReplacementJournal(root, 1, incoming, lock);
    const rename = fs.rename.bind(fs);
    const intercepted = mock.method(fs, "rename", async (source: Parameters<typeof fs.rename>[0], destination: Parameters<typeof fs.rename>[1]) => {
        if (source === journal.publicationPath) {
            assert.equal(await fs.readFile(target, "utf8"), "original");
            assert.equal(await fs.readFile(journal.backupPath, "utf8"), "original");
        }
        return rename(source, destination);
    });
    try {
        await publishReplacement(root, journal, lock);
        assert.equal(await fs.readFile(target, "utf8"), "incoming");
        await reconcileReplacement(root, journal, lock, { mediaPath: target });
        assert.equal(await fs.readFile(target, "utf8"), "original");
        await lock.release();
    } finally { intercepted.mock.restore(); }
}));

for (const boundary of ["prepared", "backup", "published", "pending", "acknowledgement", "committed", "cleanup", "complete"]) {
    test(`SIGKILL/restart at ${boundary}: recovery matches database outcome and repeats safely`, () => fixture(async (root, target, _incoming, database) => {
        await fs.mkdir(path.join(root, ".thumbnails"));
        await fs.writeFile(path.join(root, ".thumbnails", "1.webp"), "old cache");
        const stop = await worker(root, boundary);
        await stop();
        const id = await journalId(root);
        const committed = ["acknowledgement", "committed", "cleanup", "complete"].includes(boundary);
        assert.equal(await recoverReplacement(root, id, database), committed ? "COMMITTED" : "ROLLED_BACK");
        assert.equal(await fs.readFile(target, "utf8"), committed ? "incoming" : "original");
        assert.equal((await readReplacementJournal(root, id)).state, committed ? "COMPLETE" : "ROLLED_BACK");
        assert.equal(await recoverReplacement(root, id, database), "ALREADY_COMPLETE");
        if (committed) await assert.rejects(fs.access(path.join(root, ".thumbnails", "1.webp")));
        else assert.equal(await fs.readFile(path.join(root, ".thumbnails", "1.webp"), "utf8"), "old cache");
        const lock = await acquireDestinationLock(root, target); await lock.release();
    }));
}

test("recovery itself can die after atomic restoration and restart idempotently", () => fixture(async (root, target, _incoming, database) => {
    await (await worker(root, "published"))();
    const id = await journalId(root);
    await (await worker(root, "restored", "recover", id))();
    assert.equal(await fs.readFile(target, "utf8"), "original");
    assert.equal(await recoverReplacement(root, id, database), "ROLLED_BACK");
    assert.equal(await recoverReplacement(root, id, database), "ALREADY_COMPLETE");
}));

test("live owners, in-flight database operations and changed evidence remain locked", () => fixture(async (root, target, incoming, database) => {
    const lock = await acquireDestinationLock(root, target);
    const journal = await prepareReplacementJournal(root, 1, incoming, lock);
    await assert.rejects(recoverReplacement(root, journal.operationId, database), /still running/);
    await reconcileReplacement(root, journal, lock, { mediaPath: target }); await lock.release();
    // A different operation left by a dead process.
    await (await worker(root, "published"))();
    const ids = (await fs.readdir(path.join(root, ".replacement-operations"))).filter(name => name.endsWith(".json"));
    const id = ids.map(name => name.slice(0, -5)).find(id => id !== journal.operationId)!;
    const pending = await readReplacementJournal(root, id);
    await assert.rejects(recoverReplacement(root, id, async () => { throw new Error("database operation still running"); }), /still running/);
    assert.equal(await fs.readFile(target, "utf8"), "incoming");
    await fs.writeFile(pending.backupPath, "tampered");
    await assert.rejects(recoverReplacement(root, id, database), /evidence changed/);
    await assert.rejects(acquireDestinationLock(root, target), DestinationBusyError);
}));

for (const failure of ["backup", "publication", "database", "acknowledgement", "restoration", "cleanup"]) {
    test(`failure during ${failure} preserves the correct generation or retains its backup`, () => fixture(async (root, target, incoming, database) => {
        const originalRename = fs.rename.bind(fs), originalUnlink = fs.unlink.bind(fs);
        const handles: { mock: { restore(): void } }[] = [];
        if (failure === "backup") handles.push(mock.method(fs, "link", async () => { throw new Error("backup failed"); }));
        if (["publication", "restoration"].includes(failure)) handles.push(mock.method(fs, "rename", async (source: Parameters<typeof fs.rename>[0], dest: Parameters<typeof fs.rename>[1]) => {
            if ((failure === "publication" && String(source).includes(".publish-")) || (failure === "restoration" && String(source).includes(".backup-"))) throw new Error(`${failure} failed`);
            return originalRename(source, dest);
        }));
        if (failure === "cleanup") handles.push(mock.method(fs, "unlink", async (file: Parameters<typeof fs.unlink>[0]) => {
            if (file === incoming) throw new Error("cleanup failed"); return originalUnlink(file);
        }));
        const operation = () => replaceMediaAtDestination({ root, destination: target, stagedPath: incoming, mediaId: 1,
            revalidateMetadata: async () => {}, readReceipt: async () => undefined, withRecoveryDatabase: database,
            updateMetadata: async receipt => {
                if (["database", "restoration"].includes(failure)) throw new Error("DB rolled back");
                await fs.writeFile(path.join(root, "receipt.json"), JSON.stringify(receipt));
                if (failure === "acknowledgement") throw new Error("COMMIT response lost");
            },
        });
        try {
            if (failure === "acknowledgement") await operation(); else await assert.rejects(operation());
            const expected = ["acknowledgement", "cleanup", "restoration"].includes(failure) ? "incoming" : "original";
            assert.equal(await fs.readFile(target, "utf8"), expected);
            if (["restoration", "cleanup"].includes(failure)) {
                const journal = await readReplacementJournal(root, await journalId(root));
                assert.equal(await fs.readFile(journal.backupPath, "utf8"), "original");
                await assert.rejects(acquireDestinationLock(root, target), DestinationBusyError);
            }
        } finally { for (const handle of handles) handle.mock.restore(); }
    }));
}

test("a conflicting receipt never authorizes cleanup or rollback", () => fixture(async (root, target, incoming) => {
    const lock = await acquireDestinationLock(root, target);
    const journal = await prepareReplacementJournal(root, 1, incoming, lock);
    await publishReplacement(root, journal, lock);
    await assert.rejects(reconcileReplacement(root, journal, lock, { mediaPath: target, receipt: { ...receiptFor(journal), incomingSha256: "a".repeat(64) } }), /Conflicting/);
    assert.equal(await fs.readFile(journal.backupPath, "utf8"), "original");
}));


test("incoming hard-link aliases are rejected before a journal or destructive cleanup", () => fixture(async (root, target, incoming) => {
    await fs.unlink(incoming); await fs.link(target, incoming);
    await assert.rejects(replaceMediaAtDestination({ root, destination: target, stagedPath: incoming, mediaId: 1,
        readReceipt: async () => undefined, revalidateMetadata: async () => {}, updateMetadata: async () => {},
    }), /aliases the original/);
    assert.equal(await fs.readFile(target, "utf8"), "original");
    const lock = await acquireDestinationLock(root, target); await lock.release();
}));


test("thumbnail generation participates in destination exclusion", () => fixture(async (root, target) => {
    await fs.mkdir(path.join(root, ".thumbnails"));
    const cached = path.join(root, ".thumbnails", "1.webp");
    await fs.writeFile(cached, "cached fixture");
    const lock = await acquireDestinationLock(root, target);
    await assert.rejects(getOrCreateThumbnail(1, target, "IMAGE"), DestinationBusyError);
    await lock.release();
    assert.equal(await getOrCreateThumbnail(1, target, "IMAGE"), cached);
}));


test("same-process recoveries cannot overlap even if a database lease is lost", () => fixture(async (root, target, incoming) => {
    const lock = await acquireDestinationLock(root, target);
    const journal = await prepareReplacementJournal(root, 1, incoming, lock);
    let enter!: () => void, finish!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const first = recoverReplacement(root, journal.operationId, async (_id, _media, action) => {
        enter(); await finished; return action({ mediaPath: target });
    });
    const firstRejected = assert.rejects(first, /still running/);
    await entered;
    await assert.rejects(recoverReplacement(root, journal.operationId, async () => { throw new Error("Should not acquire DB lease"); }), /already running/);
    finish(); await firstRejected;
    await reconcileReplacement(root, journal, lock, { mediaPath: target }); await lock.release();
}));


test("owner death proof handles PID reuse and rejects unverifiable cross-user visibility", async () => {
    const owner = await processIdentity();
    assert.equal(await processHasStopped(owner), false);
    assert.equal(await processHasStopped({ ...owner, startTime: "0" }), true);
    await assert.rejects(processHasStopped({ ...owner, uid: owner.uid + 1 }), /same Unix user/);
});
