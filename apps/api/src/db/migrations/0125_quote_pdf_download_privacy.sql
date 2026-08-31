-- Quote download counts are useful engagement evidence, but raw forwarded IP
-- and user-agent values are neither necessary nor safe for this purpose.
-- Keep the legacy nullable columns during additive rollout, erase historical
-- values, and prevent every writer from repopulating them.
UPDATE "quote_pdf_downloads"
SET "user_agent" = NULL,
    "ip_address" = NULL
WHERE "user_agent" IS NOT NULL
   OR "ip_address" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "quote_pdf_downloads"
  ADD CONSTRAINT "quote_pdf_downloads_no_raw_client_data_check"
  CHECK ("user_agent" IS NULL AND "ip_address" IS NULL)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE "quote_pdf_downloads"
  VALIDATE CONSTRAINT "quote_pdf_downloads_no_raw_client_data_check";
