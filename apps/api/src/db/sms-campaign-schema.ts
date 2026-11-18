import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  boolean,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type {
  CampaignTerms,
  CampaignStatus,
  CampaignRecipientPreview,
} from "@myst-os/sdk";

// Foreign keys to the existing contact/message tables are migration-owned to avoid a schema import cycle.
export const smsMarketingConsents = pgTable(
  "sms_marketing_consents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contactId: uuid("contact_id").notNull(),
    phone: text("phone").notNull(),
    status: text("status").$type<"granted" | "revoked">().notNull(),
    source: text("source").notNull(),
    evidence: text("evidence").notNull(),
    evidenceReference: text("evidence_reference"),
    timeZone: text("time_zone").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    recordedBy: uuid("recorded_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    phoneIdx: index("sms_marketing_consents_phone_idx").on(
      t.phone,
      t.createdAt,
    ),
    statusCheck: check(
      "sms_marketing_consents_status_check",
      sql`${t.status} in ('granted','revoked')`,
    ),
  }),
);

export const smsCampaigns = pgTable(
  "sms_campaigns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    version: integer("version").default(1).notNull(),
    status: text("status").$type<CampaignStatus>().default("draft").notNull(),
    terms: jsonb("terms").$type<CampaignTerms>().notNull(),
    sender: text("sender"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    nextSendAt: timestamp("next_send_at", { withTimezone: true }),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    statusCheck: check(
      "sms_campaigns_status_check",
      sql`${t.status} in ('draft','active','paused','completed','cancelled')`,
    ),
  }),
);

export const smsCampaignReviews = pgTable("sms_campaign_reviews", {
  id: uuid("id").defaultRandom().primaryKey(),
  campaignId: uuid("campaign_id")
    .notNull()
    .references(() => smsCampaigns.id),
  version: integer("version").notNull(),
  recipients: jsonb("recipients").$type<CampaignRecipientPreview[]>().notNull(),
  sender: text("sender"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdBy: uuid("created_by").notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
});
export const smsCampaignBatches = pgTable(
  "sms_campaign_batches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => smsCampaigns.id),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => smsCampaignReviews.id),
    releasedBy: uuid("released_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    reviewKey: uniqueIndex("sms_campaign_batches_review_key").on(t.reviewId),
  }),
);
export const smsCampaignRecipients = pgTable(
  "sms_campaign_recipients",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => smsCampaigns.id),
    batchId: uuid("batch_id").references(() => smsCampaignBatches.id),
    contactId: uuid("contact_id").notNull(),
    phone: text("phone").notNull(),
    name: text("name").notNull(),
    consentId: uuid("consent_id").references(() => smsMarketingConsents.id),
    body: text("body").notNull(),
    messageId: uuid("message_id"),
    draftId: uuid("draft_id"),
    isTest: boolean("is_test").default(false).notNull(),
    suppressionReason: text("suppression_reason"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    repliedAt: timestamp("replied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    recipientKey: uniqueIndex("sms_campaign_recipients_destination_key")
      .on(t.campaignId, t.phone)
      .where(sql`${t.isTest} = false`),
    messageKey: uniqueIndex("sms_campaign_recipients_message_key").on(
      t.messageId,
    ),
    phoneIdx: index("sms_campaign_recipients_phone_idx").on(t.phone),
  }),
);
