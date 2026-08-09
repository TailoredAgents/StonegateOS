import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import {
  appointmentHolds,
  appointments,
  callRecords,
  type DatabaseClient,
  contactProperties,
  contactMergeRecoveryEntries,
  contactMergeRecoveryLedgers,
  contacts,
  conversationParticipants,
  conversationThreads,
  crmPipeline,
  crmTasks,
  etaMessageDrafts,
  facebookSalesAutopilotActions,
  facebookSalesAutopilotSessions,
  getDb,
  instantQuotes,
  leads,
  mediaAssets,
  mediaJobAnalyses,
  mergeSuggestions,
  properties,
  quotes,
  salesAgentMemories,
  salesAgentNextActions,
  teamInboxNewLeadAcknowledgements,
} from "@/db";
import { contactPurgeEligibleAt } from "@/lib/contact-retention";
import {
  assessContactMergeRecovery,
  buildContactConsolidationPlan,
  buildMergePreviewHash,
  compareContactMergeRecoveryBaseline,
  contactMergeInventoryEvidenceFailures,
  contactMergeOperationSafetyFailures,
  contactMergeExpectedEvidenceIdentity,
  CONTACT_MERGE_RULE_VERSION,
  isExactContactMergeHash,
  isExactContactMergeInstant,
  isExactContactMergeUuid,
  mergeDependencyRule,
  type ContactMergeConsolidationPlan,
  type ContactMergeEvidenceRow,
  type ContactMergeOperationSafetyState,
  type MergeContactFieldSnapshot,
} from "@/lib/contact-merge-contract";

type MergeTransaction = Parameters<DatabaseClient["transaction"]>[0] extends (
  tx: infer Transaction,
) => Promise<unknown>
  ? Transaction
  : never;

type ContactRow = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  phoneE164: string | null;
  createdAt: Date;
};

type ContactLeadRow = {
  propertyId: string;
  contactId: string;
  leadId: string;
  leadCreatedAt: Date;
  leadUpdatedAt: Date;
  contactFirstName: string;
  contactLastName: string;
  contactEmail: string | null;
  contactPhone: string | null;
  contactPhoneE164: string | null;
  contactCreatedAt: Date;
  addressLine1: string;
  city: string;
  state: string;
  postalCode: string;
};

type ContactStats = {
  contact: ContactRow;
  leadCount: number;
  lastLeadAt: Date;
};

type SimilarityBreakdown = {
  sameLastName: boolean;
  sameFirstName: boolean;
  sameFirstInitial: boolean;
  sameEmail: boolean;
  samePhoneLast4: boolean;
};

export type MergeContactsResult = {
  sourceContactId: string;
  targetContactId: string;
  targetVersion: string;
  previewHash: string;
  recoveryLedgerId: string;
  recoveryAssessmentPath: string;
  suggestionVersion?: string;
  updatedFields: string[];
  moved: {
    properties: number;
    propertyAssociations: number;
    leads: number;
    quotes: number;
    appointments: number;
    threads: number;
    participants: number;
    tasks: number;
    pipeline: number;
    acknowledgements: number;
    agentMemories: number;
    agentNextActions: number;
    mediaAnalyses: number;
    automationSessions: number;
    automationActions: number;
    callRecords: number;
    mediaAssets: number;
    appointmentHolds: number;
    etaDrafts: number;
    instantQuotes: number;
    supersededSuggestions: number;
  };
};

export type MergePreviewCountKey =
  | "properties"
  | "leads"
  | "threads"
  | "messages"
  | "participants"
  | "tasks"
  | "appointments"
  | "quotes"
  | "payments"
  | "pipeline"
  | "partnerUsers"
  | "partnerRateCards"
  | "partnerBookings"
  | "agentMemories"
  | "agentNextActions"
  | "mediaAnalyses"
  | "automationSessions"
  | "automationActions"
  | "callRecords"
  | "mediaAssets"
  | "appointmentHolds"
  | "etaDrafts"
  | "instantQuotes"
  | "inboxAcknowledgements"
  | "externalDispatches"
  | "manualCallEvidence"
  | "salesCallEvidence"
  | "staffNotificationEvidence"
  | "pendingOutboxOperations"
  | "mergeSuggestions";

export type MergePreviewContact = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  partnerAccountId: string | null;
  partnerStatus: string;
  updatedAt: string;
  counts: Record<MergePreviewCountKey, number>;
};

export type MergePreview = {
  source: MergePreviewContact;
  target: MergePreviewContact;
  confirmationText: string;
  previewHash: string;
  ruleVersion: typeof CONTACT_MERGE_RULE_VERSION;
  consolidationPlan: ContactMergeConsolidationPlan;
  unresolvedDependencies: string[];
};

type MergeRecoveryContext = {
  actorMemberId: string;
  actorRole: string | null;
  actorLabel: string | null;
  sessionId: string;
  authMethod: "team_session" | "break_glass";
  operationId: string;
  correlationId: string;
  idempotencyKeyHash: string;
  suggestionId?: string;
  expectedSuggestionUpdatedAt?: string;
};

type DependencyInventoryRow = {
  contactId: string;
  inventoryKind: "foreign_key" | "logical";
  schemaName: string;
  tableName: string;
  columnName: string;
  referenceCount: number;
  supported: boolean;
};

type MergeDependencyRow = {
  dependencyKey: string;
  entityId: string;
  ownerContactId: string;
  snapshot: Record<string, unknown>;
};

const CONTACT_EVIDENCE_DEPENDENCY_KEY = "contacts.id";

function evidenceIdentityKey(dependencyKey: string, entityId: string): string {
  return `${dependencyKey}\u0000${entityId}`;
}

function beforeEvidence(
  dependencyKey: string,
  snapshot: Record<string, unknown>,
): Record<string, unknown> {
  return { evidenceVersion: 1, dependencyKey, snapshot };
}

function deduplicatedBeforeEvidence(
  dependencyKey: string,
  sourceSnapshot: Record<string, unknown>,
  retainedSnapshot: Record<string, unknown>,
): Record<string, unknown> {
  return {
    evidenceVersion: 1,
    dependencyKey,
    sourceSnapshot,
    retainedSnapshot,
  };
}

function absentBeforeEvidence(
  dependencyKey: string,
  discriminator: Record<string, unknown>,
): Record<string, unknown> {
  return {
    evidenceVersion: 1,
    dependencyKey,
    snapshot: null,
    discriminator,
  };
}

function presentAfterEvidence(
  row: MergeDependencyRow,
): Record<string, unknown> {
  return {
    evidenceVersion: 1,
    expectation: "present_exact",
    dependencyKey: row.dependencyKey,
    entityId: row.entityId,
    ownerContactId: row.ownerContactId,
    snapshot: row.snapshot,
  };
}

function deduplicatedAfterEvidence(
  source: MergeDependencyRow,
  retained: MergeDependencyRow,
): Record<string, unknown> {
  return {
    evidenceVersion: 1,
    expectation: "source_absent_retained_exact",
    dependencyKey: source.dependencyKey,
    sourceEntityId: source.entityId,
    retainedEntityId: retained.entityId,
    retainedOwnerContactId: retained.ownerContactId,
    retainedSnapshot: retained.snapshot,
  };
}

function replacedAfterEvidence(
  source: MergeDependencyRow,
  destination: MergeDependencyRow,
): Record<string, unknown> {
  return {
    evidenceVersion: 1,
    expectation: "source_absent_destination_exact",
    dependencyKey: source.dependencyKey,
    sourceEntityId: source.entityId,
    destinationEntityId: destination.entityId,
    destinationOwnerContactId: destination.ownerContactId,
    destinationSnapshot: destination.snapshot,
  };
}

type MergeDependencyState = {
  rows: MergeDependencyRow[];
  inventory: DependencyInventoryRow[];
  operationSafety: ContactMergeOperationSafetyState[];
};

export class MergeQueueError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = "MergeQueueError";
    this.code = code;
    this.status = status;
  }
}

export type ScanMergeSuggestionsResult = {
  scanned: number;
  created: number;
  skipped: number;
};

type ScanMergeSuggestionsOptions = {
  sinceDays?: number;
  limit?: number;
  minConfidence?: number;
};

const DEFAULT_SCAN_DAYS = 365;
const DEFAULT_SCAN_LIMIT = 200;
const DEFAULT_MIN_CONFIDENCE = 60;

function normalizeValue(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function lastFourDigits(phone: string | null | undefined): string {
  if (!phone) return "";
  const digits = phone.replace(/\D/g, "");
  return digits.slice(-4);
}

function scoreSimilarity(
  primary: ContactRow,
  secondary: ContactRow,
): { score: number; breakdown: SimilarityBreakdown } {
  const breakdown: SimilarityBreakdown = {
    sameLastName: false,
    sameFirstName: false,
    sameFirstInitial: false,
    sameEmail: false,
    samePhoneLast4: false,
  };

  const primaryLast = normalizeValue(primary.lastName);
  const secondaryLast = normalizeValue(secondary.lastName);
  const primaryFirst = normalizeValue(primary.firstName);
  const secondaryFirst = normalizeValue(secondary.firstName);

  let score = 30;

  if (primaryLast && primaryLast === secondaryLast) {
    breakdown.sameLastName = true;
    score += 40;
  }

  if (primaryFirst && primaryFirst === secondaryFirst) {
    breakdown.sameFirstName = true;
    score += 20;
  } else if (
    primaryFirst &&
    secondaryFirst &&
    primaryFirst[0] === secondaryFirst[0]
  ) {
    breakdown.sameFirstInitial = true;
    score += 10;
  }

  const primaryEmail = normalizeValue(primary.email ?? "");
  const secondaryEmail = normalizeValue(secondary.email ?? "");
  if (primaryEmail && primaryEmail === secondaryEmail) {
    breakdown.sameEmail = true;
    score += 15;
  }

  const primaryLast4 = lastFourDigits(primary.phoneE164 ?? primary.phone);
  const secondaryLast4 = lastFourDigits(secondary.phoneE164 ?? secondary.phone);
  if (primaryLast4 && primaryLast4 === secondaryLast4) {
    breakdown.samePhoneLast4 = true;
    score += 10;
  }

  return { score: Math.min(score, 100), breakdown };
}

function contactStrength(stats: ContactStats): number {
  let score = stats.leadCount * 2;
  if (stats.contact.email) score += 3;
  if (stats.contact.phoneE164) score += 3;
  if (stats.contact.phone) score += 1;
  const daysAgo = Math.max(
    0,
    Math.floor(
      (Date.now() - stats.lastLeadAt.getTime()) / (1000 * 60 * 60 * 24),
    ),
  );
  const recencyBoost = Math.max(0, 5 - Math.floor(daysAgo / 30));
  score += recencyBoost;
  return score;
}

export async function scanMergeSuggestionsUsing(
  db: DatabaseClient | MergeTransaction,
  options: ScanMergeSuggestionsOptions = {},
): Promise<ScanMergeSuggestionsResult> {
  const sinceDays = Math.max(
    1,
    Math.min(options.sinceDays ?? DEFAULT_SCAN_DAYS, 3650),
  );
  const limit = Math.max(
    1,
    Math.min(options.limit ?? DEFAULT_SCAN_LIMIT, 1000),
  );
  const minConfidence = Math.max(
    1,
    Math.min(options.minConfidence ?? DEFAULT_MIN_CONFIDENCE, 100),
  );

  const sinceDate = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      propertyId: leads.propertyId,
      contactId: leads.contactId,
      leadId: leads.id,
      leadCreatedAt: leads.createdAt,
      leadUpdatedAt: leads.updatedAt,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      contactEmail: contacts.email,
      contactPhone: contacts.phone,
      contactPhoneE164: contacts.phoneE164,
      contactCreatedAt: contacts.createdAt,
      addressLine1: properties.addressLine1,
      city: properties.city,
      state: properties.state,
      postalCode: properties.postalCode,
    })
    .from(leads)
    .leftJoin(contacts, eq(leads.contactId, contacts.id))
    .leftJoin(properties, eq(leads.propertyId, properties.id))
    .where(and(gte(leads.createdAt, sinceDate), isNull(contacts.deletedAt)))
    .orderBy(desc(leads.updatedAt));

  const grouped = new Map<string, ContactLeadRow[]>();
  for (const row of rows as ContactLeadRow[]) {
    const list = grouped.get(row.propertyId) ?? [];
    list.push(row);
    grouped.set(row.propertyId, list);
  }

  const suggestions: Array<{
    sourceContactId: string;
    targetContactId: string;
    reason: string;
    confidence: number;
    meta: Record<string, unknown>;
  }> = [];

  for (const [propertyId, groupRows] of grouped.entries()) {
    const contactMap = new Map<string, ContactStats>();
    for (const row of groupRows) {
      const existing = contactMap.get(row.contactId);
      const lastLeadAt =
        row.leadUpdatedAt && row.leadUpdatedAt > row.leadCreatedAt
          ? row.leadUpdatedAt
          : row.leadCreatedAt;
      if (existing) {
        existing.leadCount += 1;
        if (lastLeadAt > existing.lastLeadAt) {
          existing.lastLeadAt = lastLeadAt;
        }
      } else {
        contactMap.set(row.contactId, {
          contact: {
            id: row.contactId,
            firstName: row.contactFirstName,
            lastName: row.contactLastName,
            email: row.contactEmail ?? null,
            phone: row.contactPhone ?? null,
            phoneE164: row.contactPhoneE164 ?? null,
            createdAt: row.contactCreatedAt,
          },
          leadCount: 1,
          lastLeadAt,
        });
      }
    }

    if (contactMap.size <= 1) {
      continue;
    }

    const contactStats = Array.from(contactMap.values());
    contactStats.sort((a, b) => {
      const scoreDiff = contactStrength(b) - contactStrength(a);
      if (scoreDiff !== 0) return scoreDiff;
      return a.contact.createdAt.getTime() - b.contact.createdAt.getTime();
    });

    const primary = contactStats[0];
    if (!primary) {
      continue;
    }

    for (const secondary of contactStats.slice(1)) {
      const { score, breakdown } = scoreSimilarity(
        primary.contact,
        secondary.contact,
      );
      if (score < minConfidence) {
        continue;
      }

      suggestions.push({
        sourceContactId: secondary.contact.id,
        targetContactId: primary.contact.id,
        reason: "property_name_match",
        confidence: score,
        meta: {
          propertyId,
          addressLine1: groupRows[0]?.addressLine1 ?? "",
          city: groupRows[0]?.city ?? "",
          state: groupRows[0]?.state ?? "",
          postalCode: groupRows[0]?.postalCode ?? "",
          primaryLeadCount: primary.leadCount,
          secondaryLeadCount: secondary.leadCount,
          similarity: breakdown,
        },
      });
    }
  }

  const limitedSuggestions = suggestions.slice(0, limit);
  let created = 0;

  for (const suggestion of limitedSuggestions) {
    const inserted = await db
      .insert(mergeSuggestions)
      .values({
        sourceContactId: suggestion.sourceContactId,
        targetContactId: suggestion.targetContactId,
        status: "pending",
        reason: suggestion.reason,
        confidence: suggestion.confidence,
        meta: suggestion.meta,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: mergeSuggestions.id });

    if (inserted.length > 0) {
      created += 1;
    }
  }

  return {
    scanned: suggestions.length,
    created,
    skipped: limitedSuggestions.length - created,
  };
}

export async function scanMergeSuggestions(
  options: ScanMergeSuggestionsOptions = {},
): Promise<ScanMergeSuggestionsResult> {
  return scanMergeSuggestionsUsing(getDb(), options);
}

export function buildMergeConfirmation(
  sourceContactId: string,
  targetContactId: string,
): string {
  return `MERGE ${sourceContactId} INTO ${targetContactId}`;
}

function resultRows(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter(
      (row): row is Record<string, unknown> =>
        Boolean(row) && typeof row === "object" && !Array.isArray(row),
    );
  }
  if (value && typeof value === "object") {
    const rows = (value as Record<string, unknown>)["rows"];
    if (Array.isArray(rows)) return resultRows(rows);
  }
  return [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function countValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function exactRowSnapshot(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length === 0
  ) {
    throw new MergeQueueError("merge_dependency_evidence_incomplete", 409);
  }
  return value as Record<string, unknown>;
}

async function readContactEvidenceRowsUsing(
  db: DatabaseClient | MergeTransaction,
  contactIds: readonly [string, string],
): Promise<MergeDependencyRow[]> {
  const result: unknown = await db.execute(sql`
    SELECT
      ${CONTACT_EVIDENCE_DEPENDENCY_KEY}::text AS "dependencyKey",
      c."id"::text AS "entityId",
      c."id"::text AS "ownerContactId",
      to_jsonb(c) AS "snapshot"
    FROM "contacts" c
    WHERE c."id" IN (${contactIds[0]}::uuid, ${contactIds[1]}::uuid)
    ORDER BY c."id"
  `);
  return resultRows(result).map((row) => ({
    dependencyKey: stringValue(row["dependencyKey"]),
    entityId: stringValue(row["entityId"]),
    ownerContactId: stringValue(row["ownerContactId"]),
    snapshot: exactRowSnapshot(row["snapshot"]),
  }));
}

async function readMergeDependencyStateUsing(
  db: DatabaseClient | MergeTransaction,
  sourceContactId: string,
  targetContactId: string,
): Promise<MergeDependencyState> {
  const dependencyResult: unknown = await db.execute(sql`
    SELECT
      dependency."dependencyKey",
      dependency."entityId",
      dependency."ownerContactId",
      dependency."snapshot"
    FROM (
      SELECT 'properties.contact_id'::text AS "dependencyKey", p."id"::text AS "entityId", p."contact_id"::text AS "ownerContactId", to_jsonb(p) AS "snapshot"
      FROM "properties" p WHERE p."contact_id" IN (${sourceContactId}::uuid, ${targetContactId}::uuid)
      UNION ALL
      SELECT 'contact_properties.contact_id', p."id"::text, p."contact_id"::text, to_jsonb(p)
      FROM "contact_properties" p WHERE p."contact_id" IN (${sourceContactId}::uuid, ${targetContactId}::uuid)
      UNION ALL
      SELECT 'crm_pipeline.contact_id', p."contact_id"::text, p."contact_id"::text, to_jsonb(p)
      FROM "crm_pipeline" p WHERE p."contact_id" IN (${sourceContactId}::uuid, ${targetContactId}::uuid)
      UNION ALL
      SELECT 'crm_tasks.contact_id', t."id"::text, t."contact_id"::text, to_jsonb(t)
      FROM "crm_tasks" t WHERE t."contact_id" IN (${sourceContactId}::uuid, ${targetContactId}::uuid)
      UNION ALL
      SELECT 'leads.contact_id', l."id"::text, l."contact_id"::text, to_jsonb(l)
      FROM "leads" l WHERE l."contact_id" IN (${sourceContactId}::uuid, ${targetContactId}::uuid)
      UNION ALL
      SELECT 'team_inbox_new_lead_acknowledgements.contact_id', a."id"::text, a."contact_id"::text, to_jsonb(a)
      FROM "team_inbox_new_lead_acknowledgements" a WHERE a."contact_id" IN (${sourceContactId}::uuid, ${targetContactId}::uuid)
      UNION ALL
      SELECT 'merge_suggestions.source_contact_id', s."id"::text, s."source_contact_id"::text, to_jsonb(s)
      FROM "merge_suggestions" s WHERE s."source_contact_id" IN (${sourceContactId}::uuid, ${targetContactId}::uuid)
      UNION ALL
      SELECT 'merge_suggestions.target_contact_id', s."id"::text, s."target_contact_id"::text, to_jsonb(s)
      FROM "merge_suggestions" s WHERE s."target_contact_id" IN (${sourceContactId}::uuid, ${targetContactId}::uuid)
      UNION ALL
      SELECT 'sales_agent_memories.contact_id', m."id"::text, m."contact_id"::text, to_jsonb(m)
      FROM "sales_agent_memories" m WHERE m."contact_id" IN (${sourceContactId}::uuid, ${targetContactId}::uuid)
      UNION ALL
      SELECT 'sales_agent_next_actions.contact_id', a."id"::text, a."contact_id"::text, to_jsonb(a)
      FROM "sales_agent_next_actions" a WHERE a."contact_id" IN (${sourceContactId}::uuid, ${targetContactId}::uuid)
      UNION ALL
      SELECT 'facebook_sales_autopilot_sessions.contact_id', s."id"::text, s."contact_id"::text, to_jsonb(s)
      FROM "facebook_sales_autopilot_sessions" s WHERE s."contact_id" IN (${sourceContactId}::uuid, ${targetContactId}::uuid)
      UNION ALL
      SELECT 'facebook_sales_autopilot_actions.contact_id', a."id"::text, a."contact_id"::text, to_jsonb(a)
      FROM "facebook_sales_autopilot_actions" a WHERE a."contact_id" IN (${sourceContactId}::uuid, ${targetContactId}::uuid)
      UNION ALL
      SELECT 'media_job_analyses.contact_id', a."id"::text, a."contact_id"::text, to_jsonb(a)
      FROM "media_job_analyses" a WHERE a."contact_id" IN (${sourceContactId}::uuid, ${targetContactId}::uuid)
      UNION ALL
      SELECT 'conversation_threads.contact_id', t."id"::text, t."contact_id"::text, to_jsonb(t)
      FROM "conversation_threads" t WHERE t."contact_id" IN (${sourceContactId}::uuid, ${targetContactId}::uuid)
      UNION ALL
      SELECT 'conversation_participants.contact_id', p."id"::text, p."contact_id"::text, to_jsonb(p)
      FROM "conversation_participants" p WHERE p."contact_id" IN (${sourceContactId}::uuid, ${targetContactId}::uuid)
      UNION ALL
      SELECT 'partner_users.org_contact_id', p."id"::text, p."org_contact_id"::text, to_jsonb(p)
      FROM "partner_users" p WHERE p."org_contact_id" IN (${sourceContactId}::uuid, ${targetContactId}::uuid)
      UNION ALL
      SELECT 'partner_invite_operations.org_contact_id', p."id"::text, p."org_contact_id"::text, to_jsonb(p)
      FROM "partner_invite_operations" p WHERE p."org_contact_id" IN (${sourceContactId}::uuid, ${targetContactId}::uuid)
      UNION ALL
      SELECT 'partner_rate_cards.org_contact_id', p."id"::text, p."org_contact_id"::text, to_jsonb(p)
      FROM "partner_rate_cards" p WHERE p."org_contact_id" IN (${sourceContactId}::uuid, ${targetContactId}::uuid)
      UNION ALL
      SELECT 'external_message_dispatches.contact_id', d."id"::text, d."contact_id"::text, to_jsonb(d)
      FROM "external_message_dispatches" d WHERE d."contact_id" IN (${sourceContactId}::uuid, ${targetContactId}::uuid)
      UNION ALL
      SELECT 'eta_message_drafts.contact_id', d."id"::text, d."contact_id"::text, to_jsonb(d)
      FROM "eta_message_drafts" d WHERE d."contact_id" IN (${sourceContactId}::uuid, ${targetContactId}::uuid)
      UNION ALL
      SELECT 'appointments.contact_id', a."id"::text, a."contact_id"::text, to_jsonb(a)
      FROM "appointments" a WHERE a."contact_id" IN (${sourceContactId}::uuid, ${targetContactId}::uuid)
      UNION ALL
      SELECT 'appointment_holds.contact_id', h."id"::text, h."contact_id"::text, to_jsonb(h)
      FROM "appointment_holds" h WHERE h."contact_id" IN (${sourceContactId}::uuid, ${targetContactId}::uuid)
      UNION ALL
      SELECT 'media_assets.contact_id', m."id"::text, m."contact_id"::text, to_jsonb(m)
      FROM "media_assets" m WHERE m."contact_id" IN (${sourceContactId}::uuid, ${targetContactId}::uuid)
      UNION ALL
      SELECT 'partner_bookings.org_contact_id', b."id"::text, b."org_contact_id"::text, to_jsonb(b)
      FROM "partner_bookings" b WHERE b."org_contact_id" IN (${sourceContactId}::uuid, ${targetContactId}::uuid)
      UNION ALL
      SELECT 'call_records.contact_id', c."id"::text, c."contact_id"::text, to_jsonb(c)
      FROM "call_records" c WHERE c."contact_id" IN (${sourceContactId}::uuid, ${targetContactId}::uuid)
      UNION ALL
      SELECT 'quotes.contact_id', q."id"::text, q."contact_id"::text, to_jsonb(q)
      FROM "quotes" q WHERE q."contact_id" IN (${sourceContactId}::uuid, ${targetContactId}::uuid)
      UNION ALL
      SELECT 'instant_quotes.contact_id', q."id"::text, q."contact_id"::text, to_jsonb(q)
      FROM "instant_quotes" q WHERE q."contact_id" IN (${sourceContactId}::uuid, ${targetContactId}::uuid)
      UNION ALL
      SELECT 'outbox_events.quarantined_contact_id', o."id"::text, o."quarantined_contact_id"::text, to_jsonb(o)
      FROM "outbox_events" o WHERE o."quarantined_contact_id" IN (${sourceContactId}::uuid, ${targetContactId}::uuid)
      UNION ALL
      SELECT 'team_call_operations.contact_id', c."id"::text, c."contact_id"::text, to_jsonb(c)
      FROM "team_call_operations" c WHERE c."contact_id" IN (${sourceContactId}::uuid, ${targetContactId}::uuid)
      UNION ALL
      SELECT 'team_call_operation_task_intents.expected_contact_id', i."id"::text, i."expected_contact_id"::text, to_jsonb(i)
      FROM "team_call_operation_task_intents" i WHERE i."expected_contact_id" IN (${sourceContactId}::uuid, ${targetContactId}::uuid)
      UNION ALL
      SELECT 'sales_escalation_call_operations.contact_id', c."id"::text, c."contact_id"::text, to_jsonb(c)
      FROM "sales_escalation_call_operations" c WHERE c."contact_id" IN (${sourceContactId}::uuid, ${targetContactId}::uuid)
      UNION ALL
      SELECT 'staff_notification_operations.contact_id', n."id"::text, n."contact_id"::text, to_jsonb(n)
      FROM "staff_notification_operations" n WHERE n."contact_id" IN (${sourceContactId}::uuid, ${targetContactId}::uuid)
      UNION ALL
      SELECT 'contacts.merged_into_contact_snapshot_id', c."id"::text, c."merged_into_contact_snapshot_id"::text, to_jsonb(c)
      FROM "contacts" c WHERE c."merged_into_contact_snapshot_id" IN (${sourceContactId}::uuid, ${targetContactId}::uuid)
      UNION ALL
      SELECT 'contact_merge_recovery_ledgers.source_contact_snapshot_id', l."id"::text, l."source_contact_snapshot_id"::text, to_jsonb(l)
      FROM "contact_merge_recovery_ledgers" l WHERE l."source_contact_snapshot_id" IN (${sourceContactId}::uuid, ${targetContactId}::uuid)
      UNION ALL
      SELECT 'contact_merge_recovery_ledgers.target_contact_snapshot_id', l."id"::text, l."target_contact_snapshot_id"::text, to_jsonb(l)
      FROM "contact_merge_recovery_ledgers" l WHERE l."target_contact_snapshot_id" IN (${sourceContactId}::uuid, ${targetContactId}::uuid)
    ) dependency
    ORDER BY dependency."dependencyKey", dependency."entityId"
  `);

  const rows = resultRows(dependencyResult).map((row) => ({
    dependencyKey: stringValue(row["dependencyKey"]),
    entityId: stringValue(row["entityId"]),
    ownerContactId: stringValue(row["ownerContactId"]),
    snapshot: exactRowSnapshot(row["snapshot"]),
  }));

  const inventoryResult: unknown = await db.execute(sql`
    WITH "contactScope"("contactId") AS (
      VALUES (${sourceContactId}::uuid), (${targetContactId}::uuid)
    )
    SELECT
      scope."contactId"::text AS "contactId",
      'foreign_key'::text AS "inventoryKind",
      inventory."schema_name" AS "schemaName",
      inventory."table_name" AS "tableName",
      inventory."column_name" AS "columnName",
      inventory."reference_count" AS "referenceCount",
      inventory."supported" AS "supported"
    FROM "contactScope" scope
    CROSS JOIN LATERAL "contact_purge_fk_inventory"(scope."contactId") inventory
    UNION ALL
    SELECT
      scope."contactId"::text,
      'logical'::text,
      inventory."schema_name",
      inventory."table_name",
      inventory."column_name",
      inventory."reference_count",
      inventory."supported"
    FROM "contactScope" scope
    CROSS JOIN LATERAL "contact_purge_logical_inventory"(scope."contactId") inventory
    ORDER BY 1, 2, 3, 4, 5
  `);
  const inventory = resultRows(inventoryResult).map((row) => ({
    contactId: stringValue(row["contactId"]),
    inventoryKind:
      row["inventoryKind"] === "logical" ? "logical" : "foreign_key",
    schemaName: stringValue(row["schemaName"]),
    tableName: stringValue(row["tableName"]),
    columnName: stringValue(row["columnName"]),
    referenceCount: countValue(row["referenceCount"]),
    supported: row["supported"] === true,
  })) satisfies DependencyInventoryRow[];

  const safetyResult: unknown = await db.execute(sql`
    WITH "contactScope"("contactId") AS (
      VALUES (${sourceContactId}::uuid), (${targetContactId}::uuid)
    )
    SELECT
      scope."contactId"::text AS "contactId",
      coalesce((
        SELECT jsonb_agg(o."id"::text ORDER BY o."id")
        FROM "outbox_events" o
        WHERE o."processed_at" IS NULL
          AND o."quarantined_at" IS NULL
          AND (
            o."payload"->>'contactId' = scope."contactId"::text
            OR o."payload"::text LIKE ('%' || scope."contactId"::text || '%')
            OR EXISTS (SELECT 1 FROM "leads" l WHERE l."contact_id" = scope."contactId" AND l."id"::text = o."payload"->>'leadId')
            OR EXISTS (SELECT 1 FROM "appointments" a WHERE a."contact_id" = scope."contactId" AND a."id"::text = o."payload"->>'appointmentId')
            OR EXISTS (SELECT 1 FROM "quotes" q WHERE q."contact_id" = scope."contactId" AND q."id"::text = o."payload"->>'quoteId')
            OR EXISTS (SELECT 1 FROM "crm_tasks" t WHERE t."contact_id" = scope."contactId" AND t."id"::text = o."payload"->>'taskId')
            OR EXISTS (SELECT 1 FROM "conversation_threads" t WHERE t."contact_id" = scope."contactId" AND t."id"::text = o."payload"->>'threadId')
          )
      ), '[]'::jsonb) AS "unresolvedOutboxIds",
      coalesce((
        SELECT jsonb_agg(d."id"::text ORDER BY d."id")
        FROM "external_message_dispatches" d
        WHERE d."contact_id" = scope."contactId"
          AND d."state" IN ('requested', 'dispatched', 'reconciliation_required')
      ), '[]'::jsonb) AS "activeExternalDispatchIds",
      coalesce((
        SELECT jsonb_agg(c."id"::text ORDER BY c."id")
        FROM "team_call_operations" c
        WHERE c."contact_id" = scope."contactId"
          AND c."guard_released_at" IS NULL
      ), '[]'::jsonb) AS "activeManualCallIds",
      coalesce((
        SELECT jsonb_agg(c."id"::text ORDER BY c."id")
        FROM "sales_escalation_call_operations" c
        WHERE c."contact_id" = scope."contactId"
          AND c."guard_released_at" IS NULL
      ), '[]'::jsonb) AS "activeSalesCallIds",
      coalesce((
        SELECT jsonb_agg(p."id"::text ORDER BY p."id")
        FROM "properties" p
        WHERE p."contact_id" = scope."contactId"
          AND EXISTS (
            SELECT 1 FROM "contact_properties" linked
            WHERE linked."property_id" = p."id"
          )
          AND NOT EXISTS (
            SELECT 1 FROM "contact_properties" owned
            WHERE owned."property_id" = p."id"
              AND owned."contact_id" = scope."contactId"
          )
      ), '[]'::jsonb) AS "staleCompatibilityPropertyIds"
    FROM "contactScope" scope
    ORDER BY scope."contactId"
  `);
  const ids = (row: Record<string, unknown>, key: string): string[] =>
    Array.isArray(row[key])
      ? row[key].filter((value): value is string => typeof value === "string")
      : [];
  const operationSafety = resultRows(safetyResult).map((row) => ({
    contactId: stringValue(row["contactId"]),
    unresolvedOutboxIds: ids(row, "unresolvedOutboxIds"),
    activeExternalDispatchIds: ids(row, "activeExternalDispatchIds"),
    activeManualCallIds: ids(row, "activeManualCallIds"),
    activeSalesCallIds: ids(row, "activeSalesCallIds"),
    staleCompatibilityPropertyIds: ids(row, "staleCompatibilityPropertyIds"),
  })) satisfies ContactMergeOperationSafetyState[];

  return {
    rows,
    inventory,
    operationSafety,
  };
}

function dependencyInventoryEvidenceBlockers(
  state: MergeDependencyState,
  contactId: string,
): string[] {
  return contactMergeInventoryEvidenceFailures(
    contactId,
    state.inventory,
    state.rows,
  );
}

function dependencyOperationSafetyBlockers(
  state: MergeDependencyState,
  contactId: string,
): string[] {
  return contactMergeOperationSafetyFailures(
    state.operationSafety.find((item) => item.contactId === contactId),
  );
}

function dependencyBlockers(
  state: MergeDependencyState,
  sourceContactId: string,
): string[] {
  const blockers = new Set(
    dependencyInventoryEvidenceBlockers(state, sourceContactId),
  );
  for (const row of state.rows) {
    if (row.ownerContactId !== sourceContactId) continue;
    const rule = mergeDependencyRule(row.dependencyKey);
    if (rule?.disposition === "block") blockers.add(rule.label);
  }
  for (const blocker of dependencyOperationSafetyBlockers(
    state,
    sourceContactId,
  )) {
    blockers.add(blocker);
  }

  return Array.from(blockers).sort();
}

async function getMergePreviewUsing(
  db: DatabaseClient | MergeTransaction,
  input: { sourceContactId: string; targetContactId: string },
  providedDependencyState?: MergeDependencyState,
): Promise<MergePreview> {
  const { sourceContactId, targetContactId } = input;
  if (sourceContactId === targetContactId) {
    throw new MergeQueueError("same_contact", 422);
  }

  const rows = await db
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164,
      company: contacts.company,
      salespersonMemberId: contacts.salespersonMemberId,
      partnerAccountId: contacts.partnerAccountId,
      partnerStatus: contacts.partnerStatus,
      doNotContact: contacts.doNotContact,
      doNotContactAt: contacts.doNotContactAt,
      doNotContactBy: contacts.doNotContactBy,
      doNotContactReason: contacts.doNotContactReason,
      preferredContactMethod: contacts.preferredContactMethod,
      sourceValue: contacts.source,
      deletedAt: contacts.deletedAt,
      mergedIntoContactId: contacts.mergedIntoContactId,
      mergeRecoveryLedgerId: contacts.mergeRecoveryLedgerId,
      createdAt: contacts.createdAt,
      updatedAt: contacts.updatedAt,
      properties: sql<number>`(
        select count(*)::int from contact_properties p where p.contact_id = ${contacts.id}
      )`.mapWith(Number),
      leads: sql<number>`(
        select count(*)::int from leads l where l.contact_id = ${contacts.id}
      )`.mapWith(Number),
      threads: sql<number>`(
        select count(*)::int from conversation_threads t where t.contact_id = ${contacts.id}
      )`.mapWith(Number),
      messages: sql<number>`(
        select count(*)::int
        from conversation_messages m
        join conversation_threads t on t.id = m.thread_id
        where t.contact_id = ${contacts.id}
      )`.mapWith(Number),
      participants: sql<number>`(
        select count(*)::int from conversation_participants p where p.contact_id = ${contacts.id}
      )`.mapWith(Number),
      tasks: sql<number>`(
        select count(*)::int from crm_tasks t where t.contact_id = ${contacts.id}
      )`.mapWith(Number),
      appointments: sql<number>`(
        select count(*)::int from appointments a where a.contact_id = ${contacts.id}
      )`.mapWith(Number),
      quotes: sql<number>`(
        select count(*)::int from quotes q where q.contact_id = ${contacts.id}
      )`.mapWith(Number),
      payments: sql<number>`(
        select count(*)::int
        from payments pay
        join appointments a on a.id = pay.appointment_id
        where a.contact_id = ${contacts.id}
      )`.mapWith(Number),
      pipeline: sql<number>`(
        select count(*)::int from crm_pipeline p where p.contact_id = ${contacts.id}
      )`.mapWith(Number),
      partnerUsers: sql<number>`(
        select count(*)::int from partner_users p where p.org_contact_id = ${contacts.id}
      )`.mapWith(Number),
      partnerRateCards: sql<number>`(
        select count(*)::int from partner_rate_cards p where p.org_contact_id = ${contacts.id}
      )`.mapWith(Number),
      partnerBookings: sql<number>`(
        select count(*)::int from partner_bookings p where p.org_contact_id = ${contacts.id}
      )`.mapWith(Number),
      agentMemories: sql<number>`(
        select count(*)::int from sales_agent_memories m where m.contact_id = ${contacts.id}
      )`.mapWith(Number),
      agentNextActions: sql<number>`(
        select count(*)::int from sales_agent_next_actions a where a.contact_id = ${contacts.id}
      )`.mapWith(Number),
      mediaAnalyses: sql<number>`(
        select count(*)::int from media_job_analyses a where a.contact_id = ${contacts.id}
      )`.mapWith(Number),
      automationSessions: sql<number>`(
        select count(*)::int from facebook_sales_autopilot_sessions s where s.contact_id = ${contacts.id}
      )`.mapWith(Number),
      automationActions: sql<number>`(
        select count(*)::int from facebook_sales_autopilot_actions a where a.contact_id = ${contacts.id}
      )`.mapWith(Number),
      callRecords: sql<number>`(
        select count(*)::int from call_records c where c.contact_id = ${contacts.id}
      )`.mapWith(Number),
      mediaAssets: sql<number>`(
        select count(*)::int from media_assets m where m.contact_id = ${contacts.id}
      )`.mapWith(Number),
      appointmentHolds: sql<number>`(
        select count(*)::int from appointment_holds h where h.contact_id = ${contacts.id}
      )`.mapWith(Number),
      etaDrafts: sql<number>`(
        select count(*)::int from eta_message_drafts d where d.contact_id = ${contacts.id}
      )`.mapWith(Number),
      instantQuotes: sql<number>`(
        select count(*)::int from instant_quotes q where q.contact_id = ${contacts.id}
      )`.mapWith(Number),
      inboxAcknowledgements: sql<number>`(
        select count(*)::int from team_inbox_new_lead_acknowledgements a where a.contact_id = ${contacts.id}
      )`.mapWith(Number),
      externalDispatches: sql<number>`(
        select count(*)::int from external_message_dispatches d where d.contact_id = ${contacts.id}
      )`.mapWith(Number),
      manualCallEvidence: sql<number>`(
        select count(*)::int from team_call_operations c where c.contact_id = ${contacts.id}
      )`.mapWith(Number),
      salesCallEvidence: sql<number>`(
        select count(*)::int from sales_escalation_call_operations c where c.contact_id = ${contacts.id}
      )`.mapWith(Number),
      staffNotificationEvidence: sql<number>`(
        select count(*)::int from staff_notification_operations n where n.contact_id = ${contacts.id}
      )`.mapWith(Number),
      pendingOutboxOperations: sql<number>`(
        select count(*)::int from outbox_events o
        where o.processed_at is null and o.quarantined_at is null
          and o.payload->>'contactId' = ${contacts.id}::text
      )`.mapWith(Number),
      mergeSuggestionCount: sql<number>`(
        select count(*)::int from merge_suggestions s
        where s.source_contact_id = ${contacts.id} or s.target_contact_id = ${contacts.id}
      )`.mapWith(Number),
    })
    .from(contacts)
    .where(inArray(contacts.id, [sourceContactId, targetContactId]));

  const sourceRow = rows.find((row) => row.id === sourceContactId);
  const targetRow = rows.find((row) => row.id === targetContactId);
  if (!sourceRow || !targetRow) {
    throw new MergeQueueError("contact_not_found", 404);
  }
  if (sourceRow.deletedAt || targetRow.deletedAt) {
    throw new MergeQueueError("merge_contact_inactive", 409);
  }
  if (
    sourceRow.mergedIntoContactId ||
    sourceRow.mergeRecoveryLedgerId ||
    targetRow.mergedIntoContactId ||
    targetRow.mergeRecoveryLedgerId
  ) {
    throw new MergeQueueError("merge_contact_already_merged", 409);
  }

  const dependencyState =
    providedDependencyState ??
    (await readMergeDependencyStateUsing(db, sourceContactId, targetContactId));

  const toPreviewContact = (
    row: (typeof rows)[number],
  ): MergePreviewContact => ({
    id: row.id,
    name:
      [row.firstName, row.lastName].filter(Boolean).join(" ").trim() ||
      "Contact",
    email: row.email ?? null,
    phone: row.phoneE164 ?? row.phone ?? null,
    partnerAccountId: row.partnerAccountId ?? null,
    partnerStatus: row.partnerStatus,
    updatedAt: row.updatedAt.toISOString(),
    counts: {
      properties: row.properties,
      leads: row.leads,
      threads: row.threads,
      messages: row.messages,
      participants: row.participants,
      tasks: row.tasks,
      appointments: row.appointments,
      quotes: row.quotes,
      payments: row.payments,
      pipeline: row.pipeline,
      partnerUsers: row.partnerUsers,
      partnerRateCards: row.partnerRateCards,
      partnerBookings: row.partnerBookings,
      agentMemories: row.agentMemories,
      agentNextActions: row.agentNextActions,
      mediaAnalyses: row.mediaAnalyses,
      automationSessions: row.automationSessions,
      automationActions: row.automationActions,
      callRecords: row.callRecords,
      mediaAssets: row.mediaAssets,
      appointmentHolds: row.appointmentHolds,
      etaDrafts: row.etaDrafts,
      instantQuotes: row.instantQuotes,
      inboxAcknowledgements: row.inboxAcknowledgements,
      externalDispatches: row.externalDispatches,
      manualCallEvidence: row.manualCallEvidence,
      salesCallEvidence: row.salesCallEvidence,
      staffNotificationEvidence: row.staffNotificationEvidence,
      pendingOutboxOperations: row.pendingOutboxOperations,
      mergeSuggestions: row.mergeSuggestionCount,
    },
  });

  const source = toPreviewContact(sourceRow);
  const target = toPreviewContact(targetRow);
  const asFieldSnapshot = (
    row: typeof sourceRow,
  ): MergeContactFieldSnapshot => ({
    company: row.company ?? null,
    email: row.email ?? null,
    phone: row.phone ?? null,
    phoneE164: row.phoneE164 ?? null,
    salespersonMemberId: row.salespersonMemberId ?? null,
    doNotContact: row.doNotContact,
    doNotContactAt: row.doNotContactAt ?? null,
    doNotContactBy: row.doNotContactBy ?? null,
    doNotContactReason: row.doNotContactReason ?? null,
    preferredContactMethod: row.preferredContactMethod ?? null,
    source: row.sourceValue ?? null,
  });
  const consolidationPlan = buildContactConsolidationPlan(
    asFieldSnapshot(sourceRow),
    asFieldSnapshot(targetRow),
  );
  const unresolvedDependencies = new Set(
    dependencyBlockers(dependencyState, sourceContactId),
  );
  for (const blocker of dependencyOperationSafetyBlockers(
    dependencyState,
    targetContactId,
  )) {
    unresolvedDependencies.add(`retained contact: ${blocker}`);
  }
  if (source.partnerAccountId !== null || source.partnerStatus !== "none") {
    unresolvedDependencies.add("partner contact profile");
  }

  const hashMaterial = {
    ruleVersion: CONTACT_MERGE_RULE_VERSION,
    sourceContactId,
    targetContactId,
    source: sourceRow,
    target: targetRow,
    dependencies: dependencyState,
    consolidationPlan,
  };
  const previewHash = buildMergePreviewHash(hashMaterial);

  return {
    source,
    target,
    confirmationText: buildMergeConfirmation(sourceContactId, targetContactId),
    previewHash,
    ruleVersion: CONTACT_MERGE_RULE_VERSION,
    consolidationPlan,
    unresolvedDependencies: Array.from(unresolvedDependencies).sort(),
  };
}

export async function getMergePreview(input: {
  sourceContactId: string;
  targetContactId: string;
}): Promise<MergePreview> {
  return getMergePreviewUsing(getDb(), input);
}

export async function mergeContactsInTransaction(
  tx: MergeTransaction,
  input: {
    sourceContactId: string;
    targetContactId: string;
    expectedSourceUpdatedAt: string;
    expectedTargetUpdatedAt: string;
    expectedPreviewHash: string;
    recovery: MergeRecoveryContext;
  },
): Promise<MergeContactsResult> {
  const { sourceContactId, targetContactId } = input;
  if (
    !isExactContactMergeUuid(sourceContactId) ||
    !isExactContactMergeUuid(targetContactId) ||
    !isExactContactMergeInstant(input.expectedSourceUpdatedAt) ||
    !isExactContactMergeInstant(input.expectedTargetUpdatedAt) ||
    !isExactContactMergeHash(input.expectedPreviewHash)
  ) {
    throw new MergeQueueError("merge_input_invalid", 422);
  }
  if (
    !isExactContactMergeUuid(input.recovery.actorMemberId) ||
    !isExactContactMergeUuid(input.recovery.sessionId) ||
    !isExactContactMergeUuid(input.recovery.operationId) ||
    !isExactContactMergeHash(input.recovery.idempotencyKeyHash) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(
      input.recovery.correlationId,
    ) ||
    (input.recovery.authMethod !== "team_session" &&
      input.recovery.authMethod !== "break_glass")
  ) {
    throw new MergeQueueError("merge_actor_attribution_invalid", 500);
  }
  if (sourceContactId === targetContactId) {
    throw new MergeQueueError("same_contact", 422);
  }

  const orderedContactIds = [sourceContactId, targetContactId].sort();
  for (const contactId of orderedContactIds) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${contactId}, 91))`,
    );
  }

  const rows = await tx
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      company: contacts.company,
      email: contacts.email,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164,
      salespersonMemberId: contacts.salespersonMemberId,
      partnerAccountId: contacts.partnerAccountId,
      partnerStatus: contacts.partnerStatus,
      partnerType: contacts.partnerType,
      partnerOwnerMemberId: contacts.partnerOwnerMemberId,
      partnerSince: contacts.partnerSince,
      partnerLastTouchAt: contacts.partnerLastTouchAt,
      partnerNextTouchAt: contacts.partnerNextTouchAt,
      partnerReferralCount: contacts.partnerReferralCount,
      partnerLastReferralAt: contacts.partnerLastReferralAt,
      doNotContact: contacts.doNotContact,
      doNotContactAt: contacts.doNotContactAt,
      doNotContactBy: contacts.doNotContactBy,
      doNotContactReason: contacts.doNotContactReason,
      preferredContactMethod: contacts.preferredContactMethod,
      sourceValue: contacts.source,
      deletedAt: contacts.deletedAt,
      deletedBy: contacts.deletedBy,
      purgeEligibleAt: contacts.purgeEligibleAt,
      mergedIntoContactId: contacts.mergedIntoContactId,
      mergeRecoveryLedgerId: contacts.mergeRecoveryLedgerId,
      createdAt: contacts.createdAt,
      updatedAt: contacts.updatedAt,
    })
    .from(contacts)
    .where(inArray(contacts.id, [sourceContactId, targetContactId]))
    .orderBy(contacts.id)
    .for("update");

  const source = rows.find((row) => row.id === sourceContactId);
  const target = rows.find((row) => row.id === targetContactId);
  if (!source || !target) {
    throw new MergeQueueError("contact_not_found", 404);
  }
  if (source.deletedAt || target.deletedAt) {
    throw new MergeQueueError("merge_contact_inactive", 409);
  }
  if (
    source.mergedIntoContactId ||
    source.mergeRecoveryLedgerId ||
    target.mergedIntoContactId ||
    target.mergeRecoveryLedgerId
  ) {
    throw new MergeQueueError("merge_contact_already_merged", 409);
  }
  const contactBeforeRows = await readContactEvidenceRowsUsing(tx, [
    sourceContactId,
    targetContactId,
  ]);
  const sourceContactBefore = contactBeforeRows.find(
    (row) => row.entityId === sourceContactId,
  );
  const targetContactBefore = contactBeforeRows.find(
    (row) => row.entityId === targetContactId,
  );
  if (!sourceContactBefore || !targetContactBefore) {
    throw new MergeQueueError("merge_dependency_evidence_incomplete", 409);
  }

  // Contact locks always precede suggestion locks. Manual merges, approvals,
  // and declines use this same order so reversed source/target requests cannot
  // deadlock or allow two reviewers to claim the same pair.
  const lockedSuggestions = await tx
    .select({
      id: mergeSuggestions.id,
      sourceContactId: mergeSuggestions.sourceContactId,
      targetContactId: mergeSuggestions.targetContactId,
      status: mergeSuggestions.status,
      reason: mergeSuggestions.reason,
      confidence: mergeSuggestions.confidence,
      meta: mergeSuggestions.meta,
      reviewedBy: mergeSuggestions.reviewedBy,
      reviewedAt: mergeSuggestions.reviewedAt,
      createdAt: mergeSuggestions.createdAt,
      updatedAt: mergeSuggestions.updatedAt,
    })
    .from(mergeSuggestions)
    .where(
      or(
        inArray(mergeSuggestions.sourceContactId, orderedContactIds),
        inArray(mergeSuggestions.targetContactId, orderedContactIds),
      ),
    )
    .orderBy(mergeSuggestions.id)
    .for("update");

  let reviewedSuggestion: (typeof lockedSuggestions)[number] | null = null;
  if (input.recovery.suggestionId) {
    reviewedSuggestion =
      lockedSuggestions.find(
        (suggestion) => suggestion.id === input.recovery.suggestionId,
      ) ?? null;
    const expectedSuggestionTime = input.recovery.expectedSuggestionUpdatedAt
      ? new Date(input.recovery.expectedSuggestionUpdatedAt)
      : null;
    if (
      !reviewedSuggestion ||
      reviewedSuggestion.status !== "pending" ||
      reviewedSuggestion.sourceContactId !== sourceContactId ||
      reviewedSuggestion.targetContactId !== targetContactId ||
      !expectedSuggestionTime ||
      !Number.isFinite(expectedSuggestionTime.getTime()) ||
      reviewedSuggestion.updatedAt.getTime() !==
        expectedSuggestionTime.getTime()
    ) {
      throw new MergeQueueError("suggestion_already_resolved", 409);
    }
  }

  const sourceExpected = new Date(input.expectedSourceUpdatedAt);
  const targetExpected = new Date(input.expectedTargetUpdatedAt);
  if (
    !Number.isFinite(sourceExpected.getTime()) ||
    sourceExpected.getTime() !== source.updatedAt.getTime() ||
    !Number.isFinite(targetExpected.getTime()) ||
    targetExpected.getTime() !== target.updatedAt.getTime()
  ) {
    throw new MergeQueueError("merge_contact_version_conflict", 409);
  }

  const dependencyState = await readMergeDependencyStateUsing(
    tx,
    sourceContactId,
    targetContactId,
  );
  const preview = await getMergePreviewUsing(tx, input, dependencyState);
  if (preview.unresolvedDependencies.length > 0) {
    throw new MergeQueueError("merge_has_unresolved_dependencies", 409);
  }
  if (preview.previewHash !== input.expectedPreviewHash) {
    throw new MergeQueueError("merge_preview_conflict", 409);
  }

  const mergedAt = new Date(
    Math.max(
      Date.now(),
      source.updatedAt.getTime() + 1,
      target.updatedAt.getTime() + 1,
    ),
  );
  const recoveryLedgerId = randomUUID();
  const purgeEligibleAt = contactPurgeEligibleAt(mergedAt);
  const updatedFields = preview.consolidationPlan.targetUpdatedFields;
  const actorMemberId = input.recovery.actorMemberId;
  const sessionId = input.recovery.sessionId;

  const sourceRows = dependencyState.rows.filter(
    (row) => row.ownerContactId === sourceContactId,
  );
  const dependencySummary = sourceRows.reduce<Record<string, number>>(
    (summary, row) => {
      summary[row.dependencyKey] = (summary[row.dependencyKey] ?? 0) + 1;
      return summary;
    },
    {},
  );
  await tx.insert(contactMergeRecoveryLedgers).values({
    id: recoveryLedgerId,
    sourceContactId,
    targetContactId,
    suggestionId: input.recovery.suggestionId ?? null,
    previewHash: preview.previewHash,
    ruleVersion: CONTACT_MERGE_RULE_VERSION,
    sourceVersion: source.updatedAt,
    targetVersion: mergedAt,
    actorMemberId,
    actorRole: input.recovery.actorRole,
    actorLabel: input.recovery.actorLabel,
    sessionId,
    authMethod: input.recovery.authMethod,
    operationId: input.recovery.operationId,
    correlationId: input.recovery.correlationId,
    idempotencyKeyHash: input.recovery.idempotencyKeyHash,
    status: "completed",
    contactBefore: {
      evidenceVersion: 1,
      source: sourceContactBefore.snapshot,
      target: targetContactBefore.snapshot,
    },
    consolidationPlan: preview.consolidationPlan,
    dependencySummary,
    createdAt: mergedAt,
  });

  const [sourceMarked] = await tx
    .update(contacts)
    .set({
      email: null,
      phone: null,
      phoneE164: null,
      deletedAt: mergedAt,
      deletedBy: actorMemberId,
      purgeEligibleAt,
      mergedIntoContactId: targetContactId,
      mergeRecoveryLedgerId: recoveryLedgerId,
      updatedAt: mergedAt,
    })
    .where(
      and(
        eq(contacts.id, sourceContactId),
        eq(contacts.updatedAt, source.updatedAt),
        isNull(contacts.deletedAt),
        isNull(contacts.mergeRecoveryLedgerId),
      ),
    )
    .returning({ id: contacts.id });
  if (!sourceMarked) throw new MergeQueueError("merge_source_changed", 409);

  const [targetUpdated] = await tx
    .update(contacts)
    .set({
      ...preview.consolidationPlan.targetPatch,
      updatedAt: mergedAt,
    })
    .where(
      and(
        eq(contacts.id, targetContactId),
        eq(contacts.updatedAt, target.updatedAt),
        isNull(contacts.deletedAt),
      ),
    )
    .returning({ id: contacts.id });
  if (!targetUpdated)
    throw new MergeQueueError("merge_contact_version_conflict", 409);

  const sourcePropertyAssociations = await tx
    .select({
      propertyId: contactProperties.propertyId,
      relationship: contactProperties.relationship,
    })
    .from(contactProperties)
    .where(eq(contactProperties.contactId, sourceContactId));

  // Rollback-only fallback: a legacy owner row is considered linked only when
  // no explicit association exists for that physical property. This prevents
  // a stale compatibility owner from absorbing another contact's property.
  const sourceCompatibilityProperties = await tx
    .select({ propertyId: properties.id })
    .from(properties)
    .leftJoin(
      contactProperties,
      eq(contactProperties.propertyId, properties.id),
    )
    .where(
      and(
        eq(properties.contactId, sourceContactId),
        isNull(contactProperties.id),
      ),
    );

  const sourcePropertyLinks = Array.from(
    new Map(
      [
        ...sourcePropertyAssociations,
        ...sourceCompatibilityProperties.map((property) => ({
          propertyId: property.propertyId,
          relationship: "customer",
        })),
      ].map((association) => [association.propertyId, association]),
    ).values(),
  );
  const sourcePropertyIds = sourcePropertyLinks.map(
    (association) => association.propertyId,
  );

  const propertiesUpdated =
    sourcePropertyIds.length > 0
      ? await tx
          .update(properties)
          .set({ contactId: targetContactId, updatedAt: mergedAt })
          .where(
            and(
              eq(properties.contactId, sourceContactId),
              inArray(properties.id, sourcePropertyIds),
            ),
          )
          .returning({ id: properties.id })
      : [];

  if (sourcePropertyLinks.length > 0) {
    await tx
      .insert(contactProperties)
      .values(
        sourcePropertyLinks.map((association) => ({
          contactId: targetContactId,
          propertyId: association.propertyId,
          relationship: association.relationship,
          updatedAt: mergedAt,
        })),
      )
      .onConflictDoNothing({
        target: [contactProperties.contactId, contactProperties.propertyId],
      });
    await tx
      .delete(contactProperties)
      .where(eq(contactProperties.contactId, sourceContactId));
  }

  const leadsUpdated = await tx
    .update(leads)
    .set({ contactId: targetContactId, updatedAt: mergedAt })
    .where(eq(leads.contactId, sourceContactId))
    .returning({ id: leads.id });

  const quotesUpdated = await tx
    .update(quotes)
    .set({ contactId: targetContactId, updatedAt: mergedAt })
    .where(eq(quotes.contactId, sourceContactId))
    .returning({ id: quotes.id });

  const appointmentsUpdated = await tx
    .update(appointments)
    .set({ contactId: targetContactId, updatedAt: mergedAt })
    .where(eq(appointments.contactId, sourceContactId))
    .returning({ id: appointments.id });

  const threadsUpdated = await tx
    .update(conversationThreads)
    .set({ contactId: targetContactId, updatedAt: mergedAt })
    .where(eq(conversationThreads.contactId, sourceContactId))
    .returning({ id: conversationThreads.id });

  const participantsUpdated = await tx
    .update(conversationParticipants)
    .set({ contactId: targetContactId })
    .where(eq(conversationParticipants.contactId, sourceContactId))
    .returning({ id: conversationParticipants.id });

  const tasksUpdated = await tx
    .update(crmTasks)
    .set({ contactId: targetContactId, updatedAt: mergedAt })
    .where(eq(crmTasks.contactId, sourceContactId))
    .returning({ id: crmTasks.id });

  const [targetPipeline] = await tx
    .select({ contactId: crmPipeline.contactId })
    .from(crmPipeline)
    .where(eq(crmPipeline.contactId, targetContactId))
    .limit(1);

  let pipelineCount = 0;
  if (targetPipeline) {
    const removed = await tx
      .delete(crmPipeline)
      .where(eq(crmPipeline.contactId, sourceContactId))
      .returning({ id: crmPipeline.contactId });
    pipelineCount = removed.length;
  } else {
    const updated = await tx
      .update(crmPipeline)
      .set({ contactId: targetContactId, updatedAt: mergedAt })
      .where(eq(crmPipeline.contactId, sourceContactId))
      .returning({ id: crmPipeline.contactId });
    pipelineCount = updated.length;
  }

  const acknowledgementRows = await tx
    .select()
    .from(teamInboxNewLeadAcknowledgements)
    .where(
      inArray(teamInboxNewLeadAcknowledgements.contactId, orderedContactIds),
    )
    .orderBy(teamInboxNewLeadAcknowledgements.id)
    .for("update");
  const sourceAcknowledgements = acknowledgementRows.filter(
    (row) => row.contactId === sourceContactId,
  );
  for (const sourceAcknowledgement of sourceAcknowledgements) {
    const targetAcknowledgement = acknowledgementRows.find(
      (row) =>
        row.contactId === targetContactId &&
        row.teamMemberId === sourceAcknowledgement.teamMemberId,
    );
    if (targetAcknowledgement) {
      await tx
        .update(teamInboxNewLeadAcknowledgements)
        .set({
          acknowledgedAt:
            targetAcknowledgement.acknowledgedAt >
            sourceAcknowledgement.acknowledgedAt
              ? targetAcknowledgement.acknowledgedAt
              : sourceAcknowledgement.acknowledgedAt,
          expiresAt:
            targetAcknowledgement.expiresAt > sourceAcknowledgement.expiresAt
              ? targetAcknowledgement.expiresAt
              : sourceAcknowledgement.expiresAt,
          version:
            Math.max(
              targetAcknowledgement.version,
              sourceAcknowledgement.version,
            ) + 1,
          updatedAt: mergedAt,
        })
        .where(
          eq(teamInboxNewLeadAcknowledgements.id, targetAcknowledgement.id),
        );
      await tx
        .delete(teamInboxNewLeadAcknowledgements)
        .where(
          eq(teamInboxNewLeadAcknowledgements.id, sourceAcknowledgement.id),
        );
    } else {
      await tx
        .update(teamInboxNewLeadAcknowledgements)
        .set({
          contactId: targetContactId,
          version: sourceAcknowledgement.version + 1,
          updatedAt: mergedAt,
        })
        .where(
          eq(teamInboxNewLeadAcknowledgements.id, sourceAcknowledgement.id),
        );
    }
  }

  const moveUniqueContactRecord = async (
    dependencyKey: string,
    move: () => Promise<unknown>,
    remove: () => Promise<unknown>,
  ) => {
    const hasSource = sourceRows.some(
      (row) => row.dependencyKey === dependencyKey,
    );
    if (!hasSource) return 0;
    const hasTarget = dependencyState.rows.some(
      (row) =>
        row.dependencyKey === dependencyKey &&
        row.ownerContactId === targetContactId,
    );
    await (hasTarget ? remove() : move());
    return 1;
  };
  const agentMemoryCount = await moveUniqueContactRecord(
    "sales_agent_memories.contact_id",
    () =>
      tx
        .update(salesAgentMemories)
        .set({ contactId: targetContactId, updatedAt: mergedAt })
        .where(eq(salesAgentMemories.contactId, sourceContactId)),
    () =>
      tx
        .delete(salesAgentMemories)
        .where(eq(salesAgentMemories.contactId, sourceContactId)),
  );
  const agentNextActionCount = await moveUniqueContactRecord(
    "sales_agent_next_actions.contact_id",
    () =>
      tx
        .update(salesAgentNextActions)
        .set({ contactId: targetContactId, updatedAt: mergedAt })
        .where(eq(salesAgentNextActions.contactId, sourceContactId)),
    () =>
      tx
        .delete(salesAgentNextActions)
        .where(eq(salesAgentNextActions.contactId, sourceContactId)),
  );
  const mediaAnalysisCount = await moveUniqueContactRecord(
    "media_job_analyses.contact_id",
    () =>
      tx
        .update(mediaJobAnalyses)
        .set({ contactId: targetContactId, updatedAt: mergedAt })
        .where(eq(mediaJobAnalyses.contactId, sourceContactId)),
    () =>
      tx
        .delete(mediaJobAnalyses)
        .where(eq(mediaJobAnalyses.contactId, sourceContactId)),
  );

  const automationSessionsUpdated = await tx
    .update(facebookSalesAutopilotSessions)
    .set({ contactId: targetContactId, updatedAt: mergedAt })
    .where(eq(facebookSalesAutopilotSessions.contactId, sourceContactId))
    .returning({ id: facebookSalesAutopilotSessions.id });
  const automationActionsUpdated = await tx
    .update(facebookSalesAutopilotActions)
    .set({ contactId: targetContactId })
    .where(eq(facebookSalesAutopilotActions.contactId, sourceContactId))
    .returning({ id: facebookSalesAutopilotActions.id });
  const callRecordsUpdated = await tx
    .update(callRecords)
    .set({ contactId: targetContactId, updatedAt: mergedAt })
    .where(eq(callRecords.contactId, sourceContactId))
    .returning({ id: callRecords.id });
  const mediaAssetsUpdated = await tx
    .update(mediaAssets)
    .set({ contactId: targetContactId, updatedAt: mergedAt })
    .where(eq(mediaAssets.contactId, sourceContactId))
    .returning({ id: mediaAssets.id });
  const appointmentHoldsUpdated = await tx
    .update(appointmentHolds)
    .set({ contactId: targetContactId, updatedAt: mergedAt })
    .where(eq(appointmentHolds.contactId, sourceContactId))
    .returning({ id: appointmentHolds.id });
  const etaDraftsUpdated = await tx
    .update(etaMessageDrafts)
    .set({ contactId: targetContactId, updatedAt: mergedAt })
    .where(eq(etaMessageDrafts.contactId, sourceContactId))
    .returning({ id: etaMessageDrafts.id });
  const instantQuotesUpdated = await tx
    .update(instantQuotes)
    .set({ contactId: targetContactId })
    .where(eq(instantQuotes.contactId, sourceContactId))
    .returning({ id: instantQuotes.id });

  const supersededSuggestions = lockedSuggestions.filter(
    (suggestion) =>
      suggestion.status === "pending" &&
      suggestion.id !== reviewedSuggestion?.id,
  );
  if (supersededSuggestions.length > 0) {
    await tx
      .update(mergeSuggestions)
      .set({
        status: "declined",
        reviewedBy: actorMemberId,
        reviewedAt: mergedAt,
        updatedAt: mergedAt,
        meta: sql`coalesce(${mergeSuggestions.meta}, '{}'::jsonb) || jsonb_build_object('supersededByMergeLedgerId', ${recoveryLedgerId}, 'supersededAt', ${mergedAt.toISOString()})`,
      })
      .where(
        and(
          inArray(
            mergeSuggestions.id,
            supersededSuggestions.map((suggestion) => suggestion.id),
          ),
          eq(mergeSuggestions.status, "pending"),
        ),
      );
  }

  let suggestionVersion: string | undefined;
  if (reviewedSuggestion) {
    const [approved] = await tx
      .update(mergeSuggestions)
      .set({
        status: "approved",
        reviewedBy: actorMemberId,
        reviewedAt: mergedAt,
        updatedAt: mergedAt,
        meta: sql`coalesce(${mergeSuggestions.meta}, '{}'::jsonb) || jsonb_build_object('recoveryLedgerId', ${recoveryLedgerId}, 'previewHash', ${preview.previewHash})`,
      })
      .where(
        and(
          eq(mergeSuggestions.id, reviewedSuggestion.id),
          eq(mergeSuggestions.status, "pending"),
          eq(mergeSuggestions.updatedAt, reviewedSuggestion.updatedAt),
        ),
      )
      .returning({ updatedAt: mergeSuggestions.updatedAt });
    if (!approved)
      throw new MergeQueueError("suggestion_already_resolved", 409);
    suggestionVersion = approved.updatedAt.toISOString();
  }

  // Capture the actual committed-shape rows after every mutation. Recovery
  // evidence is built from these database snapshots, not inferred from the
  // writes above, so a missing or unexpectedly transformed row aborts the
  // same transaction instead of producing a misleading ledger.
  const postDependencyState = await readMergeDependencyStateUsing(
    tx,
    sourceContactId,
    targetContactId,
  );
  const contactAfterRows = await readContactEvidenceRowsUsing(tx, [
    sourceContactId,
    targetContactId,
  ]);
  const sourceContactAfter = contactAfterRows.find(
    (row) => row.entityId === sourceContactId,
  );
  const targetContactAfter = contactAfterRows.find(
    (row) => row.entityId === targetContactId,
  );
  if (!sourceContactAfter || !targetContactAfter) {
    throw new MergeQueueError("merge_dependency_postcondition_failed", 409);
  }

  type RecoveryEntryInsert = typeof contactMergeRecoveryEntries.$inferInsert;
  const recoveryEntries: RecoveryEntryInsert[] = [];
  const addEntry = (
    entry: Omit<
      RecoveryEntryInsert,
      "id" | "ledgerId" | "ordinal" | "createdAt"
    >,
  ) => {
    recoveryEntries.push({
      ...entry,
      ledgerId: recoveryLedgerId,
      ordinal: recoveryEntries.length,
      createdAt: mergedAt,
    });
  };
  const requirePostRow = (
    predicate: (candidate: MergeDependencyRow) => boolean,
  ): MergeDependencyRow => {
    const row = postDependencyState.rows.find(predicate);
    if (!row) {
      throw new MergeQueueError("merge_dependency_postcondition_failed", 409);
    }
    return row;
  };

  addEntry({
    entityType: "contact",
    entityId: targetContactId,
    changeKind: "updated",
    before: beforeEvidence(
      CONTACT_EVIDENCE_DEPENDENCY_KEY,
      targetContactBefore.snapshot,
    ),
    after: presentAfterEvidence(targetContactAfter),
  });
  addEntry({
    entityType: "contact",
    entityId: sourceContactId,
    changeKind: "soft_deleted",
    before: beforeEvidence(
      CONTACT_EVIDENCE_DEPENDENCY_KEY,
      sourceContactBefore.snapshot,
    ),
    after: presentAfterEvidence(sourceContactAfter),
  });

  const uniqueKeys = new Set([
    "crm_pipeline.contact_id",
    "sales_agent_memories.contact_id",
    "sales_agent_next_actions.contact_id",
    "media_job_analyses.contact_id",
  ]);
  const findTargetMatch = (
    row: MergeDependencyRow,
  ): MergeDependencyRow | undefined => {
    if (uniqueKeys.has(row.dependencyKey)) {
      return dependencyState.rows.find(
        (candidate) =>
          candidate.dependencyKey === row.dependencyKey &&
          candidate.ownerContactId === targetContactId,
      );
    }
    if (row.dependencyKey === "contact_properties.contact_id") {
      return dependencyState.rows.find(
        (candidate) =>
          candidate.dependencyKey === row.dependencyKey &&
          candidate.ownerContactId === targetContactId &&
          candidate.snapshot["property_id"] === row.snapshot["property_id"],
      );
    }
    if (
      row.dependencyKey === "team_inbox_new_lead_acknowledgements.contact_id"
    ) {
      return dependencyState.rows.find(
        (candidate) =>
          candidate.dependencyKey === row.dependencyKey &&
          candidate.ownerContactId === targetContactId &&
          candidate.snapshot["team_member_id"] ===
            row.snapshot["team_member_id"],
      );
    }
    return undefined;
  };
  const mutatedSuggestionIds = new Set([
    ...supersededSuggestions.map((suggestion) => suggestion.id),
    ...(reviewedSuggestion ? [reviewedSuggestion.id] : []),
  ]);
  for (const row of sourceRows) {
    if (
      row.dependencyKey.startsWith("merge_suggestions.") &&
      mutatedSuggestionIds.has(row.entityId)
    ) {
      continue;
    }
    const rule = mergeDependencyRule(row.dependencyKey);
    if (!rule || rule.disposition === "block") {
      throw new MergeQueueError("merge_dependency_postcondition_failed", 409);
    }
    if (rule.disposition === "preserve_historical") {
      const retained = requirePostRow(
        (candidate) =>
          candidate.dependencyKey === row.dependencyKey &&
          candidate.entityId === row.entityId &&
          candidate.ownerContactId === sourceContactId,
      );
      addEntry({
        entityType: row.dependencyKey.split(".")[0] ?? "dependency",
        entityId: row.entityId,
        changeKind: "retained_historical",
        before: beforeEvidence(row.dependencyKey, row.snapshot),
        after: presentAfterEvidence(retained),
      });
      continue;
    }
    const targetMatch = findTargetMatch(row);
    if (targetMatch) {
      const sourceStillPresent = postDependencyState.rows.some(
        (candidate) =>
          candidate.dependencyKey === row.dependencyKey &&
          candidate.entityId === row.entityId,
      );
      const retained = requirePostRow(
        (candidate) =>
          candidate.dependencyKey === row.dependencyKey &&
          candidate.entityId === targetMatch.entityId &&
          candidate.ownerContactId === targetContactId,
      );
      if (sourceStillPresent) {
        throw new MergeQueueError("merge_dependency_postcondition_failed", 409);
      }
      addEntry({
        entityType: row.dependencyKey.split(".")[0] ?? "dependency",
        entityId: row.entityId,
        changeKind: "deduplicated",
        before: deduplicatedBeforeEvidence(
          row.dependencyKey,
          row.snapshot,
          targetMatch.snapshot,
        ),
        after: deduplicatedAfterEvidence(row, retained),
      });
      continue;
    }

    const destination =
      row.dependencyKey === "crm_pipeline.contact_id"
        ? requirePostRow(
            (candidate) =>
              candidate.dependencyKey === row.dependencyKey &&
              candidate.ownerContactId === targetContactId,
          )
        : row.dependencyKey === "contact_properties.contact_id"
          ? requirePostRow(
              (candidate) =>
                candidate.dependencyKey === row.dependencyKey &&
                candidate.ownerContactId === targetContactId &&
                candidate.snapshot["property_id"] ===
                  row.snapshot["property_id"],
            )
          : requirePostRow(
              (candidate) =>
                candidate.dependencyKey === row.dependencyKey &&
                candidate.entityId === row.entityId &&
                candidate.ownerContactId === targetContactId,
            );
    const replaced = destination.entityId !== row.entityId;
    if (
      replaced &&
      postDependencyState.rows.some(
        (candidate) =>
          candidate.dependencyKey === row.dependencyKey &&
          candidate.entityId === row.entityId,
      )
    ) {
      throw new MergeQueueError("merge_dependency_postcondition_failed", 409);
    }
    addEntry({
      entityType: row.dependencyKey.split(".")[0] ?? "dependency",
      entityId: row.entityId,
      changeKind: "moved",
      before: beforeEvidence(row.dependencyKey, row.snapshot),
      after: replaced
        ? replacedAfterEvidence(row, destination)
        : presentAfterEvidence(destination),
    });
  }

  // Compatibility-only properties create a canonical association because no
  // source association existed to move. Record the exact created row rather
  // than inflating the moved count with an inferred association.
  for (const compatibilityProperty of sourceCompatibilityProperties) {
    const createdAssociation = requirePostRow(
      (candidate) =>
        candidate.dependencyKey === "contact_properties.contact_id" &&
        candidate.ownerContactId === targetContactId &&
        candidate.snapshot["property_id"] === compatibilityProperty.propertyId,
    );
    addEntry({
      entityType: "contact_properties",
      entityId: createdAssociation.entityId,
      changeKind: "created",
      before: absentBeforeEvidence("contact_properties.contact_id", {
        contactId: sourceContactId,
        propertyId: compatibilityProperty.propertyId,
      }),
      after: presentAfterEvidence(createdAssociation),
    });
  }

  const mutatedSuggestions = [
    ...supersededSuggestions.map((suggestion) => ({
      suggestion,
      changeKind: "superseded" as const,
    })),
    ...(reviewedSuggestion
      ? [{ suggestion: reviewedSuggestion, changeKind: "updated" as const }]
      : []),
  ];
  for (const { suggestion, changeKind } of mutatedSuggestions) {
    const beforeRow = dependencyState.rows.find(
      (candidate) => candidate.entityId === suggestion.id,
    );
    const afterRow = postDependencyState.rows.find(
      (candidate) => candidate.entityId === suggestion.id,
    );
    if (!beforeRow || !afterRow) {
      throw new MergeQueueError("merge_dependency_postcondition_failed", 409);
    }
    addEntry({
      entityType: "merge_suggestions",
      entityId: suggestion.id,
      changeKind,
      before: beforeEvidence(beforeRow.dependencyKey, beforeRow.snapshot),
      after: presentAfterEvidence(afterRow),
    });
  }

  // The merge creates three logical provenance references: the source points
  // at its kept contact and the immutable ledger snapshots both contacts.
  // Enumerate each exact row so inventory-only dependencies never become an
  // undocumented exception to recovery drift checks.
  const createdProvenance = [
    requirePostRow(
      (candidate) =>
        candidate.dependencyKey ===
          "contacts.merged_into_contact_snapshot_id" &&
        candidate.entityId === sourceContactId &&
        candidate.ownerContactId === targetContactId,
    ),
    requirePostRow(
      (candidate) =>
        candidate.dependencyKey ===
          "contact_merge_recovery_ledgers.source_contact_snapshot_id" &&
        candidate.entityId === recoveryLedgerId &&
        candidate.ownerContactId === sourceContactId,
    ),
    requirePostRow(
      (candidate) =>
        candidate.dependencyKey ===
          "contact_merge_recovery_ledgers.target_contact_snapshot_id" &&
        candidate.entityId === recoveryLedgerId &&
        candidate.ownerContactId === targetContactId,
    ),
  ];
  for (const provenance of createdProvenance) {
    addEntry({
      entityType: provenance.dependencyKey.split(".")[0] ?? "dependency",
      entityId: provenance.entityId,
      changeKind: "created",
      before: absentBeforeEvidence(provenance.dependencyKey, {
        entityId: provenance.entityId,
        ownerContactId: provenance.ownerContactId,
      }),
      after: presentAfterEvidence(provenance),
    });
  }

  const postSafetyBlockers = [
    ...dependencyInventoryEvidenceBlockers(
      postDependencyState,
      sourceContactId,
    ),
    ...dependencyInventoryEvidenceBlockers(
      postDependencyState,
      targetContactId,
    ),
    ...dependencyOperationSafetyBlockers(postDependencyState, sourceContactId),
    ...dependencyOperationSafetyBlockers(postDependencyState, targetContactId),
  ];
  if (postSafetyBlockers.length > 0) {
    throw new MergeQueueError("merge_dependency_postcondition_failed", 409);
  }

  // Baseline every remaining post-merge row for both contacts, including
  // untouched rows already owned by the retained target. This lets a later
  // assessment detect not only drift in records changed by the merge, but
  // missing, changed, and newly introduced linked records on either side.
  const representedPostRows = new Set<string>();
  for (const entry of recoveryEntries) {
    const identity = contactMergeExpectedEvidenceIdentity(entry.after);
    if (!identity) {
      throw new MergeQueueError("merge_dependency_postcondition_failed", 409);
    }
    representedPostRows.add(
      evidenceIdentityKey(identity.dependencyKey, identity.entityId),
    );
  }
  const preBaselineRows = [...contactBeforeRows, ...dependencyState.rows];
  const postBaselineRows = [...contactAfterRows, ...postDependencyState.rows];
  for (const row of postBaselineRows) {
    const identityKey = evidenceIdentityKey(row.dependencyKey, row.entityId);
    if (representedPostRows.has(identityKey)) continue;
    const beforeRow = preBaselineRows.find(
      (candidate) =>
        candidate.dependencyKey === row.dependencyKey &&
        candidate.entityId === row.entityId,
    );
    addEntry({
      entityType:
        row.dependencyKey === CONTACT_EVIDENCE_DEPENDENCY_KEY
          ? "contact"
          : (row.dependencyKey.split(".")[0] ?? "dependency"),
      entityId: row.entityId,
      changeKind: "baseline",
      before: beforeRow
        ? beforeEvidence(row.dependencyKey, beforeRow.snapshot)
        : absentBeforeEvidence(row.dependencyKey, {
            entityId: row.entityId,
            ownerContactId: row.ownerContactId,
          }),
      after: presentAfterEvidence(row),
    });
    representedPostRows.add(identityKey);
  }
  for (let index = 0; index < recoveryEntries.length; index += 500) {
    await tx
      .insert(contactMergeRecoveryEntries)
      .values(recoveryEntries.slice(index, index + 500));
  }

  return {
    sourceContactId,
    targetContactId,
    targetVersion: mergedAt.toISOString(),
    previewHash: preview.previewHash,
    recoveryLedgerId,
    recoveryAssessmentPath: `/api/admin/merge-recovery/${recoveryLedgerId}/assessment`,
    ...(suggestionVersion ? { suggestionVersion } : {}),
    updatedFields,
    moved: {
      properties: propertiesUpdated.length,
      propertyAssociations: sourcePropertyLinks.length,
      leads: leadsUpdated.length,
      quotes: quotesUpdated.length,
      appointments: appointmentsUpdated.length,
      threads: threadsUpdated.length,
      participants: participantsUpdated.length,
      tasks: tasksUpdated.length,
      pipeline: pipelineCount,
      acknowledgements: sourceAcknowledgements.length,
      agentMemories: agentMemoryCount,
      agentNextActions: agentNextActionCount,
      mediaAnalyses: mediaAnalysisCount,
      automationSessions: automationSessionsUpdated.length,
      automationActions: automationActionsUpdated.length,
      callRecords: callRecordsUpdated.length,
      mediaAssets: mediaAssetsUpdated.length,
      appointmentHolds: appointmentHoldsUpdated.length,
      etaDrafts: etaDraftsUpdated.length,
      instantQuotes: instantQuotesUpdated.length,
      supersededSuggestions: supersededSuggestions.length,
    },
  };
}

export async function declineMergeSuggestionInTransaction(
  tx: MergeTransaction,
  input: {
    suggestionId: string;
    expectedUpdatedAt: string;
    actorMemberId: string | null;
    reviewedAt: Date;
  },
): Promise<{
  sourceContactId: string;
  targetContactId: string;
  version: string;
}> {
  const [hint] = await tx
    .select({
      sourceContactId: mergeSuggestions.sourceContactId,
      targetContactId: mergeSuggestions.targetContactId,
    })
    .from(mergeSuggestions)
    .where(eq(mergeSuggestions.id, input.suggestionId))
    .limit(1);
  if (!hint) throw new MergeQueueError("suggestion_already_resolved", 409);

  const orderedContactIds = [hint.sourceContactId, hint.targetContactId].sort();
  for (const contactId of orderedContactIds) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${contactId}, 91))`,
    );
  }
  await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(inArray(contacts.id, orderedContactIds))
    .orderBy(contacts.id)
    .for("update");
  const suggestions = await tx
    .select({
      id: mergeSuggestions.id,
      sourceContactId: mergeSuggestions.sourceContactId,
      targetContactId: mergeSuggestions.targetContactId,
      status: mergeSuggestions.status,
      updatedAt: mergeSuggestions.updatedAt,
    })
    .from(mergeSuggestions)
    .where(
      or(
        inArray(mergeSuggestions.sourceContactId, orderedContactIds),
        inArray(mergeSuggestions.targetContactId, orderedContactIds),
      ),
    )
    .orderBy(mergeSuggestions.id)
    .for("update");
  const current = suggestions.find(
    (suggestion) => suggestion.id === input.suggestionId,
  );
  const expected = new Date(input.expectedUpdatedAt);
  if (
    !current ||
    current.status !== "pending" ||
    current.sourceContactId !== hint.sourceContactId ||
    current.targetContactId !== hint.targetContactId ||
    !Number.isFinite(expected.getTime()) ||
    current.updatedAt.getTime() !== expected.getTime()
  ) {
    throw new MergeQueueError("suggestion_already_resolved", 409);
  }

  const [declined] = await tx
    .update(mergeSuggestions)
    .set({
      status: "declined",
      reviewedBy: input.actorMemberId,
      reviewedAt: input.reviewedAt,
      updatedAt: input.reviewedAt,
    })
    .where(
      and(
        eq(mergeSuggestions.id, input.suggestionId),
        eq(mergeSuggestions.status, "pending"),
        eq(mergeSuggestions.updatedAt, current.updatedAt),
      ),
    )
    .returning({ updatedAt: mergeSuggestions.updatedAt });
  if (!declined) throw new MergeQueueError("suggestion_already_resolved", 409);
  return {
    sourceContactId: current.sourceContactId,
    targetContactId: current.targetContactId,
    version: declined.updatedAt.toISOString(),
  };
}

export type ContactMergeRecoveryAssessmentResult = {
  ledger: {
    id: string;
    sourceContactId: string;
    targetContactId: string;
    suggestionId: string | null;
    previewHash: string;
    ruleVersion: string;
    mergedAt: string;
    actorLabel: string | null;
    entryCount: number;
  };
  assessment: ReturnType<typeof assessContactMergeRecovery>;
  changedDependencies: Array<{
    entityType: string;
    entityId: string;
    dependencyKey: string;
    reason: string;
    expectedOwnerContactId: string | null;
    actualOwnerContactId: string | null;
  }>;
};

export async function getContactMergeRecoveryAssessment(
  ledgerId: string,
): Promise<ContactMergeRecoveryAssessmentResult> {
  const database = getDb();
  return database.transaction(
    async (db) => {
      const [ledger] = await db
        .select({
          id: contactMergeRecoveryLedgers.id,
          sourceContactId: contactMergeRecoveryLedgers.sourceContactId,
          targetContactId: contactMergeRecoveryLedgers.targetContactId,
          suggestionId: contactMergeRecoveryLedgers.suggestionId,
          previewHash: contactMergeRecoveryLedgers.previewHash,
          ruleVersion: contactMergeRecoveryLedgers.ruleVersion,
          targetVersion: contactMergeRecoveryLedgers.targetVersion,
          actorLabel: contactMergeRecoveryLedgers.actorLabel,
          createdAt: contactMergeRecoveryLedgers.createdAt,
        })
        .from(contactMergeRecoveryLedgers)
        .where(eq(contactMergeRecoveryLedgers.id, ledgerId))
        .limit(1);
      if (!ledger) throw new MergeQueueError("merge_recovery_not_found", 404);

      const [source, target] = await Promise.all([
        db
          .select({
            id: contacts.id,
            mergedIntoContactId: contacts.mergedIntoContactId,
            mergeRecoveryLedgerId: contacts.mergeRecoveryLedgerId,
          })
          .from(contacts)
          .where(eq(contacts.id, ledger.sourceContactId))
          .limit(1)
          .then((rows) => rows[0] ?? null),
        db
          .select({ id: contacts.id, updatedAt: contacts.updatedAt })
          .from(contacts)
          .where(eq(contacts.id, ledger.targetContactId))
          .limit(1)
          .then((rows) => rows[0] ?? null),
      ]);
      const entries = await db
        .select({
          entityId: contactMergeRecoveryEntries.entityId,
          after: contactMergeRecoveryEntries.after,
        })
        .from(contactMergeRecoveryEntries)
        .where(eq(contactMergeRecoveryEntries.ledgerId, ledger.id))
        .orderBy(contactMergeRecoveryEntries.ordinal);
      const state = await readMergeDependencyStateUsing(
        db,
        ledger.sourceContactId,
        ledger.targetContactId,
      );
      const contactEvidenceRows = await readContactEvidenceRowsUsing(db, [
        ledger.sourceContactId,
        ledger.targetContactId,
      ]);
      const currentEvidenceRows: ContactMergeEvidenceRow[] = [
        ...contactEvidenceRows,
        ...state.rows,
      ];
      const changedDependencies: ContactMergeRecoveryAssessmentResult["changedDependencies"] =
        compareContactMergeRecoveryBaseline(entries, currentEvidenceRows).map(
          (drift) => ({
            entityType:
              drift.dependencyKey === CONTACT_EVIDENCE_DEPENDENCY_KEY
                ? "contact"
                : (drift.dependencyKey.split(".")[0] ?? "dependency"),
            entityId: drift.entityId,
            dependencyKey: drift.dependencyKey,
            reason: drift.reason,
            expectedOwnerContactId: drift.expectedOwnerContactId,
            actualOwnerContactId: drift.actualOwnerContactId,
          }),
        );
      const unknownDependencyCount =
        dependencyBlockers(state, ledger.sourceContactId).length +
        dependencyInventoryEvidenceBlockers(state, ledger.targetContactId)
          .length +
        dependencyOperationSafetyBlockers(state, ledger.targetContactId)
          .length +
        (ledger.ruleVersion === CONTACT_MERGE_RULE_VERSION ? 0 : 1) +
        (entries.length > 0 ? 0 : 1);
      const assessment = assessContactMergeRecovery({
        sourcePresent: source !== null,
        sourceStillBoundToLedger:
          source?.mergeRecoveryLedgerId === ledger.id &&
          source.mergedIntoContactId === ledger.targetContactId,
        targetPresent: target !== null,
        targetVersionUnchanged:
          target?.updatedAt.getTime() === ledger.targetVersion.getTime(),
        changedDependencyCount: changedDependencies.length,
        unknownDependencyCount,
      });
      return {
        ledger: {
          id: ledger.id,
          sourceContactId: ledger.sourceContactId,
          targetContactId: ledger.targetContactId,
          suggestionId: ledger.suggestionId,
          previewHash: ledger.previewHash,
          ruleVersion: ledger.ruleVersion,
          mergedAt: ledger.createdAt.toISOString(),
          actorLabel: ledger.actorLabel,
          entryCount: entries.length,
        },
        assessment,
        changedDependencies,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export async function mergeContacts(input: {
  sourceContactId: string;
  targetContactId: string;
  expectedSourceUpdatedAt: string;
  expectedTargetUpdatedAt: string;
  expectedPreviewHash: string;
  recovery: MergeRecoveryContext;
}): Promise<MergeContactsResult> {
  const db = getDb();
  return db.transaction((tx) => mergeContactsInTransaction(tx, input), {
    isolationLevel: "serializable",
  });
}
