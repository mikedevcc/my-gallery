// Crash-test worker: temporary fixtures and file-backed mock DB only.
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { mockStorageMount } from "./storage-fixture";
import { deleteMediaAtDestination } from "../media-mutations";
import { recoverDeletion, type DeletionRecoveryDatabase } from "../deletion-recovery";
import { deleteThumbnail } from "../media-thumbnail";

async function main() {
    const [root, boundary, mode = "delete", operationId = ""] = process.argv.slice(2);
    if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith("gallery-deletion-test-")) throw new Error("Temporary deletion fixture required");
    await mockStorageMount(root);
    const target = path.join(root, "original.jpg");
    const databasePath = path.join(root, "database.json");
    async function pause() { console.log("BOUNDARY"); await new Promise<void>(() => { setInterval(() => {}, 1000); }); }
    const rename = fs.rename.bind(fs), unlink = fs.unlink.bind(fs);
    fs.rename = async (source, destination) => {
        await rename(source, destination);
        if (String(destination).includes(".deletion-operations") && String(destination).endsWith(".json")) {
            const { state } = JSON.parse(await fs.readFile(destination, "utf8"));
            if (boundary === state.toLowerCase()) await pause();
        }
    };
    fs.unlink = async location => {
        await unlink(location);
        if ((boundary === "original-unlink" && location === target)
            || (boundary === "thumbnail-unlink" && String(location).endsWith("1.webp"))) await pause();
    };
    const database: DeletionRecoveryDatabase = async (_op, _id, _target, action) => action(JSON.parse(await fs.readFile(databasePath, "utf8")));
    if (mode === "recover") await recoverDeletion(root, operationId, database);
    else await deleteMediaAtDestination({ root, destination: target, mediaId: 1, revalidateMetadata: async () => true,
        deleteMetadata: async (verify, receipt) => {
            await verify();
            if (boundary === "pending") await pause();
            const handle = await fs.open(databasePath, "w");
            try { await handle.writeFile(JSON.stringify({ receipt, media: [] })); await handle.sync(); } finally { await handle.close(); }
            if (boundary === "acknowledgement") await pause();
            return true;
        }, afterDelete: () => deleteThumbnail(1),
    });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
