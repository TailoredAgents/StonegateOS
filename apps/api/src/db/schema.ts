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
  bigint,
  integer,
  doublePrecision,
  customType,
  check,
  date,
  foreignKey,
  primaryKey,
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
export type AppointmentResourceAssignmentSnapshot = Readonly<{
  resourceId: string;
  kind: "crew" | "truck" | "equipment";
  label: string;
  capacityUnits: number;
}>;
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
    // Compatibility anchor for the contact-owned V1 portal. The migration
    // owns this FK because contacts is declared after partnerAccounts.
    portalContactId: uuid("portal_contact_id"),
    portalAccessEnabled: boolean("portal_access_enabled")
      .default(false)
      .notNull(),
    portalLifecycleStatus: text("portal_lifecycle_status")
      .$type<"active" | "suspended" | "closed" | "merged">()
      .default("active")
      .notNull(),
    portalLifecycleRevision: integer("portal_lifecycle_revision")
      .default(1)
      .notNull(),
    portalLifecycleChangedAt: timestamp("portal_lifecycle_changed_at", {
      withTimezone: true,
    }),
    // Migration 0156 owns this FK because teamMembers is declared below.
    portalLifecycleChangedByTeamMemberId: uuid(
      "portal_lifecycle_changed_by_team_member_id",
    ),
    portalLifecycleReason: varchar("portal_lifecycle_reason", { length: 1000 }),
    portalLifecyclePriorAccessEnabled: boolean(
      "portal_lifecycle_prior_access_enabled",
    ),
    // Migration 0156 owns the self-referencing account FK.
    mergedIntoPartnerAccountId: uuid("merged_into_partner_account_id"),
    // Partner-managed account profile. These fields belong to the canonical
    // tenant and never derive authority from a CRM contact.
    profileRevision: integer("profile_revision").default(1).notNull(),
    serviceContactName: varchar("service_contact_name", { length: 160 }),
    serviceContactEmail: varchar("service_contact_email", { length: 254 }),
    serviceContactPhoneE164: varchar("service_contact_phone_e164", {
      length: 16,
    }),
    billingContactName: varchar("billing_contact_name", { length: 160 }),
    billingContactEmail: varchar("billing_contact_email", { length: 254 }),
    billingContactPhoneE164: varchar("billing_contact_phone_e164", {
      length: 16,
    }),
    billingAddressLine1: varchar("billing_address_line1", { length: 200 }),
    billingAddressLine2: varchar("billing_address_line2", { length: 200 }),
    billingAddressCity: varchar("billing_address_city", { length: 120 }),
    billingAddressState: varchar("billing_address_state", { length: 64 }),
    billingAddressPostalCode: varchar("billing_address_postal_code", {
      length: 20,
    }),
    billingAddressCountry: varchar("billing_address_country", { length: 2 }),
    defaultPoNumber: varchar("default_po_number", { length: 80 }),
    costCenterGuidance: varchar("cost_center_guidance", { length: 500 }),
    // Migration 0154 owns the deferrable composite FK because locations are
    // declared later in this module.
    defaultPartnerLocationId: uuid("default_partner_location_id"),
    locationDirectoryVersion: integer("location_directory_version")
      .default(1)
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
    statusIdx: index("partner_accounts_status_idx").on(table.status),
    ownerIdx: index("partner_accounts_owner_idx").on(table.ownerMemberId),
    nextTouchIdx: index("partner_accounts_next_touch_idx").on(
      table.nextTouchAt,
    ),
    domainIdx: index("partner_accounts_domain_idx").on(table.domain),
    normalizedNameIdx: index("partner_accounts_normalized_name_idx").on(
      table.normalizedName,
    ),
    portalContactKey: uniqueIndex("partner_accounts_portal_contact_key")
      .on(table.portalContactId)
      .where(sql`${table.portalContactId} IS NOT NULL`),
    portalAccessIdx: index("partner_accounts_portal_access_idx").on(
      table.portalAccessEnabled,
      table.status,
    ),
    portalLifecycleIdx: index("partner_accounts_portal_lifecycle_idx").on(
      table.portalLifecycleStatus,
      table.updatedAt,
      table.id,
    ),
    mergeTargetIdx: index("partner_accounts_merge_target_idx")
      .on(table.mergedIntoPartnerAccountId)
      .where(sql`${table.mergedIntoPartnerAccountId} IS NOT NULL`),
    defaultLocationIdx: index("partner_accounts_default_location_idx")
      .on(table.defaultPartnerLocationId)
      .where(sql`${table.defaultPartnerLocationId} IS NOT NULL`),
    locationDirectoryVersionCheck: check(
      "partner_accounts_location_directory_version_check",
      sql`${table.locationDirectoryVersion} > 0`,
    ),
    profileRevisionCheck: check(
      "partner_accounts_profile_revision_check",
      sql`${table.profileRevision} > 0`,
    ),
    portalLifecycleStatusCheck: check(
      "partner_accounts_portal_lifecycle_status_check",
      sql`${table.portalLifecycleStatus} IN ('active', 'suspended', 'closed', 'merged')`,
    ),
    portalLifecycleRevisionCheck: check(
      "partner_accounts_portal_lifecycle_revision_check",
      sql`${table.portalLifecycleRevision} > 0`,
    ),
    portalLifecycleEvidenceCheck: check(
      "partner_accounts_portal_lifecycle_evidence_check",
      sql`${table.portalLifecycleStatus} = 'active' OR (${table.portalLifecycleChangedAt} IS NOT NULL AND ${table.portalLifecycleChangedByTeamMemberId} IS NOT NULL AND length(btrim(${table.portalLifecycleReason})) BETWEEN 20 AND 1000)`,
    ),
    portalLifecycleAccessCheck: check(
      "partner_accounts_portal_lifecycle_access_check",
      sql`${table.portalLifecycleStatus} = 'active' OR (${table.portalAccessEnabled} IS false AND ${table.portalLifecyclePriorAccessEnabled} IS NOT NULL)`,
    ),
    mergeShapeCheck: check(
      "partner_accounts_merge_shape_check",
      sql`(${table.portalLifecycleStatus} = 'merged') = (${table.mergedIntoPartnerAccountId} IS NOT NULL) AND ${table.mergedIntoPartnerAccountId} IS DISTINCT FROM ${table.id}`,
    ),
    serviceContactShapeCheck: check(
      "partner_accounts_service_contact_shape_check",
      sql`(
        ${table.serviceContactName} IS NULL
        AND ${table.serviceContactEmail} IS NULL
        AND ${table.serviceContactPhoneE164} IS NULL
      ) OR (
        ${table.serviceContactName} IS NOT NULL
        AND ${table.serviceContactEmail} IS NOT NULL
        AND length(btrim(${table.serviceContactName})) BETWEEN 1 AND 160
        AND ${table.serviceContactEmail} = lower(btrim(${table.serviceContactEmail}))
        AND length(${table.serviceContactEmail}) BETWEEN 3 AND 254
        AND ${table.serviceContactEmail} !~ '[[:space:]]'
        AND ${table.serviceContactEmail} LIKE '%@%'
        AND (${table.serviceContactPhoneE164} IS NULL OR ${table.serviceContactPhoneE164} ~ '^\\+[1-9][0-9]{7,14}$')
      )`,
    ),
    billingContactShapeCheck: check(
      "partner_accounts_billing_contact_shape_check",
      sql`(
        ${table.billingContactName} IS NULL
        AND ${table.billingContactEmail} IS NULL
        AND ${table.billingContactPhoneE164} IS NULL
      ) OR (
        ${table.billingContactName} IS NOT NULL
        AND ${table.billingContactEmail} IS NOT NULL
        AND length(btrim(${table.billingContactName})) BETWEEN 1 AND 160
        AND ${table.billingContactEmail} = lower(btrim(${table.billingContactEmail}))
        AND length(${table.billingContactEmail}) BETWEEN 3 AND 254
        AND ${table.billingContactEmail} !~ '[[:space:]]'
        AND ${table.billingContactEmail} LIKE '%@%'
        AND (${table.billingContactPhoneE164} IS NULL OR ${table.billingContactPhoneE164} ~ '^\\+[1-9][0-9]{7,14}$')
      )`,
    ),
    billingAddressShapeCheck: check(
      "partner_accounts_billing_address_shape_check",
      sql`(
        ${table.billingAddressLine1} IS NULL
        AND ${table.billingAddressLine2} IS NULL
        AND ${table.billingAddressCity} IS NULL
        AND ${table.billingAddressState} IS NULL
        AND ${table.billingAddressPostalCode} IS NULL
        AND ${table.billingAddressCountry} IS NULL
      ) OR (
        ${table.billingAddressLine1} IS NOT NULL
        AND ${table.billingAddressCity} IS NOT NULL
        AND ${table.billingAddressState} IS NOT NULL
        AND ${table.billingAddressPostalCode} IS NOT NULL
        AND ${table.billingAddressCountry} IS NOT NULL
        AND length(btrim(${table.billingAddressLine1})) BETWEEN 1 AND 200
        AND (${table.billingAddressLine2} IS NULL OR length(btrim(${table.billingAddressLine2})) BETWEEN 1 AND 200)
        AND length(btrim(${table.billingAddressCity})) BETWEEN 1 AND 120
        AND length(btrim(${table.billingAddressState})) BETWEEN 1 AND 64
        AND length(btrim(${table.billingAddressPostalCode})) BETWEEN 1 AND 20
        AND ${table.billingAddressCountry} ~ '^[A-Z]{2}$'
      )`,
    ),
    defaultPoNumberCheck: check(
      "partner_accounts_default_po_number_check",
      sql`${table.defaultPoNumber} IS NULL OR length(btrim(${table.defaultPoNumber})) BETWEEN 1 AND 80`,
    ),
    costCenterGuidanceCheck: check(
      "partner_accounts_cost_center_guidance_check",
      sql`${table.costCenterGuidance} IS NULL OR length(btrim(${table.costCenterGuidance})) BETWEEN 1 AND 500`,
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
    // Installed as a nullable FK by Quote V2 after `sales_opportunities` exists.
    salesOpportunityId: uuid("sales_opportunity_id"),
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
    salesOpportunityIdx: index("crm_tasks_sales_opportunity_idx").on(
      table.salesOpportunityId,
    ),
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
    // Installed as a nullable FK by Quote V2 after `sales_opportunities` exists.
    salesOpportunityId: uuid("sales_opportunity_id"),
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
    salesOpportunityIdx: index("leads_sales_opportunity_idx").on(
      table.salesOpportunityId,
    ),
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
    mfaRequired: boolean("mfa_required").default(false).notNull(),
    mfaEnrolledAt: timestamp("mfa_enrolled_at", { withTimezone: true }),
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

export const partnerAccountDomains = pgTable(
  "partner_account_domains",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "cascade" }),
    normalizedDomain: varchar("normalized_domain", { length: 253 }).notNull(),
    status: text("status")
      .$type<"pending" | "verified" | "revoked">()
      .default("pending")
      .notNull(),
    verificationMethod: text("verification_method"),
    verificationEvidence: text("verification_evidence"),
    verifiedByTeamMemberId: uuid("verified_by_team_member_id").references(
      () => teamMembers.id,
      { onDelete: "restrict" },
    ),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    revokedByTeamMemberId: uuid("revoked_by_team_member_id").references(
      () => teamMembers.id,
      { onDelete: "restrict" },
    ),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    accountDomainKey: uniqueIndex(
      "partner_account_domains_account_domain_key",
    ).on(table.partnerAccountId, table.normalizedDomain),
    domainStatusIdx: index("partner_account_domains_domain_status_idx").on(
      table.normalizedDomain,
      table.status,
      table.partnerAccountId,
    ),
    domainCheck: check(
      "partner_account_domains_domain_check",
      sql`${table.normalizedDomain} = lower(btrim(${table.normalizedDomain})) AND length(${table.normalizedDomain}) BETWEEN 3 AND 253 AND ${table.normalizedDomain} ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'`,
    ),
    statusCheck: check(
      "partner_account_domains_status_check",
      sql`${table.status} IN ('pending', 'verified', 'revoked')`,
    ),
    lifecycleCheck: check(
      "partner_account_domains_lifecycle_check",
      sql`(${table.status} = 'pending' AND ${table.verifiedAt} IS NULL AND ${table.verifiedByTeamMemberId} IS NULL AND ${table.revokedAt} IS NULL AND ${table.revokedByTeamMemberId} IS NULL) OR (${table.status} = 'verified' AND ${table.verifiedAt} IS NOT NULL AND ${table.verifiedByTeamMemberId} IS NOT NULL AND ${table.verificationMethod} IS NOT NULL AND ${table.verificationEvidence} IS NOT NULL AND ${table.revokedAt} IS NULL AND ${table.revokedByTeamMemberId} IS NULL) OR (${table.status} = 'revoked' AND ${table.revokedAt} IS NOT NULL AND ${table.revokedByTeamMemberId} IS NOT NULL)`,
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
    assuranceLevel: text("assurance_level")
      .$type<"aal1" | "aal2">()
      .default("aal1")
      .notNull(),
    mfaVerifiedAt: timestamp("mfa_verified_at", { withTimezone: true }),
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
    assuranceLevelCheck: check(
      "team_sessions_assurance_level_check",
      sql`${table.assuranceLevel} IN ('aal1', 'aal2')`,
    ),
    assuranceStateCheck: check(
      "team_sessions_assurance_state_check",
      sql`(${table.assuranceLevel} = 'aal1' AND ${table.mfaVerifiedAt} IS NULL) OR (${table.assuranceLevel} = 'aal2' AND ${table.mfaVerifiedAt} IS NOT NULL AND ${table.authMethod} = 'team_session')`,
    ),
  }),
);

/** Team MFA is deliberately stored separately from partner MFA identities. */
export const teamMfaMethods = pgTable(
  "team_mfa_methods",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    teamMemberId: uuid("team_member_id")
      .notNull()
      .references(() => teamMembers.id, { onDelete: "cascade" }),
    methodType: text("method_type").$type<"totp">().notNull(),
    label: text("label"),
    totpSecretCiphertext: text("totp_secret_ciphertext").notNull(),
    totpSecretKeyVersion: integer("totp_secret_key_version").notNull(),
    lastTotpCounter: integer("last_totp_counter"),
    enabled: boolean("enabled").default(true).notNull(),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    memberIdx: index("team_mfa_methods_member_idx").on(
      table.teamMemberId,
      table.enabled,
    ),
    oneActiveTotpKey: uniqueIndex("team_mfa_methods_active_totp_key")
      .on(table.teamMemberId)
      .where(sql`${table.methodType} = 'totp' AND ${table.enabled} = true`),
    methodTypeCheck: check(
      "team_mfa_methods_type_check",
      sql`${table.methodType} = 'totp'`,
    ),
    enabledStateCheck: check(
      "team_mfa_methods_enabled_state_check",
      sql`(${table.enabled} = true AND ${table.disabledAt} IS NULL) OR (${table.enabled} = false AND ${table.disabledAt} IS NOT NULL)`,
    ),
    keyVersionCheck: check(
      "team_mfa_methods_key_version_check",
      sql`${table.totpSecretKeyVersion} > 0`,
    ),
    lastTotpCounterCheck: check(
      "team_mfa_methods_last_counter_check",
      sql`${table.lastTotpCounter} IS NULL OR ${table.lastTotpCounter} >= 0`,
    ),
  }),
);

export const teamMfaEnrollmentChallenges = pgTable(
  "team_mfa_enrollment_challenges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    teamMemberId: uuid("team_member_id")
      .notNull()
      .references(() => teamMembers.id, { onDelete: "cascade" }),
    secretCiphertext: text("secret_ciphertext").notNull(),
    secretKeyVersion: integer("secret_key_version").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    activeMemberKey: uniqueIndex("team_mfa_enrollment_active_member_key")
      .on(table.teamMemberId)
      .where(sql`${table.consumedAt} IS NULL`),
    expiryIdx: index("team_mfa_enrollment_expiry_idx").on(
      table.expiresAt,
      table.consumedAt,
    ),
    keyVersionCheck: check(
      "team_mfa_enrollment_key_version_check",
      sql`${table.secretKeyVersion} > 0`,
    ),
    attemptCountCheck: check(
      "team_mfa_enrollment_attempt_count_check",
      sql`${table.attemptCount} BETWEEN 0 AND 8`,
    ),
  }),
);

export const teamMfaRecoveryCodes = pgTable(
  "team_mfa_recovery_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    methodId: uuid("method_id")
      .notNull()
      .references(() => teamMfaMethods.id, { onDelete: "cascade" }),
    codeHash: varchar("code_hash", { length: 64 }).notNull(),
    keyVersion: integer("key_version").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    methodCodeKey: uniqueIndex("team_mfa_recovery_method_code_key").on(
      table.methodId,
      table.codeHash,
    ),
    unusedIdx: index("team_mfa_recovery_unused_idx").on(
      table.methodId,
      table.usedAt,
    ),
    codeHashCheck: check(
      "team_mfa_recovery_code_hash_check",
      sql`${table.codeHash} ~ '^[0-9a-f]{64}$'`,
    ),
    keyVersionCheck: check(
      "team_mfa_recovery_key_version_check",
      sql`${table.keyVersion} > 0`,
    ),
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
      sql`${table.authMethod} IS NULL OR ${table.authMethod} IN ('team_session', 'break_glass', 'partner_session', 'partner_pre_auth', 'magic_link', 'password', 'mfa_step_up', 'verified_email_session', 'service')`,
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
    // Installed as a nullable FK by Quote V2 after `sales_opportunities` exists.
    salesOpportunityId: uuid("sales_opportunity_id"),
    leadId: uuid("lead_id").references(() => leads.id, {
      onDelete: "set null",
    }),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    propertyId: uuid("property_id").references(() => properties.id, {
      onDelete: "set null",
    }),
    partnerAccountId: uuid("partner_account_id").references(
      () => partnerAccounts.id,
      { onDelete: "restrict" },
    ),
    partnerBookingId: uuid("partner_booking_id"),
    staffScope: text("staff_scope")
      .$type<"general" | "partner_billing">()
      .default("general")
      .notNull(),
    portalVisible: boolean("portal_visible").default(false).notNull(),
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
    partnerAccountIdKey: uniqueIndex(
      "conversation_threads_partner_account_id_key",
    ).on(table.partnerAccountId, table.id),
    salesOpportunityIdx: index("conversation_threads_sales_opportunity_idx").on(
      table.salesOpportunityId,
    ),
    leadIdx: index("conversation_threads_lead_idx").on(table.leadId),
    contactIdx: index("conversation_threads_contact_idx").on(table.contactId),
    statusIdx: index("conversation_threads_status_idx").on(table.status),
    stateIdx: index("conversation_threads_state_idx").on(table.state),
    lastMessageIdx: index("conversation_threads_last_message_idx").on(
      table.lastMessageAt,
    ),
    partnerAccountIdx: index("conversation_threads_partner_account_idx").on(
      table.partnerAccountId,
      table.portalVisible,
      table.lastMessageAt,
    ),
    portalJobThreadKey: uniqueIndex(
      "conversation_threads_portal_job_thread_key",
    )
      .on(table.partnerAccountId, table.partnerBookingId)
      .where(
        sql`${table.partnerAccountId} IS NOT NULL AND ${table.partnerBookingId} IS NOT NULL AND ${table.portalVisible} = true`,
      ),
    staffScopeCheck: check(
      "conversation_threads_staff_scope_check",
      sql`${table.staffScope} IN ('general', 'partner_billing')`,
    ),
    billingScopeBindingCheck: check(
      "conversation_threads_billing_scope_binding_check",
      sql`${table.staffScope} <> 'partner_billing' OR (${table.partnerAccountId} IS NOT NULL AND ${table.partnerBookingId} IS NULL AND ${table.portalVisible} IS true)`,
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
    partnerMembershipId: uuid("partner_membership_id"),
    externalAddress: text("external_address"),
    displayName: text("display_name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    threadIdx: index("conversation_participants_thread_idx").on(table.threadId),
    partnerMembershipIdx: index(
      "conversation_participants_partner_membership_idx",
    ).on(table.partnerMembershipId),
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
    portalVisible: boolean("portal_visible").default(false).notNull(),
    authorType: text("author_type").default("staff").notNull(),
    idempotencyKeyHash: varchar("idempotency_key_hash", { length: 64 }),
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
    portalHistoryIdx: index("conversation_messages_portal_history_idx").on(
      table.threadId,
      table.portalVisible,
      table.createdAt,
      table.id,
    ),
    idempotencyKey: uniqueIndex("conversation_messages_idempotency_key")
      .on(table.threadId, table.idempotencyKeyHash)
      .where(sql`${table.idempotencyKeyHash} IS NOT NULL`),
    authorTypeCheck: check(
      "conversation_messages_author_type_check",
      sql`${table.authorType} IN ('partner', 'staff', 'system', 'provider')`,
    ),
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
    orgContactId: uuid("org_contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    email: text("email").notNull(),
    // Authentication uses the canonical normalized address. The original
    // email remains the user-facing value during the legacy cutover.
    normalizedEmail: text("normalized_email"),
    phone: text("phone"),
    phoneE164: text("phone_e164"),
    name: text("name").notNull(),
    active: boolean("active").default(true).notNull(),
    identityStatus: text("identity_status")
      .$type<
        | "pending_activation"
        | "active"
        | "suspended"
        | "disabled"
        | "quarantined"
      >()
      .default("active")
      .notNull(),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    passwordHash: text("password_hash"),
    passwordHashVersion: integer("password_hash_version").default(1).notNull(),
    passwordSetAt: timestamp("password_set_at", { withTimezone: true }),
    mfaRequired: boolean("mfa_required").default(false).notNull(),
    mfaEnrolledAt: timestamp("mfa_enrolled_at", { withTimezone: true }),
    // Incrementing this value invalidates every session created under an
    // earlier password/MFA/security posture without exposing session hashes.
    securityVersion: integer("security_version").default(1).notNull(),
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
    normalizedEmailIdx: uniqueIndex("partner_users_normalized_email_key")
      .on(table.normalizedEmail)
      .where(sql`${table.normalizedEmail} IS NOT NULL`),
    phoneE164Idx: uniqueIndex("partner_users_phone_e164_key").on(
      table.phoneE164,
    ),
    orgContactIdx: index("partner_users_org_contact_idx").on(
      table.orgContactId,
    ),
    securityVersionCheck: check(
      "partner_users_security_version_check",
      sql`${table.securityVersion} > 0`,
    ),
    normalizedEmailCheck: check(
      "partner_users_normalized_email_check",
      sql`${table.normalizedEmail} IS NULL OR (${table.normalizedEmail} = lower(btrim(${table.normalizedEmail})) AND length(${table.normalizedEmail}) BETWEEN 3 AND 254 AND ${table.normalizedEmail} !~ '[[:space:]]' AND ${table.normalizedEmail} LIKE '%@%')`,
    ),
    identityStatusCheck: check(
      "partner_users_identity_status_check",
      sql`${table.identityStatus} IN ('pending_activation', 'active', 'suspended', 'disabled', 'quarantined')`,
    ),
    passwordHashVersionCheck: check(
      "partner_users_password_hash_version_check",
      sql`${table.passwordHashVersion} > 0`,
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

export type PartnerMfaMethodType = "totp" | "webauthn";

/**
 * Non-secret metadata for a partner MFA authenticator. Secret material and
 * WebAuthn private data never belong in this table; credentialReference is an
 * opaque pointer to the configured secret/credential provider.
 */
export const partnerMfaMethods = pgTable(
  "partner_mfa_methods",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerUserId: uuid("partner_user_id")
      .notNull()
      .references(() => partnerUsers.id, { onDelete: "cascade" }),
    methodType: text("method_type").$type<PartnerMfaMethodType>().notNull(),
    label: text("label"),
    credentialIdHash: varchar("credential_id_hash", { length: 64 }),
    credentialReference: text("credential_reference"),
    totpSecretCiphertext: text("totp_secret_ciphertext"),
    totpSecretKeyVersion: integer("totp_secret_key_version"),
    lastTotpCounter: integer("last_totp_counter"),
    enabled: boolean("enabled").default(true).notNull(),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    userIdx: index("partner_mfa_methods_user_idx").on(
      table.partnerUserId,
      table.enabled,
    ),
    credentialKey: uniqueIndex("partner_mfa_methods_credential_hash_key")
      .on(table.credentialIdHash)
      .where(sql`${table.credentialIdHash} IS NOT NULL`),
    methodTypeCheck: check(
      "partner_mfa_methods_type_check",
      sql`${table.methodType} IN ('totp', 'webauthn')`,
    ),
    credentialHashCheck: check(
      "partner_mfa_methods_credential_hash_check",
      sql`${table.credentialIdHash} IS NULL OR ${table.credentialIdHash} ~ '^[0-9a-f]{64}$'`,
    ),
    enabledStateCheck: check(
      "partner_mfa_methods_enabled_state_check",
      sql`(${table.enabled} = true AND ${table.disabledAt} IS NULL) OR (${table.enabled} = false AND ${table.disabledAt} IS NOT NULL)`,
    ),
    totpSecretPairCheck: check(
      "partner_mfa_methods_totp_secret_pair_check",
      sql`(${table.totpSecretCiphertext} IS NULL) = (${table.totpSecretKeyVersion} IS NULL)`,
    ),
    totpKeyVersionCheck: check(
      "partner_mfa_methods_totp_key_version_check",
      sql`${table.totpSecretKeyVersion} IS NULL OR ${table.totpSecretKeyVersion} > 0`,
    ),
    lastTotpCounterCheck: check(
      "partner_mfa_methods_last_totp_counter_check",
      sql`${table.lastTotpCounter} IS NULL OR ${table.lastTotpCounter} >= 0`,
    ),
  }),
);

/** Short-lived encrypted TOTP bootstrap material awaiting user confirmation. */
export const partnerMfaEnrollmentChallenges = pgTable(
  "partner_mfa_enrollment_challenges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerUserId: uuid("partner_user_id")
      .notNull()
      .references(() => partnerUsers.id, { onDelete: "cascade" }),
    // Migration 0141 owns this FK because partnerAuthTransactions is declared
    // after the MFA tables. A value here makes activation bootstrap material
    // usable only by the exact one-use pre-authentication transaction that
    // created it.
    authTransactionId: uuid("auth_transaction_id"),
    secretCiphertext: text("secret_ciphertext").notNull(),
    secretKeyVersion: integer("secret_key_version").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    activeUserKey: uniqueIndex("partner_mfa_enrollment_active_user_key")
      .on(table.partnerUserId)
      .where(sql`${table.consumedAt} IS NULL`),
    authTransactionKey: uniqueIndex(
      "partner_mfa_enrollment_auth_transaction_key",
    )
      .on(table.authTransactionId)
      .where(sql`${table.authTransactionId} IS NOT NULL`),
    expiryIdx: index("partner_mfa_enrollment_expiry_idx").on(
      table.expiresAt,
      table.consumedAt,
    ),
    keyVersionCheck: check(
      "partner_mfa_enrollment_key_version_check",
      sql`${table.secretKeyVersion} > 0`,
    ),
    attemptCountCheck: check(
      "partner_mfa_enrollment_attempt_count_check",
      sql`${table.attemptCount} BETWEEN 0 AND 8`,
    ),
  }),
);

/** Keyed, single-use recovery-code digests. Plaintext is never persisted. */
export const partnerMfaRecoveryCodes = pgTable(
  "partner_mfa_recovery_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    methodId: uuid("method_id")
      .notNull()
      .references(() => partnerMfaMethods.id, { onDelete: "cascade" }),
    codeHash: varchar("code_hash", { length: 64 }).notNull(),
    keyVersion: integer("key_version").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    methodCodeKey: uniqueIndex("partner_mfa_recovery_method_code_key").on(
      table.methodId,
      table.codeHash,
    ),
    unusedIdx: index("partner_mfa_recovery_unused_idx").on(
      table.methodId,
      table.usedAt,
    ),
    codeHashCheck: check(
      "partner_mfa_recovery_code_hash_check",
      sql`${table.codeHash} ~ '^[0-9a-f]{64}$'`,
    ),
    keyVersionCheck: check(
      "partner_mfa_recovery_key_version_check",
      sql`${table.keyVersion} > 0`,
    ),
  }),
);

export type PartnerCapabilityRisk = "standard" | "sensitive" | "financial";

/** Stable capability registry used by role templates and policy tooling. */
export const partnerCapabilityDefinitions = pgTable(
  "partner_capability_definitions",
  {
    key: text("key").primaryKey(),
    label: text("label").notNull(),
    description: text("description").notNull(),
    category: text("category").notNull(),
    risk: text("risk")
      .$type<PartnerCapabilityRisk>()
      .default("standard")
      .notNull(),
    assignable: boolean("assignable").default(true).notNull(),
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
    categoryIdx: index("partner_capability_definitions_category_idx").on(
      table.category,
      table.active,
    ),
    keyCheck: check(
      "partner_capability_definitions_key_check",
      sql`${table.key} ~ '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$'`,
    ),
    riskCheck: check(
      "partner_capability_definitions_risk_check",
      sql`${table.risk} IN ('standard', 'sensitive', 'financial')`,
    ),
  }),
);

/**
 * Global system roles have partnerAccountId = null. Accounts may add their
 * own templates without changing the stable capability catalog.
 */
export const partnerRoleTemplates = pgTable(
  "partner_role_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id").references(
      () => partnerAccounts.id,
      { onDelete: "cascade" },
    ),
    key: varchar("key", { length: 64 }).notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    capabilities: text("capabilities").array().notNull().default([]),
    isSystem: boolean("is_system").default(false).notNull(),
    active: boolean("active").default(true).notNull(),
    version: integer("version").default(1).notNull(),
    createdByPartnerUserId: uuid("created_by_partner_user_id").references(
      () => partnerUsers.id,
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
    globalKey: uniqueIndex("partner_role_templates_global_key")
      .on(table.key)
      .where(sql`${table.partnerAccountId} IS NULL`),
    accountKey: uniqueIndex("partner_role_templates_account_key")
      .on(table.partnerAccountId, table.key)
      .where(sql`${table.partnerAccountId} IS NOT NULL`),
    accountIdx: index("partner_role_templates_account_idx").on(
      table.partnerAccountId,
      table.active,
    ),
    keyCheck: check(
      "partner_role_templates_key_check",
      sql`${table.key} ~ '^[a-z][a-z0-9_]{1,63}$'`,
    ),
    versionCheck: check(
      "partner_role_templates_version_check",
      sql`${table.version} > 0`,
    ),
  }),
);

export type PartnerAccountMembershipStatus =
  | "invited"
  | "active"
  | "suspended"
  | "removed";
export type PartnerPersona =
  | "contractor"
  | "real_estate_agent"
  | "property_manager"
  | "commercial_client"
  | "other";
export type PartnerMembershipAccessLevel = "account" | "scoped";
export type PartnerMembershipAccessScope = {
  propertyIds?: string[];
  locationIds?: string[];
  costCenterIds?: string[];
};
export type PartnerMembershipPreferences = {
  timezone?: string | null;
  locale?: string | null;
  defaultPropertyId?: string | null;
  notificationChannels?: Array<"email" | "sms" | "in_portal">;
  onboardingChecklist?: {
    version: 1;
    completedSteps?: Array<
      | "first_location"
      | "communication_preferences"
      | "proof_defaults"
      | "billing_details"
      | "teammates"
    >;
    dismissedAt?: string | null;
  };
};

export const partnerAccountMemberships = pgTable(
  "partner_account_memberships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "restrict" }),
    partnerUserId: uuid("partner_user_id")
      .notNull()
      .references(() => partnerUsers.id, { onDelete: "cascade" }),
    roleTemplateId: uuid("role_template_id").references(
      () => partnerRoleTemplates.id,
      { onDelete: "set null" },
    ),
    roleKey: varchar("role_key", { length: 64 }).notNull(),
    status: text("status")
      .$type<PartnerAccountMembershipStatus>()
      .default("invited")
      .notNull(),
    capabilityGrants: text("capability_grants").array().notNull().default([]),
    capabilityDenies: text("capability_denies").array().notNull().default([]),
    persona: varchar("persona", { length: 64 })
      .$type<PartnerPersona>()
      .default("other")
      .notNull(),
    accessLevel: text("access_level")
      .$type<PartnerMembershipAccessLevel>()
      .default("account")
      .notNull(),
    accessScope: jsonb("access_scope")
      .$type<PartnerMembershipAccessScope>()
      .notNull()
      .default({}),
    preferences: jsonb("preferences")
      .$type<PartnerMembershipPreferences>()
      .notNull()
      .default({}),
    isDefault: boolean("is_default").default(false).notNull(),
    invitedByPartnerUserId: uuid("invited_by_partner_user_id").references(
      () => partnerUsers.id,
      { onDelete: "set null" },
    ),
    invitedAt: timestamp("invited_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    migrationReviewStatus: text("migration_review_status")
      .$type<"not_required" | "pending" | "approved" | "quarantined">()
      .default("not_required")
      .notNull(),
    migrationLegacyRoleKey: varchar("migration_legacy_role_key", {
      length: 64,
    }),
    migrationReviewedByTeamMemberId: uuid(
      "migration_reviewed_by_team_member_id",
    ).references(() => teamMembers.id, { onDelete: "set null" }),
    migrationReviewedAt: timestamp("migration_reviewed_at", {
      withTimezone: true,
    }),
    migrationReviewNote: text("migration_review_note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    idAccountKey: uniqueIndex("partner_account_memberships_id_account_key").on(
      table.id,
      table.partnerAccountId,
    ),
    idAccountUserKey: uniqueIndex(
      "partner_account_memberships_id_account_user_key",
    ).on(table.id, table.partnerAccountId, table.partnerUserId),
    accountUserKey: uniqueIndex(
      "partner_account_memberships_account_user_key",
    ).on(table.partnerAccountId, table.partnerUserId),
    defaultUserKey: uniqueIndex("partner_account_memberships_default_user_key")
      .on(table.partnerUserId)
      .where(sql`${table.isDefault} = true AND ${table.status} = 'active'`),
    accountStatusIdx: index(
      "partner_account_memberships_account_status_idx",
    ).on(table.partnerAccountId, table.status, table.createdAt),
    userStatusIdx: index("partner_account_memberships_user_status_idx").on(
      table.partnerUserId,
      table.status,
      table.isDefault,
    ),
    statusCheck: check(
      "partner_account_memberships_status_check",
      sql`${table.status} IN ('invited', 'active', 'suspended', 'removed')`,
    ),
    roleKeyCheck: check(
      "partner_account_memberships_role_key_check",
      sql`${table.roleKey} ~ '^[a-z][a-z0-9_]{1,63}$'`,
    ),
    personaCheck: check(
      "partner_account_memberships_persona_check",
      sql`${table.persona} IN ('contractor', 'real_estate_agent', 'property_manager', 'commercial_client', 'other')`,
    ),
    accessLevelCheck: check(
      "partner_account_memberships_access_level_check",
      sql`${table.accessLevel} IN ('account', 'scoped')`,
    ),
    overrideConflictCheck: check(
      "partner_account_memberships_override_conflict_check",
      sql`NOT (${table.capabilityGrants} && ${table.capabilityDenies})`,
    ),
    lifecycleCheck: check(
      "partner_account_memberships_lifecycle_check",
      sql`(
        ${table.status} = 'invited'
        AND ${table.acceptedAt} IS NULL
        AND ${table.suspendedAt} IS NULL
        AND ${table.removedAt} IS NULL
      ) OR (
        ${table.status} = 'active'
        AND ${table.acceptedAt} IS NOT NULL
        AND ${table.suspendedAt} IS NULL
        AND ${table.removedAt} IS NULL
      ) OR (
        ${table.status} = 'suspended'
        AND ${table.acceptedAt} IS NOT NULL
        AND ${table.suspendedAt} IS NOT NULL
        AND ${table.removedAt} IS NULL
      ) OR (
        ${table.status} = 'removed'
        AND ${table.removedAt} IS NOT NULL
      )`,
    ),
    migrationReviewCheck: check(
      "partner_account_memberships_migration_review_check",
      sql`${table.migrationReviewStatus} IN ('not_required', 'pending', 'approved', 'quarantined')`,
    ),
    migrationReviewEvidenceCheck: check(
      "partner_account_memberships_migration_review_evidence_check",
      sql`(${table.migrationReviewStatus} = 'approved' AND ${table.migrationReviewedAt} IS NOT NULL AND ${table.migrationReviewedByTeamMemberId} IS NOT NULL) OR (${table.migrationReviewStatus} <> 'approved')`,
    ),
  }),
);

export type PartnerAccountInvitationStatus =
  | "pending"
  | "accepted"
  | "revoked"
  | "expired";
export type PartnerAccountInvitationDeliveryStatus =
  | "queued"
  | "dispatching"
  | "accepted"
  | "failed"
  | "reconciliation_required";

/**
 * Account-bound invitation credential. Only a digest is stored here; the raw
 * token exists solely inside the short-lived delivery URL queued to outbox.
 * Migration 0119 owns the composite account FKs and outbox FK.
 */
export const partnerAccountInvitations = pgTable(
  "partner_account_invitations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "restrict" }),
    email: text("email").notNull(),
    normalizedEmail: text("normalized_email").notNull(),
    inviteeName: text("invitee_name").notNull(),
    roleTemplateId: uuid("role_template_id")
      .notNull()
      .references(() => partnerRoleTemplates.id, { onDelete: "restrict" }),
    roleTemplateVersion: integer("role_template_version").notNull(),
    roleKey: varchar("role_key", { length: 64 }).notNull(),
    accessLevel: text("access_level")
      .$type<"account" | "scoped">()
      .default("account")
      .notNull(),
    persona: varchar("persona", { length: 64 })
      .$type<PartnerPersona>()
      .default("other")
      .notNull(),
    status: text("status")
      .$type<PartnerAccountInvitationStatus>()
      .default("pending")
      .notNull(),
    tokenHash: varchar("token_hash", { length: 64 }),
    generation: integer("generation").default(1).notNull(),
    version: integer("version").default(1).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    invitedByMembershipId: uuid("invited_by_membership_id").notNull(),
    acceptedByPartnerUserId: uuid("accepted_by_partner_user_id").references(
      () => partnerUsers.id,
      { onDelete: "restrict" },
    ),
    acceptedMembershipId: uuid("accepted_membership_id"),
    revokedByMembershipId: uuid("revoked_by_membership_id"),
    deliveryStatus: text("delivery_status")
      .$type<PartnerAccountInvitationDeliveryStatus>()
      .default("queued")
      .notNull(),
    deliveryOutboxEventId: uuid("delivery_outbox_event_id"),
    deliveryAttemptId: uuid("delivery_attempt_id"),
    deliveryProvider: text("delivery_provider"),
    deliveryProviderMessageId: text("delivery_provider_message_id"),
    deliveryDetail: text("delivery_detail"),
    dispatchStartedAt: timestamp("dispatch_started_at", {
      withTimezone: true,
    }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    pendingEmailKey: uniqueIndex(
      "partner_account_invitations_pending_email_key",
    )
      .on(table.partnerAccountId, table.normalizedEmail)
      .where(sql`${table.status} = 'pending'`),
    accountInvitationKey: uniqueIndex(
      "partner_account_invitations_account_invitation_key",
    ).on(table.partnerAccountId, table.id),
    tokenHashKey: uniqueIndex("partner_account_invitations_token_hash_key")
      .on(table.tokenHash)
      .where(sql`${table.tokenHash} IS NOT NULL`),
    deliveryOutboxKey: uniqueIndex(
      "partner_account_invitations_delivery_outbox_key",
    )
      .on(table.deliveryOutboxEventId)
      .where(sql`${table.deliveryOutboxEventId} IS NOT NULL`),
    accountStatusIdx: index(
      "partner_account_invitations_account_status_idx",
    ).on(table.partnerAccountId, table.status, table.createdAt, table.id),
    expiryIdx: index("partner_account_invitations_expiry_idx")
      .on(table.expiresAt)
      .where(sql`${table.status} = 'pending'`),
    emailCheck: check(
      "partner_account_invitations_email_check",
      sql`${table.normalizedEmail} = lower(btrim(${table.normalizedEmail})) AND ${table.email} = ${table.normalizedEmail} AND length(${table.normalizedEmail}) BETWEEN 3 AND 254 AND ${table.normalizedEmail} !~ '[[:space:]]' AND ${table.normalizedEmail} LIKE '%@%'`,
    ),
    nameCheck: check(
      "partner_account_invitations_name_check",
      sql`length(btrim(${table.inviteeName})) BETWEEN 2 AND 120`,
    ),
    roleKeyCheck: check(
      "partner_account_invitations_role_key_check",
      sql`${table.roleKey} ~ '^[a-z][a-z0-9_]{1,63}$'`,
    ),
    accessLevelCheck: check(
      "partner_account_invitations_access_level_check",
      sql`${table.accessLevel} IN ('account', 'scoped')`,
    ),
    administratorScopeCheck: check(
      "partner_account_invitations_administrator_scope_check",
      sql`${table.roleKey} <> 'administrator' OR ${table.accessLevel} = 'account'`,
    ),
    personaCheck: check(
      "partner_account_invitations_persona_check",
      sql`${table.persona} IN ('contractor', 'real_estate_agent', 'property_manager', 'commercial_client', 'other')`,
    ),
    statusCheck: check(
      "partner_account_invitations_status_check",
      sql`${table.status} IN ('pending', 'accepted', 'revoked', 'expired')`,
    ),
    tokenHashCheck: check(
      "partner_account_invitations_token_hash_check",
      sql`${table.tokenHash} IS NULL OR ${table.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
    generationCheck: check(
      "partner_account_invitations_generation_check",
      sql`${table.generation} > 0`,
    ),
    versionCheck: check(
      "partner_account_invitations_version_check",
      sql`${table.version} > 0`,
    ),
    roleVersionCheck: check(
      "partner_account_invitations_role_version_check",
      sql`${table.roleTemplateVersion} > 0`,
    ),
    deliveryStatusCheck: check(
      "partner_account_invitations_delivery_status_check",
      sql`${table.deliveryStatus} IN ('queued', 'dispatching', 'accepted', 'failed', 'reconciliation_required')`,
    ),
    lifecycleCheck: check(
      "partner_account_invitations_lifecycle_check",
      sql`(
        ${table.status} = 'pending'
        AND ${table.tokenHash} IS NOT NULL
        AND ${table.acceptedByPartnerUserId} IS NULL
        AND ${table.acceptedMembershipId} IS NULL
        AND ${table.acceptedAt} IS NULL
        AND ${table.revokedAt} IS NULL
        AND ${table.expiredAt} IS NULL
      ) OR (
        ${table.status} = 'accepted'
        AND ${table.tokenHash} IS NULL
        AND ${table.acceptedByPartnerUserId} IS NOT NULL
        AND ${table.acceptedMembershipId} IS NOT NULL
        AND ${table.acceptedAt} IS NOT NULL
        AND ${table.revokedAt} IS NULL
        AND ${table.expiredAt} IS NULL
      ) OR (
        ${table.status} = 'revoked'
        AND ${table.tokenHash} IS NULL
        AND ${table.acceptedByPartnerUserId} IS NULL
        AND ${table.acceptedMembershipId} IS NULL
        AND ${table.acceptedAt} IS NULL
        AND ${table.revokedAt} IS NOT NULL
        AND ${table.expiredAt} IS NULL
      ) OR (
        ${table.status} = 'expired'
        AND ${table.tokenHash} IS NULL
        AND ${table.acceptedByPartnerUserId} IS NULL
        AND ${table.acceptedMembershipId} IS NULL
        AND ${table.acceptedAt} IS NULL
        AND ${table.revokedAt} IS NULL
        AND ${table.expiredAt} IS NOT NULL
      )`,
    ),
  }),
);

export type PartnerAuthChallengePurpose =
  | "email_verification"
  | "account_activation"
  | "password_reset"
  | "email_change";
export type PartnerAuthChallengeStatus =
  | "pending"
  | "consumed"
  | "revoked"
  | "expired";
export type PartnerAuthChallengeDeliveryStatus =
  | "queued"
  | "dispatching"
  | "accepted"
  | "failed"
  | "reconciliation_required";

/**
 * Purpose-bound mailbox credentials. A purpose-specific handler must match
 * both purpose and subject before consuming a digest, so these credentials
 * can never be exchanged by the legacy routine-login path.
 */
export const partnerAuthChallenges = pgTable(
  "partner_auth_challenges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    purpose: text("purpose").$type<PartnerAuthChallengePurpose>().notNull(),
    status: text("status")
      .$type<PartnerAuthChallengeStatus>()
      .default("pending")
      .notNull(),
    normalizedEmail: text("normalized_email").notNull(),
    tokenHash: varchar("token_hash", { length: 64 }),
    generation: integer("generation").default(1).notNull(),
    partnerUserId: uuid("partner_user_id").references(() => partnerUsers.id, {
      onDelete: "cascade",
    }),
    partnerAccountId: uuid("partner_account_id").references(
      () => partnerAccounts.id,
      { onDelete: "restrict" },
    ),
    partnerMembershipId: uuid("partner_membership_id").references(
      () => partnerAccountMemberships.id,
      { onDelete: "cascade" },
    ),
    // Migration 0131 owns this FK because applications are declared below.
    applicationId: uuid("application_id"),
    securityVersionSnapshot: integer("security_version_snapshot"),
    requestedIp: text("requested_ip"),
    requestedUserAgent: text("requested_user_agent"),
    consumedIp: text("consumed_ip"),
    consumedUserAgent: text("consumed_user_agent"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
    deliveryStatus: text("delivery_status")
      .$type<PartnerAuthChallengeDeliveryStatus>()
      .default("queued")
      .notNull(),
    deliveryOutboxEventId: uuid("delivery_outbox_event_id"),
    deliveryAttemptId: uuid("delivery_attempt_id"),
    deliveryProvider: text("delivery_provider"),
    deliveryProviderMessageId: text("delivery_provider_message_id"),
    deliveryDetail: text("delivery_detail"),
    dispatchStartedAt: timestamp("dispatch_started_at", {
      withTimezone: true,
    }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    tokenHashKey: uniqueIndex("partner_auth_challenges_token_hash_key")
      .on(table.tokenHash)
      .where(sql`${table.tokenHash} IS NOT NULL`),
    activeMailboxPurposeEmailKey: uniqueIndex(
      "partner_auth_challenges_active_mailbox_purpose_email_key",
    )
      .on(table.purpose, table.normalizedEmail)
      .where(
        sql`${table.status} = 'pending' AND ${table.purpose} <> 'account_activation'`,
      ),
    activeActivationMembershipKey: uniqueIndex(
      "partner_auth_challenges_active_activation_membership_key",
    )
      .on(table.purpose, table.partnerAccountId, table.partnerMembershipId)
      .where(
        sql`${table.status} = 'pending' AND ${table.purpose} = 'account_activation'`,
      ),
    activeEmailChangeUserKey: uniqueIndex(
      "partner_auth_challenges_active_email_change_user_key",
    )
      .on(table.partnerUserId)
      .where(
        sql`${table.status} = 'pending' AND ${table.purpose} = 'email_change'`,
      ),
    subjectIdx: index("partner_auth_challenges_subject_idx").on(
      table.partnerUserId,
      table.purpose,
      table.status,
    ),
    expiryIdx: index("partner_auth_challenges_expiry_idx").on(
      table.status,
      table.expiresAt,
    ),
    purposeCheck: check(
      "partner_auth_challenges_purpose_check",
      sql`${table.purpose} IN ('email_verification', 'account_activation', 'password_reset', 'email_change')`,
    ),
    subjectCheck: check(
      "partner_auth_challenges_subject_check",
      sql`(
        ${table.purpose} = 'email_verification'
        AND ${table.partnerUserId} IS NULL
        AND ${table.partnerAccountId} IS NULL
        AND ${table.partnerMembershipId} IS NULL
        AND ${table.securityVersionSnapshot} IS NULL
      ) OR (
        ${table.purpose} = 'account_activation'
        AND ${table.partnerUserId} IS NOT NULL
        AND ${table.partnerAccountId} IS NOT NULL
        AND ${table.partnerMembershipId} IS NOT NULL
        AND ${table.securityVersionSnapshot} IS NOT NULL
      ) OR (
        ${table.purpose} = 'password_reset'
        AND ${table.partnerUserId} IS NOT NULL
        AND ${table.partnerAccountId} IS NULL
        AND ${table.partnerMembershipId} IS NULL
        AND ${table.applicationId} IS NULL
        AND ${table.securityVersionSnapshot} IS NOT NULL
      ) OR (
        ${table.purpose} = 'email_change'
        AND ${table.partnerUserId} IS NOT NULL
        AND ${table.partnerAccountId} IS NOT NULL
        AND ${table.partnerMembershipId} IS NOT NULL
        AND ${table.applicationId} IS NULL
        AND ${table.securityVersionSnapshot} IS NOT NULL
      )`,
    ),
    accountMembershipPairCheck: check(
      "partner_auth_challenges_account_membership_pair_check",
      sql`(${table.partnerAccountId} IS NULL) = (${table.partnerMembershipId} IS NULL)`,
    ),
    membershipAccountFk: foreignKey({
      name: "partner_auth_challenges_membership_account_fk",
      columns: [table.partnerMembershipId, table.partnerAccountId],
      foreignColumns: [
        partnerAccountMemberships.id,
        partnerAccountMemberships.partnerAccountId,
      ],
    }).onDelete("cascade"),
    statusCheck: check(
      "partner_auth_challenges_status_check",
      sql`${table.status} IN ('pending', 'consumed', 'revoked', 'expired')`,
    ),
    emailCheck: check(
      "partner_auth_challenges_email_check",
      sql`${table.normalizedEmail} = lower(btrim(${table.normalizedEmail})) AND length(${table.normalizedEmail}) BETWEEN 3 AND 254 AND ${table.normalizedEmail} !~ '[[:space:]]' AND ${table.normalizedEmail} LIKE '%@%'`,
    ),
    tokenHashCheck: check(
      "partner_auth_challenges_token_hash_check",
      sql`${table.tokenHash} IS NULL OR ${table.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
    generationCheck: check(
      "partner_auth_challenges_generation_check",
      sql`${table.generation} > 0`,
    ),
    securityVersionCheck: check(
      "partner_auth_challenges_security_version_check",
      sql`${table.securityVersionSnapshot} IS NULL OR ${table.securityVersionSnapshot} > 0`,
    ),
    deliveryStatusCheck: check(
      "partner_auth_challenges_delivery_status_check",
      sql`${table.deliveryStatus} IN ('queued', 'dispatching', 'accepted', 'failed', 'reconciliation_required')`,
    ),
    lifecycleCheck: check(
      "partner_auth_challenges_lifecycle_check",
      sql`(
        ${table.status} = 'pending'
        AND ${table.tokenHash} IS NOT NULL
        AND ${table.consumedAt} IS NULL
        AND ${table.revokedAt} IS NULL
        AND ${table.expiredAt} IS NULL
      ) OR (
        ${table.status} = 'consumed'
        AND ${table.tokenHash} IS NULL
        AND ${table.consumedAt} IS NOT NULL
        AND ${table.revokedAt} IS NULL
        AND ${table.expiredAt} IS NULL
      ) OR (
        ${table.status} = 'revoked'
        AND ${table.tokenHash} IS NULL
        AND ${table.consumedAt} IS NULL
        AND ${table.revokedAt} IS NOT NULL
        AND ${table.expiredAt} IS NULL
      ) OR (
        ${table.status} = 'expired'
        AND ${table.tokenHash} IS NULL
        AND ${table.consumedAt} IS NULL
        AND ${table.revokedAt} IS NULL
        AND ${table.expiredAt} IS NOT NULL
      )`,
    ),
  }),
);

/** A verified-email applicant session has no partner tenant capabilities. */
export const partnerApplicantSessions = pgTable(
  "partner_applicant_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    verificationChallengeId: uuid("verification_challenge_id")
      .notNull()
      .references(() => partnerAuthChallenges.id, { onDelete: "restrict" }),
    normalizedEmail: text("normalized_email").notNull(),
    sessionHash: varchar("session_hash", { length: 64 }).notNull(),
    // Migration 0131 owns this FK because applications are declared below.
    applicationId: uuid("application_id"),
    draftPayload: jsonb("draft_payload")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    draftVersion: integer("draft_version").default(1).notNull(),
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
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    sessionHashKey: uniqueIndex("partner_applicant_sessions_hash_key").on(
      table.sessionHash,
    ),
    challengeKey: uniqueIndex("partner_applicant_sessions_challenge_key").on(
      table.verificationChallengeId,
    ),
    emailActiveIdx: index("partner_applicant_sessions_email_active_idx").on(
      table.normalizedEmail,
      table.revokedAt,
      table.expiresAt,
    ),
    emailCheck: check(
      "partner_applicant_sessions_email_check",
      sql`${table.normalizedEmail} = lower(btrim(${table.normalizedEmail})) AND length(${table.normalizedEmail}) BETWEEN 3 AND 254 AND ${table.normalizedEmail} !~ '[[:space:]]' AND ${table.normalizedEmail} LIKE '%@%'`,
    ),
    sessionHashCheck: check(
      "partner_applicant_sessions_hash_check",
      sql`${table.sessionHash} ~ '^[0-9a-f]{64}$'`,
    ),
    draftVersionCheck: check(
      "partner_applicant_sessions_draft_version_check",
      sql`${table.draftVersion} > 0`,
    ),
  }),
);

export type PartnerAccessApplicationStatus =
  | "submitted"
  | "under_review"
  | "needs_information"
  | "approved"
  | "declined"
  | "withdrawn";

export const partnerAccessApplications = pgTable(
  "partner_access_applications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    identityHash: varchar("identity_hash", { length: 64 }).notNull(),
    email: text("email").notNull(),
    normalizedEmail: text("normalized_email").notNull(),
    name: text("name").notNull(),
    phone: text("phone"),
    phoneE164: text("phone_e164"),
    companyName: text("company_name").notNull(),
    website: text("website"),
    partnerType: text("partner_type").notNull(),
    serviceAreas: text("service_areas").array().notNull().default([]),
    requestedNeeds: text("requested_needs").array().notNull().default([]),
    flowVersion: integer("flow_version").default(1).notNull(),
    emailVerificationChallengeId: uuid(
      "email_verification_challenge_id",
    ).references(() => partnerAuthChallenges.id, { onDelete: "restrict" }),
    applicantSessionId: uuid("applicant_session_id").references(
      () => partnerApplicantSessions.id,
      { onDelete: "restrict" },
    ),
    companyResolutionChoice: text("company_resolution_choice").$type<
      "join_existing" | "create_new" | "manual_review"
    >(),
    companyCandidateId: varchar("company_candidate_id", { length: 64 }),
    requestedPartnerAccountId: uuid("requested_partner_account_id").references(
      () => partnerAccounts.id,
      { onDelete: "restrict" },
    ),
    status: text("status")
      .$type<PartnerAccessApplicationStatus>()
      .default("submitted")
      .notNull(),
    applicantPartnerUserId: uuid("applicant_partner_user_id").references(
      () => partnerUsers.id,
      { onDelete: "set null" },
    ),
    // Durable tenant binding for the limited workspace created with this
    // application. Historical ambiguous rows remain null and are quarantined
    // from approval/decline until staff reconciliation.
    bootstrapPartnerAccountId: uuid("bootstrap_partner_account_id").references(
      () => partnerAccounts.id,
      { onDelete: "restrict" },
    ),
    approvedPartnerAccountId: uuid("approved_partner_account_id").references(
      () => partnerAccounts.id,
      { onDelete: "restrict" },
    ),
    reviewedByMemberId: uuid("reviewed_by_member_id").references(
      () => teamMembers.id,
      { onDelete: "set null" },
    ),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    termsAcceptedAt: timestamp("terms_accepted_at", {
      withTimezone: true,
    }).notNull(),
    privacyAcceptedAt: timestamp("privacy_accepted_at", {
      withTimezone: true,
    }).notNull(),
    reviewNote: text("review_note"),
    applicantResponse: text("applicant_response"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    submittedAt: timestamp("submitted_at", { withTimezone: true })
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
    activeIdentityKey: uniqueIndex(
      "partner_access_applications_active_identity_key",
    )
      .on(table.identityHash)
      .where(
        sql`${table.status} IN ('submitted', 'under_review', 'needs_information')`,
      ),
    statusIdx: index("partner_access_applications_status_idx").on(
      table.status,
      table.submittedAt,
    ),
    bootstrapAccountIdx: index(
      "partner_access_applications_bootstrap_account_idx",
    ).on(table.bootstrapPartnerAccountId, table.status),
    requestedAccountIdx: index(
      "partner_access_applications_requested_account_idx",
    ).on(table.requestedPartnerAccountId, table.status),
    applicantSessionKey: uniqueIndex(
      "partner_access_applications_applicant_session_key",
    )
      .on(table.applicantSessionId)
      .where(sql`${table.applicantSessionId} IS NOT NULL`),
    identityHashCheck: check(
      "partner_access_applications_identity_hash_check",
      sql`${table.identityHash} ~ '^[0-9a-f]{64}$'`,
    ),
    statusCheck: check(
      "partner_access_applications_status_check",
      sql`${table.status} IN ('submitted', 'under_review', 'needs_information', 'approved', 'declined', 'withdrawn')`,
    ),
    versionCheck: check(
      "partner_access_applications_version_check",
      sql`${table.version} > 0`,
    ),
    flowVersionCheck: check(
      "partner_access_applications_flow_version_check",
      sql`${table.flowVersion} IN (1, 2)`,
    ),
    verificationFirstCheck: check(
      "partner_access_applications_verification_first_check",
      sql`${table.flowVersion} <> 2 OR (${table.emailVerifiedAt} IS NOT NULL AND ${table.emailVerificationChallengeId} IS NOT NULL AND ${table.applicantSessionId} IS NOT NULL AND ${table.bootstrapPartnerAccountId} IS NULL)`,
    ),
    companyResolutionCheck: check(
      "partner_access_applications_company_resolution_check",
      sql`(
        ${table.flowVersion} = 1
        AND ${table.companyResolutionChoice} IS NULL
        AND ${table.companyCandidateId} IS NULL
        AND ${table.requestedPartnerAccountId} IS NULL
      ) OR (
        ${table.flowVersion} = 2
        AND (
          (${table.companyResolutionChoice} = 'join_existing' AND ${table.companyCandidateId} IS NOT NULL AND ${table.requestedPartnerAccountId} IS NOT NULL)
          OR (${table.companyResolutionChoice} IN ('create_new', 'manual_review') AND ${table.companyCandidateId} IS NULL AND ${table.requestedPartnerAccountId} IS NULL)
        )
      )`,
    ),
    approvalCheck: check(
      "partner_access_applications_approval_check",
      sql`${table.status} <> 'approved' OR (${table.approvedPartnerAccountId} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL)`,
    ),
    approvalTenantCheck: check(
      "partner_access_applications_approval_tenant_check",
      sql`${table.status} <> 'approved' OR ((${table.flowVersion} = 1 AND ${table.bootstrapPartnerAccountId} IS NOT NULL AND ${table.approvedPartnerAccountId} = ${table.bootstrapPartnerAccountId}) OR (${table.flowVersion} = 2 AND ${table.bootstrapPartnerAccountId} IS NULL))`,
    ),
  }),
);

export type PartnerCompanyJoinRequestStatus =
  | "submitted"
  | "under_review"
  | "needs_information"
  | "approved"
  | "declined"
  | "withdrawn";

export const partnerCompanyJoinRequests = pgTable(
  "partner_company_join_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerUserId: uuid("partner_user_id")
      .notNull()
      .references(() => partnerUsers.id, { onDelete: "cascade" }),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "restrict" }),
    requestedRoleKey: varchar("requested_role_key", { length: 64 })
      .default("member")
      .notNull(),
    message: text("message"),
    status: text("status")
      .$type<PartnerCompanyJoinRequestStatus>()
      .default("submitted")
      .notNull(),
    reviewedByPartnerUserId: uuid("reviewed_by_partner_user_id").references(
      () => partnerUsers.id,
      { onDelete: "set null" },
    ),
    reviewedByMemberId: uuid("reviewed_by_member_id").references(
      () => teamMembers.id,
      { onDelete: "set null" },
    ),
    resolvedMembershipId: uuid("resolved_membership_id").references(
      () => partnerAccountMemberships.id,
      { onDelete: "restrict" },
    ),
    reviewNote: text("review_note"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    requestedAt: timestamp("requested_at", { withTimezone: true })
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
    activeAccountUserKey: uniqueIndex(
      "partner_company_join_requests_active_account_user_key",
    )
      .on(table.partnerAccountId, table.partnerUserId)
      .where(
        sql`${table.status} IN ('submitted', 'under_review', 'needs_information')`,
      ),
    accountStatusIdx: index(
      "partner_company_join_requests_account_status_idx",
    ).on(table.partnerAccountId, table.status, table.requestedAt),
    userStatusIdx: index("partner_company_join_requests_user_status_idx").on(
      table.partnerUserId,
      table.status,
    ),
    statusCheck: check(
      "partner_company_join_requests_status_check",
      sql`${table.status} IN ('submitted', 'under_review', 'needs_information', 'approved', 'declined', 'withdrawn')`,
    ),
    requestedRoleKeyCheck: check(
      "partner_company_join_requests_role_key_check",
      sql`${table.requestedRoleKey} ~ '^[a-z][a-z0-9_]{1,63}$'`,
    ),
    versionCheck: check(
      "partner_company_join_requests_version_check",
      sql`${table.version} > 0`,
    ),
    approvalCheck: check(
      "partner_company_join_requests_approval_check",
      sql`${table.status} <> 'approved' OR (${table.resolvedMembershipId} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL)`,
    ),
  }),
);

export type PartnerSessionAuthMethod =
  | "legacy"
  | "magic_link"
  | "password"
  | "passkey"
  | "mfa_step_up";
export type PartnerAssuranceLevel = "aal1" | "aal2";
export type PartnerAuthTransactionPurpose =
  | "password_login_mfa"
  | "activation_mfa_setup";

export const partnerSessions = pgTable(
  "partner_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerUserId: uuid("partner_user_id")
      .notNull()
      .references(() => partnerUsers.id, { onDelete: "cascade" }),
    activePartnerAccountId: uuid("active_partner_account_id").references(
      () => partnerAccounts.id,
      { onDelete: "restrict" },
    ),
    activeMembershipId: uuid("active_membership_id").references(
      () => partnerAccountMemberships.id,
      { onDelete: "cascade" },
    ),
    sessionHash: text("session_hash").notNull(),
    authMethod: text("auth_method")
      .$type<PartnerSessionAuthMethod>()
      .default("legacy")
      .notNull(),
    assuranceLevel: text("assurance_level")
      .$type<PartnerAssuranceLevel>()
      .default("aal1")
      .notNull(),
    mfaVerifiedAt: timestamp("mfa_verified_at", { withTimezone: true }),
    securityVersion: integer("security_version").default(1).notNull(),
    deviceName: text("device_name"),
    accountSelectedAt: timestamp("account_selected_at", {
      withTimezone: true,
    }),
    // The migration owns the self-referencing FK to avoid a declaration-time
    // cycle in Drizzle while retaining rotation provenance in PostgreSQL.
    rotatedFromSessionId: uuid("rotated_from_session_id"),
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
    userActiveIdx: index("partner_sessions_user_active_idx").on(
      table.partnerUserId,
      table.revokedAt,
      table.expiresAt,
    ),
    accountIdx: index("partner_sessions_account_idx").on(
      table.activePartnerAccountId,
      table.partnerUserId,
    ),
    expiresIdx: index("partner_sessions_expires_idx").on(table.expiresAt),
    authMethodCheck: check(
      "partner_sessions_auth_method_check",
      sql`${table.authMethod} IN ('legacy', 'magic_link', 'password', 'passkey', 'mfa_step_up')`,
    ),
    assuranceLevelCheck: check(
      "partner_sessions_assurance_level_check",
      sql`${table.assuranceLevel} IN ('aal1', 'aal2')`,
    ),
    securityVersionCheck: check(
      "partner_sessions_security_version_check",
      sql`${table.securityVersion} > 0`,
    ),
    accountBindingCheck: check(
      "partner_sessions_account_binding_check",
      sql`(${table.activePartnerAccountId} IS NULL) = (${table.activeMembershipId} IS NULL)`,
    ),
    deviceNameCheck: check(
      "partner_sessions_device_name_check",
      sql`${table.deviceName} IS NULL OR char_length(btrim(${table.deviceName})) BETWEEN 1 AND 120`,
    ),
  }),
);

/**
 * A password has been verified but no portal session exists yet. These
 * short-lived, one-use records carry only the authority to finish MFA for the
 * exact identity, account, membership, and security version captured here.
 */
export const partnerAuthTransactions = pgTable(
  "partner_auth_transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerUserId: uuid("partner_user_id").notNull(),
    partnerAccountId: uuid("partner_account_id").notNull(),
    partnerMembershipId: uuid("partner_membership_id").notNull(),
    tokenHash: varchar("token_hash", { length: 43 }).notNull(),
    purpose: text("purpose")
      .$type<PartnerAuthTransactionPurpose>()
      .default("password_login_mfa")
      .notNull(),
    sourceAuthChallengeId: uuid("source_auth_challenge_id").references(
      () => partnerAuthChallenges.id,
      { onDelete: "restrict" },
    ),
    securityVersion: integer("security_version").notNull(),
    rememberMe: boolean("remember_me").default(false).notNull(),
    requestedIp: text("requested_ip"),
    requestedUserAgent: text("requested_user_agent"),
    attemptCount: integer("attempt_count").default(0).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    completedSessionId: uuid("completed_session_id").references(
      () => partnerSessions.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    tokenHashKey: uniqueIndex("partner_auth_transactions_token_hash_key").on(
      table.tokenHash,
    ),
    sourceAuthChallengeKey: uniqueIndex(
      "partner_auth_transactions_source_challenge_key",
    )
      .on(table.sourceAuthChallengeId)
      .where(sql`${table.sourceAuthChallengeId} IS NOT NULL`),
    activeUserKey: uniqueIndex("partner_auth_transactions_active_user_key")
      .on(table.partnerUserId)
      .where(sql`${table.consumedAt} IS NULL`),
    expiryIdx: index("partner_auth_transactions_expiry_idx").on(
      table.expiresAt,
      table.consumedAt,
    ),
    membershipBindingFk: foreignKey({
      columns: [
        table.partnerMembershipId,
        table.partnerAccountId,
        table.partnerUserId,
      ],
      foreignColumns: [
        partnerAccountMemberships.id,
        partnerAccountMemberships.partnerAccountId,
        partnerAccountMemberships.partnerUserId,
      ],
      name: "partner_auth_transactions_membership_binding_fk",
    }).onDelete("cascade"),
    purposeCheck: check(
      "partner_auth_transactions_purpose_check",
      sql`${table.purpose} IN ('password_login_mfa', 'activation_mfa_setup')`,
    ),
    purposeSourceCheck: check(
      "partner_auth_transactions_purpose_source_check",
      sql`(${table.purpose} = 'password_login_mfa' AND ${table.sourceAuthChallengeId} IS NULL) OR (${table.purpose} = 'activation_mfa_setup' AND ${table.sourceAuthChallengeId} IS NOT NULL)`,
    ),
    tokenHashCheck: check(
      "partner_auth_transactions_token_hash_check",
      sql`${table.tokenHash} ~ '^[A-Za-z0-9_-]{43}$'`,
    ),
    securityVersionCheck: check(
      "partner_auth_transactions_security_version_check",
      sql`${table.securityVersion} > 0`,
    ),
    attemptCountCheck: check(
      "partner_auth_transactions_attempt_count_check",
      sql`${table.attemptCount} BETWEEN 0 AND 8`,
    ),
    expiryCheck: check(
      "partner_auth_transactions_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt} AND ${table.expiresAt} <= ${table.createdAt} + interval '10 minutes'`,
    ),
    completionCheck: check(
      "partner_auth_transactions_completion_check",
      sql`${table.completedSessionId} IS NULL OR ${table.consumedAt} IS NOT NULL`,
    ),
  }),
);

export const partnerRateCards = pgTable(
  "partner_rate_cards",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgContactId: uuid("org_contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    partnerAccountId: uuid("partner_account_id").references(
      () => partnerAccounts.id,
      { onDelete: "restrict" },
    ),
    currency: text("currency").default("USD").notNull(),
    active: boolean("active").default(true).notNull(),
    version: integer("version").default(1).notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true })
      .defaultNow()
      .notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
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
    accountVersionKey: uniqueIndex("partner_rate_cards_account_version_key")
      .on(table.partnerAccountId, table.version)
      .where(sql`${table.partnerAccountId} IS NOT NULL`),
    accountEffectiveIdx: index("partner_rate_cards_account_effective_idx").on(
      table.partnerAccountId,
      table.active,
      table.effectiveFrom,
      table.effectiveTo,
    ),
    versionCheck: check(
      "partner_rate_cards_version_check",
      sql`${table.version} > 0`,
    ),
    effectiveRangeCheck: check(
      "partner_rate_cards_effective_range_check",
      sql`${table.effectiveTo} IS NULL OR ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
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
    cardServiceTierKey: uniqueIndex(
      "partner_rate_items_card_service_tier_key",
    ).on(table.rateCardId, table.serviceKey, table.tierKey),
    amountCheck: check(
      "partner_rate_items_amount_check",
      sql`${table.amountCents} >= 0`,
    ),
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
    partnerFunnelDateKeyIdx: index(
      "web_event_counts_daily_partner_funnel_date_key_idx",
    )
      .on(table.dateStart, table.key)
      .where(sql`${table.event} = 'partner_funnel'`),
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
  externalBusyCoverageSyncedAt: timestamp("external_busy_coverage_synced_at", {
    withTimezone: true,
  }),
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
    // Installed as a nullable FK by Quote V2 after `quote_versions` exists.
    quoteVersionId: uuid("quote_version_id"),
    // Installed as a nullable FK after `quote_responses` exists. This binds a
    // booked job to the exact acceptance evidence, not merely the quote row.
    quoteResponseId: uuid("quote_response_id"),
    // Installed as a nullable FK by Quote V2 after `sales_opportunities` exists.
    salesOpportunityId: uuid("sales_opportunity_id"),
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
    // Immutable booking-time zone used to render this appointment exactly
    // after policy changes, DST transitions, and later reschedules.
    schedulingTimezone: varchar("scheduling_timezone", { length: 64 }),
    durationMinutes: integer("duration_min").default(60).notNull(),
    status: appointmentStatusEnum("status").default("requested").notNull(),
    quotedTotalCents: integer("quoted_total_cents"),
    quotedTotalMaxCents: integer("quoted_total_max_cents"),
    quoteConfigurationHash: varchar("quote_configuration_hash", { length: 64 }),
    quoteContentHash: varchar("quote_content_hash", { length: 64 }),
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
    partnerAccountId: uuid("partner_account_id").references(
      () => partnerAccounts.id,
      { onDelete: "restrict" },
    ),
    capacityPoolKey: varchar("capacity_pool_key", { length: 64 })
      .default("field_service")
      .notNull(),
    capacityUnits: integer("capacity_units").default(1).notNull(),
    promisedArrivalStartAt: timestamp("promised_arrival_start_at", {
      withTimezone: true,
    }),
    promisedArrivalEndAt: timestamp("promised_arrival_end_at", {
      withTimezone: true,
    }),
    schedulePolicyRevision: text("schedule_policy_revision"),
    resourceAssignmentSnapshot: jsonb("resource_assignment_snapshot")
      .$type<AppointmentResourceAssignmentSnapshot[]>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    salesOpportunityIdx: index("appointments_sales_opportunity_idx").on(
      table.salesOpportunityId,
    ),
    quoteVersionKey: uniqueIndex("appointments_quote_version_key")
      .on(table.quoteVersionId)
      .where(sql`${table.quoteVersionId} IS NOT NULL`),
    quoteResponseKey: uniqueIndex("appointments_quote_response_key")
      .on(table.quoteResponseId)
      .where(sql`${table.quoteResponseId} IS NOT NULL`),
    startIdx: index("appointments_start_idx").on(table.startAt),
    statusIdx: index("appointments_status_idx").on(table.status),
    capacityIdx: index("appointments_capacity_idx").on(
      table.capacityPoolKey,
      table.startAt,
      table.status,
    ),
    partnerAccountIdx: index("appointments_partner_account_idx").on(
      table.partnerAccountId,
      table.startAt,
    ),
    capacityUnitsCheck: check(
      "appointments_capacity_units_check",
      sql`${table.capacityUnits} BETWEEN 1 AND 100`,
    ),
    quoteEvidenceCheck: check(
      "appointments_quote_evidence_check",
      sql`${table.quoteResponseId} IS NULL OR (${table.quoteVersionId} IS NOT NULL AND ${table.salesOpportunityId} IS NOT NULL AND ${table.quotedTotalCents} IS NOT NULL AND ${table.quotedTotalCents} > 0 AND ${table.quotedTotalMaxCents} IS NOT NULL AND ${table.quotedTotalMaxCents} >= ${table.quotedTotalCents} AND ${table.quoteConfigurationHash} ~ '^[0-9a-f]{64}$' AND ${table.quoteContentHash} ~ '^[0-9a-f]{64}$' AND nullif(btrim(${table.quotedScopeText}), '') IS NOT NULL)`,
    ),
    arrivalWindowCheck: check(
      "appointments_arrival_window_check",
      sql`(${table.promisedArrivalStartAt} IS NULL AND ${table.promisedArrivalEndAt} IS NULL) OR (${table.promisedArrivalStartAt} IS NOT NULL AND ${table.promisedArrivalEndAt} > ${table.promisedArrivalStartAt})`,
    ),
    resourceAssignmentSnapshotCheck: check(
      "appointments_resource_assignment_snapshot_check",
      sql`jsonb_typeof(${table.resourceAssignmentSnapshot}) = 'array'`,
    ),
    quoteSchedulingTimezoneCheck: check(
      "appointments_quote_scheduling_timezone_check",
      sql`${table.quoteResponseId} IS NULL OR (${table.schedulingTimezone} IS NOT NULL AND char_length(btrim(${table.schedulingTimezone})) BETWEEN 1 AND 64)`,
    ),
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
    quoteVersionId: uuid("quote_version_id"),
    leadId: uuid("lead_id").references(() => leads.id, {
      onDelete: "set null",
    }),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    propertyId: uuid("property_id").references(() => properties.id, {
      onDelete: "set null",
    }),
    partnerAccountId: uuid("partner_account_id").references(
      () => partnerAccounts.id,
      { onDelete: "cascade" },
    ),
    partnerBookingDraftId: uuid("partner_booking_draft_id"),
    requestedByMembershipId: uuid("requested_by_membership_id"),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    durationMinutes: integer("duration_min").default(60).notNull(),
    travelBufferMinutes: integer("travel_buffer_min").default(30).notNull(),
    capacityPoolKey: varchar("capacity_pool_key", { length: 64 })
      .default("field_service")
      .notNull(),
    capacityUnits: integer("capacity_units").default(1).notNull(),
    arrivalWindowStartAt: timestamp("arrival_window_start_at", {
      withTimezone: true,
    }),
    arrivalWindowEndAt: timestamp("arrival_window_end_at", {
      withTimezone: true,
    }),
    policyRevision: text("policy_revision"),
    serviceProfileRevision: integer("service_profile_revision"),
    resourceAssignmentSnapshot: jsonb("resource_assignment_snapshot")
      .$type<AppointmentResourceAssignmentSnapshot[]>()
      .notNull()
      .default([]),
    idempotencyKeyHash: varchar("idempotency_key_hash", { length: 64 }),
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
    quoteVersionIdx: index("appointment_holds_quote_version_idx").on(
      table.quoteVersionId,
      table.status,
      table.expiresAt,
    ),
    activeQuoteVersionKey: uniqueIndex(
      "appointment_holds_active_quote_version_key",
    )
      .on(table.quoteVersionId)
      .where(
        sql`${table.quoteVersionId} IS NOT NULL AND ${table.status} = 'active'`,
      ),
    partnerDraftIdx: index("appointment_holds_partner_draft_idx").on(
      table.partnerAccountId,
      table.partnerBookingDraftId,
      table.status,
    ),
    capacityIdx: index("appointment_holds_capacity_idx").on(
      table.capacityPoolKey,
      table.startAt,
      table.status,
      table.expiresAt,
    ),
    idempotencyKey: uniqueIndex("appointment_holds_idempotency_key")
      .on(table.partnerAccountId, table.idempotencyKeyHash)
      .where(
        sql`${table.partnerAccountId} IS NOT NULL AND ${table.idempotencyKeyHash} IS NOT NULL`,
      ),
    capacityUnitsCheck: check(
      "appointment_holds_capacity_units_check",
      sql`${table.capacityUnits} BETWEEN 1 AND 100`,
    ),
    arrivalWindowCheck: check(
      "appointment_holds_arrival_window_check",
      sql`(${table.arrivalWindowStartAt} IS NULL AND ${table.arrivalWindowEndAt} IS NULL) OR (${table.arrivalWindowStartAt} IS NOT NULL AND ${table.arrivalWindowEndAt} > ${table.arrivalWindowStartAt})`,
    ),
    resourceAssignmentSnapshotCheck: check(
      "appointment_holds_resource_assignment_snapshot_check",
      sql`jsonb_typeof(${table.resourceAssignmentSnapshot}) = 'array'`,
    ),
    quoteVersionLinkCheck: check(
      "appointment_holds_quote_version_link_check",
      sql`${table.quoteVersionId} IS NULL OR ${table.fullQuoteId} IS NOT NULL`,
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
    partnerAccountId: uuid("partner_account_id").references(
      () => partnerAccounts.id,
      { onDelete: "restrict" },
    ),
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
    idPartnerAccountKey: uniqueIndex("media_assets_id_partner_account_key").on(
      table.id,
      table.partnerAccountId,
    ),
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
    partnerAccountId: uuid("partner_account_id").references(
      () => partnerAccounts.id,
      { onDelete: "restrict" },
    ),
    bookingDraftId: uuid("booking_draft_id"),
    requestedByMembershipId: uuid("requested_by_membership_id"),
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
    currency: varchar("currency", { length: 3 }).default("USD").notNull(),
    publicStatus: text("public_status").default("requested").notNull(),
    confirmationMode: text("confirmation_mode").default("review").notNull(),
    arrivalWindowStartAt: timestamp("arrival_window_start_at", {
      withTimezone: true,
    }),
    arrivalWindowEndAt: timestamp("arrival_window_end_at", {
      withTimezone: true,
    }),
    scopeSnapshot: jsonb("scope_snapshot").$type<Record<
      string,
      unknown
    > | null>(),
    rateSnapshot: jsonb("rate_snapshot").$type<Record<
      string,
      unknown
    > | null>(),
    addOnsSnapshot: jsonb("add_ons_snapshot")
      .$type<
        Array<{
          key: string;
          label: string;
          unitLabel: string;
          quantity: number;
          unitAmountMinor: number | null;
          lineTotalMinor: number | null;
          currency: string | null;
          requiresReview: boolean;
        }>
      >()
      .notNull()
      .default([]),
    proofRequirementsSnapshot: jsonb(
      "proof_requirements_snapshot",
    ).$type<Record<string, unknown> | null>(),
    poNumber: text("po_number"),
    costCenter: text("cost_center"),
    projectReference: text("project_reference"),
    billingContactSnapshot: jsonb("billing_contact_snapshot").$type<Record<
      string,
      unknown
    > | null>(),
    requestedReviewReasons: text("requested_review_reasons")
      .array()
      .notNull()
      .default([]),
    createOperationKeyHash: varchar("create_operation_key_hash", {
      length: 64,
    }),
    createRequestHash: varchar("create_request_hash", { length: 64 }),
    cancelOperationKeyHash: varchar("cancel_operation_key_hash", {
      length: 64,
    }),
    cancelRequestHash: varchar("cancel_request_hash", { length: 64 }),
    rescheduleOperationKeyHash: varchar("reschedule_operation_key_hash", {
      length: 64,
    }),
    rescheduleRequestHash: varchar("reschedule_request_hash", { length: 64 }),
    version: integer("version").default(1).notNull(),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    orgIdx: index("partner_bookings_org_idx").on(table.orgContactId),
    appointmentIdx: index("partner_bookings_appointment_idx").on(
      table.appointmentId,
    ),
    appointmentKey: uniqueIndex("partner_bookings_appointment_key").on(
      table.appointmentId,
    ),
    accountStatusIdx: index("partner_bookings_account_status_idx").on(
      table.partnerAccountId,
      table.publicStatus,
      table.createdAt,
      table.id,
    ),
    accountBookingKey: uniqueIndex("partner_bookings_account_booking_key").on(
      table.partnerAccountId,
      table.id,
    ),
    accountLocationIdx: index("partner_bookings_account_location_idx").on(
      table.partnerAccountId,
      table.propertyId,
      table.createdAt,
    ),
    accountCreatedIdx: index("partner_bookings_account_created_id_idx")
      .on(table.partnerAccountId, table.createdAt, table.id)
      .where(sql`${table.partnerAccountId} IS NOT NULL`),
    accountServiceCreatedIdx: index(
      "partner_bookings_account_service_created_id_idx",
    )
      .on(table.partnerAccountId, table.serviceKey, table.createdAt, table.id)
      .where(sql`${table.partnerAccountId} IS NOT NULL`),
    accountPropertyCreatedIdx: index(
      "partner_bookings_account_property_created_id_idx",
    )
      .on(table.partnerAccountId, table.propertyId, table.createdAt, table.id)
      .where(sql`${table.partnerAccountId} IS NOT NULL`),
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
    cancelRequestHashCheck: check(
      "partner_bookings_cancel_request_hash_check",
      sql`${table.cancelRequestHash} IS NULL OR ${table.cancelRequestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    rescheduleOperationKeyIdx: uniqueIndex(
      "partner_bookings_reschedule_operation_key_hash_key",
    )
      .on(table.rescheduleOperationKeyHash)
      .where(sql`${table.rescheduleOperationKeyHash} IS NOT NULL`),
    rescheduleOperationKeyHashCheck: check(
      "partner_bookings_reschedule_operation_key_hash_check",
      sql`${table.rescheduleOperationKeyHash} IS NULL OR ${table.rescheduleOperationKeyHash} ~ '^[0-9a-f]{64}$'`,
    ),
    rescheduleRequestHashCheck: check(
      "partner_bookings_reschedule_request_hash_check",
      sql`${table.rescheduleRequestHash} IS NULL OR ${table.rescheduleRequestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    rescheduleOperationPairCheck: check(
      "partner_bookings_reschedule_operation_pair_check",
      sql`(${table.rescheduleOperationKeyHash} IS NULL) = (${table.rescheduleRequestHash} IS NULL)`,
    ),
    versionCheck: check(
      "partner_bookings_version_check",
      sql`${table.version} > 0`,
    ),
    amountCheck: check(
      "partner_bookings_amount_check",
      sql`${table.amountCents} IS NULL OR ${table.amountCents} >= 0`,
    ),
    currencyCheck: check(
      "partner_bookings_currency_check",
      sql`${table.currency} ~ '^[A-Z]{3}$'`,
    ),
    publicStatusCheck: check(
      "partner_bookings_public_status_check",
      sql`${table.publicStatus} IN ('requested', 'approval_needed', 'under_review', 'confirmed', 'en_route', 'in_progress', 'completed', 'canceled', 'declined')`,
    ),
    confirmationModeCheck: check(
      "partner_bookings_confirmation_mode_check",
      sql`${table.confirmationMode} IN ('instant', 'review', 'approval')`,
    ),
    arrivalWindowCheck: check(
      "partner_bookings_arrival_window_check",
      sql`(${table.arrivalWindowStartAt} IS NULL AND ${table.arrivalWindowEndAt} IS NULL) OR (${table.arrivalWindowStartAt} IS NOT NULL AND ${table.arrivalWindowEndAt} > ${table.arrivalWindowStartAt})`,
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
      sql`${table.kind} IN ('partner_booking_created', 'partner_booking_canceled', 'partner_billing_dispute_requested')`,
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
    // Quote V2 compatibility pointers remain nullable until the additive
    // backfill and dual-write rollout have completed. Their foreign keys are
    // installed by 0114 after the appended V2 tables exist.
    salesOpportunityId: uuid("sales_opportunity_id"),
    currentVersionId: uuid("current_version_id"),
    publishedVersionId: uuid("published_version_id"),
    partnerAccountId: uuid("partner_account_id").references(
      () => partnerAccounts.id,
      { onDelete: "restrict" },
    ),
    engineVersion: text("engine_version").default("legacy").notNull(),
    aggregateState: text("aggregate_state"),
    aggregateRevision: integer("aggregate_revision"),
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
    salesOpportunityIdx: index("quotes_sales_opportunity_idx").on(
      table.salesOpportunityId,
    ),
    currentVersionIdx: index("quotes_current_version_idx").on(
      table.currentVersionId,
    ),
    publishedVersionIdx: index("quotes_published_version_idx").on(
      table.publishedVersionId,
    ),
    idPartnerAccountKey: uniqueIndex("quotes_id_partner_account_key").on(
      table.id,
      table.partnerAccountId,
    ),
    partnerAccountStateIdx: index("quotes_partner_account_state_idx")
      .on(
        table.partnerAccountId,
        table.aggregateState,
        table.updatedAt,
        table.id,
      )
      .where(sql`${table.partnerAccountId} IS NOT NULL`),
    aggregateStateIdx: index("quotes_aggregate_state_idx").on(
      table.engineVersion,
      table.aggregateState,
      table.updatedAt,
    ),
    contactIdx: index("quotes_contact_idx").on(table.contactId),
    propertyIdx: index("quotes_property_idx").on(table.propertyId),
    quoteNumberIdx: index("quotes_quote_number_idx").on(table.quoteNumber),
    v2QuoteNumberKey: uniqueIndex("quotes_v2_quote_number_key")
      .on(table.quoteNumber)
      .where(
        sql`${table.engineVersion} = 'v2' AND ${table.quoteNumber} IS NOT NULL`,
      ),
    partnerAccountEngineCheck: check(
      "quotes_partner_account_engine_check",
      sql`${table.partnerAccountId} IS NULL OR ${table.engineVersion} = 'v2'`,
    ),
    shareTokenIdx: uniqueIndex("quotes_share_token_key").on(table.shareToken),
    acceptedAppointmentIdx: index("quotes_accepted_appointment_idx").on(
      table.acceptedAppointmentId,
    ),
    engineVersionCheck: check(
      "quotes_engine_version_check",
      sql`${table.engineVersion} IN ('legacy', 'v2')`,
    ),
    aggregateStateCheck: check(
      "quotes_aggregate_state_check",
      sql`${table.aggregateState} IS NULL OR ${table.aggregateState} IN ('draft', 'open', 'accepted', 'declined', 'voided', 'archived')`,
    ),
    v2ShapeCheck: check(
      "quotes_v2_shape_check",
      sql`${table.engineVersion} = 'legacy' OR (${table.aggregateState} IS NOT NULL AND ${table.aggregateRevision} IS NOT NULL AND ${table.aggregateRevision} > 0 AND ${table.quoteNumber} IS NOT NULL)`,
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
    quoteVersionId: uuid("quote_version_id"),
    userAgent: text("user_agent"),
    ipAddress: text("ip_address"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    quoteIdx: index("quote_pdf_downloads_quote_idx").on(table.quoteId),
    versionIdx: index("quote_pdf_downloads_version_idx").on(
      table.quoteVersionId,
      table.createdAt,
    ),
    createdIdx: index("quote_pdf_downloads_created_idx").on(table.createdAt),
    noRawClientDataCheck: check(
      "quote_pdf_downloads_no_raw_client_data_check",
      sql`${table.userAgent} IS NULL AND ${table.ipAddress} IS NULL`,
    ),
  }),
);

export const quoteChangeRequests = pgTable(
  "quote_change_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    quoteId: uuid("quote_id")
      .notNull()
      .references(() => quotes.id, { onDelete: "cascade" }),
    // Nullable during legacy backfill. The migration installs the FK after
    // `quote_versions` has been created.
    quoteVersionId: uuid("quote_version_id"),
    expectedRevision: integer("expected_revision"),
    requestKeyHash: varchar("request_key_hash", { length: 64 }),
    status: text("status"),
    ownerTaskId: uuid("owner_task_id").references(() => crmTasks.id, {
      onDelete: "restrict",
    }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    reason: text("reason").notNull(),
    message: text("message"),
    resolvedByTeamMemberId: uuid("resolved_by_team_member_id").references(
      () => teamMembers.id,
      { onDelete: "set null" },
    ),
    resolutionNote: text("resolution_note"),
    resolutionKind: text("resolution_kind"),
    // The composite quote/version FK is installed by the additive lifecycle
    // migration because quote_versions is declared later in this module.
    resultingVersionId: uuid("resulting_version_id"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    quoteIdx: index("quote_change_requests_quote_idx").on(table.quoteId),
    versionStatusIdx: index("quote_change_requests_version_status_idx").on(
      table.quoteVersionId,
      table.status,
      table.createdAt,
    ),
    resultingVersionIdx: index(
      "quote_change_requests_resulting_version_idx",
    ).on(table.resultingVersionId),
    actionableQuoteKey: uniqueIndex(
      "quote_change_requests_actionable_quote_key",
    )
      .on(table.quoteId)
      .where(
        sql`${table.quoteVersionId} IS NOT NULL AND ${table.status} IN ('open', 'acknowledged')`,
      ),
    requestKey: uniqueIndex("quote_change_requests_request_key")
      .on(table.quoteVersionId, table.requestKeyHash)
      .where(
        sql`${table.quoteVersionId} IS NOT NULL AND ${table.requestKeyHash} IS NOT NULL`,
      ),
    ownerTaskKey: uniqueIndex("quote_change_requests_owner_task_key")
      .on(table.ownerTaskId)
      .where(sql`${table.ownerTaskId} IS NOT NULL`),
    createdIdx: index("quote_change_requests_created_idx").on(table.createdAt),
    expectedRevisionCheck: check(
      "quote_change_requests_expected_revision_check",
      sql`${table.expectedRevision} IS NULL OR ${table.expectedRevision} > 0`,
    ),
    requestKeyHashCheck: check(
      "quote_change_requests_request_key_hash_check",
      sql`${table.requestKeyHash} IS NULL OR ${table.requestKeyHash} ~ '^[0-9a-f]{64}$'`,
    ),
    statusCheck: check(
      "quote_change_requests_status_check",
      sql`${table.status} IS NULL OR ${table.status} IN ('open', 'acknowledged', 'resolved', 'dismissed')`,
    ),
    resolutionCheck: check(
      "quote_change_requests_resolution_check",
      sql`(${table.status} IS NULL OR ${table.status} IN ('open', 'acknowledged')) OR ${table.resolvedAt} IS NOT NULL`,
    ),
    resolutionKindCheck: check(
      "quote_change_requests_resolution_kind_check",
      sql`${table.resolutionKind} IS NULL OR ${table.resolutionKind} IN ('revision', 'reopen_unchanged', 'quote_voided', 'quote_archived')`,
    ),
    v2ResolutionEvidenceCheck: check(
      "quote_change_requests_v2_resolution_evidence_check",
      sql`${table.quoteVersionId} IS NULL OR ((${table.status} IN ('open', 'acknowledged') AND ${table.resolutionKind} IS NULL AND ${table.resultingVersionId} IS NULL AND ${table.resolvedAt} IS NULL) OR (${table.status} = 'resolved' AND ${table.resolutionKind} IN ('revision', 'reopen_unchanged') AND ${table.resultingVersionId} IS NOT NULL AND ${table.resolvedAt} IS NOT NULL) OR (${table.status} = 'dismissed' AND ${table.resolutionKind} IN ('quote_voided', 'quote_archived') AND ${table.resultingVersionId} IS NOT NULL AND ${table.resolvedAt} IS NOT NULL))`,
    ),
    v2WorkflowCheck: check(
      "quote_change_requests_v2_workflow_check",
      sql`${table.quoteVersionId} IS NULL OR (${table.ownerTaskId} IS NOT NULL AND ${table.dueAt} IS NOT NULL)`,
    ),
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

/**
 * Human-confirmed operational facts from landfill and transfer-station scale
 * tickets. AI extraction remains on the immutable receipt capture; only the
 * reviewed values attached to an expense become reporting facts here.
 */
export const expenseDumpDetails = pgTable(
  "expense_dump_details",
  {
    expenseId: uuid("expense_id")
      .primaryKey()
      .references(() => expenses.id, { onDelete: "restrict" }),
    weightStatus: text("weight_status")
      .$type<"confirmed" | "unreadable">()
      .notNull(),
    facilityName: text("facility_name"),
    ticketNumber: text("ticket_number"),
    material: text("material"),
    grossWeightPounds: integer("gross_weight_pounds"),
    tareWeightPounds: integer("tare_weight_pounds"),
    netWeightPounds: integer("net_weight_pounds"),
    billedWeightMilliTons: integer("billed_weight_milli_tons"),
    unitRateCentsPerTon: integer("unit_rate_cents_per_ton"),
    confirmedBy: uuid("confirmed_by")
      .notNull()
      .references(() => teamMembers.id, { onDelete: "restrict" }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    ticketLookupIdx: index("expense_dump_details_ticket_lookup_idx").on(
      table.facilityName,
      table.ticketNumber,
    ),
    confirmedAtIdx: index("expense_dump_details_confirmed_at_idx").on(
      table.confirmedAt,
    ),
    weightStatusCheck: check(
      "expense_dump_details_weight_status_check",
      sql`${table.weightStatus} IN ('confirmed', 'unreadable')`,
    ),
    weightShapeCheck: check(
      "expense_dump_details_weight_shape_check",
      sql`(${table.weightStatus} = 'confirmed' AND ${table.netWeightPounds} BETWEEN 1 AND 10000000) OR (${table.weightStatus} = 'unreadable' AND ${table.netWeightPounds} IS NULL)`,
    ),
    grossWeightCheck: check(
      "expense_dump_details_gross_weight_check",
      sql`${table.grossWeightPounds} IS NULL OR ${table.grossWeightPounds} BETWEEN 1 AND 10000000`,
    ),
    tareWeightCheck: check(
      "expense_dump_details_tare_weight_check",
      sql`${table.tareWeightPounds} IS NULL OR ${table.tareWeightPounds} BETWEEN 0 AND 10000000`,
    ),
    grossTareCheck: check(
      "expense_dump_details_gross_tare_check",
      sql`${table.grossWeightPounds} IS NULL OR ${table.tareWeightPounds} IS NULL OR ${table.grossWeightPounds} >= ${table.tareWeightPounds}`,
    ),
    billedWeightCheck: check(
      "expense_dump_details_billed_weight_check",
      sql`${table.billedWeightMilliTons} IS NULL OR ${table.billedWeightMilliTons} BETWEEN 0 AND 10000000`,
    ),
    unitRateCheck: check(
      "expense_dump_details_unit_rate_check",
      sql`${table.unitRateCentsPerTon} IS NULL OR ${table.unitRateCentsPerTon} BETWEEN 0 AND 100000000`,
    ),
    facilityNameCheck: check(
      "expense_dump_details_facility_name_check",
      sql`${table.facilityName} IS NULL OR char_length(btrim(${table.facilityName})) BETWEEN 1 AND 240`,
    ),
    ticketNumberCheck: check(
      "expense_dump_details_ticket_number_check",
      sql`${table.ticketNumber} IS NULL OR char_length(btrim(${table.ticketNumber})) BETWEEN 1 AND 120`,
    ),
    materialCheck: check(
      "expense_dump_details_material_check",
      sql`${table.material} IS NULL OR char_length(btrim(${table.material})) BETWEEN 1 AND 240`,
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
    // Quote-deposit linkage is optional so every existing appointment payment
    // remains valid while Quote V2 rolls out.
    quoteId: uuid("quote_id"),
    quoteVersionId: uuid("quote_version_id"),
    // Installed as an FK after Quote V2 response evidence exists.
    quoteResponseId: uuid("quote_response_id"),
    appointmentHoldId: uuid("appointment_hold_id").references(
      () => appointmentHolds.id,
      { onDelete: "set null" },
    ),
    quotePaymentKind: text("quote_payment_kind"),
    appointmentId: uuid("appointment_id").references(() => appointments.id, {
      onDelete: "set null",
    }),
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
    quoteVersionIdx: index("payment_attempts_quote_version_idx").on(
      table.quoteVersionId,
      table.quotePaymentKind,
      table.createdAt,
    ),
    quoteResponseIdx: index("payment_attempts_quote_response_idx").on(
      table.quoteResponseId,
      table.createdAt,
    ),
    activeQuoteDepositKey: uniqueIndex(
      "payment_attempts_active_quote_deposit_key",
    )
      .on(table.quoteResponseId)
      .where(
        sql`${table.quoteResponseId} IS NOT NULL AND ${table.quotePaymentKind} = 'deposit' AND ${table.status} IN ('created', 'launched', 'pending_verification')`,
      ),
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
    quoteLinkCheck: check(
      "payment_attempts_quote_link_check",
      sql`${table.quoteVersionId} IS NULL OR ${table.quoteId} IS NOT NULL`,
    ),
    quotePaymentKindCheck: check(
      "payment_attempts_quote_payment_kind_check",
      sql`${table.quotePaymentKind} IS NULL OR (${table.quoteVersionId} IS NOT NULL AND ${table.quotePaymentKind} IN ('deposit', 'balance', 'full', 'adjustment'))`,
    ),
    subjectCheck: check(
      "payment_attempts_subject_check",
      sql`${table.appointmentId} IS NOT NULL OR ${table.quoteResponseId} IS NOT NULL`,
    ),
  }),
);

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    quoteId: uuid("quote_id"),
    quoteVersionId: uuid("quote_version_id"),
    // Installed as an FK after Quote V2 response evidence exists.
    quoteResponseId: uuid("quote_response_id"),
    quotePaymentKind: text("quote_payment_kind"),
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
    quoteVersionIdx: index("payments_quote_version_idx").on(
      table.quoteVersionId,
      table.quotePaymentKind,
      table.createdAt,
    ),
    quoteResponseIdx: index("payments_quote_response_idx").on(
      table.quoteResponseId,
      table.createdAt,
    ),
    completedQuoteDepositKey: uniqueIndex(
      "payments_completed_quote_deposit_key",
    )
      .on(table.quoteResponseId)
      .where(
        sql`${table.quoteResponseId} IS NOT NULL AND ${table.quotePaymentKind} = 'deposit' AND ${table.canonicalStatus} = 'completed'`,
      ),
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
    quoteLinkCheck: check(
      "payments_quote_link_check",
      sql`${table.quoteVersionId} IS NULL OR ${table.quoteId} IS NOT NULL`,
    ),
    quotePaymentKindCheck: check(
      "payments_quote_payment_kind_check",
      sql`${table.quotePaymentKind} IS NULL OR (${table.quoteVersionId} IS NOT NULL AND ${table.quotePaymentKind} IN ('deposit', 'balance', 'full', 'adjustment'))`,
    ),
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

// ---------------------------------------------------------------------------
// Partner Portal V2: account-owned operations, proof, communication, and
// commercial records. These are deliberately additive while legacy contact-
// owned projections remain available during the expand/backfill/contract
// migration.
// ---------------------------------------------------------------------------

export const partnerAccountLocations = pgTable(
  "partner_account_locations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "restrict" }),
    propertyId: uuid("property_id").references(() => properties.id, {
      onDelete: "restrict",
    }),
    siteName: text("site_name").notNull(),
    externalPropertyId: text("external_property_id"),
    addressLine1: text("address_line1").notNull(),
    addressLine2: text("address_line2"),
    city: text("city").notNull(),
    state: varchar("state", { length: 2 }).notNull(),
    postalCode: varchar("postal_code", { length: 16 }).notNull(),
    timezone: text("timezone").default("America/New_York").notNull(),
    locale: text("locale").default("en-US").notNull(),
    latitude: numeric("latitude", { precision: 9, scale: 6 }),
    longitude: numeric("longitude", { precision: 9, scale: 6 }),
    geocodeStatus: text("geocode_status").default("pending").notNull(),
    serviceAreaStatus: text("service_area_status")
      .default("unverified")
      .notNull(),
    addressVerificationStatus: text("address_verification_status")
      .$type<
        | "verified"
        | "suggested_correction"
        | "review_required"
        | "staff_verified"
      >()
      .default("review_required")
      .notNull(),
    addressVerificationProvider: text("address_verification_provider")
      .$type<"mapbox" | "manual" | "legacy" | "none">()
      .default("none")
      .notNull(),
    addressVerificationConfidence: integer("address_verification_confidence"),
    addressVerificationFeatureId: text("address_verification_feature_id"),
    addressVerificationSuggestion: jsonb(
      "address_verification_suggestion",
    ).$type<Record<string, unknown> | null>(),
    addressVerifiedAt: timestamp("address_verified_at", {
      withTimezone: true,
    }),
    accessInstructions: text("access_instructions"),
    parkingInstructions: text("parking_instructions"),
    loadingInstructions: text("loading_instructions"),
    accessSecretCiphertext: text("access_secret_ciphertext"),
    accessSecretKeyVersion: integer("access_secret_key_version"),
    onSiteContact: jsonb("on_site_contact").$type<Record<
      string,
      unknown
    > | null>(),
    parentLocationId: uuid("parent_location_id"),
    mergedIntoLocationId: uuid("merged_into_location_id"),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    mergedByMembershipId: uuid("merged_by_membership_id"),
    mergeReason: text("merge_reason"),
    active: boolean("active").default(true).notNull(),
    version: integer("version").default(1).notNull(),
    createdByMembershipId: uuid("created_by_membership_id").references(
      () => partnerAccountMemberships.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    accountLocationKey: uniqueIndex(
      "partner_account_locations_account_location_key",
    ).on(table.partnerAccountId, table.id),
    accountPropertyKey: uniqueIndex(
      "partner_account_locations_account_property_key",
    )
      .on(table.partnerAccountId, table.propertyId)
      .where(sql`${table.propertyId} IS NOT NULL`),
    accountExternalKey: uniqueIndex(
      "partner_account_locations_account_external_key",
    )
      .on(table.partnerAccountId, table.externalPropertyId)
      .where(sql`${table.externalPropertyId} IS NOT NULL`),
    accountActiveIdx: index("partner_account_locations_account_active_idx").on(
      table.partnerAccountId,
      table.active,
      table.siteName,
    ),
    accountActiveSiteIdIdx: index(
      "partner_account_locations_account_active_site_id_idx",
    ).on(table.partnerAccountId, table.active, table.siteName, table.id),
    accountSiteIdIdx: index("partner_account_locations_account_site_id_idx").on(
      table.partnerAccountId,
      table.siteName,
      table.id,
    ),
    parentIdx: index("partner_account_locations_parent_idx").on(
      table.partnerAccountId,
      table.parentLocationId,
      table.active,
      table.siteName,
      table.id,
    ),
    verificationQueueIdx: index(
      "partner_account_locations_verification_queue_idx",
    )
      .on(
        table.addressVerificationStatus,
        table.partnerAccountId,
        table.updatedAt,
        table.id,
      )
      .where(
        sql`${table.active} = true AND ${table.addressVerificationStatus} IN ('suggested_correction', 'review_required')`,
      ),
    mergedIntoIdx: index("partner_account_locations_merged_into_idx")
      .on(
        table.partnerAccountId,
        table.mergedIntoLocationId,
        table.mergedAt,
        table.id,
      )
      .where(sql`${table.mergedIntoLocationId} IS NOT NULL`),
    parentAccountFk: foreignKey({
      name: "partner_account_locations_parent_account_fk",
      columns: [table.partnerAccountId, table.parentLocationId],
      foreignColumns: [table.partnerAccountId, table.id],
    }).onDelete("restrict"),
    mergeActorAccountFk: foreignKey({
      name: "partner_account_locations_merge_actor_account_fk",
      columns: [table.mergedByMembershipId, table.partnerAccountId],
      foreignColumns: [
        partnerAccountMemberships.id,
        partnerAccountMemberships.partnerAccountId,
      ],
    }).onDelete("restrict"),
    parentNotSelfCheck: check(
      "partner_account_locations_parent_not_self_check",
      sql`${table.parentLocationId} IS NULL OR ${table.parentLocationId} <> ${table.id}`,
    ),
    versionCheck: check(
      "partner_account_locations_version_check",
      sql`${table.version} > 0`,
    ),
    geocodeStatusCheck: check(
      "partner_account_locations_geocode_status_check",
      sql`${table.geocodeStatus} IN ('pending', 'verified', 'failed', 'manual')`,
    ),
    serviceAreaStatusCheck: check(
      "partner_account_locations_service_area_status_check",
      sql`${table.serviceAreaStatus} IN ('unverified', 'eligible', 'review', 'outside')`,
    ),
    verificationStatusCheck: check(
      "partner_account_locations_verification_status_check",
      sql`${table.addressVerificationStatus} IN ('verified', 'suggested_correction', 'review_required', 'staff_verified')`,
    ),
    verificationProviderCheck: check(
      "partner_account_locations_verification_provider_check",
      sql`${table.addressVerificationProvider} IN ('mapbox', 'manual', 'legacy', 'none')`,
    ),
    verificationConfidenceCheck: check(
      "partner_account_locations_verification_confidence_check",
      sql`${table.addressVerificationConfidence} IS NULL OR ${table.addressVerificationConfidence} BETWEEN 0 AND 100`,
    ),
    verificationEvidenceCheck: check(
      "partner_account_locations_verification_evidence_check",
      sql`(${table.addressVerificationStatus} IN ('verified', 'staff_verified') AND ${table.addressVerifiedAt} IS NOT NULL) OR (${table.addressVerificationStatus} IN ('suggested_correction', 'review_required') AND ${table.addressVerifiedAt} IS NULL)`,
    ),
    suggestionShapeCheck: check(
      "partner_account_locations_suggestion_shape_check",
      sql`${table.addressVerificationSuggestion} IS NULL OR jsonb_typeof(${table.addressVerificationSuggestion}) = 'object'`,
    ),
    mergeStateCheck: check(
      "partner_account_locations_merge_state_check",
      sql`(${table.mergedIntoLocationId} IS NULL AND ${table.mergedAt} IS NULL AND ${table.mergedByMembershipId} IS NULL AND ${table.mergeReason} IS NULL) OR (${table.mergedIntoLocationId} IS NOT NULL AND ${table.mergedIntoLocationId} <> ${table.id} AND ${table.mergedAt} IS NOT NULL AND ${table.mergedByMembershipId} IS NOT NULL AND length(btrim(${table.mergeReason})) BETWEEN 5 AND 500 AND ${table.active} IS FALSE)`,
    ),
    secretStateCheck: check(
      "partner_account_locations_secret_state_check",
      sql`(${table.accessSecretCiphertext} IS NULL AND ${table.accessSecretKeyVersion} IS NULL) OR (${table.accessSecretCiphertext} IS NOT NULL AND ${table.accessSecretKeyVersion} > 0)`,
    ),
  }),
);

export const partnerLocationAddressReviews = pgTable(
  "partner_location_address_reviews",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id").notNull(),
    locationId: uuid("location_id").notNull(),
    requestedByMembershipId: uuid("requested_by_membership_id").notNull(),
    state: text("state")
      .$type<"pending" | "verified" | "correction_required" | "dismissed">()
      .default("pending")
      .notNull(),
    reasonCode: text("reason_code")
      .$type<
        | "provider_unavailable"
        | "low_confidence"
        | "suggested_correction"
        | "possible_duplicate"
        | "partner_requested"
      >()
      .notNull(),
    enteredAddress: jsonb("entered_address")
      .$type<Record<string, unknown>>()
      .notNull(),
    providerSuggestion: jsonb("provider_suggestion").$type<Record<
      string,
      unknown
    > | null>(),
    providerConfidence: integer("provider_confidence"),
    duplicateCandidates: jsonb("duplicate_candidates")
      .$type<Array<Record<string, unknown>>>()
      .default([])
      .notNull(),
    reviewedByTeamMemberId: uuid("reviewed_by_team_member_id").references(
      () => teamMembers.id,
      { onDelete: "restrict" },
    ),
    resolutionNote: text("resolution_note"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
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
    accountFk: foreignKey({
      name: "partner_location_address_reviews_account_fk",
      columns: [table.partnerAccountId],
      foreignColumns: [partnerAccounts.id],
    }).onDelete("restrict"),
    locationAccountFk: foreignKey({
      name: "partner_location_address_reviews_location_account_fk",
      columns: [table.partnerAccountId, table.locationId],
      foreignColumns: [
        partnerAccountLocations.partnerAccountId,
        partnerAccountLocations.id,
      ],
    }).onDelete("restrict"),
    requesterAccountFk: foreignKey({
      name: "partner_location_address_reviews_requester_account_fk",
      columns: [table.requestedByMembershipId, table.partnerAccountId],
      foreignColumns: [
        partnerAccountMemberships.id,
        partnerAccountMemberships.partnerAccountId,
      ],
    }).onDelete("restrict"),
    openLocationKey: uniqueIndex(
      "partner_location_address_reviews_open_location_key",
    )
      .on(table.partnerAccountId, table.locationId)
      .where(sql`${table.state} = 'pending'`),
    queueIdx: index("partner_location_address_reviews_queue_idx").on(
      table.state,
      table.createdAt,
      table.id,
    ),
    accountIdx: index("partner_location_address_reviews_account_idx").on(
      table.partnerAccountId,
      table.state,
      table.createdAt,
      table.id,
    ),
    stateCheck: check(
      "partner_location_address_reviews_state_check",
      sql`${table.state} IN ('pending', 'verified', 'correction_required', 'dismissed')`,
    ),
    reasonCheck: check(
      "partner_location_address_reviews_reason_check",
      sql`${table.reasonCode} IN ('provider_unavailable', 'low_confidence', 'suggested_correction', 'possible_duplicate', 'partner_requested')`,
    ),
    jsonCheck: check(
      "partner_location_address_reviews_json_check",
      sql`jsonb_typeof(${table.enteredAddress}) = 'object' AND (${table.providerSuggestion} IS NULL OR jsonb_typeof(${table.providerSuggestion}) = 'object') AND jsonb_typeof(${table.duplicateCandidates}) = 'array' AND jsonb_array_length(${table.duplicateCandidates}) <= 20`,
    ),
    confidenceCheck: check(
      "partner_location_address_reviews_confidence_check",
      sql`${table.providerConfidence} IS NULL OR ${table.providerConfidence} BETWEEN 0 AND 100`,
    ),
    lifecycleCheck: check(
      "partner_location_address_reviews_lifecycle_check",
      sql`(${table.state} = 'pending' AND ${table.reviewedByTeamMemberId} IS NULL AND ${table.resolutionNote} IS NULL AND ${table.resolvedAt} IS NULL) OR (${table.state} <> 'pending' AND ${table.reviewedByTeamMemberId} IS NOT NULL AND length(btrim(${table.resolutionNote})) BETWEEN 5 AND 1000 AND ${table.resolvedAt} IS NOT NULL)`,
    ),
    versionCheck: check(
      "partner_location_address_reviews_version_check",
      sql`${table.version} > 0`,
    ),
  }),
);

export const partnerLocationFavorites = pgTable(
  "partner_location_favorites",
  {
    partnerAccountId: uuid("partner_account_id").notNull(),
    membershipId: uuid("membership_id").notNull(),
    locationId: uuid("location_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    primaryKey: primaryKey({
      name: "partner_location_favorites_pk",
      columns: [table.membershipId, table.locationId],
    }),
    membershipAccountFk: foreignKey({
      name: "partner_location_favorites_membership_account_fk",
      columns: [table.membershipId, table.partnerAccountId],
      foreignColumns: [
        partnerAccountMemberships.id,
        partnerAccountMemberships.partnerAccountId,
      ],
    }).onDelete("cascade"),
    locationAccountFk: foreignKey({
      name: "partner_location_favorites_location_account_fk",
      columns: [table.partnerAccountId, table.locationId],
      foreignColumns: [
        partnerAccountLocations.partnerAccountId,
        partnerAccountLocations.id,
      ],
    }).onDelete("cascade"),
    accountLocationIdx: index(
      "partner_location_favorites_account_location_idx",
    ).on(table.partnerAccountId, table.locationId, table.membershipId),
  }),
);

export const partnerAccountMergeCases = pgTable(
  "partner_account_merge_cases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourcePartnerAccountId: uuid("source_partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "restrict" }),
    targetPartnerAccountId: uuid("target_partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "restrict" }),
    state: text("state")
      .$type<"needs_reconciliation" | "ready" | "completed" | "cancelled">()
      .default("needs_reconciliation")
      .notNull(),
    reason: varchar("reason", { length: 1_000 }).notNull(),
    conflictSummary: jsonb("conflict_summary")
      .$type<Record<string, number>>()
      .default({})
      .notNull(),
    preflightHash: varchar("preflight_hash", { length: 64 }).notNull(),
    sourceLifecycleRevision: integer("source_lifecycle_revision").notNull(),
    targetLifecycleRevision: integer("target_lifecycle_revision").notNull(),
    requestedByTeamMemberId: uuid("requested_by_team_member_id")
      .notNull()
      .references(() => teamMembers.id, { onDelete: "restrict" }),
    completedByTeamMemberId: uuid("completed_by_team_member_id").references(
      () => teamMembers.id,
      { onDelete: "restrict" },
    ),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledByTeamMemberId: uuid("cancelled_by_team_member_id").references(
      () => teamMembers.id,
      { onDelete: "restrict" },
    ),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    resolutionNote: varchar("resolution_note", { length: 1_000 }),
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
    openSourceKey: uniqueIndex("partner_account_merge_cases_open_source_key")
      .on(table.sourcePartnerAccountId)
      .where(sql`${table.state} IN ('needs_reconciliation', 'ready')`),
    queueIdx: index("partner_account_merge_cases_queue_idx").on(
      table.state,
      table.createdAt,
      table.id,
    ),
    targetIdx: index("partner_account_merge_cases_target_idx").on(
      table.targetPartnerAccountId,
      table.state,
      table.createdAt,
      table.id,
    ),
    distinctAccountsCheck: check(
      "partner_account_merge_cases_distinct_accounts_check",
      sql`${table.sourcePartnerAccountId} <> ${table.targetPartnerAccountId}`,
    ),
    stateCheck: check(
      "partner_account_merge_cases_state_check",
      sql`${table.state} IN ('needs_reconciliation', 'ready', 'completed', 'cancelled')`,
    ),
    reasonCheck: check(
      "partner_account_merge_cases_reason_check",
      sql`length(btrim(${table.reason})) BETWEEN 20 AND 1000`,
    ),
    conflictCheck: check(
      "partner_account_merge_cases_conflict_check",
      sql`jsonb_typeof(${table.conflictSummary}) = 'object' AND octet_length(${table.conflictSummary}::text) <= 8192 AND ${table.preflightHash} ~ '^[0-9a-f]{64}$' AND ${table.sourceLifecycleRevision} > 0 AND ${table.targetLifecycleRevision} > 0`,
    ),
    lifecycleCheck: check(
      "partner_account_merge_cases_lifecycle_check",
      sql`(${table.state} IN ('needs_reconciliation', 'ready') AND ${table.completedByTeamMemberId} IS NULL AND ${table.completedAt} IS NULL AND ${table.cancelledByTeamMemberId} IS NULL AND ${table.cancelledAt} IS NULL AND ${table.resolutionNote} IS NULL) OR (${table.state} = 'completed' AND ${table.completedByTeamMemberId} IS NOT NULL AND ${table.completedAt} IS NOT NULL AND ${table.cancelledByTeamMemberId} IS NULL AND ${table.cancelledAt} IS NULL AND length(btrim(${table.resolutionNote})) BETWEEN 20 AND 1000) OR (${table.state} = 'cancelled' AND ${table.cancelledByTeamMemberId} IS NOT NULL AND ${table.cancelledAt} IS NOT NULL AND ${table.completedByTeamMemberId} IS NULL AND ${table.completedAt} IS NULL AND length(btrim(${table.resolutionNote})) BETWEEN 20 AND 1000)`,
    ),
    versionCheck: check(
      "partner_account_merge_cases_version_check",
      sql`${table.version} > 0`,
    ),
  }),
);

export const partnerLocationImports = pgTable(
  "partner_location_imports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id").notNull(),
    requestedByMembershipId: uuid("requested_by_membership_id").notNull(),
    committedByMembershipId: uuid("committed_by_membership_id"),
    dryRunIdempotencyKeyHash: varchar("dry_run_idempotency_key_hash", {
      length: 64,
    }).notNull(),
    commitIdempotencyKeyHash: varchar("commit_idempotency_key_hash", {
      length: 64,
    }),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    commitRequestHash: varchar("commit_request_hash", { length: 64 }),
    state: text("state")
      .$type<"validated" | "invalid" | "committed" | "expired">()
      .default("validated")
      .notNull(),
    directoryVersion: integer("directory_version").notNull(),
    rowCount: integer("row_count").notNull(),
    validRowCount: integer("valid_row_count").notNull(),
    invalidRowCount: integer("invalid_row_count").notNull(),
    normalizedRows: jsonb("normalized_rows")
      .$type<Array<Record<string, unknown>>>()
      .default([])
      .notNull(),
    rowResults: jsonb("row_results")
      .$type<Array<Record<string, unknown>>>()
      .default([])
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    purgeAfter: timestamp("purge_after", { withTimezone: true }).notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    revision: integer("revision").default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    accountFk: foreignKey({
      name: "partner_location_imports_account_fk",
      columns: [table.partnerAccountId],
      foreignColumns: [partnerAccounts.id],
    }).onDelete("restrict"),
    requesterAccountFk: foreignKey({
      name: "partner_location_imports_requester_account_fk",
      columns: [table.requestedByMembershipId, table.partnerAccountId],
      foreignColumns: [
        partnerAccountMemberships.id,
        partnerAccountMemberships.partnerAccountId,
      ],
    }).onDelete("restrict"),
    committerAccountFk: foreignKey({
      name: "partner_location_imports_committer_account_fk",
      columns: [table.committedByMembershipId, table.partnerAccountId],
      foreignColumns: [
        partnerAccountMemberships.id,
        partnerAccountMemberships.partnerAccountId,
      ],
    }).onDelete("restrict"),
    accountDryKey: uniqueIndex("partner_location_imports_account_dry_key").on(
      table.partnerAccountId,
      table.dryRunIdempotencyKeyHash,
    ),
    accountCommitKey: uniqueIndex("partner_location_imports_account_commit_key")
      .on(table.partnerAccountId, table.commitIdempotencyKeyHash)
      .where(sql`${table.commitIdempotencyKeyHash} IS NOT NULL`),
    accountHistoryIdx: index("partner_location_imports_account_history_idx").on(
      table.partnerAccountId,
      table.createdAt,
      table.id,
    ),
    cleanupIdx: index("partner_location_imports_cleanup_idx").on(
      table.purgeAfter,
      table.id,
    ),
    stateCheck: check(
      "partner_location_imports_state_check",
      sql`${table.state} IN ('validated', 'invalid', 'committed', 'expired')`,
    ),
    hashCheck: check(
      "partner_location_imports_hash_check",
      sql`${table.dryRunIdempotencyKeyHash} ~ '^[0-9a-f]{64}$' AND ${table.requestHash} ~ '^[0-9a-f]{64}$' AND (${table.commitIdempotencyKeyHash} IS NULL OR ${table.commitIdempotencyKeyHash} ~ '^[0-9a-f]{64}$') AND (${table.commitRequestHash} IS NULL OR ${table.commitRequestHash} ~ '^[0-9a-f]{64}$')`,
    ),
    countsCheck: check(
      "partner_location_imports_counts_check",
      sql`${table.rowCount} BETWEEN 1 AND 500 AND ${table.validRowCount} BETWEEN 0 AND ${table.rowCount} AND ${table.invalidRowCount} BETWEEN 0 AND ${table.rowCount} AND ${table.validRowCount} + ${table.invalidRowCount} = ${table.rowCount} AND jsonb_typeof(${table.normalizedRows}) = 'array' AND jsonb_array_length(${table.normalizedRows}) = ${table.validRowCount} AND jsonb_typeof(${table.rowResults}) = 'array' AND jsonb_array_length(${table.rowResults}) = ${table.rowCount}`,
    ),
    versionCheck: check(
      "partner_location_imports_version_check",
      sql`${table.directoryVersion} > 0 AND ${table.revision} > 0`,
    ),
    lifecycleCheck: check(
      "partner_location_imports_lifecycle_check",
      sql`${table.expiresAt} > ${table.createdAt} AND ${table.expiresAt} <= ${table.createdAt} + interval '24 hours' AND ${table.purgeAfter} > ${table.expiresAt} AND ${table.purgeAfter} <= ${table.createdAt} + interval '30 days' AND ((${table.state} = 'committed' AND ${table.committedAt} IS NOT NULL AND ${table.committedByMembershipId} IS NOT NULL AND ${table.commitIdempotencyKeyHash} IS NOT NULL AND ${table.commitRequestHash} IS NOT NULL) OR (${table.state} <> 'committed' AND ${table.committedAt} IS NULL))`,
    ),
    noSecretKeysCheck: check(
      "partner_location_imports_no_secret_keys_check",
      sql`${table.normalizedRows}::text !~* '"(accesssecret|gatecode|accesscode|doorcode)"[[:space:]]*:' AND ${table.rowResults}::text !~* '"(accesssecret|gatecode|accesscode|doorcode)"[[:space:]]*:'`,
    ),
  }),
);

export const partnerAccountCostCenters = pgTable(
  "partner_account_cost_centers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 120 }).notNull(),
    name: text("name").notNull(),
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
    accountIdKey: uniqueIndex("partner_account_cost_centers_account_id_key").on(
      table.partnerAccountId,
      table.id,
    ),
    accountCodeKey: uniqueIndex(
      "partner_account_cost_centers_account_code_key",
    ).on(table.partnerAccountId, table.code),
    accountActiveIdx: index(
      "partner_account_cost_centers_account_active_idx",
    ).on(table.partnerAccountId, table.active, table.name),
    codeCheck: check(
      "partner_account_cost_centers_code_check",
      sql`length(btrim(${table.code})) BETWEEN 1 AND 120`,
    ),
  }),
);

export const partnerMembershipLocationScopes = pgTable(
  "partner_membership_location_scopes",
  {
    membershipId: uuid("membership_id").notNull(),
    partnerAccountId: uuid("partner_account_id").notNull(),
    locationId: uuid("location_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    primaryKey: primaryKey({
      name: "partner_membership_location_scopes_pk",
      columns: [table.membershipId, table.locationId],
    }),
    membershipAccountFk: foreignKey({
      name: "partner_membership_location_scopes_membership_account_fk",
      columns: [table.membershipId, table.partnerAccountId],
      foreignColumns: [
        partnerAccountMemberships.id,
        partnerAccountMemberships.partnerAccountId,
      ],
    }).onDelete("cascade"),
    locationAccountFk: foreignKey({
      name: "partner_membership_location_scopes_location_account_fk",
      columns: [table.partnerAccountId, table.locationId],
      foreignColumns: [
        partnerAccountLocations.partnerAccountId,
        partnerAccountLocations.id,
      ],
    }).onDelete("cascade"),
    accountMembershipIdx: index(
      "partner_membership_location_scopes_account_membership_idx",
    ).on(table.partnerAccountId, table.membershipId),
  }),
);

export const partnerMembershipCostCenterScopes = pgTable(
  "partner_membership_cost_center_scopes",
  {
    membershipId: uuid("membership_id").notNull(),
    partnerAccountId: uuid("partner_account_id").notNull(),
    costCenterId: uuid("cost_center_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    primaryKey: primaryKey({
      name: "partner_membership_cost_center_scopes_pk",
      columns: [table.membershipId, table.costCenterId],
    }),
    membershipAccountFk: foreignKey({
      name: "partner_membership_cost_center_scopes_membership_account_fk",
      columns: [table.membershipId, table.partnerAccountId],
      foreignColumns: [
        partnerAccountMemberships.id,
        partnerAccountMemberships.partnerAccountId,
      ],
    }).onDelete("cascade"),
    costCenterAccountFk: foreignKey({
      name: "partner_membership_cost_center_scopes_cost_center_account_fk",
      columns: [table.partnerAccountId, table.costCenterId],
      foreignColumns: [
        partnerAccountCostCenters.partnerAccountId,
        partnerAccountCostCenters.id,
      ],
    }).onDelete("cascade"),
    accountMembershipIdx: index(
      "partner_membership_cost_center_scopes_account_membership_idx",
    ).on(table.partnerAccountId, table.membershipId),
  }),
);

/**
 * The account-safe scope snapshot accepted with an invitation. Acceptance
 * revalidates these rows and copies them to the new membership; client JSON is
 * never trusted as membership authority.
 */
export const partnerInvitationLocationScopes = pgTable(
  "partner_invitation_location_scopes",
  {
    invitationId: uuid("invitation_id").notNull(),
    partnerAccountId: uuid("partner_account_id").notNull(),
    locationId: uuid("location_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    primaryKey: primaryKey({
      name: "partner_invitation_location_scopes_pk",
      columns: [table.invitationId, table.locationId],
    }),
    invitationAccountFk: foreignKey({
      name: "partner_invitation_location_scopes_invitation_account_fk",
      columns: [table.partnerAccountId, table.invitationId],
      foreignColumns: [
        partnerAccountInvitations.partnerAccountId,
        partnerAccountInvitations.id,
      ],
    }).onDelete("cascade"),
    locationAccountFk: foreignKey({
      name: "partner_invitation_location_scopes_location_account_fk",
      columns: [table.partnerAccountId, table.locationId],
      foreignColumns: [
        partnerAccountLocations.partnerAccountId,
        partnerAccountLocations.id,
      ],
    }).onDelete("cascade"),
    accountInvitationIdx: index(
      "partner_invitation_location_scopes_account_invitation_idx",
    ).on(table.partnerAccountId, table.invitationId),
  }),
);

export const partnerInvitationCostCenterScopes = pgTable(
  "partner_invitation_cost_center_scopes",
  {
    invitationId: uuid("invitation_id").notNull(),
    partnerAccountId: uuid("partner_account_id").notNull(),
    costCenterId: uuid("cost_center_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    primaryKey: primaryKey({
      name: "partner_invitation_cost_center_scopes_pk",
      columns: [table.invitationId, table.costCenterId],
    }),
    invitationAccountFk: foreignKey({
      name: "partner_invitation_cost_center_scopes_invitation_account_fk",
      columns: [table.partnerAccountId, table.invitationId],
      foreignColumns: [
        partnerAccountInvitations.partnerAccountId,
        partnerAccountInvitations.id,
      ],
    }).onDelete("cascade"),
    costCenterAccountFk: foreignKey({
      name: "partner_invitation_cost_center_scopes_cost_center_account_fk",
      columns: [table.partnerAccountId, table.costCenterId],
      foreignColumns: [
        partnerAccountCostCenters.partnerAccountId,
        partnerAccountCostCenters.id,
      ],
    }).onDelete("cascade"),
    accountInvitationIdx: index(
      "partner_invitation_cost_center_scopes_account_invitation_idx",
    ).on(table.partnerAccountId, table.invitationId),
  }),
);

export const partnerServiceCatalog = pgTable(
  "partner_service_catalog",
  {
    key: varchar("key", { length: 80 }).primaryKey(),
    label: text("label").notNull(),
    description: text("description").notNull(),
    active: boolean("active").default(true).notNull(),
    instantBookable: boolean("instant_bookable").default(false).notNull(),
    requiredScopeFields: text("required_scope_fields")
      .array()
      .notNull()
      .default([]),
    defaultProofRequirements: jsonb("default_proof_requirements")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({ before: 1, after: 1 }),
    automaticReviewRules: jsonb("automatic_review_rules")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    keyCheck: check(
      "partner_service_catalog_key_check",
      sql`${table.key} ~ '^[a-z][a-z0-9_-]{1,79}$'`,
    ),
    activeIdx: index("partner_service_catalog_active_idx").on(
      table.active,
      table.label,
    ),
  }),
);

export const partnerServiceAddOns = pgTable(
  "partner_service_add_ons",
  {
    key: varchar("key", { length: 80 }).primaryKey(),
    label: text("label").notNull(),
    description: text("description").notNull(),
    unitLabel: varchar("unit_label", { length: 80 }).notNull(),
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
    keyCheck: check(
      "partner_service_add_ons_key_check",
      sql`${table.key} ~ '^[a-z][a-z0-9_-]{1,79}$'`,
    ),
    activeIdx: index("partner_service_add_ons_active_idx").on(
      table.active,
      table.label,
    ),
  }),
);

export const partnerServiceAddOnOptions = pgTable(
  "partner_service_add_on_options",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    serviceKey: varchar("service_key", { length: 80 })
      .notNull()
      .references(() => partnerServiceCatalog.key, { onDelete: "restrict" }),
    addOnKey: varchar("add_on_key", { length: 80 })
      .notNull()
      .references(() => partnerServiceAddOns.key, { onDelete: "restrict" }),
    minimumQuantity: integer("minimum_quantity").default(1).notNull(),
    maximumQuantity: integer("maximum_quantity").default(100).notNull(),
    instantConfirmationMaxQuantity: integer(
      "instant_confirmation_max_quantity",
    ),
    requiresReview: boolean("requires_review").default(false).notNull(),
    active: boolean("active").default(true).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    serviceAddOnKey: uniqueIndex(
      "partner_service_add_on_options_service_add_on_key",
    ).on(table.serviceKey, table.addOnKey),
    serviceActiveIdx: index(
      "partner_service_add_on_options_service_active_idx",
    ).on(table.serviceKey, table.active, table.sortOrder),
    quantityCheck: check(
      "partner_service_add_on_options_quantity_check",
      sql`${table.minimumQuantity} BETWEEN 1 AND 100 AND ${table.maximumQuantity} BETWEEN ${table.minimumQuantity} AND 100`,
    ),
    instantQuantityCheck: check(
      "partner_service_add_on_options_instant_quantity_check",
      sql`${table.instantConfirmationMaxQuantity} IS NULL OR ${table.instantConfirmationMaxQuantity} BETWEEN ${table.minimumQuantity} AND ${table.maximumQuantity}`,
    ),
  }),
);

export const partnerRateAddOnItems = pgTable(
  "partner_rate_add_on_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    rateCardId: uuid("rate_card_id")
      .notNull()
      .references(() => partnerRateCards.id, { onDelete: "cascade" }),
    serviceKey: varchar("service_key", { length: 80 })
      .notNull()
      .references(() => partnerServiceCatalog.key, { onDelete: "restrict" }),
    addOnKey: varchar("add_on_key", { length: 80 })
      .notNull()
      .references(() => partnerServiceAddOns.key, { onDelete: "restrict" }),
    unitAmountCents: integer("unit_amount_cents").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    cardServiceAddOnKey: uniqueIndex(
      "partner_rate_add_on_items_card_service_add_on_key",
    ).on(table.rateCardId, table.serviceKey, table.addOnKey),
    serviceAddOnIdx: index("partner_rate_add_on_items_service_add_on_idx").on(
      table.serviceKey,
      table.addOnKey,
    ),
    amountCheck: check(
      "partner_rate_add_on_items_amount_check",
      sql`${table.unitAmountCents} >= 0`,
    ),
  }),
);

export const scheduleResourcePools = pgTable(
  "schedule_resource_pools",
  {
    key: varchar("key", { length: 64 }).primaryKey(),
    label: text("label").notNull(),
    capacityUnits: integer("capacity_units").notNull(),
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
    capacityCheck: check(
      "schedule_resource_pools_capacity_check",
      sql`${table.capacityUnits} BETWEEN 1 AND 10000`,
    ),
    keyCheck: check(
      "schedule_resource_pools_key_check",
      sql`${table.key} ~ '^[a-z][a-z0-9_-]{0,63}$'`,
    ),
  }),
);

export const partnerSchedulingProfiles = pgTable(
  "partner_scheduling_profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    serviceKey: varchar("service_key", { length: 80 })
      .notNull()
      .references(() => partnerServiceCatalog.key, { onDelete: "restrict" }),
    version: integer("version").default(1).notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    travelBufferMinutes: integer("travel_buffer_minutes").notNull(),
    capacityPoolKey: varchar("capacity_pool_key", { length: 64 })
      .notNull()
      .references(() => scheduleResourcePools.key, { onDelete: "restrict" }),
    capacityUnits: integer("capacity_units").default(1).notNull(),
    supportedTerritories: text("supported_territories")
      .array()
      .notNull()
      .default([]),
    requiredScopeFields: text("required_scope_fields")
      .array()
      .notNull()
      .default([]),
    pricingEligibility: jsonb("pricing_eligibility")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    proofDefaults: jsonb("proof_defaults")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({ before: 1, after: 1 }),
    automaticReviewRules: jsonb("automatic_review_rules")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    instantConfirmationEnabled: boolean("instant_confirmation_enabled")
      .default(false)
      .notNull(),
    active: boolean("active").default(true).notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true })
      .defaultNow()
      .notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    serviceVersionKey: uniqueIndex(
      "partner_scheduling_profiles_service_version_key",
    ).on(table.serviceKey, table.version),
    effectiveIdx: index("partner_scheduling_profiles_effective_idx").on(
      table.serviceKey,
      table.active,
      table.effectiveFrom,
      table.effectiveTo,
    ),
    versionCheck: check(
      "partner_scheduling_profiles_version_check",
      sql`${table.version} > 0`,
    ),
    durationCheck: check(
      "partner_scheduling_profiles_duration_check",
      sql`${table.durationMinutes} BETWEEN 15 AND 1440`,
    ),
    bufferCheck: check(
      "partner_scheduling_profiles_buffer_check",
      sql`${table.travelBufferMinutes} BETWEEN 0 AND 1440`,
    ),
    unitsCheck: check(
      "partner_scheduling_profiles_units_check",
      sql`${table.capacityUnits} BETWEEN 1 AND 100`,
    ),
    effectiveRangeCheck: check(
      "partner_scheduling_profiles_effective_range_check",
      sql`${table.effectiveTo} IS NULL OR ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
  }),
);

export const scheduleResources = pgTable(
  "schedule_resources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    capacityPoolKey: varchar("capacity_pool_key", { length: 64 })
      .notNull()
      .references(() => scheduleResourcePools.key, { onDelete: "restrict" }),
    kind: text("kind").$type<"crew" | "truck" | "equipment">().notNull(),
    label: text("label").notNull(),
    capacityUnits: integer("capacity_units").notNull(),
    skillKeys: text("skill_keys").array().notNull().default([]),
    active: boolean("active").default(true).notNull(),
    source: text("source")
      .$type<"staff" | "compatibility_pool">()
      .default("staff")
      .notNull(),
    sourceKey: text("source_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    sourceKeyIndex: uniqueIndex("schedule_resources_source_key")
      .on(table.sourceKey)
      .where(sql`${table.sourceKey} IS NOT NULL`),
    poolKindActiveIdx: index("schedule_resources_pool_kind_active_idx").on(
      table.capacityPoolKey,
      table.kind,
      table.active,
      table.label,
      table.id,
    ),
    kindCheck: check(
      "schedule_resources_kind_check",
      sql`${table.kind} IN ('crew', 'truck', 'equipment')`,
    ),
    labelCheck: check(
      "schedule_resources_label_check",
      sql`${table.label} = btrim(${table.label}) AND length(${table.label}) BETWEEN 1 AND 160`,
    ),
    capacityCheck: check(
      "schedule_resources_capacity_check",
      sql`${table.capacityUnits} BETWEEN 1 AND 10000`,
    ),
    sourceCheck: check(
      "schedule_resources_source_check",
      sql`${table.source} IN ('staff', 'compatibility_pool')`,
    ),
    sourceKeyCheck: check(
      "schedule_resources_source_key_check",
      sql`(${table.source} = 'staff' AND ${table.sourceKey} IS NULL) OR (${table.source} = 'compatibility_pool' AND ${table.sourceKey} ~ '^pool:[a-z][a-z0-9_-]{0,63}:(crew|truck)$')`,
    ),
    skillKeysCheck: check(
      "schedule_resources_skill_keys_check",
      sql`cardinality(${table.skillKeys}) <= 50 AND array_position(${table.skillKeys}, NULL) IS NULL`,
    ),
  }),
);

export const partnerSchedulingProfileResourceRequirements = pgTable(
  "partner_scheduling_profile_resource_requirements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    schedulingProfileId: uuid("scheduling_profile_id")
      .notNull()
      .references(() => partnerSchedulingProfiles.id, { onDelete: "cascade" }),
    resourceKind: text("resource_kind")
      .$type<"crew" | "truck" | "equipment">()
      .notNull(),
    quantity: integer("quantity").default(1).notNull(),
    capacityUnits: integer("capacity_units").default(1).notNull(),
    requiredSkillKeys: text("required_skill_keys")
      .array()
      .notNull()
      .default([]),
    source: text("source")
      .$type<"staff" | "compatibility_pool">()
      .default("staff")
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    profileKindKey: uniqueIndex(
      "partner_profile_resource_requirements_kind_key",
    ).on(table.schedulingProfileId, table.resourceKind),
    profileIdx: index("partner_profile_resource_requirements_profile_idx").on(
      table.schedulingProfileId,
      table.resourceKind,
      table.id,
    ),
    kindCheck: check(
      "partner_profile_resource_requirements_kind_check",
      sql`${table.resourceKind} IN ('crew', 'truck', 'equipment')`,
    ),
    quantityCheck: check(
      "partner_profile_resource_requirements_quantity_check",
      sql`${table.quantity} BETWEEN 1 AND 20`,
    ),
    capacityCheck: check(
      "partner_profile_resource_requirements_capacity_check",
      sql`${table.capacityUnits} BETWEEN 1 AND 100`,
    ),
    sourceCheck: check(
      "partner_profile_resource_requirements_source_check",
      sql`${table.source} IN ('staff', 'compatibility_pool')`,
    ),
    skillKeysCheck: check(
      "partner_profile_resource_requirements_skill_keys_check",
      sql`cardinality(${table.requiredSkillKeys}) <= 50 AND array_position(${table.requiredSkillKeys}, NULL) IS NULL`,
    ),
  }),
);

/**
 * Account-specific constraints for Partner self-service scheduling. These
 * values are narrowing inputs only: the scheduling domain combines them with
 * Stonegate's global Partner channel by max/max/min/AND precedence and never
 * uses them to expand hours, capacity, notice, horizon, or confirmation.
 */
export const partnerAccountSchedulingPolicies = pgTable(
  "partner_account_scheduling_policies",
  {
    partnerAccountId: uuid("partner_account_id")
      .primaryKey()
      .references(() => partnerAccounts.id, { onDelete: "cascade" }),
    minimumNoticeMinutes: integer("minimum_notice_minutes")
      .default(0)
      .notNull(),
    minimumCalendarLeadDays: integer("minimum_calendar_lead_days")
      .default(1)
      .notNull(),
    maximumBookingHorizonDays: integer("maximum_booking_horizon_days")
      .default(30)
      .notNull(),
    instantConfirmationEnabled: boolean("instant_confirmation_enabled")
      .default(false)
      .notNull(),
    revision: integer("revision").default(1).notNull(),
    lastChangedByTeamMemberId: uuid(
      "last_changed_by_team_member_id",
    ).references(() => teamMembers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      precision: 3,
    })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    noticeCheck: check(
      "partner_account_scheduling_policies_notice_check",
      sql`${table.minimumNoticeMinutes} BETWEEN 0 AND 10080`,
    ),
    leadDaysCheck: check(
      "partner_account_scheduling_policies_lead_days_check",
      sql`${table.minimumCalendarLeadDays} BETWEEN 1 AND 30`,
    ),
    horizonCheck: check(
      "partner_account_scheduling_policies_horizon_check",
      sql`${table.maximumBookingHorizonDays} BETWEEN 1 AND 30`,
    ),
    revisionCheck: check(
      "partner_account_scheduling_policies_revision_check",
      sql`${table.revision} > 0`,
    ),
    changedByIdx: index(
      "partner_account_scheduling_policies_changed_by_idx",
    ).on(table.lastChangedByTeamMemberId, table.updatedAt),
  }),
);

/**
 * Account-specific constraints for Partner cancellation. The account notice
 * is combined with Stonegate's global notice using max precedence, and direct
 * cancellation is combined using logical AND. Late requests always remain
 * scheduled for staff review and this launch policy never applies a fee.
 */
export const partnerAccountCancellationPolicies = pgTable(
  "partner_account_cancellation_policies",
  {
    partnerAccountId: uuid("partner_account_id")
      .primaryKey()
      .references(() => partnerAccounts.id, { onDelete: "cascade" }),
    minimumNoticeMinutes: integer("minimum_notice_minutes")
      .default(1_440)
      .notNull(),
    directCancellationEnabled: boolean("direct_cancellation_enabled")
      .default(true)
      .notNull(),
    lateCancellationDisposition: text("late_cancellation_disposition")
      .$type<"staff_review">()
      .default("staff_review")
      .notNull(),
    automaticFeeMinor: integer("automatic_fee_minor"),
    revision: integer("revision").default(1).notNull(),
    lastChangedByTeamMemberId: uuid(
      "last_changed_by_team_member_id",
    ).references(() => teamMembers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      precision: 3,
    })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    noticeCheck: check(
      "partner_account_cancellation_policies_notice_check",
      sql`${table.minimumNoticeMinutes} BETWEEN 1440 AND 525600`,
    ),
    lateDispositionCheck: check(
      "partner_account_cancellation_policies_late_disposition_check",
      sql`${table.lateCancellationDisposition} = 'staff_review'`,
    ),
    noAutomaticFeeCheck: check(
      "partner_account_cancellation_policies_no_automatic_fee_check",
      sql`${table.automaticFeeMinor} IS NULL`,
    ),
    revisionCheck: check(
      "partner_account_cancellation_policies_revision_check",
      sql`${table.revision} > 0`,
    ),
    changedByIdx: index(
      "partner_account_cancellation_policies_changed_by_idx",
    ).on(table.lastChangedByTeamMemberId, table.updatedAt),
  }),
);

export const scheduleDateOverrides = pgTable(
  "schedule_date_overrides",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    localDate: date("local_date").notNull(),
    timezone: text("timezone").default("America/New_York").notNull(),
    closed: boolean("closed").default(false).notNull(),
    windows: jsonb("windows")
      .$type<Array<{ startMinute: number; endMinute: number }>>()
      .notNull()
      .default([]),
    capacityByPool: jsonb("capacity_by_pool")
      .$type<Record<string, number>>()
      .notNull()
      .default({}),
    reason: text("reason").notNull(),
    revision: integer("revision").default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    localDateKey: uniqueIndex("schedule_date_overrides_local_date_key").on(
      table.localDate,
      table.timezone,
    ),
    revisionCheck: check(
      "schedule_date_overrides_revision_check",
      sql`${table.revision} > 0`,
    ),
  }),
);

export const scheduleBlocks = pgTable(
  "schedule_blocks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    kind: text("kind").notNull(),
    source: text("source").notNull(),
    sourceKey: text("source_key"),
    capacityPoolKey: varchar("capacity_pool_key", { length: 64 })
      .notNull()
      .references(() => scheduleResourcePools.key, { onDelete: "restrict" }),
    capacityUnits: integer("capacity_units").notNull(),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }).notNull(),
    active: boolean("active").default(true).notNull(),
    mirroredAppointmentId: uuid("mirrored_appointment_id").references(
      () => appointments.id,
      { onDelete: "set null" },
    ),
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
    sourceKey: uniqueIndex("schedule_blocks_source_key")
      .on(table.source, table.sourceKey)
      .where(sql`${table.sourceKey} IS NOT NULL`),
    occupancyIdx: index("schedule_blocks_occupancy_idx").on(
      table.capacityPoolKey,
      table.active,
      table.startAt,
      table.endAt,
    ),
    kindCheck: check(
      "schedule_blocks_kind_check",
      sql`${table.kind} IN ('external_busy', 'blackout', 'resource_unavailable', 'capacity_adjustment')`,
    ),
    rangeCheck: check(
      "schedule_blocks_range_check",
      sql`${table.endAt} > ${table.startAt}`,
    ),
    unitsCheck: check(
      "schedule_blocks_units_check",
      sql`${table.capacityUnits} BETWEEN 1 AND 10000`,
    ),
  }),
);

export const partnerBookingDrafts = pgTable(
  "partner_booking_drafts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "cascade" }),
    createdByMembershipId: uuid("created_by_membership_id")
      .notNull()
      .references(() => partnerAccountMemberships.id, {
        onDelete: "restrict",
      }),
    // The migration installs an account-bound composite FK after both account
    // uniqueness keys exist, preventing cross-tenant reschedule references.
    rescheduleFromPartnerBookingId: uuid("reschedule_from_partner_booking_id"),
    locationId: uuid("location_id").references(
      () => partnerAccountLocations.id,
      { onDelete: "restrict" },
    ),
    serviceKey: varchar("service_key", { length: 80 }).references(
      () => partnerServiceCatalog.key,
      { onDelete: "restrict" },
    ),
    tierKey: varchar("tier_key", { length: 100 }),
    selectedAddOns: jsonb("selected_add_ons")
      .$type<Array<{ key: string; quantity: number }>>()
      .notNull()
      .default([]),
    state: text("state").default("draft").notNull(),
    scope: jsonb("scope")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    description: text("description"),
    crewInstructions: text("crew_instructions"),
    accessDetails: text("access_details"),
    onSiteContact: jsonb("on_site_contact").$type<Record<
      string,
      unknown
    > | null>(),
    proofRequirements: jsonb("proof_requirements")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({ before: 1, after: 1 }),
    commercial: jsonb("commercial")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    preferredWindows: jsonb("preferred_windows")
      .$type<Array<Record<string, unknown>>>()
      .notNull()
      .default([]),
    scheduleAssistancePreference: text("schedule_assistance_preference")
      .$type<"none" | "waitlist" | "callback">()
      .default("none")
      .notNull(),
    reviewReasons: text("review_reasons").array().notNull().default([]),
    validation: jsonb("validation")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    revision: integer("revision").default(1).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    accountStateIdx: index("partner_booking_drafts_account_state_idx").on(
      table.partnerAccountId,
      table.state,
      table.updatedAt,
      table.id,
    ),
    accountDraftKey: uniqueIndex("partner_booking_drafts_account_draft_key").on(
      table.partnerAccountId,
      table.id,
    ),
    creatorIdx: index("partner_booking_drafts_creator_idx").on(
      table.createdByMembershipId,
      table.state,
    ),
    activeRescheduleKey: uniqueIndex(
      "partner_booking_drafts_active_reschedule_key",
    )
      .on(table.partnerAccountId, table.rescheduleFromPartnerBookingId)
      .where(
        sql`${table.rescheduleFromPartnerBookingId} IS NOT NULL AND ${table.state} IN ('draft', 'ready')`,
      ),
    revisionCheck: check(
      "partner_booking_drafts_revision_check",
      sql`${table.revision} > 0`,
    ),
    stateCheck: check(
      "partner_booking_drafts_state_check",
      sql`${table.state} IN ('draft', 'ready', 'submitted', 'abandoned', 'expired')`,
    ),
    scheduleAssistanceCheck: check(
      "partner_booking_drafts_schedule_assistance_check",
      sql`${table.scheduleAssistancePreference} IN ('none', 'waitlist', 'callback')`,
    ),
  }),
);

export type PartnerScheduleAssistanceWindowsSnapshot = Readonly<{
  version: 1;
  windows: ReadonlyArray<
    Readonly<{
      localDate: string;
      timeOfDay: "morning" | "afternoon" | "anytime";
      timezone: string;
    }>
  >;
}>;

export const partnerScheduleAssistanceRequests = pgTable(
  "partner_schedule_assistance_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "restrict" }),
    partnerBookingId: uuid("partner_booking_id").notNull(),
    bookingDraftId: uuid("booking_draft_id").notNull(),
    requestedByMembershipId: uuid("requested_by_membership_id").notNull(),
    preference: text("preference").$type<"waitlist" | "callback">().notNull(),
    state: text("state")
      .$type<"pending" | "contacted" | "fulfilled" | "canceled">()
      .default("pending")
      .notNull(),
    preferredWindowsSnapshot: jsonb("preferred_windows_snapshot")
      .$type<PartnerScheduleAssistanceWindowsSnapshot>()
      .notNull(),
    operationKeyHash: varchar("operation_key_hash", { length: 64 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    revision: integer("revision").default(1).notNull(),
    resolvedByTeamMemberId: uuid("resolved_by_team_member_id").references(
      () => teamMembers.id,
      { onDelete: "restrict" },
    ),
    resolutionNote: text("resolution_note"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    bookingAccountFk: foreignKey({
      columns: [table.partnerAccountId, table.partnerBookingId],
      foreignColumns: [partnerBookings.partnerAccountId, partnerBookings.id],
      name: "partner_schedule_assistance_booking_account_fk",
    }).onDelete("cascade"),
    draftAccountFk: foreignKey({
      columns: [table.partnerAccountId, table.bookingDraftId],
      foreignColumns: [
        partnerBookingDrafts.partnerAccountId,
        partnerBookingDrafts.id,
      ],
      name: "partner_schedule_assistance_draft_account_fk",
    }).onDelete("restrict"),
    requesterAccountFk: foreignKey({
      columns: [table.requestedByMembershipId, table.partnerAccountId],
      foreignColumns: [
        partnerAccountMemberships.id,
        partnerAccountMemberships.partnerAccountId,
      ],
      name: "partner_schedule_assistance_requester_account_fk",
    }).onDelete("restrict"),
    bookingKey: uniqueIndex("partner_schedule_assistance_booking_key").on(
      table.partnerAccountId,
      table.partnerBookingId,
    ),
    operationKey: uniqueIndex("partner_schedule_assistance_operation_key").on(
      table.partnerAccountId,
      table.operationKeyHash,
    ),
    queueIdx: index("partner_schedule_assistance_queue_idx").on(
      table.state,
      table.createdAt,
      table.id,
    ),
    preferenceCheck: check(
      "partner_schedule_assistance_preference_check",
      sql`${table.preference} IN ('waitlist', 'callback')`,
    ),
    stateCheck: check(
      "partner_schedule_assistance_state_check",
      sql`${table.state} IN ('pending', 'contacted', 'fulfilled', 'canceled')`,
    ),
    windowsCheck: check(
      "partner_schedule_assistance_windows_check",
      sql`jsonb_typeof(${table.preferredWindowsSnapshot}) = 'object' AND ${table.preferredWindowsSnapshot} ->> 'version' = '1' AND jsonb_typeof(${table.preferredWindowsSnapshot} -> 'windows') = 'array' AND jsonb_array_length(${table.preferredWindowsSnapshot} -> 'windows') BETWEEN 1 AND 3`,
    ),
    operationHashCheck: check(
      "partner_schedule_assistance_operation_hash_check",
      sql`${table.operationKeyHash} ~ '^[0-9a-f]{64}$'`,
    ),
    requestHashCheck: check(
      "partner_schedule_assistance_request_hash_check",
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    revisionCheck: check(
      "partner_schedule_assistance_revision_check",
      sql`${table.revision} > 0`,
    ),
    resolutionCheck: check(
      "partner_schedule_assistance_resolution_check",
      sql`(${table.state} = 'pending' AND ${table.resolvedByTeamMemberId} IS NULL AND ${table.resolutionNote} IS NULL AND ${table.resolvedAt} IS NULL) OR (${table.state} <> 'pending' AND ${table.resolvedByTeamMemberId} IS NOT NULL AND length(btrim(${table.resolutionNote})) BETWEEN 5 AND 1000 AND ${table.resolvedAt} IS NOT NULL)`,
    ),
  }),
);

export const partnerRescheduleRequests = pgTable(
  "partner_reschedule_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "restrict" }),
    // Composite account/resource FKs are installed by migration 0116.
    partnerBookingId: uuid("partner_booking_id").notNull(),
    bookingDraftId: uuid("booking_draft_id").notNull(),
    state: text("state").default("pending").notNull(),
    proposedStartAt: timestamp("proposed_start_at", {
      withTimezone: true,
    }).notNull(),
    requestedArrivalStartAt: timestamp("requested_arrival_start_at", {
      withTimezone: true,
    }).notNull(),
    requestedArrivalEndAt: timestamp("requested_arrival_end_at", {
      withTimezone: true,
    }).notNull(),
    previousStartAt: timestamp("previous_start_at", {
      withTimezone: true,
    }).notNull(),
    previousArrivalStartAt: timestamp("previous_arrival_start_at", {
      withTimezone: true,
    }),
    previousArrivalEndAt: timestamp("previous_arrival_end_at", {
      withTimezone: true,
    }),
    reviewReasons: text("review_reasons").array().notNull().default([]),
    operationKeyHash: varchar("operation_key_hash", { length: 64 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    createdByMembershipId: uuid("created_by_membership_id")
      .notNull()
      .references(() => partnerAccountMemberships.id, {
        onDelete: "restrict",
      }),
    resolvedByTeamMemberId: uuid("resolved_by_team_member_id").references(
      () => teamMembers.id,
      { onDelete: "set null" },
    ),
    resolutionReason: text("resolution_reason"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    accountRequestKey: uniqueIndex(
      "partner_reschedule_requests_account_request_key",
    ).on(table.partnerAccountId, table.id),
    operationKey: uniqueIndex(
      "partner_reschedule_requests_operation_key_hash_key",
    ).on(table.operationKeyHash),
    pendingBookingKey: uniqueIndex(
      "partner_reschedule_requests_pending_booking_key",
    )
      .on(table.partnerAccountId, table.partnerBookingId)
      .where(sql`${table.state} = 'pending'`),
    accountStateIdx: index("partner_reschedule_requests_account_state_idx").on(
      table.partnerAccountId,
      table.state,
      table.createdAt,
      table.id,
    ),
    stateCheck: check(
      "partner_reschedule_requests_state_check",
      sql`${table.state} IN ('pending', 'accepted', 'declined', 'withdrawn', 'superseded')`,
    ),
    requestedWindowCheck: check(
      "partner_reschedule_requests_window_check",
      sql`${table.requestedArrivalEndAt} > ${table.requestedArrivalStartAt}`,
    ),
    previousWindowCheck: check(
      "partner_reschedule_requests_previous_window_check",
      sql`(${table.previousArrivalStartAt} IS NULL AND ${table.previousArrivalEndAt} IS NULL) OR (${table.previousArrivalStartAt} IS NOT NULL AND ${table.previousArrivalEndAt} > ${table.previousArrivalStartAt})`,
    ),
    operationHashCheck: check(
      "partner_reschedule_requests_operation_hash_check",
      sql`${table.operationKeyHash} ~ '^[0-9a-f]{64}$'`,
    ),
    requestHashCheck: check(
      "partner_reschedule_requests_request_hash_check",
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    resolutionCheck: check(
      "partner_reschedule_requests_resolution_check",
      sql`(${table.state} = 'pending' AND ${table.resolvedAt} IS NULL AND ${table.resolvedByTeamMemberId} IS NULL AND ${table.resolutionReason} IS NULL) OR (${table.state} <> 'pending' AND ${table.resolvedAt} IS NOT NULL AND ${table.resolutionReason} IS NOT NULL)`,
    ),
  }),
);

export type PartnerCancellationRequestSnapshot = Readonly<{
  version: 1;
  requestedAt: string;
  job: Readonly<{
    publicStatus: string;
    appointmentStatus: string;
    bookingVersion: number;
  }>;
  schedule: Readonly<{
    promisedArrivalStartAt: string | null;
    promisedArrivalEndAt: string | null;
    timezone: string;
  }>;
  policy: Readonly<{
    cutoffMinutes: number;
    directCancellationEnabled: boolean;
    lateCancellationDisposition: "staff_review";
    automaticFeeMinor: null;
    source: "launch_default" | "configured" | "unconfigured";
    revision: number | null;
    deadlineAt: string | null;
    decisionReasonCode: string;
  }>;
}>;

/**
 * Durable Partner cancellation-review requests. Request evidence is immutable;
 * only the state/revision and bounded Staff resolution evidence may change.
 * Composite foreign keys are installed by migration 0149.
 */
export const partnerCancellationRequests = pgTable(
  "partner_cancellation_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "restrict" }),
    partnerBookingId: uuid("partner_booking_id").notNull(),
    requestedByMembershipId: uuid("requested_by_membership_id").notNull(),
    state: text("state")
      .$type<"pending" | "approved" | "declined">()
      .default("pending")
      .notNull(),
    reason: text("reason").notNull(),
    requestSnapshot: jsonb("request_snapshot")
      .$type<PartnerCancellationRequestSnapshot>()
      .notNull(),
    operationKeyHash: varchar("operation_key_hash", { length: 64 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    revision: integer("revision").default(1).notNull(),
    resolvedByTeamMemberId: uuid("resolved_by_team_member_id").references(
      () => teamMembers.id,
      { onDelete: "restrict" },
    ),
    resolutionReason: text("resolution_reason"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    accountRequestKey: uniqueIndex(
      "partner_cancellation_requests_account_request_key",
    ).on(table.partnerAccountId, table.id),
    accountOperationKey: uniqueIndex(
      "partner_cancellation_requests_account_operation_key",
    ).on(table.partnerAccountId, table.operationKeyHash),
    pendingBookingKey: uniqueIndex(
      "partner_cancellation_requests_pending_booking_key",
    )
      .on(table.partnerAccountId, table.partnerBookingId)
      .where(sql`${table.state} = 'pending'`),
    accountStateIdx: index(
      "partner_cancellation_requests_account_state_idx",
    ).on(table.partnerAccountId, table.state, table.createdAt, table.id),
    stateCheck: check(
      "partner_cancellation_requests_state_check",
      sql`${table.state} IN ('pending', 'approved', 'declined')`,
    ),
    reasonCheck: check(
      "partner_cancellation_requests_reason_check",
      sql`${table.reason} = btrim(${table.reason}) AND length(${table.reason}) BETWEEN 5 AND 1000`,
    ),
    snapshotCheck: check(
      "partner_cancellation_requests_snapshot_check",
      sql`jsonb_typeof(${table.requestSnapshot}) = 'object' AND ${table.requestSnapshot} ->> 'version' = '1'`,
    ),
    operationHashCheck: check(
      "partner_cancellation_requests_operation_hash_check",
      sql`${table.operationKeyHash} ~ '^[0-9a-f]{64}$'`,
    ),
    requestHashCheck: check(
      "partner_cancellation_requests_request_hash_check",
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    revisionCheck: check(
      "partner_cancellation_requests_revision_check",
      sql`${table.revision} > 0`,
    ),
    resolutionCheck: check(
      "partner_cancellation_requests_resolution_check",
      sql`(${table.state} = 'pending' AND ${table.resolvedByTeamMemberId} IS NULL AND ${table.resolutionReason} IS NULL AND ${table.resolvedAt} IS NULL) OR (${table.state} IN ('approved', 'declined') AND ${table.resolvedByTeamMemberId} IS NOT NULL AND ${table.resolutionReason} IS NOT NULL AND length(btrim(${table.resolutionReason})) BETWEEN 12 AND 1000 AND ${table.resolvedAt} IS NOT NULL)`,
    ),
  }),
);

/**
 * Read-only quarantine evidence for pre-0149 hash-based review rows. These are
 * deliberately not promoted into actionable requests without reconciliation.
 */
export const partnerCancellationRequestReconciliationCases = pgTable(
  "partner_cancellation_request_reconciliation_cases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id").references(
      () => partnerAccounts.id,
      { onDelete: "restrict" },
    ),
    partnerBookingId: uuid("partner_booking_id")
      .notNull()
      .references(() => partnerBookings.id, { onDelete: "restrict" }),
    legacyOperationKeyHash: varchar("legacy_operation_key_hash", {
      length: 64,
    }),
    legacyRequestHash: varchar("legacy_request_hash", { length: 64 }),
    reasonCode: text("reason_code").notNull(),
    evidenceSnapshot: jsonb("evidence_snapshot")
      .$type<Record<string, unknown>>()
      .notNull(),
    state: text("state").$type<"open">().default("open").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    bookingKey: uniqueIndex(
      "partner_cancellation_request_reconciliation_booking_key",
    ).on(table.partnerBookingId),
    accountStateIdx: index(
      "partner_cancellation_request_reconciliation_account_state_idx",
    ).on(table.partnerAccountId, table.state, table.createdAt, table.id),
    stateCheck: check(
      "partner_cancellation_request_reconciliation_state_check",
      sql`${table.state} = 'open'`,
    ),
    reasonCheck: check(
      "partner_cancellation_request_reconciliation_reason_check",
      sql`${table.reasonCode} IN ('legacy_cancellation_review_requires_reconciliation', 'legacy_cancellation_review_hash_pair_invalid', 'legacy_cancellation_review_tenant_unresolved')`,
    ),
    hashCheck: check(
      "partner_cancellation_request_reconciliation_hash_check",
      sql`(${table.legacyOperationKeyHash} IS NOT NULL OR ${table.legacyRequestHash} IS NOT NULL) AND (${table.legacyOperationKeyHash} IS NULL OR ${table.legacyOperationKeyHash} ~ '^[0-9a-f]{64}$') AND (${table.legacyRequestHash} IS NULL OR ${table.legacyRequestHash} ~ '^[0-9a-f]{64}$')`,
    ),
    evidenceCheck: check(
      "partner_cancellation_request_reconciliation_evidence_check",
      sql`jsonb_typeof(${table.evidenceSnapshot}) = 'object' AND ${table.evidenceSnapshot} ->> 'version' = '1'`,
    ),
  }),
);

export type PartnerJobChangeProposedChanges = Readonly<{
  version: 1;
  description?: string | null;
  crewInstructions?: string | null;
  accessDetails?: string | null;
  onSiteContact?: Readonly<Record<string, string | null>> | null;
  materiality: Readonly<{
    price: boolean;
    schedule: boolean;
    service: boolean;
    quantity: boolean;
    hazards: boolean;
    proof: boolean;
  }>;
}>;

export type PartnerJobChangeRequestDbSnapshot = Readonly<{
  version: 1;
  requestedAt: string;
  job: Readonly<{
    publicStatus: string;
    appointmentStatus: string;
    bookingRevision: number;
  }>;
  current: Readonly<{
    description: string | null;
    crewInstructions: string | null;
    accessDetails: string | null;
    onSiteContact: Readonly<Record<string, string | null>> | null;
  }>;
  proposed: Omit<PartnerJobChangeProposedChanges, "version">;
}>;

export type PartnerJobChangeResolutionSnapshot =
  | Readonly<{
      version: 1;
      outcome: "approved" | "declined" | "change_order_required";
      appliedFields: readonly string[];
      bookingRevisionBefore: number;
      bookingRevisionAfter: number;
    }>
  | Readonly<{
      version: 1;
      outcome: "superseded";
      actorType: "system" | "staff";
      trigger: "partner_direct_cancellation" | "staff_approved_cancellation";
      triggeringMembershipId?: string;
      bookingRevisionBefore: number;
      bookingRevisionAfter: number;
    }>;

/**
 * Account-owned Partner job change requests. The migration installs composite
 * tenant FKs and an immutable-evidence/one-way-resolution trigger.
 */
export const partnerJobChangeRequests = pgTable(
  "partner_job_change_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "restrict" }),
    partnerBookingId: uuid("partner_booking_id").notNull(),
    requestedByMembershipId: uuid("requested_by_membership_id").notNull(),
    state: text("state")
      .$type<
        | "pending"
        | "approved"
        | "declined"
        | "change_order_required"
        | "superseded"
      >()
      .default("pending")
      .notNull(),
    reason: text("reason").notNull(),
    proposedChanges: jsonb("proposed_changes")
      .$type<PartnerJobChangeProposedChanges>()
      .notNull(),
    requestSnapshot: jsonb("request_snapshot")
      .$type<PartnerJobChangeRequestDbSnapshot>()
      .notNull(),
    baseBookingRevision: integer("base_booking_revision").notNull(),
    operationKeyHash: varchar("operation_key_hash", { length: 64 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    revision: integer("revision").default(1).notNull(),
    resolvedByTeamMemberId: uuid("resolved_by_team_member_id").references(
      () => teamMembers.id,
      { onDelete: "restrict" },
    ),
    resolutionReason: text("resolution_reason"),
    resolutionSnapshot: jsonb(
      "resolution_snapshot",
    ).$type<PartnerJobChangeResolutionSnapshot | null>(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    bookingAccountFk: foreignKey({
      columns: [table.partnerAccountId, table.partnerBookingId],
      foreignColumns: [partnerBookings.partnerAccountId, partnerBookings.id],
      name: "partner_job_change_requests_booking_account_fk",
    }).onDelete("cascade"),
    requesterAccountFk: foreignKey({
      columns: [table.requestedByMembershipId, table.partnerAccountId],
      foreignColumns: [
        partnerAccountMemberships.id,
        partnerAccountMemberships.partnerAccountId,
      ],
      name: "partner_job_change_requests_requester_account_fk",
    }).onDelete("restrict"),
    accountRequestKey: uniqueIndex(
      "partner_job_change_requests_account_request_key",
    ).on(table.partnerAccountId, table.id),
    accountBookingRequestKey: uniqueIndex(
      "partner_job_change_requests_account_booking_request_key",
    ).on(table.partnerAccountId, table.partnerBookingId, table.id),
    accountOperationKey: uniqueIndex(
      "partner_job_change_requests_account_operation_key",
    ).on(table.partnerAccountId, table.operationKeyHash),
    pendingBookingKey: uniqueIndex(
      "partner_job_change_requests_pending_booking_key",
    )
      .on(table.partnerAccountId, table.partnerBookingId)
      .where(sql`${table.state} = 'pending'`),
    accountStateIdx: index("partner_job_change_requests_account_state_idx").on(
      table.partnerAccountId,
      table.state,
      table.createdAt,
      table.id,
    ),
    stateCheck: check(
      "partner_job_change_requests_state_check",
      sql`${table.state} IN ('pending', 'approved', 'declined', 'change_order_required', 'superseded')`,
    ),
    reasonCheck: check(
      "partner_job_change_requests_reason_check",
      sql`${table.reason} = btrim(${table.reason}) AND length(${table.reason}) BETWEEN 5 AND 1000`,
    ),
    proposedCheck: check(
      "partner_job_change_requests_proposed_check",
      sql`jsonb_typeof(${table.proposedChanges}) = 'object' AND ${table.proposedChanges} ->> 'version' = '1' AND jsonb_typeof(${table.proposedChanges} -> 'materiality') = 'object'`,
    ),
    snapshotCheck: check(
      "partner_job_change_requests_snapshot_check",
      sql`jsonb_typeof(${table.requestSnapshot}) = 'object' AND ${table.requestSnapshot} ->> 'version' = '1'`,
    ),
    baseRevisionCheck: check(
      "partner_job_change_requests_base_revision_check",
      sql`${table.baseBookingRevision} > 0`,
    ),
    operationHashCheck: check(
      "partner_job_change_requests_operation_hash_check",
      sql`${table.operationKeyHash} ~ '^[0-9a-f]{64}$'`,
    ),
    requestHashCheck: check(
      "partner_job_change_requests_request_hash_check",
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    revisionCheck: check(
      "partner_job_change_requests_revision_check",
      sql`${table.revision} > 0`,
    ),
    resolutionCheck: check(
      "partner_job_change_requests_resolution_check",
      sql`(${table.state} = 'pending' AND ${table.resolvedByTeamMemberId} IS NULL AND ${table.resolutionReason} IS NULL AND ${table.resolutionSnapshot} IS NULL AND ${table.resolvedAt} IS NULL) OR (${table.state} IN ('approved', 'declined', 'change_order_required') AND ${table.resolvedByTeamMemberId} IS NOT NULL AND ${table.resolutionReason} IS NOT NULL AND length(btrim(${table.resolutionReason})) BETWEEN 12 AND 1000 AND jsonb_typeof(${table.resolutionSnapshot}) = 'object' AND ${table.resolutionSnapshot} ->> 'version' = '1' AND ${table.resolutionSnapshot} ->> 'outcome' = ${table.state} AND ${table.resolvedAt} IS NOT NULL) OR (${table.state} = 'superseded' AND ${table.resolutionReason} IS NOT NULL AND length(btrim(${table.resolutionReason})) BETWEEN 12 AND 1000 AND jsonb_typeof(${table.resolutionSnapshot}) = 'object' AND ${table.resolutionSnapshot} ->> 'version' = '1' AND ${table.resolutionSnapshot} ->> 'outcome' = 'superseded' AND ${table.resolutionSnapshot} ->> 'trigger' IN ('partner_direct_cancellation', 'staff_approved_cancellation') AND ((${table.resolutionSnapshot} ->> 'actorType' = 'system' AND ${table.resolutionSnapshot} ->> 'trigger' = 'partner_direct_cancellation' AND ${table.resolvedByTeamMemberId} IS NULL) OR (${table.resolutionSnapshot} ->> 'actorType' = 'staff' AND ${table.resolutionSnapshot} ->> 'trigger' = 'staff_approved_cancellation' AND ${table.resolvedByTeamMemberId} IS NOT NULL)) AND ${table.resolvedAt} IS NOT NULL)`,
    ),
  }),
);

export const partnerMediaMutationOperations = pgTable(
  "partner_media_mutation_operations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "cascade" }),
    actorMembershipId: uuid("actor_membership_id").notNull(),
    action: varchar("action", { length: 64 }).notNull(),
    idempotencyKeyHash: varchar("idempotency_key_hash", {
      length: 64,
    }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    parentKind: text("parent_kind").notNull(),
    parentId: uuid("parent_id").notNull(),
    associationId: uuid("association_id").notNull(),
    status: text("status").default("in_progress").notNull(),
    claimToken: uuid("claim_token").notNull(),
    claimExpiresAt: timestamp("claim_expires_at", {
      withTimezone: true,
    }).notNull(),
    attemptCount: integer("attempt_count").default(1).notNull(),
    lastErrorCode: varchar("last_error_code", { length: 80 }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    actorAccountFk: foreignKey({
      columns: [table.actorMembershipId, table.partnerAccountId],
      foreignColumns: [
        partnerAccountMemberships.id,
        partnerAccountMemberships.partnerAccountId,
      ],
      name: "partner_media_mutation_operations_actor_account_fk",
    }).onDelete("restrict"),
    actorActionKey: uniqueIndex(
      "partner_media_mutation_operations_actor_action_key",
    ).on(
      table.partnerAccountId,
      table.actorMembershipId,
      table.action,
      table.idempotencyKeyHash,
    ),
    claimIdx: index("partner_media_mutation_operations_claim_idx").on(
      table.status,
      table.claimExpiresAt,
    ),
    associationIdx: index(
      "partner_media_mutation_operations_association_idx",
    ).on(
      table.partnerAccountId,
      table.parentKind,
      table.parentId,
      table.associationId,
      table.createdAt,
    ),
    actionCheck: check(
      "partner_media_mutation_operations_action_check",
      sql`${table.action} IN ('finalize')`,
    ),
    parentKindCheck: check(
      "partner_media_mutation_operations_parent_kind_check",
      sql`${table.parentKind} IN ('draft', 'job')`,
    ),
    statusCheck: check(
      "partner_media_mutation_operations_status_check",
      sql`${table.status} IN ('in_progress', 'succeeded', 'failed')`,
    ),
    idempotencyHashCheck: check(
      "partner_media_mutation_operations_idempotency_hash_check",
      sql`${table.idempotencyKeyHash} ~ '^[0-9a-f]{64}$'`,
    ),
    requestHashCheck: check(
      "partner_media_mutation_operations_request_hash_check",
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    attemptCountCheck: check(
      "partner_media_mutation_operations_attempt_count_check",
      sql`${table.attemptCount} BETWEEN 1 AND 20`,
    ),
    completionCheck: check(
      "partner_media_mutation_operations_completion_check",
      sql`(${table.status} = 'in_progress' AND ${table.completedAt} IS NULL) OR (${table.status} <> 'in_progress' AND ${table.completedAt} IS NOT NULL)`,
    ),
  }),
);

export const partnerDraftMedia = pgTable(
  "partner_draft_media",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "cascade" }),
    bookingDraftId: uuid("booking_draft_id")
      .notNull()
      .references(() => partnerBookingDrafts.id, { onDelete: "cascade" }),
    mediaAssetId: uuid("media_asset_id")
      .notNull()
      .references(() => mediaAssets.id, { onDelete: "restrict" }),
    category: text("category").default("intake").notNull(),
    caption: text("caption"),
    sortOrder: integer("sort_order").default(0).notNull(),
    uploadedByMembershipId: uuid("uploaded_by_membership_id").references(
      () => partnerAccountMemberships.id,
      { onDelete: "set null" },
    ),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    purgeEligibleAt: timestamp("purge_eligible_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    draftAssetKey: uniqueIndex("partner_draft_media_draft_asset_key").on(
      table.bookingDraftId,
      table.mediaAssetId,
    ),
    accountDraftIdx: index("partner_draft_media_account_draft_idx").on(
      table.partnerAccountId,
      table.bookingDraftId,
      table.sortOrder,
    ),
    accountDraftFk: foreignKey({
      columns: [table.partnerAccountId, table.bookingDraftId],
      foreignColumns: [
        partnerBookingDrafts.partnerAccountId,
        partnerBookingDrafts.id,
      ],
      name: "partner_draft_media_account_draft_fk",
    }).onDelete("cascade"),
    assetAccountFk: foreignKey({
      columns: [table.mediaAssetId, table.partnerAccountId],
      foreignColumns: [mediaAssets.id, mediaAssets.partnerAccountId],
      name: "partner_draft_media_asset_account_fk",
    }).onDelete("restrict"),
    uploaderAccountFk: foreignKey({
      columns: [table.uploadedByMembershipId, table.partnerAccountId],
      foreignColumns: [
        partnerAccountMemberships.id,
        partnerAccountMemberships.partnerAccountId,
      ],
      name: "partner_draft_media_uploader_account_fk",
    }).onDelete("restrict"),
    categoryCheck: check(
      "partner_draft_media_category_check",
      sql`${table.category} IN ('intake', 'before', 'after', 'completion', 'issue', 'document')`,
    ),
    deletionCheck: check(
      "partner_draft_media_deletion_check",
      sql`(${table.deletedAt} IS NULL AND ${table.purgeEligibleAt} IS NULL) OR (${table.deletedAt} IS NOT NULL AND ${table.purgeEligibleAt} >= ${table.deletedAt} + interval '30 days')`,
    ),
  }),
);

export const partnerJobEvents = pgTable(
  "partner_job_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "restrict" }),
    partnerBookingId: uuid("partner_booking_id")
      .notNull()
      .references(() => partnerBookings.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    publicLabel: text("public_label").notNull(),
    publicDetail: text("public_detail"),
    effectiveAt: timestamp("effective_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    actorType: text("actor_type").notNull(),
    actorMembershipId: uuid("actor_membership_id").references(
      () => partnerAccountMemberships.id,
      { onDelete: "set null" },
    ),
    actorTeamMemberId: uuid("actor_team_member_id").references(
      () => teamMembers.id,
      { onDelete: "set null" },
    ),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    jobTimelineIdx: index("partner_job_events_job_timeline_idx").on(
      table.partnerAccountId,
      table.partnerBookingId,
      table.effectiveAt,
      table.id,
    ),
    actorTypeCheck: check(
      "partner_job_events_actor_type_check",
      sql`${table.actorType} IN ('partner', 'staff', 'system')`,
    ),
    actorBindingCheck: check(
      "partner_job_events_actor_binding_check",
      sql`(${table.actorType} = 'partner' AND ${table.actorMembershipId} IS NOT NULL AND ${table.actorTeamMemberId} IS NULL) OR (${table.actorType} = 'staff' AND ${table.actorTeamMemberId} IS NOT NULL AND ${table.actorMembershipId} IS NULL) OR (${table.actorType} = 'system' AND ${table.actorMembershipId} IS NULL AND ${table.actorTeamMemberId} IS NULL)`,
    ),
  }),
);

export const partnerJobComments = pgTable(
  "partner_job_comments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "restrict" }),
    partnerBookingId: uuid("partner_booking_id")
      .notNull()
      .references(() => partnerBookings.id, { onDelete: "cascade" }),
    authorMembershipId: uuid("author_membership_id").references(
      () => partnerAccountMemberships.id,
      { onDelete: "set null" },
    ),
    authorTeamMemberId: uuid("author_team_member_id").references(
      () => teamMembers.id,
      { onDelete: "set null" },
    ),
    body: varchar("body", { length: 5000 }).notNull(),
    portalVisible: boolean("portal_visible").default(true).notNull(),
    revision: integer("revision").default(1).notNull(),
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
    jobHistoryIdx: index("partner_job_comments_job_history_idx").on(
      table.partnerAccountId,
      table.partnerBookingId,
      table.portalVisible,
      table.createdAt,
      table.id,
    ),
    authorCheck: check(
      "partner_job_comments_author_check",
      sql`num_nonnulls(${table.authorMembershipId}, ${table.authorTeamMemberId}) = 1`,
    ),
    revisionCheck: check(
      "partner_job_comments_revision_check",
      sql`${table.revision} > 0`,
    ),
  }),
);

export const partnerEvidenceRequirements = pgTable(
  "partner_evidence_requirements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "cascade" }),
    partnerBookingId: uuid("partner_booking_id").references(
      () => partnerBookings.id,
      { onDelete: "cascade" },
    ),
    category: text("category").notNull(),
    minimumCount: integer("minimum_count").default(1).notNull(),
    required: boolean("required").default(true).notNull(),
    source: text("source").default("account_default").notNull(),
    overrideReason: text("override_reason"),
    overriddenByTeamMemberId: uuid("overridden_by_team_member_id").references(
      () => teamMembers.id,
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
    accountDefaultKey: uniqueIndex(
      "partner_evidence_requirements_account_default_key",
    )
      .on(table.partnerAccountId, table.category)
      .where(sql`${table.partnerBookingId} IS NULL`),
    jobCategoryKey: uniqueIndex(
      "partner_evidence_requirements_job_category_key",
    )
      .on(table.partnerBookingId, table.category)
      .where(sql`${table.partnerBookingId} IS NOT NULL`),
    categoryCheck: check(
      "partner_evidence_requirements_category_check",
      sql`${table.category} IN ('intake', 'before', 'after', 'completion', 'issue', 'document')`,
    ),
    countCheck: check(
      "partner_evidence_requirements_count_check",
      sql`${table.minimumCount} BETWEEN 0 AND 40`,
    ),
    overrideCheck: check(
      "partner_evidence_requirements_override_check",
      sql`(${table.source} <> 'staff_override' AND ${table.overrideReason} IS NULL AND ${table.overriddenByTeamMemberId} IS NULL) OR (${table.source} = 'staff_override' AND char_length(btrim(${table.overrideReason})) >= 10 AND ${table.overriddenByTeamMemberId} IS NOT NULL)`,
    ),
  }),
);

export const partnerJobEvidence = pgTable(
  "partner_job_evidence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "restrict" }),
    partnerBookingId: uuid("partner_booking_id")
      .notNull()
      .references(() => partnerBookings.id, { onDelete: "cascade" }),
    mediaAssetId: uuid("media_asset_id")
      .notNull()
      .references(() => mediaAssets.id, { onDelete: "restrict" }),
    category: text("category").notNull(),
    caption: text("caption"),
    sortOrder: integer("sort_order").default(0).notNull(),
    uploadedByMembershipId: uuid("uploaded_by_membership_id").references(
      () => partnerAccountMemberships.id,
      { onDelete: "set null" },
    ),
    uploadedByTeamMemberId: uuid("uploaded_by_team_member_id").references(
      () => teamMembers.id,
      { onDelete: "set null" },
    ),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    purgeEligibleAt: timestamp("purge_eligible_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    jobAssetKey: uniqueIndex("partner_job_evidence_job_asset_key").on(
      table.partnerBookingId,
      table.mediaAssetId,
    ),
    jobCategoryIdx: index("partner_job_evidence_job_category_idx").on(
      table.partnerAccountId,
      table.partnerBookingId,
      table.category,
      table.sortOrder,
    ),
    accountBookingFk: foreignKey({
      columns: [table.partnerAccountId, table.partnerBookingId],
      foreignColumns: [partnerBookings.partnerAccountId, partnerBookings.id],
      name: "partner_job_evidence_account_booking_fk",
    }).onDelete("cascade"),
    assetAccountFk: foreignKey({
      columns: [table.mediaAssetId, table.partnerAccountId],
      foreignColumns: [mediaAssets.id, mediaAssets.partnerAccountId],
      name: "partner_job_evidence_asset_account_fk",
    }).onDelete("restrict"),
    uploaderAccountFk: foreignKey({
      columns: [table.uploadedByMembershipId, table.partnerAccountId],
      foreignColumns: [
        partnerAccountMemberships.id,
        partnerAccountMemberships.partnerAccountId,
      ],
      name: "partner_job_evidence_uploader_account_fk",
    }).onDelete("restrict"),
    categoryCheck: check(
      "partner_job_evidence_category_check",
      sql`${table.category} IN ('intake', 'before', 'after', 'completion', 'issue', 'document')`,
    ),
    uploaderCheck: check(
      "partner_job_evidence_uploader_check",
      sql`num_nonnulls(${table.uploadedByMembershipId}, ${table.uploadedByTeamMemberId}) <= 1`,
    ),
    deletionCheck: check(
      "partner_job_evidence_deletion_check",
      sql`(${table.deletedAt} IS NULL AND ${table.purgeEligibleAt} IS NULL) OR (${table.deletedAt} IS NOT NULL AND ${table.purgeEligibleAt} >= ${table.deletedAt} + interval '30 days')`,
    ),
  }),
);

export const partnerProofPackages = pgTable(
  "partner_proof_packages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "restrict" }),
    partnerBookingId: uuid("partner_booking_id")
      .notNull()
      .references(() => partnerBookings.id, { onDelete: "restrict" }),
    version: integer("version").default(1).notNull(),
    manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull(),
    manifestSha256: varchar("manifest_sha256", { length: 64 }).notNull(),
    pdfDocumentId: uuid("pdf_document_id"),
    zipDocumentId: uuid("zip_document_id"),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    jobVersionKey: uniqueIndex("partner_proof_packages_job_version_key").on(
      table.partnerBookingId,
      table.version,
    ),
    accountGeneratedIdx: index(
      "partner_proof_packages_account_generated_idx",
    ).on(table.partnerAccountId, table.generatedAt),
    hashCheck: check(
      "partner_proof_packages_hash_check",
      sql`${table.manifestSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    versionCheck: check(
      "partner_proof_packages_version_check",
      sql`${table.version} > 0`,
    ),
  }),
);

export const partnerProofShareLinks = pgTable(
  "partner_proof_share_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "restrict" }),
    proofPackageId: uuid("proof_package_id")
      .notNull()
      .references(() => partnerProofPackages.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByMembershipId: uuid("revoked_by_membership_id").references(
      () => partnerAccountMemberships.id,
      { onDelete: "set null" },
    ),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
    accessCount: integer("access_count").default(0).notNull(),
    createdByMembershipId: uuid("created_by_membership_id")
      .notNull()
      .references(() => partnerAccountMemberships.id, {
        onDelete: "restrict",
      }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    tokenKey: uniqueIndex("partner_proof_share_links_token_key").on(
      table.tokenHash,
    ),
    accountExpiryIdx: index("partner_proof_share_links_account_expiry_idx").on(
      table.partnerAccountId,
      table.expiresAt,
      table.revokedAt,
    ),
    hashCheck: check(
      "partner_proof_share_links_hash_check",
      sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
    expiryCheck: check(
      "partner_proof_share_links_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    countCheck: check(
      "partner_proof_share_links_count_check",
      sql`${table.accessCount} >= 0`,
    ),
  }),
);

export type PartnerNotificationEndpointStatus =
  | "pending"
  | "verified"
  | "revoked";

/**
 * Identity-owned notification destinations. Phone numbers in this table are
 * delivery endpoints only and can never be used to authenticate a partner.
 */
export const partnerNotificationEndpoints = pgTable(
  "partner_notification_endpoints",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerUserId: uuid("partner_user_id")
      .notNull()
      .references(() => partnerUsers.id, { onDelete: "cascade" }),
    channel: text("channel").$type<"sms">().default("sms").notNull(),
    normalizedDestination: varchar("normalized_destination", {
      length: 32,
    }).notNull(),
    status: text("status")
      .$type<PartnerNotificationEndpointStatus>()
      .default("pending")
      .notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    consentAt: timestamp("consent_at", { withTimezone: true }),
    consentSource: text("consent_source"),
    consentVersion: text("consent_version"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    userDestinationKey: uniqueIndex(
      "partner_notification_endpoints_user_destination_key",
    ).on(table.partnerUserId, table.channel, table.normalizedDestination),
    activeSmsUserKey: uniqueIndex(
      "partner_notification_endpoints_verified_sms_user_key",
    )
      .on(table.partnerUserId, table.channel)
      .where(sql`${table.status} = 'verified'`),
    statusIdx: index("partner_notification_endpoints_user_status_idx").on(
      table.partnerUserId,
      table.status,
      table.updatedAt,
    ),
    channelCheck: check(
      "partner_notification_endpoints_channel_check",
      sql`${table.channel} = 'sms'`,
    ),
    destinationCheck: check(
      "partner_notification_endpoints_destination_check",
      sql`${table.normalizedDestination} ~ '^\+[1-9][0-9]{7,14}$'`,
    ),
    statusCheck: check(
      "partner_notification_endpoints_status_check",
      sql`${table.status} IN ('pending', 'verified', 'revoked')`,
    ),
    lifecycleCheck: check(
      "partner_notification_endpoints_lifecycle_check",
      sql`(${table.status} = 'pending' AND ${table.verifiedAt} IS NULL AND ${table.consentAt} IS NULL AND ${table.consentSource} IS NULL AND ${table.consentVersion} IS NULL AND ${table.revokedAt} IS NULL) OR (${table.status} = 'verified' AND ${table.verifiedAt} IS NOT NULL AND ${table.consentAt} IS NOT NULL AND ${table.consentSource} IS NOT NULL AND ${table.consentVersion} IS NOT NULL AND ${table.revokedAt} IS NULL) OR (${table.status} = 'revoked' AND ${table.revokedAt} IS NOT NULL)`,
    ),
  }),
);

export type PartnerNotificationEndpointChallengeStatus =
  | "pending"
  | "consumed"
  | "revoked"
  | "expired";
export type PartnerNotificationEndpointDeliveryStatus =
  | "queued"
  | "dispatching"
  | "accepted"
  | "failed"
  | "reconciliation_required";

export const partnerNotificationEndpointChallenges = pgTable(
  "partner_notification_endpoint_challenges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => partnerNotificationEndpoints.id, {
        onDelete: "cascade",
      }),
    partnerUserId: uuid("partner_user_id")
      .notNull()
      .references(() => partnerUsers.id, { onDelete: "cascade" }),
    partnerAccountId: uuid("partner_account_id").notNull(),
    membershipId: uuid("membership_id").notNull(),
    codeHash: text("code_hash"),
    generation: integer("generation").default(1).notNull(),
    status: text("status")
      .$type<PartnerNotificationEndpointChallengeStatus>()
      .default("pending")
      .notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    deliveryStatus: text("delivery_status")
      .$type<PartnerNotificationEndpointDeliveryStatus>()
      .default("queued")
      .notNull(),
    deliveryOutboxEventId: uuid("delivery_outbox_event_id").references(
      () => outboxEvents.id,
      { onDelete: "set null" },
    ),
    deliveryAttemptId: uuid("delivery_attempt_id"),
    deliveryProvider: text("delivery_provider"),
    deliveryProviderMessageId: text("delivery_provider_message_id"),
    deliveryDetail: text("delivery_detail"),
    dispatchStartedAt: timestamp("dispatch_started_at", {
      withTimezone: true,
    }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    endpointGenerationKey: uniqueIndex(
      "partner_notification_endpoint_challenges_endpoint_generation_key",
    ).on(table.endpointId, table.generation),
    activeEndpointKey: uniqueIndex(
      "partner_notification_endpoint_challenges_active_endpoint_key",
    )
      .on(table.endpointId)
      .where(sql`${table.status} = 'pending'`),
    deliveryOutboxKey: uniqueIndex(
      "partner_notification_endpoint_challenges_delivery_outbox_key",
    )
      .on(table.deliveryOutboxEventId)
      .where(sql`${table.deliveryOutboxEventId} IS NOT NULL`),
    membershipAccountFk: foreignKey({
      name: "partner_notification_endpoint_challenges_membership_account_fk",
      columns: [table.membershipId, table.partnerAccountId],
      foreignColumns: [
        partnerAccountMemberships.id,
        partnerAccountMemberships.partnerAccountId,
      ],
    }).onDelete("cascade"),
    expiryIdx: index("partner_notification_endpoint_challenges_expiry_idx").on(
      table.status,
      table.expiresAt,
    ),
    statusCheck: check(
      "partner_notification_endpoint_challenges_status_check",
      sql`${table.status} IN ('pending', 'consumed', 'revoked', 'expired')`,
    ),
    deliveryStatusCheck: check(
      "partner_notification_endpoint_challenges_delivery_status_check",
      sql`${table.deliveryStatus} IN ('queued', 'dispatching', 'accepted', 'failed', 'reconciliation_required')`,
    ),
    generationCheck: check(
      "partner_notification_endpoint_challenges_generation_check",
      sql`${table.generation} > 0`,
    ),
    attemptCountCheck: check(
      "partner_notification_endpoint_challenges_attempt_count_check",
      sql`${table.attemptCount} BETWEEN 0 AND 5`,
    ),
    lifecycleCheck: check(
      "partner_notification_endpoint_challenges_lifecycle_check",
      sql`(${table.status} = 'pending' AND ${table.codeHash} IS NOT NULL AND ${table.consumedAt} IS NULL AND ${table.revokedAt} IS NULL AND ${table.expiredAt} IS NULL) OR (${table.status} = 'consumed' AND ${table.codeHash} IS NULL AND ${table.consumedAt} IS NOT NULL AND ${table.revokedAt} IS NULL AND ${table.expiredAt} IS NULL) OR (${table.status} = 'revoked' AND ${table.codeHash} IS NULL AND ${table.consumedAt} IS NULL AND ${table.revokedAt} IS NOT NULL AND ${table.expiredAt} IS NULL) OR (${table.status} = 'expired' AND ${table.codeHash} IS NULL AND ${table.consumedAt} IS NULL AND ${table.revokedAt} IS NULL AND ${table.expiredAt} IS NOT NULL)`,
    ),
  }),
);

export const partnerNotificationPreferences = pgTable(
  "partner_notification_preferences",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "cascade" }),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => partnerAccountMemberships.id, { onDelete: "cascade" }),
    eventKey: text("event_key").notNull(),
    inAppEnabled: boolean("in_app_enabled").default(true).notNull(),
    emailEnabled: boolean("email_enabled").default(true).notNull(),
    smsEnabled: boolean("sms_enabled").default(false).notNull(),
    smsVerifiedOptInAt: timestamp("sms_verified_opt_in_at", {
      withTimezone: true,
    }),
    smsVerifiedPhoneE164: varchar("sms_verified_phone_e164", { length: 32 }),
    smsVerifiedEndpointId: uuid("sms_verified_endpoint_id").references(
      () => partnerNotificationEndpoints.id,
      { onDelete: "set null" },
    ),
    smsOptInSource: text("sms_opt_in_source"),
    smsConsentVersion: text("sms_consent_version"),
    quietHoursStart: varchar("quiet_hours_start", { length: 5 }),
    quietHoursEnd: varchar("quiet_hours_end", { length: 5 }),
    timezone: text("timezone").default("America/New_York").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    membershipEventKey: uniqueIndex(
      "partner_notification_preferences_membership_event_key",
    ).on(table.membershipId, table.eventKey),
    accountIdx: index("partner_notification_preferences_account_idx").on(
      table.partnerAccountId,
      table.membershipId,
    ),
    smsConsentCheck: check(
      "partner_notification_preferences_sms_consent_check",
      sql`${table.smsEnabled} = false OR (${table.smsVerifiedOptInAt} IS NOT NULL AND ${table.smsVerifiedPhoneE164} IS NOT NULL AND ${table.smsVerifiedEndpointId} IS NOT NULL AND ${table.smsOptInSource} IS NOT NULL AND ${table.smsConsentVersion} IS NOT NULL)`,
    ),
    smsPhoneCheck: check(
      "partner_notification_preferences_sms_phone_check",
      sql`${table.smsVerifiedPhoneE164} IS NULL OR ${table.smsVerifiedPhoneE164} ~ '^\\+[1-9][0-9]{7,14}$'`,
    ),
    quietHoursCheck: check(
      "partner_notification_preferences_quiet_hours_check",
      sql`(${table.quietHoursStart} IS NULL AND ${table.quietHoursEnd} IS NULL) OR (${table.quietHoursStart} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND ${table.quietHoursEnd} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')`,
    ),
  }),
);

export const partnerNotifications = pgTable(
  "partner_notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "cascade" }),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => partnerAccountMemberships.id, { onDelete: "cascade" }),
    partnerBookingId: uuid("partner_booking_id").references(
      () => partnerBookings.id,
      { onDelete: "cascade" },
    ),
    eventKey: text("event_key").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    actionPath: text("action_path"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    unreadIdx: index("partner_notifications_unread_idx").on(
      table.partnerAccountId,
      table.membershipId,
      table.readAt,
      table.createdAt,
      table.id,
    ),
  }),
);

export type PartnerNotificationDeliveryEventType =
  | "booking.created"
  | "booking.review_received"
  | "booking.rescheduled"
  | "booking.reschedule_review_requested"
  | "booking.canceled"
  | "booking.cancellation_review_requested"
  | "billing.dispute_requested"
  | "billing.dispute_resolved";
export type PartnerNotificationDeliveryChannel = "in_app" | "email" | "sms";
export type PartnerNotificationDeliveryState =
  | "suppressed"
  | "queued"
  | "dispatching"
  | "accepted"
  | "failed"
  | "reconciliation_required";

/**
 * Immutable per-channel intent plus the provider dispatch state. The outbox
 * payload contains only this opaque ID; destinations are resolved again from
 * canonical identity/endpoint records immediately before dispatch.
 */
export const partnerNotificationDeliveries = pgTable(
  "partner_notification_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id").notNull(),
    membershipId: uuid("membership_id").notNull(),
    partnerBookingId: uuid("partner_booking_id"),
    partnerNotificationId: uuid("partner_notification_id").references(
      () => partnerNotifications.id,
      { onDelete: "set null" },
    ),
    eventType: text("event_type")
      .$type<PartnerNotificationDeliveryEventType>()
      .notNull(),
    preferenceEventKey: text("preference_event_key").notNull(),
    channel: text("channel")
      .$type<PartnerNotificationDeliveryChannel>()
      .notNull(),
    state: text("state").$type<PartnerNotificationDeliveryState>().notNull(),
    urgency: text("urgency").default("ordinary").notNull(),
    dedupeKeyHash: varchar("dedupe_key_hash", { length: 64 }).notNull(),
    title: varchar("title", { length: 120 }).notNull(),
    body: varchar("body", { length: 500 }).notNull(),
    actionPath: varchar("action_path", { length: 200 }).notNull(),
    endpointId: uuid("endpoint_id").references(
      () => partnerNotificationEndpoints.id,
      { onDelete: "set null" },
    ),
    providerRequestKey: varchar("provider_request_key", { length: 200 }),
    outboxEventId: uuid("outbox_event_id").references(() => outboxEvents.id, {
      onDelete: "restrict",
    }),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    dispatchAttemptId: uuid("dispatch_attempt_id"),
    dispatchStartedAt: timestamp("dispatch_started_at", {
      withTimezone: true,
    }),
    provider: varchar("provider", { length: 64 }),
    providerMessageId: varchar("provider_message_id", { length: 255 }),
    providerIdempotencySupported: boolean("provider_idempotency_supported"),
    deliveryCertainty: text("delivery_certainty"),
    detail: varchar("detail", { length: 500 }),
    correlationId: varchar("correlation_id", { length: 128 }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    membershipAccountFk: foreignKey({
      name: "partner_notification_deliveries_membership_account_fk",
      columns: [table.membershipId, table.partnerAccountId],
      foreignColumns: [
        partnerAccountMemberships.id,
        partnerAccountMemberships.partnerAccountId,
      ],
    }).onDelete("restrict"),
    bookingAccountFk: foreignKey({
      name: "partner_notification_deliveries_booking_account_fk",
      columns: [table.partnerBookingId, table.partnerAccountId],
      foreignColumns: [partnerBookings.id, partnerBookings.partnerAccountId],
    }).onDelete("restrict"),
    channelDedupeKey: uniqueIndex(
      "partner_notification_deliveries_channel_dedupe_key",
    ).on(
      table.membershipId,
      table.eventType,
      table.dedupeKeyHash,
      table.channel,
    ),
    outboxKey: uniqueIndex("partner_notification_deliveries_outbox_key")
      .on(table.outboxEventId)
      .where(sql`${table.outboxEventId} IS NOT NULL`),
    dispatchIdx: index("partner_notification_deliveries_dispatch_idx").on(
      table.state,
      table.scheduledFor,
      table.createdAt,
    ),
    accountBookingIdx: index(
      "partner_notification_deliveries_account_booking_idx",
    ).on(table.partnerAccountId, table.partnerBookingId, table.createdAt),
    eventTypeCheck: check(
      "partner_notification_deliveries_event_type_check",
      sql`${table.eventType} IN ('booking.created', 'booking.review_received', 'booking.rescheduled', 'booking.reschedule_review_requested', 'booking.canceled', 'booking.cancellation_review_requested', 'billing.dispute_requested', 'billing.dispute_resolved')`,
    ),
    preferenceEventKeyCheck: check(
      "partner_notification_deliveries_preference_event_key_check",
      sql`${table.preferenceEventKey} IN ('booking_created', 'booking_changed', 'invoice_issued')`,
    ),
    channelCheck: check(
      "partner_notification_deliveries_channel_check",
      sql`${table.channel} IN ('in_app', 'email', 'sms')`,
    ),
    stateCheck: check(
      "partner_notification_deliveries_state_check",
      sql`${table.state} IN ('suppressed', 'queued', 'dispatching', 'accepted', 'failed', 'reconciliation_required')`,
    ),
    urgencyCheck: check(
      "partner_notification_deliveries_urgency_check",
      sql`${table.urgency} IN ('ordinary', 'urgent_same_day')`,
    ),
    attemptCountCheck: check(
      "partner_notification_deliveries_attempt_count_check",
      sql`${table.attemptCount} BETWEEN 0 AND 3`,
    ),
    hashCheck: check(
      "partner_notification_deliveries_dedupe_hash_check",
      sql`${table.dedupeKeyHash} ~ '^[0-9a-f]{64}$'`,
    ),
    actionPathCheck: check(
      "partner_notification_deliveries_action_path_check",
      sql`${table.actionPath} ~ '^/partners/bookings/[0-9a-f-]{36}$' OR ${table.actionPath} = '/partners/billing'`,
    ),
    lifecycleCheck: check(
      "partner_notification_deliveries_lifecycle_check",
      sql`(
        ${table.channel} = 'in_app'
        AND ${table.outboxEventId} IS NULL
        AND ${table.providerRequestKey} IS NULL
        AND ${table.endpointId} IS NULL
        AND ${table.state} IN ('suppressed', 'accepted')
      ) OR (
        ${table.channel} IN ('email', 'sms')
        AND ((${table.outboxEventId} IS NULL) = (${table.providerRequestKey} IS NULL))
        AND (${table.state} = 'suppressed' OR ${table.outboxEventId} IS NOT NULL)
        AND (${table.channel} <> 'sms' OR ${table.state} = 'suppressed' OR ${table.endpointId} IS NOT NULL)
      )`,
    ),
  }),
);

export const partnerServiceTemplates = pgTable(
  "partner_service_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    serviceKey: varchar("service_key", { length: 80 })
      .notNull()
      .references(() => partnerServiceCatalog.key, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(
      () => partnerAccountLocations.id,
      { onDelete: "set null" },
    ),
    templateData: jsonb("template_data")
      .$type<Record<string, unknown>>()
      .notNull(),
    active: boolean("active").default(true).notNull(),
    version: integer("version").default(1).notNull(),
    createdByMembershipId: uuid("created_by_membership_id").references(
      () => partnerAccountMemberships.id,
      { onDelete: "set null" },
    ),
    createOperationKeyHash: varchar("create_operation_key_hash", {
      length: 64,
    }),
    createRequestHash: varchar("create_request_hash", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    accountNameKey: uniqueIndex("partner_service_templates_account_name_key")
      .on(table.partnerAccountId, table.name)
      .where(sql`${table.active} = true`),
    accountIdx: index("partner_service_templates_account_idx").on(
      table.partnerAccountId,
      table.active,
      table.updatedAt,
    ),
    versionCheck: check(
      "partner_service_templates_version_check",
      sql`${table.version} > 0`,
    ),
    createOperationKey: uniqueIndex(
      "partner_service_templates_create_operation_key_hash_key",
    )
      .on(table.createOperationKeyHash)
      .where(sql`${table.createOperationKeyHash} IS NOT NULL`),
    createHashPairCheck: check(
      "partner_service_templates_create_hash_pair_check",
      sql`(${table.createOperationKeyHash} IS NULL) = (${table.createRequestHash} IS NULL)`,
    ),
  }),
);

export const partnerRecurringSeries = pgTable(
  "partner_recurring_series",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "restrict" }),
    templateId: uuid("template_id").references(
      () => partnerServiceTemplates.id,
      { onDelete: "restrict" },
    ),
    name: text("name").notNull(),
    recurrenceRule: text("recurrence_rule").notNull(),
    timezone: text("timezone").default("America/New_York").notNull(),
    preferredWindowStart: varchar("preferred_window_start", { length: 5 }),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on"),
    state: text("state").default("active").notNull(),
    revision: integer("revision").default(1).notNull(),
    createdByMembershipId: uuid("created_by_membership_id")
      .notNull()
      .references(() => partnerAccountMemberships.id, {
        onDelete: "restrict",
      }),
    createOperationKeyHash: varchar("create_operation_key_hash", {
      length: 64,
    }),
    createRequestHash: varchar("create_request_hash", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    accountStateIdx: index("partner_recurring_series_account_state_idx").on(
      table.partnerAccountId,
      table.state,
      table.startsOn,
    ),
    stateCheck: check(
      "partner_recurring_series_state_check",
      sql`${table.state} IN ('active', 'paused', 'completed', 'canceled')`,
    ),
    dateCheck: check(
      "partner_recurring_series_date_check",
      sql`${table.endsOn} IS NULL OR ${table.endsOn} >= ${table.startsOn}`,
    ),
    revisionCheck: check(
      "partner_recurring_series_revision_check",
      sql`${table.revision} > 0`,
    ),
    preferredWindowCheck: check(
      "partner_recurring_series_preferred_window_start_check",
      sql`${table.preferredWindowStart} IS NULL OR ${table.preferredWindowStart} ~ '^([01][0-9]|2[0-3]):(00|30)$'`,
    ),
    createOperationKey: uniqueIndex(
      "partner_recurring_series_create_operation_key_hash_key",
    )
      .on(table.createOperationKeyHash)
      .where(sql`${table.createOperationKeyHash} IS NOT NULL`),
  }),
);

export const partnerRecurringOccurrences = pgTable(
  "partner_recurring_occurrences",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "restrict" }),
    recurringSeriesId: uuid("recurring_series_id")
      .notNull()
      .references(() => partnerRecurringSeries.id, { onDelete: "cascade" }),
    localDate: date("local_date").notNull(),
    state: text("state").default("tentative").notNull(),
    partnerBookingId: uuid("partner_booking_id").references(
      () => partnerBookings.id,
      { onDelete: "set null" },
    ),
    bookingDraftId: uuid("booking_draft_id").references(
      () => partnerBookingDrafts.id,
      { onDelete: "set null" },
    ),
    evaluation: jsonb("evaluation")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    failureCode: text("failure_code"),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    seriesDateKey: uniqueIndex(
      "partner_recurring_occurrences_series_date_key",
    ).on(table.recurringSeriesId, table.localDate),
    actionIdx: index("partner_recurring_occurrences_action_idx").on(
      table.partnerAccountId,
      table.state,
      table.localDate,
    ),
    stateCheck: check(
      "partner_recurring_occurrences_state_check",
      sql`${table.state} IN ('tentative', 'evaluating', 'confirmed', 'review', 'failed', 'skipped', 'canceled')`,
    ),
  }),
);

export const partnerBulkImports = pgTable(
  "partner_bulk_imports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "restrict" }),
    createdByMembershipId: uuid("created_by_membership_id")
      .notNull()
      .references(() => partnerAccountMemberships.id, {
        onDelete: "restrict",
      }),
    sourceFilename: text("source_filename").notNull(),
    sourceSha256: varchar("source_sha256", { length: 64 }).notNull(),
    state: text("state").default("validating").notNull(),
    dryRun: boolean("dry_run").default(true).notNull(),
    rowCount: integer("row_count").default(0).notNull(),
    validCount: integer("valid_count").default(0).notNull(),
    errorCount: integer("error_count").default(0).notNull(),
    correctionDocumentId: uuid("correction_document_id"),
    createOperationKeyHash: varchar("create_operation_key_hash", {
      length: 64,
    }),
    createRequestHash: varchar("create_request_hash", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    accountCreatedIdx: index("partner_bulk_imports_account_created_idx").on(
      table.partnerAccountId,
      table.createdAt,
      table.id,
    ),
    hashCheck: check(
      "partner_bulk_imports_hash_check",
      sql`${table.sourceSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    stateCheck: check(
      "partner_bulk_imports_state_check",
      sql`${table.state} IN ('validating', 'validated', 'processing', 'completed', 'failed')`,
    ),
    countsCheck: check(
      "partner_bulk_imports_counts_check",
      sql`${table.rowCount} >= 0 AND ${table.validCount} >= 0 AND ${table.errorCount} >= 0 AND ${table.validCount} + ${table.errorCount} <= ${table.rowCount}`,
    ),
    createOperationKey: uniqueIndex(
      "partner_bulk_imports_create_operation_key_hash_key",
    )
      .on(table.createOperationKeyHash)
      .where(sql`${table.createOperationKeyHash} IS NOT NULL`),
  }),
);

export const partnerBulkImportRows = pgTable(
  "partner_bulk_import_rows",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "restrict" }),
    partnerBulkImportId: uuid("partner_bulk_import_id")
      .notNull()
      .references(() => partnerBulkImports.id, { onDelete: "cascade" }),
    rowNumber: integer("row_number").notNull(),
    normalizedData: jsonb("normalized_data").$type<Record<
      string,
      unknown
    > | null>(),
    errors: jsonb("errors")
      .$type<Array<Record<string, unknown>>>()
      .notNull()
      .default([]),
    state: text("state").default("pending").notNull(),
    partnerBookingId: uuid("partner_booking_id").references(
      () => partnerBookings.id,
      { onDelete: "set null" },
    ),
    bookingDraftId: uuid("booking_draft_id").references(
      () => partnerBookingDrafts.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    importRowKey: uniqueIndex("partner_bulk_import_rows_import_row_key").on(
      table.partnerBulkImportId,
      table.rowNumber,
    ),
    stateIdx: index("partner_bulk_import_rows_state_idx").on(
      table.partnerBulkImportId,
      table.state,
      table.rowNumber,
    ),
    rowCheck: check(
      "partner_bulk_import_rows_row_check",
      sql`${table.rowNumber} > 0`,
    ),
    stateCheck: check(
      "partner_bulk_import_rows_state_check",
      sql`${table.state} IN ('pending', 'invalid', 'review', 'created', 'failed')`,
    ),
  }),
);

export const partnerDocuments = pgTable(
  "partner_documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "restrict" }),
    partnerBookingId: uuid("partner_booking_id").references(
      () => partnerBookings.id,
      { onDelete: "restrict" },
    ),
    documentType: text("document_type").notNull(),
    version: integer("version").default(1).notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    storageBucket: text("storage_bucket").notNull(),
    storageObjectKey: text("storage_object_key").notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    accountDocumentKey: uniqueIndex(
      "partner_documents_account_document_key",
    ).on(table.partnerAccountId, table.id),
    storageKey: uniqueIndex("partner_documents_storage_key").on(
      table.storageBucket,
      table.storageObjectKey,
    ),
    jobTypeVersionKey: uniqueIndex("partner_documents_job_type_version_key")
      .on(table.partnerBookingId, table.documentType, table.version)
      .where(sql`${table.partnerBookingId} IS NOT NULL`),
    accountTypeIdx: index("partner_documents_account_type_idx").on(
      table.partnerAccountId,
      table.documentType,
      table.generatedAt,
      table.id,
    ),
    hashCheck: check(
      "partner_documents_hash_check",
      sql`${table.sha256} ~ '^[0-9a-f]{64}$'`,
    ),
    sizeCheck: check(
      "partner_documents_size_check",
      sql`${table.byteSize} > 0`,
    ),
    versionCheck: check(
      "partner_documents_version_check",
      sql`${table.version} > 0`,
    ),
  }),
);

export type PartnerAccountServiceAgreementEntitlement = Readonly<{
  serviceKey: string;
  pricingState: "contracted" | "estimate" | "quote_required" | "standard_rate";
  inclusions: readonly string[];
  exclusions: readonly string[];
  quoteRule: string | null;
}>;

/**
 * The single account-owned commercial agreement used to authorize Partner
 * booking choices. Historical booking snapshots remain immutable when this
 * current policy is revised.
 */
export const partnerAccountServiceAgreements = pgTable(
  "partner_account_service_agreements",
  {
    partnerAccountId: uuid("partner_account_id")
      .primaryKey()
      .references(() => partnerAccounts.id, { onDelete: "restrict" }),
    active: boolean("active").default(false).notNull(),
    agreementLabel: varchar("agreement_label", { length: 160 }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    effectiveFrom: timestamp("effective_from", {
      withTimezone: true,
    }).notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    inclusions: jsonb("inclusions")
      .$type<readonly string[]>()
      .default([])
      .notNull(),
    exclusions: jsonb("exclusions")
      .$type<readonly string[]>()
      .default([])
      .notNull(),
    quoteRules: text("quote_rules"),
    serviceEntitlements: jsonb("service_entitlements")
      .$type<readonly PartnerAccountServiceAgreementEntitlement[]>()
      .notNull(),
    agreementDocumentId: uuid("agreement_document_id"),
    revision: integer("revision").default(1).notNull(),
    updatedByTeamMemberId: uuid("updated_by_team_member_id").references(
      () => teamMembers.id,
      { onDelete: "restrict" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    documentAccountFk: foreignKey({
      name: "partner_account_service_agreements_document_account_fk",
      columns: [table.partnerAccountId, table.agreementDocumentId],
      foreignColumns: [partnerDocuments.partnerAccountId, partnerDocuments.id],
    }).onDelete("restrict"),
    effectiveIdx: index("partner_account_service_agreements_effective_idx").on(
      table.active,
      table.effectiveFrom,
      table.effectiveTo,
    ),
    labelCheck: check(
      "partner_account_service_agreements_label_check",
      sql`${table.agreementLabel} = btrim(${table.agreementLabel}) AND length(${table.agreementLabel}) BETWEEN 1 AND 160`,
    ),
    currencyCheck: check(
      "partner_account_service_agreements_currency_check",
      sql`${table.currency} ~ '^[A-Z]{3}$'`,
    ),
    rangeCheck: check(
      "partner_account_service_agreements_range_check",
      sql`${table.effectiveTo} IS NULL OR ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
    listsCheck: check(
      "partner_account_service_agreements_lists_check",
      sql`jsonb_typeof(${table.inclusions}) = 'array' AND jsonb_array_length(${table.inclusions}) <= 40 AND jsonb_typeof(${table.exclusions}) = 'array' AND jsonb_array_length(${table.exclusions}) <= 40`,
    ),
    entitlementsCheck: check(
      "partner_account_service_agreements_entitlements_check",
      sql`jsonb_typeof(${table.serviceEntitlements}) = 'array' AND jsonb_array_length(${table.serviceEntitlements}) BETWEEN 1 AND 100`,
    ),
    quoteRulesCheck: check(
      "partner_account_service_agreements_quote_rules_check",
      sql`${table.quoteRules} IS NULL OR (${table.quoteRules} = btrim(${table.quoteRules}) AND length(${table.quoteRules}) BETWEEN 1 AND 2000)`,
    ),
    revisionCheck: check(
      "partner_account_service_agreements_revision_check",
      sql`${table.revision} > 0`,
    ),
  }),
);

export const partnerDocumentAccessLogs = pgTable(
  "partner_document_access_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "restrict" }),
    partnerDocumentId: uuid("partner_document_id")
      .notNull()
      .references(() => partnerDocuments.id, { onDelete: "restrict" }),
    actorType: text("actor_type").notNull(),
    actorMembershipId: uuid("actor_membership_id").references(
      () => partnerAccountMemberships.id,
      { onDelete: "set null" },
    ),
    actorTeamMemberId: uuid("actor_team_member_id").references(
      () => teamMembers.id,
      { onDelete: "set null" },
    ),
    shareLinkId: uuid("share_link_id").references(
      () => partnerProofShareLinks.id,
      { onDelete: "set null" },
    ),
    action: text("action").default("download").notNull(),
    correlationId: text("correlation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    documentHistoryIdx: index(
      "partner_document_access_logs_document_history_idx",
    ).on(table.partnerDocumentId, table.createdAt, table.id),
    accountIdx: index("partner_document_access_logs_account_idx").on(
      table.partnerAccountId,
      table.createdAt,
    ),
    actorTypeCheck: check(
      "partner_document_access_logs_actor_type_check",
      sql`${table.actorType} IN ('partner', 'staff', 'share_link', 'system')`,
    ),
  }),
);

export const partnerRateCardVersions = pgTable(
  "partner_rate_card_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    currency: varchar("currency", { length: 3 }).default("USD").notNull(),
    status: text("status").default("draft").notNull(),
    effectiveFrom: timestamp("effective_from", {
      withTimezone: true,
    }).notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    supersedesId: uuid("supersedes_id"),
    createdByTeamMemberId: uuid("created_by_team_member_id").references(
      () => teamMembers.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    accountVersionKey: uniqueIndex(
      "partner_rate_card_versions_account_version_key",
    ).on(table.partnerAccountId, table.version),
    accountEffectiveIdx: index(
      "partner_rate_card_versions_account_effective_idx",
    ).on(
      table.partnerAccountId,
      table.status,
      table.effectiveFrom,
      table.effectiveTo,
    ),
    versionCheck: check(
      "partner_rate_card_versions_version_check",
      sql`${table.version} > 0`,
    ),
    statusCheck: check(
      "partner_rate_card_versions_status_check",
      sql`${table.status} IN ('draft', 'active', 'expired', 'superseded')`,
    ),
    currencyCheck: check(
      "partner_rate_card_versions_currency_check",
      sql`${table.currency} ~ '^[A-Z]{3}$'`,
    ),
    effectiveRangeCheck: check(
      "partner_rate_card_versions_effective_range_check",
      sql`${table.effectiveTo} IS NULL OR ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
  }),
);

export const partnerRateCardVersionItems = pgTable(
  "partner_rate_card_version_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerRateCardVersionId: uuid("partner_rate_card_version_id")
      .notNull()
      .references(() => partnerRateCardVersions.id, { onDelete: "restrict" }),
    serviceKey: varchar("service_key", { length: 80 })
      .notNull()
      .references(() => partnerServiceCatalog.key, { onDelete: "restrict" }),
    tierKey: text("tier_key").notNull(),
    label: text("label"),
    amountCents: integer("amount_cents").notNull(),
    pricingRules: jsonb("pricing_rules")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    versionServiceTierKey: uniqueIndex(
      "partner_rate_card_version_items_service_tier_key",
    ).on(table.partnerRateCardVersionId, table.serviceKey, table.tierKey),
    amountCheck: check(
      "partner_rate_card_version_items_amount_check",
      sql`${table.amountCents} >= 0`,
    ),
  }),
);

export const partnerApprovalRules = pgTable(
  "partner_approval_rules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    conditions: jsonb("conditions").$type<Record<string, unknown>>().notNull(),
    requiredApproverRoleKeys: text("required_approver_role_keys")
      .array()
      .notNull()
      .default([]),
    requiredApproverCapabilities: text("required_approver_capabilities")
      .array()
      .notNull()
      .default(["approvals.decide"]),
    requiredDecisionCount: integer("required_decision_count")
      .default(1)
      .notNull(),
    active: boolean("active").default(true).notNull(),
    version: integer("version").default(1).notNull(),
    createdByMembershipId: uuid("created_by_membership_id"),
    createdByTeamMemberId: uuid("created_by_team_member_id").references(
      () => teamMembers.id,
      { onDelete: "restrict" },
    ),
    updatedByTeamMemberId: uuid("updated_by_team_member_id").references(
      () => teamMembers.id,
      { onDelete: "restrict" },
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
    accountActiveIdx: index("partner_approval_rules_account_active_idx").on(
      table.partnerAccountId,
      table.active,
      table.name,
    ),
    accountRuleKey: uniqueIndex("partner_approval_rules_account_rule_key").on(
      table.partnerAccountId,
      table.id,
    ),
    teamCreatorIdx: index("partner_approval_rules_team_creator_idx")
      .on(table.createdByTeamMemberId, table.createdAt)
      .where(sql`${table.createdByTeamMemberId} IS NOT NULL`),
    teamUpdaterIdx: index("partner_approval_rules_team_updater_idx")
      .on(table.updatedByTeamMemberId, table.updatedAt)
      .where(sql`${table.updatedByTeamMemberId} IS NOT NULL`),
    creatorMembershipAccountFk: foreignKey({
      columns: [table.createdByMembershipId, table.partnerAccountId],
      foreignColumns: [
        partnerAccountMemberships.id,
        partnerAccountMemberships.partnerAccountId,
      ],
      name: "partner_approval_rules_creator_membership_account_fk",
    }).onDelete("restrict"),
    creatorProvenanceCheck: check(
      "partner_approval_rules_creator_provenance_check",
      sql`num_nonnulls(${table.createdByMembershipId}, ${table.createdByTeamMemberId}) = 1`,
    ),
    nameCheck: check(
      "partner_approval_rules_name_check",
      sql`${table.name} = btrim(${table.name}) AND length(${table.name}) BETWEEN 1 AND 160`,
    ),
    conditionsObjectCheck: check(
      "partner_approval_rules_conditions_object_check",
      sql`jsonb_typeof(${table.conditions}) = 'object'`,
    ),
    fixedCapabilityCheck: check(
      "partner_approval_rules_fixed_capability_check",
      sql`${table.requiredApproverCapabilities} = ARRAY['approvals.decide']::text[] AND ${table.requiredApproverRoleKeys} = ARRAY[]::text[]`,
    ),
    decisionCountCheck: check(
      "partner_approval_rules_decision_count_check",
      sql`${table.requiredDecisionCount} BETWEEN 1 AND 20`,
    ),
    versionCheck: check(
      "partner_approval_rules_version_check",
      sql`${table.version} > 0`,
    ),
  }),
);

export const partnerApprovalRequests = pgTable(
  "partner_approval_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "restrict" }),
    partnerBookingId: uuid("partner_booking_id").references(
      () => partnerBookings.id,
      { onDelete: "restrict" },
    ),
    bookingDraftId: uuid("booking_draft_id").references(
      () => partnerBookingDrafts.id,
      { onDelete: "restrict" },
    ),
    requestedByMembershipId: uuid("requested_by_membership_id")
      .notNull()
      .references(() => partnerAccountMemberships.id, {
        onDelete: "restrict",
      }),
    state: text("state").default("pending").notNull(),
    ruleSnapshot: jsonb("rule_snapshot")
      .$type<Array<Record<string, unknown>>>()
      .notNull(),
    requestSnapshot: jsonb("request_snapshot")
      .$type<Record<string, unknown>>()
      .notNull(),
    requiredDecisionCount: integer("required_decision_count").notNull(),
    approvalHoldId: uuid("approval_hold_id").references(
      () => appointmentHolds.id,
      { onDelete: "set null" },
    ),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    revision: integer("revision").default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    accountStateIdx: index("partner_approval_requests_account_state_idx").on(
      table.partnerAccountId,
      table.state,
      table.createdAt,
      table.id,
    ),
    targetCheck: check(
      "partner_approval_requests_target_check",
      sql`num_nonnulls(${table.partnerBookingId}, ${table.bookingDraftId}) = 1`,
    ),
    stateCheck: check(
      "partner_approval_requests_state_check",
      sql`${table.state} IN ('pending', 'approved', 'declined', 'expired', 'approved_needs_reschedule', 'withdrawn')`,
    ),
    decisionCountCheck: check(
      "partner_approval_requests_decision_count_check",
      sql`${table.requiredDecisionCount} BETWEEN 1 AND 20`,
    ),
    revisionCheck: check(
      "partner_approval_requests_revision_check",
      sql`${table.revision} > 0`,
    ),
  }),
);

export const partnerApprovalDecisions = pgTable(
  "partner_approval_decisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    approvalRequestId: uuid("approval_request_id")
      .notNull()
      .references(() => partnerApprovalRequests.id, { onDelete: "restrict" }),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "restrict" }),
    decidedByMembershipId: uuid("decided_by_membership_id")
      .notNull()
      .references(() => partnerAccountMemberships.id, {
        onDelete: "restrict",
      }),
    decision: text("decision").notNull(),
    reason: text("reason"),
    decisionSnapshot: jsonb("decision_snapshot")
      .$type<Record<string, unknown>>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    requestMemberKey: uniqueIndex(
      "partner_approval_decisions_request_member_key",
    ).on(table.approvalRequestId, table.decidedByMembershipId),
    accountHistoryIdx: index(
      "partner_approval_decisions_account_history_idx",
    ).on(table.partnerAccountId, table.createdAt),
    decisionCheck: check(
      "partner_approval_decisions_decision_check",
      sql`${table.decision} IN ('approved', 'declined')`,
    ),
  }),
);

export const partnerQuotes = pgTable(
  "partner_quotes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    authority: text("authority")
      .$type<"legacy_snapshot" | "quote_v2">()
      .default("legacy_snapshot")
      .notNull(),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "restrict" }),
    quoteId: uuid("quote_id"),
    partnerBookingId: uuid("partner_booking_id").references(
      () => partnerBookings.id,
      { onDelete: "restrict" },
    ),
    bookingDraftId: uuid("booking_draft_id").references(
      () => partnerBookingDrafts.id,
      { onDelete: "restrict" },
    ),
    partnerAccountLocationId: uuid("partner_account_location_id"),
    quoteNumber: text("quote_number"),
    version: integer("version").default(1),
    status: text("status").default("draft"),
    currency: varchar("currency", { length: 3 }).default("USD"),
    subtotalCents: integer("subtotal_cents"),
    taxCents: integer("tax_cents").default(0),
    discountCents: integer("discount_cents").default(0),
    totalCents: integer("total_cents"),
    lines: jsonb("lines").$type<Array<Record<string, unknown>>>(),
    terms: text("terms"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    declinedAt: timestamp("declined_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    documentId: uuid("document_id").references(() => partnerDocuments.id, {
      onDelete: "set null",
    }),
    createdByTeamMemberId: uuid("created_by_team_member_id").references(
      () => teamMembers.id,
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
    quoteAccountFk: foreignKey({
      name: "partner_quotes_quote_account_fk",
      columns: [table.quoteId, table.partnerAccountId],
      foreignColumns: [quotes.id, quotes.partnerAccountId],
    }).onDelete("restrict"),
    bookingAccountFk: foreignKey({
      name: "partner_quotes_booking_account_fk",
      columns: [table.partnerAccountId, table.partnerBookingId],
      foreignColumns: [partnerBookings.partnerAccountId, partnerBookings.id],
    }).onDelete("restrict"),
    draftAccountFk: foreignKey({
      name: "partner_quotes_draft_account_fk",
      columns: [table.partnerAccountId, table.bookingDraftId],
      foreignColumns: [
        partnerBookingDrafts.partnerAccountId,
        partnerBookingDrafts.id,
      ],
    }).onDelete("restrict"),
    locationAccountFk: foreignKey({
      name: "partner_quotes_location_account_fk",
      columns: [table.partnerAccountId, table.partnerAccountLocationId],
      foreignColumns: [
        partnerAccountLocations.partnerAccountId,
        partnerAccountLocations.id,
      ],
    }).onDelete("restrict"),
    quoteV2BindingKey: uniqueIndex("partner_quotes_quote_v2_binding_key")
      .on(table.quoteId)
      .where(sql`${table.authority} = 'quote_v2'`),
    quoteVersionKey: uniqueIndex("partner_quotes_quote_version_key").on(
      table.partnerAccountId,
      table.quoteNumber,
      table.version,
    ),
    accountAuthorityIdx: index("partner_quotes_account_authority_idx").on(
      table.partnerAccountId,
      table.authority,
      table.createdAt,
      table.id,
    ),
    accountBookingProjectionKey: uniqueIndex(
      "partner_quotes_account_booking_projection_key",
    ).on(table.partnerAccountId, table.partnerBookingId, table.id),
    accountStatusIdx: index("partner_quotes_account_status_idx").on(
      table.partnerAccountId,
      table.status,
      table.createdAt,
    ),
    authorityCheck: check(
      "partner_quotes_authority_check",
      sql`${table.authority} IN ('legacy_snapshot', 'quote_v2')`,
    ),
    projectionShapeCheck: check(
      "partner_quotes_projection_shape_check",
      sql`(${table.authority} = 'legacy_snapshot' AND ${table.quoteId} IS NULL AND ${table.partnerAccountLocationId} IS NULL AND ${table.quoteNumber} IS NOT NULL AND ${table.version} IS NOT NULL AND ${table.status} IS NOT NULL AND ${table.currency} IS NOT NULL AND ${table.subtotalCents} IS NOT NULL AND ${table.taxCents} IS NOT NULL AND ${table.discountCents} IS NOT NULL AND ${table.totalCents} IS NOT NULL AND ${table.lines} IS NOT NULL AND num_nonnulls(${table.partnerBookingId}, ${table.bookingDraftId}) >= 1) OR (${table.authority} = 'quote_v2' AND ${table.quoteId} IS NOT NULL AND num_nonnulls(${table.partnerBookingId}, ${table.bookingDraftId}, ${table.partnerAccountLocationId}) = 1 AND ${table.quoteNumber} IS NULL AND ${table.version} IS NULL AND ${table.status} IS NULL AND ${table.currency} IS NULL AND ${table.subtotalCents} IS NULL AND ${table.taxCents} IS NULL AND ${table.discountCents} IS NULL AND ${table.totalCents} IS NULL AND ${table.lines} IS NULL AND ${table.terms} IS NULL AND ${table.expiresAt} IS NULL AND ${table.sentAt} IS NULL AND ${table.acceptedAt} IS NULL AND ${table.declinedAt} IS NULL AND ${table.supersededAt} IS NULL AND ${table.documentId} IS NULL)`,
    ),
    statusCheck: check(
      "partner_quotes_status_check",
      sql`${table.status} IN ('draft', 'sent', 'accepted', 'declined', 'expired', 'superseded')`,
    ),
    totalsCheck: check(
      "partner_quotes_totals_check",
      sql`${table.subtotalCents} >= 0 AND ${table.taxCents} >= 0 AND ${table.discountCents} >= 0 AND ${table.totalCents} = ${table.subtotalCents} + ${table.taxCents} - ${table.discountCents} AND ${table.totalCents} >= 0`,
    ),
    currencyCheck: check(
      "partner_quotes_currency_check",
      sql`${table.currency} ~ '^[A-Z]{3}$'`,
    ),
    versionCheck: check(
      "partner_quotes_version_check",
      sql`${table.version} > 0`,
    ),
  }),
);

export const partnerInvoices = pgTable(
  "partner_invoices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "restrict" }),
    partnerBookingId: uuid("partner_booking_id").references(
      () => partnerBookings.id,
      { onDelete: "restrict" },
    ),
    invoiceNumber: text("invoice_number").notNull(),
    status: text("status").default("draft").notNull(),
    currency: varchar("currency", { length: 3 }).default("USD").notNull(),
    subtotalCents: integer("subtotal_cents").notNull(),
    taxCents: integer("tax_cents").default(0).notNull(),
    discountCents: integer("discount_cents").default(0).notNull(),
    depositCents: integer("deposit_cents").default(0).notNull(),
    totalCents: integer("total_cents").notNull(),
    paidCents: integer("paid_cents").default(0).notNull(),
    balanceCents: integer("balance_cents").notNull(),
    poNumber: text("po_number"),
    costCenter: text("cost_center"),
    billingContact: jsonb("billing_contact")
      .$type<Record<string, unknown>>()
      .notNull(),
    terms: text("terms"),
    dueDate: date("due_date"),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    provider: text("provider"),
    providerInvoiceId: text("provider_invoice_id"),
    providerOrderId: text("provider_order_id"),
    hostedPaymentUrl: text("hosted_payment_url"),
    documentId: uuid("document_id").references(() => partnerDocuments.id, {
      onDelete: "set null",
    }),
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
    accountIdKey: uniqueIndex("partner_invoices_account_id_key").on(
      table.partnerAccountId,
      table.id,
    ),
    bookingAccountFk: foreignKey({
      name: "partner_invoices_account_booking_fk",
      columns: [table.partnerAccountId, table.partnerBookingId],
      foreignColumns: [partnerBookings.partnerAccountId, partnerBookings.id],
    }).onDelete("restrict"),
    accountInvoiceKey: uniqueIndex("partner_invoices_account_invoice_key").on(
      table.partnerAccountId,
      table.invoiceNumber,
    ),
    providerInvoiceKey: uniqueIndex("partner_invoices_provider_invoice_key")
      .on(table.provider, table.providerInvoiceId)
      .where(sql`${table.providerInvoiceId} IS NOT NULL`),
    accountStatusIdx: index("partner_invoices_account_status_idx").on(
      table.partnerAccountId,
      table.status,
      table.dueDate,
      table.createdAt,
    ),
    statusCheck: check(
      "partner_invoices_status_check",
      sql`${table.status} IN ('draft', 'issued', 'partially_paid', 'paid', 'overdue', 'void')`,
    ),
    totalsCheck: check(
      "partner_invoices_totals_check",
      sql`${table.subtotalCents} >= 0 AND ${table.taxCents} >= 0 AND ${table.discountCents} >= 0 AND ${table.depositCents} >= 0 AND ${table.totalCents} = ${table.subtotalCents} + ${table.taxCents} - ${table.discountCents} AND ${table.paidCents} >= 0 AND ${table.balanceCents} = ${table.totalCents} - ${table.paidCents} AND ${table.balanceCents} >= 0`,
    ),
    currencyCheck: check(
      "partner_invoices_currency_check",
      sql`${table.currency} ~ '^[A-Z]{3}$'`,
    ),
    versionCheck: check(
      "partner_invoices_version_check",
      sql`${table.version} > 0`,
    ),
  }),
);

export type PartnerBillingDisputeCategory =
  | "invoice_amount"
  | "duplicate_charge"
  | "payment_not_reflected"
  | "service_concern"
  | "refund_request"
  | "tax_or_document"
  | "other";

export type PartnerBillingDisputeState =
  | "pending"
  | "information_provided"
  | "adjustment_required"
  | "refund_review"
  | "declined";

export type PartnerBillingDisputeRequestSnapshot = Readonly<{
  version: 1;
  requestedAt: string;
  invoice: Readonly<{
    id: string;
    invoiceNumber: string;
    version: number;
    status: string;
    currency: string;
    totalMinor: number;
    paidMinor: number;
    balanceMinor: number;
    bookingId: string | null;
  }>;
  evidence: Readonly<{
    disputedAmountMinor: number | null;
    reference: string | null;
    details: string | null;
  }>;
  replayReceipt: Readonly<{
    version: 1;
    status: 201;
    correlationId: string;
    etag: string;
    message: string;
  }>;
}>;

export type PartnerBillingDisputeResolutionSnapshot = Readonly<{
  version: 1;
  outcome: Exclude<PartnerBillingDisputeState, "pending">;
  resolvedAt: string;
  invoiceVersion: number;
  invoiceStatus: string;
  monetaryMutationPerformed: false;
  providerActionPerformed: false;
}>;

/**
 * Account/invoice-owned billing questions, disputes, and refund-review
 * requests. The lifecycle only classifies Staff follow-up; it never mutates
 * financial/provider state.
 */
export const partnerBillingDisputeRequests = pgTable(
  "partner_billing_dispute_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "restrict" }),
    partnerInvoiceId: uuid("partner_invoice_id").notNull(),
    partnerBookingId: uuid("partner_booking_id"),
    requestedByMembershipId: uuid("requested_by_membership_id").notNull(),
    conversationThreadId: uuid("conversation_thread_id").notNull(),
    threadScope: text("thread_scope").$type<"account_billing">().notNull(),
    category: text("category").$type<PartnerBillingDisputeCategory>().notNull(),
    reason: text("reason").notNull(),
    requestSnapshot: jsonb("request_snapshot")
      .$type<PartnerBillingDisputeRequestSnapshot>()
      .notNull(),
    operationKeyHash: varchar("operation_key_hash", { length: 64 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    state: text("state")
      .$type<PartnerBillingDisputeState>()
      .default("pending")
      .notNull(),
    revision: integer("revision").default(1).notNull(),
    resolvedByTeamMemberId: uuid("resolved_by_team_member_id").references(
      () => teamMembers.id,
      { onDelete: "restrict" },
    ),
    resolutionReason: text("resolution_reason"),
    resolutionSnapshot: jsonb(
      "resolution_snapshot",
    ).$type<PartnerBillingDisputeResolutionSnapshot | null>(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    invoiceAccountFk: foreignKey({
      name: "partner_billing_disputes_invoice_account_fk",
      columns: [table.partnerAccountId, table.partnerInvoiceId],
      foreignColumns: [partnerInvoices.partnerAccountId, partnerInvoices.id],
    }).onDelete("restrict"),
    bookingAccountFk: foreignKey({
      name: "partner_billing_disputes_booking_account_fk",
      columns: [table.partnerAccountId, table.partnerBookingId],
      foreignColumns: [partnerBookings.partnerAccountId, partnerBookings.id],
    }).onDelete("restrict"),
    requesterAccountFk: foreignKey({
      name: "partner_billing_disputes_requester_account_fk",
      columns: [table.requestedByMembershipId, table.partnerAccountId],
      foreignColumns: [
        partnerAccountMemberships.id,
        partnerAccountMemberships.partnerAccountId,
      ],
    }).onDelete("restrict"),
    threadAccountFk: foreignKey({
      name: "partner_billing_disputes_thread_account_fk",
      columns: [table.partnerAccountId, table.conversationThreadId],
      foreignColumns: [
        conversationThreads.partnerAccountId,
        conversationThreads.id,
      ],
    }).onDelete("restrict"),
    accountRequestKey: uniqueIndex(
      "partner_billing_disputes_account_request_key",
    ).on(table.partnerAccountId, table.id),
    accountOperationKey: uniqueIndex(
      "partner_billing_disputes_account_operation_key",
    ).on(table.partnerAccountId, table.operationKeyHash),
    pendingInvoiceKey: uniqueIndex(
      "partner_billing_disputes_pending_invoice_key",
    )
      .on(table.partnerAccountId, table.partnerInvoiceId)
      .where(sql`${table.state} = 'pending'`),
    accountBillingThreadKey: uniqueIndex(
      "partner_billing_disputes_account_thread_key",
    )
      .on(table.conversationThreadId)
      .where(sql`${table.threadScope} = 'account_billing'`),
    accountStateIdx: index("partner_billing_disputes_account_state_idx").on(
      table.partnerAccountId,
      table.state,
      table.createdAt,
      table.id,
    ),
    invoiceHistoryIdx: index("partner_billing_disputes_invoice_history_idx").on(
      table.partnerAccountId,
      table.partnerInvoiceId,
      table.createdAt,
      table.id,
    ),
    bookingHistoryIdx: index("partner_billing_disputes_booking_history_idx")
      .on(
        table.partnerAccountId,
        table.partnerBookingId,
        table.createdAt,
        table.id,
      )
      .where(sql`${table.partnerBookingId} IS NOT NULL`),
    threadScopeCheck: check(
      "partner_billing_disputes_thread_scope_check",
      sql`${table.threadScope} = 'account_billing'`,
    ),
    categoryCheck: check(
      "partner_billing_disputes_category_check",
      sql`${table.category} IN ('invoice_amount', 'duplicate_charge', 'payment_not_reflected', 'service_concern', 'refund_request', 'tax_or_document', 'other')`,
    ),
    reasonCheck: check(
      "partner_billing_disputes_reason_check",
      sql`${table.reason} = btrim(${table.reason}) AND length(${table.reason}) BETWEEN 10 AND 2000`,
    ),
    snapshotCheck: check(
      "partner_billing_disputes_snapshot_check",
      sql`jsonb_typeof(${table.requestSnapshot}) = 'object' AND ${table.requestSnapshot} @> '{"version": 1}'::jsonb AND ${table.requestSnapshot} ? 'replayReceipt' AND jsonb_typeof(${table.requestSnapshot} -> 'replayReceipt') = 'object' AND ${table.requestSnapshot} -> 'replayReceipt' @> '{"version": 1, "status": 201}'::jsonb AND ${table.requestSnapshot} -> 'replayReceipt' ? 'correlationId' AND jsonb_typeof(${table.requestSnapshot} -> 'replayReceipt' -> 'correlationId') = 'string' AND ${table.requestSnapshot} -> 'replayReceipt' ->> 'correlationId' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' AND ${table.requestSnapshot} -> 'replayReceipt' ? 'etag' AND jsonb_typeof(${table.requestSnapshot} -> 'replayReceipt' -> 'etag') = 'string' AND ${table.requestSnapshot} -> 'replayReceipt' ->> 'etag' ~ '^"[A-Za-z0-9_-]{43}"$' AND ${table.requestSnapshot} -> 'replayReceipt' ? 'message' AND jsonb_typeof(${table.requestSnapshot} -> 'replayReceipt' -> 'message') = 'string' AND length(${table.requestSnapshot} -> 'replayReceipt' ->> 'message') BETWEEN 1 AND 500`,
    ),
    operationHashCheck: check(
      "partner_billing_disputes_operation_hash_check",
      sql`${table.operationKeyHash} ~ '^[0-9a-f]{64}$'`,
    ),
    requestHashCheck: check(
      "partner_billing_disputes_request_hash_check",
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    stateCheck: check(
      "partner_billing_disputes_state_check",
      sql`${table.state} IN ('pending', 'information_provided', 'adjustment_required', 'refund_review', 'declined')`,
    ),
    revisionCheck: check(
      "partner_billing_disputes_revision_check",
      sql`${table.revision} > 0`,
    ),
    resolutionCheck: check(
      "partner_billing_disputes_resolution_check",
      sql`(${table.state} = 'pending' AND ${table.resolvedByTeamMemberId} IS NULL AND ${table.resolutionReason} IS NULL AND ${table.resolutionSnapshot} IS NULL AND ${table.resolvedAt} IS NULL) OR (${table.state} IN ('information_provided', 'adjustment_required', 'refund_review', 'declined') AND ${table.resolvedByTeamMemberId} IS NOT NULL AND ${table.resolutionReason} IS NOT NULL AND length(btrim(${table.resolutionReason})) BETWEEN 12 AND 2000 AND ${table.resolutionSnapshot} IS NOT NULL AND jsonb_typeof(${table.resolutionSnapshot}) = 'object' AND ${table.resolutionSnapshot} @> '{"version": 1, "monetaryMutationPerformed": false, "providerActionPerformed": false}'::jsonb AND ${table.resolutionSnapshot} ? 'outcome' AND jsonb_typeof(${table.resolutionSnapshot} -> 'outcome') = 'string' AND ${table.resolutionSnapshot} ->> 'outcome' = ${table.state} AND ${table.resolvedAt} IS NOT NULL)`,
    ),
  }),
);

export const partnerInvoiceLines = pgTable(
  "partner_invoice_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerInvoiceId: uuid("partner_invoice_id")
      .notNull()
      .references(() => partnerInvoices.id, { onDelete: "restrict" }),
    lineNumber: integer("line_number").notNull(),
    kind: text("kind").default("service").notNull(),
    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 12, scale: 3 })
      .default("1")
      .notNull(),
    unitAmountCents: integer("unit_amount_cents").notNull(),
    lineTotalCents: integer("line_total_cents").notNull(),
    taxCode: text("tax_code"),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    invoiceLineKey: uniqueIndex("partner_invoice_lines_invoice_line_key").on(
      table.partnerInvoiceId,
      table.lineNumber,
    ),
    lineNumberCheck: check(
      "partner_invoice_lines_line_number_check",
      sql`${table.lineNumber} > 0`,
    ),
    amountCheck: check(
      "partner_invoice_lines_amount_check",
      sql`${table.unitAmountCents} >= 0 AND ${table.lineTotalCents} >= 0 AND ${table.quantity} > 0`,
    ),
  }),
);

export const partnerPaymentAllocations = pgTable(
  "partner_payment_allocations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "restrict" }),
    partnerInvoiceId: uuid("partner_invoice_id")
      .notNull()
      .references(() => partnerInvoices.id, { onDelete: "restrict" }),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id, { onDelete: "restrict" }),
    amountCents: integer("amount_cents").notNull(),
    state: text("state").default("pending").notNull(),
    allocatedAt: timestamp("allocated_at", { withTimezone: true }),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    invoicePaymentKey: uniqueIndex(
      "partner_payment_allocations_invoice_payment_key",
    ).on(table.partnerInvoiceId, table.paymentId),
    accountStateIdx: index("partner_payment_allocations_account_state_idx").on(
      table.partnerAccountId,
      table.state,
      table.createdAt,
    ),
    amountCheck: check(
      "partner_payment_allocations_amount_check",
      sql`${table.amountCents} > 0`,
    ),
    stateCheck: check(
      "partner_payment_allocations_state_check",
      sql`${table.state} IN ('pending', 'settled', 'reversed')`,
    ),
  }),
);

export const partnerStatements = pgTable(
  "partner_statements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "restrict" }),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    currency: varchar("currency", { length: 3 }).default("USD").notNull(),
    openingBalanceCents: integer("opening_balance_cents").notNull(),
    invoiceCents: integer("invoice_cents").notNull(),
    paymentCents: integer("payment_cents").notNull(),
    refundCents: integer("refund_cents").notNull(),
    creditCents: integer("credit_cents").notNull(),
    closingBalanceCents: integer("closing_balance_cents").notNull(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => partnerDocuments.id, { onDelete: "restrict" }),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    accountPeriodCurrencyKey: uniqueIndex(
      "partner_statements_account_period_currency_key",
    ).on(
      table.partnerAccountId,
      table.periodStart,
      table.periodEnd,
      table.currency,
    ),
    accountPeriodIdx: index("partner_statements_account_period_idx").on(
      table.partnerAccountId,
      table.periodEnd,
    ),
    periodCheck: check(
      "partner_statements_period_check",
      sql`${table.periodEnd} >= ${table.periodStart}`,
    ),
    balanceCheck: check(
      "partner_statements_balance_check",
      sql`${table.closingBalanceCents} = ${table.openingBalanceCents} + ${table.invoiceCents} + ${table.refundCents} - ${table.paymentCents} - ${table.creditCents}`,
    ),
    currencyCheck: check(
      "partner_statements_currency_check",
      sql`${table.currency} ~ '^[A-Z]{3}$'`,
    ),
  }),
);

// Quote V2 is intentionally appended after the legacy quote schema. Existing
// quote rows stay on the legacy engine until explicitly moved to this aggregate.
export const salesOpportunities = pgTable(
  "sales_opportunities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "restrict" }),
    propertyId: uuid("property_id").references(() => properties.id, {
      onDelete: "set null",
    }),
    leadId: uuid("lead_id").references(() => leads.id, {
      onDelete: "set null",
    }),
    ownerTeamMemberId: uuid("owner_team_member_id").references(
      () => teamMembers.id,
      { onDelete: "set null" },
    ),
    name: text("name").notNull(),
    status: text("status").default("open").notNull(),
    pipelineStage: text("pipeline_stage"),
    currency: varchar("currency", { length: 3 }).default("USD").notNull(),
    estimatedValueCents: integer("estimated_value_cents"),
    revision: integer("revision").default(1).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default({})
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
    contactStatusIdx: index("sales_opportunities_contact_status_idx").on(
      table.contactId,
      table.status,
      table.createdAt,
    ),
    propertyIdx: index("sales_opportunities_property_idx").on(table.propertyId),
    ownerStatusIdx: index("sales_opportunities_owner_status_idx").on(
      table.ownerTeamMemberId,
      table.status,
    ),
    statusCheck: check(
      "sales_opportunities_status_check",
      sql`${table.status} IN ('open', 'approved', 'won', 'lost', 'archived')`,
    ),
    currencyCheck: check(
      "sales_opportunities_currency_check",
      sql`${table.currency} ~ '^[A-Z]{3}$'`,
    ),
    estimatedValueCheck: check(
      "sales_opportunities_estimated_value_check",
      sql`${table.estimatedValueCents} IS NULL OR ${table.estimatedValueCents} >= 0`,
    ),
    revisionCheck: check(
      "sales_opportunities_revision_check",
      sql`${table.revision} > 0`,
    ),
    closedCheck: check(
      "sales_opportunities_closed_check",
      sql`${table.status} IN ('open', 'approved') OR ${table.closedAt} IS NOT NULL`,
    ),
  }),
);

export const quoteVersions = pgTable(
  "quote_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    quoteId: uuid("quote_id")
      .notNull()
      .references(() => quotes.id, { onDelete: "restrict" }),
    versionNumber: integer("version_number").notNull(),
    draftRevision: integer("draft_revision").default(1).notNull(),
    supersedesVersionId: uuid("supersedes_version_id"),
    state: text("state").default("draft").notNull(),
    provenance: text("provenance").default("native").notNull(),
    schemaVersion: integer("schema_version").default(1).notNull(),
    documentType: text("document_type").notNull(),
    audience: text("audience").notNull(),
    schedulingMode: text("scheduling_mode").notNull(),
    currency: varchar("currency", { length: 3 }).default("USD").notNull(),
    documentSnapshot: jsonb("document_snapshot")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    partySnapshot: jsonb("party_snapshot")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    issuerSnapshot: jsonb("issuer_snapshot")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    termsSnapshot: jsonb("terms_snapshot")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    canonicalRenderJson: text("canonical_render_json"),
    documentSchemaHash: varchar("document_schema_hash", { length: 64 }),
    pricingHash: varchar("pricing_hash", { length: 64 }),
    templateHash: varchar("template_hash", { length: 64 }),
    contentHash: varchar("content_hash", { length: 64 }),
    clientName: text("client_name"),
    clientCompany: text("client_company"),
    clientEmail: text("client_email"),
    clientPhone: text("client_phone"),
    projectName: text("project_name"),
    purchaseOrderNumber: text("purchase_order_number"),
    referenceNumber: text("reference_number"),
    selectedOptionIds: text("selected_option_ids")
      .array()
      .default([])
      .notNull(),
    subtotalMinCents: integer("subtotal_min_cents").default(0).notNull(),
    subtotalMaxCents: integer("subtotal_max_cents").default(0).notNull(),
    discountMinCents: integer("discount_min_cents").default(0).notNull(),
    discountMaxCents: integer("discount_max_cents").default(0).notNull(),
    feeMinCents: integer("fee_min_cents").default(0).notNull(),
    feeMaxCents: integer("fee_max_cents").default(0).notNull(),
    totalMinCents: integer("total_min_cents").default(0).notNull(),
    totalMaxCents: integer("total_max_cents").default(0).notNull(),
    depositCents: integer("deposit_cents").default(0).notNull(),
    balanceMinCents: integer("balance_min_cents").default(0).notNull(),
    balanceMaxCents: integer("balance_max_cents").default(0).notNull(),
    scope: text("scope"),
    assumptions: text("assumptions"),
    exclusions: text("exclusions"),
    terms: text("terms"),
    paymentTerms: text("payment_terms"),
    internalNotes: text("internal_notes"),
    validFrom: timestamp("valid_from", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    firstSentAt: timestamp("first_sent_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdByTeamMemberId: uuid("created_by_team_member_id").references(
      () => teamMembers.id,
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
    idQuoteKey: uniqueIndex("quote_versions_id_quote_key").on(
      table.id,
      table.quoteId,
    ),
    quoteVersionKey: uniqueIndex("quote_versions_quote_version_key").on(
      table.quoteId,
      table.versionNumber,
    ),
    quoteStateIdx: index("quote_versions_quote_state_idx").on(
      table.quoteId,
      table.state,
      table.createdAt,
    ),
    expiresIdx: index("quote_versions_expires_idx").on(
      table.state,
      table.expiresAt,
    ),
    versionCheck: check(
      "quote_versions_version_check",
      sql`${table.versionNumber} > 0 AND ${table.draftRevision} > 0 AND ${table.schemaVersion} > 0`,
    ),
    stateCheck: check(
      "quote_versions_state_check",
      sql`${table.state} IN ('draft', 'ready', 'issued', 'superseded', 'accepted', 'expired', 'declined', 'voided')`,
    ),
    provenanceCheck: check(
      "quote_versions_provenance_check",
      sql`${table.provenance} IN ('native', 'legacy_current_state')`,
    ),
    documentTypeCheck: check(
      "quote_versions_document_type_check",
      sql`${table.documentType} IN ('fixed_quote', 'estimate', 'range')`,
    ),
    audienceCheck: check(
      "quote_versions_audience_check",
      sql`${table.audience} IN ('residential', 'commercial')`,
    ),
    schedulingModeCheck: check(
      "quote_versions_scheduling_mode_check",
      sql`${table.schedulingMode} IN ('self_schedule', 'staff_followup', 'approval_only')`,
    ),
    currencyCheck: check(
      "quote_versions_currency_check",
      sql`${table.currency} ~ '^[A-Z]{3}$'`,
    ),
    snapshotShapeCheck: check(
      "quote_versions_snapshot_shape_check",
      sql`jsonb_typeof(${table.documentSnapshot}) = 'object' AND jsonb_typeof(${table.partySnapshot}) = 'object' AND jsonb_typeof(${table.issuerSnapshot}) = 'object' AND jsonb_typeof(${table.termsSnapshot}) = 'object' AND (${table.canonicalRenderJson} IS NULL OR jsonb_typeof(${table.canonicalRenderJson}::jsonb) = 'object')`,
    ),
    totalsCheck: check(
      "quote_versions_totals_check",
      sql`${table.subtotalMinCents} >= 0 AND ${table.subtotalMaxCents} >= ${table.subtotalMinCents} AND ${table.discountMinCents} >= 0 AND ${table.discountMaxCents} >= ${table.discountMinCents} AND ${table.feeMinCents} >= 0 AND ${table.feeMaxCents} >= ${table.feeMinCents} AND ${table.totalMinCents} = ${table.subtotalMinCents} - ${table.discountMinCents} + ${table.feeMinCents} AND ${table.totalMaxCents} = ${table.subtotalMaxCents} - ${table.discountMaxCents} + ${table.feeMaxCents} AND ${table.totalMinCents} >= 0 AND ${table.totalMaxCents} >= ${table.totalMinCents}`,
    ),
    depositCheck: check(
      "quote_versions_deposit_check",
      sql`${table.depositCents} >= 0 AND ${table.depositCents} <= ${table.totalMinCents} AND ${table.balanceMinCents} = ${table.totalMinCents} - ${table.depositCents} AND ${table.balanceMaxCents} = ${table.totalMaxCents} - ${table.depositCents}`,
    ),
    rangeCheck: check(
      "quote_versions_range_check",
      sql`${table.state} IN ('draft', 'voided') OR (${table.documentType} = 'range' AND ${table.totalMinCents} > 0 AND ${table.totalMaxCents} > ${table.totalMinCents}) OR (${table.documentType} <> 'range' AND ${table.totalMinCents} > 0 AND ${table.totalMaxCents} = ${table.totalMinCents})`,
    ),
    hashesCheck: check(
      "quote_versions_hashes_check",
      sql`(${table.documentSchemaHash} IS NULL OR ${table.documentSchemaHash} ~ '^[0-9a-f]{64}$') AND (${table.pricingHash} IS NULL OR ${table.pricingHash} ~ '^[0-9a-f]{64}$') AND (${table.templateHash} IS NULL OR ${table.templateHash} ~ '^[0-9a-f]{64}$') AND (${table.contentHash} IS NULL OR ${table.contentHash} ~ '^[0-9a-f]{64}$')`,
    ),
    validityCheck: check(
      "quote_versions_validity_check",
      sql`${table.expiresAt} IS NULL OR ${table.validFrom} IS NULL OR ${table.expiresAt} > ${table.validFrom}`,
    ),
    readinessCheck: check(
      "quote_versions_readiness_check",
      sql`${table.state} IN ('draft', 'voided') OR ${table.readyAt} IS NOT NULL`,
    ),
    readyPublicationCheck: check(
      "quote_versions_ready_publication_check",
      sql`(${table.state} <> 'draft' OR (${table.validFrom} IS NULL AND ${table.expiresAt} IS NULL AND ${table.issuedAt} IS NULL AND ${table.firstSentAt} IS NULL AND ${table.canonicalRenderJson} IS NULL AND ${table.documentSchemaHash} IS NULL AND ${table.pricingHash} IS NULL AND ${table.templateHash} IS NULL AND ${table.contentHash} IS NULL)) AND (${table.state} <> 'ready' OR (${table.validFrom} IS NULL AND ${table.expiresAt} IS NULL AND ${table.issuedAt} IS NULL AND ${table.firstSentAt} IS NULL AND ${table.canonicalRenderJson} IS NOT NULL AND ${table.documentSchemaHash} IS NOT NULL AND ${table.pricingHash} IS NOT NULL AND ${table.templateHash} IS NOT NULL AND ${table.contentHash} IS NOT NULL))`,
    ),
    issuanceCheck: check(
      "quote_versions_issuance_check",
      sql`${table.state} IN ('draft', 'ready', 'voided') OR (${table.readyAt} IS NOT NULL AND ${table.issuedAt} IS NOT NULL AND ${table.expiresAt} IS NOT NULL AND ${table.expiresAt} > ${table.issuedAt} AND ${table.canonicalRenderJson} IS NOT NULL AND ${table.documentSchemaHash} IS NOT NULL AND ${table.pricingHash} IS NOT NULL AND ${table.templateHash} IS NOT NULL AND ${table.contentHash} IS NOT NULL)`,
    ),
    timelineCheck: check(
      "quote_versions_timeline_check",
      sql`(${table.issuedAt} IS NULL OR (${table.readyAt} IS NOT NULL AND ${table.issuedAt} >= ${table.readyAt})) AND (${table.firstSentAt} IS NULL OR (${table.issuedAt} IS NOT NULL AND ${table.firstSentAt} >= ${table.issuedAt})) AND (${table.supersededAt} IS NULL OR (${table.issuedAt} IS NOT NULL AND ${table.supersededAt} >= ${table.issuedAt}))`,
    ),
    supersededCheck: check(
      "quote_versions_superseded_check",
      sql`${table.state} <> 'superseded' OR ${table.supersededAt} IS NOT NULL`,
    ),
  }),
);

export const quoteVersionOptionGroups = pgTable(
  "quote_version_option_groups",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    quoteVersionId: uuid("quote_version_id")
      .notNull()
      .references(() => quoteVersions.id, { onDelete: "cascade" }),
    groupKey: varchar("group_key", { length: 80 }).notNull(),
    label: varchar("label", { length: 200 }).notNull(),
    mode: text("mode").notNull(),
    minimumSelections: integer("minimum_selections").default(0).notNull(),
    maximumSelections: integer("maximum_selections").notNull(),
    displayOrder: integer("display_order").default(0).notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    idVersionKey: uniqueIndex("quote_option_groups_id_version_key").on(
      table.id,
      table.quoteVersionId,
    ),
    versionGroupKey: uniqueIndex("quote_option_groups_version_group_key").on(
      table.quoteVersionId,
      table.groupKey,
    ),
    versionOrderKey: uniqueIndex("quote_option_groups_version_order_key").on(
      table.quoteVersionId,
      table.displayOrder,
    ),
    modeCheck: check(
      "quote_option_groups_mode_check",
      sql`${table.mode} IN ('single', 'multiple')`,
    ),
    selectionsCheck: check(
      "quote_option_groups_selections_check",
      sql`${table.minimumSelections} BETWEEN 0 AND 100 AND ${table.maximumSelections} BETWEEN 1 AND 100 AND ${table.minimumSelections} <= ${table.maximumSelections} AND (${table.mode} <> 'single' OR ${table.maximumSelections} = 1)`,
    ),
    displayOrderCheck: check(
      "quote_option_groups_display_order_check",
      sql`${table.displayOrder} BETWEEN 0 AND 10000`,
    ),
  }),
);

export const quoteVersionLineItems = pgTable(
  "quote_version_line_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    quoteVersionId: uuid("quote_version_id")
      .notNull()
      .references(() => quoteVersions.id, { onDelete: "cascade" }),
    lineKey: varchar("line_key", { length: 80 }).notNull(),
    catalogKey: varchar("catalog_key", { length: 120 }),
    name: varchar("name", { length: 240 }).notNull(),
    description: text("description"),
    quantity: numeric("quantity", { precision: 12, scale: 3 })
      .default("1")
      .notNull(),
    unit: varchar("unit", { length: 40 }).notNull(),
    unitPriceMinCents: integer("unit_price_min_cents").notNull(),
    unitPriceMaxCents: integer("unit_price_max_cents").notNull(),
    amountMinCents: integer("amount_min_cents").notNull(),
    amountMaxCents: integer("amount_max_cents").notNull(),
    optionGroupId: uuid("option_group_id").references(
      () => quoteVersionOptionGroups.id,
      { onDelete: "restrict" },
    ),
    selectedByDefault: boolean("selected_by_default").default(false).notNull(),
    displayOrder: integer("display_order").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    versionLineKey: uniqueIndex("quote_line_items_version_line_key").on(
      table.quoteVersionId,
      table.lineKey,
    ),
    versionOrderKey: uniqueIndex("quote_line_items_version_order_key").on(
      table.quoteVersionId,
      table.displayOrder,
    ),
    amountsCheck: check(
      "quote_version_line_items_amounts_check",
      sql`${table.quantity} > 0 AND ${table.quantity} <= 1000000 AND ${table.unitPriceMinCents} >= 0 AND ${table.unitPriceMaxCents} >= ${table.unitPriceMinCents} AND ${table.amountMinCents} >= 0 AND ${table.amountMaxCents} >= ${table.amountMinCents}`,
    ),
    optionCheck: check(
      "quote_version_line_items_option_check",
      sql`${table.optionGroupId} IS NOT NULL OR ${table.selectedByDefault} = false`,
    ),
    displayOrderCheck: check(
      "quote_version_line_items_display_order_check",
      sql`${table.displayOrder} BETWEEN 0 AND 10000`,
    ),
  }),
);

export const quoteVersionAdjustments = pgTable(
  "quote_version_adjustments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    quoteVersionId: uuid("quote_version_id")
      .notNull()
      .references(() => quoteVersions.id, { onDelete: "cascade" }),
    adjustmentKey: varchar("adjustment_key", { length: 80 }).notNull(),
    kind: text("kind").notNull(),
    label: varchar("label", { length: 240 }).notNull(),
    calculation: text("calculation").notNull(),
    basis: text("basis").default("subtotal").notNull(),
    eligibleLineItemKeys: text("eligible_line_item_keys")
      .array()
      .default([])
      .notNull(),
    amountCents: integer("amount_cents"),
    basisPoints: integer("basis_points"),
    amountMinCents: integer("amount_min_cents").notNull(),
    amountMaxCents: integer("amount_max_cents").notNull(),
    displayOrder: integer("display_order").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    versionAdjustmentKey: uniqueIndex(
      "quote_adjustments_version_adjustment_key",
    ).on(table.quoteVersionId, table.adjustmentKey),
    versionOrderKey: uniqueIndex("quote_adjustments_version_order_key").on(
      table.quoteVersionId,
      table.displayOrder,
    ),
    kindCheck: check(
      "quote_version_adjustments_kind_check",
      sql`${table.kind} IN ('discount', 'fee', 'travel')`,
    ),
    calculationCheck: check(
      "quote_version_adjustments_calculation_check",
      sql`(${table.calculation} = 'fixed' AND ${table.amountCents} IS NOT NULL AND ${table.amountCents} >= 0 AND ${table.basisPoints} IS NULL) OR (${table.calculation} = 'percentage' AND ${table.amountCents} IS NULL AND ${table.basisPoints} BETWEEN 1 AND 10000)`,
    ),
    basisCheck: check(
      "quote_version_adjustments_basis_check",
      sql`(${table.basis} = 'subtotal' AND cardinality(${table.eligibleLineItemKeys}) = 0) OR (${table.basis} = 'line_items' AND cardinality(${table.eligibleLineItemKeys}) > 0)`,
    ),
    computedAmountCheck: check(
      "quote_version_adjustments_computed_amount_check",
      sql`${table.amountMinCents} >= 0 AND ${table.amountMaxCents} >= ${table.amountMinCents}`,
    ),
    displayOrderCheck: check(
      "quote_version_adjustments_display_order_check",
      sql`${table.displayOrder} BETWEEN 0 AND 10000`,
    ),
  }),
);

export const quoteVersionAttachments = pgTable(
  "quote_version_attachments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    quoteVersionId: uuid("quote_version_id")
      .notNull()
      .references(() => quoteVersions.id, { onDelete: "cascade" }),
    mediaAssetId: uuid("media_asset_id")
      .notNull()
      .references(() => mediaAssets.id, { onDelete: "restrict" }),
    purpose: text("purpose").default("scope_evidence").notNull(),
    position: integer("position").default(0).notNull(),
    label: text("label"),
    description: text("description"),
    customerVisible: boolean("customer_visible").default(true).notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    attachedByTeamMemberId: uuid("attached_by_team_member_id").references(
      () => teamMembers.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    versionAssetKey: uniqueIndex(
      "quote_version_attachments_version_asset_key",
    ).on(table.quoteVersionId, table.mediaAssetId),
    versionPositionKey: uniqueIndex(
      "quote_version_attachments_version_position_key",
    ).on(table.quoteVersionId, table.position),
    positionCheck: check(
      "quote_version_attachments_position_check",
      sql`${table.position} >= 0`,
    ),
    purposeCheck: check(
      "quote_version_attachments_purpose_check",
      sql`${table.purpose} IN ('scope_evidence', 'site_plan', 'specification', 'terms', 'other', 'internal')`,
    ),
    visibilityCheck: check(
      "quote_version_attachments_visibility_check",
      sql`${table.purpose} <> 'internal' OR ${table.customerVisible} = false`,
    ),
  }),
);

export const quoteVersionDocuments = pgTable(
  "quote_version_documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    quoteVersionId: uuid("quote_version_id")
      .notNull()
      .references(() => quoteVersions.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    storageProvider: text("storage_provider").notNull(),
    storageBucket: text("storage_bucket").notNull(),
    storageObjectKey: text("storage_object_key").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    generatedByTeamMemberId: uuid("generated_by_team_member_id").references(
      () => teamMembers.id,
      { onDelete: "set null" },
    ),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    storageKey: uniqueIndex("quote_version_documents_storage_key").on(
      table.storageProvider,
      table.storageBucket,
      table.storageObjectKey,
    ),
    versionKindIdx: index("quote_version_documents_version_kind_idx").on(
      table.quoteVersionId,
      table.kind,
      table.generatedAt,
    ),
    kindCheck: check(
      "quote_version_documents_kind_check",
      sql`${table.kind} IN ('proposal_pdf', 'acceptance_pdf', 'other')`,
    ),
    byteSizeCheck: check(
      "quote_version_documents_byte_size_check",
      sql`${table.byteSize} > 0`,
    ),
    hashCheck: check(
      "quote_version_documents_hash_check",
      sql`${table.sha256} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);

export const quoteCapabilities = pgTable(
  "quote_capabilities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    quoteId: uuid("quote_id")
      .notNull()
      .references(() => quotes.id, { onDelete: "restrict" }),
    quoteVersionId: uuid("quote_version_id")
      .notNull()
      .references(() => quoteVersions.id, { onDelete: "restrict" }),
    recipientRole: text("recipient_role").notNull(),
    recipientAddressHash: varchar("recipient_address_hash", {
      length: 64,
    }).notNull(),
    allowedActions: text("allowed_actions").array().default(["view"]).notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    status: text("status").default("active").notNull(),
    readExpiresAt: timestamp("read_expires_at", {
      withTimezone: true,
    }).notNull(),
    actionExpiresAt: timestamp("action_expires_at", { withTimezone: true }),
    issuedAt: timestamp("issued_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    issuedByTeamMemberId: uuid("issued_by_team_member_id").references(
      () => teamMembers.id,
      { onDelete: "set null" },
    ),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByTeamMemberId: uuid("revoked_by_team_member_id").references(
      () => teamMembers.id,
      { onDelete: "set null" },
    ),
    revocationReason: text("revocation_reason"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededByCapabilityId: uuid("superseded_by_capability_id"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    useCount: integer("use_count").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    tokenHashKey: uniqueIndex("quote_capabilities_token_hash_key").on(
      table.tokenHash,
    ),
    activeRecipientKey: uniqueIndex("quote_capabilities_active_recipient_key")
      .on(table.quoteVersionId, table.recipientAddressHash)
      .where(sql`${table.status} = 'active'`),
    quoteStatusIdx: index("quote_capabilities_quote_status_idx").on(
      table.quoteId,
      table.status,
      table.createdAt,
    ),
    versionIdx: index("quote_capabilities_version_idx").on(
      table.quoteVersionId,
    ),
    readExpiresIdx: index("quote_capabilities_read_expires_idx").on(
      table.readExpiresAt,
    ),
    tokenHashCheck: check(
      "quote_capabilities_token_hash_check",
      sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
    recipientRoleCheck: check(
      "quote_capabilities_recipient_role_check",
      sql`${table.recipientRole} IN ('signer', 'cc', 'bcc')`,
    ),
    recipientHashCheck: check(
      "quote_capabilities_recipient_hash_check",
      sql`${table.recipientAddressHash} ~ '^[0-9a-f]{64}$'`,
    ),
    statusCheck: check(
      "quote_capabilities_status_check",
      sql`${table.status} IN ('active', 'revoked', 'superseded')`,
    ),
    actionsCheck: check(
      "quote_capabilities_actions_check",
      sql`cardinality(${table.allowedActions}) > 0 AND ${table.allowedActions} <@ ARRAY['view', 'pdf', 'change', 'refresh', 'accept', 'decline', 'availability', 'hold', 'checkout', 'book']::text[] AND (${table.recipientRole} = 'signer' OR NOT (${table.allowedActions} && ARRAY['change', 'refresh', 'accept', 'decline', 'availability', 'hold', 'checkout', 'book']::text[]))`,
    ),
    useCountCheck: check(
      "quote_capabilities_use_count_check",
      sql`${table.useCount} >= 0`,
    ),
    supersessionCheck: check(
      "quote_capabilities_supersession_check",
      sql`${table.supersededByCapabilityId} IS NULL OR ${table.supersededByCapabilityId} <> ${table.id}`,
    ),
    lifecycleCheck: check(
      "quote_capabilities_lifecycle_check",
      sql`(${table.status} <> 'revoked' OR (${table.revokedAt} IS NOT NULL AND nullif(btrim(${table.revocationReason}), '') IS NOT NULL)) AND (${table.status} <> 'superseded' OR (${table.supersededAt} IS NOT NULL AND ${table.supersededByCapabilityId} IS NOT NULL)) AND ${table.readExpiresAt} > ${table.issuedAt} AND (${table.actionExpiresAt} IS NULL OR (${table.actionExpiresAt} > ${table.issuedAt} AND ${table.actionExpiresAt} <= ${table.readExpiresAt}))`,
    ),
  }),
);

export const quoteSendAttempts = pgTable(
  "quote_send_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    quoteId: uuid("quote_id")
      .notNull()
      .references(() => quotes.id, { onDelete: "restrict" }),
    quoteVersionId: uuid("quote_version_id")
      .notNull()
      .references(() => quoteVersions.id, { onDelete: "restrict" }),
    capabilityId: uuid("capability_id").references(() => quoteCapabilities.id, {
      onDelete: "set null",
    }),
    attemptNumber: integer("attempt_number").notNull(),
    idempotencyKeyHash: varchar("idempotency_key_hash", {
      length: 64,
    }).notNull(),
    status: text("status").default("requested").notNull(),
    recipientManifest: jsonb("recipient_manifest")
      .$type<Array<Record<string, unknown>>>()
      .default([])
      .notNull(),
    messageSnapshot: jsonb("message_snapshot")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    requestedByTeamMemberId: uuid("requested_by_team_member_id").references(
      () => teamMembers.id,
      { onDelete: "set null" },
    ),
    correlationId: text("correlation_id"),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    lastErrorDetail: text("last_error_detail"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default({})
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
    versionAttemptKey: uniqueIndex(
      "quote_send_attempts_version_attempt_key",
    ).on(table.quoteVersionId, table.attemptNumber),
    versionIdempotencyKey: uniqueIndex(
      "quote_send_attempts_version_idempotency_key",
    ).on(table.quoteVersionId, table.idempotencyKeyHash),
    statusRequestedIdx: index("quote_send_attempts_status_requested_idx").on(
      table.status,
      table.requestedAt,
    ),
    attemptNumberCheck: check(
      "quote_send_attempts_attempt_number_check",
      sql`${table.attemptNumber} > 0`,
    ),
    keyHashCheck: check(
      "quote_send_attempts_key_hash_check",
      sql`${table.idempotencyKeyHash} ~ '^[0-9a-f]{64}$'`,
    ),
    statusCheck: check(
      "quote_send_attempts_status_check",
      sql`${table.status} IN ('requested', 'processing', 'partial', 'succeeded', 'failed', 'reconciliation_required', 'canceled')`,
    ),
    snapshotShapeCheck: check(
      "quote_send_attempts_snapshot_shape_check",
      sql`jsonb_typeof(${table.recipientManifest}) = 'array' AND jsonb_typeof(${table.messageSnapshot}) = 'object'`,
    ),
  }),
);

export const quoteSendDeliveries = pgTable(
  "quote_send_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sendAttemptId: uuid("send_attempt_id")
      .notNull()
      .references(() => quoteSendAttempts.id, { onDelete: "restrict" }),
    channel: text("channel").notNull(),
    recipientRole: text("recipient_role").notNull(),
    recipientAddressHash: varchar("recipient_address_hash", {
      length: 64,
    }).notNull(),
    recipientDisplayHint: text("recipient_display_hint"),
    encryptedProviderPayload: text("encrypted_provider_payload").notNull(),
    encryptionKeyId: text("encryption_key_id").notNull(),
    channelAttemptNumber: integer("channel_attempt_number")
      .default(1)
      .notNull(),
    status: text("status").default("queued").notNull(),
    provider: text("provider"),
    providerMessageId: text("provider_message_id"),
    providerRequestKey: text("provider_request_key"),
    externalMessageDispatchId: uuid("external_message_dispatch_id").references(
      () => externalMessageDispatches.id,
      { onDelete: "set null" },
    ),
    conversationThreadId: uuid("conversation_thread_id").references(
      () => conversationThreads.id,
      { onDelete: "set null" },
    ),
    conversationMessageId: uuid("conversation_message_id").references(
      () => conversationMessages.id,
      { onDelete: "set null" },
    ),
    errorCode: text("error_code"),
    errorDetail: text("error_detail"),
    queuedAt: timestamp("queued_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default({})
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
    attemptChannelAddressKey: uniqueIndex(
      "quote_send_deliveries_attempt_channel_address_key",
    ).on(
      table.sendAttemptId,
      table.channel,
      table.recipientAddressHash,
      table.channelAttemptNumber,
    ),
    providerMessageKey: uniqueIndex(
      "quote_send_deliveries_provider_message_key",
    )
      .on(table.provider, table.providerMessageId)
      .where(
        sql`${table.provider} IS NOT NULL AND ${table.providerMessageId} IS NOT NULL`,
      ),
    dispatchKey: uniqueIndex("quote_send_deliveries_dispatch_key")
      .on(table.externalMessageDispatchId)
      .where(sql`${table.externalMessageDispatchId} IS NOT NULL`),
    conversationIdx: index("quote_send_deliveries_conversation_idx").on(
      table.conversationThreadId,
      table.createdAt,
    ),
    statusQueuedIdx: index("quote_send_deliveries_status_queued_idx").on(
      table.status,
      table.queuedAt,
    ),
    channelCheck: check(
      "quote_send_deliveries_channel_check",
      sql`${table.channel} IN ('email', 'sms')`,
    ),
    recipientRoleCheck: check(
      "quote_send_deliveries_recipient_role_check",
      sql`${table.recipientRole} IN ('signer', 'cc', 'bcc')`,
    ),
    addressHashCheck: check(
      "quote_send_deliveries_address_hash_check",
      sql`${table.recipientAddressHash} ~ '^[0-9a-f]{64}$'`,
    ),
    channelAttemptCheck: check(
      "quote_send_deliveries_channel_attempt_check",
      sql`${table.channelAttemptNumber} > 0`,
    ),
    statusCheck: check(
      "quote_send_deliveries_status_check",
      sql`${table.status} IN ('queued', 'dispatched', 'delivered', 'failed', 'reconciliation_required', 'suppressed')`,
    ),
  }),
);

export const quoteResponses = pgTable(
  "quote_responses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    quoteId: uuid("quote_id")
      .notNull()
      .references(() => quotes.id, { onDelete: "restrict" }),
    quoteVersionId: uuid("quote_version_id")
      .notNull()
      .references(() => quoteVersions.id, { onDelete: "restrict" }),
    responseType: text("response_type").notNull(),
    source: text("source").notNull(),
    teamMemberId: uuid("team_member_id").references(() => teamMembers.id, {
      onDelete: "set null",
    }),
    partnerAccountId: uuid("partner_account_id").references(
      () => partnerAccounts.id,
      { onDelete: "restrict" },
    ),
    partnerMembershipId: uuid("partner_membership_id"),
    partnerUserId: uuid("partner_user_id").references(() => partnerUsers.id, {
      onDelete: "restrict",
    }),
    changeRequestId: uuid("change_request_id").references(
      () => quoteChangeRequests.id,
      { onDelete: "set null" },
    ),
    appointmentId: uuid("appointment_id").references(() => appointments.id, {
      onDelete: "set null",
    }),
    signerSnapshot: jsonb("signer_snapshot").$type<Record<
      string,
      unknown
    > | null>(),
    configurationSnapshot: jsonb("configuration_snapshot").$type<Record<
      string,
      unknown
    > | null>(),
    selectedOptionIds: text("selected_option_ids")
      .array()
      .default([])
      .notNull(),
    reason: text("reason"),
    message: text("message"),
    consentText: text("consent_text"),
    consentVersion: text("consent_version"),
    consentAffirmed: boolean("consent_affirmed"),
    configurationHash: varchar("configuration_hash", { length: 64 }),
    consentHash: varchar("consent_hash", { length: 64 }),
    contentHash: varchar("content_hash", { length: 64 }),
    issuedPdfHash: varchar("issued_pdf_hash", { length: 64 }),
    acceptedTotalMinCents: integer("accepted_total_min_cents"),
    acceptedTotalMaxCents: integer("accepted_total_max_cents"),
    acceptedDepositCents: integer("accepted_deposit_cents"),
    acceptedBalanceMinCents: integer("accepted_balance_min_cents"),
    acceptedBalanceMaxCents: integer("accepted_balance_max_cents"),
    idempotencyKeyHash: varchar("idempotency_key_hash", { length: 64 }),
    requestHash: varchar("request_hash", { length: 64 }),
    requestMetadata: jsonb("request_metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    respondedAt: timestamp("responded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    quotePartnerAccountFk: foreignKey({
      name: "quote_responses_quote_partner_account_fk",
      columns: [table.quoteId, table.partnerAccountId],
      foreignColumns: [quotes.id, quotes.partnerAccountId],
    }).onDelete("restrict"),
    partnerActorFk: foreignKey({
      name: "quote_responses_partner_actor_fk",
      columns: [
        table.partnerMembershipId,
        table.partnerAccountId,
        table.partnerUserId,
      ],
      foreignColumns: [
        partnerAccountMemberships.id,
        partnerAccountMemberships.partnerAccountId,
        partnerAccountMemberships.partnerUserId,
      ],
    }).onDelete("restrict"),
    terminalVersionKey: uniqueIndex("quote_responses_terminal_version_key")
      .on(table.quoteVersionId)
      .where(sql`${table.responseType} IN ('accepted', 'declined')`),
    idQuoteVersionKey: uniqueIndex("quote_responses_id_quote_version_key").on(
      table.id,
      table.quoteId,
      table.quoteVersionId,
    ),
    versionIdempotencyKey: uniqueIndex(
      "quote_responses_version_idempotency_key",
    )
      .on(table.quoteVersionId, table.idempotencyKeyHash)
      .where(sql`${table.idempotencyKeyHash} IS NOT NULL`),
    quoteHistoryIdx: index("quote_responses_quote_history_idx").on(
      table.quoteId,
      table.respondedAt,
    ),
    partnerActorIdx: index("quote_responses_partner_actor_idx")
      .on(table.partnerAccountId, table.partnerMembershipId, table.respondedAt)
      .where(sql`${table.source} = 'partner_member'`),
    appointmentKey: uniqueIndex("quote_responses_appointment_key")
      .on(table.appointmentId)
      .where(sql`${table.appointmentId} IS NOT NULL`),
    typeCheck: check(
      "quote_responses_type_check",
      sql`${table.responseType} IN ('accepted', 'declined', 'change_requested', 'refresh_requested')`,
    ),
    sourceCheck: check(
      "quote_responses_source_check",
      sql`${table.source} IN ('customer', 'team_member', 'partner_member', 'system')`,
    ),
    actorCheck: check(
      "quote_responses_actor_check",
      sql`(${table.source} = 'team_member' AND ${table.teamMemberId} IS NOT NULL AND num_nonnulls(${table.partnerAccountId}, ${table.partnerMembershipId}, ${table.partnerUserId}) = 0) OR (${table.source} = 'partner_member' AND ${table.teamMemberId} IS NULL AND ${table.partnerAccountId} IS NOT NULL AND ${table.partnerMembershipId} IS NOT NULL AND ${table.partnerUserId} IS NOT NULL AND ${table.idempotencyKeyHash} IS NOT NULL AND ${table.requestHash} IS NOT NULL) OR (${table.source} IN ('customer', 'system') AND ${table.teamMemberId} IS NULL AND num_nonnulls(${table.partnerAccountId}, ${table.partnerMembershipId}, ${table.partnerUserId}) = 0)`,
    ),
    changeRequestCheck: check(
      "quote_responses_change_request_check",
      sql`${table.responseType} NOT IN ('change_requested', 'refresh_requested') OR ${table.changeRequestId} IS NOT NULL`,
    ),
    hashesCheck: check(
      "quote_responses_hashes_check",
      sql`(${table.configurationHash} IS NULL OR ${table.configurationHash} ~ '^[0-9a-f]{64}$') AND (${table.consentHash} IS NULL OR ${table.consentHash} ~ '^[0-9a-f]{64}$') AND (${table.contentHash} IS NULL OR ${table.contentHash} ~ '^[0-9a-f]{64}$') AND (${table.issuedPdfHash} IS NULL OR ${table.issuedPdfHash} ~ '^[0-9a-f]{64}$')`,
    ),
    acceptanceEvidenceCheck: check(
      "quote_responses_acceptance_evidence_check",
      sql`${table.responseType} <> 'accepted' OR (${table.signerSnapshot} IS NOT NULL AND ${table.configurationSnapshot} IS NOT NULL AND ${table.consentText} IS NOT NULL AND ${table.consentVersion} IS NOT NULL AND ${table.consentAffirmed} IS TRUE AND ${table.configurationHash} IS NOT NULL AND ${table.consentHash} IS NOT NULL AND ${table.contentHash} IS NOT NULL AND ${table.issuedPdfHash} IS NOT NULL AND ${table.acceptedTotalMinCents} IS NOT NULL AND ${table.acceptedTotalMaxCents} IS NOT NULL AND ${table.acceptedDepositCents} IS NOT NULL AND ${table.acceptedBalanceMinCents} IS NOT NULL AND ${table.acceptedBalanceMaxCents} IS NOT NULL AND ${table.acceptedTotalMinCents} > 0 AND ${table.acceptedTotalMaxCents} >= ${table.acceptedTotalMinCents} AND ${table.acceptedDepositCents} BETWEEN 0 AND ${table.acceptedTotalMinCents} AND ${table.acceptedBalanceMinCents} = ${table.acceptedTotalMinCents} - ${table.acceptedDepositCents} AND ${table.acceptedBalanceMaxCents} = ${table.acceptedTotalMaxCents} - ${table.acceptedDepositCents})`,
    ),
    declineEvidenceCheck: check(
      "quote_responses_decline_evidence_check",
      sql`${table.responseType} <> 'declined' OR ${table.signerSnapshot} IS NOT NULL`,
    ),
    snapshotShapeCheck: check(
      "quote_responses_snapshot_shape_check",
      sql`(${table.signerSnapshot} IS NULL OR jsonb_typeof(${table.signerSnapshot}) = 'object') AND (${table.configurationSnapshot} IS NULL OR jsonb_typeof(${table.configurationSnapshot}) = 'object')`,
    ),
    idempotencyHashCheck: check(
      "quote_responses_idempotency_hash_check",
      sql`${table.idempotencyKeyHash} IS NULL OR ${table.idempotencyKeyHash} ~ '^[0-9a-f]{64}$'`,
    ),
    requestHashCheck: check(
      "quote_responses_request_hash_check",
      sql`${table.requestHash} IS NULL OR ${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);

export type PartnerJobChangeOrderOfferSnapshot = Readonly<{
  version: 1;
  offeredAt: string;
  partnerQuoteId: string;
  quoteId: string;
  quoteVersionId: string;
  quoteVersionNumber: number;
  quoteContentHash: string;
  amountMinor: number;
  currency: string;
  bookingRevision: number;
}>;

export type PartnerJobChangeOrderResolutionSnapshot = Readonly<{
  version: 1;
  outcome: "accepted" | "declined" | "superseded";
  quoteResponseId: string | null;
  bookingRevisionBefore: number;
  bookingRevisionAfter: number;
  appliedPublicFields: readonly string[];
  operationalEffectsPending: readonly ("schedule" | "service" | "proof")[];
}>;

/**
 * Bridges a material Partner job-change request to one exact account/job-bound
 * Quote V2. The immutable offer snapshot is the commercial evidence applied
 * when the Partner accepts that quote.
 */
export const partnerJobChangeOrders = pgTable(
  "partner_job_change_orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    partnerAccountId: uuid("partner_account_id")
      .notNull()
      .references(() => partnerAccounts.id, { onDelete: "restrict" }),
    partnerBookingId: uuid("partner_booking_id").notNull(),
    partnerJobChangeRequestId: uuid("partner_job_change_request_id").notNull(),
    partnerQuoteId: uuid("partner_quote_id").notNull(),
    quoteId: uuid("quote_id").notNull(),
    quoteVersionId: uuid("quote_version_id").notNull(),
    state: text("state")
      .$type<"offered" | "accepted" | "declined" | "superseded">()
      .default("offered")
      .notNull(),
    offerSnapshot: jsonb("offer_snapshot")
      .$type<PartnerJobChangeOrderOfferSnapshot>()
      .notNull(),
    baseBookingRevision: integer("base_booking_revision").notNull(),
    revision: integer("revision").default(1).notNull(),
    offeredByTeamMemberId: uuid("offered_by_team_member_id")
      .notNull()
      .references(() => teamMembers.id, { onDelete: "restrict" }),
    quoteResponseId: uuid("quote_response_id"),
    resolutionSnapshot: jsonb(
      "resolution_snapshot",
    ).$type<PartnerJobChangeOrderResolutionSnapshot | null>(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    requestAccountJobFk: foreignKey({
      name: "partner_job_change_orders_request_account_job_fk",
      columns: [
        table.partnerAccountId,
        table.partnerBookingId,
        table.partnerJobChangeRequestId,
      ],
      foreignColumns: [
        partnerJobChangeRequests.partnerAccountId,
        partnerJobChangeRequests.partnerBookingId,
        partnerJobChangeRequests.id,
      ],
    }).onDelete("restrict"),
    quoteAccountJobFk: foreignKey({
      name: "partner_job_change_orders_quote_account_job_fk",
      columns: [
        table.partnerAccountId,
        table.partnerBookingId,
        table.partnerQuoteId,
      ],
      foreignColumns: [
        partnerQuotes.partnerAccountId,
        partnerQuotes.partnerBookingId,
        partnerQuotes.id,
      ],
    }).onDelete("restrict"),
    versionQuoteFk: foreignKey({
      name: "partner_job_change_orders_version_quote_fk",
      columns: [table.quoteVersionId, table.quoteId],
      foreignColumns: [quoteVersions.id, quoteVersions.quoteId],
    }).onDelete("restrict"),
    responseQuoteVersionFk: foreignKey({
      name: "partner_job_change_orders_response_quote_version_fk",
      columns: [table.quoteResponseId, table.quoteId, table.quoteVersionId],
      foreignColumns: [
        quoteResponses.id,
        quoteResponses.quoteId,
        quoteResponses.quoteVersionId,
      ],
    }).onDelete("restrict"),
    requestKey: uniqueIndex("partner_job_change_orders_request_key").on(
      table.partnerJobChangeRequestId,
    ),
    quoteKey: uniqueIndex("partner_job_change_orders_quote_key").on(
      table.partnerQuoteId,
    ),
    activeBookingKey: uniqueIndex(
      "partner_job_change_orders_active_booking_key",
    )
      .on(table.partnerAccountId, table.partnerBookingId)
      .where(sql`${table.state} = 'offered'`),
    accountStateIdx: index("partner_job_change_orders_account_state_idx").on(
      table.partnerAccountId,
      table.state,
      table.createdAt,
      table.id,
    ),
    stateCheck: check(
      "partner_job_change_orders_state_check",
      sql`${table.state} IN ('offered', 'accepted', 'declined', 'superseded')`,
    ),
    offerCheck: check(
      "partner_job_change_orders_offer_check",
      sql`jsonb_typeof(${table.offerSnapshot}) = 'object' AND ${table.offerSnapshot} ->> 'version' = '1' AND (${table.offerSnapshot} ->> 'amountMinor')::numeric > 0 AND ${table.offerSnapshot} ->> 'currency' ~ '^[A-Z]{3}$'`,
    ),
    revisionCheck: check(
      "partner_job_change_orders_revision_check",
      sql`${table.revision} > 0 AND ${table.baseBookingRevision} > 0`,
    ),
    resolutionCheck: check(
      "partner_job_change_orders_resolution_check",
      sql`(${table.state} = 'offered' AND ${table.quoteResponseId} IS NULL AND ${table.resolutionSnapshot} IS NULL AND ${table.resolvedAt} IS NULL) OR (${table.state} IN ('accepted', 'declined', 'superseded') AND jsonb_typeof(${table.resolutionSnapshot}) = 'object' AND ${table.resolutionSnapshot} ->> 'version' = '1' AND ${table.resolutionSnapshot} ->> 'outcome' = ${table.state} AND ${table.resolvedAt} IS NOT NULL AND ((${table.state} IN ('accepted', 'declined') AND ${table.quoteResponseId} IS NOT NULL) OR (${table.state} = 'superseded' AND ${table.quoteResponseId} IS NULL)))`,
    ),
  }),
);

export const quoteActivityEvents = pgTable(
  "quote_activity_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    quoteId: uuid("quote_id")
      .notNull()
      .references(() => quotes.id, { onDelete: "restrict" }),
    quoteVersionId: uuid("quote_version_id").references(
      () => quoteVersions.id,
      { onDelete: "restrict" },
    ),
    eventType: text("event_type").notNull(),
    actorType: text("actor_type").notNull(),
    actorTeamMemberId: uuid("actor_team_member_id").references(
      () => teamMembers.id,
      { onDelete: "set null" },
    ),
    outboxEventId: uuid("outbox_event_id").references(() => outboxEvents.id, {
      onDelete: "set null",
    }),
    correlationId: text("correlation_id"),
    causationId: text("causation_id"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    quoteHistoryIdx: index("quote_activity_events_quote_history_idx").on(
      table.quoteId,
      table.occurredAt,
      table.id,
    ),
    versionHistoryIdx: index("quote_activity_events_version_history_idx").on(
      table.quoteVersionId,
      table.occurredAt,
    ),
    eventTypeIdx: index("quote_activity_events_type_idx").on(
      table.eventType,
      table.occurredAt,
    ),
    actorTypeCheck: check(
      "quote_activity_events_actor_type_check",
      sql`${table.actorType} IN ('customer', 'team_member', 'system', 'worker')`,
    ),
    actorCheck: check(
      "quote_activity_events_actor_check",
      sql`${table.actorType} <> 'team_member' OR ${table.actorTeamMemberId} IS NOT NULL`,
    ),
  }),
);

/**
 * Browser-confirmed proposal visibility is short-lived operational detail,
 * not immutable proposal/acceptance evidence. The retention job rolls these
 * rows into identifier-free daily buckets before deleting them after 90 days.
 */
export const quoteVisibleEngagementEvents = pgTable(
  "quote_visible_engagement_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    quoteId: uuid("quote_id")
      .notNull()
      .references(() => quotes.id, { onDelete: "restrict" }),
    quoteVersionId: uuid("quote_version_id")
      .notNull()
      .references(() => quoteVersions.id, { onDelete: "restrict" }),
    capabilityId: uuid("capability_id").references(() => quoteCapabilities.id, {
      onDelete: "set null",
    }),
    idempotencyKeyHash: varchar("idempotency_key_hash", {
      length: 64,
    }).notNull(),
    visibleMsBucket: text("visible_ms_bucket").notNull(),
    correlationId: text("correlation_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    versionIdempotencyKey: uniqueIndex(
      "quote_visible_engagement_version_idempotency_key",
    ).on(table.quoteVersionId, table.idempotencyKeyHash),
    occurredIdx: index("quote_visible_engagement_occurred_idx").on(
      table.occurredAt,
      table.id,
    ),
    quoteHistoryIdx: index("quote_visible_engagement_quote_history_idx").on(
      table.quoteId,
      table.occurredAt,
      table.id,
    ),
    idempotencyHashCheck: check(
      "quote_visible_engagement_idempotency_hash_check",
      sql`${table.idempotencyKeyHash} ~ '^[0-9a-f]{64}$'`,
    ),
    bucketCheck: check(
      "quote_visible_engagement_bucket_check",
      sql`${table.visibleMsBucket} IN ('1-5s', '5-30s', '30s+')`,
    ),
    timeCheck: check(
      "quote_visible_engagement_time_check",
      sql`${table.createdAt} >= ${table.occurredAt}`,
    ),
  }),
);

/** Identifier-free aggregate retained after detailed engagement is purged. */
export const quoteVisibleEngagementDaily = pgTable(
  "quote_visible_engagement_daily",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    engagementDate: date("engagement_date", { mode: "string" }).notNull(),
    visibleMsBucket: text("visible_ms_bucket").notNull(),
    eventCount: bigint("event_count", { mode: "number" }).notNull(),
    firstOccurredAt: timestamp("first_occurred_at", {
      withTimezone: true,
    }).notNull(),
    lastOccurredAt: timestamp("last_occurred_at", {
      withTimezone: true,
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    dateBucketKey: uniqueIndex(
      "quote_visible_engagement_daily_date_bucket_key",
    ).on(table.engagementDate, table.visibleMsBucket),
    dateIdx: index("quote_visible_engagement_daily_date_idx").on(
      table.engagementDate,
    ),
    bucketCheck: check(
      "quote_visible_engagement_daily_bucket_check",
      sql`${table.visibleMsBucket} IN ('1-5s', '5-30s', '30s+')`,
    ),
    countCheck: check(
      "quote_visible_engagement_daily_count_check",
      sql`${table.eventCount} > 0`,
    ),
    timeCheck: check(
      "quote_visible_engagement_daily_time_check",
      sql`${table.lastOccurredAt} >= ${table.firstOccurredAt}`,
    ),
  }),
);

// Fixed-window counters store only a one-way scope key. Callers can key by a
// capability, normalized address, or network fingerprint without raw secrets.
export const quotePublicRateLimits = pgTable(
  "quote_public_rate_limits",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scope: text("scope").notNull(),
    scopeKeyHash: varchar("scope_key_hash", { length: 64 }).notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowSeconds: integer("window_seconds").notNull(),
    requestCount: integer("request_count").default(0).notNull(),
    blockedUntil: timestamp("blocked_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    scopeKeyWindowKey: uniqueIndex(
      "quote_public_rate_limits_scope_key_window_key",
    ).on(
      table.scope,
      table.scopeKeyHash,
      table.windowStart,
      table.windowSeconds,
    ),
    blockedIdx: index("quote_public_rate_limits_blocked_idx").on(
      table.blockedUntil,
    ),
    hashCheck: check(
      "quote_public_rate_limits_hash_check",
      sql`${table.scopeKeyHash} ~ '^[0-9a-f]{64}$'`,
    ),
    windowCheck: check(
      "quote_public_rate_limits_window_check",
      sql`${table.windowSeconds} > 0 AND ${table.requestCount} >= 0`,
    ),
  }),
);

export const quoteMigrationCheckpoints = pgTable(
  "quote_migration_checkpoints",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobKey: varchar("job_key", { length: 120 }).notNull(),
    checkpointKey: varchar("checkpoint_key", { length: 120 }).notNull(),
    cursor: jsonb("cursor").$type<Record<string, unknown> | null>(),
    status: text("status").default("pending").notNull(),
    scannedCount: integer("scanned_count").default(0).notNull(),
    migratedCount: integer("migrated_count").default(0).notNull(),
    reviewCount: integer("review_count").default(0).notNull(),
    skippedCount: integer("skipped_count").default(0).notNull(),
    lastErrorCode: text("last_error_code"),
    lastErrorDetail: text("last_error_detail"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    jobCheckpointKey: uniqueIndex(
      "quote_migration_checkpoints_job_checkpoint_key",
    ).on(table.jobKey, table.checkpointKey),
    statusHeartbeatIdx: index(
      "quote_migration_checkpoints_status_heartbeat_idx",
    ).on(table.status, table.lastHeartbeatAt),
    statusCheck: check(
      "quote_migration_checkpoints_status_check",
      sql`${table.status} IN ('pending', 'running', 'paused', 'completed', 'failed')`,
    ),
    countsCheck: check(
      "quote_migration_checkpoints_counts_check",
      sql`${table.scannedCount} >= 0 AND ${table.migratedCount} >= 0 AND ${table.reviewCount} >= 0 AND ${table.skippedCount} >= 0 AND ${table.migratedCount} + ${table.reviewCount} + ${table.skippedCount} <= ${table.scannedCount}`,
    ),
    lifecycleCheck: check(
      "quote_migration_checkpoints_lifecycle_check",
      sql`${table.status} <> 'completed' OR ${table.completedAt} IS NOT NULL`,
    ),
  }),
);

export const quoteMigrationReviewItems = pgTable(
  "quote_migration_review_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    legacyEntityType: varchar("legacy_entity_type", { length: 80 }).notNull(),
    legacyEntityId: varchar("legacy_entity_id", { length: 200 }).notNull(),
    reasonCode: varchar("reason_code", { length: 120 }).notNull(),
    details: jsonb("details")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    status: text("status").default("open").notNull(),
    resolution: text("resolution"),
    resolvedByTeamMemberId: uuid("resolved_by_team_member_id").references(
      () => teamMembers.id,
      { onDelete: "set null" },
    ),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    entityReasonKey: uniqueIndex(
      "quote_migration_review_items_entity_reason_key",
    ).on(table.legacyEntityType, table.legacyEntityId, table.reasonCode),
    statusCreatedIdx: index(
      "quote_migration_review_items_status_created_idx",
    ).on(table.status, table.createdAt),
    statusCheck: check(
      "quote_migration_review_items_status_check",
      sql`${table.status} IN ('open', 'resolved', 'dismissed')`,
    ),
    resolutionCheck: check(
      "quote_migration_review_items_resolution_check",
      sql`${table.status} = 'open' OR (${table.resolvedAt} IS NOT NULL AND nullif(btrim(${table.resolution}), '') IS NOT NULL)`,
    ),
  }),
);
