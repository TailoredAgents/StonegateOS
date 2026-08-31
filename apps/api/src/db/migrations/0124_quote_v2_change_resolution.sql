-- Durable, version-bound resolution evidence for Quote V2 customer changes.
-- Historical legacy requests remain nullable; every newly resolved V2 request
-- must identify both its resolution kind and exact resulting version.
ALTER TABLE "quote_change_requests"
  ADD COLUMN "resolution_kind" text,
  ADD COLUMN "resulting_version_id" uuid;
--> statement-breakpoint

ALTER TABLE "quote_change_requests"
  ADD CONSTRAINT "quote_change_requests_resulting_version_fk"
    FOREIGN KEY ("resulting_version_id", "quote_id")
    REFERENCES "quote_versions"("id", "quote_id")
    ON DELETE RESTRICT
    NOT VALID;
--> statement-breakpoint

ALTER TABLE "quote_change_requests"
  ADD CONSTRAINT "quote_change_requests_resolution_kind_check"
    CHECK (
      "resolution_kind" IS NULL
      OR "resolution_kind" IN (
        'revision',
        'reopen_unchanged',
        'quote_voided',
        'quote_archived'
      )
    )
    NOT VALID;
--> statement-breakpoint

ALTER TABLE "quote_change_requests"
  ADD CONSTRAINT "quote_change_requests_v2_resolution_evidence_check"
    CHECK (
      "quote_version_id" IS NULL
      OR (
        "status" IN ('open', 'acknowledged')
        AND "resolution_kind" IS NULL
        AND "resulting_version_id" IS NULL
        AND "resolved_at" IS NULL
      )
      OR (
        "status" = 'resolved'
        AND "resolution_kind" IN ('revision', 'reopen_unchanged')
        AND "resulting_version_id" IS NOT NULL
        AND "resolved_at" IS NOT NULL
      )
      OR (
        "status" = 'dismissed'
        AND "resolution_kind" IN ('quote_voided', 'quote_archived')
        AND "resulting_version_id" IS NOT NULL
        AND "resolved_at" IS NOT NULL
      )
    )
    NOT VALID;
--> statement-breakpoint

CREATE INDEX "quote_change_requests_resulting_version_idx"
  ON "quote_change_requests" ("resulting_version_id");
--> statement-breakpoint

CREATE UNIQUE INDEX "quote_change_requests_actionable_quote_key"
  ON "quote_change_requests" ("quote_id")
  WHERE "quote_version_id" IS NOT NULL
    AND "status" IN ('open', 'acknowledged');
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "quote_v2_guard_change_request_transition"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."quote_version_id" IS NULL THEN
    RETURN NEW;
  END IF;

  IF ROW(NEW."quote_id", NEW."quote_version_id", NEW."owner_task_id", NEW."created_at")
    IS DISTINCT FROM
    ROW(OLD."quote_id", OLD."quote_version_id", OLD."owner_task_id", OLD."created_at") THEN
    RAISE EXCEPTION 'version-bound quote change request identity is immutable';
  END IF;

  IF OLD."status" IN ('resolved', 'dismissed') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal quote change request evidence is immutable';
  END IF;

  IF (OLD."status" = 'open' AND NEW."status" NOT IN ('open', 'acknowledged', 'resolved', 'dismissed'))
    OR (OLD."status" = 'acknowledged' AND NEW."status" NOT IN ('acknowledged', 'resolved', 'dismissed')) THEN
    RAISE EXCEPTION 'illegal quote change request transition: % -> %', OLD."status", NEW."status";
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "quote_change_requests_transition_guard"
  BEFORE UPDATE ON "quote_change_requests"
  FOR EACH ROW EXECUTE FUNCTION "quote_v2_guard_change_request_transition"();
