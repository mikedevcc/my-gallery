// Termination fixture only; never connects to PostgreSQL or accepts real storage.
import fs from "node:fs/promises";
import path from "node:path";
import { finalizeStagedMedia } from "../media-storage";
import { mockStorageMount } from "./storage-fixture";

async function main() {
    const [root, staged, destination, boundary] = process.argv.slice(2);
    if (!/^\/tmp\/gallery-import-publication-[a-zA-Z0-9]+$/.test(root ?? "") || ![staged, destination].every(file => file?.startsWith(root + path.sep)) || !["after-link", "before-metadata", "after-metadata", "after-staging-unlink"].includes(boundary)) throw new Error("Invalid isolated worker fixture");
    await mockStorageMount(root);
    async function pause() {
        process.stdout.write("BOUNDARY\n");
        await new Promise<void>(() => { setInterval(() => {}, 1000); });
    }
    const link = fs.link.bind(fs), unlink = fs.unlink.bind(fs);
    fs.link = async (source, target) => {
        await link(source, target);
        if (String(target) === destination && boundary === "after-link") await pause();
    };
    fs.unlink = async target => {
        await unlink(target);
        if (String(target) === staged && boundary === "after-staging-unlink") await pause();
    };
    await finalizeStagedMedia(staged, destination, async () => {
        // Durable stand-in for acknowledged metadata, NOT a PostgreSQL commit test.
        if (["after-metadata", "after-staging-unlink"].includes(boundary)) {
            const handle = await fs.open(path.join(root, "metadata-confirmed"), "wx");
            try { await handle.writeFile("confirmed"); await handle.sync(); } finally { await handle.close(); }
        }
        if (["before-metadata", "after-metadata"].includes(boundary)) await pause();
    }, root);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
