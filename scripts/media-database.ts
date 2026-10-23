import { CollectionIntegrityError, collectionId, collectionIds, coordinateAlbumDeletion, lockCollectionMedia, lockAlbums, lockTrips, repairAlbumCovers } from "./collection-integrity";
import { databaseConnectionString, RuntimeConfigurationError } from "./runtime-config";
import type { DeletionEvidence } from "./deletion-recovery";
import type { DeletionReceipt } from "./deletion-tracking";
import type { ReplacementEvidence } from "./replacement-files";
import type { ReplacementReceipt } from "./replacement-recovery";
import type { ImportedMedia } from "./media-import";
import { Pool, PoolClient } from "pg";


type MediaIdRow = {
    media_id: number;
};

type CountryIdRow = {
    country_id: number;
};

type CityIdRow = {
    city_id: number;
};

type TripRow = {
    trip_id: number;
    trip_name: string;
    media_count: number;
    cover_media_id: number | null;
};

type TripMediaRow = {
    media_id: number;
    file_name: string;
    file_type: "IMAGE" | "VIDEO";
    path: string;
    date_taken: Date | null;
    capture_local: string | null;
    capture_offset_minutes: number | null;
    width: number | null;
    height: number | null;
    favorite: boolean;

    file_modified_at: Date | null;
    file_modified_timezone: string | null;
};

type AlbumMediaRow = {
    media_id: number;
    file_name: string;
    file_type: "IMAGE" | "VIDEO";
    path: string;
    date_taken: Date | null;
    capture_local: string | null;
    capture_offset_minutes: number | null;
    width: number | null;
    height: number | null;
    favorite: boolean;

    file_modified_at: Date | null;
    file_modified_timezone: string | null;
}

export type MediaFileRow = {
    media_id: number;
    file_name: string;
    file_type: "IMAGE" | "VIDEO";
    path: string;
};

export type MediaDetailRow = {
    media_id: number;
    file_name: string;
    file_type: "IMAGE" | "VIDEO";
    file_size: number;
    path: string;
    date_taken: Date | null;
    capture_local: string | null;
    capture_offset_minutes: number | null;
    width: number | null;
    height: number | null;
    favorite: boolean;

    city_name: string | null;
    country_name: string | null;

    aperture: number | null;
    iso: number | null;
    exposure_time: number | null;
    focal_length_mm: number | null;
    focal_length_35mm: number | null;
    flash: string | null;
    white_balance: string | null;

    duration_seconds: number | null;
    frame_rate: number | null;
    video_codec: string | null;
    audio_codec: string | null;
    bitrate: number | null;

    file_modified_at: Date | null;
    file_modified_timezone: string | null;
};

export type AvailableMediaRow = {
    media_id: number;
    file_name: string;
    file_type: "IMAGE" | "VIDEO";
    date_taken: Date | null;
    capture_local: string | null;
    capture_offset_minutes: number | null;
    width: number | null;
    height: number | null;

    file_modified_at: Date | null;
    file_modified_timezone: string | null;
};

export type DeletedMediaRow = {
    media_id: number;
    path: string;
};

export type LibraryMediaRow = {
    media_id: number;
    file_name: string;
    file_type: "IMAGE" | "VIDEO";
    date_taken: Date | null;
    capture_local: string | null;
    capture_offset_minutes: number | null;
    date_imported: Date;
    width: number | null;
    height: number | null;
    favorite: boolean;
    city_name: string | null;
    country_name: string | null;

    file_modified_at: Date | null;
    file_modified_timezone: string | null;
};

export type AlbumRow = {
    album_id: number;
    album_name: string;
    media_count: number;
    cover_media_id: number | null;
}


let pool: Pool | undefined;
let poolUrl: string | undefined;
function getPool(): Pool {
    const url = databaseConnectionString();
    if (pool && poolUrl !== url) throw new RuntimeConfigurationError("DATABASE_URL changed; restart the application before using a different target");
    if (!pool) { pool = new Pool({ connectionString: url, connectionTimeoutMillis: 5000 }); poolUrl = url; }
    return pool;
}


export async function findMediaByPath(
    absolutePath:string
): Promise<MediaIdRow | undefined> {
    const client = await getPool().connect();

    try {
        const result = await client.query<MediaIdRow>(
            `SELECT media_id
             FROM media
             WHERE path = $1
             LIMIT 1`,
            [absolutePath]
        );

        return result.rows[0];
    }
    finally {
        client.release();
    }
}


async function findOrCreateCountry(
    client: PoolClient,
    countryName: string
): Promise<number> {
    const result = await client.query<CountryIdRow>(
        `SELECT country_id
        FROM country
        WHERE country_name = $1`,
        [countryName]
    );

    const existing = result.rows[0];

    if (existing !== undefined) {
        return existing.country_id;
    }

    const insertResult = await client.query<CountryIdRow>(
        `INSERT INTO country (country_name)
        VALUES ($1)
        ON CONFLICT (country_name)
        DO UPDATE SET country_name = EXCLUDED.country_name
        RETURNING country_id`,
        [countryName],
        
    );
    return insertResult.rows[0].country_id;
}


async function findOrCreateCity(
    client: PoolClient,
    cityName: string,
    countryId: number
): Promise<number> {
    const result = await client.query<CityIdRow>(
        `SELECT city_id
        FROM city
        WHERE city_name = $1
            AND country_id = $2`,
        [cityName, countryId]
    );

    const existing = result.rows[0];

    if (existing !== undefined) {
        return existing.city_id;
    }

    const insertResult = await client.query<CityIdRow>(
        `INSERT INTO city (
            city_name,
            country_id
        )
        VALUES ($1, $2)
        ON CONFLICT (city_name, country_id)
        DO UPDATE SET city_name = EXCLUDED.city_name
        RETURNING city_id`,
        [cityName, countryId],
        
    );

    return insertResult.rows[0].city_id;
}


export async function insertImportedMedia(
    imported: ImportedMedia,
    countryName?:string,
    cityName?: string
): Promise<number> {
    const {
        fileName,
        fileType,
        fileSize,
        absolutePath,
    } = imported.file;

    const {
        dateTaken,
        captureLocal,
        captureOffsetMinutes,
        width,
        height,
        latitude,
        longitude,
    } = imported.media;

    // Check for existing media at path
    const existingMedia = await findMediaByPath(absolutePath);
        
    if (existingMedia !== undefined) {
        throw new Error(`Media already exists with media_id: ${existingMedia.media_id} \nfor path ${absolutePath}`);
    }

    // The lookup releases its own client before we acquire the transaction client.
    const client = await getPool().connect();

    try {
        await client.query("BEGIN");

        let cityId: number | undefined;

        if (cityName !== undefined && countryName === undefined) {
            throw new Error("Cannot insert a city without a country");
        }

        if (countryName !== undefined) {
            const countryId = await findOrCreateCountry(client, countryName);

            if (cityName !== undefined) {
                cityId = await findOrCreateCity(client, cityName, countryId);
            }
        }

        const values = [
            fileName,
            fileType,
            fileSize,
            absolutePath,
            dateTaken ?? null,
            width ?? null,
            height ?? null,
            latitude ?? null,
            longitude ?? null,
            cityId ?? null,
            captureLocal ?? null,
            captureOffsetMinutes ?? null,
            imported.fileModifiedAt ?? null,
            imported.fileModifiedTimezone ?? null,
        ];

        
        const result = await client.query<MediaIdRow>(
            `INSERT INTO media (
                file_name,
                file_type,
                file_size,
                path,
                date_taken,
                width,
                height,
                latitude,
                longitude,
                city_id,
                capture_local,
                capture_offset_minutes,
                file_modified_at,
                file_modified_timezone
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamp, $12, $13, $14)
            RETURNING media_id`,
            values
        );
        
        if (result.rows.length === 0) {
            throw new Error("Media insert did not return a media_id");
        }

        const mediaId = result.rows[0].media_id;

        if (imported.file.fileType === "IMAGE") {
            if (!imported.image) {
                throw new Error("Image metadata is missing:");
            }

            const inImage = imported.image;

            await client.query(
                `INSERT INTO image (
                    media_id,
                    aperture,
                    iso,
                    exposure_time,
                    focal_length_mm,
                    focal_length_35mm,
                    flash,
                    white_balance
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [
                    mediaId,
                    inImage.aperture ?? null,
                    inImage.iso ?? null,
                    inImage.exposureTime ?? null,
                    inImage.focalLengthMm ?? null,
                    inImage.focalLength35mm ?? null,
                    inImage.flash ?? null,
                    inImage.whiteBalance ?? null,

                ]
            );
        }
        else if (imported.file.fileType === "VIDEO") {
            if (!imported.video) {
                throw new Error("Video metadata is missing");
            }

            const inVideo = imported.video;

            await client.query(
                `INSERT INTO video (
                    media_id,
                    duration_seconds,
                    frame_rate,
                    video_codec,
                    audio_codec,
                    bitrate
                )
                VALUES ($1, $2, $3, $4, $5, $6)`,
                [
                    mediaId,
                    inVideo.durationSeconds ?? null,
                    inVideo.frameRate ?? null,
                    inVideo.videoCodec ?? null,
                    inVideo.audioCodec ?? null,
                    inVideo.bitrate ?? null,
                ]
            );
        }

        await client.query("COMMIT");

        // generated media_id
        return mediaId;
    }
    catch (error) {
        await client.query("ROLLBACK");
        throw error;
    }
    finally {
        client.release();
    }
}


export async function updateImportedMedia(
    mediaId: number,
    imported: ImportedMedia,
    countryName?: string,
    cityName?: string,
    replacement?: { receipt: ReplacementReceipt; assertStorage: () => Promise<void> }
): Promise<void> {
    const {
        fileName,
        fileType,
        fileSize,
        absolutePath,
    } = imported.file;

    const {
        dateTaken,
        captureLocal,
        captureOffsetMinutes,
        width,
        height,
        latitude,
        longitude,
    } = imported.media;
    
    if (replacement && (replacement.receipt.mediaId !== mediaId || replacement.receipt.target !== absolutePath)) {
        throw new Error("Replacement receipt does not match metadata");
    }
    const client = await getPool().connect();

    try {
        await client.query("BEGIN");
        if (replacement) {
            await client.query("SET LOCAL synchronous_commit = on");
            await lockReplacementTransaction(client, replacement.receipt.operationId);
        }

        let cityId: number | undefined;

        if (cityName !== undefined && countryName === undefined) {
            throw new Error("Cannot insert a city without a country");
        }

        if (countryName !== undefined) {
            const countryId = await findOrCreateCountry(client, countryName);

            if (cityName !== undefined) {
                cityId = await findOrCreateCity(client, cityName, countryId);
            }
        }

        const values = [
            fileName,
            fileType,
            fileSize,
            absolutePath,
            dateTaken ?? null,
            width ?? null,
            height ?? null,
            latitude ?? null,
            longitude ?? null,
            cityId ?? null,
            mediaId,
            captureLocal ?? null,
            captureOffsetMinutes ?? null,
            imported.fileModifiedAt ?? null,
            imported.fileModifiedTimezone ?? null,
        ];

        const updated = await client.query(
            `UPDATE media
            SET file_name = $1,
                file_type = $2,
                file_size = $3,
                path = $4,
                date_taken = $5,
                width = $6,
                height = $7,
                latitude = $8,
                longitude = $9,
                city_id = $10,
                capture_local = $12::timestamp,
                capture_offset_minutes = $13,
                file_modified_at = $14,
                file_modified_timezone = $15
            WHERE media_id = $11`,
            values
        );

        if (replacement && updated.rowCount !== 1) throw new Error("Replacement media no longer exists");

        if (imported.file.fileType === "IMAGE") {
            if (!imported.image) {
                throw new Error("Image metadata is missing:");
            }

            const inImage = imported.image;

            await client.query(
                `UPDATE image
                SET aperture = $2,
                    iso = $3,
                    exposure_time = $4,
                    focal_length_mm =$5,
                    focal_length_35mm = $6,
                    flash = $7,
                    white_balance = $8
                WHERE media_id = $1`,
                [
                    mediaId,
                    inImage.aperture ?? null,
                    inImage.iso ?? null,
                    inImage.exposureTime ?? null,
                    inImage.focalLengthMm ?? null,
                    inImage.focalLength35mm ?? null,
                    inImage.flash ?? null,
                    inImage.whiteBalance ?? null,

                ]
            );
        }
        else if (imported.file.fileType === "VIDEO") {
            if (!imported.video) {
                throw new Error("Video metadata is missing");
            }

            const inVideo = imported.video;

            await client.query(
                `UPDATE video
                SET duration_seconds = $2,
                    frame_rate = $3,
                    video_codec = $4,
                    audio_codec = $5,
                    bitrate = $6
                WHERE media_id = $1`,
                [
                    mediaId,
                    inVideo.durationSeconds ?? null,
                    inVideo.frameRate ?? null,
                    inVideo.videoCodec ?? null,
                    inVideo.audioCodec ?? null,
                    inVideo.bitrate ?? null,
                ]
            );
        }

        if (replacement) {
            const receipt = replacement.receipt;
            await client.query(
                `INSERT INTO public.media_replacement_receipts
                 (operation_id, media_id, target_path, original_sha256, incoming_sha256)
                 VALUES ($1, $2, $3, $4, $5)`,
                [receipt.operationId, receipt.mediaId, receipt.target, receipt.originalSha256, receipt.incomingSha256]
            );
            await replacement.assertStorage();
        }
        await client.query("COMMIT");
    }
    catch (error) {
        await client.query("ROLLBACK");
        throw error;
    }
    finally {
        client.release();
    }
}


export async function createTrip(
    tripName: string
): Promise<number> {
    const client = await getPool().connect();

    try {
        const result = await client.query<{ trip_id: number }>(
            `INSERT INTO trip (trip_name)
            VALUES ($1)
            RETURNING trip_id`,
            [tripName]
        );

        return result.rows[0].trip_id;
    }
    finally {
        client.release();
    }
}


export async function getTrips(): Promise<TripRow[]> {
    const client = await getPool().connect();

    try{
        const result = await client.query<TripRow>(
            `SELECT
                t.trip_id,
                t.trip_name,
                COUNT(m.media_id)::int AS media_count,
                MIN(m.media_id) AS cover_media_id
            FROM trip t
            LEFT JOIN media m
                ON m.trip_id = t.trip_id
            GROUP BY
                t.trip_id,
                t.trip_name
            ORDER BY t.trip_id DESC`
        );

        return result.rows;
    }
    finally {
        client.release();
    }
}


export async function getTripById(
    tripId: number
): Promise<TripRow | undefined> {
    const client = await getPool().connect();

    try {
        const result = await client.query<TripRow>(
            `SELECT
                t.trip_id,
                t.trip_name,
                MIN(m.media_id) AS cover_media_id
            FROM trip t
            LEFT JOIN media m
                ON m.trip_id = t.trip_id
            WHERE t.trip_id = $1
            GROUP BY
                t.trip_id,
                t.trip_name
            LIMIT 1`,
            [tripId]
        );

        return result.rows[0];
    }
    finally {
        client.release();
    }
}


export async function getMediaByTripId(
    tripId: number
): Promise<TripMediaRow[]> {
    const client = await getPool().connect();

    try {
        const result = await client.query<TripMediaRow>(
            `SELECT
                media_id,
                file_name,
                file_type,
                path,
                date_taken,
                to_char(capture_local, 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS capture_local,
                capture_offset_minutes,
                width,
                height,
                favorite,
                file_modified_at,
                file_modified_timezone
             FROM media
             WHERE trip_id = $1
             ORDER BY
                COALESCE(capture_local, date_taken AT TIME ZONE 'UTC', file_modified_at AT TIME ZONE 'UTC', date_imported AT TIME ZONE 'UTC') DESC,
                media_id DESC`,
            [tripId]
        );

        return result.rows;
    }
    finally {
        client.release();
    }
}


export async function addMediaToTrip(mediaIds: number | number[], tripId: number): Promise<number> {
    const ids = collectionIds(typeof mediaIds === "number" ? [mediaIds] : mediaIds);
    collectionId(tripId);
    const client = await getPool().connect();
    try {
        await client.query("BEGIN");
        await lockTrips(client, [tripId]);
        const media = await lockCollectionMedia(client, ids);
        const missing = ids.filter(id => !media.some(row => row.media_id === id));
        if (missing.length) throw new CollectionIntegrityError("Media not found", 404, missing);
        const assigned = media.filter(row => row.trip_id !== null).map(row => row.media_id);
        if (assigned.length) throw new CollectionIntegrityError("Media already belongs to a Trip; use Move Media", 409, assigned);
        const result = await client.query<{ media_id: number }>(
            `UPDATE media SET trip_id = $1 WHERE media_id = ANY($2::int[]) AND trip_id IS NULL RETURNING media_id`, [tripId, ids]);
        if (result.rows.length !== ids.length) throw new CollectionIntegrityError("Trip membership changed; retry selection");
        await client.query("COMMIT");
        return result.rowCount ?? result.rows.length;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
}


export async function removeMediaFromTrip(
    mediaId: number,
    tripId: number
): Promise<boolean> {
    const client = await getPool().connect();

    try {
        const result = await client.query(
            `UPDATE media
            SET trip_id = NULL
            WHERE media_id = $1
            AND trip_id = $2`,
            [mediaId, tripId]
        );

        return result.rowCount === 1;
    }
    finally {
        client.release();
    }
}


export async function getMediaFileById (
    mediaId: number
): Promise<MediaFileRow | undefined> {
    const client = await getPool().connect();

    try {
        const result = await client.query<MediaFileRow>(
            `SELECT
                media_id,
                file_name,
                file_type,
                path
            FROM media
            WHERE media_id = $1`,
            [mediaId]
        );

        return result.rows[0];
    }
    finally {
        client.release();
    }
}


export async function getMediaDetailsById(
    mediaId: number
): Promise<MediaDetailRow | undefined> {
    const client = await getPool().connect();
    
    try {
        const result = await client.query<MediaDetailRow>(
            `SELECT
                m.media_id,
                m.file_name,
                m.file_type,
                m.file_size,
                m.path,
                m.date_taken,
                to_char(m.capture_local, 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS capture_local,
                m.capture_offset_minutes,
                m.width,
                m.height,
                m.favorite,

                c.city_name,
                co.country_name,

                i.aperture,
                i.iso,
                i.exposure_time,
                i.focal_length_mm,
                i.focal_length_35mm,
                i.flash,
                i.white_balance,

                v.duration_seconds,
                v.frame_rate,
                v.video_codec,
                v.audio_codec,
                v.bitrate,

                m.file_modified_at,
                m.file_modified_timezone

            FROM media m

            LEFT JOIN city c
                ON m.city_id = c.city_id

            LEFT JOIN country co
                ON c.country_id = co.country_id

            LEFT JOIN image i
                ON m.media_id = i.media_id

            LEFT JOIN video v
                ON m.media_id = v.media_id

            WHERE m.media_id = $1

            LIMIT 1;`,
            [mediaId]
        );

        return result.rows[0];
    }
    finally {
        client.release();
    }
}


export async function getAvailableMedia(): Promise<AvailableMediaRow[]> {
    const client = await getPool().connect();

    try {
        const result = await client.query<AvailableMediaRow>(
            `SELECT
                media_id,
                file_name,
                file_type,
                date_taken,
                to_char(capture_local, 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS capture_local,
                capture_offset_minutes,
                width,
                height,
                file_modified_at,
                file_modified_timezone
            FROM media
            WHERE trip_id IS NULL
            ORDER BY 
                COALESCE(capture_local, date_taken AT TIME ZONE 'UTC', file_modified_at AT TIME ZONE 'UTC', date_imported AT TIME ZONE 'UTC') DESC,
                media_id DESC`
        );

        return result.rows;
    }
    finally {
        client.release();
    }
}


export async function moveMediaToTrip(
    mediaIds: number[],
    sourceTripId: number,
    targetTripId: number
): Promise<number[]> {
    const ids = collectionIds(mediaIds);
    collectionId(sourceTripId); collectionId(targetTripId);
    if (sourceTripId === targetTripId) throw new CollectionIntegrityError("Source and target Trips are the same", 400);
    const client = await getPool().connect()

    try {
        await client.query("BEGIN");
        await lockTrips(client, [sourceTripId, targetTripId]);
        await lockCollectionMedia(client, ids);

        const result = await client.query(
            `UPDATE media
            SET trip_id = $1
            WHERE trip_id = $2
            AND media_id = ANY($3::int[])
            RETURNING media_id`,
            [
                targetTripId,
                sourceTripId,
                ids
            ]
        );

        const movedMediaIds = result.rows.map(
            row => row.media_id
        );
    
        const failedMediaIds = ids.filter(
            mediaId => 
                !movedMediaIds.includes(mediaId)
        );

        if (failedMediaIds.length === 0) {
            await client.query("COMMIT");
        } 
        else {
            await client.query("ROLLBACK");
        }

        return failedMediaIds;
    }
    catch (error) {
        await client.query("ROLLBACK");
        throw error;
    }
    finally {
        client.release();
    }
}


export async function moveLibraryMediaToTrip(
    mediaId: number,
    targetTripId: number
): Promise<"moved" | "already-in-trip"> {
    const ids = collectionIds([mediaId]);
    collectionId(targetTripId);

    const client = await getPool().connect();

    try {
        await client.query("BEGIN");

        // Maintain the existing lock ordering:
        // Trip rows before media rows.
        await lockTrips(client, [targetTripId]);

        const media = await lockCollectionMedia(client, ids);
        const current = media.find(row => row.media_id === mediaId);

        if (!current) {
            throw new CollectionIntegrityError(
                "Media not found",
                404,
                [mediaId]
            );
        }

        if (current.trip_id === targetTripId) {
            await client.query("COMMIT");
            return "already-in-trip";
        }

        const result = await client.query(
            `UPDATE media
             SET trip_id = $1
             WHERE media_id = $2`,
            [targetTripId, mediaId]
        );

        if (result.rowCount !== 1) {
            throw new CollectionIntegrityError(
                "Trip membership changed",
                409,
                [mediaId]
            );
        }

        await client.query("COMMIT");
        return "moved";
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}


export async function deleteMediaById(
    mediaId: number,
    verifyStorage: () => Promise<void>,
    receipt: DeletionReceipt,
): Promise<DeletedMediaRow | undefined> {
    if (receipt.mediaId !== mediaId) throw new Error("Deletion receipt media mismatch");
    const client = await getPool().connect();
    try {
        await client.query("BEGIN");
        await client.query("SET LOCAL synchronous_commit = on");
        await lockReplacementTransaction(client, receipt.operationId);
        await verifyStorage();
        await coordinateAlbumDeletion(client, true);
        await lockCollectionMedia(client, [mediaId]);
        // The exclusive transaction guard stabilizes membership discovery. All
        // Album writers hold its shared counterpart before locking Album rows.
        const albums = await client.query<{ album_id: number }>(
            `SELECT a.album_id FROM album a
             WHERE a.album_id IN (SELECT ma.album_id FROM media_album ma WHERE ma.media_id = $1)
               OR a.cover_media_id = $1 ORDER BY a.album_id FOR UPDATE`, [mediaId]);
        const result = await client.query<DeletedMediaRow>(
            `DELETE FROM media WHERE media_id = $1 AND path = $2 RETURNING media_id, path`,
            [mediaId, receipt.target]);
        if (result.rowCount !== 1 || result.rows[0]?.path !== receipt.target) throw new Error("Deletion target metadata changed");
        await client.query(`INSERT INTO public.media_deletion_receipts
            (operation_id, media_id, target_path, original_identity) VALUES ($1, $2, $3, $4::jsonb)`,
            [receipt.operationId, mediaId, receipt.target, JSON.stringify(receipt.original)]);
        await repairAlbumCovers(client, albums.rows.map(row => row.album_id));
        await verifyStorage();
        await client.query("COMMIT");
        return result.rows[0];
    } catch (error) {
        try { await client.query("ROLLBACK"); }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], "Deletion outcome unresolved; rollback failed"); }
        throw error;
    } finally { client.release(); }
}


export async function getLibraryMedia():
    Promise<LibraryMediaRow[]> {
    const client = await getPool().connect();

    try {
        const result = await client.query<LibraryMediaRow>(
                `SELECT
                    m.media_id,
                    m.file_name,
                    m.file_type,
                    m.date_taken,
                to_char(m.capture_local, 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS capture_local,
                    m.capture_offset_minutes,
                    m.file_modified_at,
                    m.file_modified_timezone,
                    m.date_imported,
                    m.width,
                    m.height,
                    m.favorite,
                    c.city_name,
                    co.country_name
                 FROM media m
                 LEFT JOIN city c
                    ON m.city_id = c.city_id
                 LEFT JOIN country co
                    ON c.country_id = co.country_id
                 ORDER BY
                    COALESCE(
                        m.capture_local, 
                        m.date_taken AT TIME ZONE 'UTC', 
                        m.file_modified_at AT TIME ZONE 'UTC', 
                        m.date_imported AT TIME ZONE 'UTC')
                    DESC,
                    m.media_id DESC`
            );

        return result.rows;
    }
    finally {
        client.release();
    }
}


export async function getAlbums(): Promise<AlbumRow[]> {
    const client = await getPool().connect();

    try {
        const result = await client.query<AlbumRow>(`
            SELECT
                a.album_id,
                a.album_name,
                a.cover_media_id,
                COUNT(ma.media_id)::int AS media_count
            FROM album a
            LEFT JOIN media_album ma
                ON ma.album_id = a.album_id
            GROUP BY 
                a.album_id,
                a.album_name,
                a.cover_media_id
            ORDER BY
                a.album_id DESC`
        );
        
        return result.rows;
    }
    finally {
        client.release();
    }
}


export async function createAlbum(
    albumName: string
): Promise<number> {
    const client = await getPool().connect();

    try {
        const result = await client.query<{ album_id: number }>(
                `INSERT INTO album (
                    album_name
                 )
                 VALUES ($1)
                 RETURNING album_id`,
                [albumName]
            );

        return result.rows[0].album_id;
    }
    finally {
        client.release();
    }
}


export async function getAlbumById(
    albumId: number
): Promise<AlbumRow | undefined> {
    const client = await getPool().connect();

    try {
        const result = await client.query<AlbumRow>(
            `SELECT
                album_id,
                album_name,
                cover_media_id
             FROM album
             WHERE album_id = $1`,
            [albumId]
        );

        return result.rows[0];
    }
    finally {
        client.release();
    }
}


export async function getMediaByAlbumId(
    albumId: number
): Promise<AlbumMediaRow[]> {
    const client = await getPool().connect();

    try {
        const result = await client.query<AlbumMediaRow>(
            `SELECT
                m.media_id,
                m.file_name,
                m.file_type,
                m.path,
                m.date_taken,
                to_char(m.capture_local, 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS capture_local,
                m.capture_offset_minutes,
                m.date_imported,
                m.width,
                m.height,
                m.favorite
                m.file_modified_at,
                m.file_modified_timezone
             FROM media m
             INNER JOIN media_album ma
                ON ma.media_id = m.media_id
             WHERE ma.album_id = $1
             ORDER BY
                COALESCE(m.capture_local, m.date_taken AT TIME ZONE 'UTC', m.file_modified_at AT TIME ZONE 'UTC', m.date_imported AT TIME ZONE 'UTC') DESC,
                m.media_id DESC`,
            [albumId]
        );

        return result.rows;
    }
    finally {
        client.release();
    }
}


export async function addMediaToAlbum(mediaId: number, albumId: number): Promise<number> {
    collectionId(mediaId); collectionId(albumId);
    const client = await getPool().connect();
    try {
        await client.query("BEGIN");
        await coordinateAlbumDeletion(client);
        await lockAlbums(client, [albumId]);
        const media = await lockCollectionMedia(client, [mediaId], true);
        if (!media.length) throw new CollectionIntegrityError("Media not found", 404, [mediaId]);
        const result = await client.query(`INSERT INTO media_album (media_id, album_id) VALUES ($1, $2)
            ON CONFLICT (media_id, album_id) DO NOTHING RETURNING media_id`, [mediaId, albumId]);
        await repairAlbumCovers(client, [albumId]);
        await client.query("COMMIT");
        return result.rowCount ?? result.rows.length;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
}

export async function removeMediaFromAlbum(mediaId: number, albumId: number): Promise<boolean> {
    collectionId(mediaId); collectionId(albumId);
    const client = await getPool().connect();
    try {
        await client.query("BEGIN");
        await coordinateAlbumDeletion(client);
        await lockAlbums(client, [albumId]);
        await lockCollectionMedia(client, [mediaId], true);
        const result = await client.query(`DELETE FROM media_album WHERE media_id = $1 AND album_id = $2 RETURNING media_id`, [mediaId, albumId]);
        if (result.rowCount !== 1) { await client.query("ROLLBACK"); return false; }
        await repairAlbumCovers(client, [albumId]);
        await client.query("COMMIT");
        return true;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
}

async function transferAlbumMedia(mediaIds: number[], sourceAlbumId: number, targetAlbumId: number, move: boolean): Promise<number> {
    const ids = collectionIds(mediaIds);
    collectionId(sourceAlbumId); collectionId(targetAlbumId);
    if (sourceAlbumId === targetAlbumId) throw new CollectionIntegrityError("Source and target Albums are the same", 400);
    const client = await getPool().connect();
    try {
        await client.query("BEGIN");
        await coordinateAlbumDeletion(client);
        await lockAlbums(client, [sourceAlbumId, targetAlbumId]);
        const media = await lockCollectionMedia(client, ids, true);
        const absent = ids.filter(id => !media.some(row => row.media_id === id));
        if (absent.length) throw new CollectionIntegrityError("Media not found", 404, absent);
        const source = await client.query<{ media_id: number }>(`SELECT media_id FROM media_album
            WHERE album_id = $1 AND media_id = ANY($2::int[]) ORDER BY media_id`, [sourceAlbumId, ids]);
        const missing = ids.filter(id => !source.rows.some(row => row.media_id === id));
        if (missing.length) throw new CollectionIntegrityError("Selection is no longer part of the source Album", 409, missing);
        const inserted = await client.query(`INSERT INTO media_album (media_id, album_id)
            SELECT media_id, $1 FROM media_album WHERE album_id = $2 AND media_id = ANY($3::int[])
            ON CONFLICT (media_id, album_id) DO NOTHING RETURNING media_id`, [targetAlbumId, sourceAlbumId, ids]);
        let count = inserted.rowCount ?? inserted.rows.length;
        if (move) {
            const removed = await client.query(`DELETE FROM media_album WHERE album_id = $1 AND media_id = ANY($2::int[]) RETURNING media_id`, [sourceAlbumId, ids]);
            count = removed.rowCount ?? removed.rows.length;
            if (count !== ids.length) throw new CollectionIntegrityError("Source Album membership changed; retry selection");
        }
        await repairAlbumCovers(client, [sourceAlbumId, targetAlbumId]);
        await client.query("COMMIT");
        return count;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
}

export async function moveMediaToAlbum(mediaIds: number[], sourceAlbumId: number, targetAlbumId: number): Promise<number> {
    return transferAlbumMedia(mediaIds, sourceAlbumId, targetAlbumId, true);
}
export async function copyMediaToAlbum(mediaIds: number[], sourceAlbumId: number, targetAlbumId: number): Promise<number> {
    return transferAlbumMedia(mediaIds, sourceAlbumId, targetAlbumId, false);
}


export async function setMediaFavorite(
    mediaId: number,
    favorite: boolean
): Promise<boolean> {
    const client = await getPool().connect();

    try {
        const result = await client.query(
            `UPDATE media
             SET favorite = $2
             WHERE media_id = $1`,
            [mediaId, favorite]
        );

        return result.rowCount === 1;
    }
    finally {
        client.release();
    }
}


export async function renameTrip(
    tripId: number,
    tripName: string
): Promise<boolean> {
    const client = await getPool().connect();

    try {
        const result = await client.query(
            `UPDATE trip
             SET trip_name = $2
             WHERE trip_id = $1`,
            [tripId, tripName]
        );

        return result.rowCount === 1;
    }
    finally {
        client.release();
    }
}


export async function deleteTrip(
    tripId: number
): Promise<boolean> {
    const client = await getPool().connect();

    try {
        const result = await client.query(
            `DELETE FROM trip
             WHERE trip_id = $1`,
            [tripId]
        );

        return result.rowCount === 1;
    }
    finally {
        client.release();
    }
}


export async function renameAlbum(
    albumId: number,
    albumName: string
): Promise<boolean> {
    const client = await getPool().connect();

    try {
        const result = await client.query(
            `UPDATE album
             SET album_name = $1
             WHERE album_id = $2`,
            [albumName, albumId]
        );

        return result.rowCount === 1;
    }
    finally {
        client.release();
    }
}


export async function deleteAlbum(albumId: number): Promise<boolean> {
    collectionId(albumId);
    const client = await getPool().connect();
    try {
        await client.query("BEGIN");
        await coordinateAlbumDeletion(client);
        // The FK cascades only membership rows; media records are preserved.
        const result = await client.query(`DELETE FROM album WHERE album_id = $1`, [albumId]);
        await client.query("COMMIT");
        return result.rowCount === 1;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
}

// Read the primary database; failures must never be interpreted as a missing receipt.
export async function getReplacementReceipt(operationId: string): Promise<ReplacementReceipt | undefined> {
    const client = await getPool().connect();
    try {
        const result = await client.query<ReplacementReceipt>(
            `SELECT operation_id::text AS "operationId", media_id AS "mediaId", target_path AS target,
                    original_sha256 AS "originalSha256", incoming_sha256 AS "incomingSha256"
             FROM public.media_replacement_receipts WHERE operation_id = $1`, [operationId]);
        return result.rows[0];
    } finally { client.release(); }
}

async function lockReplacementTransaction(client: PoolClient, operationId: string) {
    const result = await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 48291)) AS locked", [operationId]);
    if (!result.rows[0]?.locked) throw new Error("Replacement database operation is still running or recovery is active");
}

// A fresh READ COMMITTED snapshot AFTER the advisory lock is acquired makes
// absence conclusive. The original transaction must have released the same lock.
export async function withReplacementRecoveryDatabase<T>(operationId: string, mediaId: number,
    action: (evidence: ReplacementEvidence) => Promise<T>): Promise<T> {
    const client = await getPool().connect();
    try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
        await lockReplacementTransaction(client, operationId);
        const receipt = await client.query<ReplacementReceipt>(
            `SELECT operation_id::text AS "operationId", media_id AS "mediaId", target_path AS target,
                    original_sha256 AS "originalSha256", incoming_sha256 AS "incomingSha256"
             FROM public.media_replacement_receipts WHERE operation_id=$1`, [operationId]);
        const media = await client.query<{ path: string }>("SELECT path FROM public.media WHERE media_id=$1", [mediaId]);
        const result = await action({ receipt: receipt.rows[0], mediaPath: media.rows[0]?.path });
        await client.query("COMMIT");
        return result;
    } catch (error) {
        try { await client.query("ROLLBACK"); }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], "Recovery transaction close failed"); }
        throw error;
    } finally { client.release(); }
}

// Receipt absence is conclusive only after acquiring the original operation lock.
export async function withDeletionRecoveryDatabase<T>(operationId: string, mediaId: number, target: string,
    action: (evidence: DeletionEvidence) => Promise<T>): Promise<T> {
    const client = await getPool().connect();
    try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
        const primary = await client.query("SELECT pg_is_in_recovery() AS standby");
        if (primary.rows[0]?.standby !== false) throw new Error("Deletion recovery requires the verified primary database");
        await lockReplacementTransaction(client, operationId);
        const receipt = await client.query<DeletionReceipt>(
            `SELECT operation_id::text AS "operationId", media_id AS "mediaId", target_path AS target,
                    original_identity AS original FROM public.media_deletion_receipts WHERE operation_id=$1`, [operationId]);
        const media = await client.query<{ media_id: number; path: string }>(
            "SELECT media_id, path FROM public.media WHERE media_id=$1 OR path=$2", [mediaId, target]);
        const result = await action({ receipt: receipt.rows[0], media: media.rows });
        await client.query("COMMIT");
        return result;
    } catch (error) {
        try { await client.query("ROLLBACK"); }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], "Deletion recovery transaction close failed"); }
        throw error;
    } finally { client.release(); }
}

// Maintenance CLI shutdown; request handlers keep their shared pool alive.
export async function closeMediaDatabase(): Promise<void> { if (pool) await pool.end(); pool = undefined; poolUrl = undefined; }
