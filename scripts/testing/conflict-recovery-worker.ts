// Isolated crash fixture: no PostgreSQL connections or actual media.
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { mockStorageMount } from "./storage-fixture";
import { acquireResolutionClaim } from "../conflict-resolution-lock";
import { replaceMediaAtDestination } from "../media-mutations";
import { recoverReplacement, type RecoveryDatabase } from "../replacement-files";

async function main() {
    const [root, boundary, mode = "replace", operationId = ""] = process.argv.slice(2);
    if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith("gallery-n1-test-")) throw new Error("Temporary N1 fixture required");
    await mockStorageMount(root);
    const id = "12ec0585-07cb-4e3c-9d84-1ec28cb40a82", target = path.join(root, "original.jpg");
    const job = path.join(root, ".incoming", id), stagedPath = path.join(job, "incoming.jpg");
    async function pause() { console.log("BOUNDARY"); await new Promise<void>(() => { setInterval(() => {}, 1000); }); }
    const rename = fs.rename.bind(fs), unlink = fs.unlink.bind(fs), rmdir = fs.rmdir.bind(fs);
    fs.rename = async (source, destination) => {
        await rename(source, destination);
        if (String(destination).includes(".replacement-operations") && String(destination).endsWith(".json")) {
            const journal = JSON.parse(await fs.readFile(destination, "utf8"));
            if ((boundary === "committed" && journal.state === "COMMITTED")
                || (boundary === "files-settled" && journal.state === "COMPLETE" && journal.conflict.phase === "BOUND")
                || (boundary === "rollback-files" && journal.state === "ROLLED_BACK" && journal.conflict.phase === "BOUND")
                || (boundary === "finalized" && journal.conflict.phase === "FINALIZED")) await pause();
        }
    };
    fs.unlink = async location => {
        await unlink(location);
        if ((boundary === "owner-unlink" && String(location).endsWith(".resolution-lock/owner.json"))
            || (boundary === "metadata-unlink" && String(location).endsWith(".conflict.json"))) await pause();
    };
    fs.rmdir = async (...args) => {
        await rmdir(...args);
        if ((boundary === "marker-rmdir" && String(args[0]).endsWith(".resolution-lock"))
            || (boundary === "job-rmdir" && args[0] === job)) await pause();
    };
    const database: RecoveryDatabase = async (_op, _media, action) => {
        let receipt;
        try { receipt = JSON.parse(await fs.readFile(path.join(root, "receipt.json"), "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        return action({ receipt, mediaPath: target });
    };
    if (mode === "recover") await recoverReplacement(root, operationId, database);
    else {
        const claim = await acquireResolutionClaim(root, id, "REPLACE", stagedPath);
        await replaceMediaAtDestination({ root, destination: target, stagedPath, mediaId: 1, conflict: claim,
            revalidateMetadata: async () => {}, readReceipt: async () => undefined, withRecoveryDatabase: database,
            updateMetadata: async receipt => {
                if (mode === "rollback") throw new Error("rolled back metadata update");
                const handle = await fs.open(path.join(root, "receipt.json"), "wx");
                try { await handle.writeFile(JSON.stringify(receipt)); await handle.sync(); } finally { await handle.close(); }
            },
        });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
