import { mock } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { storageMarkerName, storageSystem } from "../storage-safety";

export const testFilesystemUuid = "12345678-1234-4234-8234-123456789abc";
export const testInstallationId = "87654321-4321-4321-8321-cba987654321";

// Tests deliberately provision their own marker; application code never does.
export async function writeTestStorageMarker(root: string) {
    await fs.writeFile(path.join(root, storageMarkerName), JSON.stringify({ version: 1, installationId: testInstallationId, filesystemUuid: testFilesystemUuid }), { flag: "wx" });
}

export async function mockStorageMount(root: string) {
    const keys = ["MEDIA_STORAGE_ROOT", "MEDIA_STORAGE_UUID", "MEDIA_STORAGE_ID", "MEDIA_STORAGE_MODE", "MEDIA_STORAGE_ASSERTION"] as const;
    const previous = keys.map(key => process.env[key]);
    process.env.MEDIA_STORAGE_MODE = "native";
    delete process.env.MEDIA_STORAGE_ASSERTION;
    process.env.MEDIA_STORAGE_ROOT = root;
    process.env.MEDIA_STORAGE_UUID = testFilesystemUuid;
    process.env.MEDIA_STORAGE_ID = testInstallationId;
    const device = (await fs.stat(root, { bigint: true })).dev;
    const state = { mounted: true, wrongDevice: false, readOnly: false, mountId: "901", extraMounts: "" };
    const mount = mock.method(storageSystem, "mounts", async () => state.mounted
        ? `${state.mountId} 1 8:1 / ${root.replace(/ /g, "\\040")} ${state.readOnly ? "ro" : "rw"} - ext4 /dev/test ${state.readOnly ? "ro" : "rw"}\n${state.extraMounts}`
        : "1 0 8:0 / / rw - ext4 /dev/system rw\n");
    const disk = mock.method(storageSystem, "device", async () => ({ device: state.wrongDevice ? device + BigInt(1) : device, block: true }));
    return {
        state,
        restore() {
            mount.mock.restore(); disk.mock.restore();
            keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
        },
    };
}
