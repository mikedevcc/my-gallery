import fs from "node:fs/promises";
import path from "node:path";
import type { validateStorage } from "./storage-safety";
import { ProcessingError, processingLimits } from "./processing-limits";

let reserved = 0;
/** Count retained conflicts as well as active uploads. Never follow symlinks. */
export async function reserveStaging(storage: Awaited<ReturnType<typeof validateStorage>>) {
    const limits = processingLimits();
    reserved += limits.uploadBytes;
    let released = false;
    const release = () => { if (!released) { reserved -= limits.uploadBytes; released = true; } };
    try {
        let entries = 0;
        async function usage(directory: string): Promise<number> {
            await storage.assertAvailable(directory);
            let names: string[];
            try { names = await fs.readdir(directory); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
            let total = 0;
            for (const name of names) {
                if (++entries > 10_000) throw new ProcessingError("Too many staging artifacts; maintenance required");
                const file = path.join(directory, name);
                await storage.assertAvailable(file);
                const stat = await fs.lstat(file);
                if (stat.isSymbolicLink()) throw new ProcessingError("Unsafe staging artifact; maintenance required");
                total += stat.isDirectory() ? await usage(file) : stat.size;
                if (total + reserved > limits.tempBytes) throw new ProcessingError("Staging quota exhausted; resolve pending conflicts");
            }
            return total;
        }
        let used = await usage(path.join(storage.root, ".incoming"));
        const thumbnails = path.join(storage.root, ".thumbnails");
        await storage.assertAvailable(thumbnails);
        const names = await fs.readdir(thumbnails).catch(error => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error;
        });
        for (const name of names) {
            if (!name.endsWith(".tmp.webp")) continue;
            if (++entries > 10_000) throw new ProcessingError("Too many storage artifacts; maintenance required");
            const file = path.join(thumbnails, name);
            await storage.assertAvailable(file);
            const stat = await fs.lstat(file);
            if (!stat.isFile()) throw new ProcessingError("Unsafe temporary thumbnail");
            used += stat.size;
        }
        if (used + reserved > limits.tempBytes) throw new ProcessingError("Staging quota exhausted; resolve pending conflicts");
        await storage.assertAvailable();
        const disk = await fs.statfs(storage.root, { bigint: true });
        if (disk.bavail * disk.bsize < BigInt(limits.freeBytes + reserved)) throw new ProcessingError("Insufficient free media storage", 507);
        return release;
    } catch (error) { release(); throw error; }
}
