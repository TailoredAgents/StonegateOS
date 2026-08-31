ALTER TABLE "quote_version_attachments"
  ADD COLUMN "purpose" text DEFAULT 'scope_evidence' NOT NULL;
--> statement-breakpoint

ALTER TABLE "quote_version_attachments"
  ADD CONSTRAINT "quote_version_attachments_purpose_check"
  CHECK ("purpose" IN ('scope_evidence', 'site_plan', 'specification', 'terms', 'other', 'internal'))
  NOT VALID;
--> statement-breakpoint

ALTER TABLE "quote_version_attachments"
  ADD CONSTRAINT "quote_version_attachments_visibility_check"
  CHECK ("purpose" <> 'internal' OR "customer_visible" = false)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE "quote_version_attachments"
  VALIDATE CONSTRAINT "quote_version_attachments_purpose_check";
--> statement-breakpoint

ALTER TABLE "quote_version_attachments"
  VALIDATE CONSTRAINT "quote_version_attachments_visibility_check";
