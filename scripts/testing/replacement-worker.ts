// Isolated crash-test worker only. All files live in a caller-provisioned temp fixture.
import fs from "node:fs/promises";
import { mockStorageMount } from "./storage-fixture";
import { replaceMediaAtDestination } from "../media-mutations";
import { recoverReplacement, type RecoveryDatabase } from "../replacement-files";
import path from "node:path";
import { Client, Pool, type PoolClient } from "pg";

async function main() {
const [root, boundary, mode = "replace", operationId = ""] = process.argv.slice(2);
if (!root || !path.basename(root).startsWith("gallery-h4c-test-")) throw new Error("Isolated fixture required");
await mockStorageMount(root);
const target = path.join(root, "original.jpg"), stagedPath = path.join(root, "incoming.jpg");
async function pause() {
    console.log("BOUNDARY");
    await new Promise<void>(() => { setInterval(() => {}, 1000); });
}
const link = fs.link.bind(fs), rename = fs.rename.bind(fs), unlink = fs.unlink.bind(fs);
fs.link = async (source, destination) => {
    await link(source, destination);
    if (boundary === "backup" && String(destination).includes(".backup-")) await pause();
};
fs.rename = async (source, destination) => {
    await rename(source, destination);
    if (boundary === "published" && String(source).includes(".publish-")) await pause();
    if (boundary === "restored" && String(source).includes(".backup-")) await pause();
    if (String(destination).endsWith(".json") && String(source).endsWith(".tmp")) {
        const state = JSON.parse(await fs.readFile(destination, "utf8")).state;
        if ((boundary === "prepared" && state === "PREPARED") || (boundary === "committed" && state === "COMMITTED") || (boundary === "complete" && state === "COMPLETE")) await pause();
    }
};
fs.unlink = async target => {
    await unlink(target);
    if (boundary === "cleanup" && target === stagedPath) await pause();
};
const database: RecoveryDatabase = async (_operationId, _mediaId, action) => {
    let receipt;
    try { receipt = JSON.parse(await fs.readFile(path.join(root, "receipt.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return action({ receipt, mediaPath: target });
};
let postgres: typeof import("../media-database") | undefined;
if (mode === "replace-pg") {
    const url = new URL(process.env.H4C_INTEGRATION_URL ?? "");
    if (url.hostname !== "127.0.0.1" || url.port !== "55439" || !/^\/h4c_replacement_test_[a-z0-9_]+$/.test(url.pathname) || url.search) throw new Error("Non-isolated worker database refused");
    const identitySql = "SELECT current_database() AS database,current_setting('data_directory') AS directory,current_setting('server_version_num')::int AS version";
    const verify = (row: { database: string; directory: string; version: number }) => {
        if (row.database !== url.pathname.slice(1) || row.directory !== "/tmp/mygallery-runner-integration-du1UxD/data" || Math.floor(row.version / 10000) !== 17) throw new Error("Worker database identity mismatch");
    };
    const probe = new Client({ connectionString: url.href, options: "-c default_transaction_read_only=on" });
    try { await probe.connect(); verify((await probe.query(identitySql)).rows[0]); } finally { await probe.end(); }
    const originalConnect = Pool.prototype.connect as (this: Pool) => Promise<PoolClient>;
    Pool.prototype.connect = (async function(this: Pool) {
        const client = await originalConnect.call(this), raw = client.query.bind(client);
        return { query: async (sql: string, values?: unknown[]) => {
            if (sql !== "ROLLBACK") verify((await raw(identitySql)).rows[0]);
            return raw(sql, values);
        }, release: client.release.bind(client) };
    }) as typeof Pool.prototype.connect;
    process.env.DATABASE_URL = url.href;
    postgres = await import("../media-database");
}
try {
if (mode === "recover") await recoverReplacement(root, operationId, database);
else await replaceMediaAtDestination({ root, destination: target, stagedPath,
    mediaId: mode === "replace-pg" ? Number(operationId) : 1,
    revalidateMetadata: async () => {}, readReceipt: postgres?.getReplacementReceipt ?? (async () => undefined),
    updateMetadata: async (receipt, assertStorage) => {
        if (boundary === "pending") await pause();
        if (postgres) {
            await postgres.updateImportedMedia(receipt.mediaId, {
                file: { fileName: "original.jpg", fileType: "IMAGE", fileSize: 15, absolutePath: target, extension: ".jpg" },
                media: { width: 640 }, image: { iso: 100 },
            }, undefined, undefined, { receipt, assertStorage });
        } else {
            const handle = await fs.open(path.join(root, "receipt.json"), "wx");
            try { await handle.writeFile(JSON.stringify(receipt)); await handle.sync(); } finally { await handle.close(); }
        }
        if (boundary === "acknowledgement") await pause();
    },
});
} finally { if (postgres) await postgres.closeMediaDatabase(); }

}
main().catch(error => { console.error(error); process.exitCode = 1; });
