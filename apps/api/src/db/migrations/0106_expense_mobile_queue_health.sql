-- Metadata-only monitoring for receipt captures that have not yet been
-- acknowledged by the server. Receipt bytes and extracted fields never enter
-- this table.
CREATE TABLE "mobile_expense_queue_health" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_member_id" uuid NOT NULL,
  "client_device_id" uuid NOT NULL,
  "queued_count" integer DEFAULT 0 NOT NULL,
  "failed_count" integer DEFAULT 0 NOT NULL,
  "oldest_queued_at" timestamp with time zone,
  "client_reported_at" timestamp with time zone NOT NULL,
  "last_reported_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mobile_expense_queue_health_queued_count_check"
    CHECK ("queued_count" BETWEEN 0 AND 10000),
  CONSTRAINT "mobile_expense_queue_health_failed_count_check"
    CHECK ("failed_count" BETWEEN 0 AND "queued_count"),
  CONSTRAINT "mobile_expense_queue_health_queue_state_check"
    CHECK (
      ("queued_count" = 0 AND "failed_count" = 0 AND "oldest_queued_at" IS NULL)
      OR ("queued_count" > 0 AND "oldest_queued_at" IS NOT NULL)
    )
);

ALTER TABLE "mobile_expense_queue_health"
  ADD CONSTRAINT "mobile_expense_queue_health_team_member_id_team_members_id_fk"
  FOREIGN KEY ("team_member_id") REFERENCES "public"."team_members"("id")
  ON DELETE cascade ON UPDATE no action;

CREATE UNIQUE INDEX "mobile_expense_queue_health_member_device_key"
  ON "mobile_expense_queue_health" USING btree ("team_member_id", "client_device_id");

CREATE INDEX "mobile_expense_queue_health_stale_idx"
  ON "mobile_expense_queue_health" USING btree ("oldest_queued_at")
  WHERE "queued_count" > 0;

CREATE INDEX "mobile_expense_queue_health_last_reported_idx"
  ON "mobile_expense_queue_health" USING btree ("last_reported_at");
