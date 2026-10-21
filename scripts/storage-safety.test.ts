import assert from "node:assert/strict";
import { mock, test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Pool, type PoolClient } from "pg";
import { getMediaStorageRoot, readStorageFile, storageMarkerName, StorageUnavailableError, validateStorage } from "./storage-safety";
import { mockStorageMount, writeTestStorageMarker } from "./testing/storage-fixture";
import { stageMediaFile } from "./media-storage";
import { deleteMediaAtDestination } from "./media-mutations";
import { deleteMediaById } from "./media-database";
import { getOrCreateThumbnail, deleteThumbnail } from "./media-thumbnail";

async function fixture(operation: (root: string, mount: Awaited<ReturnType<typeof mockStorageMount>>) => Promise<void>) {
    const root = await fs.mkdtemp(path.join(tmpdir(), "gallery-storage-safety-"));
    await writeTestStorageMarker(root);
    const mount = await mockStorageMount(root);
    try { await operation(root, mount); }
    finally { mount.restore(); await fs.rm(root, { recursive: true, force: true }); }
}

test("missing or relative configuration is rejected without creating directories", async () => {
    const previous = process.env.MEDIA_STORAGE_ROOT;
    try {
        for (const value of [undefined, "", "relative/path", "/"]) {
            if (value === undefined) delete process.env.MEDIA_STORAGE_ROOT;
            else process.env.MEDIA_STORAGE_ROOT = value;
            assert.throws(getMediaStorageRoot, StorageUnavailableError);
            await assert.rejects(() => stageMediaFile(new File(["test"], "test.jpg")), StorageUnavailableError);
        }
    } finally { if (previous === undefined) delete process.env.MEDIA_STORAGE_ROOT; else process.env.MEDIA_STORAGE_ROOT = previous; }
});

test("missing root is never automatically recreated", () => fixture(async (root) => {
    const missing = path.join(root, "not-provisioned");
    process.env.MEDIA_STORAGE_ROOT = missing;
    await assert.rejects(() => stageMediaFile(new File(["test"], "test.jpg")), StorageUnavailableError);
    assert.equal(await fs.stat(missing).then(() => true, () => false), false);
}));

test("root disappearing between validation and mkdir is not recursively recreated", () => fixture(async (root) => {
    const detached = `${root}-detached`;
    const mkdir = fs.mkdir;
    let moved = false;
    const failure = mock.method(fs, "mkdir", async (...args: Parameters<typeof fs.mkdir>) => {
        if (!moved && String(args[0]) === path.join(root, ".incoming")) {
            await fs.rename(root, detached); moved = true;
        }
        return mkdir(...args);
    });
    try {
        await assert.rejects(() => stageMediaFile(new File(["test"], "test.jpg")));
        assert.equal(moved, true);
        assert.equal(await fs.stat(root).then(() => true, () => false), false);
    } finally {
        failure.mock.restore();
        if (moved) await fs.rename(detached, root);
    }
}));

test("unmounted HDD rejects staging and serving even when fallback directory and marker exist", () => fixture(async (root, mount) => {
    const file = path.join(root, "original.jpg"); await fs.writeFile(file, "original");
    mount.state.mounted = false;
    await assert.rejects(() => stageMediaFile(new File(["test"], "test.jpg")), StorageUnavailableError);
    await assert.rejects(() => readStorageFile(file), StorageUnavailableError);
    await assert.rejects(() => getOrCreateThumbnail(1, file, "IMAGE"), StorageUnavailableError);
    await assert.rejects(() => deleteThumbnail(1), StorageUnavailableError);
    assert.equal(await fs.stat(path.join(root, ".incoming")).then(() => true, () => false), false);
    assert.equal(await fs.stat(path.join(root, ".thumbnails")).then(() => true, () => false), false);
}));

test("wrong device, read-only volume and missing expected device configuration fail closed", () => fixture(async (_, mount) => {
    mount.state.wrongDevice = true; await assert.rejects(() => validateStorage(), StorageUnavailableError);
    mount.state.wrongDevice = false; mount.state.readOnly = true; await assert.rejects(() => validateStorage(), StorageUnavailableError);
    mount.state.readOnly = false; delete process.env.MEDIA_STORAGE_UUID;
    await assert.rejects(() => validateStorage(), StorageUnavailableError);
}));

test("missing, wrong-installation, malformed or symlink markers are never initialized", () => fixture(async (root) => {
    const marker = path.join(root, storageMarkerName);
    const content = await fs.readFile(marker, "utf8");
    await fs.unlink(marker);
    await assert.rejects(() => validateStorage(), StorageUnavailableError);
    assert.equal(await fs.stat(marker).then(() => true, () => false), false);
    await fs.writeFile(marker, content.replace('"installationId":', '"wrongId":'));
    await assert.rejects(() => validateStorage(), StorageUnavailableError);
    await fs.writeFile(marker, content.replace('"filesystemUuid":', '"wrongUuid":'));
    await assert.rejects(() => validateStorage(), StorageUnavailableError);
    await fs.writeFile(marker, "invalid JSON"); await assert.rejects(() => validateStorage(), StorageUnavailableError);
    await fs.unlink(marker); await fs.writeFile(path.join(root, "copied-marker"), content);
    await fs.symlink(path.join(root, "copied-marker"), marker);
    await assert.rejects(() => validateStorage(), StorageUnavailableError);
}));

test("validated storage permits staging on its own filesystem and internal directory creation", () => fixture(async (root) => {
    const file = await stageMediaFile(new File(["temporary upload"], "test.jpg"));
    assert.ok(file.startsWith(path.join(root, ".incoming") + path.sep));
    assert.equal((await readStorageFile(file)).toString(), "temporary upload");
}));

test("operation snapshots reject remounts and nested mounts", () => fixture(async (root, mount) => {
    const storage = await validateStorage();
    mount.state.mountId = "902";
    await assert.rejects(() => storage.assertAvailable(), StorageUnavailableError);
    mount.state.mountId = "901";
    await fs.mkdir(path.join(root, ".incoming"));
    mount.state.extraMounts = `903 901 8:1 / ${root}/.incoming rw - ext4 /dev/test rw\n`;
    await assert.rejects(() => storage.assertAvailable(path.join(root, ".incoming", "new.jpg")), StorageUnavailableError);
}));

test("deletion never invokes metadata removal while storage is unavailable", () => fixture(async (root, mount) => {
    const destination = path.join(root, "original.jpg"); await fs.writeFile(destination, "original");
    let deletions = 0;
    const options = { root, destination, revalidateMetadata: async () => true,
        deleteMetadata: async () => { deletions++; return true; }, afterDelete: async () => {} };
    mount.state.mounted = false;
    await assert.rejects(() => deleteMediaAtDestination(options), StorageUnavailableError);
    assert.equal(deletions, 0);
    mount.state.mounted = true;
    await assert.rejects(() => deleteMediaAtDestination({ ...options, revalidateMetadata: async () => { mount.state.mounted = false; return true; } }));
    assert.equal(deletions, 0);
    assert.equal(await fs.readFile(destination, "utf8"), "original");
}));

test("storage loss during DELETE rolls metadata transaction back before commit and releases client", () => fixture(async (root, mount) => {
    const destination = path.join(root, "original.jpg"); await fs.writeFile(destination, "original");
    const queries: string[] = []; let releases = 0;
    const checkout = mock.method(Pool.prototype, "connect", async () => ({
        query: async (text: string) => {
            const sql = text.trim().split(/\s+/)[0]; queries.push(sql);
            if (sql === "DELETE") mount.state.mounted = false;
            return { rows: [{ media_id: 1, path: destination }], rowCount: 1 };
        }, release: () => { releases++; },
    }) as unknown as PoolClient);
    try {
        await assert.rejects(() => deleteMediaAtDestination({ root, destination, revalidateMetadata: async () => true,
            deleteMetadata: async guard => (await deleteMediaById(1, guard)) !== undefined, afterDelete: async () => {} }));
        assert.deepEqual(queries, ["BEGIN", "DELETE", "ROLLBACK"]);
        assert.equal(releases, 1);
        assert.equal(await fs.readFile(destination, "utf8"), "original");
    } finally { checkout.mock.restore(); }
}));
