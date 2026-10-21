import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { Pool, type PoolClient } from "pg";
import * as database from "./media-database";
import type { ImportedMedia } from "./media-import";

// Explicit inert target; every checkout is mocked below. Never inherit a real URL.
process.env.DATABASE_URL = "postgresql://offline:offline@database.invalid:5432/gallery_test";

const deletionReceipt = { operationId: "12345678-1234-4234-8234-123456789abc", mediaId: 1, target: "/test/test.jpg", original: { sha256: "a".repeat(64), size: "100", device: "1", inode: "2" } };

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
    parameters: unknown[][];
    error: Error;
}) => Promise<T>): Promise<T> {
    const clients: { releases: number }[] = [];
    const queries: string[] = [];
    const parameters: unknown[][] = [];
    const error = new Error("injected query failure");
    let connects = 0;
    const checkout = mock.method(Pool.prototype, "connect", async () => {
        connects++;
        if (connects === options.failConnect) throw new Error("injected connection failure");
        assert.ok(clients.every(client => client.releases === 1), "Must not hold a client while checking out another");
        const state = { releases: 0 };
        clients.push(state);
        return {
            query: async (text: string, values: unknown[] = []) => {
                assert.equal(state.releases, 0, "Query after release");
                const sql = text.replace(/\s+/g, " ").trim();
                queries.push(sql);
                parameters.push(values);
                if (sql === "ROLLBACK" && options.failRollback) throw new Error("injected rollback failure");
                if (queries.length === options.failQuery) throw error;
                const response = options.response?.(sql);
                if (response) return response;
                if (sql.includes("pg_is_in_recovery")) return { rows: [{ standby: false }], rowCount: 1 };
                if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ locked: true }], rowCount: 1 };
                if (sql.includes("FROM public.media_replacement_receipts")) return { rows: [], rowCount: 0 };
                if (sql.startsWith("SELECT media_id FROM media WHERE path")) return { rows: [], rowCount: 0 };
                return { rows: [{ media_id: 1, path: "/test/test.jpg", trip_id: 1, album_id: 1, country_id: 1, city_id: 1 }], rowCount: 1 };
            },
            release: () => { state.releases++; },
        } as unknown as PoolClient;
    });
    try {
        return await operation({ clients, queries, parameters, error });
    } finally {
        checkout.mock.restore();
        for (const client of clients) assert.equal(client.releases, 1, "Every acquired client must be released exactly once");
    }
}

const operations: Record<Exclude<keyof typeof database, "closeMediaDatabase">, () => Promise<unknown>> = {
    withDeletionRecoveryDatabase: () => database.withDeletionRecoveryDatabase(deletionReceipt.operationId, 1, deletionReceipt.target, async () => {}),
    withReplacementRecoveryDatabase: () => database.withReplacementRecoveryDatabase("12345678-1234-4234-8234-123456789abc", 1, async value => value),
    getReplacementReceipt: () => database.getReplacementReceipt("12345678-1234-4234-8234-123456789abc"),
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
    deleteMediaById: () => database.deleteMediaById(1, async () => {}, deletionReceipt),
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

const receipt = {
    operationId: "12345678-1234-4234-8234-123456789abc", mediaId: 1,
    target: image.file.absolutePath, originalSha256: "a".repeat(64), incomingSha256: "b".repeat(64),
};

test("replacement receipt and metadata use the same transaction and guarded durable commit", async () => {
    await withPool({}, async ({ queries, parameters }) => {
        let guarded = false;
        await database.updateImportedMedia(1, image, undefined, undefined, {
            receipt, assertStorage: async () => { guarded = true; assert.match(queries.at(-1)!, /INSERT INTO public.media_replacement_receipts/); },
        });
        assert.equal(guarded, true);
        assert.equal(queries[0], "BEGIN");
        assert.equal(queries[1], "SET LOCAL synchronous_commit = on");
        assert.match(queries[2], /pg_try_advisory_xact_lock/);
        assert.match(queries[3], /UPDATE media/);
        assert.match(queries[4], /UPDATE image/);
        assert.match(queries[5], /INSERT INTO public.media_replacement_receipts/);
        assert.equal(queries[6], "COMMIT");
        assert.deepEqual(parameters[5], [receipt.operationId, receipt.mediaId, receipt.target, receipt.originalSha256, receipt.incomingSha256]);
    });
});

test("receipt insert, metadata, guard, and COMMIT failures roll back and release", async () => {
    for (const failQuery of [3, 4, 5, 6, 7]) {
        await withPool({ failQuery }, async ({ queries }) => {
            await assert.rejects(database.updateImportedMedia(1, image, undefined, undefined, { receipt, assertStorage: async () => {} }));
            assert.equal(queries.at(-1), "ROLLBACK");
        });
    }
    await withPool({}, async ({ queries }) => {
        await assert.rejects(database.updateImportedMedia(1, image, undefined, undefined, {
            receipt, assertStorage: async () => { throw new Error("storage lost"); },
        }), /storage lost/);
        assert.equal(queries.at(-1), "ROLLBACK");
        assert.ok(!queries.includes("COMMIT"));
    });
});

test("no receipt can commit for a missing media row or mismatched target", async () => {
    await withPool({ response: sql => sql.startsWith("UPDATE media") ? { rows: [], rowCount: 0 } : undefined }, async ({ queries }) => {
        await assert.rejects(database.updateImportedMedia(1, image, undefined, undefined, { receipt, assertStorage: async () => {} }), /no longer exists/);
        assert.ok(!queries.some(sql => sql.startsWith("INSERT INTO public.media_replacement_receipts")));
    });
    await withPool({}, async ({ clients }) => {
        await assert.rejects(database.updateImportedMedia(2, image, undefined, undefined, { receipt, assertStorage: async () => {} }), /does not match/);
        assert.equal(clients.length, 0);
    });
});

test("deletion receipt and expected path are written before COMMIT in the deletion transaction", async () => {
    let validations = 0;
    await withPool({}, async ({ queries, parameters }) => {
        await database.deleteMediaById(1, async () => { validations++; }, deletionReceipt);
        assert.equal(validations, 2);
        assert.equal(queries[0], "BEGIN");
        assert.equal(queries[1], "SET LOCAL synchronous_commit = on");
        assert.match(queries[2], /pg_try_advisory_xact_lock/);
        const deletion = queries.findIndex(sql => sql.startsWith("DELETE"));
        assert.deepEqual(parameters[deletion], [1, deletionReceipt.target]);
        assert.match(queries[deletion], /AND path = \$2/);
        assert.match(queries[deletion + 1], /INSERT INTO public.media_deletion_receipts/);
        assert.deepEqual(parameters[deletion + 1], [deletionReceipt.operationId, 1, deletionReceipt.target, JSON.stringify(deletionReceipt.original)]);
        assert.equal(queries.at(-1), "COMMIT");
    });
});

test("receipt insertion failure rolls metadata deletion back", async () => {
    await withPool({ failQuery: 5 }, async ({ queries, error }) => {
        await assert.rejects(database.deleteMediaById(1, async () => {}, deletionReceipt), actual => actual === error);
        assert.match(queries[4], /INSERT INTO public.media_deletion_receipts/);
        assert.equal(queries.at(-1), "ROLLBACK");
        assert.ok(!queries.includes("COMMIT"));
    });
});

test("changed deletion path rolls back without writing a receipt", async () => {
    await withPool({ response: sql => sql.startsWith("DELETE") ? { rows: [], rowCount: 0 } : undefined }, async ({ queries }) => {
        await assert.rejects(database.deleteMediaById(1, async () => {}, deletionReceipt), /metadata changed/);
        assert.equal(queries.at(-1), "ROLLBACK");
        assert.ok(!queries.some(sql => sql.startsWith("INSERT")));
    });
});


test("deletion recovery takes advisory lock before fresh receipt and path-reuse reads", async () => {
    await withPool({ response: sql => {
        if (sql.includes("FROM public.media_deletion_receipts")) return { rows: [deletionReceipt], rowCount: 1 };
        if (sql.startsWith("SELECT media_id, path FROM public.media")) return { rows: [], rowCount: 0 };
    } }, async ({ queries, parameters }) => {
        await database.withDeletionRecoveryDatabase(deletionReceipt.operationId, 1, deletionReceipt.target, async evidence => {
            assert.deepEqual(evidence, { receipt: deletionReceipt, media: [] });
            assert.equal(queries[0], "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
            assert.match(queries[1], /pg_is_in_recovery/);
            assert.match(queries[2], /pg_try_advisory_xact_lock/);
            assert.match(queries[3], /media_deletion_receipts/);
            assert.match(queries[4], /media_id=\$1 OR path=\$2/);
            assert.deepEqual(parameters[4], [1, deletionReceipt.target]);
        });
        assert.equal(queries.at(-1), "COMMIT");
    });
});

test("busy deletion advisory lock cannot be mistaken for absent receipt", async () => {
    await withPool({ response: sql => sql.includes("pg_try_advisory_xact_lock") ? { rows: [{ locked: false }], rowCount: 1 } : undefined }, async ({ queries }) => {
        await assert.rejects(database.withDeletionRecoveryDatabase(deletionReceipt.operationId, 1, deletionReceipt.target, async () => { assert.fail("No evidence before settled DB operation"); }), /still running/);
        assert.equal(queries.at(-1), "ROLLBACK");
        assert.ok(!queries.some(sql => sql.includes("media_deletion_receipts")));
    });
});


test("deletion recovery refuses receipt absence on a standby", async () => {
    await withPool({ response: sql => sql.includes("pg_is_in_recovery") ? { rows: [{ standby: true }], rowCount: 1 } : undefined }, async ({ queries }) => {
        await assert.rejects(database.withDeletionRecoveryDatabase(deletionReceipt.operationId, 1, deletionReceipt.target, async () => { assert.fail("Standby cannot decide outcome"); }), /verified primary/);
        assert.ok(!queries.some(sql => sql.includes("media_deletion_receipts")));
        assert.equal(queries.at(-1), "ROLLBACK");
    });
});
