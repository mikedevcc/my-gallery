import assert from "node:assert/strict";
import { test, mock } from "node:test";
import fs from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { databaseConnectionString, geocoderConfiguration, RuntimeConfigurationError } from "./runtime-config";
import { validateRuntimeConfiguration } from "./validate-runtime-config";
import { processingLimits, withProcessingJob, ProcessingError } from "./processing-limits";
import { resolveLocation } from "./media-location";
import { closeMediaDatabase, findMediaByPath } from "./media-database";
import { storageSystem, StorageUnavailableError } from "./storage-safety";

const safeUrl = "postgresql://offline:unused@database.example.invalid:5432/gallery";
async function environment(values: Record<string, string | undefined>, work: () => Promise<void>) {
    const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    try { await work(); } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    }
}
const config = {
    DATABASE_URL: safeUrl, GEOCODER_MODE: "disabled", GEOCODER_URL: undefined,
    MEDIA_STORAGE_ROOT: "/srv/example-gallery", MEDIA_STORAGE_UUID: "12345678-1234-4234-8234-123456789abc",
    MEDIA_STORAGE_ID: "87654321-4321-4321-8321-cba987654321",
    MEDIA_STORAGE_MODE: "native", MEDIA_STORAGE_ASSERTION: undefined,
};
test("database URL rejects missing, ambient, malformed and overriding targets without leaking secrets", () => {
    for (const value of [undefined, "", "secret-invalid-url", "postgresql://user:TOP_SECRET@host/db", "https://user:TOP_SECRET@host:5432/db", "postgresql://user:TOP_SECRET@host:5432/", `${safeUrl}?host=wrong`, `${safeUrl}#secret`, `${safeUrl}?sslmode=typo`]) {
        assert.throws(() => databaseConnectionString({ DATABASE_URL: value }), error => {
            assert.ok(error instanceof RuntimeConfigurationError);
            assert.doesNotMatch(error.message, /TOP_SECRET|secret-invalid-url/); return true;
        });
    }
    for (const suffix of ["", "?sslmode=verify-full", "?sslmode=require", "?sslmode=disable"]) assert.equal(databaseConnectionString({ DATABASE_URL: safeUrl + suffix }), safeUrl + suffix);
});
test("geocoder config validates modes, endpoint and bounded timeout", () => {
    assert.throws(() => geocoderConfiguration({}), /GEOCODER_URL/);
    assert.equal(geocoderConfiguration({ GEOCODER_MODE: "disabled" }).url, undefined);
    for (const url of ["", "relative/reverse", "ftp://host/reverse", "https://user:TOP_SECRET@host/reverse", "https://host/reverse?password=TOP_SECRET", "https://host/reverse#fragment"]) {
        assert.throws(() => geocoderConfiguration({ GEOCODER_URL: url }), error => {
            assert.ok(error instanceof RuntimeConfigurationError); assert.doesNotMatch(error.message, /TOP_SECRET/); return true;
        });
    }
    for (const timeout of ["", "-1", "0", "NaN", "1.5", "2147483648"]) assert.throws(() => geocoderConfiguration({ GEOCODER_MODE: "disabled", GEOCODER_TIMEOUT_MS: timeout }));
    assert.throws(() => geocoderConfiguration({ GEOCODER_MODE: "optional" }));
    const result = geocoderConfiguration({ GEOCODER_MODE: "best-effort", GEOCODER_URL: "https://geocoder.example.invalid/base/reverse", GEOCODER_TIMEOUT_MS: "200" });
    assert.equal(result.mode, "best-effort"); assert.equal(result.timeoutMs, 200);
});
test("startup checks configuration without any database, device or mount access", () => environment(config, async () => {
    const connect = mock.method(Pool.prototype, "connect", () => { throw new Error("No database access allowed"); });
    const mounts = mock.method(storageSystem, "mounts", async () => { throw new Error("No storage probes allowed"); });
    const device = mock.method(storageSystem, "device", async () => { throw new Error("No device access allowed"); });
    const read = mock.method(fs, "readFile", async () => { throw new Error("No filesystem access allowed"); });
    const stat = mock.method(fs, "stat", async () => { throw new Error("No filesystem access allowed"); });
    const open = mock.method(fs, "open", async () => { throw new Error("No filesystem access allowed"); });
    try {
        validateRuntimeConfiguration();
        await environment({ MEDIA_STORAGE_MODE: "docker", MEDIA_STORAGE_ASSERTION: "/run/gallery/identity.json" }, async () => validateRuntimeConfiguration());
        for (const values of [{ MEDIA_STORAGE_MODE: "invalid" }, { MEDIA_STORAGE_MODE: "docker", MEDIA_STORAGE_ASSERTION: undefined }, { MEDIA_STORAGE_MODE: "docker", MEDIA_STORAGE_ASSERTION: "/srv/example-gallery/assertion.json" }]) {
            await environment(values, async () => assert.throws(validateRuntimeConfiguration, StorageUnavailableError));
        }
        assert.equal(read.mock.callCount(), 0); assert.equal(stat.mock.callCount(), 0); assert.equal(open.mock.callCount(), 0);
        for (const name of ["DATABASE_URL", "MEDIA_STORAGE_ROOT", "MEDIA_STORAGE_UUID", "MEDIA_STORAGE_ID"]) await environment({ [name]: undefined }, async () => assert.throws(validateRuntimeConfiguration));
        await environment({ MEDIA_STORAGE_ROOT: "/bad\npath" }, async () => assert.throws(validateRuntimeConfiguration, StorageUnavailableError));
        await environment({ MEDIA_UPLOAD_TIMEOUT_MS: "2147483648" }, async () => assert.throws(validateRuntimeConfiguration, /MEDIA_UPLOAD_TIMEOUT_MS/));
        await environment({ MEDIA_MAX_UPLOAD_BYTES: "9007199254740991", MEDIA_MAX_REQUEST_BYTES: undefined }, async () => assert.throws(processingLimits));
        assert.equal(connect.mock.callCount(), 0); assert.equal(mounts.mock.callCount(), 0); assert.equal(device.mock.callCount(), 0);
    } finally { connect.mock.restore(); mounts.mock.restore(); device.mock.restore(); read.mock.restore(); stat.mock.restore(); open.mock.restore(); }
}));
test("database validates before checkout and refuses a changed pool target", () => environment({ DATABASE_URL: undefined }, async () => {
    let releases = 0;
    const connect = mock.method(Pool.prototype, "connect", async () => ({ query: async () => ({ rows: [] }), release: () => { releases++; } }) as unknown as PoolClient);
    try {
        await assert.rejects(findMediaByPath("/unused"), RuntimeConfigurationError);
        assert.equal(connect.mock.callCount(), 0);
        await environment({ DATABASE_URL: safeUrl }, async () => { assert.equal(await findMediaByPath("/unused"), undefined); });
        await environment({ DATABASE_URL: safeUrl.replace("/gallery", "/other") }, async () => { await assert.rejects(findMediaByPath("/unused"), /restart/); });
        assert.equal(releases, 1);
    } finally { await closeMediaDatabase(); connect.mock.restore(); }
}));
test("disabled geocoder never fetches; required uses configured endpoint and preserves location", () => environment({ GEOCODER_MODE: "disabled", GEOCODER_URL: undefined }, async () => {
    const fetch = mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
        const url = new URL(String(input));
        assert.equal(url.origin, "https://geocoder.example.invalid"); assert.equal(url.pathname, "/custom/reverse");
        assert.equal(url.searchParams.get("lat"), "1"); assert.equal(url.searchParams.get("lon"), "2");
        return Response.json({ address: { town: "Example", country: "Country" } });
    });
    try {
        assert.deepEqual(await resolveLocation(1, 2), {}); assert.equal(fetch.mock.callCount(), 0);
        await environment({ GEOCODER_MODE: "required", GEOCODER_URL: "https://geocoder.example.invalid/custom/reverse" }, async () => assert.deepEqual(await resolveLocation(1, 2), { city: "Example", country: "Country" }));
    } finally { fetch.mock.restore(); }
}));
test("geocoder explicit failure modes sanitize failures and retain cancellation", () => environment({ GEOCODER_MODE: "required", GEOCODER_URL: "http://geocoder.example.invalid/reverse" }, async () => {
    const fetch = mock.method(globalThis, "fetch", async () => { throw new Error("TOP_SECRET URL or response"); });
    try {
        await assert.rejects(resolveLocation(1, 2), error => error instanceof ProcessingError && error.status === 502 && !error.message.includes("TOP_SECRET"));
        await environment({ GEOCODER_MODE: "best-effort" }, async () => assert.deepEqual(await resolveLocation(1, 2), {}));
        const controller = new AbortController();
        fetch.mock.mockImplementation(async () => { controller.abort(); throw new Error("aborted"); });
        await environment({ GEOCODER_MODE: "best-effort" }, async () => {
            await assert.rejects(withProcessingJob(controller.signal, () => resolveLocation(1, 2)), error => error instanceof ProcessingError && error.status === 408);
        });
    } finally { fetch.mock.restore(); }
}));
test("geocoder malformed responses and deadlines follow the chosen failure policy", () => environment({ GEOCODER_MODE: "required", GEOCODER_URL: "http://geocoder.example.invalid/reverse", GEOCODER_TIMEOUT_MS: "10" }, async () => {
    const fetch = mock.method(globalThis, "fetch", async () => Response.json({ address: { city: 123 } }));
    try {
        await assert.rejects(resolveLocation(0, 0), error => error instanceof ProcessingError && error.status === 502);
        fetch.mock.mockImplementation(async (_url: unknown, options?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
        }));
        // AbortSignal.timeout is unref'ed; keep this isolated mocked test alive.
        const alive = setTimeout(() => {}, 1000);
        try { await assert.rejects(resolveLocation(0, 0), error => error instanceof ProcessingError && error.status === 504); }
        finally { clearTimeout(alive); }
    } finally { fetch.mock.restore(); }
}));

test("Next startup hook validates Node configuration and skips the Edge registration path", () => environment({ ...config, NEXT_RUNTIME: "nodejs" }, async () => {
    const { register } = await import("../instrumentation");
    await register();
    await environment({ DATABASE_URL: undefined }, async () => assert.rejects(register(), RuntimeConfigurationError));
    await environment({ NEXT_RUNTIME: "edge", DATABASE_URL: undefined }, async () => { await register(); });
}));

test("failed geocoder HTTP responses close their bodies without leaking service details", () => environment({ GEOCODER_MODE: "required", GEOCODER_URL: "http://geocoder.example.invalid/reverse" }, async () => {
    let cancelled = false;
    const fetch = mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 503, statusText: "TOP_SECRET" }));
    try {
        await assert.rejects(resolveLocation(0, 0), error => error instanceof ProcessingError && error.status === 502 && !error.message.includes("TOP_SECRET"));
        assert.equal(cancelled, true);
    } finally { fetch.mock.restore(); }
}));
