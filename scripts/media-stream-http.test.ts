import assert from "node:assert/strict";
import { test, mock } from "node:test";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { pipeToNodeResponse } from "next/dist/server/pipe-readable";
import { signalFromNodeResponse } from "next/dist/server/web/spec-extension/adapters/next-request";
import { streamMediaFile } from "./media-stream";
import { mockStorageMount, writeTestStorageMarker } from "./testing/storage-fixture";

test("Next's Node response bridge cancels a disconnected client and closes the pinned file", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "gallery-stream-http-"));
    await writeTestStorageMarker(root); const mount = await mockStorageMount(root);
    const target = path.join(root, "large.mp4"); const fixture = await fs.open(target, "wx");
    await fixture.truncate(1024 * 1024 * 1024); await fixture.close();
    let closed!: () => void; const fileClosed = new Promise<void>(resolve => { closed = resolve; });
    const open = fs.open.bind(fs); let closes = 0;
    const spy = mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        if (args[0] === target) {
            const close = handle.close.bind(handle);
            handle.close = async () => { try { await close(); } finally { closes++; closed(); } };
        }
        return handle;
    });
    const server = http.createServer(async (incoming, outgoing) => {
        try {
            const request = new Request("http://gallery.test/video", { signal: signalFromNodeResponse(outgoing) });
            const response = await streamMediaFile(request, { filePath: target, destination: target, fileName: "large.mp4", revalidate: async () => {} });
            outgoing.statusCode = response.status; response.headers.forEach((value, key) => outgoing.setHeader(key, value));
            await pipeToNodeResponse(response.body!, outgoing);
        } catch { outgoing.destroy(); }
    });
    let client: http.ClientRequest | undefined;
    try {
        server.listen(0, "127.0.0.1"); await once(server, "listening");
        const address = server.address(); assert.ok(address && typeof address !== "string");
        let bytes = 0;
        client = http.get(`http://127.0.0.1:${address.port}/`, response => {
            assert.equal(response.statusCode, 200);
            response.on("data", chunk => { bytes += chunk.length; client!.destroy(); });
            response.on("error", () => {});
        });
        client.on("error", () => {});
        await Promise.race([fileClosed, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Disconnect did not close file")), 5000).unref())]);
        assert.equal(closes, 1); assert.ok(bytes > 0 && bytes < 1024 * 1024 * 1024);
    } finally {
        client?.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
        spy.mock.restore(); mount.restore(); await fs.rm(root, { recursive: true, force: true });
    }
});
