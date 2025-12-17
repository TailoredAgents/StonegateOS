CREATE TABLE IF NOT EXISTS "blog_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"excerpt" text,
	"content_markdown" text NOT NULL,
	"meta_title" text,
	"meta_description" text,
	"topic_key" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "blog_posts_slug_key" ON "blog_posts" ("slug");
CREATE INDEX IF NOT EXISTS "blog_posts_published_idx" ON "blog_posts" ("published_at");
CREATE INDEX IF NOT EXISTS "blog_posts_topic_key_idx" ON "blog_posts" ("topic_key");

CREATE TABLE IF NOT EXISTS "seo_agent_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
