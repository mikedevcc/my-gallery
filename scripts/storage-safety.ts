import { isReservedStorageName } from "./media-paths";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

export class StorageUnavailableError extends Error {}
export const storageMarkerName = ".mygallery-storage.json";

// Isolated read-only OS probes, mocked by tests. Production always reads the
// current Linux mount table and the administrator-provisioned UUID device link.
export const storageSystem = {
    mounts: () => fs.readFile("/proc/self/mountinfo", "utf8"),
    device: async (uuid: string) => {
        const stat = await fs.stat(`/dev/disk/by-uuid/${uuid}`, { bigint: true });
        return { device: stat.rdev, block: stat.isBlockDevice() };
    },
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function getMediaStorageRoot(): string {
    const root = process.env.MEDIA_STORAGE_ROOT;
    if (!root || /[\u0000-\u001f\u007f]/.test(root) || !path.isAbsolute(root) || path.resolve(root) === path.parse(root).root) {
        throw new StorageUnavailableError("MEDIA_STORAGE_ROOT must be an explicit absolute media directory, not the filesystem root");
    }
    return path.resolve(root);
}

export function storageConfiguration() {
    const root = getMediaStorageRoot();
    const uuid = process.env.MEDIA_STORAGE_UUID;
    const installationId = process.env.MEDIA_STORAGE_ID;
    if (!uuid || !uuidPattern.test(uuid) || !installationId || !uuidPattern.test(installationId)) {
        throw new StorageUnavailableError("MEDIA_STORAGE_UUID and MEDIA_STORAGE_ID must be explicitly configured UUIDs");
    }
    return { root, uuid, installationId };
}

type Mount = { id: string; target: string; filesystem: string; readOnly: boolean };
function mounts(text: string): Mount[] {
    return text.trim().split("\n").filter(Boolean).map(line => {
        const [left, right] = line.split(" - ");
        if (!right) throw new Error("Invalid Linux mount table");
        const fields = left.split(" ");
        const fsFields = right.split(" ");
        return { id: fields[0], target: fields[4].replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8))), filesystem: fsFields[0], readOnly: fields[5].split(",").includes("ro") || fsFields[2].split(",").includes("ro") };
    });
}
function inside(root: string, target: string): boolean {
    const relative = path.relative(root, target);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function coveringMount(entries: Mount[], target: string): Mount | undefined {
    return entries.filter(entry => inside(entry.target, target)).sort((a, b) => b.target.length - a.target.length)[0];
}

async function inspect(expectedRoot: string) {
    const config = storageConfiguration();
    if (config.root !== path.resolve(expectedRoot)) throw new Error("Storage root differs from configured installation");
    if (await fs.realpath(config.root) !== config.root) throw new Error("Configured storage root must not contain symlinks");
    const stat = await fs.stat(config.root, { bigint: true });
    if (!stat.isDirectory()) throw new Error("Storage root is not an existing directory");
    const entries = mounts(await storageSystem.mounts());
    const mount = coveringMount(entries, config.root);
    if (!mount || mount.target === "/" || mount.readOnly || !["ext4", "xfs"].includes(mount.filesystem)) throw new Error("Expected a writable, separately mounted ext4 or XFS storage volume");
    const expected = await storageSystem.device(config.uuid);
    if (!expected.block || stat.dev !== expected.device) throw new Error("Storage device does not match MEDIA_STORAGE_UUID");
    const handle = await fs.open(path.join(config.root, storageMarkerName), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const markerStat = await handle.stat({ bigint: true });
        if (!markerStat.isFile() || markerStat.dev !== stat.dev || markerStat.size > BigInt(4096)) throw new Error("Invalid installation marker file");
        const marker = JSON.parse(await handle.readFile("utf8")) as { version?: number; installationId?: string; filesystemUuid?: string };
        if (marker.version !== 1 || marker.installationId !== config.installationId || marker.filesystemUuid !== config.uuid) throw new Error("Storage marker does not match this installation and filesystem");
    } finally { await handle.close(); }
    return { ...config, device: stat.dev, inode: stat.ino, mount, entries };
}

export type ValidatedStorage = {
    root: string;
    assertAvailable(target?: string): Promise<void>;
};

export async function validateStorage(root = getMediaStorageRoot()): Promise<ValidatedStorage> {
    try {
        const initial = await inspect(root);
        const storage: ValidatedStorage = {
            root: initial.root,
            async assertAvailable(target = initial.root) {
                try {
                    const current = await inspect(root);
                    if (current.device !== initial.device || current.inode !== initial.inode || current.mount.id !== initial.mount.id || current.uuid !== initial.uuid || current.installationId !== initial.installationId) throw new Error("Storage mount or installation changed during operation");
                    let candidate = path.resolve(target);
                    if (!inside(initial.root, candidate)) throw new Error("Media path is outside configured storage");
                    // Resolve the closest existing ancestor, rejecting symlink files
                    // and nested mounts even if they use the same block device.
                    while (true) {
                        try {
                            const stat = await fs.lstat(candidate, { bigint: true });
                            if (candidate === path.resolve(target) && stat.isSymbolicLink()) throw new Error("Media file/directory must not be a symlink");
                            const real = await fs.realpath(candidate);
                            const lexicalParts = path.relative(initial.root, path.resolve(target)).split(path.sep);
                            const realParts = path.relative(initial.root, real).split(path.sep);
                            if (real !== candidate && [...lexicalParts, ...realParts].some(isReservedStorageName)) throw new Error("Internal storage paths must not use symlink aliases");
                            if (!inside(initial.root, real) || stat.dev !== initial.device || coveringMount(current.entries, real)?.id !== initial.mount.id) throw new Error("Media path is on a different storage mount");
                            break;
                        } catch (error) {
                            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                            candidate = path.dirname(candidate);
                        }
                    }
                } catch (cause) { throw new StorageUnavailableError("Expected media storage is unavailable or changed; operation refused", { cause }); }
            },
        };
        await storage.assertAvailable();
        return storage;
    } catch (cause) {
        if (cause instanceof StorageUnavailableError) throw cause;
        throw new StorageUnavailableError("Expected media storage is unavailable; operation refused", { cause });
    }
}

export async function readStorageFile(filePath: string) {
    const storage = await validateStorage();
    await storage.assertAvailable(filePath);
    const file = await fs.readFile(filePath);
    await storage.assertAvailable(filePath);
    return file;
}

export async function createStorageDirectory(storage: ValidatedStorage, directory: string): Promise<void> {
    const target = path.resolve(directory);
    if (!inside(storage.root, target)) throw new StorageUnavailableError("Internal directory is outside media storage");
    await storage.assertAvailable(target);
    let current = storage.root;
    for (const component of path.relative(storage.root, target).split(path.sep).filter(Boolean)) {
        current = path.join(current, component);
        await storage.assertAvailable(current);
        try { await fs.mkdir(current, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        if (!(await fs.lstat(current)).isDirectory()) throw new StorageUnavailableError("Internal storage path is not a directory");
        await storage.assertAvailable(current);
    }
    // Deliberately no recursive mkdir: losing the root/parent between validation
    // and mkdir must yield ENOENT, never recreate a root on a fallback filesystem.
}
