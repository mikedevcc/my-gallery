// Test-only worker: real PostgreSQL, temporary media and injected process stops.
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Client } from "pg";
import { conflictPostgresTarget, verifyConflictPostgres, checkedConflictQuery, guardConflictPool } from "./conflict-postgres-fixture";
import { mockStorageMount } from "./storage-fixture";
import { acquireResolutionClaim } from "../conflict-resolution-lock";
import { replaceMediaAtDestination } from "../media-mutations";
import { DestinationRecoveryError } from "../destination-lock";
import { recoverReplacement } from "../replacement-files";

async function main() {
    const [root, boundary, mode, value] = process.argv.slice(2);
    if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith("gallery-n1-postgres-")) throw new Error("Temporary PostgreSQL N1 fixture required");
    const url = conflictPostgresTarget();
    const probe = new Client({ connectionString: url.href, options: "-c default_transaction_read_only=on" });
    try { await probe.connect(); await verifyConflictPostgres(probe); } finally { await probe.end(); }
    await mockStorageMount(root);
    async function pause() { console.log("BOUNDARY"); await new Promise<void>(() => { setInterval(() => {}, 1000); }); }
    const restore = guardConflictPool(async sql => {
        if (sql === "COMMIT" && boundary === "in-flight") await pause();
    });
    process.env.DATABASE_URL = url.href; // Before importing the actual application's pool.
    const db = await import("../media-database");
    const id = "12ec0585-07cb-4e3c-9d84-1ec28cb40a82", target = path.join(root, "original.jpg");
    const stagedPath = path.join(root, ".incoming", id, "incoming.jpg");
    const rename = fs.rename.bind(fs), unlink = fs.unlink.bind(fs), rmdir = fs.rmdir.bind(fs);
    fs.rename = async (source, destination) => {
        await rename(source, destination);
        if (boundary === "published" && String(source).includes(".publish-")) await pause();
        if (String(destination).includes(".replacement-operations") && String(destination).endsWith(".json")) {
            const journal = JSON.parse(await fs.readFile(destination, "utf8"));
            if ((boundary === "files-settled" && journal.state === "COMPLETE" && journal.conflict.phase === "BOUND")
                || (boundary === "rollback-files" && journal.state === "ROLLED_BACK" && journal.conflict.phase === "BOUND")) await pause();
        }
    };
    fs.unlink = async location => {
        await unlink(location);
        if (boundary === "owner-unlink" && String(location).endsWith(".resolution-lock/owner.json")) await pause();
    };
    fs.rmdir = async (...args) => {
        await rmdir(...args);
        if (boundary === "job-rmdir" && String(args[0]).endsWith(id)) await pause();
    };
    let blocker: Client | undefined;
    try {
        if (mode === "recover") {
            await recoverReplacement(root, value, db.withReplacementRecoveryDatabase);
        } else {
            const mediaId = Number(value);
            if (!Number.isSafeInteger(mediaId) || mediaId <= 0) throw new Error("Invalid fixture media ID");
            const claim = await acquireResolutionClaim(root, id, "REPLACE", stagedPath);
            try {
                await replaceMediaAtDestination({ root, destination: target, stagedPath, mediaId, conflict: claim,
                    readReceipt: db.getReplacementReceipt, withRecoveryDatabase: db.withReplacementRecoveryDatabase,
                    revalidateMetadata: async () => {
                        if ((await db.findMediaByPath(target))?.media_id !== mediaId) throw new Error("Fixture metadata mismatch");
                    },
                    updateMetadata: async (receipt, assertStorage) => {
                        await db.updateImportedMedia(mediaId, {
                            file: { fileName: "original.jpg", fileType: "IMAGE", fileSize: 15, absolutePath: target, extension: ".jpg" },
                            media: { width: 640 }, image: { iso: mode === "rollback" ? -1 : 100 },
                        }, undefined, undefined, { receipt, assertStorage });
                        if (boundary === "acknowledgement") await pause();
                        if (mode === "ambiguous") {
                            // Commit really succeeded. Simulate lost acknowledgment
                            // while a genuine second transaction blocks reconciliation.
                            blocker = new Client({ connectionString: url.href }); await blocker.connect();
                            await checkedConflictQuery(blocker, "BEGIN");
                            await checkedConflictQuery(blocker, "SELECT pg_advisory_xact_lock(hashtextextended($1,48291))", [receipt.operationId]);
                            throw new Error("Injected lost commit acknowledgment");
                        }
                    },
                });
            } catch (error) {
                if (mode !== "ambiguous" || !(error instanceof DestinationRecoveryError)) throw error;
                await pause(); // Keep the actual advisory-lock transaction open.
            }
        }
    } finally {
        if (blocker) { await checkedConflictQuery(blocker, "ROLLBACK"); await blocker.end(); }
        await db.closeMediaDatabase(); restore();
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
