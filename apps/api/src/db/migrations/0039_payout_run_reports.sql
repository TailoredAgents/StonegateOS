ALTER TABLE "payout_runs"
ADD COLUMN "report_html" text,
ADD COLUMN "report_generated_at" timestamp with time zone;
