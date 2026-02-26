CREATE TABLE "discord_report_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"discord_guild_id" text,
	"discord_channel_id" text NOT NULL,
	"report_type" text NOT NULL,
	"timezone" text NOT NULL DEFAULT 'America/New_York',
	"time_of_day" text NOT NULL DEFAULT '08:30',
	"enabled" boolean NOT NULL DEFAULT true,
	"last_sent_at" timestamp with time zone,
	"created_by_discord_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "discord_report_subscriptions_unique_idx" ON "discord_report_subscriptions" USING btree ("discord_channel_id","report_type");--> statement-breakpoint
CREATE INDEX "discord_report_subscriptions_enabled_idx" ON "discord_report_subscriptions" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "discord_report_subscriptions_last_sent_idx" ON "discord_report_subscriptions" USING btree ("last_sent_at");

