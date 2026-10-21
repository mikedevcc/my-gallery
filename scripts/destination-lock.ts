import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export class DestinationBusyError extends Error {}
export class DestinationRecoveryError extends Error {}

async function canonicalDestination(root: string, destination: string): Promise<string> {
    const absolute = path.resolve(destination);
    let parent = path.dirname(absolute);
    const missing: string[] = [];
    while (true) {
        try { parent = await fs.realpath(parent); break; }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            missing.unshift(path.basename(parent));
            const next = path.dirname(parent);
            if (next === parent) throw error;
            parent = next;
        }
    }
    const canonical = path.join(parent, ...missing, path.basename(absolute));
    const relative = path.relative(root, canonical);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || relative.split(path.sep)[0] === ".destination-locks") {
        throw new Error("Destination must be an original media path inside the storage root");
    }
    return canonical;
}

async function fingerprint(destination: string): Promise<string | undefined> {
    try {
        const stat = await fs.lstat(destination, { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Destination must be a regular file, not a symlink");
        return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
}

export type DestinationLock = {
    destination: string;
    directory: string;
    unresolved: boolean;
    markUnresolved(): void;
    markSafe(): void;
    assertOwned(destination?: string): Promise<void>;
    revalidate(): Promise<void>;
    release(): Promise<void>;
};

export async function acquireDestinationLock(storageRoot: string, destination: string): Promise<DestinationLock> {
    const root = await fs.realpath(storageRoot);
    const canonical = await canonicalDestination(root, destination);
    // Reject unsupported targets before leaving any lock artifacts. Capture the
    // authoritative fingerprint again after exclusive acquisition below.
    await fingerprint(canonical);
    const locks = path.join(root, ".destination-locks");
    await fs.mkdir(locks, { recursive: true });
    if (await fs.realpath(locks) !== locks) throw new Error("Lock directory must not be a symlink");
    // Root-relative canonical identity also works when the same shared storage
    // root is mounted at different absolute paths by separate processes.
    const directory = path.join(locks, createHash("sha256").update(path.relative(root, canonical)).digest("hex"));
    try { await fs.mkdir(directory); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new DestinationBusyError("Media destination is locked; retry after completion or request recovery review");
        throw error;
    }
    // A failure here intentionally leaves a blocking directory, never an unlocked
    // target with uncertain ownership. There is no time-based lock eviction.
    const token = randomUUID();
    const ownerPath = path.join(directory, "owner.json");
    const identity = await fs.lstat(directory, { bigint: true });
    await fs.writeFile(ownerPath, JSON.stringify({ token, destination: canonical, pid: process.pid }), { flag: "wx" });
    let released = false;
    const initial = await fingerprint(canonical);
    const lock: DestinationLock = {
        destination: canonical,
        directory,
        unresolved: false,
        markUnresolved() { this.unresolved = true; },
        markSafe() { this.unresolved = false; },
        async assertOwned(target = canonical) {
            if (released) throw new Error("Destination lock has already been released");
            const current = await fs.lstat(directory, { bigint: true });
            const owner = JSON.parse(await fs.readFile(ownerPath, "utf8")) as { token?: string };
            if (current.dev !== identity.dev || current.ino !== identity.ino || owner.token !== token || await canonicalDestination(root, target) !== canonical) {
                throw new Error("Destination lock ownership or target changed; manual review required");
            }
        },
        async revalidate() {
            await this.assertOwned(destination);
            if (await fingerprint(canonical) !== initial) throw new Error("Destination changed while locked; retry after review");
        },
        async release() {
            if (this.unresolved) throw new DestinationRecoveryError("Unresolved destination lock must be retained for manual recovery");
            await this.assertOwned();
            await fs.unlink(ownerPath);
            await fs.rmdir(directory);
            released = true;
        },
    };
    return lock;
}

export async function withDestinationLock<T>(root: string, destination: string, operation: (lock: DestinationLock) => Promise<T>): Promise<T> {
    const lock = await acquireDestinationLock(root, destination);
    try {
        await lock.revalidate();
        const result = await operation(lock);
        if (lock.unresolved) throw new DestinationRecoveryError("Media operation needs recovery; destination lock retained");
        return result;
    } catch (error) {
        if (lock.unresolved && !(error instanceof DestinationRecoveryError)) {
            throw new DestinationRecoveryError(`Media operation needs recovery; destination lock retained: ${error instanceof Error ? error.message : "unknown failure"}`, { cause: error });
        }
        throw error;
    } finally {
        if (!lock.unresolved) await lock.release();
    }
}
