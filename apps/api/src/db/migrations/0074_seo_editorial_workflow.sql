ALTER TABLE "blog_posts"
  ADD COLUMN IF NOT EXISTS "editorial_status" text,
  ADD COLUMN IF NOT EXISTS "version" integer DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "generated_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "review_requested_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "reviewed_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "reviewed_by" uuid,
  ADD COLUMN IF NOT EXISTS "published_by" uuid,
  ADD COLUMN IF NOT EXISTS "generation_key_hash" text,
  ADD COLUMN IF NOT EXISTS "last_error" text;

UPDATE "blog_posts"
SET
  "editorial_status" = CASE
    WHEN "published_at" IS NOT NULL THEN 'published'
    ELSE 'draft'
  END,
  "generated_at" = COALESCE("generated_at", "created_at")
WHERE "editorial_status" IS NULL OR "generated_at" IS NULL;

ALTER TABLE "blog_posts"
  ALTER COLUMN "editorial_status" SET DEFAULT 'draft',
  ALTER COLUMN "editorial_status" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'blog_posts_editorial_status_check'
  ) THEN
    ALTER TABLE "blog_posts"
      ADD CONSTRAINT "blog_posts_editorial_status_check"
      CHECK ("editorial_status" IN ('draft', 'review', 'published', 'failed'))
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'blog_posts_version_check'
  ) THEN
    ALTER TABLE "blog_posts"
      ADD CONSTRAINT "blog_posts_version_check"
      CHECK ("version" > 0)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'blog_posts_publication_state_check'
  ) THEN
    ALTER TABLE "blog_posts"
      ADD CONSTRAINT "blog_posts_publication_state_check"
      CHECK (
        ("editorial_status" = 'published' AND "published_at" IS NOT NULL)
        OR
        ("editorial_status" <> 'published' AND "published_at" IS NULL)
      )
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'blog_posts_reviewed_by_team_member_fk'
  ) THEN
    ALTER TABLE "blog_posts"
      ADD CONSTRAINT "blog_posts_reviewed_by_team_member_fk"
      FOREIGN KEY ("reviewed_by") REFERENCES "team_members"("id")
      ON DELETE SET NULL NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'blog_posts_published_by_team_member_fk'
  ) THEN
    ALTER TABLE "blog_posts"
      ADD CONSTRAINT "blog_posts_published_by_team_member_fk"
      FOREIGN KEY ("published_by") REFERENCES "team_members"("id")
      ON DELETE SET NULL NOT VALID;
  END IF;
END $$;

ALTER TABLE "blog_posts"
  VALIDATE CONSTRAINT "blog_posts_editorial_status_check";
ALTER TABLE "blog_posts"
  VALIDATE CONSTRAINT "blog_posts_version_check";
ALTER TABLE "blog_posts"
  VALIDATE CONSTRAINT "blog_posts_publication_state_check";
ALTER TABLE "blog_posts"
  VALIDATE CONSTRAINT "blog_posts_reviewed_by_team_member_fk";
ALTER TABLE "blog_posts"
  VALIDATE CONSTRAINT "blog_posts_published_by_team_member_fk";

CREATE INDEX IF NOT EXISTS "blog_posts_editorial_status_updated_idx"
  ON "blog_posts" ("editorial_status", "updated_at" DESC);

CREATE UNIQUE INDEX IF NOT EXISTS "blog_posts_generation_key_hash_key"
  ON "blog_posts" ("generation_key_hash")
  WHERE "generation_key_hash" IS NOT NULL;
