import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { Pool, type PoolClient } from "pg";
import * as database from "./media-database";
import type { ImportedMedia } from "./media-import";

const image: ImportedMedia = {
    file: { fileName: "test.jpg", fileType: "IMAGE", fileSize: 100, absolutePath: "/test/test.jpg", extension: ".jpg" },
    media: {},
    image: {},
};
const video: ImportedMedia = {
    ...image,
    file: { ...image.file, fileName: "test.mp4", fileType: "VIDEO", extension: ".mp4" },
    image: undefined,
    video: {},
};

type Result = { rows: Record<string, unknown>[]; rowCount: number };
type Options = {
    failQuery?: number;
    failConnect?: number;
    failRollback?: boolean;
    response?: (sql: string) => Result | undefined;
};

// Every checkout is mocked, including a one-client capacity limit. No actual
// Pool.connect implementation, socket, or database query can run in these tests.
async function withPool<T>(options: Options, operation: (state: {
    clients: { releases: number }[];
    queries: string[];
    error: Error;
}) => Promise<T>): Promise<T> {
    const clients: { releases: number }[] = [];
    const queries: string[] = [];
    const error = new Error("injected query failure");
    let connects = 0;
    const checkout = mock.method(Pool.prototype, "connect", async () => {
        connects++;
        if (connects === options.failConnect) throw new Error("injected connection failure");
        assert.ok(clients.every(client => client.releases === 1), "Must not hold a client while checking out another");
        const state = { releases: 0 };
        clients.push(state);
        return {
            query: async (text: string) => {
                assert.equal(state.releases, 0, "Query after release");
                const sql = text.replace(/\s+/g, " ").trim();
                queries.push(sql);
                if (sql === "ROLLBACK" && options.failRollback) throw new Error("injected rollback failure");
                if (queries.length === options.failQuery) throw error;
                const response = options.response?.(sql);
                if (response) return response;
                if (sql.startsWith("SELECT media_id FROM media WHERE path")) return { rows: [], rowCount: 0 };
                return { rows: [{ media_id: 1, trip_id: 1, album_id: 1, country_id: 1, city_id: 1 }], rowCount: 1 };
            },
            release: () => { state.releases++; },
        } as unknown as PoolClient;
    });
    try {
        return await operation({ clients, queries, error });
    } finally {
        checkout.mock.restore();
        for (const client of clients) assert.equal(client.releases, 1, "Every acquired client must be released exactly once");
    }
}

const operations: Record<keyof typeof database, () => Promise<unknown>> = {
    findMediaByPath: () => database.findMediaByPath("/test/test.jpg"),
    insertImportedMedia: () => database.insertImportedMedia(image),
    updateImportedMedia: () => database.updateImportedMedia(1, image),
    createTrip: () => database.createTrip("trip"),
    getTrips: () => database.getTrips(),
    getTripById: () => database.getTripById(1),
    getMediaByTripId: () => database.getMediaByTripId(1),
    addMediaToTrip: () => database.addMediaToTrip(1, 1),
    removeMediaFromTrip: () => database.removeMediaFromTrip(1, 1),
    getMediaFileById: () => database.getMediaFileById(1),
    getMediaDetailsById: () => database.getMediaDetailsById(1),
    getAvailableMedia: () => database.getAvailableMedia(),
    moveMediaToTrip: () => database.moveMediaToTrip([1], 1, 2),
    deleteMediaById: () => database.deleteMediaById(1),
    getLibraryMedia: () => database.getLibraryMedia(),
    getAlbums: () => database.getAlbums(),
    createAlbum: () => database.createAlbum("album"),
    getAlbumById: () => database.getAlbumById(1),
    getMediaByAlbumId: () => database.getMediaByAlbumId(1),
    addMediaToAlbum: () => database.addMediaToAlbum(1, 1),
    removeMediaFromAlbum: () => database.removeMediaFromAlbum(1, 1),
    moveMediaToAlbum: () => database.moveMediaToAlbum([1], 1, 2),
    copyMediaToAlbum: () => database.copyMediaToAlbum([1], 1, 2),
    setMediaFavorite: () => database.setMediaFavorite(1, true),
    renameTrip: () => database.renameTrip(1, "trip"),
    deleteTrip: () => database.deleteTrip(1),
    renameAlbum: () => database.renameAlbum(1, "album"),
    deleteAlbum: () => database.deleteAlbum(1),
};

for (const [name, operation] of Object.entries(operations)) {
    test(`${name}: releases clients on success, every query failure, and checkout failure`, async () => {
        const count = await withPool({}, async ({ queries }) => { await operation(); return queries.length; });
        for (let failQuery = 1; failQuery <= count; failQuery++) {
            await withPool({ failQuery }, async ({ error }) => {
                await assert.rejects(operation, actual => actual === error);
            });
        }
        await withPool({ failConnect: 1 }, async () => {
            await assert.rejects(operation, /injected connection failure/);
        });
    });
}

test("duplicate import releases lookup client without acquiring a transaction client", async () => {
    await withPool({ response: () => ({ rows: [{ media_id: 7 }], rowCount: 1 }) }, async ({ clients, queries }) => {
        await assert.rejects(() => database.insertImportedMedia(image), /Media already exists with media_id: 7/);
        assert.equal(clients.length, 1);
        assert.equal(queries.length, 1);
    });
});

test("import releases lookup client before transaction checkout failure", async () => {
    await withPool({ failConnect: 2 }, async ({ clients }) => {
        await assert.rejects(() => database.insertImportedMedia(image), /injected connection failure/);
        assert.equal(clients.length, 1);
    });
});

test("image/video imports and updates preserve transaction order with one-client capacity", async () => {
    for (const imported of [image, video]) {
        for (const insert of [true, false]) {
            await withPool({}, async ({ clients, queries }) => {
                if (insert) assert.equal(await database.insertImportedMedia(imported), 1);
                else await database.updateImportedMedia(1, imported);
                const transaction = insert ? queries.slice(1) : queries;
                assert.equal(transaction[0], "BEGIN");
                assert.equal(transaction.at(-1), "COMMIT");
                assert.equal(transaction.length, 4);
                assert.equal(clients.length, insert ? 2 : 1);
            });
        }
    }
});

test("import validation and rollback failures still release transaction clients", async () => {
    for (const insert of [true, false]) {
        const invoke = () => insert
            ? database.insertImportedMedia(image, undefined, "city")
            : database.updateImportedMedia(1, image, undefined, "city");
        await withPool({}, async ({ queries }) => {
            await assert.rejects(invoke, /Cannot insert a city without a country/);
            assert.equal(queries.at(-1), "ROLLBACK");
        });
        await withPool({ failRollback: true }, async () => {
            await assert.rejects(invoke, /injected rollback failure/);
        });
    }
});

test("collection early returns release clients after rollback", async () => {
    await withPool({ response: () => ({ rows: [], rowCount: 0 }) }, async ({ queries }) => {
        assert.equal(await database.removeMediaFromAlbum(1, 1), false);
        assert.equal(queries.at(-1), "ROLLBACK");
    });
    await withPool({ response: () => ({ rows: [], rowCount: 0 }) }, async ({ queries }) => {
        assert.deepEqual(await database.moveMediaToTrip([1], 1, 2), [1]);
        assert.equal(queries.at(-1), "ROLLBACK");
    });
});
