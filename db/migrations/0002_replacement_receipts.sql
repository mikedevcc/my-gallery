-- Durable evidence that replacement metadata committed. Retain receipts even
-- after media deletion: intentionally no cascading foreign key or automatic GC.
CREATE TABLE public.media_replacement_receipts (
    operation_id uuid PRIMARY KEY,
    media_id integer NOT NULL CHECK (media_id > 0),
    target_path text NOT NULL,
    original_sha256 text NOT NULL CHECK (original_sha256 ~ '^[0-9a-f]{64}$'),
    incoming_sha256 text NOT NULL CHECK (incoming_sha256 ~ '^[0-9a-f]{64}$'),
    committed_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);
