import assert from "node:assert/strict";
import { mock, test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Pool, type PoolClient } from "pg";
import { insertImportedMedia } from "./media-database";
import { createInterface } from "node:readline";
import { finalizeStagedMedia } from "./media-storage";
import { acquireDestinationLock, DestinationBusyError, DestinationRecoveryError } from "./destination-lock";
import { mockStorageMount, writeTestStorageMarker } from "./testing/storage-fixture";

process.env.DATABASE_URL = "postgresql://offline:unused@database.example.invalid:5432/gallery";

async function fixture(work: (root: string, staged: string, destination: string) => Promise<void>) {
    const root = await fs.mkdtemp(path.join(tmpdir(), "gallery-import-publication-"));
    await writeTestStorageMarker(root);
    const mount = await mockStorageMount(root);
    const staged = path.join(root, ".incoming", "12345678-1234-4234-8234-123456789abc", "photo.jpg");
    const destination = path.join(root, "2026", "City", "photo.jpg");
    await fs.mkdir(path.dirname(staged), { recursive: true });
    await fs.writeFile(staged, "original fixture bytes");
    try { await work(root, staged, destination); }
    finally { mount.restore(); await fs.rm(root, { recursive: true, force: true }); }
}

// Exercise real fsyncs on temporary files; inject failures only at a chosen path.
function watchSync(events: string[], fail?: (target: string) => boolean) {
    const open = fs.open.bind(fs);
    const handles: ReturnType<typeof mock.method>[] = [];
    const interception = mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        const target = String(args[0]);
        const sync = handle.sync.bind(handle);
        handles.push(mock.method(handle, "sync", async () => {
            events.push(`sync:${target}`);
            if (fail?.(target)) throw new Error("injected fsync failure");
            await sync();
        }));
        return handle;
    });
    return () => { interception.mock.restore(); for (const h of handles) h.mock.restore(); };
}

async function retained(root: string, destination: string) {
    await assert.rejects(acquireDestinationLock(root, destination), DestinationBusyError);
    assert.equal(await fs.readFile(destination, "utf8"), "original fixture bytes");
}

test("inode and all publication parents are synced before metadata commit; cleanup sync precedes lock release", () => fixture(async (root, staged, destination) => {
    const events: string[] = [];
    const restore = watchSync(events);
    try {
        await finalizeStagedMedia(staged, destination, async () => {
            events.push("COMMIT");
            const required = [destination, path.dirname(destination), path.dirname(path.dirname(destination)), root, path.dirname(staged), path.dirname(path.dirname(staged))];
            for (const target of required) assert.ok(events.includes(`sync:${target}`), `missing precommit sync: ${target}`);
            const first = events.indexOf(`sync:${destination}`);
            assert.ok(first < events.indexOf(`sync:${path.dirname(destination)}`));
            assert.ok(events.indexOf(`sync:${path.dirname(destination)}`) < events.indexOf(`sync:${path.dirname(path.dirname(destination))}`));
            assert.equal((await fs.stat(staged)).ino, (await fs.stat(destination)).ino);
            await assert.rejects(acquireDestinationLock(root, destination), DestinationBusyError);
        }, root);
        assert.ok(events.lastIndexOf(`sync:${path.dirname(staged)}`) > events.indexOf("COMMIT"));
        await assert.rejects(fs.stat(staged), { code: "ENOENT" });
        const lock = await acquireDestinationLock(root, destination); await lock.release();
    } finally { restore(); }
}));

for (const point of ["inode", "parent", "ancestor", "root", "staging"] as const) test(`precommit ${point} fsync failure prevents metadata and retains evidence`, () => fixture(async (root, staged, destination) => {
    const target = point === "inode" ? destination : point === "parent" ? path.dirname(destination) : point === "ancestor" ? path.dirname(path.dirname(destination)) : point === "root" ? root : path.dirname(staged);
    const restore = watchSync([], current => current === target);
    let commits = 0;
    try {
        await assert.rejects(finalizeStagedMedia(staged, destination, async () => { commits++; }, root), DestinationRecoveryError);
        assert.equal(commits, 0);
        assert.equal(await fs.readFile(staged, "utf8"), "original fixture bytes");
        await retained(root, destination);
    } finally { restore(); }
}));

for (const outcome of ["rollback", "lost commit acknowledgment"]) test(`${outcome} never removes published original or permits replay`, () => fixture(async (root, staged, destination) => {
    let commits = 0;
    await assert.rejects(finalizeStagedMedia(staged, destination, async () => { commits++; throw new Error(outcome); }, root), DestinationRecoveryError);
    await retained(root, destination);
    assert.equal(await fs.readFile(staged, "utf8"), "original fixture bytes");
    await assert.rejects(finalizeStagedMedia(staged, destination, async () => { commits++; }, root), DestinationBusyError);
    assert.equal(commits, 1);
    await assert.rejects(fs.stat(destination.replace("photo.jpg", "photo (1).jpg")), { code: "ENOENT" });
}));

test("postcommit staging unlink failure retains both names and the lock", () => fixture(async (root, staged, destination) => {
    const unlink = fs.unlink.bind(fs);
    const interception = mock.method(fs, "unlink", async (target: Parameters<typeof fs.unlink>[0]) => {
        if (String(target) === staged) throw new Error("injected staging cleanup failure");
        await unlink(target);
    });
    let committed = false;
    try {
        await assert.rejects(finalizeStagedMedia(staged, destination, async () => { committed = true; }, root), DestinationRecoveryError);
        assert.ok(committed); await retained(root, destination);
        assert.equal(await fs.readFile(staged, "utf8"), "original fixture bytes");
    } finally { interception.mock.restore(); }
}));

test("postcommit cleanup fsync failure retains original and lock even after staging is absent", () => fixture(async (root, staged, destination) => {
    let committed = false;
    const restore = watchSync([], current => committed && current === path.dirname(staged));
    try {
        await assert.rejects(finalizeStagedMedia(staged, destination, async () => { committed = true; }, root), DestinationRecoveryError);
        await retained(root, destination);
        await assert.rejects(fs.stat(staged), { code: "ENOENT" });
        await assert.rejects(finalizeStagedMedia(staged, destination, async () => assert.fail("must not replay"), root), DestinationBusyError);
    } finally { restore(); }
}));

test("successful collision retry syncs the chosen alternate and preserves existing original", () => fixture(async (root, staged, destination) => {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, "preexisting");
    const alternate = destination.replace("photo.jpg", "photo (1).jpg");
    const events: string[] = [], restore = watchSync(events);
    try {
        assert.equal(await finalizeStagedMedia(staged, destination, async selected => {
            assert.equal(selected, alternate); assert.ok(events.includes(`sync:${alternate}`));
        }, root), alternate);
        assert.equal(await fs.readFile(destination, "utf8"), "preexisting");
    } finally { restore(); }
}));

for (const boundary of ["after-link", "before-metadata", "after-metadata", "after-staging-unlink"]) test(`worker termination ${boundary} preserves publication and prevents automatic retry`, () => fixture(async (root, staged, destination) => {
    const worker = path.resolve("scripts/testing/import-publication-worker.ts");
    const child = spawn(process.execPath, ["--import", "tsx", worker, root, staged, destination, boundary], { stdio: ["ignore", "pipe", "pipe"] });
    let errors = "";
    child.stderr.on("data", chunk => { errors += chunk; });
    const exit = once(child, "exit");
    const lines = createInterface({ input: child.stdout });
    try {
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`worker timeout: ${errors}`)), 15000);
            lines.on("line", line => { if (line === "BOUNDARY") { clearTimeout(timer); resolve(); } });
            child.once("exit", () => { clearTimeout(timer); reject(new Error(`worker exited: ${errors}`)); });
            child.once("error", error => { clearTimeout(timer); reject(error); });
        });
        child.kill("SIGKILL"); await exit;
        await retained(root, destination);
        if (boundary === "after-staging-unlink") await assert.rejects(fs.stat(staged), { code: "ENOENT" });
        else assert.equal(await fs.readFile(staged, "utf8"), "original fixture bytes");
        await assert.rejects(finalizeStagedMedia(staged, destination, async () => assert.fail("must not replay"), root), DestinationBusyError);
        assert.equal(await fs.readFile(path.join(root, "metadata-confirmed"), "utf8").then(() => true, () => false), ["after-metadata", "after-staging-unlink"].includes(boundary));
    } finally {
        lines.close();
        if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exit; }
    }
}));

test("real insertImportedMedia transaction reaches COMMIT only after filesystem barriers", () => fixture(async (root, staged, destination) => {
    const events: string[] = [];
    const restore = watchSync(events);
    let releases = 0, checkouts = 0;
    const connect = mock.method(Pool.prototype, "connect", async () => {
        checkouts++;
        return {
            query: async (text: string) => {
                const sql = text.replace(/\s+/g, " ").trim();
                events.push(sql);
                if (sql === "BEGIN" || sql === "COMMIT") {
                    for (const target of [destination, path.dirname(destination), path.dirname(path.dirname(destination)), root]) {
                        assert.ok(events.includes(`sync:${target}`), `${sql} before durable publication`);
                    }
                }
                if (sql.startsWith("SELECT media_id FROM media WHERE path")) return { rows: [], rowCount: 0 };
                return { rows: [{ media_id: 42 }], rowCount: 1 };
            }, release: () => { releases++; },
        } as unknown as PoolClient;
    });
    try {
        await finalizeStagedMedia(staged, destination, async finalPath => {
            assert.equal(await insertImportedMedia({ file: { fileName: "photo.jpg", fileType: "IMAGE", extension: ".jpg", fileSize: 22, absolutePath: finalPath }, media: {}, image: {} }), 42);
        }, root);
        assert.equal(events.filter(e => e === "COMMIT").length, 1);
        assert.equal(releases, checkouts);
    } finally { connect.mock.restore(); restore(); }
}));
