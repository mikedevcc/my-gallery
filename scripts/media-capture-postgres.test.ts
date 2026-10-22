import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { Client, Pool, type PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { captureDateFromExif, formatCaptureDate } from "../lib/media-capture-date";
import { groupMediaByDate } from "../lib/media-grouping";
import { buildDestinationPath } from "./media-storage";
import { discover, pending, validateSql } from "./migrations/core";
import * as db from "./media-database";
import * as libraryRoute from "../app/api/media/route";
import * as detailsRoute from "../app/api/media/[mediaId]/route";
import type { ImportedMedia } from "./media-import";

test("M11-A PostgreSQL 17 migration, legacy preservation and capture-date round trips", { skip: !process.env.CAPTURE_PG_FIXTURE }, async t => {
    const file = process.env.CAPTURE_PG_FIXTURE!;
    const root = path.dirname(file);
    assert.match(root, /^\/tmp\/gallery-capture-pg-[a-zA-Z0-9_]+$/);
    assert.equal(await fs.realpath(root), root);
    const owner = await fs.lstat(root);
    assert.equal(owner.uid, process.getuid?.()); assert.equal(owner.mode & 0o777, 0o700);
    const f = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(f.root, root); assert.equal(f.directory, path.join(root, "data"));
    assert.equal(f.socket, path.join(root, "socket")); assert.equal(f.port, 55443);
    assert.equal(f.role, "capture_test"); assert.equal(f.database, "gallery_capture_dates_test");
    const identitySql = `SELECT current_database() AS database, current_user AS role,
        current_setting('data_directory') AS directory, current_setting('server_version_num')::int AS version,
        current_setting('unix_socket_directories') AS socket, current_setting('port')::int AS port,
        extract(epoch from pg_postmaster_start_time())::text AS started, inet_server_addr() IS NULL AS local`;
    let started: string | undefined;
    async function verify(client: Pick<Client, "query">, database = f.database) {
        const row = (await client.query(identitySql)).rows[0];
        assert.equal(row.database, database); assert.equal(row.role, f.role); assert.equal(row.directory, f.directory);
        assert.equal(row.socket, f.socket); assert.equal(row.port, f.port); assert.equal(row.local, true);
        assert.equal(Math.floor(row.version / 10000), 17);
        if (started) assert.equal(row.started, started); else started = row.started;
    }
    // This maintenance connection belongs solely to the newly provisioned cluster.
    const maintenance = new Client({ host: f.socket, port: f.port, user: f.role, database: "postgres" });
    await maintenance.connect();
    try {
        await verify(maintenance, "postgres");
        assert.equal((await maintenance.query("SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1) AS exists", [f.database])).rows[0].exists, false, "Fresh disposable database required; do not reset/reuse one implicitly");
        await verify(maintenance, "postgres");
        await maintenance.query("CREATE DATABASE gallery_capture_dates_test");
    } finally { await maintenance.end(); }
    const client = new Client({ host: f.socket, port: f.port, user: f.role, database: f.database });
    await client.connect(); await verify(client);
    const checked = async (sql: string, values?: unknown[]) => { await verify(client); return client.query(sql, values); };
    const previousUrl = process.env.DATABASE_URL, previousRoot = process.env.MEDIA_STORAGE_ROOT, previousTz = process.env.TZ;
    let zone = "UTC";
    const originalConnect = Pool.prototype.connect as (this: Pool) => Promise<PoolClient>;
    // Every production checkout and every query is bound to this positively
    // verified cluster/database. Only rollback bypasses probing in a failed tx.
    Pool.prototype.connect = (async function(this: Pool) {
        const connection = await originalConnect.call(this), raw = connection.query.bind(connection);
        const probe = { query: raw } as Pick<Client, "query">;
        try {
            await verify(probe);
            await raw("SELECT set_config('TimeZone',$1,false)", [zone]);
            await verify(probe); await raw("SET statement_timeout='5s'");
        } catch (error) { connection.release(); throw error; }
        return { query: async (sql: string, values?: unknown[]) => {
            if (sql !== "ROLLBACK") await verify(probe);
            return raw(sql, values);
        }, release: connection.release.bind(connection) } as unknown as PoolClient;
    }) as typeof Pool.prototype.connect;
    process.env.DATABASE_URL = `postgresql://capture_test@${encodeURIComponent(f.socket)}:55443/gallery_capture_dates_test`;
    process.env.MEDIA_STORAGE_ROOT = path.join(root, "media-fixtures");
    try {
        const migrations = await discover(path.resolve("db/migrations"));
        const captureMigration = migrations.find(m => m.version === 4)!;
        validateSql(captureMigration.sql);
        assert.deepEqual(pending(migrations, migrations.slice(0, 3).map(m => ({ ...m, applied_at: new Date() }))).map(m => m.version), [4]);
        for (const migration of migrations.slice(0, 3)) {
            await checked("BEGIN");
            try { await checked(migration.sql); await checked("COMMIT"); }
            catch (error) { await client.query("ROLLBACK"); throw error; }
        }
        const before = (await checked(`INSERT INTO media(file_name,file_type,file_size,path,date_taken)
            VALUES ('legacy.jpg','IMAGE',10,$1,'2019-12-31T23:45:00.123456Z') RETURNING *`, [path.join(root, "legacy.jpg")])).rows[0];
        const beforeSnapshot = (await checked("SELECT to_jsonb(m) AS snapshot FROM media m WHERE media_id=$1", [before.media_id])).rows[0].snapshot;
        await checked("BEGIN");
        try { await checked(captureMigration.sql); await checked("COMMIT"); }
        catch (error) { await client.query("ROLLBACK"); throw error; }
        await t.test("0004 adds only nullable capture fields and preserves every legacy value", async () => {
            const after = (await checked("SELECT to_jsonb(m) AS snapshot FROM media m WHERE media_id=$1", [before.media_id])).rows[0].snapshot;
            const { capture_local, capture_offset_minutes, ...old } = after;
            assert.equal(capture_local, null); assert.equal(capture_offset_minutes, null); assert.deepEqual(old, beforeSnapshot);
            const details = await db.getMediaDetailsById(before.media_id);
            assert.equal(details!.date_taken!.toISOString(), "2019-12-31T23:45:00.123Z");
        });
        await checked("INSERT INTO trip(trip_name) VALUES ('Fixture trip')");
        await checked("INSERT INTO album(album_name) VALUES ('Fixture album')");
        let chosen = 0;
        const cases: { raw: string | undefined; day: string; year: string; offset?: string }[] = [
            { raw: "2026:01:01 00:15:00+08:00", day: "1 January 2026", year: "2026" },
            { raw: "2025:12:31 23:45:00-08:00", day: "31 December 2025", year: "2025" },
            { raw: "2026:03:08 02:30:00", day: "8 March 2026", year: "2026" },
            { raw: "2026:11:01 01:30:00-07:00", day: "1 November 2026", year: "2026" },
            { raw: "2026:11:01 01:30:00-08:00", day: "1 November 2026", year: "2026" },
            { raw: "2026:11:01 01:30:00", day: "1 November 2026", year: "2026" },
            { raw: "2024:02:29 23:59:59.123456Z", day: "29 February 2024", year: "2024" },
            { raw: "2026:01:01 00:15:00", offset: "+05:30", day: "1 January 2026", year: "2026" },
            { raw: undefined, day: "Capture date unknown", year: "Unknown" },
        ];
        for (const tz of ["UTC", "Asia/Singapore", "America/Los_Angeles"]) await t.test(`real writes, API DTOs and grouping with Node/PostgreSQL timezone ${tz}`, async () => {
            zone = tz; process.env.TZ = tz;
            for (const [i, sample] of cases.entries()) {
                const capture = captureDateFromExif(sample.raw ? { DateTimeOriginal: sample.raw, OffsetTimeOriginal: sample.offset } : {});
                const imported: ImportedMedia = { file: { fileName: `${tz.replaceAll("/", "-")}-${i}.jpg`, fileType: "IMAGE", extension: ".jpg", fileSize: 10, absolutePath: "" }, media: { ...capture }, image: {} };
                imported.file.absolutePath = buildDestinationPath(imported, "Fixture");
                assert.equal(path.relative(process.env.MEDIA_STORAGE_ROOT!, imported.file.absolutePath).split(path.sep)[0], sample.year);
                const id = await db.insertImportedMedia(imported);
                if (!chosen) chosen = id;
                const response = await detailsRoute.GET(new Request("http://fixture.invalid"), { params: Promise.resolve({ mediaId: String(id) }) });
                assert.equal(response.status, 200);
                const dto = await response.json();
                assert.equal(dto.capture_local, capture?.captureLocal ?? null);
                assert.equal(dto.capture_offset_minutes, capture?.captureOffsetMinutes ?? null);
                assert.equal(dto.date_taken, capture?.dateTaken?.toISOString() ?? null);
                assert.equal(typeof dto.capture_local === "string" || dto.capture_local === null, true);
                assert.equal(dto.path, undefined);
                assert.equal(groupMediaByDate([dto], "Days")[0][0], sample.day);
                if (!capture) assert.equal(formatCaptureDate(dto), "Capture date unknown");
            }
            const response = await libraryRoute.GET(new Request("http://fixture.invalid/api/media?scope=all"));
            assert.equal(response.status, 200);
            const rows = await response.json();
            assert.ok(rows.some((r: { capture_local: string }) => r.capture_local === "2026-01-01T00:15:00.000"));
            assert.ok(rows.some((r: { media_id: number; capture_local: unknown }) => r.media_id === before.media_id && r.capture_local === null));
            const east = rows.findIndex((r: { file_name: string }) => r.file_name === `${tz.replaceAll("/", "-")}-0.jpg`);
            const west = rows.findIndex((r: { file_name: string }) => r.file_name === `${tz.replaceAll("/", "-")}-1.jpg`);
            assert.ok(east < west, "sort by camera calendar, not opposite-year UTC instants");
        });
        await t.test("Trip, Album and available-media reads preserve wall-clock text", async () => {
            assert.equal(typeof (await db.getAvailableMedia()).find(m => m.media_id === chosen)!.capture_local, "string");
            await db.addMediaToTrip(chosen, 1); await db.addMediaToAlbum(chosen, 1);
            for (const rows of [await db.getMediaByTripId(1), await db.getMediaByAlbumId(1)]) {
                assert.equal(rows[0].capture_local, "2026-01-01T00:15:00.000"); assert.equal(rows[0].capture_offset_minutes, 480);
            }
        });
        await t.test("replacement metadata and receipt commit together; receipt failure rolls capture fields back", async () => {
            const current = await db.getMediaFileById(chosen);
            const receipt = { operationId: randomUUID(), mediaId: chosen, target: current!.path, originalSha256: "a".repeat(64), incomingSha256: "b".repeat(64) };
            const imported: ImportedMedia = { file: { fileName: current!.file_name, fileType: "IMAGE", extension: ".jpg", fileSize: 10, absolutePath: current!.path }, media: { ...captureDateFromExif({ DateTimeOriginal: "2027:01:01 00:10:00" }) }, image: {} };
            let checks = 0;
            await db.updateImportedMedia(chosen, imported, undefined, undefined, { receipt, assertStorage: async () => { checks++; } });
            const after = await db.getMediaDetailsById(chosen);
            assert.equal(after!.capture_local, "2027-01-01T00:10:00.000"); assert.equal(after!.date_taken, null); assert.ok(checks > 0);
            assert.ok(await db.getReplacementReceipt(receipt.operationId));
            await assert.rejects(db.updateImportedMedia(chosen, { ...imported, media: { ...captureDateFromExif({ DateTimeOriginal: "2028:01:01 00:10:00+08:00" }) } }, undefined, undefined, { receipt, assertStorage: async () => {} }), { code: "23505" });
            assert.deepEqual(await db.getMediaDetailsById(chosen), after);
        });
        await t.test("constraints reject fabricated instants, inconsistent offsets and orphan offsets", async () => {
            for (const [local, offset, instant] of [
                ["2026-01-01T00:00:00", null, "2026-01-01T00:00:00Z"],
                ["2026-01-01T00:00:00", 480, "2026-01-01T00:00:00Z"],
                [null, 480, "2026-01-01T00:00:00Z"],
                ["2026-01-01T00:00:00", 841, "2025-12-31T09:59:00Z"],
            ]) {
                await checked("BEGIN");
                try {
                    await assert.rejects(checked(`INSERT INTO media(file_name,file_type,file_size,path,capture_local,capture_offset_minutes,date_taken)
                        VALUES ('invalid.jpg','IMAGE',10,$1,$2::timestamp,$3,$4::timestamptz)`, [path.join(root, randomUUID()), local, offset, instant]), { code: "23514" });
                } finally { await client.query("ROLLBACK"); }
            }
        });
    } finally {
        await db.closeMediaDatabase(); Pool.prototype.connect = originalConnect as typeof Pool.prototype.connect;
        await client.end();
        if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl;
        if (previousRoot === undefined) delete process.env.MEDIA_STORAGE_ROOT; else process.env.MEDIA_STORAGE_ROOT = previousRoot;
        if (previousTz === undefined) delete process.env.TZ; else process.env.TZ = previousTz;
    }
});
