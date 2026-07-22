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
  integer,
  doublePrecision,
  customType,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const leadStatusEnum = pgEnum("lead_status", [
  "new",
  "contacted",
  "quoted",
  "scheduled",
]);
export const quoteStatusEnum = pgEnum("quote_status", [
  "pending",
  "sent",
  "accepted",
  "declined",
]);
export const appointmentStatusEnum = pgEnum("appointment_status", [
  "requested",
  "confirmed",
  "completed",
  "no_show",
  "canceled",
]);

export type AppointmentLeadSourceType =
  | "google"
  | "facebook"
  | "team_member"
  | "referral";
export type AppointmentPriceMode = "range" | "exact" | "both";
export type AppointmentServiceType =
  | "junk_removal"
  | "land_clearing"
  | "demolition"
  | "rental_dumpster";
export type AppointmentLoadSizeKind =
  | "quarter_to_half"
  | "half_to_three_quarters"
  | "three_quarters_to_full"
  | "custom";
export type AppointmentLandClearingAccessDifficulty =
  | "easy"
  | "moderate"
  | "hard";
export type AppointmentDemolitionType =
  | "shed"
  | "deck"
  | "fence"
  | "interior"
  | "concrete"
  | "other";
export type AppointmentDumpsterSizeKind = "10_yard" | "15_yard" | "20_yard";
export type AppointmentBookingDetails = {
  serviceType: AppointmentServiceType;
  source: {
    type: AppointmentLeadSourceType;
    teamMemberId?: string | null;
    referralName?: string | null;
  };
  pricing: {
    mode: AppointmentPriceMode;
    rangeMinCents?: number | null;
    rangeMaxCents?: number | null;
  };
  loadSize?: {
    kind: AppointmentLoadSizeKind;
    customLoads?: number | null;
  } | null;
  landClearing?: {
    areaScope: string;
    accessDifficulty: AppointmentLandClearingAccessDifficulty;
    haulAway: boolean;
  } | null;
  demolition?: {
    demoType: AppointmentDemolitionType;
    scopeSize: string;
    haulAway: boolean;
  } | null;
  rentalDumpster?: {
    dumpsterSize: AppointmentDumpsterSizeKind;
    pickupDate: string;
    placementLocation: string;
  } | null;
};
export const commissionRoleEnum = pgEnum("commission_role", [
  "sales",
  "marketing",
  "crew",
]);
export const payoutRunStatusEnum = pgEnum("payout_run_status", [
  "draft",
  "locked",
  "paid",
]);
export const auditActorTypeEnum = pgEnum("audit_actor_type", [
  "human",
  "ai",
  "system",
  "worker",
]);
export const conversationChannelEnum = pgEnum("conversation_channel", [
  "sms",
  "email",
  "dm",
  "call",
  "web",
]);
export const conversationThreadStatusEnum = pgEnum(
  "conversation_thread_status",
  ["open", "pending", "closed"],
);
export const conversationStateEnum = pgEnum("conversation_state", [
  "new",
  "qualifying",
  "photos_received",
  "estimated",
  "offered_times",
  "booked",
  "reminder",
  "completed",
  "review",
]);
export const conversationParticipantTypeEnum = pgEnum(
  "conversation_participant_type",
  ["contact", "team", "system"],
);
export const messageDirectionEnum = pgEnum("message_direction", [
  "inbound",
  "outbound",
  "internal",
]);
export const messageDeliveryStatusEnum = pgEnum("message_delivery_status", [
  "queued",
  "sent",
  "delivered",
  "failed",
]);
export const mergeSuggestionStatusEnum = pgEnum("merge_suggestion_status", [
  "pending",
  "approved",
  "declined",
]);
export const automationChannelEnum = pgEnum("automation_channel", [
  "sms",
  "email",
  "dm",
  "call",
  "web",
]);
export const automationModeEnum = pgEnum("automation_mode", [
  "draft",
  "assist",
  "auto",
]);

export const partnerAccountStatusEnum = pgEnum("partner_account_status", [
  "imported",
  "ready_for_first_touch",
  "attempting_contact",
  "conversation_active",
  "qualified_partner",
  "trial_partner",
  "active_partner",
  "portal_partner",
  "managed_partner",
  "dormant",
  "not_a_fit",
]);

export const partnerStatusEnum = pgEnum("partner_status", [
  "none",
  "prospect",
  "contacted",
  "partner",
  "inactive",
]);

export const partnerAccounts = pgTable(
  "partner_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    domain: text("domain"),
    website: text("website"),
    segment: text("segment"),
    subsegment: text("subsegment"),
    status: partnerAccountStatusEnum("status").default("imported").notNull(),
    source: text("source"),
    sourceCampaign: text("source_campaign"),
    sourceListName: text("source_list_name"),
    city: text("city"),
    state: varchar("state", { length: 32 }),
    ownerMemberId: uuid("owner_member_id"),
    portalFit: text("portal_fit"),
    fitScore: integer("fit_score"),
    lastTouchAt: timestamp("last_touch_at", { withTimezone: true }),
    nextTouchAt: timestamp("next_touch_at", { withTimezone: true }),
    lastDisposition: text("last_disposition"),
    notes: text("notes"),
    aiAccountBrief: jsonb("ai_account_brief").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    statusIdx: index("partner_accounts_status_idx").on(table.status),
    ownerIdx: index("partner_accounts_owner_idx").on(table.ownerMemberId),
    nextTouchIdx: index("partner_accounts_next_touch_idx").on(table.nextTouchAt),
    domainIdx: index("partner_accounts_domain_idx").on(table.domain),
    normalizedNameIdx: index("partner_accounts_normalized_name_idx").on(
      table.normalizedName,
    ),
  }),
);

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    company: text("company"),
    email: text("email"),
    phone: varchar("phone", { length: 32 }),
    phoneE164: varchar("phone_e164", { length: 32 }),
    salespersonMemberId: uuid("salesperson_member_id"),
    partnerAccountId: uuid("partner_account_id").references(() => partnerAccounts.id, {
      onDelete: "set null",
    }),
    partnerStatus: partnerStatusEnum("partner_status")
      .default("none")
      .notNull(),
    partnerType: text("partner_type"),
    partnerOwnerMemberId: uuid("partner_owner_member_id"),
    partnerSince: timestamp("partner_since", { withTimezone: true }),
    partnerLastTouchAt: timestamp("partner_last_touch_at", {
      withTimezone: true,
    }),
    partnerNextTouchAt: timestamp("partner_next_touch_at", {
      withTimezone: true,
    }),
    partnerReferralCount: integer("partner_referral_count")
      .default(0)
      .notNull(),
    partnerLastReferralAt: timestamp("partner_last_referral_at", {
      withTimezone: true,
    }),
    doNotContact: boolean("do_not_contact").default(false).notNull(),
    doNotContactAt: timestamp("do_not_contact_at", { withTimezone: true }),
    doNotContactBy: uuid("do_not_contact_by"),
    doNotContactReason: text("do_not_contact_reason"),
    preferredContactMethod: text("preferred_contact_method").default("phone"),
    source: text("source"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    emailIdx: uniqueIndex("contacts_email_key").on(table.email),
    phoneIdx: uniqueIndex("contacts_phone_key").on(table.phone),
    phoneE164Idx: uniqueIndex("contacts_phone_e164_key").on(table.phoneE164),
    partnerAccountIdx: index("contacts_partner_account_idx").on(
      table.partnerAccountId,
    ),
    partnerStatusIdx: index("contacts_partner_status_idx").on(
      table.partnerStatus,
    ),
    partnerOwnerIdx: index("contacts_partner_owner_idx").on(
      table.partnerOwnerMemberId,
    ),
    partnerNextTouchIdx: index("contacts_partner_next_touch_idx").on(
      table.partnerNextTouchAt,
    ),
  }),
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    contactIdx: index("properties_contact_idx").on(table.contactId),
    addressKey: uniqueIndex("properties_address_key").on(
      table.addressLine1,
      table.postalCode,
      table.state,
    ),
  }),
);

export const crmPipelineStageEnum = pgEnum("crm_pipeline_stage", [
  "new",
  "contacted",
  "in_person_quote",
  "qualified",
  "quoted",
  "won",
  "lost",
]);

export const crmTaskStatusEnum = pgEnum("crm_task_status", [
  "open",
  "completed",
]);

export const crmPipeline = pgTable("crm_pipeline", {
  contactId: uuid("contact_id")
    .notNull()
    .references(() => contacts.id, { onDelete: "cascade" })
    .primaryKey(),
  stage: crmPipelineStageEnum("stage").default("new").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export const crmTasks = pgTable(
  "crm_tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    partnerAccountId: uuid("partner_account_id").references(() => partnerAccounts.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    assignedTo: text("assigned_to"),
    status: crmTaskStatusEnum("status").default("open").notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    contactIdx: index("crm_tasks_contact_idx").on(table.contactId),
    partnerAccountIdx: index("crm_tasks_partner_account_idx").on(
      table.partnerAccountId,
    ),
    dueIdx: index("crm_tasks_due_idx").on(table.dueAt),
  }),
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
    instantQuoteId: uuid("instant_quote_id").references(
      () => instantQuotes.id,
      { onDelete: "set null" },
    ),
    quoteEstimate: numeric("quote_estimate"),
    quoteId: text("quote_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    contactIdx: index("leads_contact_idx").on(table.contactId),
    propertyIdx: index("leads_property_idx").on(table.propertyId),
    quoteIdx: uniqueIndex("leads_quote_idx").on(table.quoteId),
  }),
);

export const teamRoles = pgTable(
  "team_roles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    permissions: text("permissions").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    slugIdx: uniqueIndex("team_roles_slug_key").on(table.slug),
  }),
);

export const teamMembers = pgTable(
  "team_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    email: text("email"),
    roleId: uuid("role_id").references(() => teamRoles.id, {
      onDelete: "set null",
    }),
    permissionsGrant: text("permissions_grant").array().notNull().default([]),
    permissionsDeny: text("permissions_deny").array().notNull().default([]),
    active: boolean("active").default(true).notNull(),
    defaultCrewSplitBps: integer("default_crew_split_bps"),
    passwordHash: text("password_hash"),
    passwordSetAt: timestamp("password_set_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    emailIdx: index("team_members_email_idx").on(table.email),
    roleIdx: index("team_members_role_idx").on(table.roleId),
  }),
);

export const teamLoginTokens = pgTable(
  "team_login_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    teamMemberId: uuid("team_member_id")
      .notNull()
      .references(() => teamMembers.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    requestedIp: text("requested_ip"),
    userAgent: text("user_agent"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    tokenHashIdx: uniqueIndex("team_login_tokens_hash_key").on(table.tokenHash),
    memberIdx: index("team_login_tokens_member_idx").on(table.teamMemberId),
    expiresIdx: index("team_login_tokens_expires_idx").on(table.expiresAt),
  }),
);

export const teamSessions = pgTable(
  "team_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    teamMemberId: uuid("team_member_id")
      .notNull()
      .references(() => teamMembers.id, { onDelete: "cascade" }),
    sessionHash: text("session_hash").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    sessionHashIdx: uniqueIndex("team_sessions_hash_key").on(table.sessionHash),
    memberIdx: index("team_sessions_member_idx").on(table.teamMemberId),
    expiresIdx: index("team_sessions_expires_idx").on(table.expiresAt),
  }),
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorType: auditActorTypeEnum("actor_type").default("system").notNull(),
    actorId: uuid("actor_id").references(() => teamMembers.id, {
      onDelete: "set null",
    }),
    actorLabel: text("actor_label"),
    actorRole: text("actor_role"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    meta: jsonb("meta").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    actorIdx: index("audit_logs_actor_idx").on(table.actorId),
    entityIdx: index("audit_logs_entity_idx").on(
      table.entityType,
      table.entityId,
    ),
    createdIdx: index("audit_logs_created_idx").on(table.createdAt),
  }),
);

export const mergeSuggestions = pgTable(
  "merge_suggestions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceContactId: uuid("source_contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    targetContactId: uuid("target_contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    status: mergeSuggestionStatusEnum("status").default("pending").notNull(),
    reason: text("reason").notNull(),
    confidence: integer("confidence").default(0).notNull(),
    meta: jsonb("meta").$type<Record<string, unknown> | null>(),
    reviewedBy: uuid("reviewed_by").references(() => teamMembers.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    statusIdx: index("merge_suggestions_status_idx").on(table.status),
    sourceIdx: index("merge_suggestions_source_idx").on(table.sourceContactId),
    targetIdx: index("merge_suggestions_target_idx").on(table.targetContactId),
    pairIdx: uniqueIndex("merge_suggestions_pair_key").on(
      table.sourceContactId,
      table.targetContactId,
    ),
  }),
);

export const policySettings = pgTable("policy_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  updatedBy: uuid("updated_by").references(() => teamMembers.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export const automationSettings = pgTable("automation_settings", {
  channel: automationChannelEnum("channel").primaryKey(),
  mode: automationModeEnum("mode").default("draft").notNull(),
  updatedBy: uuid("updated_by").references(() => teamMembers.id, {
    onDelete: "set null",
  }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export const leadAutomationStates = pgTable(
  "lead_automation_state",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    channel: automationChannelEnum("channel").notNull(),
    paused: boolean("paused").default(false).notNull(),
    dnc: boolean("dnc").default(false).notNull(),
    humanTakeover: boolean("human_takeover").default(false).notNull(),
    followupState: text("followup_state"),
    followupStep: integer("followup_step").default(0).notNull(),
    nextFollowupAt: timestamp("next_followup_at", { withTimezone: true }),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    pausedBy: uuid("paused_by").references(() => teamMembers.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    leadIdx: index("lead_automation_lead_idx").on(table.leadId),
    leadChannelIdx: uniqueIndex("lead_automation_lead_channel_key").on(
      table.leadId,
      table.channel,
    ),
  }),
);

export const salesAgentMemories = pgTable(
  "sales_agent_memories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id").references(() => leads.id, {
      onDelete: "set null",
    }),
    summary: text("summary"),
    customerIntent: text("customer_intent"),
    jobType: text("job_type"),
    pricingContext: text("pricing_context"),
    objections: text("objections").array().notNull().default([]),
    channelPreference: text("channel_preference"),
    lastPromisedNextStep: text("last_promised_next_step"),
    lastHumanSummary: text("last_human_summary"),
    bookingReadiness: text("booking_readiness"),
    quoteConfidence: text("quote_confidence"),
    missingFields: text("missing_fields").array().notNull().default([]),
    factsJson: jsonb("facts_json").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    contactIdx: uniqueIndex("sales_agent_memories_contact_key").on(
      table.contactId,
    ),
    leadIdx: index("sales_agent_memories_lead_idx").on(table.leadId),
  }),
);

export const salesAgentNextActions = pgTable(
  "sales_agent_next_actions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id").references(() => leads.id, {
      onDelete: "set null",
    }),
    actionType: text("action_type").notNull(),
    channel: text("channel"),
    status: text("status").default("open").notNull(),
    priority: text("priority").default("normal").notNull(),
    confidence: text("confidence").default("medium").notNull(),
    summary: text("summary"),
    reason: text("reason"),
    facts: text("facts").array().notNull().default([]),
    dueAt: timestamp("due_at", { withTimezone: true }),
    source: text("source").default("rules_v1").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    contactIdx: uniqueIndex("sales_agent_next_actions_contact_key").on(
      table.contactId,
    ),
    leadIdx: index("sales_agent_next_actions_lead_idx").on(table.leadId),
    dueIdx: index("sales_agent_next_actions_due_idx").on(table.dueAt),
    statusIdx: index("sales_agent_next_actions_status_idx").on(table.status),
  }),
);

export const facebookSalesAutopilotSessions = pgTable(
  "facebook_sales_autopilot_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    leadId: uuid("lead_id").references(() => leads.id, {
      onDelete: "set null",
    }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => conversationThreads.id, { onDelete: "cascade" }),
    channel: text("channel").default("dm").notNull(),
    stage: text("stage").default("new_inquiry").notNull(),
    autonomyMode: text("autonomy_mode").default("shadow").notNull(),
    lastDecision: text("last_decision"),
    lastDecisionReason: text("last_decision_reason"),
    lastHumanReviewReason: text("last_human_review_reason"),
    lastEvaluatedMessageId: uuid("last_evaluated_message_id").references(
      () => conversationMessages.id,
      { onDelete: "set null" },
    ),
    lastMeaningfulInboundAt: timestamp("last_meaningful_inbound_at", {
      withTimezone: true,
    }),
    quoteLowCents: integer("quote_low_cents"),
    quoteHighCents: integer("quote_high_cents"),
    offeredSlotsJson: jsonb("offered_slots_json").$type<
      Array<{ label: string; startAt: string; endAt?: string | null }> | null
    >(),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    threadIdx: uniqueIndex("facebook_sales_autopilot_sessions_thread_key").on(
      table.threadId,
    ),
    contactIdx: index("facebook_sales_autopilot_sessions_contact_idx").on(
      table.contactId,
    ),
    stageIdx: index("facebook_sales_autopilot_sessions_stage_idx").on(
      table.stage,
    ),
  }),
);

export const facebookSalesAutopilotActions = pgTable(
  "facebook_sales_autopilot_actions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id").references(
      () => facebookSalesAutopilotSessions.id,
      { onDelete: "cascade" },
    ),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    leadId: uuid("lead_id").references(() => leads.id, {
      onDelete: "set null",
    }),
    threadId: uuid("thread_id").references(() => conversationThreads.id, {
      onDelete: "cascade",
    }),
    messageId: uuid("message_id").references(() => conversationMessages.id, {
      onDelete: "set null",
    }),
    proposedAction: text("proposed_action").notNull(),
    executedAction: text("executed_action"),
    autonomyMode: text("autonomy_mode").default("shadow").notNull(),
    stage: text("stage").default("new_inquiry").notNull(),
    confidence: text("confidence").default("medium").notNull(),
    decisionReason: text("decision_reason"),
    humanReviewReason: text("human_review_reason"),
    inputSnapshot: jsonb("input_snapshot").$type<Record<string, unknown> | null>(),
    resultJson: jsonb("result_json").$type<Record<string, unknown> | null>(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    sessionIdx: index("facebook_sales_autopilot_actions_session_idx").on(
      table.sessionId,
    ),
    threadIdx: index("facebook_sales_autopilot_actions_thread_idx").on(
      table.threadId,
    ),
    createdIdx: index("facebook_sales_autopilot_actions_created_idx").on(
      table.createdAt,
    ),
  }),
);

export const mediaJobAnalyses = pgTable(
  "media_job_analyses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id").references(() => leads.id, {
      onDelete: "set null",
    }),
    instantQuoteId: uuid("instant_quote_id").references(() => instantQuotes.id, {
      onDelete: "set null",
    }),
    sourceChannel: text("source_channel"),
    mediaCount: integer("media_count").notNull().default(0),
    videoCount: integer("video_count").notNull().default(0),
    visibleVolumeBucket: text("visible_volume_bucket"),
    visibleVolumeRange: text("visible_volume_range"),
    mergedVolumeBucket: text("merged_volume_bucket"),
    mergedVolumeRange: text("merged_volume_range"),
    visibleMattressCount: integer("visible_mattress_count").notNull().default(0),
    visiblePaintCanCount: integer("visible_paint_can_count").notNull().default(0),
    visibleTireCount: integer("visible_tire_count").notNull().default(0),
    sceneGroupsJson: jsonb("scene_groups_json").$type<Array<Record<string, unknown>> | null>(),
    statedScopeJson: jsonb("stated_scope_json").$type<Record<string, unknown> | null>(),
    riskFlags: text("risk_flags").array().notNull().default([]),
    missingViews: text("missing_views").array().notNull().default([]),
    confidence: text("confidence"),
    summary: text("summary"),
    rawModelOutputJson: jsonb("raw_model_output_json").$type<Record<string, unknown> | null>(),
    source: text("source").default("scaffold_v1").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    contactIdx: uniqueIndex("media_job_analyses_contact_key").on(table.contactId),
    leadIdx: index("media_job_analyses_lead_idx").on(table.leadId),
    instantQuoteIdx: index("media_job_analyses_instant_quote_idx").on(table.instantQuoteId),
  }),
);

export const conversationThreads = pgTable(
  "conversation_threads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    leadId: uuid("lead_id").references(() => leads.id, {
      onDelete: "set null",
    }),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    propertyId: uuid("property_id").references(() => properties.id, {
      onDelete: "set null",
    }),
    status: conversationThreadStatusEnum("status").default("open").notNull(),
    state: conversationStateEnum("state").default("new").notNull(),
    channel: conversationChannelEnum("channel").default("sms").notNull(),
    subject: text("subject"),
    lastMessagePreview: text("last_message_preview"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    assignedTo: uuid("assigned_to").references(() => teamMembers.id, {
      onDelete: "set null",
    }),
    attentionHandledAt: timestamp("attention_handled_at", {
      withTimezone: true,
    }),
    attentionHandledBy: uuid("attention_handled_by").references(() => teamMembers.id, {
      onDelete: "set null",
    }),
    closedReason: text("closed_reason"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by").references(() => teamMembers.id, {
      onDelete: "set null",
    }),
    stateUpdatedAt: timestamp("state_updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    leadIdx: index("conversation_threads_lead_idx").on(table.leadId),
    contactIdx: index("conversation_threads_contact_idx").on(table.contactId),
    statusIdx: index("conversation_threads_status_idx").on(table.status),
    stateIdx: index("conversation_threads_state_idx").on(table.state),
    lastMessageIdx: index("conversation_threads_last_message_idx").on(
      table.lastMessageAt,
    ),
  }),
);

export const conversationParticipants = pgTable(
  "conversation_participants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => conversationThreads.id, { onDelete: "cascade" }),
    participantType:
      conversationParticipantTypeEnum("participant_type").notNull(),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    teamMemberId: uuid("team_member_id").references(() => teamMembers.id, {
      onDelete: "set null",
    }),
    externalAddress: text("external_address"),
    displayName: text("display_name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    threadIdx: index("conversation_participants_thread_idx").on(table.threadId),
  }),
);

export const conversationMessages = pgTable(
  "conversation_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => conversationThreads.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id").references(
      () => conversationParticipants.id,
      {
        onDelete: "set null",
      },
    ),
    direction: messageDirectionEnum("direction").notNull(),
    channel: conversationChannelEnum("channel").notNull(),
    subject: text("subject"),
    body: text("body").notNull(),
    mediaUrls: text("media_urls").array().notNull().default([]),
    toAddress: text("to_address"),
    fromAddress: text("from_address"),
    deliveryStatus: messageDeliveryStatusEnum("delivery_status")
      .default("queued")
      .notNull(),
    provider: text("provider"),
    providerMessageId: text("provider_message_id"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    threadIdx: index("conversation_messages_thread_idx").on(table.threadId),
    statusIdx: index("conversation_messages_status_idx").on(
      table.deliveryStatus,
    ),
    sentIdx: index("conversation_messages_sent_idx").on(table.sentAt),
  }),
);

export const partnerUsers = pgTable(
  "partner_users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgContactId: uuid("org_contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    phone: text("phone"),
    phoneE164: text("phone_e164"),
    name: text("name").notNull(),
    active: boolean("active").default(true).notNull(),
    passwordHash: text("password_hash"),
    passwordSetAt: timestamp("password_set_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    emailIdx: uniqueIndex("partner_users_email_key").on(table.email),
    phoneE164Idx: uniqueIndex("partner_users_phone_e164_key").on(
      table.phoneE164,
    ),
    orgContactIdx: index("partner_users_org_contact_idx").on(
      table.orgContactId,
    ),
  }),
);

export const partnerLoginTokens = pgTable(
  "partner_login_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerUserId: uuid("partner_user_id")
      .notNull()
      .references(() => partnerUsers.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    requestedIp: text("requested_ip"),
    userAgent: text("user_agent"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    tokenHashIdx: uniqueIndex("partner_login_tokens_hash_key").on(
      table.tokenHash,
    ),
    userIdx: index("partner_login_tokens_user_idx").on(table.partnerUserId),
    expiresIdx: index("partner_login_tokens_expires_idx").on(table.expiresAt),
  }),
);

export const partnerSessions = pgTable(
  "partner_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerUserId: uuid("partner_user_id")
      .notNull()
      .references(() => partnerUsers.id, { onDelete: "cascade" }),
    sessionHash: text("session_hash").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    sessionHashIdx: uniqueIndex("partner_sessions_hash_key").on(
      table.sessionHash,
    ),
    userIdx: index("partner_sessions_user_idx").on(table.partnerUserId),
    expiresIdx: index("partner_sessions_expires_idx").on(table.expiresAt),
  }),
);

export const partnerRateCards = pgTable(
  "partner_rate_cards",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgContactId: uuid("org_contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    currency: text("currency").default("USD").notNull(),
    active: boolean("active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    orgIdx: uniqueIndex("partner_rate_cards_org_key").on(table.orgContactId),
  }),
);

export const partnerRateItems = pgTable(
  "partner_rate_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    rateCardId: uuid("rate_card_id")
      .notNull()
      .references(() => partnerRateCards.id, { onDelete: "cascade" }),
    serviceKey: text("service_key").notNull(),
    tierKey: text("tier_key").notNull(),
    label: text("label"),
    amountCents: integer("amount_cents").notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    cardIdx: index("partner_rate_items_card_idx").on(table.rateCardId),
    serviceIdx: index("partner_rate_items_service_idx").on(table.serviceKey),
  }),
);

export const inboxMediaUploads = pgTable(
  "inbox_media_uploads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    token: text("token").notNull(),
    filename: text("filename"),
    contentType: text("content_type").notNull(),
    bytes: bytea("bytes").notNull(),
    byteLength: integer("byte_length").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    expiresIdx: index("inbox_media_uploads_expires_idx").on(table.expiresAt),
  }),
);

export const messageDeliveryEvents = pgTable(
  "message_delivery_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => conversationMessages.id, { onDelete: "cascade" }),
    status: messageDeliveryStatusEnum("status").notNull(),
    detail: text("detail"),
    provider: text("provider"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    messageIdx: index("message_delivery_message_idx").on(table.messageId),
    statusIdx: index("message_delivery_status_idx").on(table.status),
    occurredIdx: index("message_delivery_occurred_idx").on(table.occurredAt),
  }),
);

export const outboxEvents = pgTable("outbox_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  type: text("type").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  attempts: integer("attempts").default(0).notNull(),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
});

export const providerHealth = pgTable("provider_health", {
  provider: text("provider").primaryKey(),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
  lastFailureDetail: text("last_failure_detail"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export const crewTrackingDevices = pgTable(
  "crew_tracking_devices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    teamMemberId: uuid("team_member_id").references(() => teamMembers.id, {
      onDelete: "set null",
    }),
    crewLabel: text("crew_label"),
    provider: text("provider").default("traccar").notNull(),
    providerDeviceId: text("provider_device_id").notNull(),
    displayName: text("display_name"),
    active: boolean("active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    providerDeviceIdx: uniqueIndex("crew_tracking_devices_provider_device_key").on(
      table.provider,
      table.providerDeviceId,
    ),
    memberIdx: index("crew_tracking_devices_member_idx").on(table.teamMemberId),
    activeIdx: index("crew_tracking_devices_active_idx").on(table.active),
  }),
);

export const crewLocationPings = pgTable(
  "crew_location_pings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    trackingDeviceId: uuid("tracking_device_id")
      .notNull()
      .references(() => crewTrackingDevices.id, { onDelete: "cascade" }),
    provider: text("provider").default("traccar").notNull(),
    providerPositionId: text("provider_position_id"),
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),
    accuracyMeters: doublePrecision("accuracy_meters"),
    speedKph: doublePrecision("speed_kph"),
    fixAt: timestamp("fix_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    freshness: text("freshness").default("fresh").notNull(),
    raw: jsonb("raw").$type<Record<string, unknown> | null>(),
  },
  (table) => ({
    deviceFixIdx: index("crew_location_pings_device_fix_idx").on(
      table.trackingDeviceId,
      table.fixAt,
    ),
    freshnessIdx: index("crew_location_pings_freshness_idx").on(table.freshness),
  }),
);

export const crewRouteStates = pgTable(
  "crew_route_states",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    teamMemberId: uuid("team_member_id").references(() => teamMembers.id, {
      onDelete: "set null",
    }),
    crewLabel: text("crew_label"),
    serviceDate: text("service_date").notNull(),
    currentAppointmentId: uuid("current_appointment_id").references(
      () => appointments.id,
      { onDelete: "set null" },
    ),
    nextAppointmentId: uuid("next_appointment_id").references(
      () => appointments.id,
      { onDelete: "set null" },
    ),
    status: text("status").default("unknown").notNull(),
    dumpStatus: text("dump_status").default("not_needed").notNull(),
    locationFreshness: text("location_freshness").default("missing").notNull(),
    lastLocationPingId: uuid("last_location_ping_id").references(
      () => crewLocationPings.id,
      { onDelete: "set null" },
    ),
    statusNote: text("status_note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    memberDateIdx: index("crew_route_states_member_date_idx").on(
      table.teamMemberId,
      table.serviceDate,
    ),
    crewDateIdx: index("crew_route_states_crew_date_idx").on(
      table.crewLabel,
      table.serviceDate,
    ),
    currentIdx: index("crew_route_states_current_idx").on(
      table.currentAppointmentId,
    ),
  }),
);

export const appointmentEtaEvents = pgTable(
  "appointment_eta_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => appointments.id, { onDelete: "cascade" }),
    teamMemberId: uuid("team_member_id").references(() => teamMembers.id, {
      onDelete: "set null",
    }),
    crewLabel: text("crew_label"),
    eventType: text("event_type").notNull(),
    source: text("source").default("crm").notNull(),
    note: text("note"),
    meta: jsonb("meta").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    apptCreatedIdx: index("appointment_eta_events_appt_created_idx").on(
      table.appointmentId,
      table.createdAt,
    ),
    typeIdx: index("appointment_eta_events_type_idx").on(table.eventType),
  }),
);

export const etaMessageDrafts = pgTable(
  "eta_message_drafts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => appointments.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    threadId: uuid("thread_id").references(() => conversationThreads.id, {
      onDelete: "set null",
    }),
    channel: text("channel").default("sms").notNull(),
    status: text("status").default("draft").notNull(),
    reason: text("reason").notNull(),
    body: text("body").notNull(),
    etaStartAt: timestamp("eta_start_at", { withTimezone: true }),
    etaEndAt: timestamp("eta_end_at", { withTimezone: true }),
    confidence: text("confidence").default("low").notNull(),
    locationFreshness: text("location_freshness").default("missing").notNull(),
    createdBy: uuid("created_by").references(() => teamMembers.id, {
      onDelete: "set null",
    }),
    sentBy: uuid("sent_by").references(() => teamMembers.id, {
      onDelete: "set null",
    }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    statusCreatedIdx: index("eta_message_drafts_status_created_idx").on(
      table.status,
      table.createdAt,
    ),
    apptIdx: index("eta_message_drafts_appt_idx").on(
      table.appointmentId,
      table.createdAt,
    ),
  }),
);

export const metaAdsInsightsDaily = pgTable(
  "meta_ads_insights_daily",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: text("account_id").notNull(),
    level: text("level").notNull(),
    entityId: text("entity_id").notNull(),
    dateStart: text("date_start").notNull(),
    dateStop: text("date_stop"),
    currency: varchar("currency", { length: 10 }),
    campaignId: text("campaign_id"),
    campaignName: text("campaign_name"),
    adsetId: text("adset_id"),
    adsetName: text("adset_name"),
    adId: text("ad_id"),
    adName: text("ad_name"),
    impressions: integer("impressions").notNull(),
    clicks: integer("clicks").notNull(),
    reach: integer("reach").notNull(),
    spend: numeric("spend", { precision: 12, scale: 2 }).notNull(),
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    uniqueIdx: uniqueIndex("meta_ads_insights_unique_idx").on(
      table.accountId,
      table.level,
      table.entityId,
      table.dateStart,
    ),
    dateIdx: index("meta_ads_insights_date_idx").on(table.dateStart),
    campaignIdx: index("meta_ads_insights_campaign_idx").on(table.campaignId),
    adsetIdx: index("meta_ads_insights_adset_idx").on(table.adsetId),
    adIdx: index("meta_ads_insights_ad_idx").on(table.adId),
  }),
);

export const googleAdsInsightsDaily = pgTable(
  "google_ads_insights_daily",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    customerId: text("customer_id").notNull(),
    dateStart: text("date_start").notNull(),
    campaignId: text("campaign_id").notNull(),
    campaignName: text("campaign_name"),
    impressions: integer("impressions").notNull(),
    clicks: integer("clicks").notNull(),
    cost: numeric("cost", { precision: 12, scale: 2 }).notNull(),
    conversions: numeric("conversions", { precision: 12, scale: 2 }).notNull(),
    conversionValue: numeric("conversion_value", {
      precision: 12,
      scale: 2,
    }).notNull(),
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    uniqueIdx: uniqueIndex("google_ads_insights_daily_unique_idx").on(
      table.customerId,
      table.dateStart,
      table.campaignId,
    ),
    dateIdx: index("google_ads_insights_daily_date_idx").on(table.dateStart),
    campaignIdx: index("google_ads_insights_daily_campaign_idx").on(
      table.campaignId,
    ),
  }),
);

export const googleAdsSearchTermsDaily = pgTable(
  "google_ads_search_terms_daily",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    customerId: text("customer_id").notNull(),
    dateStart: text("date_start").notNull(),
    campaignId: text("campaign_id").notNull(),
    adGroupId: text("ad_group_id").notNull(),
    searchTerm: text("search_term").notNull(),
    impressions: integer("impressions").notNull(),
    clicks: integer("clicks").notNull(),
    cost: numeric("cost", { precision: 12, scale: 2 }).notNull(),
    conversions: numeric("conversions", { precision: 12, scale: 2 }).notNull(),
    conversionValue: numeric("conversion_value", {
      precision: 12,
      scale: 2,
    }).notNull(),
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    uniqueIdx: uniqueIndex("google_ads_search_terms_daily_unique_idx").on(
      table.customerId,
      table.dateStart,
      table.campaignId,
      table.adGroupId,
      table.searchTerm,
    ),
    dateIdx: index("google_ads_search_terms_daily_date_idx").on(
      table.dateStart,
    ),
    campaignIdx: index("google_ads_search_terms_daily_campaign_idx").on(
      table.campaignId,
    ),
    adGroupIdx: index("google_ads_search_terms_daily_ad_group_idx").on(
      table.adGroupId,
    ),
  }),
);

export const googleAdsConversionActions = pgTable(
  "google_ads_conversion_actions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    customerId: text("customer_id").notNull(),
    resourceName: text("resource_name").notNull(),
    actionId: text("action_id").notNull(),
    name: text("name").notNull(),
    category: text("category"),
    type: text("type"),
    status: text("status"),
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    uniqueIdx: uniqueIndex("google_ads_conversion_actions_unique_idx").on(
      table.customerId,
      table.actionId,
    ),
    nameIdx: index("google_ads_conversion_actions_name_idx").on(table.name),
  }),
);

export const googleAdsCampaignConversionsDaily = pgTable(
  "google_ads_campaign_conversions_daily",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    customerId: text("customer_id").notNull(),
    dateStart: text("date_start").notNull(),
    campaignId: text("campaign_id").notNull(),
    conversionActionId: text("conversion_action_id").notNull(),
    conversionActionName: text("conversion_action_name"),
    conversions: numeric("conversions", { precision: 12, scale: 2 }).notNull(),
    conversionValue: numeric("conversion_value", {
      precision: 12,
      scale: 2,
    }).notNull(),
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    uniqueIdx: uniqueIndex(
      "google_ads_campaign_conversions_daily_unique_idx",
    ).on(
      table.customerId,
      table.dateStart,
      table.campaignId,
      table.conversionActionId,
    ),
    dateIdx: index("google_ads_campaign_conversions_daily_date_idx").on(
      table.dateStart,
    ),
    campaignIdx: index("google_ads_campaign_conversions_daily_campaign_idx").on(
      table.campaignId,
    ),
  }),
);

export const googleAdsAnalystReports = pgTable(
  "google_ads_analyst_reports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    rangeDays: integer("range_days").notNull(),
    since: text("since").notNull(),
    until: text("until").notNull(),
    callWeight: numeric("call_weight", { precision: 4, scale: 3 }).notNull(),
    bookingWeight: numeric("booking_weight", {
      precision: 4,
      scale: 3,
    }).notNull(),
    report: jsonb("report").$type<Record<string, unknown>>().notNull(),
    createdBy: uuid("created_by").references(() => teamMembers.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    createdAtIdx: index("google_ads_analyst_reports_created_at_idx").on(
      table.createdAt,
    ),
    rangeIdx: index("google_ads_analyst_reports_range_idx").on(
      table.since,
      table.until,
    ),
  }),
);

export const googleAdsAnalystRecommendations = pgTable(
  "google_ads_analyst_recommendations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    reportId: uuid("report_id")
      .notNull()
      .references(() => googleAdsAnalystReports.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    status: text("status").default("proposed").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    decidedBy: uuid("decided_by").references(() => teamMembers.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    reportIdx: index("google_ads_analyst_recs_report_idx").on(
      table.reportId,
      table.createdAt,
    ),
    statusIdx: index("google_ads_analyst_recs_status_idx").on(
      table.status,
      table.createdAt,
    ),
  }),
);

export const webEvents = pgTable(
  "web_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: text("session_id").notNull(),
    visitId: text("visit_id").notNull(),
    event: text("event").notNull(),
    path: text("path").notNull(),
    key: text("key"),
    referrerDomain: text("referrer_domain"),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    utmTerm: text("utm_term"),
    utmContent: text("utm_content"),
    device: text("device"),
    inAreaBucket: text("in_area_bucket"),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    createdAtIdx: index("web_events_created_at_idx").on(table.createdAt),
    eventIdx: index("web_events_event_idx").on(table.event),
    pathIdx: index("web_events_path_idx").on(table.path),
    sessionIdx: index("web_events_session_idx").on(table.sessionId),
  }),
);

export const webEventCountsDaily = pgTable(
  "web_event_counts_daily",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    dateStart: text("date_start").notNull(),
    event: text("event").notNull(),
    path: text("path").notNull(),
    key: text("key").notNull().default(""),
    device: text("device").notNull().default(""),
    inAreaBucket: text("in_area_bucket").notNull().default(""),
    utmSource: text("utm_source").notNull().default(""),
    utmMedium: text("utm_medium").notNull().default(""),
    utmCampaign: text("utm_campaign").notNull().default(""),
    utmTerm: text("utm_term").notNull().default(""),
    utmContent: text("utm_content").notNull().default(""),
    count: integer("count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    uniqueIdx: uniqueIndex("web_event_counts_daily_unique_idx").on(
      table.dateStart,
      table.event,
      table.path,
      table.key,
      table.device,
      table.inAreaBucket,
      table.utmSource,
      table.utmMedium,
      table.utmCampaign,
      table.utmTerm,
      table.utmContent,
    ),
    dateIdx: index("web_event_counts_daily_date_idx").on(table.dateStart),
    eventIdx: index("web_event_counts_daily_event_idx").on(table.event),
    pathIdx: index("web_event_counts_daily_path_idx").on(table.path),
  }),
);

export const webVitals = pgTable(
  "web_vitals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: text("session_id").notNull(),
    visitId: text("visit_id").notNull(),
    path: text("path").notNull(),
    metric: text("metric").notNull(),
    value: doublePrecision("value").notNull(),
    rating: text("rating"),
    device: text("device"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    createdAtIdx: index("web_vitals_created_at_idx").on(table.createdAt),
    pathMetricIdx: index("web_vitals_path_metric_idx").on(
      table.path,
      table.metric,
    ),
  }),
);

export const googleAdsAnalystRecommendationEvents = pgTable(
  "google_ads_analyst_recommendation_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    recommendationId: uuid("recommendation_id")
      .notNull()
      .references(() => googleAdsAnalystRecommendations.id, {
        onDelete: "cascade",
      }),
    reportId: uuid("report_id")
      .notNull()
      .references(() => googleAdsAnalystReports.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    note: text("note"),
    actorMemberId: uuid("actor_member_id").references(() => teamMembers.id, {
      onDelete: "set null",
    }),
    actorSource: text("actor_source").default("ui").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    reportIdx: index("google_ads_analyst_rec_events_report_idx").on(
      table.reportId,
      table.createdAt,
    ),
    recommendationIdx: index("google_ads_analyst_rec_events_rec_idx").on(
      table.recommendationId,
      table.createdAt,
    ),
    actorIdx: index("google_ads_analyst_rec_events_actor_idx").on(
      table.actorMemberId,
      table.createdAt,
    ),
  }),
);

export const calendarSyncState = pgTable("calendar_sync_state", {
  calendarId: text("calendar_id").primaryKey(),
  syncToken: text("sync_token"),
  channelId: text("channel_id"),
  resourceId: text("resource_id"),
  channelExpiresAt: timestamp("channel_expires_at", { withTimezone: true }),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  lastNotificationAt: timestamp("last_notification_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
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
    leadId: uuid("lead_id").references(() => leads.id, {
      onDelete: "set null",
    }),
    type: text("type").default("estimate").notNull(),
    startAt: timestamp("start_at", { withTimezone: true }),
    durationMinutes: integer("duration_min").default(60).notNull(),
    status: appointmentStatusEnum("status").default("requested").notNull(),
    quotedTotalCents: integer("quoted_total_cents"),
    finalTotalCents: integer("final_total_cents"),
    bookingDetails: jsonb(
      "booking_details",
    ).$type<AppointmentBookingDetails | null>(),
    cardTipCents: integer("card_tip_cents"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    calendarEventId: text("calendar_event_id"),
    crew: text("crew"),
    owner: text("owner"),
    soldByMemberId: uuid("sold_by_member_id").references(() => teamMembers.id, {
      onDelete: "set null",
    }),
    marketingMemberId: uuid("marketing_member_id").references(
      () => teamMembers.id,
      { onDelete: "set null" },
    ),
    rescheduleToken: varchar("reschedule_token", { length: 64 }).notNull(),
    travelBufferMinutes: integer("travel_buffer_min").default(30).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    startIdx: index("appointments_start_idx").on(table.startAt),
    statusIdx: index("appointments_status_idx").on(table.status),
  }),
);

export const appointmentHolds = pgTable(
  "appointment_holds",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    instantQuoteId: uuid("instant_quote_id").references(
      () => instantQuotes.id,
      { onDelete: "set null" },
    ),
    leadId: uuid("lead_id").references(() => leads.id, {
      onDelete: "set null",
    }),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    propertyId: uuid("property_id").references(() => properties.id, {
      onDelete: "set null",
    }),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    durationMinutes: integer("duration_min").default(60).notNull(),
    travelBufferMinutes: integer("travel_buffer_min").default(30).notNull(),
    status: text("status").default("active").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    startIdx: index("appointment_holds_start_idx").on(table.startAt),
    statusIdx: index("appointment_holds_status_idx").on(table.status),
    expiresIdx: index("appointment_holds_expires_idx").on(table.expiresAt),
    quoteIdx: index("appointment_holds_quote_idx").on(table.instantQuoteId),
  }),
);

export const appointmentNotes = pgTable(
  "appointment_notes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => appointments.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    appointmentIdx: index("appointment_notes_appointment_idx").on(
      table.appointmentId,
    ),
  }),
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    appointmentIdx: index("appointment_attachments_appointment_idx").on(
      table.appointmentId,
    ),
  }),
);

export const partnerBookings = pgTable(
  "partner_bookings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgContactId: uuid("org_contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    partnerUserId: uuid("partner_user_id").references(() => partnerUsers.id, {
      onDelete: "set null",
    }),
    propertyId: uuid("property_id").references(() => properties.id, {
      onDelete: "set null",
    }),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => appointments.id, { onDelete: "cascade" }),
    serviceKey: text("service_key"),
    tierKey: text("tier_key"),
    amountCents: integer("amount_cents"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    orgIdx: index("partner_bookings_org_idx").on(table.orgContactId),
    appointmentIdx: index("partner_bookings_appointment_idx").on(
      table.appointmentId,
    ),
  }),
);

export const callRecords = pgTable(
  "call_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    callSid: text("call_sid").notNull(),
    parentCallSid: text("parent_call_sid"),
    direction: text("direction").notNull(), // inbound | outbound
    mode: text("mode"), // inbound | sales_escalation | null
    from: text("from_number"),
    to: text("to_number"),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    assignedTo: uuid("assigned_to").references(() => teamMembers.id, {
      onDelete: "set null",
    }),
    callStatus: text("call_status"),
    callDurationSec: integer("call_duration_sec"),
    recordingSid: text("recording_sid"),
    recordingUrl: text("recording_url"),
    recordingDurationSec: integer("recording_duration_sec"),
    recordingCreatedAt: timestamp("recording_created_at", {
      withTimezone: true,
    }),
    transcript: text("transcript"),
    extracted: jsonb("extracted").$type<Record<string, unknown> | null>(),
    summary: text("summary"),
    coaching: text("coaching"),
    noteTaskId: uuid("note_task_id").references(() => crmTasks.id, {
      onDelete: "set null",
    }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    deleteAfter: timestamp("delete_after", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    callSidIdx: uniqueIndex("call_records_call_sid_key").on(table.callSid),
    contactIdx: index("call_records_contact_idx").on(table.contactId),
    assignedIdx: index("call_records_assigned_idx").on(table.assignedTo),
    deleteIdx: index("call_records_delete_idx").on(table.deleteAfter),
  }),
);

export const callCoachingRubricEnum = pgEnum("call_coaching_rubric", [
  "inbound",
  "outbound",
]);

export const callCoaching = pgTable(
  "call_coaching",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    callRecordId: uuid("call_record_id")
      .notNull()
      .references(() => callRecords.id, { onDelete: "cascade" }),
    memberId: uuid("member_id").references(() => teamMembers.id, {
      onDelete: "set null",
    }),
    rubric: callCoachingRubricEnum("rubric").notNull(),
    version: integer("version").default(1).notNull(),
    model: text("model"),
    scoreOverall: integer("score_overall").notNull(),
    scoreBreakdown: jsonb("score_breakdown").$type<Record<
      string,
      number
    > | null>(),
    wins: text("wins").array().notNull().default([]),
    improvements: text("improvements").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    uniqueIdx: uniqueIndex("call_coaching_unique").on(
      table.callRecordId,
      table.rubric,
      table.version,
    ),
    callIdx: index("call_coaching_call_idx").on(table.callRecordId),
    memberIdx: index("call_coaching_member_idx").on(table.memberId),
    rubricIdx: index("call_coaching_rubric_idx").on(table.rubric),
  }),
);

export const commissionSettings = pgTable("commission_settings", {
  key: text("key").primaryKey(),
  timezone: text("timezone").default("America/New_York").notNull(),
  payoutWeekday: integer("payout_weekday").default(5).notNull(),
  payoutHour: integer("payout_hour").default(12).notNull(),
  payoutMinute: integer("payout_minute").default(0).notNull(),
  salesRateBps: integer("sales_rate_bps").default(0).notNull(),
  marketingRateBps: integer("marketing_rate_bps").default(1700).notNull(),
  crewPoolRateBps: integer("crew_pool_rate_bps").default(2000).notNull(),
  marketingMemberId: uuid("marketing_member_id").references(
    () => teamMembers.id,
    { onDelete: "set null" },
  ),
  updatedBy: uuid("updated_by").references(() => teamMembers.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export const commissionCrewPoolOverrideDays = pgTable(
  "commission_crew_pool_override_days",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    localDate: text("local_date").notNull(),
    timezone: text("timezone").default("America/New_York").notNull(),
    crewPoolRateBps: integer("crew_pool_rate_bps").notNull(),
    note: text("note"),
    createdBy: uuid("created_by").references(() => teamMembers.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    localDateUniqueIdx: uniqueIndex(
      "commission_crew_pool_override_days_local_date_unique",
    ).on(table.localDate),
    localDateIdx: index("commission_crew_pool_override_days_local_date_idx").on(
      table.localDate,
    ),
  }),
);

export const appointmentCrewMembers = pgTable(
  "appointment_crew_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => appointments.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => teamMembers.id, { onDelete: "restrict" }),
    splitBps: integer("split_bps").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    apptIdx: index("appointment_crew_members_appt_idx").on(table.appointmentId),
    uniqueIdx: uniqueIndex("appointment_crew_members_unique").on(
      table.appointmentId,
      table.memberId,
    ),
  }),
);

export const appointmentCommissions = pgTable(
  "appointment_commissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => appointments.id, { onDelete: "cascade" }),
    memberId: uuid("member_id").references(() => teamMembers.id, {
      onDelete: "set null",
    }),
    role: commissionRoleEnum("role").notNull(),
    baseCents: integer("base_cents").notNull(),
    amountCents: integer("amount_cents").notNull(),
    meta: jsonb("meta").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    apptIdx: index("appointment_commissions_appt_idx").on(table.appointmentId),
    memberIdx: index("appointment_commissions_member_idx").on(table.memberId),
    uniqueIdx: uniqueIndex("appointment_commissions_unique").on(
      table.appointmentId,
      table.role,
      table.memberId,
    ),
  }),
);

export const payoutRuns = pgTable(
  "payout_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    timezone: text("timezone").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    scheduledPayoutAt: timestamp("scheduled_payout_at", {
      withTimezone: true,
    }).notNull(),
    status: payoutRunStatusEnum("status").default("draft").notNull(),
    createdBy: uuid("created_by").references(() => teamMembers.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    reportHtml: text("report_html"),
    reportGeneratedAt: timestamp("report_generated_at", {
      withTimezone: true,
    }),
  },
  (table) => ({
    periodIdx: index("payout_runs_period_idx").on(
      table.periodStart,
      table.periodEnd,
    ),
    statusIdx: index("payout_runs_status_idx").on(table.status),
  }),
);

export const payoutRunLines = pgTable(
  "payout_run_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    payoutRunId: uuid("payout_run_id")
      .notNull()
      .references(() => payoutRuns.id, { onDelete: "cascade" }),
    memberId: uuid("member_id").references(() => teamMembers.id, {
      onDelete: "set null",
    }),
    salesCents: integer("sales_cents").default(0).notNull(),
    marketingCents: integer("marketing_cents").default(0).notNull(),
    crewCents: integer("crew_cents").default(0).notNull(),
    adjustmentsCents: integer("adjustments_cents").default(0).notNull(),
    totalCents: integer("total_cents").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    runIdx: index("payout_run_lines_run_idx").on(table.payoutRunId),
    memberIdx: index("payout_run_lines_member_idx").on(table.memberId),
    uniqueIdx: uniqueIndex("payout_run_lines_unique").on(
      table.payoutRunId,
      table.memberId,
    ),
  }),
);

export const payoutRunAdjustments = pgTable(
  "payout_run_adjustments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    payoutRunId: uuid("payout_run_id")
      .notNull()
      .references(() => payoutRuns.id, { onDelete: "cascade" }),
    memberId: uuid("member_id").references(() => teamMembers.id, {
      onDelete: "set null",
    }),
    kind: text("kind").default("manual").notNull(),
    amountCents: integer("amount_cents").notNull(),
    note: text("note"),
    expenseId: uuid("expense_id").references(() => expenses.id, {
      onDelete: "set null",
    }),
    createdBy: uuid("created_by").references(() => teamMembers.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    runIdx: index("payout_run_adjustments_run_idx").on(table.payoutRunId),
    expenseIdx: index("payout_run_adjustments_expense_idx").on(table.expenseId),
  }),
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
    quoteNumber: text("quote_number"),
    jobDurationMinutes: integer("job_duration_minutes").default(120).notNull(),
    clientScope: text("client_scope"),
    revision: integer("revision").default(1).notNull(),
    shareToken: text("share_token"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    viewedAt: timestamp("viewed_at", { withTimezone: true }),
    lastViewedAt: timestamp("last_viewed_at", { withTimezone: true }),
    viewCount: integer("view_count").default(0).notNull(),
    decisionAt: timestamp("decision_at", { withTimezone: true }),
    decisionNotes: text("decision_notes"),
    refreshRequestedAt: timestamp("refresh_requested_at", { withTimezone: true }),
    acceptedAppointmentId: uuid("accepted_appointment_id").references(() => appointments.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    contactIdx: index("quotes_contact_idx").on(table.contactId),
    propertyIdx: index("quotes_property_idx").on(table.propertyId),
    quoteNumberIdx: index("quotes_quote_number_idx").on(table.quoteNumber),
    shareTokenIdx: uniqueIndex("quotes_share_token_key").on(table.shareToken),
    acceptedAppointmentIdx: index("quotes_accepted_appointment_idx").on(table.acceptedAppointmentId),
  }),
);

export const quotePdfDownloads = pgTable(
  "quote_pdf_downloads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    quoteId: uuid("quote_id")
      .notNull()
      .references(() => quotes.id, { onDelete: "cascade" }),
    userAgent: text("user_agent"),
    ipAddress: text("ip_address"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    quoteIdx: index("quote_pdf_downloads_quote_idx").on(table.quoteId),
    createdIdx: index("quote_pdf_downloads_created_idx").on(table.createdAt),
  }),
);

export const quoteChangeRequests = pgTable(
  "quote_change_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    quoteId: uuid("quote_id")
      .notNull()
      .references(() => quotes.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    message: text("message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    quoteIdx: index("quote_change_requests_quote_idx").on(table.quoteId),
    createdIdx: index("quote_change_requests_created_idx").on(table.createdAt),
  }),
);

export const quoteRelations = relations(quotes, ({ one, many }) => ({
  contact: one(contacts, {
    fields: [quotes.contactId],
    references: [contacts.id],
  }),
  property: one(properties, {
    fields: [quotes.propertyId],
    references: [properties.id],
  }),
  pdfDownloads: many(quotePdfDownloads),
  changeRequests: many(quoteChangeRequests),
}));

export const quotePdfDownloadRelations = relations(
  quotePdfDownloads,
  ({ one }) => ({
    quote: one(quotes, {
      fields: [quotePdfDownloads.quoteId],
      references: [quotes.id],
    }),
  }),
);

export const quoteChangeRequestRelations = relations(
  quoteChangeRequests,
  ({ one }) => ({
    quote: one(quotes, {
      fields: [quoteChangeRequests.quoteId],
      references: [quotes.id],
    }),
  }),
);

// Instant quotes (junk removal)
export const instantQuotes = pgTable("instant_quotes", {
  id: uuid("id").defaultRandom().primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  source: text("source").default("public_site").notNull(),
  contactName: text("contact_name").notNull(),
  contactPhone: text("contact_phone").notNull(),
  timeframe: text("timeframe").notNull(),
  zip: text("zip").notNull(),
  jobTypes: text("job_types").array().notNull().default([]),
  perceivedSize: text("perceived_size").notNull(),
  notes: text("notes"),
  photoUrls: text("photo_urls").array().notNull().default([]),
  aiResult: jsonb("ai_result").notNull(),
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    slugKey: uniqueIndex("blog_posts_slug_key").on(table.slug),
    publishedIdx: index("blog_posts_published_idx").on(table.publishedAt),
    topicKeyIdx: index("blog_posts_topic_key_idx").on(table.topicKey),
  }),
);

export const seoAgentState = pgTable("seo_agent_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export const partnerAccountRelations = relations(
  partnerAccounts,
  ({ many }) => ({
    contacts: many(contacts),
    tasks: many(crmTasks),
  }),
);

export const contactRelations = relations(contacts, ({ many, one }) => ({
  partnerAccount: one(partnerAccounts, {
    fields: [contacts.partnerAccountId],
    references: [partnerAccounts.id],
  }),
  properties: many(properties),
  leads: many(leads),
  quotes: many(quotes),
  appointments: many(appointments),
  tasks: many(crmTasks),
  salesAgentMemories: many(salesAgentMemories),
  mediaJobAnalyses: many(mediaJobAnalyses),
  salesAgentNextAction: one(salesAgentNextActions, {
    fields: [contacts.id],
    references: [salesAgentNextActions.contactId],
  }),
  pipeline: one(crmPipeline, {
    fields: [contacts.id],
    references: [crmPipeline.contactId],
  }),
}));

export const salesAgentMemoryRelations = relations(
  salesAgentMemories,
  ({ one }) => ({
    contact: one(contacts, {
      fields: [salesAgentMemories.contactId],
      references: [contacts.id],
    }),
    lead: one(leads, {
      fields: [salesAgentMemories.leadId],
      references: [leads.id],
    }),
  }),
);

export const salesAgentNextActionRelations = relations(
  salesAgentNextActions,
  ({ one }) => ({
    contact: one(contacts, {
      fields: [salesAgentNextActions.contactId],
      references: [contacts.id],
    }),
    lead: one(leads, {
      fields: [salesAgentNextActions.leadId],
      references: [leads.id],
    }),
  }),
);

export const mediaJobAnalysisRelations = relations(
  mediaJobAnalyses,
  ({ one }) => ({
    contact: one(contacts, {
      fields: [mediaJobAnalyses.contactId],
      references: [contacts.id],
    }),
    lead: one(leads, {
      fields: [mediaJobAnalyses.leadId],
      references: [leads.id],
    }),
    instantQuote: one(instantQuotes, {
      fields: [mediaJobAnalyses.instantQuoteId],
      references: [instantQuotes.id],
    }),
  }),
);

export const propertyRelations = relations(properties, ({ one, many }) => ({
  contact: one(contacts, {
    fields: [properties.contactId],
    references: [contacts.id],
  }),
  leads: many(leads),
  quotes: many(quotes),
  appointments: many(appointments),
}));

export const leadRelations = relations(leads, ({ one, many }) => ({
  contact: one(contacts, {
    fields: [leads.contactId],
    references: [contacts.id],
  }),
  property: one(properties, {
    fields: [leads.propertyId],
    references: [properties.id],
  }),
  mediaJobAnalyses: many(mediaJobAnalyses),
  appointments: many(appointments),
}));

export const appointmentRelations = relations(
  appointments,
  ({ one, many }) => ({
    contact: one(contacts, {
      fields: [appointments.contactId],
      references: [contacts.id],
    }),
    property: one(properties, {
      fields: [appointments.propertyId],
      references: [properties.id],
    }),
    lead: one(leads, {
      fields: [appointments.leadId],
      references: [leads.id],
    }),
    notes: many(appointmentNotes),
  }),
);

export const appointmentNoteRelations = relations(
  appointmentNotes,
  ({ one }) => ({
    appointment: one(appointments, {
      fields: [appointmentNotes.appointmentId],
      references: [appointments.id],
    }),
  }),
);

export const crmTaskRelations = relations(crmTasks, ({ one }) => ({
  contact: one(contacts, {
    fields: [crmTasks.contactId],
    references: [contacts.id],
  }),
  partnerAccount: one(partnerAccounts, {
    fields: [crmTasks.partnerAccountId],
    references: [partnerAccounts.id],
  }),
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    apptIdx: index("appointment_tasks_appt_idx").on(table.appointmentId),
    statusIdx: index("appointment_tasks_status_idx").on(table.status),
  }),
);

export const crmPipelineRelations = relations(crmPipeline, ({ one }) => ({
  contact: one(contacts, {
    fields: [crmPipeline.contactId],
    references: [contacts.id],
  }),
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    itemIdx: uniqueIndex("plaid_items_item_idx").on(table.itemId),
  }),
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    accountIdx: uniqueIndex("plaid_accounts_account_idx").on(table.accountId),
    itemIdx: index("plaid_accounts_item_idx").on(table.itemId),
  }),
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    txnIdx: uniqueIndex("plaid_transactions_txn_idx").on(table.transactionId),
    accountIdx: index("plaid_transactions_account_idx").on(table.accountId),
    dateIdx: index("plaid_transactions_date_idx").on(table.date),
  }),
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
    coverageStartAt: timestamp("coverage_start_at", { withTimezone: true }),
    coverageEndAt: timestamp("coverage_end_at", { withTimezone: true }),
    receiptFilename: text("receipt_filename"),
    receiptUrl: text("receipt_url"),
    receiptContentType: text("receipt_content_type"),
    bankTransactionId: uuid("bank_transaction_id").references(
      () => plaidTransactions.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    txnIdx: index("expenses_bank_txn_idx").on(table.bankTransactionId),
    paidAtIdx: index("expenses_paid_at_idx").on(table.paidAt),
  }),
);

export const plaidItemRelations = relations(plaidItems, ({ many }) => ({
  accounts: many(plaidAccounts),
}));

export const plaidAccountRelations = relations(
  plaidAccounts,
  ({ one, many }) => ({
    item: one(plaidItems, {
      fields: [plaidAccounts.itemId],
      references: [plaidItems.id],
    }),
    transactions: many(plaidTransactions),
  }),
);

export const plaidTransactionRelations = relations(
  plaidTransactions,
  ({ one }) => ({
    account: one(plaidAccounts, {
      fields: [plaidTransactions.accountId],
      references: [plaidAccounts.id],
    }),
  }),
);

export const expenseRelations = relations(expenses, ({ one }) => ({
  bankTransaction: one(plaidTransactions, {
    fields: [expenses.bankTransactionId],
    references: [plaidTransactions.id],
  }),
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
    appointmentId: uuid("appointment_id").references(() => appointments.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    capturedAt: timestamp("captured_at", { withTimezone: true }),
  },
  (table) => ({
    stripeIdx: uniqueIndex("payments_charge_idx").on(table.stripeChargeId),
    appointmentIdx: index("payments_appointment_idx").on(table.appointmentId),
  }),
);

// Discord agent: staged actions requiring explicit approval.
export const discordActionIntents = pgTable(
  "discord_action_intents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    status: text("status").default("pending").notNull(), // pending | approved | executed | canceled | expired | failed

    discordGuildId: text("discord_guild_id"),
    discordChannelId: text("discord_channel_id").notNull(),
    discordIntentMessageId: text("discord_intent_message_id").notNull(), // bot read-back message id
    requestedByDiscordUserId: text("requested_by_discord_user_id").notNull(),

    requestText: text("request_text"),
    agentReply: text("agent_reply"),
    actions: jsonb("actions").$type<Array<Record<string, unknown>> | null>(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),

    executedByDiscordUserId: text("executed_by_discord_user_id"),
    error: text("error"),
    result: jsonb("result").$type<Record<string, unknown> | null>(),

    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    msgIdx: uniqueIndex("discord_action_intents_message_idx").on(
      table.discordIntentMessageId,
    ),
    statusIdx: index("discord_action_intents_status_idx").on(table.status),
    createdAtIdx: index("discord_action_intents_created_at_idx").on(
      table.createdAt,
    ),
  }),
);

// Discord agent: scheduled report targets (channels/DMs) and their schedules.
export const discordReportSubscriptions = pgTable(
  "discord_report_subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    discordGuildId: text("discord_guild_id"),
    discordChannelId: text("discord_channel_id").notNull(),
    reportType: text("report_type").notNull(),
    timezone: text("timezone").default("America/New_York").notNull(),
    timeOfDay: text("time_of_day").default("08:30").notNull(), // HH:MM (24h)
    enabled: boolean("enabled").default(true).notNull(),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
    createdByDiscordUserId: text("created_by_discord_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    uniqueIdx: uniqueIndex("discord_report_subscriptions_unique_idx").on(
      table.discordChannelId,
      table.reportType,
    ),
    enabledIdx: index("discord_report_subscriptions_enabled_idx").on(
      table.enabled,
    ),
    lastSentIdx: index("discord_report_subscriptions_last_sent_idx").on(
      table.lastSentAt,
    ),
  }),
);

// Discord agent: persistent memory and project notes for better continuity.
export const discordAgentMemory = pgTable(
  "discord_agent_memory",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    discordGuildId: text("discord_guild_id"),
    discordChannelId: text("discord_channel_id").notNull(),
    scope: text("scope").default("channel").notNull(), // channel | guild
    memoryType: text("memory_type").default("note").notNull(), // note | preference | project | fact
    title: text("title").notNull(),
    content: text("content").notNull(),
    tags: text("tags"),
    pinned: boolean("pinned").default(false).notNull(),
    archived: boolean("archived").default(false).notNull(),
    createdByDiscordUserId: text("created_by_discord_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    channelIdx: index("discord_agent_memory_channel_idx").on(
      table.discordChannelId,
    ),
    archivedIdx: index("discord_agent_memory_archived_idx").on(table.archived),
    pinnedIdx: index("discord_agent_memory_pinned_idx").on(table.pinned),
    updatedIdx: index("discord_agent_memory_updated_idx").on(table.updatedAt),
  }),
);
