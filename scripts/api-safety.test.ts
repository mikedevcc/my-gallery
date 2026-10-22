import assert from "node:assert/strict";
import { test, mock } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Pool, type PoolClient } from "pg";
import * as albums from "../app/api/albums/route";
import * as album from "../app/api/albums/[albumId]/route";
import * as albumMedia from "../app/api/albums/[albumId]/media/route";
import * as trips from "../app/api/trips/route";
import * as trip from "../app/api/trips/[tripId]/route";
import * as tripMedia from "../app/api/trips/[tripId]/media/route";
import * as media from "../app/api/media/[mediaId]/route";
import * as library from "../app/api/media/route";
import * as file from "../app/api/media/[mediaId]/file/route";
import * as thumbnail from "../app/api/media/[mediaId]/thumbnail/route";
import * as conflicts from "../app/api/import/conflict/route";
import * as previews from "../app/api/import/conflict/preview/route";
import { publicImportConflict, publicMedia } from "./api-dto";
import { processingErrorResponse, ProcessingError } from "./processing-limits";
import { safeApiError } from "./api-safety";
import { logApiFailure } from "./api-diagnostics";
import { mockStorageMount, writeTestStorageMarker, testFilesystemUuid, testInstallationId } from "./testing/storage-fixture";

process.env.DATABASE_URL = "postgresql://offline:unused@database.example.invalid:5432/gallery";
const secret = "PRIVATE_PASSWORD_974";
const privatePath = "/srv/private-volume/private-photo.jpg";
const storageId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const context = (id = "1") => ({ params: Promise.resolve({ albumId: id, tripId: id, mediaId: id }) });
const request = (body: unknown) => new Request("http://fixture.invalid", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const rawRequest = (body: string) => new Request("http://fixture.invalid", { method: "POST", headers: { "Content-Type": "application/json" }, body });
type Reply = (sql: string, values: unknown[]) => { rows: Record<string, unknown>[]; rowCount: number };
async function database(work: (state: { sql: string[]; values: unknown[][]; checkouts: () => number }) => Promise<void>, reply?: Reply) {
    let checkouts = 0, releases = 0;
    const sql: string[] = [], values: unknown[][] = [];
    const log = mock.method(console, "error", () => {});
    const connect = mock.method(Pool.prototype, "connect", async () => {
        checkouts++;
        return { query: async (text: string, parameters: unknown[] = []) => {
            const query = text.replace(/\s+/g, " ").trim(); sql.push(query); values.push(parameters);
            if (reply) return reply(query, parameters);
            return { rows: [{ album_id: 1, trip_id: 1, media_id: 1 }], rowCount: 1 };
        }, release: () => { releases++; } } as unknown as PoolClient;
    });
    try { await work({ sql, values, checkouts: () => checkouts }); assert.equal(checkouts, releases); }
    finally { connect.mock.restore(); log.mock.restore(); }
}
const mutations = [
    (r: Request) => albums.POST(r), (r: Request) => trips.POST(r),
    (r: Request) => album.PATCH(r, context()), (r: Request) => trip.PATCH(r, context()),
    (r: Request) => albumMedia.POST(r, context()), (r: Request) => albumMedia.DELETE(r, context()), (r: Request) => albumMedia.PATCH(r, context()),
    (r: Request) => tripMedia.POST(r, context()), (r: Request) => tripMedia.DELETE(r, context()), (r: Request) => tripMedia.PATCH(r, context()),
    (r: Request) => media.PATCH(r, context()), (r: Request) => conflicts.POST(r),
];
function noDisclosure(text: string) {
    for (const value of [secret, privatePath, storageId, "postgresql://", "stack trace", "raw internal failure"]) assert.ok(!text.includes(value), `Disclosed ${value}`);
}

test("all JSON mutation endpoints reject malformed, null and non-object bodies before checkout", () => database(async state => {
    for (const mutate of mutations) {
        for (const body of ["", "{", "null", "[]", '"text"', "true", "123"]) {
            const response = await mutate(rawRequest(body));
            assert.equal(response.status, 400, body); noDisclosure(await response.text());
        }
    }
    assert.equal(state.checkouts(), 0); assert.deepEqual(state.sql, []);
}));
test("collection name type, emptiness, NUL, UTF-16 and 101-character violations never execute SQL", () => database(async state => {
    const routes = [
        { key: "albumName", run: (r: Request) => albums.POST(r) }, { key: "tripName", run: (r: Request) => trips.POST(r) },
        { key: "albumName", run: (r: Request) => album.PATCH(r, context()) }, { key: "tripName", run: (r: Request) => trip.PATCH(r, context()) },
    ];
    for (const route of routes) for (const name of [undefined, null, 1, true, [], {}, "", "  ", "a".repeat(101), "🌈".repeat(101), "a\0b", "\ud800"]) {
        const response = await route.run(request({ [route.key]: name })); assert.equal(response.status, 400);
    }
    assert.equal(state.checkouts(), 0);
}));
test("creation and rename accept exactly 100 PostgreSQL characters and preserve trimming", () => database(async state => {
    for (const name of ["  Gallery  ", "a".repeat(100), "🌈".repeat(100)]) {
        for (const [key, run, status] of [
            ["albumName", (r: Request) => albums.POST(r), 200], ["tripName", (r: Request) => trips.POST(r), 201],
            ["albumName", (r: Request) => album.PATCH(r, context()), 200], ["tripName", (r: Request) => trip.PATCH(r, context()), 200],
        ] as const) {
            const response = await run(request({ [key]: name })); assert.equal(response.status, status);
            assert.ok(state.values.at(-1)!.includes(name.trim()));
        }
    }
}));
test("path IDs reject PostgreSQL overflows and noncanonical numeric forms on reads and mutations", () => database(async state => {
    const routes = [
        (id: string) => album.GET(request({}), context(id)), (id: string) => trip.GET(request({}), context(id)),
        (id: string) => album.PATCH(request({ albumName: "ok" }), context(id)), (id: string) => trip.PATCH(request({ tripName: "ok" }), context(id)),
        (id: string) => album.DELETE(request({}), context(id)), (id: string) => trip.DELETE(request({}), context(id)),
        (id: string) => albumMedia.POST(request({ mediaId: 1 }), context(id)), (id: string) => tripMedia.POST(request({ mediaId: 1 }), context(id)),
        (id: string) => media.GET(request({}), context(id)), (id: string) => media.DELETE(request({}), context(id)),
        (id: string) => file.GET(new Request("http://fixture.invalid"), context(id)),
        (id: string) => thumbnail.GET(request({}), context(id)),
    ];
    for (const run of routes) for (const id of ["0", "-1", "1.5", "1e0", "0x10", "+1", " 1", "01", "NaN", "2147483648", "9007199254740992"]) assert.equal((await run(id)).status, 400);
    assert.equal(state.checkouts(), 0);
    assert.equal((await album.PATCH(request({ albumName: "ok" }), context("2147483647"))).status, 200);
    assert.ok(state.values.at(-1)!.includes(2147483647));
}));
test("wrong body IDs, bulk selections and operation types cannot partially mutate collections", () => database(async state => {
    for (const id of [null, "1", true, {}, [], 0, -1, 1.5, 2147483648, Number.MAX_SAFE_INTEGER]) {
        assert.equal((await albumMedia.POST(request({ mediaId: id }), context())).status, 400);
        assert.equal((await tripMedia.POST(request({ mediaId: id }), context())).status, 400);
        assert.equal((await albumMedia.DELETE(request({ mediaId: id }), context())).status, 400);
        assert.equal((await tripMedia.DELETE(request({ mediaId: id }), context())).status, 400);
        assert.equal((await albumMedia.PATCH(request({ mediaIds: [1], targetAlbumId: id, operation: "copy" }), context())).status, 400);
        assert.equal((await tripMedia.PATCH(request({ mediaIds: [1], targetTripId: id }), context())).status, 400);
    }
    for (const ids of [null, {}, [], [1,1], [1,"2"], [1,null], [1,2147483648], [true]]) {
        assert.equal((await tripMedia.POST(request({ mediaIds: ids }), context())).status, 400);
        assert.equal((await albumMedia.PATCH(request({ mediaIds: ids, targetAlbumId: 2, operation: "copy" }), context())).status, 400);
    }
    for (const operation of [null, 1, ["copy"], {}, "unknown"]) assert.equal((await albumMedia.PATCH(request({ mediaIds: [1], targetAlbumId: 2, operation }), context())).status, 400);
    assert.equal((await tripMedia.POST(request({ mediaId: 1, mediaIds: [2] }), context())).status, 400);
    assert.equal(state.checkouts(), 0);
}));
test("favorite accepts only a boolean, including false, and validates the largest integer ID", () => database(async state => {
    for (const favorite of [null, undefined, "false", 0, 1, [], {}]) assert.equal((await media.PATCH(request({ favorite }), context())).status, 400);
    assert.equal(state.checkouts(), 0);
    assert.equal((await media.PATCH(request({ favorite: false }), context("2147483647"))).status, 200);
    assert.deepEqual(state.values.at(-1), [2147483647, false]);
}));
test("genuine assignment and database uniqueness conflicts return 409 without partial updates", () => database(async state => {
    const response = await tripMedia.POST(request({ mediaIds: [1,2] }), context());
    assert.equal(response.status, 409); assert.deepEqual((await response.json()).mediaIds, [2]);
    assert.ok(!state.sql.some(sql => sql.startsWith("UPDATE"))); assert.equal(state.sql.at(-1), "ROLLBACK");
}, sql => {
    if (sql.startsWith("SELECT trip_id")) return { rows: [{ trip_id: 1 }], rowCount: 1 };
    if (sql.startsWith("SELECT media_id, trip_id")) return { rows: [{ media_id: 1, trip_id: null }, { media_id: 2, trip_id: 3 }], rowCount: 2 };
    return { rows: [], rowCount: 0 };
}));
test("unexpected exceptions and SQL conflict details stay out of API responses and logs", async () => {
    const failure = Object.assign(new Error(`raw internal failure ${privatePath} postgresql://role:${secret}@host/db ${storageId}`), {
        code: "XX000", detail: secret, parameters: [secret], input: secret,
        cause: Object.assign(new Error(secret), { code: "28P01" }),
    });
    const routes = [
        () => albums.GET(), () => trips.GET(), () => albums.POST(request({ albumName: "ok" })), () => trips.POST(request({ tripName: "ok" })),
        () => album.GET(request({}), context()), () => trip.GET(request({}), context()),
        () => album.PATCH(request({ albumName: "ok" }), context()), () => trip.PATCH(request({ tripName: "ok" }), context()),
        () => album.DELETE(request({}), context()), () => trip.DELETE(request({}), context()),
        () => media.GET(request({}), context()), () => media.DELETE(request({}), context()), () => media.PATCH(request({ favorite: true }), context()),
        () => library.GET(new Request("http://fixture.invalid?scope=all")), () => thumbnail.GET(request({}), context()),
        () => file.GET(new Request("http://fixture.invalid"), context()),
        () => albumMedia.POST(request({ mediaId: 1 }), context()), () => tripMedia.POST(request({ mediaId: 1 }), context()),
    ];
    const logs = mock.method(console, "error", () => {});
    const connect = mock.method(Pool.prototype, "connect", async () => { throw failure; });
    try {
        for (const run of routes) { const response = await run(); assert.equal(response.status, 500); noDisclosure(await response.text()); }
        failure.code = "23505";
        const response = await albums.POST(request({ albumName: "ok" })); assert.equal(response.status, 409); noDisclosure(await response.text());
        const logId = logApiFailure("sanitization-test", new AggregateError([failure], secret, { cause: failure }));
        assert.match(logId, /^[0-9a-f-]{36}$/);
        const configLikeSecret = "MEDIA_PASSWORD_SHOULD_NEVER_BE_LOGGED";
        logApiFailure("secret-redaction", new Error(`postgresql://role:${configLikeSecret}@host/db`));
        const recorded = JSON.stringify(logs.mock.calls.map(call => call.arguments)); noDisclosure(recorded);
        assert.ok(!recorded.includes(configLikeSecret));
        assert.match(recorded, /23505/); assert.match(recorded, /28P01/); assert.match(recorded, /api-safety.test.ts/);
    } finally { connect.mock.restore(); logs.mock.restore(); }
});
test("all public read DTOs discard paths, storage identities, credentials and future internal fields", () => database(async () => {
    for (const run of [() => albums.GET(), () => trips.GET(), () => album.GET(request({}), context()), () => trip.GET(request({}), context()),
        () => media.GET(request({}), context()), () => library.GET(new Request("http://fixture.invalid?scope=all"))]) {
        const response = await run(); assert.equal(response.status, 200);
        const text = await response.text(); noDisclosure(text);
        assert.ok(!text.includes('"path"')); assert.ok(!text.includes('"storage_uuid"'));
    }
}, () => ({ rows: [{ album_id: 1, trip_id: 1, album_name: "Album", trip_name: "Trip", media_id: 1, file_name: "safe.jpg", file_type: "IMAGE",
    cover_media_id: 1, media_count: 1, path: privatePath, storage_uuid: storageId, password: secret, stack: "stack trace", future_internal_field: secret }], rowCount: 1 })));
test("import conflict DTOs contain only public names and opaque IDs", async () => {
    const conflict = { type: "FILENAME" as const, jobId: "job", conflictId: "12ec0585-07cb-4e3c-9d84-1ec28cb40a82", existingMediaId: 7, existingPath: privatePath, secret };
    const dto = publicImportConflict(conflict);
    assert.deepEqual(dto, { type: "FILENAME", jobId: "job", conflictId: conflict.conflictId, existingMediaId: 7, existingFilename: "private-photo.jpg" });
    noDisclosure(JSON.stringify(dto)); assert.equal(conflict.existingPath, privatePath);
    const legacy = publicMedia({ file_name: privatePath, path: privatePath });
    assert.deepEqual(legacy, { file_name: "private-photo.jpg" });
    noDisclosure(JSON.stringify(legacy));
});
test("pending conflict HTTP responses sanitize persisted evidence without changing it", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "gallery-api-safety-"));
    await writeTestStorageMarker(root); const mount = await mockStorageMount(root);
    const id = "12ec0585-07cb-4e3c-9d84-1ec28cb40a82", incoming = path.join(root, ".incoming", id);
    const logs = mock.method(console, "error", () => {});
    try {
        await fs.mkdir(incoming, { recursive: true }); await fs.writeFile(path.join(incoming, "safe.jpg"), "fixture");
        const evidence = JSON.stringify({ type: "FILENAME", jobId: "job", conflictId: id, existingPath: path.join(root, "safe.jpg"), secret, storage_uuid: testFilesystemUuid });
        await fs.writeFile(path.join(incoming, ".conflict.json"), evidence);
        const response = await conflicts.GET(new Request("http://fixture.invalid")); assert.equal(response.status, 200);
        const text = await response.text();
        for (const hidden of [root, secret, testFilesystemUuid, testInstallationId, "existingPath"]) assert.ok(!text.includes(hidden));
        assert.equal(JSON.parse(text).conflicts[0].existingFilename, "safe.jpg");
        assert.equal(await fs.readFile(path.join(incoming, ".conflict.json"), "utf8"), evidence);
        mount.state.mounted = false;
        const unavailable = await conflicts.GET(new Request("http://fixture.invalid")); assert.equal(unavailable.status, 503);
        assert.ok(!(await unavailable.text()).includes(root));
    } finally { logs.mock.restore(); mount.restore(); await fs.rm(root, { recursive: true, force: true }); }
});
test("invalid conflict IDs, actions and preview sides are rejected before filesystem or database work", () => database(async state => {
    for (const body of [{ conflictId: 1, action: "SKIP" }, { conflictId: [], action: "SKIP" }, { conflictId: "../../private", action: "REPLACE" },
        { conflictId: "12ec0585-07cb-4e3c-9d84-1ec28cb40a82", action: ["SKIP"] }]) assert.equal((await conflicts.POST(request(body))).status, 400);
    assert.equal((await previews.GET(new Request("http://fixture.invalid?id=../../private&side=incoming"))).status, 400);
    assert.equal((await previews.HEAD(new Request("http://fixture.invalid?id=bad&side=incoming", { method: "HEAD" }))).body, null);
    assert.equal(state.checkouts(), 0);
}));
test("resource errors use generic messages while preserving status, retry and correlation headers", () => database(async () => {
    for (const status of [400,409,413,415,422,503,504,507]) {
        const response = processingErrorResponse(new ProcessingError(`${privatePath} ${secret} ${storageId}`, status));
        assert.equal(response.status, status); noDisclosure(await response.text());
        assert.equal(response.headers.get("cache-control"), "no-store"); assert.ok(response.headers.get("x-request-id"));
        if (status === 503) assert.equal(response.headers.get("retry-after"), "5");
    }
    noDisclosure(await safeApiError(new Error(secret), "unknown").text());
}));

test("a failed diagnostic sink cannot replace the safe response or expose its exception", async () => {
    const sink = mock.method(console, "error", () => { throw new Error(secret); });
    try {
        const response = processingErrorResponse(new Error(privatePath));
        assert.equal(response.status, 500); noDisclosure(await response.text());
    } finally { sink.mock.restore(); }
});
