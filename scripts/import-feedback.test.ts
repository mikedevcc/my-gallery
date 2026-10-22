import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ImportFeedback } from "../components/import-feedback";
import { createImportNotifier, readConflict, uncertainImport, ImportFailure } from "../lib/import/import-feedback";
import { uploadImportFile } from "../lib/import/upload-import-file";
import { processImportQueue } from "../lib/import/process-import-queue";
import { resolveConflictBatch } from "../lib/import/resolve-import-conflict";
import type { ImportJob } from "../lib/import/import-job";
import { POST } from "../app/api/import/route";

const file = new File(["fixture"], "photo.jpg", { type: "image/jpeg" });
const conflict = { type: "FILENAME" as const, jobId: "c", conflictId: "conflict-c", existingFilename: "photo.jpg" };
const job = (id: string): ImportJob => ({ id, fileName: `${id}.jpg`, status: "QUEUED", progress: 0 });
async function responses(values: (Response | Error)[], work: () => Promise<void>) {
    let calls = 0;
    const fetch = mock.method(globalThis, "fetch", async () => {
        const value = values[calls++];
        if (value instanceof Error) throw value;
        assert.ok(value, "unexpected extra request");
        return value;
    });
    try { await work(); assert.equal(calls, values.length); } finally { fetch.mock.restore(); }
}

test("mixed batch preserves successes, failures and public conflicts and flushes one refresh", async () => {
    let refreshes = 0;
    const notifier = createImportNotifier(() => refreshes++);
    const jobs = [job("a"), job("b"), job("c"), job("d")];
    await responses([
        Response.json({ mediaId: 1 }), new Error("/private/password"),
        Response.json({ conflict: { ...conflict, existingPath: "/private/original" } }, { status: 409 }),
        Response.json({ mediaId: 2 }),
    ], async () => {
        const seen: unknown[] = [];
        const result = await processImportQueue(jobs, new Map(jobs.map(j => [j.id, file])), uploadImportFile, j => {
            if (j.status === "COMPLETED") notifier.confirmed(j.id);
        }, c => seen.push(c));
        notifier.flush(); notifier.flush();
        assert.deepEqual(result.map(j => j.status), ["COMPLETED", "FAILED", "AWAITING_DECISION", "COMPLETED"]);
        assert.equal(result[1].error, uncertainImport);
        assert.equal(result[1].retryable, false);
        assert.deepEqual(seen, [conflict]);
        assert.equal(refreshes, 1);
        assert.deepEqual(jobs.map(j => j.status), ["QUEUED", "QUEUED", "QUEUED", "QUEUED"]);
    });
});

test("only explicit admission rejection permits retry; retry keeps its job identity", async () => {
    await responses([
        Response.json({}, { status: 503, headers: { "X-Import-Retry-Safe": "1" } }),
        Response.json({ mediaId: 1 }),
    ], async () => {
        const first = await processImportQueue([job("a")], new Map([["a", file]]), uploadImportFile);
        assert.equal(first[0].retryable, true);
        const retry = await processImportQueue([{ ...first[0], status: "QUEUED" }], new Map([["a", file]]), uploadImportFile);
        assert.equal(retry[0].id, "a"); assert.equal(retry[0].status, "COMPLETED"); assert.equal(retry[0].retryable, false);
    });
});

for (const [name, response] of [
    ["unknown server failure", () => Response.json({ error: "/private/password" }, { status: 503 })],
    ["lost acknowledgment", () => new Error("secret")],
    ["invalid JSON", () => new Response("proxy stack trace")],
    ["invalid success DTO", () => Response.json({ message: "ok" })],
    ["invalid conflict DTO", () => Response.json({ conflict: { existingPath: "/secret" } }, { status: 409 })],
] as const) test(`${name} is sanitized and never automatically retryable`, async () => {
    await responses([response()], async () => {
        await assert.rejects(uploadImportFile("a", file), error => error instanceof ImportFailure && !error.retryable && error.message === uncertainImport);
    });
});

for (const status of [413, 415]) test(`HTTP ${status} has clear safe feedback`, async () => {
    await responses([Response.json({ error: "/secret" }, { status })], async () => {
        await assert.rejects(uploadImportFile("a", file), error => error instanceof ImportFailure && !error.retryable && !error.message.includes("secret") && error.message !== uncertainImport);
    });
});

test("bulk resolution flushes earlier successes when a later operation fails; stops remaining operations", async () => {
    let refreshes = 0;
    const notifier = createImportNotifier(() => refreshes++);
    const resolved: string[] = [];
    await responses([Response.json({ type: "COMPLETED", mediaId: 7 }), new Error("private")], async () => {
        await assert.rejects(resolveConflictBatch([conflict, { ...conflict, conflictId: "d" }, { ...conflict, conflictId: "e" }], "REPLACE", c => resolved.push(c.conflictId), notifier), /Refresh pending conflicts/);
        assert.deepEqual(resolved, [conflict.conflictId]);
        assert.equal(refreshes, 1);
        notifier.confirmed(`conflict:${conflict.conflictId}`); notifier.flush();
        assert.equal(refreshes, 1);
    });
});

test("skip and failed-only operations do not refresh; confirmed resolution batch refreshes once", async () => {
    let refreshes = 0;
    const notifier = createImportNotifier(() => refreshes++);
    await responses([Response.json({ type: "SKIPPED" }), Response.json({ type: "COMPLETED", mediaId: 1 }), Response.json({ type: "COMPLETED", mediaId: 2 })], async () => {
        await resolveConflictBatch([conflict], "SKIP", () => {}, notifier);
        assert.equal(refreshes, 0);
        await resolveConflictBatch([conflict, { ...conflict, conflictId: "d" }], "KEEP_BOTH", () => {}, notifier);
        assert.equal(refreshes, 1);
    });
});

test("public conflict parser rejects internal/legacy DTO and strips unknown fields", () => {
    assert.throws(() => readConflict({ ...conflict, existingFilename: undefined, existingPath: "/private" }));
    assert.deepEqual(readConflict({ ...conflict, token: "secret", existingPath: "/private" }), conflict);
});

test("feedback renders each outcome and only offers explicit safe retries", () => {
    const jobs: ImportJob[] = [
        { ...job("success"), status: "COMPLETED" },
        { ...job("failed"), status: "FAILED", error: "Check the library first" },
        { ...job("retry"), status: "FAILED", retryable: true, error: "Nothing was imported" },
        { ...job("conflict"), status: "AWAITING_DECISION" }, job("pending"),
    ];
    const html = renderToStaticMarkup(createElement(ImportFeedback, { jobs, disabled: false, onRetry: () => {} }));
    for (const text of ["Imported", "Failed", "Awaiting conflict resolution", "Pending", "Check the library first"]) assert.ok(html.includes(text));
    assert.equal((html.match(/<button/g) ?? []).length, 1);
    assert.ok(html.includes("Retry retry.jpg"));
});

test("import route only marks pre-admission rejection safe to retry", async () => {
    const previous = process.env.MEDIA_MAX_CONCURRENT_JOBS;
    const log = mock.method(console, "error", () => {});
    try {
        process.env.MEDIA_MAX_CONCURRENT_JOBS = "0";
        const rejected = await POST(new Request("http://fixture.invalid", { method: "POST" }));
        assert.equal(rejected.status, 503); assert.equal(rejected.headers.get("X-Import-Retry-Safe"), "1");
        process.env.MEDIA_MAX_CONCURRENT_JOBS = "2";
        const admitted = await POST(new Request("http://fixture.invalid", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "invalid" }));
        assert.equal(admitted.headers.get("X-Import-Retry-Safe"), null);
        assert.equal(admitted.ok, false);
    } finally {
        if (previous === undefined) delete process.env.MEDIA_MAX_CONCURRENT_JOBS; else process.env.MEDIA_MAX_CONCURRENT_JOBS = previous;
        log.mock.restore();
    }
});

test("validation failures remain visible and do not prevent valid files importing", async () => {
    const { createImportJobs } = await import("../lib/import/create-import-jobs");
    const { validateImportJobs, applyValidationResults } = await import("../lib/import/validate-import-jobs");
    const created = createImportJobs([new File([], "empty.jpg"), new File(["bad"], "bad.exe"), file]);
    const batch = applyValidationResults(created.jobs, validateImportJobs(created.jobs, created.filesByJobId));
    await responses([Response.json({ mediaId: 1 })], async () => {
        const result = await processImportQueue(batch, created.filesByJobId, uploadImportFile);
        assert.deepEqual(result.map(j => j.status), ["FAILED", "FAILED", "COMPLETED"]);
        assert.equal(result[0].error, "File is empty");
    });
});

test("failed-only batches and callbacks cannot relabel a confirmed import for retry", async () => {
    let notifications = 0;
    const notifier = createImportNotifier(() => notifications++);
    const failed = await processImportQueue([job("a")], new Map([["a", file]]), async () => { throw new Error("private"); }, j => {
        if (j.status === "COMPLETED") notifier.confirmed(j.id);
    });
    notifier.flush(); assert.equal(notifications, 0); assert.equal(failed[0].status, "FAILED");
    const states: string[] = [];
    await assert.rejects(processImportQueue([job("a")], new Map([["a", file]]), async () => ({ type: "COMPLETED" }), j => {
        states.push(j.status);
        if (j.status === "COMPLETED") throw new Error("UI callback failed");
    }), /UI callback failed/);
    assert.deepEqual(states, ["PROCESSING", "COMPLETED"]);
});

test("gallery refresh revision changes the rendered original thumbnail URL", async () => {
    const { LibraryMediaGrid } = await import("../components/gallery");
    const items = [{ media_id: 1, file_name: "fixture.jpg", file_type: "IMAGE" as const, date_taken: null, date_imported: "2026-01-01", width: 10, height: 10, favorite: false, city_name: null, country_name: null }];
    const render = (revision: number) => renderToStaticMarkup(createElement(LibraryMediaGrid, { items, revision, onToggleFavorite: () => {} }));
    assert.ok(render(0).includes("/api/media/1/thumbnail?v=0"));
    assert.ok(render(1).includes("/api/media/1/thumbnail?v=1"));
});
