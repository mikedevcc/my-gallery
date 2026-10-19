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
    width: number | null;
    height: number | null;
    favorite: boolean;
};

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
};

export type AvailableMediaRow = {
    media_id: number;
    file_name: string;
    file_type: "IMAGE" | "VIDEO";
    date_taken: Date | null;
    width: number | null;
    height: number | null;
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
    date_imported: Date;
    width: number | null;
    height: number | null;
    favorite: boolean;
    city_name: string | null;
    country_name: string | null;
};


const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});


export async function findMediaByPath(
    absolutePath:string
): Promise<MediaIdRow | undefined> {
    const client = await pool.connect();

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
        width,
        height,
        latitude,
        longitude,
    } = imported.media;

    const client = await pool.connect();

    // Check for existing media at path
    const existingMedia = await findMediaByPath(absolutePath);
        
    if (existingMedia !== undefined) {
        throw new Error(`Media already exists with media_id: ${existingMedia.media_id} \nfor path ${absolutePath}`);
    }

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
                city_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
    cityName?: string
): Promise<void> {
    const {
        fileName,
        fileType,
        fileSize,
        absolutePath,
    } = imported.file;

    const {
        dateTaken,
        width,
        height,
        latitude,
        longitude,
    } = imported.media;
    
    const client = await pool.connect();

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
            mediaId
        ];

        await client.query(
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
                city_id = $10
            WHERE media_id = $11`,
            values
        );

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
    const client = await pool.connect();

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
    const client = await pool.connect();

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
    const client = await pool.connect();

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
    const client = await pool.connect();

    try {
        const result = await client.query<TripMediaRow>(
            `SELECT
                media_id,
                file_name,
                file_type,
                path,
                date_taken,
                width,
                height,
                favorite
             FROM media
             WHERE trip_id = $1
             ORDER BY date_taken ASC NULLS LAST`,
            [tripId]
        );

        return result.rows;
    }
    finally {
        client.release();
    }
}


export async function addMediaToTrip(
    mediaId: number,
    tripId: number
): Promise<void> {
    const client = await pool.connect();

    try {
        await client.query(
            `UPDATE media
            SET trip_id = $1
            WHERE media_id = $2`,
            [tripId, mediaId]
        );
    }
    finally {
        client.release();
    }
}


export async function removeMediaFromTrip(
    mediaId: number,
    tripId: number
): Promise<boolean> {
    const client = await pool.connect();

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
    const client = await pool.connect();

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
    const client = await pool.connect();
    
    try {
        const result = await client.query<MediaDetailRow>(
            `SELECT
                m.media_id,
                m.file_name,
                m.file_type,
                m.file_size,
                m.path,
                m.date_taken,
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
                v.bitrate

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
    const client = await pool.connect();

    try {
        const result = await client.query<AvailableMediaRow>(
            `SELECT
                media_id,
                file_name,
                file_type,
                date_taken,
                width,
                height
            FROM media
            WHERE trip_id IS NULL
            ORDER BY 
                COALESCE(date_taken, date_imported) DESC,
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
    const client = await pool.connect()

    try {
        await client.query("BEGIN");

        const result = await client.query(
            `UPDATE media
            SET trip_id = $1
            WHERE trip_id = $2
            AND media_id = ANY($3::int[])
            RETURNING media_id`,
            [
                targetTripId,
                sourceTripId,
                mediaIds
            ]
        );

        const movedMediaIds = result.rows.map(
            row => row.media_id
        );
    
        const failedMediaIds = mediaIds.filter(
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


export async function deleteMediaById(
    mediaId: number
): Promise<DeletedMediaRow | undefined> {
    const client = await pool.connect();

    try {
        const result =
            await client.query<DeletedMediaRow>(
                `DELETE FROM media
                 WHERE media_id = $1
                 RETURNING
                    media_id,
                    path`,
                [mediaId]
            );

        return result.rows[0];
    }
    finally {
        client.release();
    }
}


export async function getLibraryMedia():
    Promise<LibraryMediaRow[]> {
    const client = await pool.connect();

    try {
        const result =
            await client.query<LibraryMediaRow>(
                `SELECT
                    m.media_id,
                    m.file_name,
                    m.file_type,
                    m.date_taken,
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
                    COALESCE(date_taken, date_imported) DESC,
                    m.media_id DESC`
            );

        return result.rows;
    }
    finally {
        client.release();
    }
}