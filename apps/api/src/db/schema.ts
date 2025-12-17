import type { LineItem } from "@myst-os/pricing";

// existing tables...
import {
  pgTable,
  text,
  timestamp,
  uuid,
  boolean,
  numeric,
  varchar,
  pgEnum,
  index,
  uniqueIndex,
  jsonb,
  integer
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const leadStatusEnum = pgEnum("lead_status", ["new", "contacted", "quoted", "scheduled"]);
export const quoteStatusEnum = pgEnum("quote_status", [
  "pending",
  "sent",
  "accepted",
  "declined"
]);
export const appointmentStatusEnum = pgEnum("appointment_status", [
  "requested",
  "confirmed",
  "completed",
  "no_show",
  "canceled"
]);

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    email: text("email"),
    phone: varchar("phone", { length: 32 }),
    phoneE164: varchar("phone_e164", { length: 32 }),
    preferredContactMethod: text("preferred_contact_method").default("phone"),
    source: text("source"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date())
  },
  (table) => ({
    emailIdx: uniqueIndex("contacts_email_key").on(table.email),
    phoneIdx: uniqueIndex("contacts_phone_key").on(table.phone),
    phoneE164Idx: uniqueIndex("contacts_phone_e164_key").on(table.phoneE164)
  })
);

export const properties = pgTable(
  "properties",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    addressLine1: text("address_line1").notNull(),
    addressLine2: text("address_line2"),
    city: text("city").notNull(),
    state: varchar("state", { length: 2 }).notNull(),
    postalCode: varchar("postal_code", { length: 16 }).notNull(),
    lat: numeric("lat", { precision: 9, scale: 6 }),
    lng: numeric("lng", { precision: 9, scale: 6 }),
    gated: boolean("gated").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date())
  },
  (table) => ({
    contactIdx: index("properties_contact_idx").on(table.contactId),
    addressKey: uniqueIndex("properties_address_key").on(
      table.addressLine1,
      table.postalCode,
      table.state
    )
  })
);

export const crmPipelineStageEnum = pgEnum("crm_pipeline_stage", [
  "new",
  "contacted",
  "qualified",
  "quoted",
  "won",
  "lost"
]);

export const crmTaskStatusEnum = pgEnum("crm_task_status", ["open", "completed"]);

export const crmPipeline = pgTable("crm_pipeline", {
  contactId: uuid("contact_id")
    .notNull()
    .references(() => contacts.id, { onDelete: "cascade" })
    .primaryKey(),
  stage: crmPipelineStageEnum("stage").default("new").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date())
});

export const crmTasks = pgTable(
  "crm_tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    assignedTo: text("assigned_to"),
    status: crmTaskStatusEnum("status").default("open").notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date())
  },
  (table) => ({
    contactIdx: index("crm_tasks_contact_idx").on(table.contactId),
    dueIdx: index("crm_tasks_due_idx").on(table.dueAt)
  })
);

export const leads = pgTable(
  "leads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    servicesRequested: text("services_requested").array().notNull(),
    notes: text("notes"),
    surfaceArea: numeric("surface_area"),
    status: leadStatusEnum("status").default("new").notNull(),
    source: text("source"),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    utmTerm: text("utm_term"),
    utmContent: text("utm_content"),
    gclid: text("gclid"),
  fbclid: text("fbclid"),
  referrer: text("referrer"),
  formPayload: jsonb("form_payload").$type<Record<string, unknown>>(),
  instantQuoteId: uuid("instant_quote_id").references(() => instantQuotes.id, { onDelete: "set null" }),
  quoteEstimate: numeric("quote_estimate"),
  quoteId: text("quote_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
      .notNull()
      .$onUpdate(() => new Date())
  },
  (table) => ({
    contactIdx: index("leads_contact_idx").on(table.contactId),
    propertyIdx: index("leads_property_idx").on(table.propertyId),
    quoteIdx: uniqueIndex("leads_quote_idx").on(table.quoteId)
  })
);

export const outboxEvents = pgTable("outbox_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  type: text("type").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true })
});

export const calendarSyncState = pgTable("calendar_sync_state", {
  calendarId: text("calendar_id").primaryKey(),
  syncToken: text("sync_token"),
  channelId: text("channel_id"),
  resourceId: text("resource_id"),
  channelExpiresAt: timestamp("channel_expires_at", { withTimezone: true }),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  lastNotificationAt: timestamp("last_notification_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date())
});
export const appointments = pgTable(
  "appointments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id")
      .references(() => leads.id, { onDelete: "set null" }),
    type: text("type").default("estimate").notNull(),
    startAt: timestamp("start_at", { withTimezone: true }),
    durationMinutes: integer("duration_min").default(60).notNull(),
    status: appointmentStatusEnum("status").default("requested").notNull(),
    calendarEventId: text("calendar_event_id"),
    crew: text("crew"),
    owner: text("owner"),
    rescheduleToken: varchar("reschedule_token", { length: 64 }).notNull(),
    travelBufferMinutes: integer("travel_buffer_min").default(30).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date())
  },
  (table) => ({
    startIdx: index("appointments_start_idx").on(table.startAt),
    statusIdx: index("appointments_status_idx").on(table.status)
  })
);

export const appointmentNotes = pgTable(
  "appointment_notes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => appointments.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => ({
    appointmentIdx: index("appointment_notes_appointment_idx").on(table.appointmentId)
  })
);

export const appointmentAttachments = pgTable(
  "appointment_attachments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => appointments.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    url: text("url").notNull(),
    contentType: text("content_type"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => ({
    appointmentIdx: index("appointment_attachments_appointment_idx").on(table.appointmentId)
  })
);

export const quotes = pgTable(
  "quotes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    status: quoteStatusEnum("status").default("pending").notNull(),
    services: jsonb("services").$type<string[]>().notNull(),
    addOns: jsonb("add_ons").$type<string[] | null>(),
    surfaceArea: numeric("surface_area"),
    zoneId: text("zone_id").notNull(),
    travelFee: numeric("travel_fee").default("0").notNull(),
    discounts: numeric("discounts").default("0").notNull(),
    addOnsTotal: numeric("add_ons_total").default("0").notNull(),
    subtotal: numeric("subtotal").notNull(),
    total: numeric("total").notNull(),
    depositDue: numeric("deposit_due").notNull(),
    depositRate: numeric("deposit_rate").notNull(),
    balanceDue: numeric("balance_due").notNull(),
    lineItems: jsonb("line_items").$type<LineItem[]>().notNull(),
    availability: jsonb("availability").$type<Record<string, unknown> | null>(),
    marketing: jsonb("marketing").$type<Record<string, unknown> | null>(),
    notes: text("notes"),
    shareToken: text("share_token"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    decisionAt: timestamp("decision_at", { withTimezone: true }),
    decisionNotes: text("decision_notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date())
  },
  (table) => ({
    contactIdx: index("quotes_contact_idx").on(table.contactId),
    propertyIdx: index("quotes_property_idx").on(table.propertyId),
    shareTokenIdx: uniqueIndex("quotes_share_token_key").on(table.shareToken)
  })
);

export const quoteRelations = relations(quotes, ({ one }) => ({
  contact: one(contacts, {
    fields: [quotes.contactId],
    references: [contacts.id]
  }),
  property: one(properties, {
    fields: [quotes.propertyId],
    references: [properties.id]
  })
}));

// Instant quotes (junk removal)
export const instantQuotes = pgTable("instant_quotes", {
  id: uuid("id").defaultRandom().primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  source: text("source").default("public_site").notNull(),
  contactName: text("contact_name").notNull(),
  contactPhone: text("contact_phone").notNull(),
  timeframe: text("timeframe").notNull(),
  zip: text("zip").notNull(),
  jobTypes: text("job_types").array().notNull().default([]),
  perceivedSize: text("perceived_size").notNull(),
  notes: text("notes"),
  photoUrls: text("photo_urls").array().notNull().default([]),
  aiResult: jsonb("ai_result").notNull()
});

export type InstantQuote = typeof instantQuotes.$inferSelect;
export type InstantQuoteInsert = typeof instantQuotes.$inferInsert;

// SEO / Blog posts (public content)
export const blogPosts = pgTable(
  "blog_posts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    excerpt: text("excerpt"),
    contentMarkdown: text("content_markdown").notNull(),
    metaTitle: text("meta_title"),
    metaDescription: text("meta_description"),
    topicKey: text("topic_key"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date())
  },
  (table) => ({
    slugKey: uniqueIndex("blog_posts_slug_key").on(table.slug),
    publishedIdx: index("blog_posts_published_idx").on(table.publishedAt),
    topicKeyIdx: index("blog_posts_topic_key_idx").on(table.topicKey)
  })
);

export const seoAgentState = pgTable("seo_agent_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date())
});

export const contactRelations = relations(contacts, ({ many, one }) => ({
  properties: many(properties),
  leads: many(leads),
  quotes: many(quotes),
  appointments: many(appointments),
  tasks: many(crmTasks),
  pipeline: one(crmPipeline, {
    fields: [contacts.id],
    references: [crmPipeline.contactId]
  })
}));

export const propertyRelations = relations(properties, ({ one, many }) => ({
  contact: one(contacts, {
    fields: [properties.contactId],
    references: [contacts.id]
  }),
  leads: many(leads),
  quotes: many(quotes),
  appointments: many(appointments)
}));

export const leadRelations = relations(leads, ({ one, many }) => ({
  contact: one(contacts, {
    fields: [leads.contactId],
    references: [contacts.id]
  }),
  property: one(properties, {
    fields: [leads.propertyId],
    references: [properties.id]
  }),
  appointments: many(appointments)
}));

export const appointmentRelations = relations(appointments, ({ one, many }) => ({
  contact: one(contacts, {
    fields: [appointments.contactId],
    references: [contacts.id]
  }),
  property: one(properties, {
    fields: [appointments.propertyId],
    references: [properties.id]
  }),
  lead: one(leads, {
    fields: [appointments.leadId],
    references: [leads.id]
  }),
  notes: many(appointmentNotes)
}));

export const appointmentNoteRelations = relations(appointmentNotes, ({ one }) => ({
  appointment: one(appointments, {
    fields: [appointmentNotes.appointmentId],
    references: [appointments.id]
  })
}));

export const crmTaskRelations = relations(crmTasks, ({ one }) => ({
  contact: one(contacts, {
    fields: [crmTasks.contactId],
    references: [contacts.id]
  })
}));

export const appointmentTasks = pgTable(
  "appointment_tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => appointments.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    status: text("status").default("open").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date())
  },
  (table) => ({
    apptIdx: index("appointment_tasks_appt_idx").on(table.appointmentId),
    statusIdx: index("appointment_tasks_status_idx").on(table.status)
  })
);

export const crmPipelineRelations = relations(crmPipeline, ({ one }) => ({
  contact: one(contacts, {
    fields: [crmPipeline.contactId],
    references: [contacts.id]
  })
}));

// Plaid banking data
export const plaidItems = pgTable(
  "plaid_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    itemId: text("item_id").notNull().unique(),
    accessToken: text("access_token").notNull(),
    institutionId: text("institution_id"),
    institutionName: text("institution_name"),
    cursor: text("cursor"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date())
  },
  (table) => ({
    itemIdx: uniqueIndex("plaid_items_item_idx").on(table.itemId)
  })
);

export const plaidAccounts = pgTable(
  "plaid_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => plaidItems.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    name: text("name"),
    officialName: text("official_name"),
    mask: varchar("mask", { length: 10 }),
    type: text("type"),
    subtype: text("subtype"),
    isoCurrencyCode: varchar("iso_currency_code", { length: 8 }),
    available: numeric("available", { precision: 14, scale: 2 }),
    current: numeric("current", { precision: 14, scale: 2 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date())
  },
  (table) => ({
    accountIdx: uniqueIndex("plaid_accounts_account_idx").on(table.accountId),
    itemIdx: index("plaid_accounts_item_idx").on(table.itemId)
  })
);

export const plaidTransactions = pgTable(
  "plaid_transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => plaidAccounts.id, { onDelete: "cascade" }),
    transactionId: text("transaction_id").notNull(),
    name: text("name"),
    merchantName: text("merchant_name"),
    amount: integer("amount_cents").notNull(), // store in cents
    isoCurrencyCode: varchar("iso_currency_code", { length: 8 }),
    date: timestamp("date", { withTimezone: false }).notNull(),
    pending: boolean("pending").default(false).notNull(),
    category: text("category").array(),
    raw: jsonb("raw"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date())
  },
  (table) => ({
    txnIdx: uniqueIndex("plaid_transactions_txn_idx").on(table.transactionId),
    accountIdx: index("plaid_transactions_account_idx").on(table.accountId),
    dateIdx: index("plaid_transactions_date_idx").on(table.date)
  })
);

export const expenses = pgTable(
  "expenses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    amount: integer("amount_cents").notNull(),
    currency: varchar("currency", { length: 8 }).default("USD").notNull(),
    category: text("category"),
    vendor: text("vendor"),
    memo: text("memo"),
    method: text("method"),
    source: text("source").default("manual").notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }).defaultNow().notNull(),
    bankTransactionId: uuid("bank_transaction_id").references(() => plaidTransactions.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date())
  },
  (table) => ({
    txnIdx: index("expenses_bank_txn_idx").on(table.bankTransactionId),
    paidAtIdx: index("expenses_paid_at_idx").on(table.paidAt)
  })
);

export const plaidItemRelations = relations(plaidItems, ({ many }) => ({
  accounts: many(plaidAccounts)
}));

export const plaidAccountRelations = relations(plaidAccounts, ({ one, many }) => ({
  item: one(plaidItems, {
    fields: [plaidAccounts.itemId],
    references: [plaidItems.id]
  }),
  transactions: many(plaidTransactions)
}));

export const plaidTransactionRelations = relations(plaidTransactions, ({ one }) => ({
  account: one(plaidAccounts, {
    fields: [plaidTransactions.accountId],
    references: [plaidAccounts.id]
  })
}));

export const expenseRelations = relations(expenses, ({ one }) => ({
  bankTransaction: one(plaidTransactions, {
    fields: [expenses.bankTransactionId],
    references: [plaidTransactions.id]
  })
}));

// Payments (Stripe charge ingestion for reconciliation)
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    stripeChargeId: text("stripe_charge_id").notNull(),
    amount: integer("amount").notNull(), // cents
    currency: varchar("currency", { length: 10 }).notNull(),
    status: text("status").notNull(),
    method: text("method"),
    cardBrand: text("card_brand"),
    last4: varchar("last4", { length: 4 }),
    receiptUrl: text("receipt_url"),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    appointmentId: uuid("appointment_id").references(() => appointments.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    capturedAt: timestamp("captured_at", { withTimezone: true })
  },
  (table) => ({
    stripeIdx: uniqueIndex("payments_charge_idx").on(table.stripeChargeId),
    appointmentIdx: index("payments_appointment_idx").on(table.appointmentId)
  })
);




