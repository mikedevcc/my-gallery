import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { collectionsFixture, checkedCollectionsQuery, verifyCollections, guardCollectionsPool } from "./testing/collections-postgres-fixture";
import { CollectionIntegrityError } from "./collection-integrity";

// This suite refuses arbitrary URLs, TCP connections and existing installations.
// Provision an independent /tmp cluster and schema explicitly before opting in.
test("M5/M6 collection integrity with PostgreSQL 17 row locks and foreign keys", { skip: !process.env.COLLECTION_PG_FIXTURE }, async t => {
    const fixture = await collectionsFixture();
    const client = new Client({ connectionString: fixture.url }); await client.connect();
    const previous = process.env.DATABASE_URL;
    let restore: (() => void) | undefined;
    let db: typeof import("./media-database") | undefined;
    const query = (sql: string, values?: unknown[]) => checkedCollectionsQuery(client, fixture, sql, values);
    try {
        await verifyCollections(client, fixture);
        process.env.DATABASE_URL = fixture.url; restore = guardCollectionsPool(fixture);
        db = await import("./media-database");
        assert.equal((await query("SELECT to_regclass('public.media_deletion_receipts') AS receipts")).rows[0].receipts, "media_deletion_receipts");
        async function reset() {
            await query("TRUNCATE public.media, public.album, public.trip, public.media_album, public.image, public.video, public.media_deletion_receipts RESTART IDENTITY CASCADE");
            await query("INSERT INTO trip(trip_name) VALUES ('One'),('Two'),('Three')");
            await query("INSERT INTO album(album_name) VALUES ('One'),('Two'),('Three')");
            for (let i = 1; i <= 4; i++) await query("INSERT INTO media(file_name,file_type,file_size,path) VALUES ($1,'IMAGE',10,$2)", [`media-${i}.jpg`, `${fixture.root}/media-${i}.jpg`]);
        }
        async function seed(album: number, media: number[], cover: number | null = media[0] ?? null) {
            for (const id of media) await query("INSERT INTO media_album(media_id,album_id) VALUES ($1,$2)", [id, album]);
            await query("UPDATE album SET cover_media_id = $1 WHERE album_id = $2", [cover, album]);
        }
        async function membership(album: number) { return (await query("SELECT media_id FROM media_album WHERE album_id=$1 ORDER BY media_id", [album])).rows.map(row => row.media_id); }
        async function covers() {
            const rows = (await query(`SELECT a.album_id, a.cover_media_id, EXISTS(SELECT 1 FROM media_album ma
                WHERE ma.album_id=a.album_id AND ma.media_id=a.cover_media_id) AS member FROM album a ORDER BY a.album_id`)).rows;
            for (const row of rows) assert.ok(row.cover_media_id === null || row.member, `Invalid cover for Album ${row.album_id}`);
            return rows.map(row => row.cover_media_id);
        }
        const conflict = (error: unknown) => error instanceof CollectionIntegrityError && error.status === 409;

        await t.test("Trip Add accepts only unassigned media and rolls a conflicting bulk selection back", async () => {
            await reset();
            assert.equal(await db!.addMediaToTrip([1, 2], 1), 2);
            await assert.rejects(db!.addMediaToTrip([2, 3], 2), conflict);
            await assert.rejects(db!.addMediaToTrip(1, 1), conflict);
            assert.deepEqual((await query("SELECT trip_id FROM media ORDER BY media_id")).rows.map(row => row.trip_id), [1, 1, null, null]);
            assert.deepEqual(await db!.moveMediaToTrip([1, 3], 1, 2), [3]);
            assert.equal((await query("SELECT trip_id FROM media WHERE media_id=1")).rows[0].trip_id, 1);
            assert.deepEqual(await db!.moveMediaToTrip([1, 2], 1, 2), []);
            assert.deepEqual((await query("SELECT trip_id FROM media ORDER BY media_id")).rows.map(row => row.trip_id), [2, 2, null, null]);
        });
        await t.test("two concurrent Trip Adds cannot both claim the same original selection", async () => {
            await reset();
            const blocker = new Client({ connectionString: fixture.url }); await blocker.connect();
            const checked = (sql: string) => checkedCollectionsQuery(blocker, fixture, sql);
            const attempts: Promise<number>[] = [];
            try {
                await checked("BEGIN"); await checked("SELECT media_id FROM media WHERE media_id=1 FOR UPDATE");
                attempts.push(db!.addMediaToTrip([1, 2], 1), db!.addMediaToTrip([1, 3], 2));
                // Attach rejection handlers before unblocking either competing transaction.
                const completed = Promise.allSettled(attempts);
                const deadline = Date.now() + 3000;
                while (true) {
                    const blocked = (await query(`SELECT count(*)::int AS n FROM pg_stat_activity
                        WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT media_id, trip_id FROM media%'`)).rows[0].n;
                    if (blocked === 2) break;
                    assert.ok(Date.now() < deadline, "Both requests must demonstrably wait on the media row"); await delay(10);
                }
                await checked("COMMIT");
                const results = await completed;
                assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
                assert.equal(results.filter(result => result.status === "rejected" && conflict(result.reason)).length, 1);
                const trips = (await query("SELECT trip_id FROM media ORDER BY media_id")).rows.map(row => row.trip_id);
                assert.ok(JSON.stringify(trips) === JSON.stringify([1,1,null,null]) || JSON.stringify(trips) === JSON.stringify([2,null,2,null]));
            } finally { await checked("ROLLBACK"); await Promise.allSettled(attempts); await blocker.end(); }
        });
        await t.test("Album Copy initializes covers and reports only newly inserted memberships", async () => {
            await reset(); await seed(1, [1,2]);
            assert.equal(await db!.copyMediaToAlbum([1,2], 1, 2), 2);
            assert.deepEqual(await membership(1), [1,2]); assert.deepEqual(await membership(2), [1,2]);
            assert.deepEqual(await covers(), [1,1,null]);
            await query("UPDATE album SET cover_media_id=2 WHERE album_id=2");
            assert.equal(await db!.copyMediaToAlbum([1,2], 1, 2), 0);
            assert.deepEqual(await covers(), [1,2,null]); // Preserve a valid custom cover.
        });
        await t.test("invalid source selection aborts both copy and move without partial changes", async () => {
            await reset(); await seed(1, [1]);
            await assert.rejects(db!.copyMediaToAlbum([1,2], 1, 2), conflict);
            await assert.rejects(db!.moveMediaToAlbum([1,2], 1, 2), conflict);
            assert.deepEqual(await membership(1), [1]); assert.deepEqual(await membership(2), []);
            assert.deepEqual(await covers(), [1,null,null]);
        });
        await t.test("moves count source removals, preserve target duplicates, and repair both covers", async () => {
            await reset(); await seed(1, [1,2]); await seed(2, [1]);
            assert.equal(await db!.moveMediaToAlbum([1,2], 1, 2), 2);
            assert.deepEqual(await membership(1), []); assert.deepEqual(await membership(2), [1,2]);
            assert.deepEqual(await covers(), [null,1,null]);
            assert.equal((await query("SELECT count(*)::int AS n FROM media")).rows[0].n, 4);
        });
        await t.test("removing the cover chooses another member then clears an empty Album", async () => {
            await reset(); await seed(1, [1,2]);
            assert.equal(await db!.removeMediaFromAlbum(1, 1), true); assert.deepEqual(await covers(), [2,null,null]);
            assert.equal(await db!.removeMediaFromAlbum(2, 1), true); assert.deepEqual(await covers(), [null,null,null]);
            assert.equal(await db!.removeMediaFromAlbum(2, 1), false);
        });
        await t.test("concurrent additions and opposite moves serialize Album cover changes without deadlock", async () => {
            await reset();
            assert.deepEqual(await Promise.all([db!.addMediaToAlbum(1, 1), db!.addMediaToAlbum(2, 1)]), [1,1]);
            assert.deepEqual(await membership(1), [1,2]); await covers();
            await reset(); await seed(1, [1]); await seed(2, [2]);
            assert.deepEqual(await Promise.all([db!.moveMediaToAlbum([1],1,2), db!.moveMediaToAlbum([2],2,1)]), [1,1]);
            assert.deepEqual(await membership(1), [2]); assert.deepEqual(await membership(2), [1]);
            assert.deepEqual(await covers(), [2,1,null]);
        });
        await t.test("concurrent removals of different members cannot deadlock through the cover foreign key", async () => {
            await reset(); await seed(1, [1,2]);
            const results = await Promise.allSettled([db!.removeMediaFromAlbum(1,1), db!.removeMediaFromAlbum(2,1)]);
            assert.ok(results.every(result => result.status === "fulfilled" && result.value === true), JSON.stringify(results));
            assert.deepEqual(await membership(1), []); assert.deepEqual(await covers(), [null,null,null]);
        });
        await t.test("unrelated Album edits remain concurrent while one Album is row-locked", async () => {
            await reset();
            const blocker = new Client({ connectionString: fixture.url }); await blocker.connect();
            const checked = (sql: string) => checkedCollectionsQuery(blocker, fixture, sql);
            const held = db!;
            let pending: Promise<unknown> | undefined;
            try {
                await checked("BEGIN"); await checked("SELECT album_id FROM album WHERE album_id=1 FOR UPDATE");
                pending = held.addMediaToAlbum(1,1); pending.catch(() => {});
                const deadline = Date.now() + 3000;
                while (!(await query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT album_id FROM album WHERE album_id = ANY%'")).rowCount) {
                    assert.ok(Date.now() < deadline, "First edit must wait on its Album row"); await delay(10);
                }
                assert.equal(await held.addMediaToAlbum(2,2), 1);
                assert.deepEqual(await membership(2), [2]);
                await checked("COMMIT"); assert.equal(await pending, 1); await covers();
            } finally { await checked("ROLLBACK"); await pending?.catch(() => {}); await blocker.end(); }
        });
        await t.test("copy and media deletion coordinate real advisory locks and leave both covers valid", async () => {
            await reset(); await seed(1, [1,2]);
            const blocker = new Client({ connectionString: fixture.url }); await blocker.connect();
            const checked = (sql: string) => checkedCollectionsQuery(blocker, fixture, sql);
            const pending: Promise<unknown>[] = [];
            async function waiting(prefix: string) {
                const deadline = Date.now() + 3000;
                while (!(await query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1", [prefix + "%"])).rowCount) {
                    assert.ok(Date.now() < deadline, "Expected a real PostgreSQL lock wait"); await delay(10);
                }
            }
            try {
                await checked("BEGIN"); await checked("SELECT album_id FROM album WHERE album_id=1 FOR UPDATE");
                const copy = db!.copyMediaToAlbum([1,2],1,2); copy.catch(() => {}); pending.push(copy);
                await waiting("SELECT album_id FROM album WHERE album_id = ANY");
                const deletion = db!.deleteMediaById(1, async () => {}, {
                    operationId: randomUUID(), mediaId: 1, target: `${fixture.root}/media-1.jpg`, original: null,
                }); deletion.catch(() => {}); pending.push(deletion);
                await waiting("SELECT pg_advisory_xact_lock(1296514892, 6)");
                await checked("COMMIT"); await Promise.all(pending);
                assert.deepEqual(await membership(1), [2]); assert.deepEqual(await membership(2), [2]);
                assert.deepEqual(await covers(), [2,2,null]);
            } finally { await checked("ROLLBACK"); await Promise.allSettled(pending); await blocker.end(); }
        });
        await t.test("existing invalid covers are repaired when an Album is mutated", async () => {
            await reset(); await seed(1, [1], 4);
            assert.equal(await db!.addMediaToAlbum(1, 1), 0);
            assert.deepEqual(await covers(), [1,null,null]);
        });
        await t.test("Album cover-update failure rolls memberships back", async () => {
            await reset(); await seed(1, [1,2]);
            await query(`CREATE FUNCTION public.collection_test_reject_cover() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN RAISE EXCEPTION 'fixture cover failure'; END $$`);
            await query("CREATE TRIGGER collection_test_cover BEFORE UPDATE ON album FOR EACH ROW EXECUTE FUNCTION public.collection_test_reject_cover()");
            try { await assert.rejects(db!.copyMediaToAlbum([1,2], 1, 2), /fixture cover failure/); }
            finally { await query("DROP TRIGGER collection_test_cover ON album"); await query("DROP FUNCTION public.collection_test_reject_cover()"); }
            assert.deepEqual(await membership(2), []); assert.deepEqual(await covers(), [1,null,null]);
        });
        await t.test("media deletion recalculates every affected Album and commits its receipt atomically", async () => {
            await reset(); await seed(1, [1,2]); await seed(2, [1,3]); await seed(3, [1]);
            const receipt = { operationId: randomUUID(), mediaId: 1, target: `${fixture.root}/media-1.jpg`, original: null };
            await db!.deleteMediaById(1, async () => {}, receipt);
            assert.deepEqual(await membership(1), [2]); assert.deepEqual(await membership(2), [3]);
            assert.deepEqual(await covers(), [2,3,null]);
            assert.equal((await query("SELECT operation_id FROM media_deletion_receipts")).rows[0].operation_id, receipt.operationId);
        });
        await t.test("receipt failure rolls media deletion, memberships and cover updates back", async () => {
            await reset(); await seed(1, [1,2]);
            const receipt = { operationId: randomUUID(), mediaId: 1, target: `${fixture.root}/media-1.jpg`, original: null };
            await query("INSERT INTO media_deletion_receipts(operation_id,media_id,target_path,original_identity) VALUES ($1,1,$2,'null'::jsonb)", [receipt.operationId, receipt.target]);
            await assert.rejects(db!.deleteMediaById(1, async () => {}, receipt), /duplicate key/);
            assert.deepEqual(await membership(1), [1,2]); assert.deepEqual(await covers(), [1,null,null]);
            assert.equal((await query("SELECT count(*)::int AS n FROM media")).rows[0].n, 4);
        });
        await t.test("deleting an Album cascades memberships but preserves media and other Albums", async () => {
            await reset(); await seed(1, [1,2]); await seed(2, [1]);
            assert.equal(await db!.deleteAlbum(1), true);
            assert.equal(await db!.deleteAlbum(1), false);
            assert.equal((await query("SELECT count(*)::int AS n FROM media")).rows[0].n, 4);
            assert.deepEqual(await membership(2), [1]); await covers();
        });
        await t.test("HTTP endpoints expose assignment conflicts and actual copy counts", async () => {
            await reset();
            const trip = await import("../app/api/trips/[tripId]/media/route");
            const album = await import("../app/api/albums/[albumId]/media/route");
            const request = (body: unknown) => new Request("http://fixture.invalid", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
            const tc = { params: Promise.resolve({ tripId: "1" }) }, ac = { params: Promise.resolve({ albumId: "1" }) };
            assert.equal((await trip.POST(request({ mediaIds: [1,2] }), tc)).status, 200);
            const blocked = await trip.POST(request({ mediaIds: [1,3] }), tc);
            assert.equal(blocked.status, 409); assert.deepEqual((await blocked.json()).mediaIds, [1]);
            assert.equal((await query("SELECT trip_id FROM media WHERE media_id=3")).rows[0].trip_id, null);
            await seed(1, [1,2]); await seed(2, [1]);
            const copied = await album.PATCH(request({ mediaIds: [1,2], targetAlbumId: 2, operation: "copy" }), ac);
            assert.equal(copied.status, 200); assert.equal((await copied.json()).affectedCount, 1);
            const invalid = await album.PATCH(request({ mediaIds: [1,3], targetAlbumId: 2, operation: "move" }), ac);
            assert.equal(invalid.status, 409);
            assert.equal((await album.PATCH(request({ mediaIds: [1], targetAlbumId: 1, operation: "move" }), ac)).status, 400);
            assert.equal((await trip.POST(request({ mediaIds: [3,3] }), tc)).status, 400);
            await covers();
        });
    } finally {
        if (db) await db.closeMediaDatabase(); restore?.(); await client.end();
        if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
    }
});
