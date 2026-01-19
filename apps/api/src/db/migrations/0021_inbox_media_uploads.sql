CREATE TABLE IF NOT EXISTS "inbox_media_uploads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "token" text NOT NULL,
  "filename" text,
  "content_type" text NOT NULL,
  "bytes" bytea NOT NULL,
  "byte_length" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);

CREATE INDEX IF NOT EXISTS "inbox_media_uploads_expires_idx"
  ON "inbox_media_uploads" ("expires_at");

