CREATE TABLE "plaid_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "item_id" text NOT NULL,
  "access_token" text NOT NULL,
  "institution_id" text,
  "institution_name" text,
  "cursor" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "plaid_items_item_idx" ON "plaid_items" ("item_id");
--> statement-breakpoint

CREATE TABLE "plaid_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "item_id" uuid NOT NULL,
  "account_id" text NOT NULL,
  "name" text,
  "official_name" text,
  "mask" varchar(10),
  "type" text,
  "subtype" text,
  "iso_currency_code" varchar(8),
  "available" numeric(14, 2),
  "current" numeric(14, 2),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "plaid_accounts_account_idx" ON "plaid_accounts" ("account_id");
--> statement-breakpoint
CREATE INDEX "plaid_accounts_item_idx" ON "plaid_accounts" ("item_id");
--> statement-breakpoint
ALTER TABLE "plaid_accounts" ADD CONSTRAINT "plaid_accounts_item_id_plaid_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "plaid_items"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

CREATE TABLE "plaid_transactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "transaction_id" text NOT NULL,
  "name" text,
  "merchant_name" text,
  "amount_cents" integer NOT NULL,
  "iso_currency_code" varchar(8),
  "date" timestamp without time zone NOT NULL,
  "pending" boolean DEFAULT false NOT NULL,
  "category" text[],
  "raw" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "plaid_transactions_txn_idx" ON "plaid_transactions" ("transaction_id");
--> statement-breakpoint
CREATE INDEX "plaid_transactions_account_idx" ON "plaid_transactions" ("account_id");
--> statement-breakpoint
CREATE INDEX "plaid_transactions_date_idx" ON "plaid_transactions" ("date");
--> statement-breakpoint
ALTER TABLE "plaid_transactions" ADD CONSTRAINT "plaid_transactions_account_id_plaid_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "plaid_accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

CREATE TABLE "expenses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "amount_cents" integer NOT NULL,
  "currency" varchar(8) DEFAULT 'USD' NOT NULL,
  "category" text,
  "vendor" text,
  "memo" text,
  "method" text,
  "source" text DEFAULT 'manual' NOT NULL,
  "paid_at" timestamp with time zone DEFAULT now() NOT NULL,
  "bank_transaction_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "expenses_bank_txn_idx" ON "expenses" ("bank_transaction_id");
--> statement-breakpoint
CREATE INDEX "expenses_paid_at_idx" ON "expenses" ("paid_at");
--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_bank_transaction_id_plaid_transactions_id_fk" FOREIGN KEY ("bank_transaction_id") REFERENCES "plaid_transactions"("id") ON DELETE set null ON UPDATE no action;
