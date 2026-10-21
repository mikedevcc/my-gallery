import assert from "node:assert/strict";
import { mock, test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { acquireDestinationLock, DestinationBusyError, DestinationRecoveryError, withDestinationLock } from "./destination-lock";
import { deleteMediaAtDestination, replaceMediaAtDestination } from "./media-mutations";
import { finalizeStagedMedia, removeStagedConflict } from "./media-storage";
import { mockStorageMount, writeTestStorageMarker } from "./testing/storage-fixture";

async function fixture(run: (root: string, destination: string) => Promise<void>) {
    const root = await fs.mkdtemp(path.join(tmpdir(), "gallery-destination-lock-"));
    await writeTestStorageMarker(root);
    const mount = await mockStorageMount(root);
    try {
        const destination = path.join(root, "original.jpg");
        await fs.writeFile(destination, "original");
        await run(root, destination);
    } finally { mount.restore(); await fs.rm(root, { recursive: true, force: true }); }
}

function gate() {
    let open!: () => void;
    const promise = new Promise<void>(resolve => { open = resolve; });
    return { promise, open };
}

async function staged(root: string, name = "incoming.jpg") {
    const file = path.join(root, name);
    await fs.writeFile(file, "incoming");
    return file;
}

test("separate conflicts replacing one original cannot overlap", () => fixture(async (root, destination) => {
    const entered = gate();
    const finish = gate();
    const firstStage = await staged(root);
    const secondStage = await staged(root, "second.jpg");
    let updates = 0;
    const first = replaceMediaAtDestination({ mediaId: 1, readReceipt: async () => undefined, root, destination, stagedPath: firstStage,
        revalidateMetadata: async () => {}, updateMetadata: async () => { updates++; entered.open(); await finish.promise; } });
    await entered.promise;
    try {
        await assert.rejects(() => replaceMediaAtDestination({ mediaId: 1, readReceipt: async () => undefined, root, destination, stagedPath: secondStage,
            revalidateMetadata: async () => {}, updateMetadata: async () => { updates++; } }), DestinationBusyError);
        assert.equal(updates, 1);
        assert.equal(await fs.readFile(secondStage, "utf8"), "incoming");
    } finally { finish.open(); await first; }
    assert.equal(await fs.readFile(destination, "utf8"), "incoming");
    const lock = await acquireDestinationLock(root, destination);
    await lock.release();
}));

test("replacement excludes deletion before its database delete", () => fixture(async (root, destination) => {
    const entered = gate(); const finish = gate();
    const first = replaceMediaAtDestination({ mediaId: 1, readReceipt: async () => undefined, root, destination, stagedPath: await staged(root),
        revalidateMetadata: async () => {}, updateMetadata: async () => { entered.open(); await finish.promise; } });
    await entered.promise;
    let deleted = false;
    try {
        await assert.rejects(() => deleteMediaAtDestination({ root, destination,
            revalidateMetadata: async () => true, deleteMetadata: async () => { deleted = true; return true; }, afterDelete: async () => {} }), DestinationBusyError);
        assert.equal(deleted, false);
    } finally { finish.open(); await first; }
}));

test("deletion excludes replacement and releases after successful cleanup", () => fixture(async (root, destination) => {
    const entered = gate(); const finish = gate();
    const deletion = deleteMediaAtDestination({ root, destination, revalidateMetadata: async () => true,
        deleteMetadata: async () => { entered.open(); await finish.promise; return true; }, afterDelete: async () => {} });
    await entered.promise;
    try {
        await assert.rejects(() => replaceMediaAtDestination({ mediaId: 1, readReceipt: async () => undefined, root, destination, stagedPath: unusedStagedPath,
            revalidateMetadata: async () => {}, updateMetadata: async () => {} }), DestinationBusyError);
    } finally { finish.open(); await deletion; }
    assert.equal(await fs.stat(destination).then(() => true, () => false), false);
    const lock = await acquireDestinationLock(root, destination); await lock.release();
}));

// Deliberately nonexistent: contention must fail before any staging-file access.
const unusedStagedPath = "/not-a-user-media-path/unused.jpg";

test("different destinations progress while one operation waits", () => fixture(async (root, destination) => {
    const entered = gate(); const finish = gate();
    const first = replaceMediaAtDestination({ mediaId: 1, readReceipt: async () => undefined, root, destination, stagedPath: await staged(root),
        revalidateMetadata: async () => {}, updateMetadata: async () => { entered.open(); await finish.promise; } });
    await entered.promise;
    try {
        const other = path.join(root, "other.jpg"); await fs.writeFile(other, "other");
        await replaceMediaAtDestination({ mediaId: 1, readReceipt: async () => undefined, root, destination: other, stagedPath: await staged(root, "other-incoming.jpg"),
            revalidateMetadata: async () => {}, updateMetadata: async () => {} });
        assert.equal(await fs.readFile(other, "utf8"), "incoming");
    } finally { finish.open(); await first; }
}));

test("ownership prevents a foreign token or released handle removing a lock", () => fixture(async (root, destination) => {
    const lock = await acquireDestinationLock(root, destination);
    const ownerPath = path.join(lock.directory, "owner.json");
    const owner = await fs.readFile(ownerPath, "utf8");
    await fs.writeFile(ownerPath, JSON.stringify({ token: "foreign" }));
    await assert.rejects(() => lock.release(), /ownership/);
    await assert.rejects(() => acquireDestinationLock(root, destination), DestinationBusyError);
    await fs.writeFile(ownerPath, owner); await lock.release();
    const next = await acquireDestinationLock(root, destination);
    await assert.rejects(() => lock.release(), /already been released/);
    await next.release();
}));

test("safe preflight failures release; unresolved writes and old locks remain blocked", () => fixture(async (root, destination) => {
    await assert.rejects(() => withDestinationLock(root, destination, async () => { throw new Error("preflight"); }), /preflight/);
    await assert.rejects(() => withDestinationLock(root, destination, async lock => {
        lock.markUnresolved(); throw new Error("uncertain write");
    }), DestinationRecoveryError);
    const dirs = await fs.readdir(path.join(root, ".destination-locks"));
    const directory = path.join(root, ".destination-locks", dirs[0]);
    await fs.utimes(directory, new Date(0), new Date(0));
    await assert.rejects(() => acquireDestinationLock(root, destination), DestinationBusyError);
}));

test("replacement database failure preserves both generations and an unresolved lock", () => fixture(async (root, destination) => {
    const incoming = await staged(root);
    await assert.rejects(() => replaceMediaAtDestination({ mediaId: 1, readReceipt: async () => undefined, root, destination, stagedPath: incoming,
        revalidateMetadata: async () => {}, updateMetadata: async () => { throw new Error("commit acknowledgement lost"); } }), DestinationRecoveryError);
    assert.equal(await fs.readFile(destination, "utf8"), "incoming");
    assert.equal(await fs.readFile(incoming, "utf8"), "incoming");
    await assert.rejects(() => acquireDestinationLock(root, destination), DestinationBusyError);
}));

test("deletion database failures retain original and lock", () => fixture(async (root, destination) => {
    await assert.rejects(() => deleteMediaAtDestination({ root, destination, revalidateMetadata: async () => true,
        deleteMetadata: async () => { throw new Error("uncertain database delete"); }, afterDelete: async () => {} }), DestinationRecoveryError);
    assert.equal(await fs.readFile(destination, "utf8"), "original");
    await assert.rejects(() => acquireDestinationLock(root, destination), DestinationBusyError);
}));

test("replacement staging-cleanup failure retains both generations and ownership", () => fixture(async (root, destination) => {
    const incoming = await staged(root);
    const unlink = fs.unlink;
    const failure = mock.method(fs, "unlink", async (file: Parameters<typeof fs.unlink>[0]) => {
        if (String(file) === incoming) throw new Error("injected staging cleanup failure");
        await unlink(file);
    });
    try {
        await assert.rejects(() => replaceMediaAtDestination({ mediaId: 1, readReceipt: async () => undefined, root, destination, stagedPath: incoming,
            revalidateMetadata: async () => {}, updateMetadata: async () => {} }), DestinationRecoveryError);
        assert.equal(await fs.readFile(destination, "utf8"), "incoming");
        const backups = (await fs.readdir(root)).filter(name => name.includes(".backup-"));
        assert.equal(backups.length, 1);
        assert.equal(await fs.readFile(path.join(root, backups[0]), "utf8"), "original");
        await assert.rejects(() => acquireDestinationLock(root, destination), DestinationBusyError);
    } finally { failure.mock.restore(); }
}));

test("destination and metadata are revalidated before mutation", () => fixture(async (root, destination) => {
    let updated = false;
    await assert.rejects(() => replaceMediaAtDestination({ mediaId: 1, readReceipt: async () => undefined, root, destination, stagedPath: unusedStagedPath,
        revalidateMetadata: async () => { await fs.writeFile(destination, "external change"); },
        updateMetadata: async () => { updated = true; } }), /Destination changed/);
    assert.equal(updated, false);
    const lock = await acquireDestinationLock(root, destination); await lock.release();
    assert.equal(await deleteMediaAtDestination({ root, destination, revalidateMetadata: async () => false,
        deleteMetadata: async () => { throw new Error("must not run"); }, afterDelete: async () => {} }), false);
}));

test("canonical parent aliases share a lock; file symlinks and outside paths are rejected", () => fixture(async (root, destination) => {
    await fs.mkdir(path.join(root, "real"));
    await fs.symlink(path.join(root, "real"), path.join(root, "alias"));
    const lock = await acquireDestinationLock(root, path.join(root, "real", "missing.jpg"));
    await assert.rejects(() => acquireDestinationLock(root, path.join(root, "alias", "missing.jpg")), DestinationBusyError);
    await lock.release();
    await fs.symlink(destination, path.join(root, "file-alias.jpg"));
    await assert.rejects(() => acquireDestinationLock(root, path.join(root, "file-alias.jpg")), /symlink/);
    await assert.rejects(() => acquireDestinationLock(root, path.join(root, "..", "outside.jpg")), /inside the storage root/);
}));

test("finalization holds lock through metadata insertion and locks alternate candidates", () => fixture(async (root, destination) => {
    const entered = gate(); const finish = gate();
    const expected = path.join(root, "original (1).jpg");
    const first = finalizeStagedMedia(await staged(root), destination, async finalPath => {
        assert.equal(finalPath, expected); entered.open(); await finish.promise;
    }, root);
    await entered.promise;
    try {
        await assert.rejects(() => acquireDestinationLock(root, expected), DestinationBusyError);
    } finally { finish.open(); assert.equal(await first, expected); }
    assert.equal(await fs.readFile(destination, "utf8"), "original");
}));

test("finalization cannot occupy a target temporarily absent during replacement", () => fixture(async (root, destination) => {
    const lock = await acquireDestinationLock(root, destination); lock.markUnresolved();
    const backup = `${destination}.backup`; await fs.rename(destination, backup);
    await assert.rejects(() => finalizeStagedMedia(unusedStagedPath, destination, undefined, root), DestinationBusyError);
    await fs.rename(backup, destination); lock.markSafe(); await lock.release();
}));

test("finalization database failure preserves staged/final files and the lock", () => fixture(async (root) => {
    const incoming = await staged(root);
    const destination = path.join(root, "new.jpg");
    await assert.rejects(() => finalizeStagedMedia(incoming, destination, async () => { throw new Error("uncertain insert"); }, root), DestinationRecoveryError);
    assert.equal(await fs.readFile(incoming, "utf8"), "incoming");
    assert.equal(await fs.readFile(destination, "utf8"), "incoming");
    await assert.rejects(() => acquireDestinationLock(root, destination), DestinationBusyError);
}));

test("SKIP cannot discard staging while its destination is locked", () => fixture(async (root, destination) => {
    const id = "12ec0585-07cb-4e3c-9d84-1ec28cb40a82";
    const directory = path.join(root, ".incoming", id);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, ".conflict.json"), JSON.stringify({ type: "FILENAME", existingPath: destination }));
    await fs.writeFile(path.join(directory, "incoming.jpg"), "incoming");
    const lock = await acquireDestinationLock(root, destination);
    await assert.rejects(() => removeStagedConflict(id, root), DestinationBusyError);
    assert.equal(await fs.readFile(path.join(directory, "incoming.jpg"), "utf8"), "incoming");
    await lock.release();
    await removeStagedConflict(id, root);
    assert.equal(await fs.stat(directory).then(() => true, () => false), false);
}));

test("another Node process excludes parent acquisition; process death never evicts its lock", { timeout: 15000 }, () => fixture(async (root, destination) => {
    const modulePath = fileURLToPath(new URL("./destination-lock.ts", import.meta.url));
    const loader = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));
    const fixturePath = fileURLToPath(new URL("./testing/storage-fixture.ts", import.meta.url));
    const worker = `const {acquireDestinationLock}=require(${JSON.stringify(modulePath)});
        const {mockStorageMount}=require(${JSON.stringify(fixturePath)});
        mockStorageMount(process.argv[1]).then(()=>acquireDestinationLock(process.argv[1],process.argv[2])).then(lock=>{
            console.log('READY'); process.stdin.resume();
            process.stdin.on('data',async()=>{await lock.release(); console.log('RELEASED'); process.stdin.pause();});
        }).catch(e=>{console.error(e);process.exitCode=1});`;
    async function start() {
        const child = spawn(process.execPath, ["--import", loader, "-e", worker, root, destination], { stdio: ["pipe", "pipe", "pipe"] });
        const lines = createInterface({ input: child.stdout });
        const ready = await Promise.race([once(lines, "line"), once(child, "exit").then(() => { throw new Error("Lock worker exited before readiness"); })]);
        assert.equal(ready[0], "READY");
        return { child, lines };
    }
    const first = await start();
    try {
        await assert.rejects(() => acquireDestinationLock(root, destination), DestinationBusyError);
        const exited = once(first.child, "exit"); first.child.stdin.write("release\n"); await exited;
    } finally { first.child.kill(); first.lines.close(); }
    const lock = await acquireDestinationLock(root, destination); await lock.release();
    const crashed = await start();
    const exited = once(crashed.child, "exit"); crashed.child.kill("SIGKILL"); await exited; crashed.lines.close();
    await assert.rejects(() => acquireDestinationLock(root, destination), DestinationBusyError);
}));
