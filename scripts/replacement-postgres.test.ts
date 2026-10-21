import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { Client, Pool, type PoolClient } from "pg";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { recoverReplacement } from "./replacement-files";
import { mockStorageMount, writeTestStorageMarker } from "./testing/storage-fixture";
import { replaceMediaAtDestination } from "./media-mutations";
import { readReplacementJournal } from "./replacement-recovery";

// Opt-in only. Never reads .env or accepts the development database.
test("isolated PostgreSQL 17 replacement integration", { skip: !process.env.H4C_INTEGRATION_URL }, async t => {
    const url = new URL(process.env.H4C_INTEGRATION_URL!);
    if (url.hostname !== "127.0.0.1" || url.port !== "55439" || !/^\/h4c_replacement_test_[a-z0-9_]+$/.test(url.pathname) || url.search) throw new Error("Refusing non-isolated integration target");
    const verifySql = "SELECT current_database() AS database, current_setting('data_directory') AS directory, current_setting('server_version_num')::int AS version";
    const verify = (row: { database: string; directory: string; version: number }) => {
        assert.equal(row.database, url.pathname.slice(1));
        assert.equal(row.directory, "/tmp/mygallery-runner-integration-du1UxD/data");
        assert.equal(Math.floor(row.version / 10000), 17);
    };
    const setup = new Client({ connectionString: url.href }); await setup.connect();
    const query = async (sql: string, values?: unknown[]) => {
        verify((await setup.query(verifySql)).rows[0]); // Before EVERY fixture write/transaction command.
        return setup.query(sql, values);
    };
    verify((await setup.query(verifySql)).rows[0]);
    if (!(await query("SELECT to_regclass('public.media') AS present")).rows[0].present) {
        await query(await fs.readFile("db/migrations/0001_initial_schema.sql", "utf8"));
        await query(await fs.readFile("db/migrations/0002_replacement_receipts.sql", "utf8"));
    }
    const originalConnect = Pool.prototype.connect as (this: Pool) => Promise<PoolClient>;
    const connect = mock.method(Pool.prototype, "connect", async function(this: Pool) {
        const client = await originalConnect.call(this);
        const raw = client.query.bind(client);
        const query = async (sql: string, values?: unknown[]) => {
            // ROLLBACK only aborts this already verified connection; an aborted
            // transaction cannot execute the identity SELECT first.
            if (sql !== "ROLLBACK") verify((await raw(verifySql)).rows[0]);
            return raw(sql, values);
        };
        return { query, release: client.release.bind(client) } as unknown as PoolClient;
    });
    process.env.DATABASE_URL = url.href;
    const db = await import("./media-database");
    try {
        for (const mode of ["success", "query-failure", "lost-acknowledgement"] as const) {
            await t.test(mode, async () => {
                const root = await fs.mkdtemp(path.join(tmpdir(), "gallery-h4c-test-"));
                await writeTestStorageMarker(root); const mount = await mockStorageMount(root);
                const target = path.join(root, "original.jpg"), incoming = path.join(root, "incoming.jpg");
                await fs.writeFile(target, "original"); await fs.writeFile(incoming, "new image bytes");
                const mediaId = (await query("INSERT INTO public.media(file_name,file_type,file_size,path) VALUES ('original.jpg','IMAGE',8,$1) RETURNING media_id", [target])).rows[0].media_id as number;
                await query("INSERT INTO public.image(media_id) VALUES ($1)", [mediaId]);
                try {
                    const operation = () => replaceMediaAtDestination({ root, destination: target, stagedPath: incoming, mediaId,
                        readReceipt: db.getReplacementReceipt, withRecoveryDatabase: db.withReplacementRecoveryDatabase,
                        revalidateMetadata: async () => { assert.equal((await db.findMediaByPath(target))?.media_id, mediaId); },
                        updateMetadata: async (receipt, assertStorage) => {
                            await db.updateImportedMedia(mediaId, {
                                file: { fileName: "original.jpg", fileType: "IMAGE", fileSize: 15, absolutePath: target, extension: ".jpg" },
                                media: { width: 640 }, image: { iso: mode === "query-failure" ? -1 : 100 },
                            }, undefined, undefined, { receipt, assertStorage });
                            if (mode === "lost-acknowledgement") throw new Error("COMMIT acknowledgement lost");
                        },
                    });
                    if (mode === "query-failure") await assert.rejects(operation()); else await operation();
                    const name = (await fs.readdir(path.join(root, ".replacement-operations"))).find(name => name.endsWith(".json"))!;
                    const journal = await readReplacementJournal(root, name.slice(0, -5));
                    const receipt = await db.getReplacementReceipt(journal.operationId);
                    const row = (await query("SELECT file_size::int AS size,width FROM public.media WHERE media_id=$1", [mediaId])).rows[0];
                    assert.equal(await fs.readFile(target, "utf8"), mode === "query-failure" ? "original" : "new image bytes");
                    assert.equal(row.size, mode === "query-failure" ? 8 : 15);
                    assert.equal(row.width, mode === "query-failure" ? null : 640);
                    assert.equal(!!receipt, mode !== "query-failure");
                    assert.equal(journal.state, mode === "query-failure" ? "ROLLED_BACK" : "COMPLETE");
                } finally { mount.restore(); await fs.rm(root, { recursive: true, force: true }); }
            });
        }
        for (const boundary of ["published", "pending", "acknowledgement", "cleanup"]) {
            await t.test(`real SQL worker death/restart at ${boundary}`, async () => {
                const root = await fs.mkdtemp(path.join(tmpdir(), "gallery-h4c-test-"));
                await writeTestStorageMarker(root); const mount = await mockStorageMount(root);
                const target = path.join(root, "original.jpg");
                await fs.writeFile(target, "original"); await fs.writeFile(path.join(root, "incoming.jpg"), "new image bytes");
                const mediaId = (await query("INSERT INTO public.media(file_name,file_type,file_size,path) VALUES ('original.jpg','IMAGE',8,$1) RETURNING media_id", [target])).rows[0].media_id as number;
                await query("INSERT INTO public.image(media_id) VALUES ($1)", [mediaId]);
                const child = spawn(process.execPath, ["--import", "tsx", "scripts/testing/replacement-worker.ts", root, boundary, "replace-pg", String(mediaId)], { stdio: ["ignore", "pipe", "pipe"] });
                let errorOutput = ""; child.stderr.on("data", data => { errorOutput += data; });
                const lines = createInterface({ input: child.stdout });
                try {
                    await Promise.race([new Promise<void>((resolve, reject) => {
                        lines.on("line", line => { if (line === "BOUNDARY") resolve(); });
                        child.once("exit", () => reject(new Error(errorOutput)));
                    }), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Worker boundary timeout")), 10000).unref())]);
                    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
                    const name = (await fs.readdir(path.join(root, ".replacement-operations"))).find(name => name.endsWith(".json"))!;
                    const id = name.slice(0, -5), committed = ["acknowledgement", "cleanup"].includes(boundary);
                    assert.equal(await recoverReplacement(root, id, db.withReplacementRecoveryDatabase), committed ? "COMMITTED" : "ROLLED_BACK");
                    assert.equal(await recoverReplacement(root, id, db.withReplacementRecoveryDatabase), "ALREADY_COMPLETE");
                    assert.equal(await fs.readFile(target, "utf8"), committed ? "new image bytes" : "original");
                    assert.equal((await query("SELECT file_size::int AS size FROM public.media WHERE media_id=$1", [mediaId])).rows[0].size, committed ? 15 : 8);
                } finally { child.kill("SIGKILL"); lines.close(); mount.restore(); await fs.rm(root, { recursive: true, force: true }); }
            });
        }
        await t.test("in-flight transaction prevents interpreting absent receipt as rollback", async () => {
            const id = randomUUID();
            await query("BEGIN");
            await query("SELECT pg_advisory_xact_lock(hashtextextended($1, 48291))", [id]);
            let entered = false;
            await assert.rejects(db.withReplacementRecoveryDatabase(id, 1, async () => { entered = true; }), /still running/);
            assert.equal(entered, false);
            await query("ROLLBACK");
            await db.withReplacementRecoveryDatabase(id, 1, async evidence => { assert.equal(evidence.receipt, undefined); entered = true; });
            assert.equal(entered, true);
        });
    } finally { connect.mock.restore(); await db.closeMediaDatabase(); await setup.end(); }
});
