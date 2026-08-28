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
  check,
  date,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

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
export const expenseLifecycleStatusEnum = pgEnum("expense_lifecycle_status", [
  "draft",
  "posted",
  "voided",
  "corrected",
]);
export const expenseReviewStatusEnum = pgEnum("expense_review_status", [
  "draft",
  "pending",
  "approved",
  "rejected",
]);
export const expensePayerTypeEnum = pgEnum("expense_payer_type", [
  "company",
  "personal",
]);
export const expenseReceiptCaptureStatusEnum = pgEnum(
  "expense_receipt_capture_status",
  [
    "pending_upload",
    "uploaded",
    "queued",
    "analyzing",
    "ready",
    "failed",
    "confirmed",
    "discarded",
  ],
);
export const expenseReimbursementStatusEnum = pgEnum(
  "expense_reimbursement_status",
  ["pending", "approved", "attached", "paid", "rejected"],
);
export const dailyAdPlatformEnum = pgEnum("daily_ad_platform", [
  "facebook",
  "google",
]);

export type AppointmentLeadSourceType =
  | "website"
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
export const externalMessageDispatchStateEnum = pgEnum(
  "external_message_dispatch_state",
  ["requested", "dispatched", "succeeded", "failed", "reconciliation_required"],
);
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
    nextTouchIdx: index("partner_accounts_next_touch_idx").on(
      table.nextTouchAt,
    ),
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
    partnerAccountId: uuid("partner_account_id").references(
      () => partnerAccounts.id,
      {
        onDelete: "set null",
      },
    ),
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
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    // The migration owns the FK because teamMembers is declared later in this
    // module; keeping the column here still makes every query type-safe.
    deletedBy: uuid("deleted_by"),
    purgeEligibleAt: timestamp("purge_eligible_at", { withTimezone: true }),
    // Merge provenance is deliberately snapshot-based. The migration owns
    // the recovery-ledger FK because that append-only table is declared after
    // contacts; mergedIntoContactId intentionally has no contact FK so the
    // recovery evidence cannot be rewritten or cascaded by later retention.
    mergedIntoContactId: uuid("merged_into_contact_snapshot_id"),
    mergeRecoveryLedgerId: uuid("merge_recovery_ledger_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
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
    activeUpdatedIdx: index("contacts_active_updated_idx")
      .on(table.updatedAt)
      .where(sql`${table.deletedAt} IS NULL`),
    purgeEligibilityIdx: index("contacts_purge_eligibility_idx")
      .on(table.purgeEligibleAt)
      .where(sql`${table.deletedAt} IS NOT NULL`),
    softDeleteStateCheck: check(
      "contacts_soft_delete_state_check",
      sql`(${table.deletedAt} IS NULL AND ${table.deletedBy} IS NULL AND ${table.purgeEligibleAt} IS NULL) OR (${table.deletedAt} IS NOT NULL AND ${table.purgeEligibleAt} IS NOT NULL AND ${table.purgeEligibleAt} >= ${table.deletedAt} + interval '30 days')`,
    ),
  }),
);

export const properties = pgTable(
  "properties",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Transitional compatibility owner. New code must use contactProperties;
    // this nullable column remains during the expand phase for older readers.
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    // Canonical physical-address identity. It is nullable so legacy writers
    // remain deployable while every write path migrates to the association API.
    addressKey: text("address_key"),
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
    addressKey: uniqueIndex("properties_physical_address_key")
      .on(table.addressKey)
      .where(sql`${table.addressKey} is not null`),
  }),
);

export const contactProperties = pgTable(
  "contact_properties",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    relationship: text("relationship").default("customer").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    contactPropertyKey: uniqueIndex(
      "contact_properties_contact_property_key",
    ).on(table.contactId, table.propertyId),
    contactIdx: index("contact_properties_contact_idx").on(table.contactId),
    propertyIdx: index("contact_properties_property_idx").on(table.propertyId),
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
  updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
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
    partnerAccountId: uuid("partner_account_id").references(
      () => partnerAccounts.id,
      {
        onDelete: "set null",
      },
    ),
    title: text("title").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    assignedTo: text("assigned_to"),
    status: crmTaskStatusEnum("status").default("open").notNull(),
    notes: text("notes"),
    outboundProjectionVersion: integer("outbound_projection_version"),
    outboundIsOutbound: boolean("outbound_is_outbound")
      .default(false)
      .notNull(),
    outboundCampaign: text("outbound_campaign"),
    outboundAttempt: integer("outbound_attempt"),
    outboundLastDisposition: text("outbound_last_disposition"),
    outboundCompany: text("outbound_company"),
    outboundNoteSnippet: text("outbound_note_snippet"),
    outboundStartedAt: timestamp("outbound_started_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
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
    intakeOperationKeyHash: varchar("intake_operation_key_hash", {
      length: 64,
    }),
    intakeRequestHash: varchar("intake_request_hash", { length: 64 }),
    intakeResponse: jsonb("intake_response").$type<Record<string, unknown>>(),
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
    intakeOperationKeyIdx: uniqueIndex("leads_intake_operation_key_hash_key")
      .on(table.intakeOperationKeyHash)
      .where(sql`${table.intakeOperationKeyHash} IS NOT NULL`),
    intakeOperationKeyHashCheck: check(
      "leads_intake_operation_key_hash_check",
      sql`${table.intakeOperationKeyHash} IS NULL OR ${table.intakeOperationKeyHash} ~ '^[0-9a-f]{64}$'`,
    ),
    intakeRequestHashCheck: check(
      "leads_intake_request_hash_check",
      sql`${table.intakeRequestHash} IS NULL OR ${table.intakeRequestHash} ~ '^[0-9a-f]{64}$'`,
    ),
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
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
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
    emailNormalized: text("email_normalized"),
    emailIdentityStatus: text("email_identity_status")
      .default("none")
      .notNull(),
    phoneE164: text("phone_e164"),
    roleId: uuid("role_id").references(() => teamRoles.id, {
      onDelete: "set null",
    }),
    permissionsGrant: text("permissions_grant").array().notNull().default([]),
    permissionsDeny: text("permissions_deny").array().notNull().default([]),
    active: boolean("active").default(true).notNull(),
    defaultCrewSplitBps: integer("default_crew_split_bps"),
    fixedCrewJobRateBps: integer("fixed_crew_job_rate_bps"),
    passwordHash: text("password_hash"),
    passwordSetAt: timestamp("password_set_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    emailIdx: index("team_members_email_idx").on(table.email),
    emailNormalizedIdx: uniqueIndex("team_members_email_normalized_key")
      .on(table.emailNormalized)
      .where(sql`${table.emailNormalized} IS NOT NULL`),
    phoneE164Idx: uniqueIndex("team_members_phone_e164_key")
      .on(table.phoneE164)
      .where(sql`${table.phoneE164} IS NOT NULL`),
    roleIdx: index("team_members_role_idx").on(table.roleId),
    phoneE164Check: check(
      "team_members_phone_e164_format",
      sql`${table.phoneE164} IS NULL OR ${table.phoneE164} ~ '^\\+[1-9][0-9]{9,14}$'`,
    ),
    emailCanonicalCheck: check(
      "team_members_email_canonical",
      sql`${table.email} IS NULL OR (${table.email} = lower(btrim(${table.email})) AND length(${table.email}) > 0)`,
    ),
    emailIdentityCheck: check(
      "team_members_email_identity_state",
      sql`(${table.emailIdentityStatus} = 'ready' AND ${table.email} IS NOT NULL AND ${table.emailNormalized} = ${table.email}) OR (${table.emailIdentityStatus} = 'needs_review' AND ${table.email} IS NOT NULL AND ${table.emailNormalized} IS NULL) OR (${table.emailIdentityStatus} = 'none' AND ${table.email} IS NULL AND ${table.emailNormalized} IS NULL)`,
    ),
  }),
);

export const teamInboxNewLeadAcknowledgements = pgTable(
  "team_inbox_new_lead_acknowledgements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    teamMemberId: uuid("team_member_id")
      .notNull()
      .references(() => teamMembers.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    acknowledgedAt: timestamp("acknowledged_at", {
      withTimezone: true,
    }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    memberContactKey: uniqueIndex(
      "team_inbox_new_lead_ack_member_contact_key",
    ).on(table.teamMemberId, table.contactId),
    memberExpiryIdx: index("team_inbox_new_lead_ack_member_expiry_idx").on(
      table.teamMemberId,
      table.expiresAt,
      table.contactId,
    ),
    expiryIdx: index("team_inbox_new_lead_ack_expiry_idx").on(table.expiresAt),
    expiryCheck: check(
      "team_inbox_new_lead_ack_expiry_check",
      sql`${table.expiresAt} = ${table.acknowledgedAt} + interval '24 hours'`,
    ),
    versionCheck: check(
      "team_inbox_new_lead_ack_version_check",
      sql`${table.version} > 0`,
    ),
  }),
);

export const teamPipelineFilterPresets = pgTable(
  "team_pipeline_filter_presets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    teamMemberId: uuid("team_member_id")
      .notNull()
      .references(() => teamMembers.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 60 }).notNull(),
    nameNormalized: varchar("name_normalized", { length: 60 }).notNull(),
    searchQuery: varchar("search_query", { length: 120 }).default("").notNull(),
    stage: crmPipelineStageEnum("stage"),
    excludeOutbound: boolean("exclude_outbound").default(true).notNull(),
    view: varchar("view", { length: 8 }).default("board").notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    memberNameKey: uniqueIndex(
      "team_pipeline_filter_presets_member_name_key",
    ).on(table.teamMemberId, table.nameNormalized),
    memberUpdatedIdx: index(
      "team_pipeline_filter_presets_member_updated_idx",
    ).on(table.teamMemberId, table.updatedAt, table.id),
    nameCheck: check(
      "team_pipeline_filter_presets_name_check",
      sql`char_length(btrim(${table.name})) BETWEEN 1 AND 60`,
    ),
    normalizedNameCheck: check(
      "team_pipeline_filter_presets_normalized_name_check",
      sql`char_length(btrim(${table.nameNormalized})) BETWEEN 1 AND 60 AND ${table.nameNormalized} = lower(${table.nameNormalized})`,
    ),
    searchCheck: check(
      "team_pipeline_filter_presets_search_check",
      sql`char_length(${table.searchQuery}) <= 120`,
    ),
    viewCheck: check(
      "team_pipeline_filter_presets_view_check",
      sql`${table.view} IN ('board', 'list')`,
    ),
    versionCheck: check(
      "team_pipeline_filter_presets_version_check",
      sql`${table.version} > 0`,
    ),
  }),
);

/**
 * Internal database latch for the effective Access-administrator invariant.
 *
 * Application code must not mutate this row. Migration 0076 owns its trigger-
 * protected lifecycle, including the explicit disposable-fixture reset on a
 * Team table TRUNCATE.
 */
export const teamAccessContinuityState = pgTable(
  "team_access_continuity_state",
  {
    singleton: boolean("singleton").default(true).primaryKey(),
    protectionEnabled: boolean("protection_enabled").default(false).notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    singletonCheck: check(
      "team_access_continuity_state_singleton",
      sql`${table.singleton} = true`,
    ),
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

export const teamAuthRateLimits = pgTable(
  "team_auth_rate_limits",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    bucket: text("bucket").notNull(),
    keyHash: text("key_hash").notNull(),
    count: integer("count").default(1).notNull(),
    windowStartedAt: timestamp("window_started_at", {
      withTimezone: true,
    }).notNull(),
    resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    bucketKeyIdx: uniqueIndex("team_auth_rate_limits_bucket_key").on(
      table.bucket,
      table.keyHash,
    ),
    resetIdx: index("team_auth_rate_limits_reset_idx").on(table.resetAt),
    countPositiveCheck: check(
      "team_auth_rate_limits_count_positive",
      sql`${table.count} > 0`,
    ),
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
    authMethod: text("auth_method")
      .$type<"team_session" | "break_glass">()
      .default("team_session")
      .notNull(),
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
    // Historical actor IDs must not be rewritten when a member is removed.
    // Migration 0071 drops the mutable FK and preserves the verified snapshot.
    actorId: uuid("actor_id"),
    actorLabel: text("actor_label"),
    actorRole: text("actor_role"),
    sessionId: uuid("session_id"),
    authMethod: text("auth_method"),
    correlationId: text("correlation_id"),
    requiredPermissions: text("required_permissions").array(),
    outcome: text("outcome").default("succeeded").notNull(),
    surface: text("surface"),
    providerOperationId: text("provider_operation_id"),
    idempotencyKeyHash: varchar("idempotency_key_hash", { length: 64 }),
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
    actionIdx: index("audit_logs_action_idx").on(table.action),
    outcomeIdx: index("audit_logs_outcome_idx").on(table.outcome),
    correlationIdx: index("audit_logs_correlation_idx").on(table.correlationId),
    entityIdx: index("audit_logs_entity_idx").on(
      table.entityType,
      table.entityId,
    ),
    createdIdx: index("audit_logs_created_idx").on(table.createdAt),
    cursorIdx: index("audit_logs_cursor_idx").on(table.createdAt, table.id),
    authMethodCheck: check(
      "audit_logs_auth_method_check",
      sql`${table.authMethod} IS NULL OR ${table.authMethod} IN ('team_session', 'break_glass', 'partner_session', 'service')`,
    ),
    outcomeCheck: check(
      "audit_logs_outcome_check",
      sql`${table.outcome} IN ('attempted', 'succeeded', 'denied', 'failed')`,
    ),
    idempotencyHashCheck: check(
      "audit_logs_idempotency_hash_check",
      sql`${table.idempotencyKeyHash} IS NULL OR ${table.idempotencyKeyHash} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);

export type TeamMutationIdempotencyStatus =
  | "in_progress"
  | "succeeded"
  | "failed";

export const teamMutationIdempotency = pgTable(
  "team_mutation_idempotency",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    principalHash: varchar("principal_hash", { length: 64 }).notNull(),
    action: text("action").notNull(),
    keyHash: varchar("key_hash", { length: 64 }).notNull(),
    scopeHash: varchar("scope_hash", { length: 64 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    status: text("status")
      .$type<TeamMutationIdempotencyStatus>()
      .default("in_progress")
      .notNull(),
    operationId: uuid("operation_id").notNull(),
    correlationId: varchar("correlation_id", { length: 128 }).notNull(),
    attemptCount: integer("attempt_count").default(1).notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    claimExpiresAt: timestamp("claim_expires_at", {
      withTimezone: true,
    }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body").$type<Record<
      string,
      unknown
    > | null>(),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    principalActionKey: uniqueIndex(
      "team_mutation_idempotency_principal_action_key",
    ).on(table.principalHash, table.action, table.keyHash),
    expiresIdx: index("team_mutation_idempotency_expires_idx").on(
      table.expiresAt,
    ),
    activeClaimIdx: index("team_mutation_idempotency_active_claim_idx")
      .on(table.claimExpiresAt)
      .where(sql`${table.status} = 'in_progress'`),
    statusCheck: check(
      "team_mutation_idempotency_status_check",
      sql`${table.status} IN ('in_progress', 'succeeded', 'failed')`,
    ),
    principalHashCheck: check(
      "team_mutation_idempotency_principal_hash_check",
      sql`${table.principalHash} ~ '^[0-9a-f]{64}$'`,
    ),
    keyHashCheck: check(
      "team_mutation_idempotency_key_hash_check",
      sql`${table.keyHash} ~ '^[0-9a-f]{64}$'`,
    ),
    scopeHashCheck: check(
      "team_mutation_idempotency_scope_hash_check",
      sql`${table.scopeHash} ~ '^[0-9a-f]{64}$'`,
    ),
    requestHashCheck: check(
      "team_mutation_idempotency_request_hash_check",
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    attemptCountCheck: check(
      "team_mutation_idempotency_attempt_count_check",
      sql`${table.attemptCount} BETWEEN 1 AND 3`,
    ),
    responseStatusCheck: check(
      "team_mutation_idempotency_response_status_check",
      sql`${table.responseStatus} IS NULL OR ${table.responseStatus} BETWEEN 100 AND 599`,
    ),
    terminalCheck: check(
      "team_mutation_idempotency_terminal_check",
      sql`(${table.status} = 'in_progress' AND ${table.completedAt} IS NULL AND ${table.responseStatus} IS NULL AND ${table.responseBody} IS NULL) OR (${table.status} IN ('succeeded', 'failed') AND ${table.completedAt} IS NOT NULL AND ${table.responseStatus} IS NOT NULL AND ${table.responseBody} IS NOT NULL)`,
    ),
    expiryCheck: check(
      "team_mutation_idempotency_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
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
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
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

export type ContactMergeRecoveryStatus = "completed";
export type ContactMergeRecoveryChangeKind =
  | "baseline"
  | "created"
  | "moved"
  | "deduplicated"
  | "updated"
  | "soft_deleted"
  | "retained_historical"
  | "superseded";

/**
 * Append-only recovery evidence for a destructive contact merge.
 *
 * Source, target, suggestion, actor, and session identifiers are immutable
 * snapshots rather than cascading foreign keys. A later contact purge must
 * not be able to remove or silently rewrite the evidence needed for a dry-run
 * recovery assessment.
 */
export const contactMergeRecoveryLedgers = pgTable(
  "contact_merge_recovery_ledgers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceContactId: uuid("source_contact_snapshot_id").notNull(),
    targetContactId: uuid("target_contact_snapshot_id").notNull(),
    suggestionId: uuid("suggestion_snapshot_id"),
    previewHash: varchar("preview_hash", { length: 64 }).notNull(),
    ruleVersion: text("rule_version").notNull(),
    sourceVersion: timestamp("source_version", {
      withTimezone: true,
    }).notNull(),
    targetVersion: timestamp("target_version", {
      withTimezone: true,
    }).notNull(),
    actorMemberId: uuid("actor_member_snapshot_id").notNull(),
    actorRole: text("actor_role_snapshot"),
    actorLabel: text("actor_label_snapshot"),
    sessionId: uuid("session_snapshot_id").notNull(),
    authMethod: text("auth_method_snapshot").notNull(),
    operationId: uuid("operation_id").notNull(),
    correlationId: varchar("correlation_id", { length: 128 }).notNull(),
    idempotencyKeyHash: varchar("idempotency_key_hash", {
      length: 64,
    }).notNull(),
    status: text("status")
      .$type<ContactMergeRecoveryStatus>()
      .default("completed")
      .notNull(),
    contactBefore: jsonb("contact_before")
      .$type<Record<string, unknown>>()
      .notNull(),
    consolidationPlan: jsonb("consolidation_plan")
      .$type<Record<string, unknown>>()
      .notNull(),
    dependencySummary: jsonb("dependency_summary")
      .$type<Record<string, unknown>>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    operationKey: uniqueIndex("contact_merge_recovery_operation_key").on(
      table.operationId,
    ),
    sourceCreatedIdx: index("contact_merge_recovery_source_created_idx").on(
      table.sourceContactId,
      table.createdAt,
      table.id,
    ),
    targetCreatedIdx: index("contact_merge_recovery_target_created_idx").on(
      table.targetContactId,
      table.createdAt,
      table.id,
    ),
    suggestionIdx: index("contact_merge_recovery_suggestion_idx").on(
      table.suggestionId,
    ),
    previewHashCheck: check(
      "contact_merge_recovery_preview_hash_check",
      sql`${table.previewHash} ~ '^[0-9a-f]{64}$'`,
    ),
    idempotencyHashCheck: check(
      "contact_merge_recovery_idempotency_hash_check",
      sql`${table.idempotencyKeyHash} ~ '^[0-9a-f]{64}$'`,
    ),
    statusCheck: check(
      "contact_merge_recovery_status_check",
      sql`${table.status} = 'completed'`,
    ),
    ruleVersionCheck: check(
      "contact_merge_recovery_rule_version_check",
      sql`${table.ruleVersion} = 'contact-merge-v3'`,
    ),
    authMethodCheck: check(
      "contact_merge_recovery_auth_method_check",
      sql`${table.authMethod} IN ('team_session', 'break_glass')`,
    ),
    differentContactsCheck: check(
      "contact_merge_recovery_distinct_contacts_check",
      sql`${table.sourceContactId} <> ${table.targetContactId}`,
    ),
  }),
);

export const contactMergeRecoveryEntries = pgTable(
  "contact_merge_recovery_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ledgerId: uuid("ledger_id")
      .notNull()
      .references(() => contactMergeRecoveryLedgers.id, {
        onDelete: "restrict",
      }),
    ordinal: integer("ordinal").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_snapshot_id").notNull(),
    changeKind: text("change_kind")
      .$type<ContactMergeRecoveryChangeKind>()
      .notNull(),
    before: jsonb("before_state").$type<Record<string, unknown>>().notNull(),
    after: jsonb("after_state").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    ledgerOrdinalKey: uniqueIndex(
      "contact_merge_recovery_entry_ledger_ordinal_key",
    ).on(table.ledgerId, table.ordinal),
    ledgerEntityIdx: index("contact_merge_recovery_entry_ledger_entity_idx").on(
      table.ledgerId,
      table.entityType,
      table.entityId,
    ),
    ordinalCheck: check(
      "contact_merge_recovery_entry_ordinal_check",
      sql`${table.ordinal} >= 0`,
    ),
    changeKindCheck: check(
      "contact_merge_recovery_entry_change_kind_check",
      sql`${table.changeKind} IN ('baseline', 'created', 'moved', 'deduplicated', 'updated', 'soft_deleted', 'retained_historical', 'superseded')`,
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
    offeredSlotsJson: jsonb("offered_slots_json").$type<Array<{
      label: string;
      startAt: string;
      endAt?: string | null;
    }> | null>(),
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
    inputSnapshot: jsonb("input_snapshot").$type<Record<
      string,
      unknown
    > | null>(),
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
    instantQuoteId: uuid("instant_quote_id").references(
      () => instantQuotes.id,
      {
        onDelete: "set null",
      },
    ),
    sourceChannel: text("source_channel"),
    mediaCount: integer("media_count").notNull().default(0),
    videoCount: integer("video_count").notNull().default(0),
    visibleVolumeBucket: text("visible_volume_bucket"),
    visibleVolumeRange: text("visible_volume_range"),
    mergedVolumeBucket: text("merged_volume_bucket"),
    mergedVolumeRange: text("merged_volume_range"),
    visibleMattressCount: integer("visible_mattress_count")
      .notNull()
      .default(0),
    visiblePaintCanCount: integer("visible_paint_can_count")
      .notNull()
      .default(0),
    visibleTireCount: integer("visible_tire_count").notNull().default(0),
    sceneGroupsJson: jsonb("scene_groups_json").$type<Array<
      Record<string, unknown>
    > | null>(),
    statedScopeJson: jsonb("stated_scope_json").$type<Record<
      string,
      unknown
    > | null>(),
    riskFlags: text("risk_flags").array().notNull().default([]),
    missingViews: text("missing_views").array().notNull().default([]),
    confidence: text("confidence"),
    summary: text("summary"),
    rawModelOutputJson: jsonb("raw_model_output_json").$type<Record<
      string,
      unknown
    > | null>(),
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
    contactIdx: uniqueIndex("media_job_analyses_contact_key").on(
      table.contactId,
    ),
    leadIdx: index("media_job_analyses_lead_idx").on(table.leadId),
    instantQuoteIdx: index("media_job_analyses_instant_quote_idx").on(
      table.instantQuoteId,
    ),
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
    attentionHandledBy: uuid("attention_handled_by").references(
      () => teamMembers.id,
      {
        onDelete: "set null",
      },
    ),
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
    threadCreatedIdIdx: index("conversation_messages_thread_created_id_idx").on(
      table.threadId,
      table.createdAt,
      table.id,
    ),
    statusIdx: index("conversation_messages_status_idx").on(
      table.deliveryStatus,
    ),
    sentIdx: index("conversation_messages_sent_idx").on(table.sentAt),
    exportEligibleEffectiveIdx: index(
      "conversation_messages_export_eligible_effective_idx",
    )
      .on(
        sql`coalesce(${table.sentAt}, ${table.receivedAt}, ${table.createdAt})`,
        table.createdAt,
        table.id,
      )
      .where(
        sql`${table.body} !~ E'^[\\t\\n\\v\\f\\r ]*$' AND (${table.direction} = 'inbound' OR (${table.direction} = 'outbound' AND ${table.deliveryStatus} IN ('sent', 'delivered') AND NOT (coalesce(${table.metadata}->>'draft', 'false') = 'true')))`,
      ),
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
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
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

export type PartnerInviteOperationState =
  | "requested"
  | "dispatched"
  | "succeeded"
  | "failed"
  | "reconciliation_required";

export type PartnerInviteResolution = "confirmed_sent" | "confirmed_not_sent";

/**
 * Durable evidence for a partner portal invitation attempt.
 *
 * The unresolved-partner-user index is intentionally independent of the
 * requesting actor and HTTP idempotency key. Email and SMS providers do not
 * provide a shared exactly-once boundary, so an ambiguous attempt must be
 * reconciled before any caller can create another attempt for the same user.
 */
export const partnerInviteOperations = pgTable(
  "partner_invite_operations",
  {
    id: uuid("id").primaryKey(),
    orgContactId: uuid("org_contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "restrict" }),
    partnerUserId: uuid("partner_user_id")
      .notNull()
      .references(() => partnerUsers.id, { onDelete: "restrict" }),
    operationKind: text("operation_kind").default("team_invite").notNull(),
    initiatorType: text("initiator_type").default("team_member").notNull(),
    semanticHash: varchar("semantic_hash", { length: 64 }).notNull(),
    requestedChannels: text("requested_channels").array().notNull(),
    correlationId: varchar("correlation_id", { length: 128 }).notNull(),
    idempotencyKeyHash: varchar("idempotency_key_hash", {
      length: 64,
    }).notNull(),
    actorMemberId: uuid("actor_member_id"),
    actorRole: text("actor_role"),
    actorLabel: text("actor_label"),
    sessionId: uuid("session_id"),
    authMethod: text("auth_method"),
    state: externalMessageDispatchStateEnum("state")
      .$type<PartnerInviteOperationState>()
      .default("requested")
      .notNull(),
    version: integer("version").default(1).notNull(),
    providerRequestKey: uuid("provider_request_key").notNull(),
    providerOperationIds: text("provider_operation_ids")
      .array()
      .notNull()
      .default([]),
    providerEvidence: jsonb("provider_evidence")
      .$type<Array<Record<string, unknown>>>()
      .notNull()
      .default([]),
    requestedAuditEventId: uuid("requested_audit_event_id")
      .notNull()
      .references(() => auditLogs.id, { onDelete: "restrict" }),
    dispatchAuditEventId: uuid("dispatch_audit_event_id").references(
      () => auditLogs.id,
      { onDelete: "restrict" },
    ),
    terminalAuditEventId: uuid("terminal_audit_event_id").references(
      () => auditLogs.id,
      { onDelete: "restrict" },
    ),
    failureCode: text("failure_code"),
    failureDetail: text("failure_detail"),
    retryable: boolean("retryable"),
    quarantinedAt: timestamp("quarantined_at", { withTimezone: true }),
    quarantinedBy: uuid("quarantined_by"),
    quarantineReason: text("quarantine_reason"),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    reconciliationRequiredAt: timestamp("reconciliation_required_at", {
      withTimezone: true,
    }),
    resolution: text("resolution").$type<PartnerInviteResolution>(),
    resolutionEvidence: text("resolution_evidence"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by").references(() => teamMembers.id, {
      onDelete: "restrict",
    }),
    resolutionAuditEventId: uuid("resolution_audit_event_id").references(
      () => auditLogs.id,
      { onDelete: "restrict" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    semanticIdx: index("partner_invite_operations_semantic_idx").on(
      table.semanticHash,
      table.createdAt,
    ),
    actorRequestKey: uniqueIndex("partner_invite_operations_actor_request_key")
      .on(table.actorMemberId, table.idempotencyKeyHash)
      .where(sql`${table.actorMemberId} IS NOT NULL`),
    publicRequestKey: uniqueIndex(
      "partner_invite_operations_public_request_key",
    )
      .on(table.idempotencyKeyHash)
      .where(sql`${table.initiatorType} = 'public_request'`),
    unresolvedTargetKey: uniqueIndex(
      "partner_invite_operations_unresolved_target_key",
    )
      .on(table.partnerUserId)
      .where(
        sql`${table.state} IN ('requested', 'dispatched', 'reconciliation_required') AND ${table.resolvedAt} IS NULL`,
      ),
    providerRequestKey: uniqueIndex(
      "partner_invite_operations_provider_request_key",
    ).on(table.providerRequestKey),
    requestedAuditKey: uniqueIndex(
      "partner_invite_operations_requested_audit_key",
    ).on(table.requestedAuditEventId),
    dispatchAuditKey: uniqueIndex(
      "partner_invite_operations_dispatch_audit_key",
    )
      .on(table.dispatchAuditEventId)
      .where(sql`${table.dispatchAuditEventId} IS NOT NULL`),
    terminalAuditKey: uniqueIndex(
      "partner_invite_operations_terminal_audit_key",
    )
      .on(table.terminalAuditEventId)
      .where(sql`${table.terminalAuditEventId} IS NOT NULL`),
    resolutionAuditKey: uniqueIndex(
      "partner_invite_operations_resolution_audit_key",
    )
      .on(table.resolutionAuditEventId)
      .where(sql`${table.resolutionAuditEventId} IS NOT NULL`),
    orgStateIdx: index("partner_invite_operations_org_state_idx").on(
      table.orgContactId,
      table.state,
      table.updatedAt,
    ),
    userCreatedIdx: index("partner_invite_operations_user_created_idx").on(
      table.partnerUserId,
      table.createdAt,
      table.id,
    ),
    versionCheck: check(
      "partner_invite_operations_version_check",
      sql`${table.version} >= 1`,
    ),
    semanticHashCheck: check(
      "partner_invite_operations_semantic_hash_check",
      sql`${table.semanticHash} ~ '^[0-9a-f]{64}$'`,
    ),
    idempotencyHashCheck: check(
      "partner_invite_operations_idempotency_hash_check",
      sql`${table.idempotencyKeyHash} ~ '^[0-9a-f]{64}$'`,
    ),
    channelCheck: check(
      "partner_invite_operations_channel_check",
      sql`${table.requestedChannels} IN (ARRAY['email']::text[], ARRAY['email', 'sms']::text[])`,
    ),
    operationKindCheck: check(
      "partner_invite_operations_operation_kind_check",
      sql`${table.operationKind} IN ('team_invite', 'public_login_link')`,
    ),
    initiatorCheck: check(
      "partner_invite_operations_initiator_check",
      sql`(
        ${table.initiatorType} = 'team_member'
        AND ${table.actorMemberId} IS NOT NULL
        AND ${table.authMethod} IN ('team_session', 'break_glass')
      ) OR (
        ${table.initiatorType} = 'public_request'
        AND ${table.actorMemberId} IS NULL
        AND ${table.sessionId} IS NULL
        AND ${table.authMethod} IS NULL
      )`,
    ),
    quarantineCheck: check(
      "partner_invite_operations_quarantine_check",
      sql`(${table.quarantinedAt} IS NULL AND ${table.quarantinedBy} IS NULL AND ${table.quarantineReason} IS NULL) OR (${table.quarantinedAt} IS NOT NULL AND ${table.quarantineReason} IS NOT NULL)`,
    ),
    resolutionCheck: check(
      "partner_invite_operations_resolution_check",
      sql`(
        ${table.resolution} IS NULL
        AND ${table.resolutionEvidence} IS NULL
        AND ${table.resolvedAt} IS NULL
        AND ${table.resolvedBy} IS NULL
        AND ${table.resolutionAuditEventId} IS NULL
      ) OR (
        ${table.state} = 'reconciliation_required'
        AND ${table.resolution} IN ('confirmed_sent', 'confirmed_not_sent')
        AND length(${table.resolutionEvidence}) BETWEEN 20 AND 1000
        AND ${table.resolvedAt} IS NOT NULL
        AND ${table.resolvedAt} >= ${table.reconciliationRequiredAt}
        AND ${table.resolvedBy} IS NOT NULL
        AND ${table.resolutionAuditEventId} IS NOT NULL
      )`,
    ),
    lifecycleCheck: check(
      "partner_invite_operations_lifecycle_check",
      sql`(
        (${table.state} = 'requested'
          AND ${table.dispatchedAt} IS NULL
          AND ${table.completedAt} IS NULL
          AND ${table.reconciliationRequiredAt} IS NULL
          AND ${table.dispatchAuditEventId} IS NULL
          AND ${table.terminalAuditEventId} IS NULL
          AND ${table.failureCode} IS NULL
          AND ${table.failureDetail} IS NULL
          AND ${table.retryable} IS NULL
          AND ${table.quarantinedAt} IS NULL)
        OR (${table.state} = 'dispatched'
          AND ${table.dispatchedAt} IS NOT NULL
          AND ${table.completedAt} IS NULL
          AND ${table.reconciliationRequiredAt} IS NULL
          AND ${table.dispatchAuditEventId} IS NOT NULL
          AND ${table.terminalAuditEventId} IS NULL
          AND ${table.failureCode} IS NULL
          AND ${table.failureDetail} IS NULL
          AND ${table.retryable} IS NULL
          AND ${table.quarantinedAt} IS NULL)
        OR (${table.state} = 'succeeded'
          AND ${table.dispatchedAt} IS NOT NULL
          AND ${table.completedAt} IS NOT NULL
          AND ${table.reconciliationRequiredAt} IS NULL
          AND ${table.dispatchAuditEventId} IS NOT NULL
          AND ${table.terminalAuditEventId} IS NOT NULL
          AND ${table.failureCode} IS NULL
          AND ${table.failureDetail} IS NULL
          AND ${table.retryable} = false
          AND ${table.quarantinedAt} IS NULL)
        OR (${table.state} = 'failed'
          AND ${table.completedAt} IS NOT NULL
          AND ${table.reconciliationRequiredAt} IS NULL
          AND ${table.terminalAuditEventId} IS NOT NULL
          AND ${table.failureCode} IS NOT NULL
          AND ${table.failureDetail} IS NOT NULL
          AND (
            (${table.dispatchedAt} IS NOT NULL
              AND ${table.dispatchAuditEventId} IS NOT NULL
              AND ${table.retryable} = true
              AND ${table.quarantinedAt} IS NULL)
            OR (${table.dispatchedAt} IS NULL
              AND ${table.dispatchAuditEventId} IS NULL
              AND ${table.retryable} = false
              AND ${table.quarantinedAt} IS NOT NULL)
          ))
        OR (${table.state} = 'reconciliation_required'
          AND ${table.dispatchedAt} IS NOT NULL
          AND ${table.completedAt} IS NOT NULL
          AND ${table.reconciliationRequiredAt} IS NOT NULL
          AND ${table.dispatchAuditEventId} IS NOT NULL
          AND ${table.terminalAuditEventId} IS NOT NULL
          AND ${table.failureCode} IS NOT NULL
          AND ${table.failureDetail} IS NOT NULL
          AND ${table.retryable} = false
          AND ${table.quarantinedAt} IS NULL)
      )`,
    ),
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
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
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

export const outboxEvents = pgTable(
  "outbox_events",
  {
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
    quarantinedAt: timestamp("quarantined_at", { withTimezone: true }),
    quarantinedBy: uuid("quarantined_by").references(() => teamMembers.id, {
      onDelete: "set null",
    }),
    quarantineReason: text("quarantine_reason"),
    quarantinedContactId: uuid("quarantined_contact_id").references(
      () => contacts.id,
      { onDelete: "restrict" },
    ),
  },
  (table) => ({
    dispatchableIdx: index("outbox_dispatchable_idx")
      .on(table.nextAttemptAt, table.createdAt)
      .where(
        sql`${table.processedAt} IS NULL AND ${table.quarantinedAt} IS NULL`,
      ),
    quarantinedContactIdx: index("outbox_quarantined_contact_idx")
      .on(table.quarantinedContactId, table.quarantinedAt)
      .where(sql`${table.quarantinedAt} IS NOT NULL`),
    pipelineMovementIdx: index("outbox_pipeline_movement_contact_created_idx")
      .on(sql`(${table.payload}->>'contactId')`, table.createdAt.desc())
      .where(sql`${table.type} = 'pipeline.auto_stage_change'`),
    quarantineStateCheck: check(
      "outbox_quarantine_state_check",
      sql`(${table.quarantinedAt} IS NULL AND ${table.quarantineReason} IS NULL AND ${table.quarantinedContactId} IS NULL) OR (${table.quarantinedAt} IS NOT NULL AND ${table.quarantineReason} IS NOT NULL)`,
    ),
  }),
);

export const externalMessageDispatches = pgTable(
  "external_message_dispatches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    outboxEventId: uuid("outbox_event_id")
      .notNull()
      .references(() => outboxEvents.id, { onDelete: "restrict" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => conversationMessages.id, { onDelete: "restrict" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "restrict" }),
    channel: conversationChannelEnum("channel").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    state: externalMessageDispatchStateEnum("state")
      .default("requested")
      .notNull(),
    version: integer("version").default(1).notNull(),
    providerRequestKey: text("provider_request_key").notNull(),
    provider: text("provider"),
    providerOperationId: text("provider_operation_id"),
    providerOperationIds: text("provider_operation_ids")
      .array()
      .notNull()
      .default([]),
    providerIdempotencySupported: boolean("provider_idempotency_supported")
      .default(false)
      .notNull(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    uncertaintyAt: timestamp("uncertainty_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    reconciliationRequiredAt: timestamp("reconciliation_required_at", {
      withTimezone: true,
    }),
    failureDetail: text("failure_detail"),
    retryable: boolean("retryable"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    eventAttemptIdx: uniqueIndex(
      "external_message_dispatches_event_attempt_key",
    ).on(table.outboxEventId, table.attemptNumber),
    providerRequestIdx: uniqueIndex(
      "external_message_dispatches_provider_request_key",
    ).on(table.providerRequestKey),
    messageIdx: index("external_message_dispatches_message_idx").on(
      table.messageId,
      table.createdAt,
    ),
    contactStateIdx: index("external_message_dispatches_contact_state_idx").on(
      table.contactId,
      table.state,
      table.updatedAt,
    ),
    reconciliationIdx: index("external_message_dispatches_reconciliation_idx")
      .on(table.reconciliationRequiredAt)
      .where(sql`${table.state} = 'reconciliation_required'`),
    attemptCheck: check(
      "external_message_dispatches_attempt_check",
      sql`${table.attemptNumber} >= 1`,
    ),
    versionCheck: check(
      "external_message_dispatches_version_check",
      sql`${table.version} >= 1`,
    ),
    channelCheck: check(
      "external_message_dispatches_channel_check",
      sql`${table.channel} IN ('sms', 'email', 'dm')`,
    ),
    stateCheck: check(
      "external_message_dispatches_state_check",
      sql`(
        (${table.state} = 'requested' AND ${table.dispatchedAt} IS NULL AND ${table.completedAt} IS NULL AND ${table.reconciliationRequiredAt} IS NULL)
        OR (${table.state} = 'dispatched' AND ${table.dispatchedAt} IS NOT NULL AND ${table.uncertaintyAt} IS NOT NULL AND ${table.completedAt} IS NULL AND ${table.reconciliationRequiredAt} IS NULL)
        OR (${table.state} = 'succeeded' AND ${table.dispatchedAt} IS NOT NULL AND ${table.completedAt} IS NOT NULL AND ${table.reconciliationRequiredAt} IS NULL AND ${table.failureDetail} IS NULL AND ${table.retryable} IS NULL)
        OR (${table.state} = 'failed' AND ${table.completedAt} IS NOT NULL AND ${table.reconciliationRequiredAt} IS NULL AND ${table.failureDetail} IS NOT NULL AND ${table.retryable} IS NOT NULL)
        OR (${table.state} = 'reconciliation_required' AND ${table.dispatchedAt} IS NOT NULL AND ${table.completedAt} IS NOT NULL AND ${table.reconciliationRequiredAt} IS NOT NULL AND ${table.failureDetail} IS NOT NULL AND ${table.retryable} = false)
      )`,
    ),
  }),
);

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
    providerDeviceIdx: uniqueIndex(
      "crew_tracking_devices_provider_device_key",
    ).on(table.provider, table.providerDeviceId),
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
    freshnessIdx: index("crew_location_pings_freshness_idx").on(
      table.freshness,
    ),
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
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
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

export type GoogleAdsRecommendationOperationState =
  | "requested"
  | "dispatched"
  | "succeeded"
  | "failed"
  | "reconciliation_required";

/**
 * Immutable-per-attempt evidence for Google Ads recommendation applications.
 *
 * Google Ads does not accept our caller idempotency key for this mutation. A
 * durable dispatched row is therefore the safety boundary: once dispatch has
 * begun, an interrupted attempt is quarantined for reconciliation and is
 * never sent again automatically.
 */
export const googleAdsRecommendationOperations = pgTable(
  "google_ads_recommendation_operations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    recommendationId: uuid("recommendation_id")
      .notNull()
      .references(() => googleAdsAnalystRecommendations.id, {
        onDelete: "restrict",
      }),
    parentOperationId: uuid("parent_operation_id").notNull(),
    correlationId: varchar("correlation_id", { length: 128 }).notNull(),
    idempotencyKeyHash: varchar("idempotency_key_hash", {
      length: 64,
    }).notNull(),
    expectedVersion: varchar("expected_version", { length: 200 }).notNull(),
    // Historical provider evidence keeps the verified actor ID as an
    // immutable snapshot. It must not be rewritten when a member is removed.
    actorMemberId: uuid("actor_member_id").notNull(),
    actorLabel: text("actor_label"),
    state: text("state")
      .$type<GoogleAdsRecommendationOperationState>()
      .default("requested")
      .notNull(),
    version: integer("version").default(1).notNull(),
    provider: text("provider").default("google_ads").notNull(),
    // This key identifies our dispatch evidence. Google Ads does not consume
    // it and providerIdempotencySupported must never be interpreted otherwise.
    providerRequestKey: uuid("provider_request_key").notNull(),
    providerOperationId: text("provider_operation_id"),
    terminalAuditEventId: uuid("terminal_audit_event_id").references(
      () => auditLogs.id,
      { onDelete: "restrict" },
    ),
    providerIdempotencySupported: boolean("provider_idempotency_supported")
      .default(false)
      .notNull(),
    term: text("term").notNull(),
    matchType: text("match_type").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    reconciliationRequiredAt: timestamp("reconciliation_required_at", {
      withTimezone: true,
    }),
    providerStatus: integer("provider_status"),
    failureCode: text("failure_code"),
    failureDetail: text("failure_detail"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    parentRecommendationKey: uniqueIndex(
      "google_ads_rec_operations_parent_recommendation_key",
    ).on(table.parentOperationId, table.recommendationId),
    actorRequestRecommendationKey: uniqueIndex(
      "google_ads_rec_operations_actor_request_recommendation_key",
    ).on(table.actorMemberId, table.idempotencyKeyHash, table.recommendationId),
    activeRecommendationKey: uniqueIndex(
      "google_ads_rec_operations_active_recommendation_key",
    )
      .on(table.recommendationId)
      .where(sql`${table.state} IN ('requested', 'dispatched')`),
    providerOperationKey: uniqueIndex(
      "google_ads_rec_operations_provider_operation_key",
    )
      .on(table.providerOperationId)
      .where(sql`${table.providerOperationId} IS NOT NULL`),
    providerRequestKey: uniqueIndex(
      "google_ads_rec_operations_provider_request_key",
    ).on(table.providerRequestKey),
    terminalAuditEventKey: uniqueIndex(
      "google_ads_rec_operations_terminal_audit_event_key",
    )
      .on(table.terminalAuditEventId)
      .where(sql`${table.terminalAuditEventId} IS NOT NULL`),
    stateUpdatedIdx: index("google_ads_rec_operations_state_updated_idx").on(
      table.state,
      table.updatedAt,
    ),
    recommendationCreatedIdx: index(
      "google_ads_rec_operations_recommendation_created_idx",
    ).on(table.recommendationId, table.createdAt, table.id),
    stateCheck: check(
      "google_ads_rec_operations_state_check",
      sql`${table.state} IN ('requested', 'dispatched', 'succeeded', 'failed', 'reconciliation_required')`,
    ),
    versionCheck: check(
      "google_ads_rec_operations_version_check",
      sql`${table.version} > 0`,
    ),
    idempotencyHashCheck: check(
      "google_ads_rec_operations_idempotency_hash_check",
      sql`${table.idempotencyKeyHash} ~ '^[0-9a-f]{64}$'`,
    ),
    expectedVersionCheck: check(
      "google_ads_rec_operations_expected_version_check",
      sql`length(${table.expectedVersion}) BETWEEN 1 AND 200`,
    ),
    matchTypeCheck: check(
      "google_ads_rec_operations_match_type_check",
      sql`${table.matchType} IN ('BROAD', 'PHRASE', 'EXACT')`,
    ),
    providerStatusCheck: check(
      "google_ads_rec_operations_provider_status_check",
      sql`${table.providerStatus} IS NULL OR ${table.providerStatus} BETWEEN 100 AND 599`,
    ),
    providerCheck: check(
      "google_ads_rec_operations_provider_check",
      sql`${table.provider} = 'google_ads' AND ${table.providerIdempotencySupported} = false`,
    ),
    termCheck: check(
      "google_ads_rec_operations_term_check",
      sql`length(trim(${table.term})) BETWEEN 1 AND 80`,
    ),
    lifecycleCheck: check(
      "google_ads_rec_operations_lifecycle_check",
      sql`(
        ${table.state} = 'requested'
        AND ${table.dispatchedAt} IS NULL
        AND ${table.completedAt} IS NULL
        AND ${table.reconciliationRequiredAt} IS NULL
        AND ${table.providerOperationId} IS NULL
        AND ${table.terminalAuditEventId} IS NULL
        AND ${table.providerStatus} IS NULL
        AND ${table.failureCode} IS NULL
        AND ${table.failureDetail} IS NULL
      ) OR (
        ${table.state} = 'dispatched'
        AND ${table.dispatchedAt} IS NOT NULL
        AND ${table.dispatchedAt} >= ${table.requestedAt}
        AND ${table.completedAt} IS NULL
        AND ${table.reconciliationRequiredAt} IS NULL
        AND ${table.providerOperationId} IS NULL
        AND ${table.terminalAuditEventId} IS NULL
        AND ${table.providerStatus} IS NULL
        AND ${table.failureCode} IS NULL
        AND ${table.failureDetail} IS NULL
      ) OR (
        ${table.state} = 'succeeded'
        AND ${table.dispatchedAt} IS NOT NULL
        AND ${table.completedAt} IS NOT NULL
        AND ${table.completedAt} >= ${table.dispatchedAt}
        AND ${table.reconciliationRequiredAt} IS NULL
        AND ${table.providerOperationId} IS NOT NULL
        AND ${table.terminalAuditEventId} IS NOT NULL
        AND ${table.failureCode} IS NULL
        AND ${table.failureDetail} IS NULL
      ) OR (
        ${table.state} = 'failed'
        AND ${table.dispatchedAt} IS NOT NULL
        AND ${table.completedAt} IS NOT NULL
        AND ${table.completedAt} >= ${table.dispatchedAt}
        AND ${table.reconciliationRequiredAt} IS NULL
        AND ${table.terminalAuditEventId} IS NOT NULL
        AND ${table.failureCode} IS NOT NULL
        AND ${table.failureDetail} IS NOT NULL
      ) OR (
        ${table.state} = 'reconciliation_required'
        AND ${table.dispatchedAt} IS NOT NULL
        AND ${table.completedAt} IS NOT NULL
        AND ${table.completedAt} >= ${table.dispatchedAt}
        AND ${table.reconciliationRequiredAt} IS NOT NULL
        AND ${table.reconciliationRequiredAt} >= ${table.dispatchedAt}
        AND ${table.terminalAuditEventId} IS NOT NULL
        AND ${table.failureCode} IS NOT NULL
        AND ${table.failureDetail} IS NOT NULL
      )`,
    ),
  }),
);

export type TeamCallOperationState =
  | "requested"
  | "dispatched"
  | "active"
  | "succeeded"
  | "failed"
  | "reconciliation_required";

export type TeamCallTerminalOutcome =
  | "connected"
  | "not_connected"
  | "not_dispatched";

export type TeamCallReconciliationOutcome =
  | "confirmed_connected"
  | "confirmed_not_connected"
  | "confirmed_not_dispatched"
  | "confirmed_active"
  | "confirmed_sent"
  | "confirmed_not_sent"
  | "still_uncertain";

export type TeamCallCallbackKind =
  | "connect"
  | "agent_status"
  | "customer_status"
  | "dial_action";

export type TeamCallTaskIntentKind = "explicit" | "speed_to_lead" | "follow_up";

export type TeamCallTaskIntentEffect =
  | "pending"
  | "completed"
  | "stale"
  | "already_terminal"
  | "not_connected"
  | "not_dispatched";

export type TeamCallReconciliationEvidenceType =
  | "provider_call_record"
  | "provider_no_matching_call"
  | "provider_support_response"
  | "operator_investigation";

/**
 * Immutable per-attempt evidence for manual Team calls.
 *
 * Twilio does not consume the CRM's idempotency key. Once an attempt is
 * durably dispatched, it can only be settled or quarantined for manual
 * reconciliation; it is never automatically sent a second time.
 */
export const teamCallOperations = pgTable(
  "team_call_operations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    mutationClaimId: uuid("mutation_claim_id").notNull(),
    // Historical, verified snapshots intentionally remain independent from
    // mutable CRM rows so retention/deactivation cannot rewrite evidence.
    contactId: uuid("contact_id").notNull(),
    agentMemberId: uuid("agent_member_id").notNull(),
    taskId: uuid("task_id"),
    actorMemberId: uuid("actor_member_id").notNull(),
    actorLabel: text("actor_label"),
    actorRole: text("actor_role"),
    sessionId: uuid("session_id").notNull(),
    authMethod: text("auth_method").notNull(),
    correlationId: varchar("correlation_id", { length: 128 }).notNull(),
    idempotencyKeyHash: varchar("idempotency_key_hash", {
      length: 64,
    }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    state: text("state")
      .$type<TeamCallOperationState>()
      .default("requested")
      .notNull(),
    version: integer("version").default(1).notNull(),
    provider: text("provider").default("twilio").notNull(),
    providerRequestKey: uuid("provider_request_key").notNull(),
    providerOperationId: text("provider_operation_id"),
    providerCustomerOperationId: text("provider_customer_operation_id"),
    providerIdempotencySupported: boolean("provider_idempotency_supported")
      .default(false)
      .notNull(),
    attemptAuditEventId: uuid("attempt_audit_event_id").references(
      () => auditLogs.id,
      { onDelete: "restrict" },
    ),
    providerAcceptedAuditEventId: uuid(
      "provider_accepted_audit_event_id",
    ).references(() => auditLogs.id, { onDelete: "restrict" }),
    terminalAuditEventId: uuid("terminal_audit_event_id").references(
      () => auditLogs.id,
      { onDelete: "restrict" },
    ),
    terminalOutcome: text("terminal_outcome").$type<TeamCallTerminalOutcome>(),
    outcomeReason: text("outcome_reason"),
    completedExplicitTaskId: uuid("completed_explicit_task_id"),
    completedFollowupTaskId: uuid("completed_followup_task_id"),
    completedSpeedToLeadCount: integer("completed_speed_to_lead_count")
      .default(0)
      .notNull(),
    legacyCompletedExplicitTaskId: uuid("legacy_completed_explicit_task_id"),
    legacyCompletedFollowupTaskId: uuid("legacy_completed_followup_task_id"),
    legacyCompletedSpeedToLeadCount: integer(
      "legacy_completed_speed_to_lead_count",
    )
      .default(0)
      .notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    providerAcceptedAt: timestamp("provider_accepted_at", {
      withTimezone: true,
    }),
    agentAnsweredAt: timestamp("agent_answered_at", { withTimezone: true }),
    customerAnsweredAt: timestamp("customer_answered_at", {
      withTimezone: true,
    }),
    agentCompletedAt: timestamp("agent_completed_at", { withTimezone: true }),
    customerCompletedAt: timestamp("customer_completed_at", {
      withTimezone: true,
    }),
    callbackDeadlineAt: timestamp("callback_deadline_at", {
      withTimezone: true,
    }),
    guardReleasedAt: timestamp("guard_released_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    reconciliationRequiredAt: timestamp("reconciliation_required_at", {
      withTimezone: true,
    }),
    // The migration owns the FK because the append-only reconciliation table
    // is declared below this operation ledger. These are the only fields a
    // terminal reconciliation_required row may ever add after settlement.
    reconciliationResolutionId: uuid("reconciliation_resolution_id"),
    reconciliationResolvedAt: timestamp("reconciliation_resolved_at", {
      withTimezone: true,
    }),
    providerStatus: integer("provider_status"),
    failureCode: text("failure_code"),
    failureDetail: text("failure_detail"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    mutationClaimKey: uniqueIndex("team_call_operations_mutation_claim_key").on(
      table.mutationClaimId,
    ),
    actorRequestKey: uniqueIndex("team_call_operations_actor_request_key").on(
      table.actorMemberId,
      table.idempotencyKeyHash,
    ),
    activeContactKey: index("team_call_operations_active_contact_key")
      .on(table.contactId)
      .where(sql`${table.guardReleasedAt} IS NULL`),
    providerRequestKey: uniqueIndex(
      "team_call_operations_provider_request_key",
    ).on(table.providerRequestKey),
    providerOperationKey: uniqueIndex(
      "team_call_operations_provider_operation_key",
    )
      .on(table.providerOperationId)
      .where(sql`${table.providerOperationId} IS NOT NULL`),
    providerCustomerOperationKey: uniqueIndex(
      "team_call_operations_provider_customer_operation_key",
    )
      .on(table.providerCustomerOperationId)
      .where(sql`${table.providerCustomerOperationId} IS NOT NULL`),
    attemptAuditEventKey: uniqueIndex(
      "team_call_operations_attempt_audit_event_key",
    )
      .on(table.attemptAuditEventId)
      .where(sql`${table.attemptAuditEventId} IS NOT NULL`),
    providerAcceptedAuditEventKey: uniqueIndex(
      "team_call_operations_provider_accepted_audit_event_key",
    )
      .on(table.providerAcceptedAuditEventId)
      .where(sql`${table.providerAcceptedAuditEventId} IS NOT NULL`),
    terminalAuditEventKey: uniqueIndex(
      "team_call_operations_terminal_audit_event_key",
    )
      .on(table.terminalAuditEventId)
      .where(sql`${table.terminalAuditEventId} IS NOT NULL`),
    stateUpdatedIdx: index("team_call_operations_state_updated_idx").on(
      table.state,
      table.updatedAt,
    ),
    contactCreatedIdx: index("team_call_operations_contact_created_idx").on(
      table.contactId,
      table.createdAt,
      table.id,
    ),
    stateCheck: check(
      "team_call_operations_state_check",
      sql`${table.state} IN ('requested', 'dispatched', 'active', 'succeeded', 'failed', 'reconciliation_required')`,
    ),
    versionCheck: check(
      "team_call_operations_version_check",
      sql`${table.version} > 0`,
    ),
    authMethodCheck: check(
      "team_call_operations_auth_method_check",
      sql`${table.authMethod} IN ('team_session', 'break_glass')`,
    ),
    idempotencyHashCheck: check(
      "team_call_operations_idempotency_hash_check",
      sql`${table.idempotencyKeyHash} ~ '^[0-9a-f]{64}$'`,
    ),
    requestHashCheck: check(
      "team_call_operations_request_hash_check",
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    providerStatusCheck: check(
      "team_call_operations_provider_status_check",
      sql`${table.providerStatus} IS NULL OR ${table.providerStatus} BETWEEN 100 AND 599`,
    ),
    providerCheck: check(
      "team_call_operations_provider_check",
      sql`${table.provider} = 'twilio' AND ${table.providerIdempotencySupported} = false`,
    ),
    providerOperationCheck: check(
      "team_call_operations_provider_operation_check",
      sql`${table.providerOperationId} IS NULL OR ${table.providerOperationId} ~ '^CA[0-9A-Fa-f]{32}$'`,
    ),
    providerCustomerOperationCheck: check(
      "team_call_operations_provider_customer_operation_check",
      sql`${table.providerCustomerOperationId} IS NULL OR ${table.providerCustomerOperationId} ~ '^CA[0-9A-Fa-f]{32}$'`,
    ),
    terminalOutcomeCheck: check(
      "team_call_operations_terminal_outcome_check",
      sql`${table.terminalOutcome} IS NULL OR ${table.terminalOutcome} IN ('connected', 'not_connected', 'not_dispatched')`,
    ),
    taskCountCheck: check(
      "team_call_operations_task_count_check",
      sql`${table.completedSpeedToLeadCount} >= 0 AND ${table.legacyCompletedSpeedToLeadCount} >= 0`,
    ),
    lifecycleCheck: check(
      "team_call_operations_lifecycle_check",
      sql`(
        ${table.state} = 'requested'
        AND ${table.dispatchedAt} IS NULL
        AND ${table.attemptAuditEventId} IS NULL
        AND ${table.callbackDeadlineAt} IS NULL
        AND ${table.guardReleasedAt} IS NULL
        AND ${table.completedAt} IS NULL
        AND ${table.providerOperationId} IS NULL
        AND ${table.providerCustomerOperationId} IS NULL
        AND ${table.providerAcceptedAuditEventId} IS NULL
        AND ${table.terminalAuditEventId} IS NULL
        AND ${table.terminalOutcome} IS NULL
        AND ${table.outcomeReason} IS NULL
      ) OR (
        ${table.state} = 'dispatched'
        AND ${table.dispatchedAt} IS NOT NULL
        AND ${table.attemptAuditEventId} IS NOT NULL
        AND ${table.callbackDeadlineAt} IS NOT NULL
        AND ${table.guardReleasedAt} IS NULL
        AND ${table.completedAt} IS NULL
        AND ${table.providerOperationId} IS NULL
        AND ${table.providerAcceptedAuditEventId} IS NULL
        AND ${table.terminalAuditEventId} IS NULL
        AND ${table.terminalOutcome} IS NULL
        AND ${table.outcomeReason} IS NULL
      ) OR (
        ${table.state} = 'active'
        AND ${table.dispatchedAt} IS NOT NULL
        AND ${table.attemptAuditEventId} IS NOT NULL
        AND ${table.callbackDeadlineAt} IS NOT NULL
        AND ${table.guardReleasedAt} IS NULL
        AND ${table.completedAt} IS NULL
        AND ${table.providerOperationId} IS NOT NULL
        AND ${table.providerAcceptedAt} IS NOT NULL
        AND ${table.providerAcceptedAuditEventId} IS NOT NULL
        AND ${table.terminalAuditEventId} IS NULL
        AND ${table.terminalOutcome} IS NULL
        AND ${table.outcomeReason} IS NULL
      ) OR (
        ${table.state} = 'succeeded'
        AND ${table.attemptAuditEventId} IS NOT NULL
        AND ${table.completedAt} IS NOT NULL
        AND ${table.guardReleasedAt} IS NOT NULL
        AND ${table.terminalOutcome} = 'connected'
        AND ${table.outcomeReason} IS NOT NULL
        AND ${table.providerOperationId} IS NOT NULL
        AND ${table.providerCustomerOperationId} IS NOT NULL
        AND ${table.providerAcceptedAuditEventId} IS NOT NULL
        AND ${table.terminalAuditEventId} IS NOT NULL
      ) OR (
        ${table.state} = 'failed'
        AND ${table.attemptAuditEventId} IS NOT NULL
        AND ${table.completedAt} IS NOT NULL
        AND ${table.guardReleasedAt} IS NOT NULL
        AND ${table.terminalOutcome} IN ('not_connected', 'not_dispatched')
        AND ${table.outcomeReason} IS NOT NULL
        AND (${table.terminalOutcome} <> 'not_connected' OR ${table.providerAcceptedAuditEventId} IS NOT NULL)
        AND ${table.terminalAuditEventId} IS NOT NULL
        AND ${table.failureCode} IS NOT NULL
        AND ${table.failureDetail} IS NOT NULL
        AND ${table.completedExplicitTaskId} IS NULL
        AND ${table.completedFollowupTaskId} IS NULL
        AND ${table.completedSpeedToLeadCount} = 0
      ) OR (
        ${table.state} = 'reconciliation_required'
        AND ${table.attemptAuditEventId} IS NOT NULL
        AND ${table.completedAt} IS NOT NULL
        AND ${table.reconciliationRequiredAt} IS NOT NULL
        AND (
          (${table.reconciliationResolutionId} IS NULL AND ${table.reconciliationResolvedAt} IS NULL AND ${table.guardReleasedAt} IS NULL AND ${table.terminalOutcome} IS NULL AND ${table.outcomeReason} IS NULL)
          OR (${table.reconciliationResolutionId} IS NOT NULL AND ${table.reconciliationResolvedAt} IS NOT NULL AND ${table.guardReleasedAt} IS NOT NULL AND ${table.terminalOutcome} IS NOT NULL AND ${table.outcomeReason} IS NOT NULL)
        )
        AND ${table.terminalAuditEventId} IS NOT NULL
        AND ${table.failureCode} IS NOT NULL
        AND ${table.failureDetail} IS NOT NULL
        AND (
          ${table.terminalOutcome} = 'connected'
          OR (
            ${table.completedExplicitTaskId} IS NULL
            AND ${table.completedFollowupTaskId} IS NULL
            AND ${table.completedSpeedToLeadCount} = 0
          )
        )
      )`,
    ),
  }),
);

/**
 * Append-only human review evidence for quarantined manual call attempts.
 *
 * Provider facts are copied exactly from the operator-supplied evidence and
 * are never used to rewrite the original operation outcome. A decisive record
 * can be linked once from team_call_operations to release the contact block.
 */
export const teamCallOperationReconciliations = pgTable(
  "team_call_operation_reconciliations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    callOperationId: uuid("call_operation_id").notNull(),
    mutationClaimId: uuid("mutation_claim_id").notNull(),
    reviewerMemberId: uuid("reviewer_member_id").notNull(),
    reviewerLabel: text("reviewer_label"),
    reviewerRole: text("reviewer_role"),
    reviewerSessionId: uuid("reviewer_session_id").notNull(),
    reviewerAuthMethod: text("reviewer_auth_method").notNull(),
    correlationId: varchar("correlation_id", { length: 128 }).notNull(),
    idempotencyKeyHash: varchar("idempotency_key_hash", {
      length: 64,
    }).notNull(),
    expectedOperationVersion: integer("expected_operation_version").notNull(),
    outcome: text("outcome").$type<TeamCallReconciliationOutcome>().notNull(),
    evidenceType: text("evidence_type")
      .$type<TeamCallReconciliationEvidenceType>()
      .notNull(),
    providerOperationId: text("provider_operation_id"),
    providerStatus: integer("provider_status"),
    reason: text("reason").notNull(),
    auditEventId: uuid("audit_event_id")
      .notNull()
      .references(() => auditLogs.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    mutationClaimKey: uniqueIndex(
      "team_call_reconciliations_mutation_claim_key",
    ).on(table.mutationClaimId),
    reviewerRequestKey: uniqueIndex(
      "team_call_reconciliations_reviewer_request_key",
    ).on(table.reviewerMemberId, table.idempotencyKeyHash),
    decisiveOperationKey: uniqueIndex(
      "team_call_reconciliations_decisive_operation_key",
    )
      .on(table.callOperationId)
      .where(
        sql`${table.outcome} IN ('confirmed_connected', 'confirmed_not_connected', 'confirmed_not_dispatched', 'confirmed_not_sent')`,
      ),
    operationCreatedIdx: index(
      "team_call_reconciliations_operation_created_idx",
    ).on(table.callOperationId, table.createdAt, table.id),
    outcomeCheck: check(
      "team_call_reconciliations_outcome_check",
      sql`${table.outcome} IN ('confirmed_connected', 'confirmed_not_connected', 'confirmed_not_dispatched', 'confirmed_active', 'confirmed_sent', 'confirmed_not_sent', 'still_uncertain')`,
    ),
    evidenceTypeCheck: check(
      "team_call_reconciliations_evidence_type_check",
      sql`${table.evidenceType} IN ('provider_call_record', 'provider_no_matching_call', 'provider_support_response', 'operator_investigation')`,
    ),
    authMethodCheck: check(
      "team_call_reconciliations_auth_method_check",
      sql`${table.reviewerAuthMethod} IN ('team_session', 'break_glass')`,
    ),
    versionCheck: check(
      "team_call_reconciliations_version_check",
      sql`${table.expectedOperationVersion} > 0`,
    ),
    idempotencyHashCheck: check(
      "team_call_reconciliations_idempotency_hash_check",
      sql`${table.idempotencyKeyHash} ~ '^[0-9a-f]{64}$'`,
    ),
    providerOperationCheck: check(
      "team_call_reconciliations_provider_operation_check",
      sql`${table.providerOperationId} IS NULL OR ${table.providerOperationId} ~ '^CA[0-9A-Fa-f]{32}$'`,
    ),
    providerStatusCheck: check(
      "team_call_reconciliations_provider_status_check",
      sql`${table.providerStatus} IS NULL OR ${table.providerStatus} BETWEEN 100 AND 599`,
    ),
    reasonCheck: check(
      "team_call_reconciliations_reason_check",
      sql`length(btrim(${table.reason})) BETWEEN 20 AND 1000`,
    ),
    evidenceOutcomeCheck: check(
      "team_call_reconciliations_evidence_outcome_check",
      sql`(${table.outcome} IN ('confirmed_connected', 'confirmed_not_connected', 'confirmed_active', 'confirmed_sent') AND ${table.providerOperationId} IS NOT NULL AND ${table.evidenceType} IN ('provider_call_record', 'provider_support_response')) OR (${table.outcome} IN ('confirmed_not_dispatched', 'confirmed_not_sent') AND ${table.providerOperationId} IS NULL AND ${table.evidenceType} IN ('provider_no_matching_call', 'provider_support_response')) OR ${table.outcome} = 'still_uncertain'`,
    ),
  }),
);

/**
 * Privacy-safe, append-only evidence from authenticated Twilio callbacks.
 * Raw form bodies, phone numbers, signatures, and credentials are never
 * retained here.
 */
export const teamCallOperationCallbackEvents = pgTable(
  "team_call_operation_callback_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    callOperationId: uuid("call_operation_id")
      .notNull()
      .references(() => teamCallOperations.id, { onDelete: "restrict" }),
    kind: text("kind").$type<TeamCallCallbackKind>().notNull(),
    leg: text("leg").$type<"agent" | "customer">().notNull(),
    semanticHash: varchar("semantic_hash", { length: 64 }).notNull(),
    parentCallSid: text("parent_call_sid"),
    customerCallSid: text("customer_call_sid"),
    status: text("status"),
    durationSec: integer("duration_sec"),
    bridged: boolean("bridged"),
    applyResult: text("apply_result")
      .$type<"applied" | "late" | "anomaly">()
      .notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    semanticKey: uniqueIndex("team_call_callback_events_semantic_key").on(
      table.callOperationId,
      table.semanticHash,
    ),
    operationReceivedIdx: index(
      "team_call_callback_events_operation_received_idx",
    ).on(table.callOperationId, table.receivedAt, table.id),
    kindCheck: check(
      "team_call_callback_events_kind_check",
      sql`${table.kind} IN ('connect', 'agent_status', 'customer_status', 'dial_action')`,
    ),
    legCheck: check(
      "team_call_callback_events_leg_check",
      sql`${table.leg} IN ('agent', 'customer')`,
    ),
    hashCheck: check(
      "team_call_callback_events_hash_check",
      sql`${table.semanticHash} ~ '^[0-9a-f]{64}$'`,
    ),
    parentSidCheck: check(
      "team_call_callback_events_parent_sid_check",
      sql`${table.parentCallSid} IS NULL OR ${table.parentCallSid} ~ '^CA[0-9A-Fa-f]{32}$'`,
    ),
    customerSidCheck: check(
      "team_call_callback_events_customer_sid_check",
      sql`${table.customerCallSid} IS NULL OR ${table.customerCallSid} ~ '^CA[0-9A-Fa-f]{32}$'`,
    ),
    durationCheck: check(
      "team_call_callback_events_duration_check",
      sql`${table.durationSec} IS NULL OR ${table.durationSec} >= 0`,
    ),
    applyResultCheck: check(
      "team_call_callback_events_apply_result_check",
      sql`${table.applyResult} IN ('applied', 'late', 'anomaly')`,
    ),
    statusCheck: check(
      "team_call_callback_events_status_check",
      sql`${table.status} IS NULL OR ${table.status} IN ('queued', 'initiated', 'ringing', 'answered', 'in-progress', 'completed', 'busy', 'no-answer', 'failed', 'canceled')`,
    ),
  }),
);

/**
 * The exact tasks that existed when a call crossed the provider boundary.
 * Callback settlement may only affect these snapshots; tasks created or
 * reassigned while a call is live are never closed by that call.
 */
export const teamCallOperationTaskIntents = pgTable(
  "team_call_operation_task_intents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    callOperationId: uuid("call_operation_id")
      .notNull()
      .references(() => teamCallOperations.id, { onDelete: "restrict" }),
    taskId: uuid("task_id").notNull(),
    kind: text("kind").$type<TeamCallTaskIntentKind>().notNull(),
    expectedContactId: uuid("expected_contact_id").notNull(),
    expectedAssignedTo: text("expected_assigned_to").notNull(),
    expectedUpdatedAt: timestamp("expected_updated_at", {
      withTimezone: true,
    }).notNull(),
    effect: text("effect")
      .$type<TeamCallTaskIntentEffect>()
      .default("pending")
      .notNull(),
    effectAt: timestamp("effect_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    operationTaskKindKey: uniqueIndex(
      "team_call_task_intents_operation_task_kind_key",
    ).on(table.callOperationId, table.taskId, table.kind),
    operationEffectIdx: index("team_call_task_intents_operation_effect_idx").on(
      table.callOperationId,
      table.effect,
      table.taskId,
    ),
    kindCheck: check(
      "team_call_task_intents_kind_check",
      sql`${table.kind} IN ('explicit', 'speed_to_lead', 'follow_up')`,
    ),
    effectCheck: check(
      "team_call_task_intents_effect_check",
      sql`${table.effect} IN ('pending', 'completed', 'stale', 'already_terminal', 'not_connected', 'not_dispatched')`,
    ),
    effectTimeCheck: check(
      "team_call_task_intents_effect_time_check",
      sql`(${table.effect} = 'pending' AND ${table.effectAt} IS NULL) OR (${table.effect} <> 'pending' AND ${table.effectAt} IS NOT NULL)`,
    ),
  }),
);

export type SalesEscalationCallOperationState =
  | "requested"
  | "dispatched"
  | "succeeded"
  | "failed"
  | "reconciliation_required";

export type SalesEscalationCallDeliveryCertainty =
  | "not_sent"
  | "accepted"
  | "uncertain";

export type SalesEscalationCallTerminalOutcome =
  | "connected"
  | "not_connected"
  | "not_dispatched";

export type SalesEscalationCallReconciliationOutcome =
  | "confirmed_dispatched"
  | "confirmed_connected"
  | "confirmed_not_dispatched";

export type SalesEscalationCallReconciliationEvidenceType =
  | "provider_call_record"
  | "provider_no_matching_call"
  | "provider_support_response";

/**
 * One durable attempt at a worker-initiated sales escalation call. Unlike a
 * manual Team call, this operation belongs to a service principal and an
 * outbox event, so it deliberately does not reuse the human mutation ledger.
 */
export const salesEscalationCallOperations = pgTable(
  "sales_escalation_call_operations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    outboxEventId: uuid("outbox_event_id")
      .notNull()
      .references(() => outboxEvents.id, { onDelete: "restrict" }),
    attemptNumber: integer("attempt_number").notNull(),
    taskId: uuid("task_id").notNull(),
    taskUpdatedAt: timestamp("task_updated_at", {
      withTimezone: true,
    }).notNull(),
    contactId: uuid("contact_id").notNull(),
    agentMemberId: uuid("agent_member_id").notNull(),
    agentPhoneE164: text("agent_phone_e164").notNull(),
    customerPhoneE164: text("customer_phone_e164").notNull(),
    mode: text("mode").$type<"instant" | "scheduled">().notNull(),
    state: text("state")
      .$type<SalesEscalationCallOperationState>()
      .default("requested")
      .notNull(),
    version: integer("version").default(1).notNull(),
    provider: text("provider").default("twilio").notNull(),
    providerRequestKey: uuid("provider_request_key").notNull(),
    providerOperationId: text("provider_operation_id"),
    providerCustomerOperationId: text("provider_customer_operation_id"),
    providerIdempotencySupported: boolean("provider_idempotency_supported")
      .default(false)
      .notNull(),
    deliveryCertainty: text(
      "delivery_certainty",
    ).$type<SalesEscalationCallDeliveryCertainty | null>(),
    providerStatus: integer("provider_status"),
    failureCode: text("failure_code"),
    failureDetail: text("failure_detail"),
    retryable: boolean("retryable"),
    requestedAuditEventId: uuid("requested_audit_event_id")
      .notNull()
      .references(() => auditLogs.id, { onDelete: "restrict" }),
    dispatchAuditEventId: uuid("dispatch_audit_event_id").references(
      () => auditLogs.id,
      { onDelete: "restrict" },
    ),
    providerResultAuditEventId: uuid(
      "provider_result_audit_event_id",
    ).references(() => auditLogs.id, { onDelete: "restrict" }),
    providerAcceptedAuditEventId: uuid(
      "provider_accepted_audit_event_id",
    ).references(() => auditLogs.id, { onDelete: "restrict" }),
    terminalAuditEventId: uuid("terminal_audit_event_id").references(
      () => auditLogs.id,
      { onDelete: "restrict" },
    ),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    providerAcceptedAt: timestamp("provider_accepted_at", {
      withTimezone: true,
    }),
    reconciliationRequiredAt: timestamp("reconciliation_required_at", {
      withTimezone: true,
    }),
    reconciliationResolutionId: uuid("reconciliation_resolution_id"),
    reconciliationResolvedAt: timestamp("reconciliation_resolved_at", {
      withTimezone: true,
    }),
    agentAnsweredAt: timestamp("agent_answered_at", { withTimezone: true }),
    customerDialRequestedAt: timestamp("customer_dial_requested_at", {
      withTimezone: true,
    }),
    customerAnsweredAt: timestamp("customer_answered_at", {
      withTimezone: true,
    }),
    customerCompletedAt: timestamp("customer_completed_at", {
      withTimezone: true,
    }),
    callbackDeadlineAt: timestamp("callback_deadline_at", {
      withTimezone: true,
    }),
    terminalOutcome: text(
      "terminal_outcome",
    ).$type<SalesEscalationCallTerminalOutcome | null>(),
    outcomeReason: text("outcome_reason"),
    taskEffect: text("task_effect")
      .$type<
        | "pending"
        | "completed"
        | "stale"
        | "already_terminal"
        | "not_connected"
        | "not_dispatched"
      >()
      .default("pending")
      .notNull(),
    taskEffectAt: timestamp("task_effect_at", { withTimezone: true }),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    guardReleasedAt: timestamp("guard_released_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    eventAttemptKey: uniqueIndex(
      "sales_escalation_call_operations_event_attempt_key",
    ).on(table.outboxEventId, table.attemptNumber),
    taskAttemptKey: uniqueIndex(
      "sales_escalation_call_operations_task_attempt_key",
    ).on(table.taskId, table.attemptNumber),
    providerRequestKey: uniqueIndex(
      "sales_escalation_call_operations_provider_request_key",
    ).on(table.providerRequestKey),
    providerOperationKey: uniqueIndex(
      "sales_escalation_call_operations_provider_operation_key",
    )
      .on(table.providerOperationId)
      .where(sql`${table.providerOperationId} IS NOT NULL`),
    providerCustomerOperationKey: uniqueIndex(
      "sales_escalation_call_operations_customer_sid_key",
    )
      .on(table.providerCustomerOperationId)
      .where(sql`${table.providerCustomerOperationId} IS NOT NULL`),
    unresolvedEventKey: uniqueIndex(
      "sales_escalation_call_operations_unresolved_event_key",
    )
      .on(table.outboxEventId)
      .where(sql`${table.guardReleasedAt} IS NULL`),
    unresolvedTaskKey: uniqueIndex(
      "sales_escalation_call_operations_unresolved_task_key",
    )
      .on(table.taskId)
      .where(sql`${table.guardReleasedAt} IS NULL`),
    providerCrossedTaskKey: uniqueIndex(
      "sales_escalation_call_operations_provider_crossed_task_key",
    )
      .on(table.taskId)
      .where(sql`${table.deliveryCertainty} IN ('accepted', 'uncertain')`),
    taskIdx: index("sales_escalation_call_operations_task_idx").on(
      table.taskId,
      table.createdAt,
    ),
    contactIdx: index("sales_escalation_call_operations_contact_idx").on(
      table.contactId,
      table.createdAt,
    ),
  }),
);

/**
 * Append-only operator evidence for a quarantined worker-initiated call.
 * These rows record a human review and never cause another provider request.
 */
export const salesEscalationCallReconciliations = pgTable(
  "sales_escalation_call_reconciliations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    operationId: uuid("operation_id")
      .notNull()
      .references(() => salesEscalationCallOperations.id, {
        onDelete: "restrict",
      }),
    mutationClaimId: uuid("mutation_claim_id").notNull(),
    reviewerMemberId: uuid("reviewer_member_id").notNull(),
    reviewerLabel: text("reviewer_label"),
    reviewerRole: text("reviewer_role"),
    reviewerSessionId: uuid("reviewer_session_id").notNull(),
    reviewerAuthMethod: text("reviewer_auth_method").notNull(),
    correlationId: varchar("correlation_id", { length: 128 }).notNull(),
    idempotencyKeyHash: varchar("idempotency_key_hash", {
      length: 64,
    }).notNull(),
    expectedOperationVersion: integer("expected_operation_version").notNull(),
    outcome: text("outcome")
      .$type<SalesEscalationCallReconciliationOutcome>()
      .notNull(),
    evidenceType: text("evidence_type")
      .$type<SalesEscalationCallReconciliationEvidenceType>()
      .notNull(),
    providerOperationId: text("provider_operation_id"),
    providerCustomerOperationId: text("provider_customer_operation_id"),
    providerCallStatus: text("provider_call_status"),
    providerCustomerStatus: text("provider_customer_status"),
    connectedDurationSec: integer("connected_duration_sec"),
    reason: text("reason").notNull(),
    auditEventId: uuid("audit_event_id")
      .notNull()
      .references(() => auditLogs.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    mutationClaimKey: uniqueIndex(
      "sales_escalation_call_reconciliations_mutation_claim_key",
    ).on(table.mutationClaimId),
    reviewerRequestKey: uniqueIndex(
      "sales_escalation_call_reconciliations_reviewer_request_key",
    ).on(table.reviewerMemberId, table.idempotencyKeyHash),
    auditEventKey: uniqueIndex(
      "sales_escalation_call_reconciliations_audit_event_key",
    ).on(table.auditEventId),
    decisiveOperationKey: uniqueIndex(
      "sales_escalation_call_reconciliations_decisive_operation_key",
    )
      .on(table.operationId)
      .where(
        sql`${table.outcome} IN ('confirmed_connected', 'confirmed_not_dispatched')`,
      ),
    operationCreatedIdx: index(
      "sales_escalation_call_reconciliations_operation_created_idx",
    ).on(table.operationId, table.createdAt, table.id),
    outcomeCheck: check(
      "sales_escalation_call_reconciliations_outcome_check",
      sql`${table.outcome} IN ('confirmed_dispatched', 'confirmed_connected', 'confirmed_not_dispatched')`,
    ),
    evidenceTypeCheck: check(
      "sales_escalation_call_reconciliations_evidence_type_check",
      sql`${table.evidenceType} IN ('provider_call_record', 'provider_no_matching_call', 'provider_support_response')`,
    ),
    authMethodCheck: check(
      "sales_escalation_call_reconciliations_auth_method_check",
      sql`${table.reviewerAuthMethod} IN ('team_session', 'break_glass')`,
    ),
    versionCheck: check(
      "sales_escalation_call_reconciliations_version_check",
      sql`${table.expectedOperationVersion} > 0`,
    ),
    correlationCheck: check(
      "sales_escalation_call_reconciliations_correlation_check",
      sql`length(${table.correlationId}) BETWEEN 8 AND 128`,
    ),
    idempotencyHashCheck: check(
      "sales_escalation_call_reconciliations_idempotency_hash_check",
      sql`${table.idempotencyKeyHash} ~ '^[0-9a-f]{64}$'`,
    ),
    parentSidCheck: check(
      "sales_escalation_call_reconciliations_parent_sid_check",
      sql`${table.providerOperationId} IS NULL OR ${table.providerOperationId} ~ '^CA[0-9A-Fa-f]{32}$'`,
    ),
    customerSidCheck: check(
      "sales_escalation_call_reconciliations_customer_sid_check",
      sql`${table.providerCustomerOperationId} IS NULL OR ${table.providerCustomerOperationId} ~ '^CA[0-9A-Fa-f]{32}$'`,
    ),
    providerCallStatusCheck: check(
      "sales_escalation_call_reconciliations_parent_status_check",
      sql`${table.providerCallStatus} IS NULL OR ${table.providerCallStatus} IN ('queued', 'initiated', 'ringing', 'answered', 'in-progress', 'completed', 'busy', 'no-answer', 'failed', 'canceled')`,
    ),
    providerCustomerStatusCheck: check(
      "sales_escalation_call_reconciliations_customer_status_check",
      sql`${table.providerCustomerStatus} IS NULL OR ${table.providerCustomerStatus} IN ('queued', 'initiated', 'ringing', 'answered', 'in-progress', 'completed', 'busy', 'no-answer', 'failed', 'canceled')`,
    ),
    durationCheck: check(
      "sales_escalation_call_reconciliations_duration_check",
      sql`${table.connectedDurationSec} IS NULL OR ${table.connectedDurationSec} BETWEEN 1 AND 86400`,
    ),
    reasonCheck: check(
      "sales_escalation_call_reconciliations_reason_check",
      sql`length(btrim(${table.reason})) BETWEEN 20 AND 1000`,
    ),
    evidenceOutcomeCheck: check(
      "sales_escalation_call_reconciliations_evidence_outcome_check",
      sql`(
        ${table.outcome} = 'confirmed_dispatched'
        AND ${table.evidenceType} IN ('provider_call_record', 'provider_support_response')
        AND ${table.providerOperationId} IS NOT NULL
        AND ${table.providerCallStatus} IS NOT NULL
        AND ${table.providerCustomerOperationId} IS NULL
        AND ${table.providerCustomerStatus} IS NULL
        AND ${table.connectedDurationSec} IS NULL
      ) OR (
        ${table.outcome} = 'confirmed_connected'
        AND ${table.evidenceType} IN ('provider_call_record', 'provider_support_response')
        AND ${table.providerOperationId} IS NOT NULL
        AND ${table.providerCustomerOperationId} IS NOT NULL
        AND ${table.providerCallStatus} = 'completed'
        AND ${table.providerCustomerStatus} = 'completed'
        AND ${table.connectedDurationSec} BETWEEN 1 AND 86400
      ) OR (
        ${table.outcome} = 'confirmed_not_dispatched'
        AND ${table.evidenceType} IN ('provider_no_matching_call', 'provider_support_response')
        AND ${table.providerOperationId} IS NULL
        AND ${table.providerCustomerOperationId} IS NULL
        AND ${table.providerCallStatus} IS NULL
        AND ${table.providerCustomerStatus} IS NULL
        AND ${table.connectedDurationSec} IS NULL
      )`,
    ),
  }),
);

/**
 * One immutable owner for every Twilio SID introduced through human review.
 * A separate table permits repeated evidence for the same operation/SID while
 * enforcing that the SID can never move to another operation or call leg.
 */
export const salesEscalationCallReconciliationSidClaims = pgTable(
  "sales_escalation_call_reconciliation_sid_claims",
  {
    sid: text("sid").primaryKey(),
    operationId: uuid("operation_id")
      .notNull()
      .references(() => salesEscalationCallOperations.id, {
        onDelete: "restrict",
      }),
    leg: text("leg").$type<"parent" | "customer">().notNull(),
    firstReconciliationId: uuid("first_reconciliation_id")
      .notNull()
      .references(() => salesEscalationCallReconciliations.id, {
        onDelete: "restrict",
      }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    operationLegKey: uniqueIndex(
      "sales_escalation_call_reconciliation_sid_claims_operation_leg_key",
    ).on(table.operationId, table.leg),
    operationIdx: index(
      "sales_escalation_call_reconciliation_sid_claims_operation_idx",
    ).on(table.operationId, table.createdAt),
    sidCheck: check(
      "sales_escalation_call_reconciliation_sid_claims_sid_check",
      sql`${table.sid} ~ '^CA[0-9A-Fa-f]{32}$'`,
    ),
    legCheck: check(
      "sales_escalation_call_reconciliation_sid_claims_leg_check",
      sql`${table.leg} IN ('parent', 'customer')`,
    ),
  }),
);

export type SalesEscalationCallCallbackKind =
  | "agent_connect"
  | "customer_dial_requested"
  | "agent_status"
  | "customer_status"
  | "dial_action";

export const salesEscalationCallCallbackEvents = pgTable(
  "sales_escalation_call_callback_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    operationId: uuid("operation_id")
      .notNull()
      .references(() => salesEscalationCallOperations.id, {
        onDelete: "restrict",
      }),
    kind: text("kind").$type<SalesEscalationCallCallbackKind>().notNull(),
    leg: text("leg").$type<"agent" | "customer">().notNull(),
    semanticHash: varchar("semantic_hash", { length: 64 }).notNull(),
    parentCallSid: text("parent_call_sid").notNull(),
    customerCallSid: text("customer_call_sid"),
    status: text("status"),
    durationSec: integer("duration_sec"),
    bridged: boolean("bridged"),
    applyResult: text("apply_result")
      .$type<"applied" | "duplicate" | "late" | "anomaly">()
      .notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    semanticKey: uniqueIndex("sales_escalation_callback_semantic_key").on(
      table.operationId,
      table.semanticHash,
    ),
    operationReceivedIdx: index(
      "sales_escalation_callback_operation_received_idx",
    ).on(table.operationId, table.receivedAt, table.id),
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
    quotedScopeText: varchar("quoted_scope_text", { length: 4000 }),
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
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
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
    fullQuoteId: uuid("full_quote_id").references(() => quotes.id, {
      onDelete: "cascade",
    }),
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
    fullQuoteIdx: index("appointment_holds_full_quote_idx").on(
      table.fullQuoteId,
    ),
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

export const mediaAssets = pgTable(
  "media_assets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    storageProvider: text("storage_provider").default("r2").notNull(),
    storageBucket: text("storage_bucket").notNull(),
    originalObjectKey: text("original_object_key").notNull(),
    displayObjectKey: text("display_object_key"),
    thumbnailObjectKey: text("thumbnail_object_key"),
    source: text("source").default("manual").notNull(),
    sourceKey: text("source_key"),
    status: text("status").default("staging").notNull(),
    originalFilename: text("original_filename"),
    contentType: text("content_type"),
    byteSize: integer("byte_size"),
    width: integer("width"),
    height: integer("height"),
    sha256: varchar("sha256", { length: 64 }),
    uploadedByMemberId: uuid("uploaded_by_member_id").references(
      () => teamMembers.id,
      { onDelete: "set null" },
    ),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    sourceMessageId: uuid("source_message_id").references(
      () => conversationMessages.id,
      { onDelete: "set null" },
    ),
    sourceMediaIndex: integer("source_media_index"),
    sourceMetadata: jsonb("source_metadata").$type<Record<
      string,
      unknown
    > | null>(),
    stagingExpiresAt: timestamp("staging_expires_at", { withTimezone: true }),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    processingError: text("processing_error"),
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
    sourceKeyIdx: uniqueIndex("media_assets_source_key_key").on(
      table.sourceKey,
    ),
    originalObjectKeyIdx: uniqueIndex(
      "media_assets_original_object_key_key",
    ).on(table.storageBucket, table.originalObjectKey),
    contactIdx: index("media_assets_contact_idx").on(
      table.contactId,
      table.createdAt,
    ),
    sourceMessageIdx: index("media_assets_source_message_idx").on(
      table.sourceMessageId,
    ),
    uploaderIdx: index("media_assets_uploader_idx").on(
      table.uploadedByMemberId,
      table.createdAt,
    ),
    statusIdx: index("media_assets_status_idx").on(
      table.status,
      table.createdAt,
    ),
    stagingExpiresIdx: index("media_assets_staging_expires_idx").on(
      table.stagingExpiresAt,
    ),
    deletedIdx: index("media_assets_deleted_idx").on(table.deletedAt),
  }),
);

export const appointmentMedia = pgTable(
  "appointment_media",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => appointments.id, { onDelete: "cascade" }),
    mediaAssetId: uuid("media_asset_id")
      .notNull()
      .references(() => mediaAssets.id, { onDelete: "cascade" }),
    purpose: text("purpose").default("quoted_work").notNull(),
    caption: text("caption"),
    sortOrder: integer("sort_order").default(0).notNull(),
    isCover: boolean("is_cover").default(false).notNull(),
    attachedByMemberId: uuid("attached_by_member_id").references(
      () => teamMembers.id,
      { onDelete: "set null" },
    ),
    attachmentSource: text("attachment_source").default("manual").notNull(),
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
    appointmentAssetIdx: uniqueIndex(
      "appointment_media_appointment_asset_key",
    ).on(table.appointmentId, table.mediaAssetId),
    appointmentIdx: index("appointment_media_appointment_idx").on(
      table.appointmentId,
      table.purpose,
      table.sortOrder,
    ),
    mediaAssetIdx: index("appointment_media_asset_idx").on(table.mediaAssetId),
    deletedIdx: index("appointment_media_deleted_idx").on(table.deletedAt),
    activeCoverIdx: uniqueIndex("appointment_media_active_cover_key")
      .on(table.appointmentId)
      .where(sql`${table.isCover} = true AND ${table.deletedAt} IS NULL`),
  }),
);

export const instantQuoteMedia = pgTable(
  "instant_quote_media",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    instantQuoteId: uuid("instant_quote_id")
      .notNull()
      .references(() => instantQuotes.id, { onDelete: "cascade" }),
    mediaAssetId: uuid("media_asset_id")
      .notNull()
      .references(() => mediaAssets.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    quoteAssetIdx: uniqueIndex("instant_quote_media_quote_asset_key").on(
      table.instantQuoteId,
      table.mediaAssetId,
    ),
    quoteIdx: index("instant_quote_media_quote_idx").on(
      table.instantQuoteId,
      table.sortOrder,
    ),
    mediaAssetIdx: index("instant_quote_media_asset_idx").on(
      table.mediaAssetId,
    ),
  }),
);

export const mobileOfflineMediaQueueHealth = pgTable(
  "mobile_offline_media_queue_health",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    teamMemberId: uuid("team_member_id")
      .notNull()
      .references(() => teamMembers.id, { onDelete: "cascade" }),
    clientDeviceId: uuid("client_device_id").notNull(),
    queuedCount: integer("queued_count").default(0).notNull(),
    failedCount: integer("failed_count").default(0).notNull(),
    oldestQueuedAt: timestamp("oldest_queued_at", { withTimezone: true }),
    clientReportedAt: timestamp("client_reported_at", {
      withTimezone: true,
    }).notNull(),
    lastReportedAt: timestamp("last_reported_at", { withTimezone: true })
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
    memberDeviceIdx: uniqueIndex(
      "mobile_offline_media_queue_health_member_device_key",
    ).on(table.teamMemberId, table.clientDeviceId),
    staleQueueIdx: index("mobile_offline_media_queue_health_stale_idx")
      .on(table.oldestQueuedAt)
      .where(sql`${table.queuedCount} > 0`),
    lastReportedIdx: index(
      "mobile_offline_media_queue_health_last_reported_idx",
    ).on(table.lastReportedAt),
    queuedCountCheck: check(
      "mobile_offline_media_queue_health_queued_count_check",
      sql`${table.queuedCount} BETWEEN 0 AND 10000`,
    ),
    failedCountCheck: check(
      "mobile_offline_media_queue_health_failed_count_check",
      sql`${table.failedCount} BETWEEN 0 AND ${table.queuedCount}`,
    ),
    queueStateCheck: check(
      "mobile_offline_media_queue_health_queue_state_check",
      sql`(${table.queuedCount} = 0 AND ${table.failedCount} = 0 AND ${table.oldestQueuedAt} IS NULL) OR (${table.queuedCount} > 0 AND ${table.oldestQueuedAt} IS NOT NULL)`,
    ),
  }),
);

export const mobileExpenseQueueHealth = pgTable(
  "mobile_expense_queue_health",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    teamMemberId: uuid("team_member_id")
      .notNull()
      .references(() => teamMembers.id, { onDelete: "cascade" }),
    clientDeviceId: uuid("client_device_id").notNull(),
    queuedCount: integer("queued_count").default(0).notNull(),
    failedCount: integer("failed_count").default(0).notNull(),
    oldestQueuedAt: timestamp("oldest_queued_at", { withTimezone: true }),
    clientReportedAt: timestamp("client_reported_at", {
      withTimezone: true,
    }).notNull(),
    lastReportedAt: timestamp("last_reported_at", { withTimezone: true })
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
    memberDeviceIdx: uniqueIndex(
      "mobile_expense_queue_health_member_device_key",
    ).on(table.teamMemberId, table.clientDeviceId),
    staleQueueIdx: index("mobile_expense_queue_health_stale_idx")
      .on(table.oldestQueuedAt)
      .where(sql`${table.queuedCount} > 0`),
    lastReportedIdx: index("mobile_expense_queue_health_last_reported_idx").on(
      table.lastReportedAt,
    ),
    queuedCountCheck: check(
      "mobile_expense_queue_health_queued_count_check",
      sql`${table.queuedCount} BETWEEN 0 AND 10000`,
    ),
    failedCountCheck: check(
      "mobile_expense_queue_health_failed_count_check",
      sql`${table.failedCount} BETWEEN 0 AND ${table.queuedCount}`,
    ),
    queueStateCheck: check(
      "mobile_expense_queue_health_queue_state_check",
      sql`(${table.queuedCount} = 0 AND ${table.failedCount} = 0 AND ${table.oldestQueuedAt} IS NULL) OR (${table.queuedCount} > 0 AND ${table.oldestQueuedAt} IS NOT NULL)`,
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
    createOperationKeyHash: varchar("create_operation_key_hash", {
      length: 64,
    }),
    createRequestHash: varchar("create_request_hash", { length: 64 }),
    cancelOperationKeyHash: varchar("cancel_operation_key_hash", {
      length: 64,
    }),
    version: integer("version").default(1).notNull(),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    orgIdx: index("partner_bookings_org_idx").on(table.orgContactId),
    appointmentIdx: index("partner_bookings_appointment_idx").on(
      table.appointmentId,
    ),
    createOperationKeyIdx: uniqueIndex(
      "partner_bookings_create_operation_key_hash_key",
    )
      .on(table.createOperationKeyHash)
      .where(sql`${table.createOperationKeyHash} IS NOT NULL`),
    createOperationKeyHashCheck: check(
      "partner_bookings_create_operation_key_hash_check",
      sql`${table.createOperationKeyHash} IS NULL OR ${table.createOperationKeyHash} ~ '^[0-9a-f]{64}$'`,
    ),
    createRequestHashCheck: check(
      "partner_bookings_create_request_hash_check",
      sql`${table.createRequestHash} IS NULL OR ${table.createRequestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    cancelOperationKeyHashCheck: check(
      "partner_bookings_cancel_operation_key_hash_check",
      sql`${table.cancelOperationKeyHash} IS NULL OR ${table.cancelOperationKeyHash} ~ '^[0-9a-f]{64}$'`,
    ),
    versionCheck: check(
      "partner_bookings_version_check",
      sql`${table.version} > 0`,
    ),
  }),
);

export type StaffNotificationOperationState =
  | "requested"
  | "dispatched"
  | "succeeded"
  | "failed"
  | "reconciliation_required";

/**
 * Durable, private staff notifications. These deliberately do not reuse a
 * customer conversation thread: an internal recipient must never appear as a
 * message sent to the customer whose record triggered the alert.
 */
export const staffNotificationOperations = pgTable(
  "staff_notification_operations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Snapshot identifier: staff-alert evidence must survive later retention
    // purges of the triggering CRM record.
    appointmentId: uuid("appointment_id").notNull(),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    recipientTeamMemberId: uuid("recipient_team_member_id").references(
      () => teamMembers.id,
      { onDelete: "set null" },
    ),
    kind: text("kind").notNull(),
    channel: text("channel").default("sms").notNull(),
    recipientAddress: text("recipient_address").notNull(),
    body: text("body").notNull(),
    state: text("state")
      .$type<StaffNotificationOperationState>()
      .default("requested")
      .notNull(),
    providerRequestKey: varchar("provider_request_key", {
      length: 160,
    }).notNull(),
    provider: text("provider"),
    providerOperationId: text("provider_operation_id"),
    deliveryCertainty: text("delivery_certainty"),
    failureCode: text("failure_code"),
    retryable: boolean("retryable").default(false).notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    uncertaintyAt: timestamp("uncertainty_at", { withTimezone: true }),
    succeededAt: timestamp("succeeded_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    appointmentKindRecipientKey: uniqueIndex(
      "staff_notification_operations_appointment_kind_recipient_key",
    ).on(table.appointmentId, table.kind, table.recipientTeamMemberId),
    appointmentKindAddressKey: uniqueIndex(
      "staff_notification_operations_appointment_kind_address_key",
    ).on(table.appointmentId, table.kind, table.recipientAddress),
    providerRequestKeyIdx: uniqueIndex(
      "staff_notification_operations_provider_request_key_key",
    ).on(table.providerRequestKey),
    stateIdx: index("staff_notification_operations_state_idx").on(
      table.state,
      table.createdAt,
    ),
    stateCheck: check(
      "staff_notification_operations_state_check",
      sql`${table.state} IN ('requested', 'dispatched', 'succeeded', 'failed', 'reconciliation_required')`,
    ),
    channelCheck: check(
      "staff_notification_operations_channel_check",
      sql`${table.channel} = 'sms'`,
    ),
    kindCheck: check(
      "staff_notification_operations_kind_check",
      sql`${table.kind} IN ('partner_booking_created', 'partner_booking_canceled')`,
    ),
    recipientCheck: check(
      "staff_notification_operations_recipient_check",
      sql`${table.recipientAddress} ~ '^\\+[1-9][0-9]{9,14}$'`,
    ),
    attemptCountCheck: check(
      "staff_notification_operations_attempt_count_check",
      sql`${table.attemptCount} BETWEEN 0 AND 20`,
    ),
    lifecycleCheck: check(
      "staff_notification_operations_lifecycle_check",
      sql`(${table.state} = 'requested' AND ${table.succeededAt} IS NULL AND ${table.failedAt} IS NULL) OR (${table.state} = 'dispatched' AND ${table.dispatchedAt} IS NOT NULL AND ${table.uncertaintyAt} IS NOT NULL AND ${table.succeededAt} IS NULL AND ${table.failedAt} IS NULL) OR (${table.state} = 'succeeded' AND ${table.succeededAt} IS NOT NULL AND ${table.failedAt} IS NULL) OR (${table.state} IN ('failed', 'reconciliation_required') AND ${table.failedAt} IS NOT NULL AND ${table.succeededAt} IS NULL)`,
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

/**
 * Management commission allocation is configuration, not application code.
 * A row is eligible only while both it and its referenced team member are
 * active. Historical appointment commissions retain their own immutable math
 * metadata, so changing this table cannot rewrite a locked payout period.
 */
export const commissionManagementSplits = pgTable(
  "commission_management_splits",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    settingsKey: text("settings_key")
      .default("default")
      .notNull()
      .references(() => commissionSettings.key, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => teamMembers.id, { onDelete: "restrict" }),
    // These are relative allocation weights. Values may exceed 10,000 (the
    // established 12%/5% rule uses 12,000 and 5,000) and are normalized by
    // their total before the management pool is distributed.
    splitBps: integer("split_bps").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    settingsMemberUniqueIdx: uniqueIndex(
      "commission_management_splits_settings_member_unique",
    ).on(table.settingsKey, table.memberId),
    settingsEnabledIdx: index(
      "commission_management_splits_settings_enabled_idx",
    ).on(table.settingsKey, table.enabled),
    splitBpsCheck: check(
      "commission_management_splits_split_bps_check",
      sql`${table.splitBps} > 0 AND ${table.splitBps} <= 1000000`,
    ),
  }),
);

/**
 * Optional crew allocation overrides. Each enabled rule is an exact set of
 * members whose split weights are normalized inside the configured crew pool.
 * Appointments retain the resolved weights, so later configuration changes do
 * not rewrite completed work or a locked payout run.
 */
export const commissionCrewSplitRules = pgTable(
  "commission_crew_split_rules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    settingsKey: text("settings_key")
      .default("default")
      .notNull()
      .references(() => commissionSettings.key, { onDelete: "cascade" }),
    ruleKey: text("rule_key").notNull(),
    memberId: uuid("member_id")
      .notNull()
      .references(() => teamMembers.id, { onDelete: "restrict" }),
    splitBps: integer("split_bps").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    settingsRuleMemberUniqueIdx: uniqueIndex(
      "commission_crew_split_rules_settings_rule_member_unique",
    ).on(table.settingsKey, table.ruleKey, table.memberId),
    settingsEnabledIdx: index(
      "commission_crew_split_rules_settings_enabled_idx",
    ).on(table.settingsKey, table.enabled, table.ruleKey),
    ruleKeyCheck: check(
      "commission_crew_split_rules_rule_key_check",
      sql`char_length(btrim(${table.ruleKey})) BETWEEN 1 AND 120`,
    ),
    splitBpsCheck: check(
      "commission_crew_split_rules_split_bps_check",
      sql`${table.splitBps} > 0 AND ${table.splitBps} <= 1000000`,
    ),
  }),
);

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
    fixedJobRateBps: integer("fixed_job_rate_bps"),
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
    // Expand-phase uniqueness marker. Exactly one canonical row may represent
    // a timezone/period while historical duplicates remain reviewable.
    periodCanonical: boolean("period_canonical").default(false).notNull(),
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
    canonicalPeriodIdx: uniqueIndex("payout_runs_canonical_period_key")
      .on(table.timezone, table.periodStart, table.periodEnd)
      .where(sql`${table.periodCanonical} = true`),
    statusIdx: index("payout_runs_status_idx").on(table.status),
    timelineCheck: check(
      "payout_runs_status_timeline_check",
      sql`(${table.status} = 'draft' AND ${table.lockedAt} IS NULL AND ${table.paidAt} IS NULL) OR (${table.status} = 'locked' AND ${table.lockedAt} IS NOT NULL AND ${table.paidAt} IS NULL) OR (${table.status} = 'paid' AND ${table.lockedAt} IS NOT NULL AND ${table.paidAt} IS NOT NULL)`,
    ),
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
    refreshRequestedAt: timestamp("refresh_requested_at", {
      withTimezone: true,
    }),
    acceptedAppointmentId: uuid("accepted_appointment_id").references(
      () => appointments.id,
      {
        onDelete: "set null",
      },
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
    contactIdx: index("quotes_contact_idx").on(table.contactId),
    propertyIdx: index("quotes_property_idx").on(table.propertyId),
    quoteNumberIdx: index("quotes_quote_number_idx").on(table.quoteNumber),
    shareTokenIdx: uniqueIndex("quotes_share_token_key").on(table.shareToken),
    acceptedAppointmentIdx: index("quotes_accepted_appointment_idx").on(
      table.acceptedAppointmentId,
    ),
  }),
);

/**
 * Token-free replay receipts for customer actions performed through a public
 * quote capability. The bearer token remains authoritative only on `quotes`;
 * this table scopes replay by quote ID and stores hashes rather than raw
 * caller keys or capability values.
 */
export const publicQuoteMutationReceipts = pgTable(
  "public_quote_mutation_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    quoteId: uuid("quote_id")
      .notNull()
      .references(() => quotes.id, { onDelete: "restrict" }),
    action: text("action").notNull(),
    keyHash: varchar("key_hash", { length: 64 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    responseStatus: integer("response_status").notNull(),
    responseBody: jsonb("response_body")
      .$type<Record<string, unknown>>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    quoteActionKey: uniqueIndex(
      "public_quote_mutation_receipts_quote_action_key",
    ).on(table.quoteId, table.action, table.keyHash),
    expiresIdx: index("public_quote_mutation_receipts_expires_idx").on(
      table.expiresAt,
    ),
    keyHashCheck: check(
      "public_quote_mutation_receipts_key_hash_check",
      sql`${table.keyHash} ~ '^[0-9a-f]{64}$'`,
    ),
    requestHashCheck: check(
      "public_quote_mutation_receipts_request_hash_check",
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    actionCheck: check(
      "public_quote_mutation_receipts_action_check",
      sql`${table.action} IN ('decision', 'refresh', 'hold', 'book')`,
    ),
    responseStatusCheck: check(
      "public_quote_mutation_receipts_response_status_check",
      sql`${table.responseStatus} BETWEEN 200 AND 299`,
    ),
    expiryCheck: check(
      "public_quote_mutation_receipts_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
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
export const instantQuotes = pgTable(
  "instant_quotes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    propertyId: uuid("property_id").references(() => properties.id, {
      onDelete: "set null",
    }),
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
  },
  (table) => ({
    contactIdx: index("instant_quotes_contact_idx").on(table.contactId),
    propertyIdx: index("instant_quotes_property_idx").on(table.propertyId),
  }),
);

export type InstantQuote = typeof instantQuotes.$inferSelect;
export type InstantQuoteInsert = typeof instantQuotes.$inferInsert;

export const instantQuoteRelations = relations(
  instantQuotes,
  ({ one, many }) => ({
    contact: one(contacts, {
      fields: [instantQuotes.contactId],
      references: [contacts.id],
    }),
    property: one(properties, {
      fields: [instantQuotes.propertyId],
      references: [properties.id],
    }),
    media: many(instantQuoteMedia),
  }),
);

/**
 * Durable migration report for legacy quotes whose linked lead rows disagree.
 * These records must be reviewed; migration code never guesses a relationship.
 */
export const instantQuoteRelationshipBackfillAmbiguities = pgTable(
  "instant_quote_relationship_backfill_ambiguities",
  {
    instantQuoteId: uuid("instant_quote_id")
      .primaryKey()
      .references(() => instantQuotes.id, { onDelete: "cascade" }),
    leadCount: integer("lead_count").notNull(),
    contactIds: uuid("contact_ids").array().notNull(),
    propertyIds: uuid("property_ids").array().notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
);

export const instantQuoteRelationshipBackfillAmbiguityRelations = relations(
  instantQuoteRelationshipBackfillAmbiguities,
  ({ one }) => ({
    instantQuote: one(instantQuotes, {
      fields: [instantQuoteRelationshipBackfillAmbiguities.instantQuoteId],
      references: [instantQuotes.id],
    }),
  }),
);

export const mediaAssetRelations = relations(mediaAssets, ({ one, many }) => ({
  contact: one(contacts, {
    fields: [mediaAssets.contactId],
    references: [contacts.id],
  }),
  uploadedByMember: one(teamMembers, {
    fields: [mediaAssets.uploadedByMemberId],
    references: [teamMembers.id],
  }),
  sourceMessage: one(conversationMessages, {
    fields: [mediaAssets.sourceMessageId],
    references: [conversationMessages.id],
  }),
  appointments: many(appointmentMedia),
  instantQuotes: many(instantQuoteMedia),
}));

export const appointmentMediaRelations = relations(
  appointmentMedia,
  ({ one }) => ({
    appointment: one(appointments, {
      fields: [appointmentMedia.appointmentId],
      references: [appointments.id],
    }),
    mediaAsset: one(mediaAssets, {
      fields: [appointmentMedia.mediaAssetId],
      references: [mediaAssets.id],
    }),
    attachedByMember: one(teamMembers, {
      fields: [appointmentMedia.attachedByMemberId],
      references: [teamMembers.id],
    }),
  }),
);

export const instantQuoteMediaRelations = relations(
  instantQuoteMedia,
  ({ one }) => ({
    instantQuote: one(instantQuotes, {
      fields: [instantQuoteMedia.instantQuoteId],
      references: [instantQuotes.id],
    }),
    mediaAsset: one(mediaAssets, {
      fields: [instantQuoteMedia.mediaAssetId],
      references: [mediaAssets.id],
    }),
  }),
);

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
    editorialStatus: text("editorial_status").default("draft").notNull(),
    version: integer("version").default(1).notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }),
    reviewRequestedAt: timestamp("review_requested_at", {
      withTimezone: true,
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: uuid("reviewed_by").references(() => teamMembers.id, {
      onDelete: "set null",
    }),
    publishedBy: uuid("published_by").references(() => teamMembers.id, {
      onDelete: "set null",
    }),
    generationKeyHash: text("generation_key_hash"),
    lastError: text("last_error"),
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
    editorialStatusUpdatedIdx: index(
      "blog_posts_editorial_status_updated_idx",
    ).on(table.editorialStatus, table.updatedAt),
    generationKeyHashKey: uniqueIndex("blog_posts_generation_key_hash_key").on(
      table.generationKeyHash,
    ),
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
  propertyAssociations: many(contactProperties),
  leads: many(leads),
  quotes: many(quotes),
  appointments: many(appointments),
  mediaAssets: many(mediaAssets),
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
  contactAssociations: many(contactProperties),
  leads: many(leads),
  quotes: many(quotes),
  appointments: many(appointments),
}));

export const contactPropertyRelations = relations(
  contactProperties,
  ({ one }) => ({
    contact: one(contacts, {
      fields: [contactProperties.contactId],
      references: [contacts.id],
    }),
    property: one(properties, {
      fields: [contactProperties.propertyId],
      references: [properties.id],
    }),
  }),
);

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
    media: many(appointmentMedia),
    paymentAttempts: many(paymentAttempts),
    payments: many(payments),
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

/** Stable accounting categories used by Expense Tracking V2. */
export const expenseCategories = pgTable(
  "expense_categories",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    isLegacy: boolean("is_legacy").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    nameKey: uniqueIndex("expense_categories_name_key").on(table.name),
    activeSortIdx: index("expense_categories_active_sort_idx").on(
      table.isActive,
      table.sortOrder,
    ),
    idCheck: check(
      "expense_categories_id_check",
      sql`${table.id} ~ '^[a-z][a-z0-9_]{1,63}$'`,
    ),
  }),
);

/** Normalized historical and user-facing labels mapped to stable categories. */
export const expenseCategoryAliases = pgTable(
  "expense_category_aliases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    categoryId: text("category_id")
      .notNull()
      .references(() => expenseCategories.id, { onDelete: "restrict" }),
    alias: text("alias").notNull(),
    normalizedAlias: text("normalized_alias").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    normalizedAliasKey: uniqueIndex(
      "expense_category_aliases_normalized_key",
    ).on(table.normalizedAlias),
    categoryIdx: index("expense_category_aliases_category_idx").on(
      table.categoryId,
    ),
    normalizedAliasCheck: check(
      "expense_category_aliases_normalized_check",
      sql`${table.normalizedAlias} = lower(btrim(${table.normalizedAlias})) AND length(${table.normalizedAlias}) > 0`,
    ),
  }),
);

/** Stable identities for owner-verified recurring monthly overhead. */
export const expenseFixedCostSeries = pgTable(
  "expense_fixed_cost_series",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => teamMembers.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    createdIdx: index("expense_fixed_cost_series_created_idx").on(
      table.createdAt,
      table.id,
    ),
  }),
);

/**
 * Append-only, effective-dated fixed-cost facts. The latest version effective
 * on a business date is the accounting truth for that series on that date.
 */
export const expenseFixedCostVersions = pgTable(
  "expense_fixed_cost_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    seriesId: uuid("series_id")
      .notNull()
      .references(() => expenseFixedCostSeries.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    categoryId: text("category_id")
      .notNull()
      .references(() => expenseCategories.id, { onDelete: "restrict" }),
    monthlyAmountCents: integer("monthly_amount_cents").notNull(),
    effectiveStartDate: date("effective_start_date", {
      mode: "string",
    }).notNull(),
    state: text("state").$type<"active" | "ended">().notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => teamMembers.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    seriesVersionKey: uniqueIndex(
      "expense_fixed_cost_versions_series_version_key",
    ).on(table.seriesId, table.version),
    effectiveLookupIdx: index(
      "expense_fixed_cost_versions_effective_lookup_idx",
    ).on(table.seriesId, table.effectiveStartDate, table.version),
    categoryEffectiveIdx: index(
      "expense_fixed_cost_versions_category_effective_idx",
    ).on(table.categoryId, table.effectiveStartDate),
    versionCheck: check(
      "expense_fixed_cost_versions_version_check",
      sql`${table.version} >= 1`,
    ),
    nameCheck: check(
      "expense_fixed_cost_versions_name_check",
      sql`char_length(btrim(${table.name})) BETWEEN 1 AND 120`,
    ),
    amountCheck: check(
      "expense_fixed_cost_versions_amount_check",
      sql`${table.monthlyAmountCents} BETWEEN 1 AND 100000000`,
    ),
    stateCheck: check(
      "expense_fixed_cost_versions_state_check",
      sql`${table.state} IN ('active', 'ended')`,
    ),
  }),
);

/**
 * Private-object receipt intake record. Object keys are stored here while the
 * receipt bytes remain in R2; legacy data URLs continue to live on expenses
 * until their separate verified migration.
 */
export const expenseReceiptCaptures = pgTable(
  "expense_receipt_captures",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    submittedBy: uuid("submitted_by")
      .notNull()
      .references(() => teamMembers.id, { onDelete: "restrict" }),
    status: expenseReceiptCaptureStatusEnum("status")
      .default("pending_upload")
      .notNull(),
    storageProvider: text("storage_provider").default("r2").notNull(),
    originalObjectKey: text("original_object_key").notNull(),
    normalizedObjectKey: text("normalized_object_key"),
    filename: text("filename").notNull(),
    declaredContentType: text("declared_content_type").notNull(),
    verifiedContentType: text("verified_content_type"),
    byteLength: integer("byte_length"),
    sha256: varchar("sha256", { length: 64 }),
    uploadExpiresAt: timestamp("upload_expires_at", {
      withTimezone: true,
    }).notNull(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
    analysisQueuedAt: timestamp("analysis_queued_at", { withTimezone: true }),
    analysisStartedAt: timestamp("analysis_started_at", {
      withTimezone: true,
    }),
    analysisCompletedAt: timestamp("analysis_completed_at", {
      withTimezone: true,
    }),
    analysisAttemptCount: integer("analysis_attempt_count")
      .default(0)
      .notNull(),
    analysisNextAttemptAt: timestamp("analysis_next_attempt_at", {
      withTimezone: true,
    }),
    analysisModel: text("analysis_model"),
    extraction: jsonb("extraction").$type<Record<string, unknown> | null>(),
    analysisWarnings: jsonb("analysis_warnings").$type<string[] | null>(),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    exactDuplicateOfCaptureId: uuid("exact_duplicate_of_capture_id"),
    duplicateOverrideReason: text("duplicate_override_reason"),
    duplicateOverrideBy: uuid("duplicate_override_by").references(
      () => teamMembers.id,
      { onDelete: "set null" },
    ),
    duplicateOverrideAt: timestamp("duplicate_override_at", {
      withTimezone: true,
    }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    discardedAt: timestamp("discarded_at", { withTimezone: true }),
    version: integer("version").default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    objectKey: uniqueIndex("expense_receipt_captures_object_key").on(
      table.originalObjectKey,
    ),
    submitterCreatedIdx: index(
      "expense_receipt_captures_submitter_created_idx",
    ).on(table.submittedBy, table.createdAt),
    statusUpdatedIdx: index("expense_receipt_captures_status_updated_idx").on(
      table.status,
      table.updatedAt,
    ),
    hashIdx: index("expense_receipt_captures_sha256_idx").on(table.sha256),
    hashCheck: check(
      "expense_receipt_captures_sha256_check",
      sql`${table.sha256} IS NULL OR ${table.sha256} ~ '^[0-9a-f]{64}$'`,
    ),
    byteLengthCheck: check(
      "expense_receipt_captures_byte_length_check",
      sql`${table.byteLength} IS NULL OR ${table.byteLength} BETWEEN 1 AND 10485760`,
    ),
    versionCheck: check(
      "expense_receipt_captures_version_check",
      sql`${table.version} >= 1`,
    ),
    analysisAttemptCountCheck: check(
      "expense_receipt_captures_analysis_attempt_count_check",
      sql`${table.analysisAttemptCount} >= 0`,
    ),
    retryStateCheck: check(
      "expense_receipt_captures_retry_state_check",
      sql`${table.analysisNextAttemptAt} IS NULL OR (${table.status} = 'queued' AND ${table.failureCode} IS NOT NULL AND ${table.analysisStartedAt} IS NULL AND ${table.analysisCompletedAt} IS NULL)`,
    ),
  }),
);

export const expenses = pgTable(
  "expenses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    amount: integer("amount_cents").notNull(),
    currency: varchar("currency", { length: 8 }).default("USD").notNull(),
    category: text("category"),
    categoryId: text("category_id").references(() => expenseCategories.id, {
      onDelete: "restrict",
    }),
    categoryNeedsReview: boolean("category_needs_review")
      .default(false)
      .notNull(),
    vendor: text("vendor"),
    memo: text("memo"),
    method: text("method"),
    source: text("source").default("manual").notNull(),
    submittedBy: uuid("submitted_by").references(() => teamMembers.id, {
      onDelete: "set null",
    }),
    payerType: expensePayerTypeEnum("payer_type").default("company").notNull(),
    paidByMemberId: uuid("paid_by_member_id").references(() => teamMembers.id, {
      onDelete: "restrict",
    }),
    reviewStatus: expenseReviewStatusEnum("review_status")
      .default("approved")
      .notNull(),
    reviewedBy: uuid("reviewed_by").references(() => teamMembers.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }).defaultNow(),
    reviewReason: text("review_reason"),
    receiptCaptureId: uuid("receipt_capture_id").references(
      () => expenseReceiptCaptures.id,
      { onDelete: "restrict" },
    ),
    appointmentId: uuid("appointment_id").references(() => appointments.id, {
      onDelete: "set null",
    }),
    paidAt: timestamp("paid_at", { withTimezone: true }).defaultNow().notNull(),
    coverageStartAt: timestamp("coverage_start_at", { withTimezone: true }),
    coverageEndAt: timestamp("coverage_end_at", { withTimezone: true }),
    coveredByFixedCostSeriesId: uuid(
      "covered_by_fixed_cost_series_id",
    ).references(() => expenseFixedCostSeries.id, { onDelete: "restrict" }),
    receiptFilename: text("receipt_filename"),
    receiptUrl: text("receipt_url"),
    receiptContentType: text("receipt_content_type"),
    bankTransactionId: uuid("bank_transaction_id").references(
      () => plaidTransactions.id,
      { onDelete: "set null" },
    ),
    payoutRunId: uuid("payout_run_id").references(() => payoutRuns.id, {
      onDelete: "restrict",
    }),
    lifecycleStatus: expenseLifecycleStatusEnum("lifecycle_status")
      .default("posted")
      .notNull(),
    version: integer("version").default(1).notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true }).defaultNow(),
    postedBy: uuid("posted_by"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by"),
    voidReason: text("void_reason"),
    correctedAt: timestamp("corrected_at", { withTimezone: true }),
    correctedBy: uuid("corrected_by"),
    correctionReason: text("correction_reason"),
    // Self-referential foreign keys are installed by migration 0072. Keeping
    // these as UUID columns here avoids a circular table initializer while the
    // database still enforces every relationship.
    reversalOfExpenseId: uuid("reversal_of_expense_id"),
    correctionOfExpenseId: uuid("correction_of_expense_id"),
    correctedByExpenseId: uuid("corrected_by_expense_id"),
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
    payoutRunIdx: uniqueIndex("expenses_payout_run_key").on(table.payoutRunId),
    paidAtIdx: index("expenses_paid_at_idx").on(table.paidAt),
    lifecycleStatusIdx: index("expenses_lifecycle_status_idx").on(
      table.lifecycleStatus,
    ),
    categoryIdIdx: index("expenses_category_id_idx").on(table.categoryId),
    submitterPaidAtIdx: index("expenses_submitter_paid_at_idx").on(
      table.submittedBy,
      table.paidAt,
    ),
    reviewStatusCreatedIdx: index("expenses_review_status_created_idx").on(
      table.reviewStatus,
      table.createdAt,
    ),
    paidByMemberIdx: index("expenses_paid_by_member_idx").on(
      table.paidByMemberId,
    ),
    receiptCaptureKey: uniqueIndex("expenses_receipt_capture_key").on(
      table.receiptCaptureId,
    ),
    appointmentIdx: index("expenses_appointment_idx").on(table.appointmentId),
    fixedCostCoverageIdx: index("expenses_covered_by_fixed_cost_series_idx").on(
      table.coveredByFixedCostSeriesId,
      table.paidAt,
    ),
    reversalOfIdx: uniqueIndex("expenses_reversal_of_key").on(
      table.reversalOfExpenseId,
    ),
    correctionOfIdx: uniqueIndex("expenses_correction_of_key").on(
      table.correctionOfExpenseId,
    ),
    correctedByIdx: uniqueIndex("expenses_corrected_by_key").on(
      table.correctedByExpenseId,
    ),
    payoutRunSourceCheck: check(
      "expenses_payout_run_source_check",
      sql`${table.payoutRunId} IS NULL OR ${table.source} = 'payout_run'`,
    ),
    versionCheck: check("expenses_version_check", sql`${table.version} >= 1`),
    currencyCheck: check(
      "expenses_currency_check",
      sql`${table.currency} = 'USD'`,
    ),
    coverageCheck: check(
      "expenses_coverage_check",
      sql`${table.coverageStartAt} IS NULL OR ${table.coverageEndAt} IS NULL OR ${table.coverageEndAt} >= ${table.coverageStartAt}`,
    ),
    amountDirectionCheck: check(
      "expenses_amount_direction_check",
      sql`(${table.reversalOfExpenseId} IS NULL AND ${table.amount} > 0) OR (${table.reversalOfExpenseId} IS NOT NULL AND ${table.amount} < 0)`,
    ),
    payerShapeCheck: check(
      "expenses_payer_shape_check",
      sql`(${table.payerType} = 'company' AND ${table.paidByMemberId} IS NULL) OR (${table.payerType} = 'personal' AND ${table.paidByMemberId} IS NOT NULL)`,
    ),
    reviewShapeCheck: check(
      "expenses_review_shape_check",
      sql`(${table.reviewStatus} IN ('draft', 'pending') AND ${table.reviewedAt} IS NULL AND ${table.reviewedBy} IS NULL) OR (${table.reviewStatus} IN ('approved', 'rejected') AND ${table.reviewedAt} IS NOT NULL)`,
    ),
    reviewLifecycleCheck: check(
      "expenses_review_lifecycle_check",
      sql`${table.lifecycleStatus} = 'draft' OR ${table.reviewStatus} = 'approved'`,
    ),
    fixedCostCoverageShapeCheck: check(
      "expenses_fixed_cost_coverage_shape_check",
      sql`${table.coveredByFixedCostSeriesId} IS NULL OR (${table.reviewStatus} = 'approved' AND ${table.reversalOfExpenseId} IS NULL AND ${table.amount} > 0)`,
    ),
    lifecycleTimelineCheck: check(
      "expenses_lifecycle_timeline_check",
      sql`(${table.lifecycleStatus} = 'draft' AND ${table.postedAt} IS NULL AND ${table.postedBy} IS NULL AND ${table.voidedAt} IS NULL AND ${table.voidedBy} IS NULL AND ${table.voidReason} IS NULL AND ${table.correctedAt} IS NULL AND ${table.correctedBy} IS NULL AND ${table.correctionReason} IS NULL AND ${table.correctedByExpenseId} IS NULL AND ((${table.reversalOfExpenseId} IS NULL AND ${table.correctionOfExpenseId} IS NULL) OR ${table.source} = 'manual_correction')) OR (${table.lifecycleStatus} = 'posted' AND ${table.postedAt} IS NOT NULL AND ${table.voidedAt} IS NULL AND ${table.voidedBy} IS NULL AND ${table.voidReason} IS NULL AND ${table.correctedAt} IS NULL AND ${table.correctedBy} IS NULL AND ${table.correctionReason} IS NULL AND ${table.correctedByExpenseId} IS NULL) OR (${table.lifecycleStatus} = 'voided' AND ${table.postedAt} IS NOT NULL AND ${table.voidedAt} IS NOT NULL AND ${table.voidReason} IS NOT NULL AND ${table.correctedAt} IS NULL AND ${table.correctedBy} IS NULL AND ${table.correctionReason} IS NULL AND ${table.reversalOfExpenseId} IS NULL AND ${table.correctedByExpenseId} IS NULL) OR (${table.lifecycleStatus} = 'corrected' AND ${table.postedAt} IS NOT NULL AND ${table.voidedAt} IS NULL AND ${table.voidedBy} IS NULL AND ${table.voidReason} IS NULL AND ${table.correctedAt} IS NOT NULL AND ${table.correctionReason} IS NOT NULL AND ${table.reversalOfExpenseId} IS NULL AND ${table.correctedByExpenseId} IS NOT NULL)`,
    ),
  }),
);

/** Signed category allocations; the deferred database constraint keeps totals exact. */
export const expenseAllocations = pgTable(
  "expense_allocations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    expenseId: uuid("expense_id")
      .notNull()
      .references(() => expenses.id, { onDelete: "restrict" }),
    categoryId: text("category_id")
      .notNull()
      .references(() => expenseCategories.id, { onDelete: "restrict" }),
    amountCents: integer("amount_cents").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    expenseCategoryKey: uniqueIndex(
      "expense_allocations_expense_category_key",
    ).on(table.expenseId, table.categoryId),
    categoryExpenseIdx: index("expense_allocations_category_expense_idx").on(
      table.categoryId,
      table.expenseId,
    ),
    amountCheck: check(
      "expense_allocations_amount_check",
      sql`${table.amountCents} <> 0`,
    ),
  }),
);

/** Aggregated approval feedback used for deterministic vendor/category learning. */
export const expenseVendorCategoryRules = pgTable(
  "expense_vendor_category_rules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    normalizedVendor: text("normalized_vendor").notNull(),
    categoryId: text("category_id")
      .notNull()
      .references(() => expenseCategories.id, { onDelete: "restrict" }),
    confirmationCount: integer("confirmation_count").default(0).notNull(),
    disagreementCount: integer("disagreement_count").default(0).notNull(),
    ownerLocked: boolean("owner_locked").default(false).notNull(),
    lockedBy: uuid("locked_by").references(() => teamMembers.id, {
      onDelete: "set null",
    }),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    vendorCategoryKey: uniqueIndex(
      "expense_vendor_category_rules_vendor_category_key",
    ).on(table.normalizedVendor, table.categoryId),
    vendorIdx: index("expense_vendor_category_rules_vendor_idx").on(
      table.normalizedVendor,
    ),
    ownerLockKey: uniqueIndex("expense_vendor_category_rules_owner_lock_key")
      .on(table.normalizedVendor)
      .where(sql`${table.ownerLocked} = true`),
    countsCheck: check(
      "expense_vendor_category_rules_counts_check",
      sql`${table.confirmationCount} >= 0 AND ${table.disagreementCount} >= 0`,
    ),
    lockShapeCheck: check(
      "expense_vendor_category_rules_lock_shape_check",
      sql`(${table.ownerLocked} = false AND ${table.lockedAt} IS NULL) OR (${table.ownerLocked} = true AND ${table.lockedAt} IS NOT NULL)`,
    ),
  }),
);

/** Manual accounting truth for daily Meta and Google advertising spend. */
export const dailyAdSpend = pgTable(
  "daily_ad_spend",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    platform: dailyAdPlatformEnum("platform").notNull(),
    businessDate: date("business_date", { mode: "string" }).notNull(),
    amountCents: integer("amount_cents").notNull(),
    currentExpenseId: uuid("current_expense_id").references(() => expenses.id, {
      onDelete: "restrict",
    }),
    enteredBy: uuid("entered_by")
      .notNull()
      .references(() => teamMembers.id, { onDelete: "restrict" }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    platformDateKey: uniqueIndex("daily_ad_spend_platform_date_key").on(
      table.platform,
      table.businessDate,
    ),
    dateIdx: index("daily_ad_spend_date_idx").on(table.businessDate),
    expenseKey: uniqueIndex("daily_ad_spend_current_expense_key").on(
      table.currentExpenseId,
    ),
    amountCheck: check(
      "daily_ad_spend_amount_check",
      sql`${table.amountCents} >= 0`,
    ),
    pointerCheck: check(
      "daily_ad_spend_pointer_check",
      sql`(${table.amountCents} = 0 AND ${table.currentExpenseId} IS NULL) OR (${table.amountCents} > 0 AND ${table.currentExpenseId} IS NOT NULL)`,
    ),
    versionCheck: check(
      "daily_ad_spend_version_check",
      sql`${table.version} >= 1`,
    ),
  }),
);

/**
 * Reimbursement workflow state for an existing personal-paid expense. The
 * payout adjustment points back to this same expense and never creates a
 * second ledger expense.
 */
export const expenseReimbursementClaims = pgTable(
  "expense_reimbursement_claims",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    expenseId: uuid("expense_id")
      .notNull()
      .references(() => expenses.id, { onDelete: "restrict" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => teamMembers.id, { onDelete: "restrict" }),
    amountCents: integer("amount_cents").notNull(),
    status: expenseReimbursementStatusEnum("status")
      .default("pending")
      .notNull(),
    reviewedBy: uuid("reviewed_by").references(() => teamMembers.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewReason: text("review_reason"),
    payoutRunId: uuid("payout_run_id").references(() => payoutRuns.id, {
      onDelete: "restrict",
    }),
    payoutAdjustmentId: uuid("payout_adjustment_id").references(
      () => payoutRunAdjustments.id,
      { onDelete: "restrict" },
    ),
    attachedAt: timestamp("attached_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    version: integer("version").default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    expenseKey: uniqueIndex("expense_reimbursement_claims_expense_key").on(
      table.expenseId,
    ),
    adjustmentKey: uniqueIndex(
      "expense_reimbursement_claims_adjustment_key",
    ).on(table.payoutAdjustmentId),
    memberStatusIdx: index("expense_reimbursement_claims_member_status_idx").on(
      table.memberId,
      table.status,
    ),
    statusCreatedIdx: index(
      "expense_reimbursement_claims_status_created_idx",
    ).on(table.status, table.createdAt),
    amountCheck: check(
      "expense_reimbursement_claims_amount_check",
      sql`${table.amountCents} > 0`,
    ),
    versionCheck: check(
      "expense_reimbursement_claims_version_check",
      sql`${table.version} >= 1`,
    ),
    attachmentShapeCheck: check(
      "expense_reimbursement_claims_attachment_shape_check",
      sql`(${table.status} IN ('pending', 'approved', 'rejected') AND ${table.payoutRunId} IS NULL AND ${table.payoutAdjustmentId} IS NULL AND ${table.attachedAt} IS NULL AND ${table.paidAt} IS NULL) OR (${table.status} = 'attached' AND ${table.payoutRunId} IS NOT NULL AND ${table.payoutAdjustmentId} IS NOT NULL AND ${table.attachedAt} IS NOT NULL AND ${table.paidAt} IS NULL) OR (${table.status} = 'paid' AND ${table.payoutRunId} IS NOT NULL AND ${table.payoutAdjustmentId} IS NOT NULL AND ${table.attachedAt} IS NOT NULL AND ${table.paidAt} IS NOT NULL)`,
    ),
    reviewShapeCheck: check(
      "expense_reimbursement_claims_review_shape_check",
      sql`(${table.status} = 'pending' AND ${table.reviewedAt} IS NULL AND ${table.reviewedBy} IS NULL AND ${table.reviewReason} IS NULL) OR (${table.status} IN ('approved', 'attached', 'paid') AND ${table.reviewedAt} IS NOT NULL) OR (${table.status} = 'rejected' AND ${table.reviewedAt} IS NOT NULL AND nullif(btrim(${table.reviewReason}), '') IS NOT NULL)`,
    ),
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

export const expenseRelations = relations(expenses, ({ one, many }) => ({
  bankTransaction: one(plaidTransactions, {
    fields: [expenses.bankTransactionId],
    references: [plaidTransactions.id],
  }),
  payoutRun: one(payoutRuns, {
    fields: [expenses.payoutRunId],
    references: [payoutRuns.id],
  }),
  categoryRecord: one(expenseCategories, {
    fields: [expenses.categoryId],
    references: [expenseCategories.id],
  }),
  receiptCapture: one(expenseReceiptCaptures, {
    fields: [expenses.receiptCaptureId],
    references: [expenseReceiptCaptures.id],
  }),
  appointment: one(appointments, {
    fields: [expenses.appointmentId],
    references: [appointments.id],
  }),
  allocations: many(expenseAllocations),
  reimbursementClaims: many(expenseReimbursementClaims),
}));

export const expenseAllocationRelations = relations(
  expenseAllocations,
  ({ one }) => ({
    expense: one(expenses, {
      fields: [expenseAllocations.expenseId],
      references: [expenses.id],
    }),
    category: one(expenseCategories, {
      fields: [expenseAllocations.categoryId],
      references: [expenseCategories.id],
    }),
  }),
);

// Provider-neutral payment attempts and ledger.
export const paymentAttempts = pgTable(
  "payment_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => appointments.id, { onDelete: "cascade" }),
    provider: text("provider").default("square").notNull(),
    clientRequestId: text("client_request_id").notNull(),
    status: text("status").default("created").notNull(),
    requestedJobAmountCents: integer("requested_job_amount_cents").notNull(),
    currency: varchar("currency", { length: 10 }).default("USD").notNull(),
    providerOrderId: text("provider_order_id"),
    providerPaymentId: text("provider_payment_id"),
    squareLocationId: text("square_location_id"),
    initiatedByMemberId: uuid("initiated_by_member_id").references(
      () => teamMembers.id,
      { onDelete: "set null" },
    ),
    returnNonceHash: text("return_nonce_hash"),
    returnStateExpiresAt: timestamp("return_state_expires_at", {
      withTimezone: true,
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    clientRequestIdx: uniqueIndex("payment_attempts_client_request_key").on(
      table.clientRequestId,
    ),
    appointmentIdx: index("payment_attempts_appointment_idx").on(
      table.appointmentId,
      table.createdAt,
    ),
    statusIdx: index("payment_attempts_status_idx").on(
      table.status,
      table.createdAt,
    ),
    expiresIdx: index("payment_attempts_expires_idx").on(table.expiresAt),
    providerOrderIdx: index("payment_attempts_provider_order_idx").on(
      table.provider,
      table.providerOrderId,
    ),
    providerPaymentIdx: index("payment_attempts_provider_payment_idx").on(
      table.provider,
      table.providerPaymentId,
    ),
    activeSquareAttemptIdx: uniqueIndex(
      "payment_attempts_active_square_appointment_key",
    )
      .on(table.appointmentId)
      .where(
        sql`${table.provider} = 'square' AND ${table.status} IN ('created', 'launched', 'pending_verification')`,
      ),
  }),
);

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    stripeChargeId: text("stripe_charge_id"),
    provider: text("provider").default("stripe").notNull(),
    providerPaymentId: text("provider_payment_id"),
    providerOrderId: text("provider_order_id"),
    paymentAttemptId: uuid("payment_attempt_id").references(
      () => paymentAttempts.id,
      { onDelete: "set null" },
    ),
    amount: integer("amount").notNull(), // cents
    jobAmountCents: integer("job_amount_cents"),
    tipCents: integer("tip_cents").default(0).notNull(),
    totalAmountCents: integer("total_amount_cents"),
    refundedAmountCents: integer("refunded_amount_cents").default(0).notNull(),
    currency: varchar("currency", { length: 10 }).notNull(),
    status: text("status").notNull(),
    canonicalStatus: text("canonical_status"),
    providerStatus: text("provider_status"),
    method: text("method"),
    tenderType: text("tender_type"),
    entryMethod: text("entry_method"),
    cardBrand: text("card_brand"),
    last4: varchar("last4", { length: 4 }),
    receiptUrl: text("receipt_url"),
    squareLocationId: text("square_location_id"),
    initiatedByMemberId: uuid("initiated_by_member_id").references(
      () => teamMembers.id,
      { onDelete: "set null" },
    ),
    legacySource: text("legacy_source"),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    appointmentId: uuid("appointment_id").references(() => appointments.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    providerCreatedAt: timestamp("provider_created_at", {
      withTimezone: true,
    }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    capturedAt: timestamp("captured_at", { withTimezone: true }),
  },
  (table) => ({
    stripeIdx: uniqueIndex("payments_charge_idx").on(table.stripeChargeId),
    providerPaymentIdx: uniqueIndex("payments_provider_payment_key").on(
      table.provider,
      table.providerPaymentId,
    ),
    paymentAttemptIdx: uniqueIndex("payments_payment_attempt_key").on(
      table.paymentAttemptId,
    ),
    appointmentIdx: index("payments_appointment_idx").on(table.appointmentId),
    canonicalStatusIdx: index("payments_canonical_status_idx").on(
      table.canonicalStatus,
      table.createdAt,
    ),
    providerOrderIdx: index("payments_provider_order_idx").on(
      table.provider,
      table.providerOrderId,
    ),
    paidAtIdx: index("payments_paid_at_idx").on(table.paidAt),
  }),
);

export const paymentRefunds = pgTable(
  "payment_refunds",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerRefundId: text("provider_refund_id"),
    amountCents: integer("amount_cents").notNull(),
    jobAmountCents: integer("job_amount_cents").default(0).notNull(),
    tipCents: integer("tip_cents").default(0).notNull(),
    currency: varchar("currency", { length: 10 }).default("USD").notNull(),
    canonicalStatus: text("canonical_status").notNull(),
    providerStatus: text("provider_status"),
    reason: text("reason"),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    providerCreatedAt: timestamp("provider_created_at", {
      withTimezone: true,
    }),
    refundedAt: timestamp("refunded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    providerRefundIdx: uniqueIndex("payment_refunds_provider_refund_key").on(
      table.provider,
      table.providerRefundId,
    ),
    paymentIdx: index("payment_refunds_payment_idx").on(
      table.paymentId,
      table.createdAt,
    ),
    statusIdx: index("payment_refunds_status_idx").on(
      table.canonicalStatus,
      table.createdAt,
    ),
  }),
);

export const paymentProviderEvents = pgTable(
  "payment_provider_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    eventType: text("event_type").notNull(),
    processingStatus: text("processing_status").default("received").notNull(),
    paymentId: uuid("payment_id").references(() => payments.id, {
      onDelete: "set null",
    }),
    paymentAttemptId: uuid("payment_attempt_id").references(
      () => paymentAttempts.id,
      { onDelete: "set null" },
    ),
    payload: jsonb("payload").$type<Record<string, unknown> | null>(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    error: text("error"),
  },
  (table) => ({
    providerEventIdx: uniqueIndex(
      "payment_provider_events_provider_event_key",
    ).on(table.provider, table.providerEventId),
    statusIdx: index("payment_provider_events_status_idx").on(
      table.processingStatus,
      table.receivedAt,
    ),
    paymentIdx: index("payment_provider_events_payment_idx").on(
      table.paymentId,
    ),
    attemptIdx: index("payment_provider_events_attempt_idx").on(
      table.paymentAttemptId,
    ),
  }),
);

export const paymentAttemptRelations = relations(
  paymentAttempts,
  ({ one, many }) => ({
    appointment: one(appointments, {
      fields: [paymentAttempts.appointmentId],
      references: [appointments.id],
    }),
    initiatedByMember: one(teamMembers, {
      fields: [paymentAttempts.initiatedByMemberId],
      references: [teamMembers.id],
    }),
    payments: many(payments),
    providerEvents: many(paymentProviderEvents),
  }),
);

export const paymentRelations = relations(payments, ({ one, many }) => ({
  appointment: one(appointments, {
    fields: [payments.appointmentId],
    references: [appointments.id],
  }),
  paymentAttempt: one(paymentAttempts, {
    fields: [payments.paymentAttemptId],
    references: [paymentAttempts.id],
  }),
  initiatedByMember: one(teamMembers, {
    fields: [payments.initiatedByMemberId],
    references: [teamMembers.id],
  }),
  refunds: many(paymentRefunds),
  providerEvents: many(paymentProviderEvents),
}));

export const paymentRefundRelations = relations(paymentRefunds, ({ one }) => ({
  payment: one(payments, {
    fields: [paymentRefunds.paymentId],
    references: [payments.id],
  }),
}));

export const paymentProviderEventRelations = relations(
  paymentProviderEvents,
  ({ one }) => ({
    payment: one(payments, {
      fields: [paymentProviderEvents.paymentId],
      references: [payments.id],
    }),
    paymentAttempt: one(paymentAttempts, {
      fields: [paymentProviderEvents.paymentAttemptId],
      references: [paymentAttempts.id],
    }),
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
