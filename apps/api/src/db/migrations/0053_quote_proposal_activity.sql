CREATE TABLE "quote_pdf_downloads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quote_id" uuid NOT NULL,
	"user_agent" text,
	"ip_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quote_change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quote_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "quote_pdf_downloads" ADD CONSTRAINT "quote_pdf_downloads_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quote_change_requests" ADD CONSTRAINT "quote_change_requests_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "quote_pdf_downloads_quote_idx" ON "quote_pdf_downloads" USING btree ("quote_id");
--> statement-breakpoint
CREATE INDEX "quote_pdf_downloads_created_idx" ON "quote_pdf_downloads" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "quote_change_requests_quote_idx" ON "quote_change_requests" USING btree ("quote_id");
--> statement-breakpoint
CREATE INDEX "quote_change_requests_created_idx" ON "quote_change_requests" USING btree ("created_at");
