-- Durable evidence committed atomically with media deletion. No foreign key:
-- receipts must outlive deleted media. JSON null records a verified missing file.
CREATE TABLE public.media_deletion_receipts (
    operation_id uuid PRIMARY KEY,
    media_id integer NOT NULL CHECK (media_id > 0),
    target_path text NOT NULL,
    original_identity jsonb NOT NULL CHECK ((
        original_identity = 'null'::jsonb OR (
            jsonb_typeof(original_identity) = 'object'
            AND original_identity ?& ARRAY['sha256', 'size', 'device', 'inode']
            AND (original_identity->>'sha256') ~ '^[0-9a-f]{64}$'
            AND (original_identity->>'size') ~ '^[0-9]+$'
            AND (original_identity->>'device') ~ '^[0-9]+$'
            AND (original_identity->>'inode') ~ '^[0-9]+$'
        )
    ) IS TRUE),
    committed_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);
