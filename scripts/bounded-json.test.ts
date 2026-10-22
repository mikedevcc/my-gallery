import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { Pool } from "pg";
import { jsonLimits, JsonRequestError, readBoundedJson } from "./bounded-json";
import { ApiInputError, jsonObject } from "./api-safety";
import { collectionIds } from "./collection-integrity";
import * as albums from "../app/api/albums/route";
import * as album from "../app/api/albums/[albumId]/route";
import * as albumMedia from "../app/api/albums/[albumId]/media/route";
import * as trips from "../app/api/trips/route";
import * as trip from "../app/api/trips/[tripId]/route";
import * as tripMedia from "../app/api/trips/[tripId]/media/route";
import * as media from "../app/api/media/[mediaId]/route";
import * as conflicts from "../app/api/import/conflict/route";
process.env.DATABASE_URL = "postgresql://offline:unused@database.example.invalid:5432/gallery";

const status = (value: number) => (error: unknown) => error instanceof JsonRequestError && error.status === value;
const request = (body: string, headers: Record<string, string> = {}) => new Request("http://fixture.invalid", { method: "POST", headers, body });
async function environment(values: Record<string, string>, work: () => Promise<void>) {
    const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    Object.assign(process.env, values);
    try { await work(); } finally {
        for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
}
function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
        pull(controller) { const chunk = chunks.shift(); if (chunk) controller.enqueue(chunk); else controller.close(); },
        cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    return { request: new Request("http://fixture.invalid", { method: "POST", body, headers, duplex: "half" } as RequestInit), cancelled: () => cancelled };
}
const encode = (value: string) => new TextEncoder().encode(value);

test("conservative defaults and hard configuration ceilings", () => {
    assert.deepEqual(jsonLimits({}), { singleBytes: 4096, bulkBytes: 65536, timeoutMs: 10000, ids: 500, depth: 4, nodes: 2048 });
    for (const key of ["API_JSON_MAX_BYTES", "API_JSON_BULK_MAX_BYTES", "API_JSON_TIMEOUT_MS", "API_JSON_MAX_IDS", "API_JSON_MAX_DEPTH", "API_JSON_MAX_NODES"]) {
        for (const value of ["", "0", "-1", "1.5", "NaN", "9007199254740992"]) assert.throws(() => jsonLimits({ [key]: value }), new RegExp(key));
    }
    assert.throws(() => jsonLimits({ API_JSON_TIMEOUT_MS: "60001" }));
    assert.throws(() => jsonLimits({ API_JSON_MAX_BYTES: "1048577" }));
});

test("exact byte boundary including UTF-8 is valid; one extra byte is 413", async () => {
    const body = JSON.stringify({ name: "é".repeat(2042) });
    const length = Buffer.byteLength(body);
    await environment({ API_JSON_MAX_BYTES: String(length) }, async () => {
        assert.equal((await jsonObject(request(body))).name, "é".repeat(2042));
        await assert.rejects(readBoundedJson(request(body + " ")), status(413));
    });
});

test("chunked bodies and dishonest small Content-Length cannot bypass byte limits", async () => {
    for (const headers of [{}, { "content-length": "1" }] as Record<string, string>[]) {
        const source = streamed([encode('{"x":"'), encode("x".repeat(4096)), encode('"}')], headers);
        await assert.rejects(readBoundedJson(source.request), status(413));
        assert.ok(source.cancelled()); assert.equal(source.request.body!.locked, false);
    }
});

test("oversized headers reject and cancel without consuming; malformed headers are 400", async () => {
    for (const [length, expected] of [["4097", 413], ["9999999999999999999999999", 413], ["-1", 400], ["wat", 400]] as const) {
        const source = streamed([encode("{}")], { "content-length": length });
        await assert.rejects(readBoundedJson(source.request), status(expected));
        assert.ok(source.cancelled());
    }
});

test("one-byte chunks decode multibyte Unicode without an unbounded chunk list", async () => {
    const text = JSON.stringify({ name: "旅行 📷" });
    const source = streamed([...encode(text)].map(byte => Uint8Array.of(byte)));
    assert.deepEqual(await readBoundedJson(source.request), { name: "旅行 📷" });
});

test("malformed JSON, invalid UTF-8, absent and non-object bodies reject safely", async () => {
    for (const body of ["", "{", '{"a":1,}', "null", "[]", "true"]) await assert.rejects(jsonObject(request(body)), error => error instanceof ApiInputError || (error instanceof JsonRequestError && error.status === 400));
    await assert.rejects(readBoundedJson(streamed([Uint8Array.of(0xff)]).request), status(400));
    await assert.rejects(readBoundedJson(new Request("http://fixture.invalid", { method: "POST" })), status(400));
});

test("bulk ID exact boundary is accepted, excessive and unexpected arrays rejected", async () => {
    const ids = Array.from({ length: 500 }, (_, i) => i + 1);
    assert.deepEqual(collectionIds((await jsonObject(request(JSON.stringify({ mediaIds: ids })), "bulk")).mediaIds), ids);
    await assert.rejects(jsonObject(request(JSON.stringify({ mediaIds: [...ids, 501] })), "bulk"), status(413));
    assert.throws(() => collectionIds([...ids, 501]), status(413));
    await assert.rejects(jsonObject(request(JSON.stringify({ mediaIds: ids }))), status(413));
    await assert.rejects(jsonObject(request(JSON.stringify({ unrelated: Array(33).fill(1) })), "bulk"), status(413));
    assert.throws(() => collectionIds([1, 1])); assert.throws(() => collectionIds([2147483648]));
});

test("nested structures and total node count are independently bounded", async () => {
    assert.deepEqual(await jsonObject(request('{"a":{"b":{"c":{"d":1}}}}')), { a: { b: { c: { d: 1 } } } });
    await assert.rejects(jsonObject(request('{"a":{"b":{"c":{"d":{"e":1}}}}}')), status(400));
    await environment({ API_JSON_MAX_NODES: "3" }, async () => {
        assert.deepEqual(await jsonObject(request('{"a":1,"b":2}')), { a: 1, b: 2 });
        await assert.rejects(jsonObject(request('{"a":1,"b":2,"c":3}')), status(413));
    });
});

function stalled(signal?: AbortSignal, cancel?: () => void | Promise<void>) {
    const body = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}); }, cancel() { return cancel?.(); } });
    return new Request("http://fixture.invalid", { method: "POST", body, signal, duplex: "half" } as RequestInit);
}

test("stalled body times out even if upstream cancellation never settles", () => environment({ API_JSON_TIMEOUT_MS: "20" }, async () => {
    const r = stalled(undefined, () => new Promise(() => {}));
    await assert.rejects(readBoundedJson(r), status(408));
    assert.equal(r.body!.locked, false);
}));

test("pre-abort and in-flight abort cancel readers and release locks", async () => {
    for (const alreadyAborted of [false, true]) {
        const abort = new AbortController();
        if (alreadyAborted) abort.abort();
        const r = stalled(abort.signal);
        const result = readBoundedJson(r);
        if (!alreadyAborted) abort.abort();
        await assert.rejects(result, status(408));
        assert.equal(r.body!.locked, false);
    }
});

test("slow trickle uses one total deadline, not a renewed per-chunk timeout", () => environment({ API_JSON_TIMEOUT_MS: "25" }, async () => {
    let timer: ReturnType<typeof setTimeout>;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { return new Promise<void>(resolve => { timer = setTimeout(() => { controller.enqueue(encode(" ")); resolve(); }, 10); }); }, cancel() { clearTimeout(timer); } });
    const r = new Request("http://fixture.invalid", { method: "POST", body, duplex: "half" } as RequestInit);
    await assert.rejects(readBoundedJson(r), status(408));
}));

const context = () => ({ params: Promise.resolve({ albumId: "1", tripId: "1", mediaId: "1" }) });
const mutations = [
    (r: Request) => albums.POST(r), (r: Request) => trips.POST(r),
    (r: Request) => album.PATCH(r, context()), (r: Request) => trip.PATCH(r, context()),
    (r: Request) => albumMedia.POST(r, context()), (r: Request) => albumMedia.DELETE(r, context()), (r: Request) => albumMedia.PATCH(r, context()),
    (r: Request) => tripMedia.POST(r, context()), (r: Request) => tripMedia.DELETE(r, context()), (r: Request) => tripMedia.PATCH(r, context()),
    (r: Request) => media.PATCH(r, context()), (r: Request) => conflicts.POST(r),
];
test("all 12 JSON mutation handlers reject oversized, malformed and nested input before database checkout", async () => {
    const connect = mock.method(Pool.prototype, "connect", async () => assert.fail("Invalid request reached database"));
    const log = mock.method(console, "error", () => {});
    try {
        for (const mutate of mutations) {
            const abort = new AbortController(); abort.abort();
            assert.equal((await mutate(new Request("http://fixture.invalid", { method: "POST", body: "{}", signal: abort.signal }))).status, 408);
            for (const [body, expected] of [[" ".repeat(65537), 413], ["{", 400], ['{"a":{"b":{"c":{"d":{"e":1}}}}}', 400]] as const) assert.equal((await mutate(request(body))).status, expected);
        }
        for (const mutate of [(r: Request) => tripMedia.POST(r, context()), (r: Request) => tripMedia.PATCH(r, context()), (r: Request) => albumMedia.PATCH(r, context())]) {
            assert.equal((await mutate(request(JSON.stringify({ mediaIds: Array.from({ length: 501 }, (_, i) => i + 1) })))).status, 413);
        }
        assert.equal(connect.mock.callCount(), 0);
    } finally { connect.mock.restore(); log.mock.restore(); }
});

test("bulk byte boundary is independent of the single-object profile", async () => {
    const base = JSON.stringify({ mediaIds: [2147483647], padding: "" });
    const body = JSON.stringify({ mediaIds: [2147483647], padding: "x".repeat(65536 - Buffer.byteLength(base)) });
    assert.equal(Buffer.byteLength(body), 65536);
    assert.deepEqual((await jsonObject(request(body), "bulk")).mediaIds, [2147483647]);
    await assert.rejects(jsonObject(request(body)), status(413));
    await assert.rejects(jsonObject(request(body + " "), "bulk"), status(413));
});

test("parsing time counts against the deadline even before the timer callback can run", () => environment({ API_JSON_TIMEOUT_MS: "10" }, async () => {
    let now = 0;
    const clock = mock.method(performance, "now", () => now);
    const parse = JSON.parse.bind(JSON);
    const delayedParse = mock.method(JSON, "parse", (text: string) => { const result = parse(text); now = 11; return result; });
    try { await assert.rejects(readBoundedJson(request("{}")), status(408)); }
    finally { delayedParse.mock.restore(); clock.mock.restore(); }
}));

test("upstream stream failures are sanitized and release reader ownership", async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("PRIVATE upstream detail")); } });
    const r = new Request("http://fixture.invalid", { method: "POST", body, duplex: "half" } as RequestInit);
    await assert.rejects(readBoundedJson(r), error => error instanceof JsonRequestError && error.status === 400 && !error.message.includes("PRIVATE"));
    assert.equal(r.body!.locked, false);
});
