-- Bind Partner Portal quotes to the canonical Quote V2 aggregate without
-- creating a second lifecycle authority. Existing partner_quotes rows remain
-- legacy, read-only snapshots until they are explicitly reconciled.

ALTER TABLE "quotes"
  ADD COLUMN "partner_account_id" uuid
    REFERENCES "partner_accounts"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "quotes_partner_account_engine_check"
    CHECK ("partner_account_id" IS NULL OR "engine_version" = 'v2');

CREATE UNIQUE INDEX "quotes_id_partner_account_key"
  ON "quotes" ("id", "partner_account_id");
CREATE INDEX "quotes_partner_account_state_idx"
  ON "quotes" ("partner_account_id", "aggregate_state", "updated_at", "id")
  WHERE "partner_account_id" IS NOT NULL;

CREATE OR REPLACE FUNCTION "quote_v2_guard_partner_account_binding"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW."partner_account_id" IS DISTINCT FROM OLD."partner_account_id" THEN
    RAISE EXCEPTION 'quote partner account binding is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "quotes_partner_account_binding_immutable"
BEFORE UPDATE ON "quotes"
FOR EACH ROW
EXECUTE FUNCTION "quote_v2_guard_partner_account_binding"();

ALTER TABLE "partner_quotes"
  ADD COLUMN "authority" text NOT NULL DEFAULT 'legacy_snapshot',
  ADD COLUMN "quote_id" uuid,
  ADD COLUMN "partner_account_location_id" uuid;

ALTER TABLE "partner_quotes"
  ALTER COLUMN "quote_number" DROP NOT NULL,
  ALTER COLUMN "version" DROP NOT NULL,
  ALTER COLUMN "status" DROP NOT NULL,
  ALTER COLUMN "currency" DROP NOT NULL,
  ALTER COLUMN "subtotal_cents" DROP NOT NULL,
  ALTER COLUMN "tax_cents" DROP NOT NULL,
  ALTER COLUMN "discount_cents" DROP NOT NULL,
  ALTER COLUMN "total_cents" DROP NOT NULL,
  ALTER COLUMN "lines" DROP NOT NULL;

ALTER TABLE "partner_quotes"
  DROP CONSTRAINT "partner_quotes_target_check",
  ADD CONSTRAINT "partner_quotes_authority_check"
    CHECK ("authority" IN ('legacy_snapshot', 'quote_v2')),
  ADD CONSTRAINT "partner_quotes_projection_shape_check"
    CHECK (
      (
        "authority" = 'legacy_snapshot'
        AND "quote_id" IS NULL
        AND "partner_account_location_id" IS NULL
        AND "quote_number" IS NOT NULL
        AND "version" IS NOT NULL
        AND "status" IS NOT NULL
        AND "currency" IS NOT NULL
        AND "subtotal_cents" IS NOT NULL
        AND "tax_cents" IS NOT NULL
        AND "discount_cents" IS NOT NULL
        AND "total_cents" IS NOT NULL
        AND "lines" IS NOT NULL
        AND num_nonnulls("partner_booking_id", "booking_draft_id") >= 1
      )
      OR
      (
        "authority" = 'quote_v2'
        AND "quote_id" IS NOT NULL
        AND num_nonnulls(
          "partner_booking_id",
          "booking_draft_id",
          "partner_account_location_id"
        ) = 1
        AND "quote_number" IS NULL
        AND "version" IS NULL
        AND "status" IS NULL
        AND "currency" IS NULL
        AND "subtotal_cents" IS NULL
        AND "tax_cents" IS NULL
        AND "discount_cents" IS NULL
        AND "total_cents" IS NULL
        AND "lines" IS NULL
        AND "terms" IS NULL
        AND "expires_at" IS NULL
        AND "sent_at" IS NULL
        AND "accepted_at" IS NULL
        AND "declined_at" IS NULL
        AND "superseded_at" IS NULL
        AND "document_id" IS NULL
      )
    ),
  ADD CONSTRAINT "partner_quotes_quote_account_fk"
    FOREIGN KEY ("quote_id", "partner_account_id")
    REFERENCES "quotes"("id", "partner_account_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "partner_quotes_booking_account_fk"
    FOREIGN KEY ("partner_account_id", "partner_booking_id")
    REFERENCES "partner_bookings"("partner_account_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "partner_quotes_draft_account_fk"
    FOREIGN KEY ("partner_account_id", "booking_draft_id")
    REFERENCES "partner_booking_drafts"("partner_account_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "partner_quotes_location_account_fk"
    FOREIGN KEY ("partner_account_id", "partner_account_location_id")
    REFERENCES "partner_account_locations"("partner_account_id", "id") ON DELETE RESTRICT;

CREATE UNIQUE INDEX "partner_quotes_quote_v2_binding_key"
  ON "partner_quotes" ("quote_id")
  WHERE "authority" = 'quote_v2';
CREATE INDEX "partner_quotes_account_authority_idx"
  ON "partner_quotes" ("partner_account_id", "authority", "created_at", "id");

CREATE OR REPLACE FUNCTION "partner_quote_guard_canonical_binding"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD."authority" = 'quote_v2' THEN
    RAISE EXCEPTION 'canonical partner quote bindings are immutable evidence'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    OLD."authority" IS DISTINCT FROM NEW."authority"
    OR OLD."quote_id" IS DISTINCT FROM NEW."quote_id"
    OR OLD."partner_account_id" IS DISTINCT FROM NEW."partner_account_id"
    OR OLD."partner_booking_id" IS DISTINCT FROM NEW."partner_booking_id"
    OR OLD."booking_draft_id" IS DISTINCT FROM NEW."booking_draft_id"
    OR OLD."partner_account_location_id" IS DISTINCT FROM NEW."partner_account_location_id"
    OR OLD."authority" = 'quote_v2'
  ) THEN
    RAISE EXCEPTION 'canonical partner quote bindings are immutable evidence'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "partner_quotes_canonical_binding_immutable"
BEFORE UPDATE OR DELETE ON "partner_quotes"
FOR EACH ROW
EXECUTE FUNCTION "partner_quote_guard_canonical_binding"();

ALTER TABLE "quote_responses"
  ADD COLUMN "partner_account_id" uuid
    REFERENCES "partner_accounts"("id") ON DELETE RESTRICT,
  ADD COLUMN "partner_membership_id" uuid,
  ADD COLUMN "partner_user_id" uuid
    REFERENCES "partner_users"("id") ON DELETE RESTRICT,
  ADD COLUMN "request_hash" varchar(64);

ALTER TABLE "quote_responses"
  DROP CONSTRAINT "quote_responses_source_check",
  DROP CONSTRAINT "quote_responses_actor_check",
  ADD CONSTRAINT "quote_responses_source_check"
    CHECK ("source" IN ('customer', 'team_member', 'partner_member', 'system')),
  ADD CONSTRAINT "quote_responses_partner_actor_fk"
    FOREIGN KEY (
      "partner_membership_id",
      "partner_account_id",
      "partner_user_id"
    ) REFERENCES "partner_account_memberships"(
      "id",
      "partner_account_id",
      "partner_user_id"
    ) ON DELETE RESTRICT,
  ADD CONSTRAINT "quote_responses_actor_check"
    CHECK (
      (
        "source" = 'team_member'
        AND "team_member_id" IS NOT NULL
        AND num_nonnulls(
          "partner_account_id",
          "partner_membership_id",
          "partner_user_id"
        ) = 0
      )
      OR
      (
        "source" = 'partner_member'
        AND "team_member_id" IS NULL
        AND "partner_account_id" IS NOT NULL
        AND "partner_membership_id" IS NOT NULL
        AND "partner_user_id" IS NOT NULL
        AND "idempotency_key_hash" IS NOT NULL
        AND "request_hash" IS NOT NULL
      )
      OR
      (
        "source" IN ('customer', 'system')
        AND "team_member_id" IS NULL
        AND num_nonnulls(
          "partner_account_id",
          "partner_membership_id",
          "partner_user_id"
        ) = 0
      )
    ),
  ADD CONSTRAINT "quote_responses_request_hash_check"
    CHECK ("request_hash" IS NULL OR "request_hash" ~ '^[0-9a-f]{64}$');

CREATE INDEX "quote_responses_partner_actor_idx"
  ON "quote_responses" (
    "partner_account_id",
    "partner_membership_id",
    "responded_at"
  )
  WHERE "source" = 'partner_member';

-- Quote access is separate from negotiated-rate visibility and internal
-- approval decisions. Only the two launch financial roles receive it.
UPDATE "partner_role_templates"
SET
  "capabilities" = ARRAY(
    SELECT DISTINCT capability
    FROM unnest(
      "capabilities" || ARRAY['quotes.read', 'quotes.respond']::text[]
    ) AS capability
    ORDER BY capability
  ),
  "version" = "version" + 1,
  "updated_at" = now()
WHERE "partner_account_id" IS NULL
  AND "key" IN ('administrator', 'billing_approver');

COMMENT ON COLUMN "quotes"."partner_account_id" IS
  'Immutable canonical tenant binding for Quote V2 records created for a Partner account.';
COMMENT ON COLUMN "partner_quotes"."authority" IS
  'legacy_snapshot is historical and non-actionable; quote_v2 binds an account target to the canonical Quote V2 aggregate.';
COMMENT ON COLUMN "quote_responses"."request_hash" IS
  'Canonical bounded decision-command hash used to verify immutable idempotent Partner replays.';
