import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createBulkSession, requestBulkItem, type BulkItem, type BulkOperation } from "../lib/bulk-media";
import { BulkMediaFeedback } from "../components/bulk-media-feedback";

const confirmed = (id: number): BulkItem => ({ id, outcome: "confirmed" });
const failed = (id: number): BulkItem => ({ id, outcome: "failed" });
const uncertain = (id: number): BulkItem => ({ id, outcome: "uncertain" });
function store() {
    const values = new Map<string, string>();
    return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test("complete success deduplicates IDs, clears only confirmed selection, and refreshes once", async () => {
    const session = createBulkSession(); const calls: number[] = [];
    let selection = [1, 2, 3], refreshes = 0;
    await session.run([1, 1, 2, 3], async id => { calls.push(id); return confirmed(id); }, items => {
        selection = selection.filter(id => !items.some(item => item.id === id && item.outcome === "confirmed"));
    }, () => refreshes++);
    assert.deepEqual(calls, [1, 2, 3]); assert.deepEqual(selection, []); assert.equal(refreshes, 1);
    await session.run([1, 2, 3], async () => assert.fail("cannot replay success"), () => {}, () => refreshes++);
    assert.equal(refreshes, 1);
});

test("partial success continues per-item requests and retry skips confirmed and uncertain IDs", async () => {
    const session = createBulkSession("delete", store());
    let selection = [1, 2, 3, 4], refreshes = 0;
    const update = (items: BulkItem[]) => { selection = selection.filter(id => !items.some(item => item.id === id && item.outcome === "confirmed")); };
    await session.run(selection, async id => id === 1 || id === 4 ? confirmed(id) : id === 2 ? failed(id) : uncertain(id), update, () => refreshes++);
    assert.deepEqual(selection, [2, 3]); assert.deepEqual(session.snapshot().map(item => item.outcome), ["confirmed", "failed", "uncertain", "confirmed"]);
    const retried: number[] = [];
    await session.run([1, 2, 3, 4], async id => { retried.push(id); return confirmed(id); }, update, () => refreshes++);
    assert.deepEqual(retried, [2]); assert.deepEqual(selection, [3]); assert.equal(refreshes, 2);
});

test("first-item failure still processes later files and refreshes; all failures remain selected", async () => {
    const session = createBulkSession(); let refreshes = 0;
    await session.run([1, 2], async id => id === 1 ? failed(id) : confirmed(id), () => {}, () => refreshes++);
    assert.deepEqual(session.snapshot(), [failed(1), confirmed(2)]); assert.equal(refreshes, 1);
    const all = createBulkSession();
    await all.run([1, 2], async id => failed(id), () => {}, () => refreshes++);
    assert.deepEqual(all.snapshot(), [failed(1), failed(2)]); assert.equal(refreshes, 2);
});

test("concurrent clicks cannot start duplicate operations", async () => {
    const session = createBulkSession(), finish = deferred<BulkItem>(); let requests = 0, refreshes = 0;
    const first = session.run([1], async () => { requests++; return finish.promise; }, () => {}, () => refreshes++);
    assert.equal(session.canRun([1]), false);
    await session.run([1], async () => { requests++; return confirmed(1); }, () => {}, () => refreshes++);
    finish.resolve(confirmed(1)); await first;
    assert.equal(requests, 1); assert.equal(refreshes, 1);
});

test("unmount stops later mutations and UI updates but retains the in-flight result and global refresh", async () => {
    const session = createBulkSession(), finish = deferred<BulkItem>(); const calls: number[] = [];
    let updates = 0, refreshes = 0;
    const run = session.run([1, 2], async id => { calls.push(id); return finish.promise; }, () => updates++, () => refreshes++);
    const before = updates;
    session.stop(); finish.resolve(confirmed(1)); await run;
    assert.equal(updates, before); assert.deepEqual(calls, [1]); assert.equal(refreshes, 1);
    assert.deepEqual(session.snapshot(), [confirmed(1), { id: 2, outcome: "pending" }]);
});

test("uncertainty survives remount and blocks parallel new sessions while an operation runs", async () => {
    const review = store(); const first = createBulkSession("delete", review), finish = deferred<BulkItem>();
    const run = first.run([1], async () => finish.promise, () => {}, () => {});
    const second = createBulkSession("delete", review);
    await second.run([1], async () => assert.fail("in-flight mutation replay"), () => {}, () => {});
    assert.deepEqual(second.snapshot(), [uncertain(1)]);
    first.stop(); finish.resolve(uncertain(1)); await run;
    const remount = createBulkSession("delete", review);
    await remount.run([1], async () => assert.fail("unknown outcome replay"), () => {}, () => {});
    assert.deepEqual(remount.snapshot(), [uncertain(1)]);
    remount.available(1);
    assert.equal(remount.canRun([1]), false);
});

test("verified rejection clears review marker and permits explicit retry; scopes stay independent", async () => {
    const review = store(); const first = createBulkSession("album-add:1", review);
    await first.run([1], async () => failed(1), () => {}, () => {});
    const retry = createBulkSession("album-add:1", review);
    await retry.run([1], async () => confirmed(1), () => {}, () => {});
    await first.run([2], async () => uncertain(2), () => {}, () => {});
    const other = createBulkSession("album-add:2", review);
    await other.run([2], async () => confirmed(2), () => {}, () => {});
    assert.deepEqual(other.snapshot(), [confirmed(2)]);
});

test("explicit selection of a newly available member permits a new operation, never an uncertain replay", async () => {
    const session = createBulkSession();
    await session.run([1, 2], async id => id === 1 ? confirmed(id) : uncertain(id), () => {}, () => {});
    session.available(1); session.available(2);
    const calls: number[] = [];
    await session.run([1, 2], async id => { calls.push(id); return confirmed(id); }, () => {}, () => {});
    assert.deepEqual(calls, [1]);
});

for (const kind of ["delete", "album-add", "album-remove", "trip-remove"] as const) test(`${kind} uses existing endpoint and public success contract`, async () => {
    const operation: BulkOperation = { kind, collectionId: 7 };
    const body = kind === "album-add" ? { addedCount: 1 } : { message: kind === "delete" ? "Media deleted" : kind === "album-remove" ? "Media removed from album" : "Media removed from trip" };
    const fetch = mock.method(globalThis, "fetch", async (url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        assert.equal(url, kind === "delete" ? "/api/media/42" : `/api/${kind === "trip-remove" ? "trips" : "albums"}/7/media`);
        assert.equal(init?.method, kind === "album-add" ? "POST" : "DELETE");
        if (kind !== "delete") assert.deepEqual(JSON.parse(init?.body as string), { mediaId: 42 });
        return Response.json(body);
    });
    try { assert.equal((await requestBulkItem(operation, 42)).outcome, "confirmed"); } finally { fetch.mock.restore(); }
});

for (const code of [400, 401, 403, 404, 409, 413, 415, 422, 408, 429, 500, 502, 503, 504]) test(`HTTP ${code} classifies rejection versus uncertain commit without exposing server errors`, async () => {
    const fetch = mock.method(globalThis, "fetch", async () => Response.json({ error: "/private/password" }, { status: code }));
    try {
        assert.deepEqual(await requestBulkItem({ kind: "delete" }, 1), { id: 1, outcome: code === 408 || code === 429 || code >= 500 ? "uncertain" : "failed" });
    } finally { fetch.mock.restore(); }
});

test("network failures, unexpected success DTOs and invalid JSON remain uncertain", async () => {
    for (const response of [new Error("secret"), Response.json({}), new Response("proxy login page")]) {
        const fetch = mock.method(globalThis, "fetch", async () => { if (response instanceof Error) throw response; return response; });
        try { assert.deepEqual(await requestBulkItem({ kind: "delete" }, 1), uncertain(1)); } finally { fetch.mock.restore(); }
    }
});

test("already-present album members are confirmed unchanged and feedback reports every outcome", async () => {
    const fetch = mock.method(globalThis, "fetch", async () => Response.json({ addedCount: 0 }));
    try {
        const unchanged = await requestBulkItem({ kind: "album-add", collectionId: 1 }, 1);
        assert.deepEqual(unchanged, { ...confirmed(1), unchanged: true });
        const html = renderToStaticMarkup(createElement(BulkMediaFeedback, { items: [unchanged, failed(2), uncertain(3), { id: 4, outcome: "pending" }] }));
        for (const text of ["1 confirmed successful", "1 already in Album", "1 failed", "1 uncertain", "1 not attempted", "Rejected IDs: 2", "Uncertain IDs: 3", "blocked from retry"]) assert.ok(html.includes(text));
    } finally { fetch.mock.restore(); }
});

test("redirected responses cannot be counted as confirmed mutations", async () => {
    const response = Response.json({ message: "Media deleted" });
    Object.defineProperty(response, "redirected", { value: true });
    const fetch = mock.method(globalThis, "fetch", async () => response);
    try { assert.deepEqual(await requestBulkItem({ kind: "delete" }, 1), uncertain(1)); }
    finally { fetch.mock.restore(); }
});

test("an unexpected request exception is uncertain and later independent IDs still run", async () => {
    const session = createBulkSession(); let refreshes = 0;
    await session.run([1, 2], async id => { if (id === 1) throw new Error("private"); return confirmed(id); }, () => {}, () => refreshes++);
    assert.deepEqual(session.snapshot(), [uncertain(1), confirmed(2)]);
    assert.equal(refreshes, 1);
});
