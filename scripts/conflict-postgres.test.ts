import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { Client } from "pg";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { conflictPostgresTarget, verifyConflictPostgres, checkedConflictQuery, guardConflictPool } from "./testing/conflict-postgres-fixture";
import { mockStorageMount, writeTestStorageMarker } from "./testing/storage-fixture";
import { acquireResolutionClaim } from "./conflict-resolution-lock";
import { replaceMediaAtDestination } from "./media-mutations";
import { recoverReplacement } from "./replacement-files";
import { readReplacementJournal } from "./replacement-recovery";
import { acquireDestinationLock, DestinationBusyError } from "./destination-lock";

const id = "12ec0585-07cb-4e3c-9d84-1ec28cb40a82";
test("N1 replacement conflict recovery with actual PostgreSQL receipts and locks", { skip: !process.env.N1_INTEGRATION_URL }, async t => {
    const url = conflictPostgresTarget(), client = new Client({ connectionString: url.href });
    await client.connect();
    const query = (sql: string, values?: unknown[]) => checkedConflictQuery(client, sql, values);
    const previous = process.env.DATABASE_URL;
    let db: typeof import("./media-database") | undefined;
    let restore: (() => void) | undefined;
    try {
        await verifyConflictPostgres(client);
        const schema = (await query("SELECT to_regclass('public.media') AS media,to_regclass('public.image') AS image,to_regclass('public.media_replacement_receipts') AS receipts")).rows[0];
        assert.ok(schema.media && schema.image && schema.receipts, "Preprovisioned isolated fixture required; never run migrations here");
        process.env.DATABASE_URL = url.href; restore = guardConflictPool();
        db = await import("./media-database");

        async function fixture(action: (f: { root: string; target: string; staged: string; job: string; marker: string; mediaId: number }) => Promise<void>) {
            const root = await fs.mkdtemp(path.join(tmpdir(), "gallery-n1-postgres-"));
            await writeTestStorageMarker(root); const mount = await mockStorageMount(root);
            const target = path.join(root, "original.jpg"), job = path.join(root, ".incoming", id), staged = path.join(job, "incoming.jpg");
            try {
                await fs.mkdir(job, { recursive: true }); await fs.writeFile(target, "original"); await fs.writeFile(staged, "new image bytes");
                const mediaId = (await query("INSERT INTO public.media(file_name,file_type,file_size,path) VALUES ('original.jpg','IMAGE',8,$1) RETURNING media_id", [target])).rows[0].media_id as number;
                await query("INSERT INTO public.image(media_id) VALUES ($1)", [mediaId]);
                await fs.writeFile(path.join(job, ".conflict.json"), JSON.stringify({ type: "FILENAME", conflictId: id, jobId: "test-job", existingPath: target, existingMediaId: mediaId }));
                await action({ root, target, staged, job, marker: path.join(job, ".resolution-lock"), mediaId });
            } finally { mount.restore(); await fs.rm(root, { recursive: true, force: true }); }
        }
        async function operation(root: string, target: string, staged: string, mediaId: number, invalid = false) {
            const claim = await acquireResolutionClaim(root, id, "REPLACE", staged);
            await replaceMediaAtDestination({ root, destination: target, stagedPath: staged, mediaId, conflict: claim,
                readReceipt: db!.getReplacementReceipt, withRecoveryDatabase: db!.withReplacementRecoveryDatabase,
                revalidateMetadata: async () => { assert.equal((await db!.findMediaByPath(target))?.media_id, mediaId); },
                updateMetadata: (receipt, assertStorage) => db!.updateImportedMedia(mediaId, {
                    file: { fileName: "original.jpg", fileType: "IMAGE", fileSize: 15, absolutePath: target, extension: ".jpg" },
                    media: { width: 640 }, image: { iso: invalid ? -1 : 100 },
                }, undefined, undefined, { receipt, assertStorage }),
            });
            return claim.operationId;
        }
        async function journalIds(root: string) {
            return (await fs.readdir(path.join(root, ".replacement-operations"))).filter(name => name.endsWith(".json")).map(name => name.slice(0, -5));
        }
        async function worker(root: string, boundary: string, mode: string, value: string) {
            const child = spawn(process.execPath, ["--import", "tsx", "scripts/testing/conflict-postgres-worker.ts", root, boundary, mode, value], { stdio: ["ignore", "pipe", "pipe"] });
            let stderr = ""; child.stderr.on("data", data => { stderr += data; });
            const lines = createInterface({ input: child.stdout });
            const stop = async () => {
                if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
                lines.close();
            };
            try {
                await new Promise<void>((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error(`PostgreSQL worker timeout: ${stderr}`)), 10000);
                    lines.on("line", line => { if (line === "BOUNDARY") { clearTimeout(timer); resolve(); } });
                    child.once("exit", () => { clearTimeout(timer); reject(new Error(`PostgreSQL worker exited: ${stderr}`)); });
                });
                return stop;
            } catch (error) { await stop(); throw error; }
        }
        async function recover(root: string, op: string) {
            // A killed worker's backend may still be closing. Busy means defer,
            // never assume rollback or manufacture a missing receipt.
            for (let attempt = 0; ; attempt++) {
                try { return await recoverReplacement(root, op, db!.withReplacementRecoveryDatabase); }
                catch (error) {
                    if (attempt >= 30 || !(error instanceof Error) || !error.message.includes("still running")) throw error;
                    await delay(25);
                }
            }
        }
        async function receipt(op: string) {
            return (await query("SELECT operation_id FROM public.media_replacement_receipts WHERE operation_id=$1", [op])).rows;
        }
        async function assertFinished(root: string, target: string, job: string, mediaId: number, op: string) {
            assert.equal(await fs.readFile(target, "utf8"), "new image bytes"); await assert.rejects(fs.access(job));
            const journal = await readReplacementJournal(root, op);
            assert.equal(journal.state, "COMPLETE"); assert.equal(journal.conflict?.phase, "FINALIZED");
            assert.equal((await receipt(op)).length, 1);
            const row = (await query("SELECT file_size::int AS size,width FROM public.media WHERE media_id=$1", [mediaId])).rows[0];
            assert.equal(row.size, 15); assert.equal(row.width, 640);
            assert.equal(await recover(root, op), "ALREADY_COMPLETE");
            assert.equal(await recover(root, op), "ALREADY_COMPLETE");
        }

        await t.test("committed replacement cleans verified conflict artifacts and repeats without changes", () => fixture(async ({ root, target, staged, job, mediaId }) => {
            const op = await operation(root, target, staged, mediaId);
            await assertFinished(root, target, job, mediaId, op);
        }));
        await t.test("real constraint failure rolls metadata back and releases marker for successful retry", () => fixture(async ({ root, target, staged, job, marker, mediaId }) => {
            await assert.rejects(operation(root, target, staged, mediaId, true));
            const [op] = await journalIds(root), journal = await readReplacementJournal(root, op);
            assert.equal(journal.state, "ROLLED_BACK"); assert.equal(journal.conflict?.phase, "FINALIZED");
            assert.equal((await receipt(op)).length, 0); await assert.rejects(fs.access(marker));
            assert.equal(await fs.readFile(target, "utf8"), "original"); assert.equal(await fs.readFile(staged, "utf8"), "new image bytes");
            const row = (await query("SELECT file_size::int AS size,width FROM public.media WHERE media_id=$1", [mediaId])).rows[0];
            assert.equal(row.size, 8); assert.equal(row.width, null);
            assert.equal(await recover(root, op), "ALREADY_COMPLETE");
            const retry = await operation(root, target, staged, mediaId); assert.notEqual(retry, op);
            await assertFinished(root, target, job, mediaId, retry);
        }));
        for (const boundary of ["published", "in-flight", "acknowledgement", "files-settled", "rollback-files"]) {
            await t.test(`real PostgreSQL worker termination at ${boundary}`, () => fixture(async ({ root, target, staged, job, marker, mediaId }) => {
                const rollback = ["published", "in-flight", "rollback-files"].includes(boundary);
                const stop = await worker(root, boundary, boundary === "rollback-files" ? "rollback" : "replace", String(mediaId));
                const [op] = await journalIds(root);
                try {
                    if (boundary === "in-flight") {
                        assert.equal((await receipt(op)).length, 0, "Uncommitted receipt is invisible");
                        await assert.rejects(recoverReplacement(root, op, db!.withReplacementRecoveryDatabase), /still running/);
                        assert.ok(await fs.stat(marker)); await assert.rejects(acquireDestinationLock(root, target), DestinationBusyError);
                    }
                } finally { await stop(); }
                assert.equal(await recover(root, op), rollback ? "ROLLED_BACK" : "COMMITTED");
                if (rollback) {
                    assert.equal(await fs.readFile(target, "utf8"), "original"); assert.equal(await fs.readFile(staged, "utf8"), "new image bytes");
                    assert.ok(await fs.stat(path.join(job, ".conflict.json"))); await assert.rejects(fs.access(marker));
                    assert.equal((await receipt(op)).length, 0); assert.equal(await recover(root, op), "ALREADY_COMPLETE");
                    const retry = await operation(root, target, staged, mediaId); await assertFinished(root, target, job, mediaId, retry);
                } else await assertFinished(root, target, job, mediaId, op);
            }));
        }
        await t.test("lost acknowledgment with a genuine busy advisory lock retains all evidence until recovery", () => fixture(async ({ root, target, job, marker, mediaId }) => {
            const stop = await worker(root, "retained", "ambiguous", String(mediaId));
            const [op] = await journalIds(root);
            try {
                const journal = await readReplacementJournal(root, op);
                assert.equal(journal.state, "COMMIT_UNKNOWN"); assert.equal(journal.conflict?.phase, "BOUND");
                assert.equal((await receipt(op)).length, 1, "Receipt is real and committed, not a mocked result");
                assert.ok(await fs.stat(marker)); assert.ok(await fs.stat(journal.stagedPath));
                assert.equal(await fs.readFile(journal.backupPath, "utf8"), "original");
                await assert.rejects(recoverReplacement(root, op, db!.withReplacementRecoveryDatabase), /still running/);
                await assert.rejects(acquireDestinationLock(root, target), DestinationBusyError);
            } finally { await stop(); }
            assert.equal(await recover(root, op), "COMMITTED"); await assertFinished(root, target, job, mediaId, op);
        }));
        for (const boundary of ["owner-unlink", "job-rmdir"]) {
            await t.test(`PostgreSQL recovery worker itself terminates after ${boundary}`, () => fixture(async ({ root, target, job, mediaId }) => {
                await (await worker(root, "files-settled", "replace", String(mediaId)))();
                const [op] = await journalIds(root);
                // Confirm actual acknowledged transaction before starting recovery.
                assert.equal((await receipt(op)).length, 1);
                const stop = await worker(root, boundary, "recover", op);
                try { await assert.rejects(recoverReplacement(root, op, db!.withReplacementRecoveryDatabase), /still running/); }
                finally { await stop(); }
                assert.equal(await recover(root, op), "COMMITTED"); await assertFinished(root, target, job, mediaId, op);
            }));
        }
        await t.test("repeated old recovery cannot remove a later conflict marker", () => fixture(async ({ root, target, staged, job, mediaId }) => {
            const op = await operation(root, target, staged, mediaId);
            await fs.mkdir(job); await fs.writeFile(staged, "another incoming generation");
            await fs.writeFile(path.join(job, ".conflict.json"), JSON.stringify({ type: "FILENAME", conflictId: id, jobId: "later-job", existingPath: target, existingMediaId: mediaId }));
            const later = await acquireResolutionClaim(root, id, "REPLACE", staged);
            assert.equal(await recover(root, op), "ALREADY_COMPLETE");
            const owner = JSON.parse(await fs.readFile(path.join(job, ".resolution-lock", "owner.json"), "utf8"));
            assert.equal(owner.token, later.evidence.token); assert.equal(owner.operationId, later.operationId);
            assert.equal(await fs.readFile(staged, "utf8"), "another incoming generation");
        }));
    } finally {
        if (db) await db.closeMediaDatabase(); restore?.(); await client.end();
        if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
    }
});
