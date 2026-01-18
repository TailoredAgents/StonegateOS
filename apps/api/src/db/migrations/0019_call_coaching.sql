DO $$ BEGIN
  CREATE TYPE "public"."call_coaching_rubric" AS ENUM('inbound','outbound');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE "call_coaching" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "call_record_id" uuid NOT NULL,
  "member_id" uuid,
  "rubric" "public"."call_coaching_rubric" NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "model" text,
  "score_overall" integer NOT NULL,
  "score_breakdown" jsonb,
  "wins" text[] DEFAULT '{}'::text[] NOT NULL,
  "improvements" text[] DEFAULT '{}'::text[] NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "call_coaching" ADD CONSTRAINT "call_coaching_call_record_id_call_records_id_fk" FOREIGN KEY ("call_record_id") REFERENCES "public"."call_records"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "call_coaching" ADD CONSTRAINT "call_coaching_member_id_team_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE UNIQUE INDEX "call_coaching_unique" ON "call_coaching" USING btree ("call_record_id","rubric","version");
CREATE INDEX "call_coaching_call_idx" ON "call_coaching" USING btree ("call_record_id");
CREATE INDEX "call_coaching_member_idx" ON "call_coaching" USING btree ("member_id");
CREATE INDEX "call_coaching_rubric_idx" ON "call_coaching" USING btree ("rubric");
