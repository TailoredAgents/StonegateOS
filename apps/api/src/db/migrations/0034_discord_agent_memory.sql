CREATE TABLE "discord_agent_memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"discord_guild_id" text,
	"discord_channel_id" text NOT NULL,
	"scope" text NOT NULL DEFAULT 'channel',
	"memory_type" text NOT NULL DEFAULT 'note',
	"title" text NOT NULL,
	"content" text NOT NULL,
	"tags" text,
	"pinned" boolean NOT NULL DEFAULT false,
	"archived" boolean NOT NULL DEFAULT false,
	"created_by_discord_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "discord_agent_memory_channel_idx" ON "discord_agent_memory" USING btree ("discord_channel_id");
--> statement-breakpoint
CREATE INDEX "discord_agent_memory_archived_idx" ON "discord_agent_memory" USING btree ("archived");
--> statement-breakpoint
CREATE INDEX "discord_agent_memory_pinned_idx" ON "discord_agent_memory" USING btree ("pinned");
--> statement-breakpoint
CREATE INDEX "discord_agent_memory_updated_idx" ON "discord_agent_memory" USING btree ("updated_at");

