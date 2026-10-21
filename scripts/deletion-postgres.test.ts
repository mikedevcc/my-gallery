import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { Client, Pool, type PoolClient } from "pg";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { acquireDestinationLock } from "./destination-lock";
import { prepareDeletionJournal, deletionReceiptFor, readDeletionJournal } from "./deletion-tracking";
import { recoverDeletion } from "./deletion-recovery";
import { mockStorageMount, writeTestStorageMarker } from "./testing/storage-fixture";

// Explicit opt-in, provisioned disposable PG17 only. Does not run migrations.
test("isolated PostgreSQL deletion receipts, rollback, lost acknowledgement and live transactions", { skip: !process.env.M1B_INTEGRATION_URL }, async t => {
    const url = new URL(process.env.M1B_INTEGRATION_URL!);
    const directory = process.env.M1B_INTEGRATION_DATA_DIRECTORY ?? "";
    if (url.hostname !== "127.0.0.1" || url.port !== "55441" || !/^\/m1b_deletion_test_[a-z0-9_]+$/.test(url.pathname)
        || url.search || !/^\/tmp\/gallery-m1b-pg-[a-zA-Z0-9]+\/data$/.test(directory)) throw new Error("Non-isolated deletion integration target refused");
    const identity = "SELECT current_database() AS database,current_setting('data_directory') AS directory,current_setting('server_version_num')::int AS version";
    const verify = (row: { database: string; directory: string; version: number }) => {
        assert.equal(row.database, url.pathname.slice(1)); assert.equal(row.directory, directory); assert.equal(Math.floor(row.version / 10000), 17);
    };
    const setup = new Client({ connectionString: url.href }); await setup.connect();
    const checked = async (sql: string, values?: unknown[]) => {
        verify((await setup.query(identity)).rows[0]); // Before each fixture write/transaction.
        return setup.query(sql, values);
    };
    const previous = process.env.DATABASE_URL;
    let db: typeof import("./media-database") | undefined;
    let interception: ReturnType<typeof mock.method> | undefined;
    try {
        verify((await setup.query(identity)).rows[0]);
        // Minimal isolated fixture tables, not application migrations or production DDL.
        await checked("CREATE TABLE public.media (media_id integer PRIMARY KEY, path text NOT NULL)");
        await checked("CREATE TABLE public.media_deletion_receipts (operation_id uuid PRIMARY KEY,media_id integer NOT NULL,target_path text NOT NULL,original_identity jsonb NOT NULL,committed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)");
        const connect = Pool.prototype.connect as (this: Pool) => Promise<PoolClient>;
        let loseAcknowledgement = false;
        interception = mock.method(Pool.prototype, "connect", async function(this: Pool) {
            const client = await connect.call(this), raw = client.query.bind(client);
            return { query: async (sql: string, values?: unknown[]) => {
                if (sql !== "ROLLBACK") verify((await raw(identity)).rows[0]);
                const result = await raw(sql, values);
                if (sql === "COMMIT" && loseAcknowledgement) { loseAcknowledgement = false; throw new Error("lost COMMIT acknowledgement"); }
                return result;
            }, release: client.release.bind(client) } as unknown as PoolClient;
        });
        process.env.DATABASE_URL = url.href;
        db = await import("./media-database");
        for (const mode of ["committed", "rollback", "lost-acknowledgement", "in-flight"] as const) {
            await t.test(mode, async () => {
                const root = await fs.mkdtemp(path.join(tmpdir(), "gallery-deletion-test-"));
                await writeTestStorageMarker(root); const mount = await mockStorageMount(root);
                const target = path.join(root, "original.jpg"); await fs.writeFile(target, "original");
                const mediaId = 1;
                await checked("INSERT INTO public.media(media_id,path) VALUES ($1,$2)", [mediaId, target]);
                const lock = await acquireDestinationLock(root, target), journal = await prepareDeletionJournal(root, mediaId, lock);
                const ownerPath = path.join(lock.directory, "owner.json");
                const owner = JSON.parse(await fs.readFile(ownerPath, "utf8"));
                await fs.writeFile(ownerPath, JSON.stringify({ ...owner, startTime: "0" }));
                try {
                    if (mode === "in-flight") {
                        await checked("BEGIN");
                        await checked("SELECT pg_advisory_xact_lock(hashtextextended($1,48291))", [journal.operationId]);
                        // An actual DELETE is still uncommitted; absence of its receipt proves nothing.
                        await checked("DELETE FROM public.media WHERE media_id=$1", [mediaId]);
                        await assert.rejects(recoverDeletion(root, journal.operationId, db!.withDeletionRecoveryDatabase), /still running/);
                        assert.equal(await fs.readFile(target, "utf8"), "original");
                        // Identity SELECT is allowed in this healthy transaction.
                        await checked("ROLLBACK");
                    } else {
                        loseAcknowledgement = mode === "lost-acknowledgement";
                        let guards = 0;
                        const deletion = () => db!.deleteMediaById(mediaId, async () => {
                            if (++guards === 2 && mode === "rollback") throw new Error("injected storage precondition failure");
                        }, deletionReceiptFor(journal));
                        if (mode === "committed") await deletion();
                        else await assert.rejects(deletion, mode === "rollback" ? /precondition/ : /lost COMMIT/);
                    }
                    const committed = mode === "committed" || mode === "lost-acknowledgement";
                    const receipts = await checked("SELECT operation_id FROM public.media_deletion_receipts WHERE operation_id=$1", [journal.operationId]);
                    assert.equal(receipts.rowCount, committed ? 1 : 0);
                    assert.equal(await recoverDeletion(root, journal.operationId, db!.withDeletionRecoveryDatabase), committed ? "COMMITTED" : "ABORTED");
                    assert.equal((await readDeletionJournal(root, journal.operationId)).state, committed ? "COMPLETE" : "ABORTED");
                    if (committed) await assert.rejects(fs.access(target));
                    else assert.equal(await fs.readFile(target, "utf8"), "original");
                    assert.equal(await recoverDeletion(root, journal.operationId, db!.withDeletionRecoveryDatabase), "ALREADY_COMPLETE");
                    await checked("DELETE FROM public.media WHERE media_id=$1", [mediaId]);
                } finally { mount.restore(); await fs.rm(root, { recursive: true, force: true }); }
            });
        }
    } finally {
        if (db) await db.closeMediaDatabase();
        interception?.mock.restore();
        if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
        await setup.end();
    }
});
