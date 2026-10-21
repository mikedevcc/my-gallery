import fs from "node:fs/promises";
import path from "node:path";

export class InvalidMediaPathError extends Error {}
const internalNames = new Set([
    ".incoming", ".destination-locks", ".replacement-operations", ".deletion-operations",
    ".thumbnails", ".resolution-lock", ".uploading", ".conflict.json", ".mygallery-storage.json",
]);
const recoveryName = /\.(?:backup|publish)-[0-9a-f-]{36}$/i;
const ownerTemporary = /^\.owner-[0-9a-f-]{36}\.tmp$/i;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isReservedStorageName(value: string): boolean {
    return internalNames.has(value.toLowerCase()) || recoveryName.test(value) || ownerTemporary.test(value);
}
// Linux ext4/XFS component limit is in bytes. Preserve spelling and Unicode;
// never basename(), trim, decode or normalize a supplied name into acceptance.
export function assertFilesystemSegment(value: unknown): asserts value is string {
    if (typeof value !== "string" || !value || !value.trim() || value === "." || value === ".."
        || /[/\\\u202a-\u202e\u2066-\u2069]|\p{Cc}/u.test(value)
        || /[\ud800-\udfff]/u.test(value) || Buffer.byteLength(value, "utf8") > 255) {
        throw new InvalidMediaPathError("Invalid media path segment");
    }
}
export function assertMediaSegment(value: unknown, directory = false): asserts value is string {
    assertFilesystemSegment(value);
    if (isReservedStorageName(value) || (directory && value.startsWith("."))) throw new InvalidMediaPathError("Reserved media path segment");
}
function relativeParts(root: string, target: string): string[] {
    if (typeof target !== "string" || !path.isAbsolute(target) || path.resolve(target) !== target) throw new InvalidMediaPathError("Media path must be absolute and canonical inside the storage root");
    const relative = path.relative(root, target);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new InvalidMediaPathError("Media path must be inside the storage root");
    return relative.split(path.sep);
}
export function assertOriginalMediaPath(root: string, target: string): void {
    const parts = relativeParts(root, target);
    parts.forEach((part, index) => assertMediaSegment(part, index < parts.length - 1));
}
export function assertStagedMediaPath(root: string, target: string, conflictId?: string): void {
    const parts = relativeParts(root, target);
    if (parts.length !== 3 || parts[0] !== ".incoming" || !uuid.test(parts[1]) || (conflictId !== undefined && parts[1] !== conflictId)) throw new InvalidMediaPathError("Invalid staged media path");
    assertMediaSegment(parts[2]);
}
// Low-level file primitives also support existing original/standalone source
// paths. Request-facing staging and cleanup require the strict UUID job layout.
export function assertMediaInputPath(root: string, target: string): void {
    const parts = relativeParts(root, target);
    if (parts[0] === ".incoming") assertStagedMediaPath(root, target);
    else assertOriginalMediaPath(root, target);
}
export function assertMediaId(value: number): void {
    if (!Number.isSafeInteger(value) || value <= 0) throw new InvalidMediaPathError("Invalid media ID");
}
export async function canonicalOriginalDestination(root: string, destination: string): Promise<string> {
    assertOriginalMediaPath(root, destination);
    let parent = path.dirname(destination);
    const missing: string[] = [];
    while (true) {
        try { parent = await fs.realpath(parent); break; }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            // realpath also returns ENOENT for dangling links. They are not
            // missing directories we may later create or lock through.
            try {
                if ((await fs.lstat(parent)).isSymbolicLink()) throw new InvalidMediaPathError("Dangling destination symlink");
            } catch (probeError) {
                if ((probeError as NodeJS.ErrnoException).code !== "ENOENT") throw probeError;
            }
            missing.unshift(path.basename(parent));
            const next = path.dirname(parent);
            if (next === parent) throw error;
            parent = next;
        }
    }
    const canonical = path.join(parent, ...missing, path.basename(destination));
    // Validate BOTH the supplied spelling and resolved destination. An apparently
    // public alias must never redirect a writer into private storage namespaces.
    assertOriginalMediaPath(root, canonical);
    return canonical;
}
