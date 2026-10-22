import { safeApiError } from "./api-safety";
import type { PoolClient } from "pg";

export class CollectionIntegrityError extends Error {
    constructor(message: string, public readonly status = 409, public readonly mediaIds: number[] = []) { super(message); }
}
export function collectionIds(values: unknown): number[] {
    if (!Array.isArray(values) || !values.length || values.some(id => !Number.isSafeInteger(id) || id < 1 || id > 2147483647)) {
        throw new CollectionIntegrityError("Select valid media IDs", 400);
    }
    if (new Set(values).size !== values.length) throw new CollectionIntegrityError("Duplicate media IDs", 400);
    return [...values].sort((a, b) => a - b);
}
export function collectionId(value: number): void { collectionIds([value]); }

// Shared for Album mutations; exclusive for media deletion, before taking rows.
// This closes membership discovery races without lock upgrades/retry loops. Only
// the metadata transaction (including its existing storage identity checks) is
// coordinated; filesystem publication and cleanup remain destination-local.
export async function coordinateAlbumDeletion(client: PoolClient, deletion = false) {
    await client.query(deletion
        ? "SELECT pg_advisory_xact_lock(1296514892, 6)"
        : "SELECT pg_advisory_xact_lock_shared(1296514892, 6)");
}
// Album writers lock Albums (ascending) before media KEY SHARE references. These
// are compatible with the KEY SHARE checks performed by the cover foreign key.
// Trip writers and exclusive media deletion use the stronger UPDATE row lock.
export async function lockCollectionMedia(client: PoolClient, ids: number[], referenceOnly = false) {
    return (await client.query<{ media_id: number; trip_id: number | null }>(
        `SELECT media_id, trip_id FROM media WHERE media_id = ANY($1::int[]) ORDER BY media_id FOR ${referenceOnly ? "KEY SHARE" : "UPDATE"}`, [ids])).rows;
}
export async function lockAlbums(client: PoolClient, ids: number[]) {
    const wanted = [...new Set(ids)].sort((a, b) => a - b);
    const rows = (await client.query<{ album_id: number }>(
        `SELECT album_id FROM album WHERE album_id = ANY($1::int[]) ORDER BY album_id FOR UPDATE`, [wanted])).rows;
    if (rows.length !== wanted.length) throw new CollectionIntegrityError("Source or target Album not found", 404);
}
export async function lockTrips(client: PoolClient, ids: number[]) {
    const wanted = [...new Set(ids)].sort((a, b) => a - b);
    // Trip-before-media order also agrees with Trip deletion's ON DELETE SET NULL.
    const rows = (await client.query<{ trip_id: number }>(
        `SELECT trip_id FROM trip WHERE trip_id = ANY($1::int[]) ORDER BY trip_id FOR KEY SHARE`, [wanted])).rows;
    if (rows.length !== wanted.length) throw new CollectionIntegrityError("Source or target Trip not found", 404);
}
export async function repairAlbumCovers(client: PoolClient, ids: number[]) {
    if (!ids.length) return;
    await client.query(`UPDATE album a SET cover_media_id = (
        SELECT MIN(ma.media_id) FROM media_album ma WHERE ma.album_id = a.album_id
    ) WHERE a.album_id = ANY($1::int[]) AND (
        a.cover_media_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM media_album ma WHERE ma.album_id = a.album_id AND ma.media_id = a.cover_media_id
        )
    )`, [ids]);
}
export function collectionErrorResponse(error: unknown): Response {
    if (error instanceof CollectionIntegrityError) return safeApiError(error, "collection-membership", { status: error.status, mediaIds: error.mediaIds });
    return safeApiError(error, "collection-membership");
}
