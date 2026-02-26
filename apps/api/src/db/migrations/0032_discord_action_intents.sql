CREATE TABLE "discord_action_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"discord_guild_id" text,
	"discord_channel_id" text NOT NULL,
	"discord_intent_message_id" text NOT NULL,
	"requested_by_discord_user_id" text NOT NULL,
	"request_text" text,
	"agent_reply" text,
	"actions" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"executed_by_discord_user_id" text,
	"error" text,
	"result" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "discord_action_intents_message_idx" ON "discord_action_intents" USING btree ("discord_intent_message_id");--> statement-breakpoint
CREATE INDEX "discord_action_intents_status_idx" ON "discord_action_intents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "discord_action_intents_created_at_idx" ON "discord_action_intents" USING btree ("created_at");
