import fs from "node:fs/promises";
import { processIdentity, processHasStopped } from "./process-identity";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createStorageDirectory, validateStorage } from "./storage-safety";

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
    token: string;
    bindOperation(operationId: string): Promise<void>;
    markUnresolved(): void;
    markSafe(): void;
    assertOwned(destination?: string): Promise<void>;
    assertStorage(target?: string): Promise<void>;
    revalidate(): Promise<void>;
    release(): Promise<void>;
};

export async function acquireDestinationLock(storageRoot: string, destination: string, recovery?: { operationId: string; token: string }): Promise<DestinationLock> {
    const storage = await validateStorage(storageRoot);
    const root = storage.root;
    const canonical = await canonicalDestination(root, destination);
    // Reject unsupported targets before leaving any lock artifacts. Capture the
    // authoritative fingerprint again after exclusive acquisition below.
    await fingerprint(canonical);
    const locks = path.join(root, ".destination-locks");
    await storage.assertAvailable(locks);
    await createStorageDirectory(storage, locks);
    if (await fs.realpath(locks) !== locks) throw new Error("Lock directory must not be a symlink");
    // Root-relative canonical identity also works when the same shared storage
    // root is mounted at different absolute paths by separate processes.
    const directory = path.join(locks, createHash("sha256").update(path.relative(root, canonical)).digest("hex"));
    await storage.assertAvailable(directory);
    if (!recovery) {
        try { await fs.mkdir(directory); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new DestinationBusyError("Media destination is locked; retry after completion or request recovery review");
            throw error;
        }
    }
    const token = recovery?.token ?? randomUUID();
    const ownerPath = path.join(directory, "owner.json");
    await storage.assertAvailable(ownerPath);
    const identity = await fs.lstat(directory, { bigint: true });
    const self = await processIdentity();
    if (recovery) {
        // Caller MUST hold the operation's PostgreSQL advisory lock throughout.
        const previous = JSON.parse(await fs.readFile(ownerPath, "utf8"));
        if (previous.token !== token || previous.operationId !== recovery.operationId || previous.destination !== canonical) {
            throw new DestinationRecoveryError("Journal does not own the retained destination lock");
        }
        const sameRecoveryProcess = previous.recovering === true && previous.pid === self.pid && previous.uid === self.uid && previous.bootId === self.bootId && previous.startTime === self.startTime;
        if (!sameRecoveryProcess && !await processHasStopped(previous)) throw new DestinationBusyError("Destination owner is still running; recovery refused");
    }
    const writeOwner = async (operationId?: string) => {
        await storage.assertAvailable(ownerPath);
        const owner = { token, destination: canonical, ...self, operationId, recovering: !!recovery };
        const temporary = path.join(locks, `.owner-${randomUUID()}.tmp`);
        const handle = await fs.open(temporary, "wx", 0o600);
        try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); } finally { await handle.close(); }
        await storage.assertAvailable(ownerPath);
        await fs.rename(temporary, ownerPath);
        const parent = await fs.open(directory, "r");
        try { await parent.sync(); } finally { await parent.close(); }
        const container = await fs.open(locks, "r");
        try { await container.sync(); } finally { await container.close(); }
    };
    if (recovery) await writeOwner(recovery.operationId);
    else await fs.writeFile(ownerPath, JSON.stringify({ token, destination: canonical, ...self }), { flag: "wx", mode: 0o600 });
    let released = false;
    const initial = await fingerprint(canonical);
    const lock: DestinationLock = {
        destination: canonical,
        directory,
        unresolved: !!recovery,
        token,
        async bindOperation(operationId) { await this.assertOwned(); await writeOwner(operationId); },
        markUnresolved() { this.unresolved = true; },
        markSafe() { this.unresolved = false; },
        assertStorage: target => storage.assertAvailable(target),
        async assertOwned(target = canonical) {
            await storage.assertAvailable(target);
            await storage.assertAvailable(ownerPath);
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
            await storage.assertAvailable(directory);
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
