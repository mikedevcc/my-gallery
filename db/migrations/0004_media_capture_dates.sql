-- Preserve camera-local capture calendars without inventing timezone knowledge.
-- Additive only: legacy timestamps and existing media records are not backfilled.
ALTER TABLE public.media
    ADD COLUMN capture_local timestamp(3) without time zone,
    ADD COLUMN capture_offset_minutes smallint,
    ADD CONSTRAINT media_capture_offset_check
        CHECK (capture_offset_minutes BETWEEN -840 AND 840),
    ADD CONSTRAINT media_capture_date_consistency_check CHECK (
        (capture_local IS NULL AND capture_offset_minutes IS NULL)
        OR (capture_local IS NOT NULL AND (
            (capture_offset_minutes IS NULL AND date_taken IS NULL)
            OR (capture_offset_minutes IS NOT NULL AND date_taken IS NOT NULL
                AND date_taken = (capture_local AT TIME ZONE 'UTC')
                    - make_interval(mins => capture_offset_minutes))
        ))
    );
