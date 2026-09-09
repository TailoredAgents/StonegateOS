import { createHash, randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  appointmentHolds,
  auditLogs,
  crmTasks,
  getDb,
  partnerAccountLocations,
  partnerAccounts,
  partnerBookings,
  partnerBulkImportRows,
  partnerBulkImports,
  partnerRecurringOccurrences,
  partnerRecurringSeries,
  partnerServiceTemplates,
  teamMutationIdempotency,
  outboxEvents,
} from "@/db";
import type { PartnerPrincipal } from "@/lib/partner-account-authorization";
import { recordAuditEvent } from "@/lib/audit";
import {
  createOrReplacePartnerHold,
  createPartnerBookingDraft,
  getPartnerBookingDraft,
  getPartnerDraftAvailability,
  PartnerPortalSchedulingError,
  submitPartnerBookingDraft,
  type PartnerDraftDto,
  type PartnerDraftMutation,
  type PartnerSchedulingActor,
} from "@/lib/partner-portal-v2-scheduling";
import {
  createPortalV2StrongEtag,
  encodePortalV2Cursor,
  parsePortalV2Pagination,
  evaluatePortalV2RevisionPrecondition,
} from "@/lib/portal-v2-contract";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import { projectPartnerAddOnSnapshots } from "@/lib/partner-portal-v2-service-add-ons";
import { acquireScheduleConflictLock } from "@/lib/appointment-schedule-conflicts";
import { acquirePartnerRecurringHorizonClaimLock } from "@/lib/partner-recurring-coordination";
import type { TeamMutationTransaction } from "@/lib/team-mutation";
import {
  isPartnerToolEnabled,
  normalizePartnerAccountWorkflow,
  type PartnerToolKey,
} from "@/lib/partner-account-workflows";
import { loadPartnerBackgroundSchedulingActor } from "@/lib/partner-background-scheduling-actor";
import { listPartnerServiceCatalog } from "@/lib/partner-portal-v2-service-catalog";
import { arePartnerPortalV2WritesEnabled } from "@/lib/partner-portal-feature-flags";
import { csvCell } from "@/lib/expense-export";

const MAX_BULK_ROWS = 100;
const MAX_CSV_BYTES = 256 * 1024;
const MAX_OCCURRENCES = 24;
const RECURRING_CONFIRMATION_HORIZON_DAYS = 30;
const RECURRING_LIFECYCLE_RECEIPT_ACTION =
  "partner.portal.v2.recurring_series.lifecycle";
const RECURRING_LIFECYCLE_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

async function requireRepeatWorkTool(accountId: string, tool: PartnerToolKey) {
  if (!(await isPartnerToolEnabled(accountId, tool)))
    throw new PartnerPortalSchedulingError(
      "not_found",
      "This optional tool is not enabled for your account. Contact Stonegate if you need it.",
      { status: 404 },
    );
}

const UNSAFE_REUSE_KEY =
  /(?:access|gate|lock|secret|password|credential|token|payment|card|bank|price|rate|quote|invoice|approval|hold|authorization)/iu;
const UNSAFE_REUSE_TEXT =
  /(?:(?:gate|door|alarm|access|lockbox|keypad)\s*(?:code|pin|password)|(?:code|pin|password)\s*(?:is|:)|\bkey\s+(?:under|inside|behind|at)\b|\b(?:payment token|card number|bank account)\b|\b(?:sk|tok)_(?:live|test)_)/iu;

type TemplateData = Readonly<{
  schemaVersion: 1;
  tierKey: string | null;
  scope: Readonly<Record<string, unknown>>;
  description: string;
  crewInstructions: string | null;
  onSiteContact: Readonly<Record<string, unknown>> | null;
  proofRequirements: Readonly<Record<string, unknown>>;
  selectedAddOns: readonly Readonly<{ key: string; quantity: number }>[];
}>;

export type PartnerServiceTemplateDto = Readonly<{
  active: boolean;
  id: string;
  name: string;
  serviceKey: string;
  locationId: string | null;
  reusable: TemplateData;
  version: number;
  updatedAt: string;
  etag: string;
}>;

export type RecurrenceInput = Readonly<{
  templateId: string;
  name: string;
  frequency: "weekly" | "biweekly" | "monthly";
  startsOn: string;
  occurrenceCount: number;
  endsOn?: string | null;
  preferredWindowStart: string | null;
}>;

export type RecurringSeriesLifecycleAction = "pause" | "resume" | "cancel";

export type RecurringSeriesLifecycleMutation = Readonly<{
  action: RecurringSeriesLifecycleAction;
  reason: string;
}>;

export type PartnerRecurringSeriesLifecycle = Readonly<{
  action: RecurringSeriesLifecycleAction;
  reason: string;
  changedAt: string;
}>;

export type PartnerRecurringOccurrenceDto = Readonly<{
  id: string;
  localDate: string;
  state: string;
  draftId: string | null;
  jobId: string | null;
  currentJobStatus: string | null;
  reason: string | null;
  evaluation: Readonly<Record<string, unknown>>;
  evaluatedAt: string | null;
}>;

export type PartnerRecurringSeriesDto = Readonly<{
  id: string;
  name: string;
  templateId: string | null;
  recurrence: unknown;
  timezone: string;
  startsOn: string;
  endsOn: string | null;
  preferredWindowStart: string | null;
  state: string;
  revision: number;
  etag: string;
  lifecycle: PartnerRecurringSeriesLifecycle | null;
  occurrences: readonly PartnerRecurringOccurrenceDto[];
}>;

export type PartnerRecurringSeriesLifecycleResult = Readonly<{
  series: PartnerRecurringSeriesDto;
  transition: Readonly<{
    action: RecurringSeriesLifecycleAction;
    reason: string;
    changedAt: string;
    changedOccurrences: number;
    preservedOccurrences: number;
  }>;
  replayed: boolean;
}>;

type RepeatWorkDatabase = ReturnType<typeof getDb> | TeamMutationTransaction;

export type BulkRowIssue = Readonly<{
  field: string;
  message: string;
}>;

export type NormalizedBulkRow = Readonly<{
  locationId: string;
  serviceKey: string;
  tierKey: string | null;
  description: string;
  crewInstructions: string | null;
  onSiteContact: Readonly<Record<string, unknown>>;
  scope: Readonly<Record<string, unknown>>;
  proofRequirements: Readonly<Record<string, unknown>>;
  commercial: Readonly<Record<string, unknown>>;
  preferredDate: string;
  preferredWindowStart: string | null;
  timezone: string;
}>;

export type BulkValidationRow = Readonly<{
  rowNumber: number;
  raw: Readonly<Record<string, string>>;
  normalized: NormalizedBulkRow | null;
  errors: readonly BulkRowIssue[];
}>;

function sha256(...parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part, "utf8").update("\u0000", "utf8");
  return hash.digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
    .join(",")}}`;
}

function operationHash(
  kind: string,
  accountId: string,
  idempotencyKeyHash: string,
): string {
  return sha256("partner-repeat-work-v1", kind, accountId, idempotencyKeyHash);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().replaceAll(String.fromCharCode(0), "");
  return text ? text.slice(0, maximum) : null;
}

function cleanReusableText(value: unknown, maximum: number): string | null {
  const text = cleanText(value, maximum * 2);
  if (!text) return null;
  const sanitized = text
    .split(/\r?\n/u)
    .filter((line) => !UNSAFE_REUSE_TEXT.test(line))
    .join("\n")
    .trim()
    .slice(0, maximum);
  return sanitized || null;
}

function sanitizeReusableValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string")
    return cleanReusableText(value, 2_000) ?? undefined;
  if (Array.isArray(value)) {
    return value
      .slice(0, 40)
      .map((entry) => sanitizeReusableValue(entry, depth + 1))
      .filter((entry) => entry !== undefined);
  }
  if (!isRecord(value)) return undefined;
  const entries: Array<[string, unknown]> = [];
  for (const [key, nested] of Object.entries(value).slice(0, 80)) {
    if (UNSAFE_REUSE_KEY.test(key)) continue;
    const safe = sanitizeReusableValue(nested, depth + 1);
    if (safe !== undefined) entries.push([key.slice(0, 100), safe]);
  }
  return Object.fromEntries(entries);
}

export function sanitizeReusableScope(
  value: unknown,
): Readonly<Record<string, unknown>> {
  const sanitized = sanitizeReusableValue(isRecord(value) ? value : {});
  const record = isRecord(sanitized) ? sanitized : {};
  if (stableJson(record).length > 32_000) {
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "The reusable scope is too large.",
      {
        status: 422,
        fieldErrors: { scope: "Keep reusable scope under 32 KB." },
      },
    );
  }
  return Object.freeze(record);
}

function safeOnSiteContact(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const name = cleanText(value["name"], 120);
  const phone = cleanText(value["phone"], 40);
  const email = cleanText(value["email"], 254)?.toLowerCase() ?? null;
  if (!name && !phone && !email) return null;
  return {
    ...(name ? { name } : {}),
    ...(phone ? { phone } : {}),
    ...(email ? { email } : {}),
  };
}

function safeProofRequirements(value: unknown): Record<string, unknown> {
  const source = isRecord(value) ? value : {};
  const count = (entry: unknown, fallback: number): number =>
    typeof entry === "number" && Number.isSafeInteger(entry)
      ? Math.min(40, Math.max(0, entry))
      : entry === true
        ? 1
        : entry === false
          ? 0
          : fallback;
  return {
    before: count(source["before"], 1),
    after: count(source["after"], 1),
    package: source["package"] === true,
  };
}

function templateRevision(row: { id: string; version: number }): string {
  return `partner-service-template:${row.id}:${row.version}`;
}

function safeTemplateAddOns(
  value: unknown,
): readonly Readonly<{ key: string; quantity: number }>[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const seen = new Set<string>();
  return Object.freeze(
    value
      .slice(0, 20)
      .flatMap((candidate) => {
        if (!isRecord(candidate)) return [];
        const key = candidate["key"];
        const quantity = candidate["quantity"];
        if (
          typeof key !== "string" ||
          !/^[a-z][a-z0-9_-]{1,79}$/u.test(key) ||
          seen.has(key) ||
          typeof quantity !== "number" ||
          !Number.isSafeInteger(quantity) ||
          quantity < 1 ||
          quantity > 100
        ) {
          return [];
        }
        seen.add(key);
        return [{ key, quantity }];
      })
      .sort((left, right) => left.key.localeCompare(right.key)),
  );
}

function toTemplateDto(
  row: typeof partnerServiceTemplates.$inferSelect,
): PartnerServiceTemplateDto {
  const rawReusable = isRecord(row.templateData) ? row.templateData : null;
  const reusable: TemplateData = rawReusable
    ? ({
        ...(rawReusable as unknown as TemplateData),
        tierKey:
          typeof rawReusable["tierKey"] === "string" &&
          /^[a-z0-9][a-z0-9_-]{0,99}$/u.test(rawReusable["tierKey"])
            ? rawReusable["tierKey"]
            : null,
        selectedAddOns: safeTemplateAddOns(rawReusable["selectedAddOns"]),
      } satisfies TemplateData)
    : ({
        schemaVersion: 1,
        tierKey: null,
        scope: {},
        description: "",
        crewInstructions: null,
        onSiteContact: null,
        proofRequirements: { before: 1, after: 1 },
        selectedAddOns: [],
      } satisfies TemplateData);
  return Object.freeze({
    id: row.id,
    name: row.name,
    active: row.active,
    serviceKey: row.serviceKey,
    locationId: row.locationId,
    reusable,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
    etag: createPortalV2StrongEtag(templateRevision(row)),
  });
}

function assertActorLocation(
  actor: PartnerSchedulingActor,
  location: typeof partnerAccountLocations.$inferSelect | null,
): void {
  if (
    !location ||
    location.partnerAccountId !== actor.accountId ||
    !location.active
  ) {
    throw new PartnerPortalSchedulingError(
      "not_found",
      "The service location was not found.",
      {
        status: 404,
      },
    );
  }
  if (actor.accessLevel === "account") return;
  if (actor.locationIds.includes(location.id)) return;
  if (location.propertyId && actor.propertyIds.includes(location.propertyId))
    return;
  throw new PartnerPortalSchedulingError(
    "not_found",
    "The service location was not found.",
    {
      status: 404,
    },
  );
}

async function loadLocationForActor(
  actor: PartnerSchedulingActor,
  locationId: string,
) {
  const [location] = await getDb()
    .select()
    .from(partnerAccountLocations)
    .where(
      and(
        eq(partnerAccountLocations.partnerAccountId, actor.accountId),
        eq(partnerAccountLocations.id, locationId),
      ),
    )
    .limit(1);
  assertActorLocation(actor, location ?? null);
  return location!;
}

function templateDataFromDraft(draft: PartnerDraftDto): TemplateData {
  const description = cleanReusableText(draft.description, 4_000);
  if (!description || !draft.serviceKey || !draft.locationId) {
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "Complete the location, service, and description before saving a template.",
      { status: 422 },
    );
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    tierKey: draft.tierKey,
    scope: sanitizeReusableScope(draft.scope),
    description,
    crewInstructions: cleanReusableText(draft.crewInstructions, 4_000),
    onSiteContact: safeOnSiteContact(draft.onSiteContact),
    proofRequirements: safeProofRequirements(draft.proofRequirements),
    selectedAddOns: draft.selectedAddOns.map((addOn) => ({ ...addOn })),
  });
}

async function reusableSourceFromJob(input: {
  actor: PartnerSchedulingActor;
  jobId: string;
}): Promise<{
  locationId: string;
  serviceKey: string;
  data: TemplateData;
}> {
  const [job] = await getDb()
    .select({
      serviceKey: partnerBookings.serviceKey,
      tierKey: partnerBookings.tierKey,
      propertyId: partnerBookings.propertyId,
      scope: partnerBookings.scopeSnapshot,
      proof: partnerBookings.proofRequirementsSnapshot,
      addOns: partnerBookings.addOnsSnapshot,
    })
    .from(partnerBookings)
    .where(
      and(
        eq(partnerBookings.partnerAccountId, input.actor.accountId),
        eq(partnerBookings.id, input.jobId),
      ),
    )
    .limit(1);
  if (!job?.serviceKey) {
    throw new PartnerPortalSchedulingError(
      "not_found",
      "The job was not found.",
      {
        status: 404,
      },
    );
  }
  const snapshot = isRecord(job.scope) ? job.scope : {};
  const snapshotLocation = cleanText(snapshot["locationId"], 64);
  const [location] = await getDb()
    .select()
    .from(partnerAccountLocations)
    .where(
      and(
        eq(partnerAccountLocations.partnerAccountId, input.actor.accountId),
        snapshotLocation
          ? eq(partnerAccountLocations.id, snapshotLocation)
          : eq(
              partnerAccountLocations.propertyId,
              job.propertyId ?? "00000000-0000-0000-0000-000000000000",
            ),
      ),
    )
    .limit(1);
  assertActorLocation(input.actor, location ?? null);
  const description = cleanReusableText(snapshot["description"], 4_000);
  if (!description) {
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "This job does not contain reusable scope.",
      { status: 422 },
    );
  }
  return {
    locationId: location!.id,
    serviceKey: job.serviceKey,
    data: Object.freeze({
      schemaVersion: 1 as const,
      tierKey: job.tierKey,
      scope: sanitizeReusableScope(snapshot["scope"]),
      description,
      crewInstructions: cleanReusableText(snapshot["crewInstructions"], 4_000),
      onSiteContact: safeOnSiteContact(snapshot["onSiteContact"]),
      proofRequirements: safeProofRequirements(job.proof),
      selectedAddOns: projectPartnerAddOnSnapshots(job.addOns).map((addOn) => ({
        key: addOn.key,
        quantity: addOn.quantity,
      })),
    }),
  };
}

async function reusableSource(input: {
  actor: PartnerSchedulingActor;
  draftId?: string;
  jobId?: string;
}) {
  if ((input.draftId ? 1 : 0) + (input.jobId ? 1 : 0) !== 1) {
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "Choose exactly one draft or job to reuse.",
      { status: 422 },
    );
  }
  if (input.jobId)
    return reusableSourceFromJob({ actor: input.actor, jobId: input.jobId });
  const draft = await getPartnerBookingDraft({
    actor: input.actor,
    draftId: input.draftId!,
  });
  if (!draft.locationId || !draft.serviceKey) {
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "Complete the location and service before reusing this draft.",
      { status: 422 },
    );
  }
  await loadLocationForActor(input.actor, draft.locationId);
  return {
    locationId: draft.locationId,
    serviceKey: draft.serviceKey,
    data: templateDataFromDraft(draft),
  };
}

function mutationFromTemplate(
  template: PartnerServiceTemplateDto,
): PartnerDraftMutation {
  return {
    locationId: template.locationId,
    serviceKey: template.serviceKey,
    tierKey: template.reusable.tierKey,
    selectedAddOns: template.reusable.selectedAddOns.map((addOn) => ({
      ...addOn,
    })),
    scope: { ...template.reusable.scope },
    description: template.reusable.description,
    crewInstructions: template.reusable.crewInstructions,
    // Location access secrets, one-time access details, old media, commercial
    // snapshots, pricing, approvals, holds, and payment state are never copied.
    accessDetails: null,
    onSiteContact: template.reusable.onSiteContact
      ? { ...template.reusable.onSiteContact }
      : null,
    proofRequirements: { ...template.reusable.proofRequirements },
    commercial: {},
    preferredWindows: [],
  };
}

async function audit(input: {
  principal: PartnerPrincipal;
  correlationId: string;
  action: string;
  entityType: string;
  entityId: string;
  permission: string;
  idempotencyKeyHash?: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  await getDb()
    .insert(auditLogs)
    .values({
      actorType: "human",
      actorId: input.principal.partnerUserId,
      actorLabel: input.principal.email,
      actorRole: input.principal.roleKey,
      sessionId: input.principal.session.id,
      authMethod: "partner_session",
      correlationId: input.correlationId,
      requiredPermissions: [input.permission],
      outcome: "succeeded",
      surface: "partner_portal_v2",
      idempotencyKeyHash: input.idempotencyKeyHash,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      meta: sanitizeAuditMetadata({
        accountId: input.principal.accountId,
        membershipId: input.principal.membershipId,
        ...(input.meta ?? {}),
      }),
    });
}

export async function listPartnerServiceTemplates(input: {
  actor: PartnerSchedulingActor;
  params?: URLSearchParams;
}) {
  const params = input.params ?? new URLSearchParams();
  const query = (params.get("q") ?? "").trim();
  const state = params.get("state") ?? "all";
  if (query.length > 120 || !["all", "active", "archived"].includes(state))
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "Review the template filters.",
      { status: 422 },
    );
  const filterHash = sha256(
    stableJson({
      query,
      state,
      locations: input.actor.locationIds,
      properties: input.actor.propertyIds,
      access: input.actor.accessLevel,
    }),
  );
  type Cursor = {
    accountId: string;
    membershipId: string;
    filterHash: string;
    name: string;
    id: string;
  };
  const pagination = parsePortalV2Pagination(params, {
    cursorKind: "partner_service_templates",
    allowedQueryKeys: new Set(["q", "state"]),
    validateCursorPayload: (value: unknown): value is Cursor =>
      isRecord(value) &&
      value["accountId"] === input.actor.accountId &&
      value["membershipId"] === input.actor.membershipId &&
      value["filterHash"] === filterHash &&
      typeof value["name"] === "string" &&
      value["name"].length <= 120 &&
      typeof value["id"] === "string" &&
      UUID_PATTERN.test(value["id"]),
  });
  if (!pagination.ok)
    throw new PartnerPortalSchedulingError(
      "invalid_cursor",
      "Reload saved templates.",
      { status: 400 },
    );
  const after = pagination.cursor?.payload;
  const filters = and(
    state === "all"
      ? undefined
      : eq(partnerServiceTemplates.active, state === "active"),
    query
      ? sql`position(lower(${query}) in lower(${partnerServiceTemplates.name})) > 0`
      : undefined,
    after
      ? sql`(${partnerServiceTemplates.name}, ${partnerServiceTemplates.id}) > (${after.name}, ${after.id}::uuid)`
      : undefined,
  );
  const db = getDb();
  const rows =
    input.actor.accessLevel === "account"
      ? await db
          .select()
          .from(partnerServiceTemplates)
          .where(
            and(
              eq(
                partnerServiceTemplates.partnerAccountId,
                input.actor.accountId,
              ),
              filters,
            ),
          )
          .orderBy(
            asc(partnerServiceTemplates.name),
            asc(partnerServiceTemplates.id),
          )
          .limit(pagination.limit + 1)
      : await (async () => {
          const grants: SQL[] = [];
          if (input.actor.locationIds.length > 0) {
            grants.push(
              inArray(partnerAccountLocations.id, [...input.actor.locationIds]),
            );
          }
          if (input.actor.propertyIds.length > 0) {
            grants.push(
              inArray(partnerAccountLocations.propertyId, [
                ...input.actor.propertyIds,
              ]),
            );
          }
          const scopedRows = await db
            .select({ template: partnerServiceTemplates })
            .from(partnerServiceTemplates)
            .innerJoin(
              partnerAccountLocations,
              and(
                eq(
                  partnerAccountLocations.id,
                  partnerServiceTemplates.locationId,
                ),
                eq(
                  partnerAccountLocations.partnerAccountId,
                  partnerServiceTemplates.partnerAccountId,
                ),
              ),
            )
            .where(
              and(
                eq(
                  partnerServiceTemplates.partnerAccountId,
                  input.actor.accountId,
                ),
                filters,
                or(...grants) ?? sql`false`,
              ),
            )
            .orderBy(
              asc(partnerServiceTemplates.name),
              asc(partnerServiceTemplates.id),
            )
            .limit(pagination.limit + 1);
          return scopedRows.map((row) => row.template);
        })();
  const visible = rows.slice(0, pagination.limit);
  const last = visible.at(-1);
  return {
    templates: Object.freeze(visible.map(toTemplateDto)),
    nextCursor:
      rows.length > pagination.limit && last
        ? encodePortalV2Cursor({
            kind: "partner_service_templates",
            limit: pagination.limit,
            payload: {
              accountId: input.actor.accountId,
              membershipId: input.actor.membershipId,
              filterHash,
              name: last.name,
              id: last.id,
            },
          })
        : null,
  };
}

export async function createPartnerServiceTemplate(input: {
  actor: PartnerSchedulingActor;
  principal: PartnerPrincipal;
  name: string;
  draftId?: string;
  jobId?: string;
  idempotencyKeyHash: string;
  correlationId: string;
}): Promise<{ template: PartnerServiceTemplateDto; replayed: boolean }> {
  await requireRepeatWorkTool(input.actor.accountId, "templates");
  const name = cleanText(input.name, 120);
  if (!name || name.length < 2) {
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "Name this template.",
      {
        status: 422,
        fieldErrors: { name: "Use 2 to 120 characters." },
      },
    );
  }
  const source = await reusableSource(input);
  const opHash = operationHash(
    "template.create",
    input.actor.accountId,
    input.idempotencyKeyHash,
  );
  const requestHash = sha256(
    stableJson({ name, draftId: input.draftId, jobId: input.jobId }),
  );
  const result = await getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`partner_template_v2:${input.actor.accountId}`}))`,
    );
    const [replay] = await tx
      .select()
      .from(partnerServiceTemplates)
      .where(eq(partnerServiceTemplates.createOperationKeyHash, opHash))
      .limit(1);
    if (replay) {
      if (replay.createRequestHash !== requestHash) {
        throw new PartnerPortalSchedulingError(
          "idempotency_conflict",
          "That request key was already used.",
          { status: 409 },
        );
      }
      return { template: toTemplateDto(replay), replayed: true };
    }
    const [duplicate] = await tx
      .select({ id: partnerServiceTemplates.id })
      .from(partnerServiceTemplates)
      .where(
        and(
          eq(partnerServiceTemplates.partnerAccountId, input.actor.accountId),
          eq(partnerServiceTemplates.name, name),
          eq(partnerServiceTemplates.active, true),
        ),
      )
      .limit(1);
    if (duplicate) {
      throw new PartnerPortalSchedulingError(
        "conflict",
        "A template with that name already exists.",
        {
          status: 409,
          fieldErrors: { name: "Choose a unique template name." },
        },
      );
    }
    const [created] = await tx
      .insert(partnerServiceTemplates)
      .values({
        partnerAccountId: input.actor.accountId,
        name,
        serviceKey: source.serviceKey,
        locationId: source.locationId,
        templateData: source.data as unknown as Record<string, unknown>,
        active: true,
        version: 1,
        createdByMembershipId: input.actor.membershipId,
        createOperationKeyHash: opHash,
        createRequestHash: requestHash,
      })
      .returning();
    if (!created) throw new Error("partner_template_create_failed");
    return { template: toTemplateDto(created), replayed: false };
  });
  if (!result.replayed) {
    await audit({
      principal: input.principal,
      correlationId: input.correlationId,
      action: "partner.portal.v2.service_template.created",
      entityType: "partner_service_template",
      entityId: result.template.id,
      permission: "bookings.create",
      idempotencyKeyHash: opHash,
    });
  }
  return result;
}

export async function getPartnerServiceTemplate(input: {
  actor: PartnerSchedulingActor;
  templateId: string;
}): Promise<PartnerServiceTemplateDto> {
  const [row] = await getDb()
    .select()
    .from(partnerServiceTemplates)
    .where(
      and(
        eq(partnerServiceTemplates.partnerAccountId, input.actor.accountId),
        eq(partnerServiceTemplates.id, input.templateId),
        eq(partnerServiceTemplates.active, true),
      ),
    )
    .limit(1);
  if (!row)
    throw new PartnerPortalSchedulingError(
      "not_found",
      "The template was not found.",
      { status: 404 },
    );
  if (row.locationId) await loadLocationForActor(input.actor, row.locationId);
  else if (input.actor.accessLevel !== "account")
    throw new PartnerPortalSchedulingError(
      "not_found",
      "The template was not found.",
      { status: 404 },
    );
  return toTemplateDto(row);
}

export async function applyPartnerServiceTemplate(input: {
  actor: PartnerSchedulingActor;
  templateId: string;
  idempotencyKeyHash: string;
}): Promise<{ draft: PartnerDraftDto; replayed: boolean }> {
  await requireRepeatWorkTool(input.actor.accountId, "templates");
  const template = await getPartnerServiceTemplate(input);
  return createPartnerBookingDraft({
    actor: input.actor,
    mutation: mutationFromTemplate(template),
    idempotencyKeyHash: sha256(
      "template.apply",
      input.idempotencyKeyHash,
      template.id,
    ),
  });
}

/** Rename, replace from a current draft, or archive a saved shortcut. Recurring series keep their snapshot. */
export async function updatePartnerServiceTemplate(input: {
  actor: PartnerSchedulingActor;
  templateId: string;
  name?: string;
  draftId?: string;
  active?: boolean;
  ifMatch: string | null;
  idempotencyKeyHash: string;
  correlationId: string;
}) {
  if (
    input.active !== false ||
    input.name !== undefined ||
    input.draftId !== undefined
  )
    await requireRepeatWorkTool(input.actor.accountId, "templates");
  const source = input.draftId
    ? await reusableSource({ actor: input.actor, draftId: input.draftId })
    : null;
  const name =
    input.name === undefined ? undefined : cleanText(input.name, 120);
  if (
    input.name !== undefined &&
    (!name || input.name.trim().length > 120 || name.length < 2)
  )
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "Use a template name of 2 to 120 characters.",
      { status: 422 },
    );
  const operationKey = operationHash(
    "template.update",
    input.actor.accountId,
    input.idempotencyKeyHash,
  );
  const requestHash = sha256(
    stableJson({
      id: input.templateId,
      name,
      draftId: input.draftId,
      active: input.active,
      ifMatch: input.ifMatch,
    }),
  );
  return getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${"partner_template_v2:" + input.actor.accountId}))`,
    );
    const [row] = await tx
      .select()
      .from(partnerServiceTemplates)
      .where(
        and(
          eq(partnerServiceTemplates.id, input.templateId),
          eq(partnerServiceTemplates.partnerAccountId, input.actor.accountId),
        ),
      )
      .limit(1);
    if (!row)
      throw new PartnerPortalSchedulingError(
        "not_found",
        "The template was not found.",
        { status: 404 },
      );
    if (row.locationId) await loadLocationForActor(input.actor, row.locationId);
    else if (input.actor.accessLevel !== "account")
      throw new PartnerPortalSchedulingError(
        "not_found",
        "The template was not found.",
        { status: 404 },
      );
    const [receipt] = await tx
      .select({ meta: auditLogs.meta })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "partner.portal.v2.service_template.updated"),
          eq(auditLogs.idempotencyKeyHash, operationKey),
        ),
      )
      .limit(1);
    if (receipt) {
      if (receipt.meta?.["requestHash"] !== requestHash)
        throw new PartnerPortalSchedulingError(
          "idempotency_conflict",
          "That request key was already used.",
          { status: 409 },
        );
      return {
        template: toTemplateDto(row),
        active: row.active,
        replayed: true,
      };
    }
    assertTemplateRevision({
      template: toTemplateDto(row),
      ifMatch: input.ifMatch,
      correlationId: input.correlationId,
    });
    // Restoring an archived shortcut must validate its existing name too.
    // Another active template may have claimed that name during archival.
    const effectiveName = name ?? row.name;
    if (input.active ?? row.active) {
      const [duplicate] = await tx
        .select({ id: partnerServiceTemplates.id })
        .from(partnerServiceTemplates)
        .where(
          and(
            eq(partnerServiceTemplates.partnerAccountId, input.actor.accountId),
            eq(partnerServiceTemplates.name, effectiveName),
            eq(partnerServiceTemplates.active, true),
            sql`${partnerServiceTemplates.id} <> ${row.id}`,
          ),
        )
        .limit(1);
      if (duplicate)
        throw new PartnerPortalSchedulingError(
          "conflict",
          "A template with that name already exists.",
          { status: 409 },
        );
    }
    const [updated] = await tx
      .update(partnerServiceTemplates)
      .set({
        ...(name ? { name } : {}),
        ...(source
          ? {
              serviceKey: source.serviceKey,
              locationId: source.locationId,
              templateData: { ...source.data },
            }
          : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        version: row.version + 1,
      })
      .where(eq(partnerServiceTemplates.id, row.id))
      .returning();
    if (!updated) throw new Error("partner_template_update_failed");
    await tx.insert(auditLogs).values({
      actorType: "human",
      actorId: input.actor.partnerUserId,
      sessionId: input.actor.sessionId,
      authMethod: "partner_session",
      action: "partner.portal.v2.service_template.updated",
      entityType: "partner_service_template",
      entityId: row.id,
      correlationId: input.correlationId,
      idempotencyKeyHash: operationKey,
      meta: {
        accountId: input.actor.accountId,
        requestHash,
        version: updated.version,
        archived: !updated.active,
        sourceReplaced: Boolean(source),
      },
    });
    return {
      template: toTemplateDto(updated),
      active: updated.active,
      replayed: false,
    };
  });
}

export async function createBookAgainDraft(input: {
  actor: PartnerSchedulingActor;
  jobId: string;
  idempotencyKeyHash: string;
}): Promise<{ draft: PartnerDraftDto; replayed: boolean }> {
  const source = await reusableSourceFromJob({
    actor: input.actor,
    jobId: input.jobId,
  });
  return createPartnerBookingDraft({
    actor: input.actor,
    mutation: mutationFromTemplate({
      id: input.jobId,
      name: "Book again",
      active: true,
      serviceKey: source.serviceKey,
      locationId: source.locationId,
      reusable: source.data,
      version: 1,
      updatedAt: new Date(0).toISOString(),
      etag: "",
    }),
    idempotencyKeyHash: sha256(
      "book-again",
      input.idempotencyKeyHash,
      input.jobId,
    ),
  });
}

export function parseRecurrenceInput(value: unknown): RecurrenceInput {
  if (!isRecord(value))
    throw new PartnerPortalSchedulingError(
      "invalid_body",
      "A JSON object is required.",
      { status: 400 },
    );
  const allowed = new Set([
    "templateId",
    "name",
    "frequency",
    "startsOn",
    "occurrenceCount",
    "endsOn",
    "preferredWindowStart",
  ]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown)
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "Review the recurring schedule.",
      {
        status: 422,
        fieldErrors: { [unknown]: "This field is not supported." },
      },
    );
  const templateId = cleanText(value["templateId"], 64) ?? "";
  const name = cleanText(value["name"], 120) ?? "";
  const frequency = value["frequency"];
  const startsOn = cleanText(value["startsOn"], 10) ?? "";
  const occurrenceCount = value["occurrenceCount"] ?? 0;
  const endsOn = cleanText(value["endsOn"], 10);
  const preferredWindowStart = cleanText(value["preferredWindowStart"], 5);
  const errors: Record<string, string> = {};
  if (!UUID_PATTERN.test(templateId))
    errors["templateId"] = "Choose a saved template.";
  if (name.length < 2) errors["name"] = "Use 2 to 120 characters.";
  if (
    value["endsOn"] !== undefined &&
    value["endsOn"] !== null &&
    (typeof value["endsOn"] !== "string" || value["endsOn"].length !== 10)
  )
    errors["endsOn"] = "Use YYYY-MM-DD or leave the end date blank.";
  if (!(["weekly", "biweekly", "monthly"] as unknown[]).includes(frequency))
    errors["frequency"] = "Choose weekly, every two weeks, or monthly.";
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(startsOn) ||
    !DateTime.fromISO(startsOn).isValid
  )
    errors["startsOn"] = "Choose a valid start date.";
  if (
    !Number.isSafeInteger(occurrenceCount) ||
    ((occurrenceCount as number) !== 0 && (occurrenceCount as number) < 2) ||
    (occurrenceCount as number) > MAX_OCCURRENCES
  )
    errors["occurrenceCount"] = `Choose 2 to ${MAX_OCCURRENCES} occurrences.`;
  if (
    endsOn &&
    (!/^\d{4}-\d{2}-\d{2}$/u.test(endsOn) ||
      !DateTime.fromISO(endsOn).isValid ||
      endsOn < startsOn)
  )
    errors["endsOn"] = "Choose an end date on or after the first service date.";
  if (endsOn && occurrenceCount !== 0)
    errors["endsOn"] = "Choose an end date or an occurrence count, not both.";
  if (
    preferredWindowStart &&
    !/^([01]\d|2[0-3]):(00|30)$/u.test(preferredWindowStart)
  )
    errors["preferredWindowStart"] =
      "Use a 30-minute time such as 08:00 or 13:30.";
  if (Object.keys(errors).length)
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "Review the recurring schedule.",
      { status: 422, fieldErrors: errors },
    );
  return Object.freeze({
    templateId,
    name,
    frequency: frequency as RecurrenceInput["frequency"],
    startsOn,
    occurrenceCount: occurrenceCount as number,
    endsOn,
    preferredWindowStart,
  });
}

export function parseRecurringSeriesLifecycleMutation(
  value: unknown,
): RecurringSeriesLifecycleMutation {
  if (!isRecord(value)) {
    throw new PartnerPortalSchedulingError(
      "invalid_body",
      "A JSON object is required.",
      { status: 400 },
    );
  }
  const allowed = new Set(["action", "reason"]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "Review the recurring schedule change.",
      {
        status: 422,
        fieldErrors: { [unknown]: "This field is not supported." },
      },
    );
  }
  const action = value["action"];
  const rawReason = value["reason"];
  const reason =
    typeof rawReason === "string"
      ? rawReason.trim().replaceAll(String.fromCharCode(0), "")
      : "";
  const errors: Record<string, string> = {};
  if (!(action === "pause" || action === "resume" || action === "cancel")) {
    errors["action"] = "Choose pause, resume, or cancel.";
  }
  if (reason.length < 2 || reason.length > 300) {
    errors["reason"] = "Use 2 to 300 characters.";
  }
  if (Object.keys(errors).length) {
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "Review the recurring schedule change.",
      { status: 422, fieldErrors: errors },
    );
  }
  return Object.freeze({
    action: action as RecurringSeriesLifecycleAction,
    reason,
  });
}

export function recurringOccurrenceLifecycleTransition(input: {
  action: RecurringSeriesLifecycleAction;
  localDate: string;
  tomorrow: string;
  state: string;
  failureCode: string | null;
  bookingDraftId: string | null;
  partnerBookingId: string | null;
}): "tentative" | "skipped" | "canceled" | null {
  if (input.localDate < input.tomorrow || input.partnerBookingId) {
    return null;
  }
  if (input.action === "pause") {
    return ["tentative", "evaluating"].includes(input.state) ? "skipped" : null;
  }
  if (input.action === "resume") {
    return input.state === "skipped" && input.failureCode === "series_paused"
      ? "tentative"
      : null;
  }
  return ["tentative", "evaluating"].includes(input.state) ||
    (input.state === "skipped" && input.failureCode === "series_paused")
    ? "canceled"
    : null;
}

export function recurrenceDates(
  input: RecurrenceInput,
  timezone: string,
  throughDate?: string,
  fromDate?: string,
): readonly string[] {
  const start = DateTime.fromISO(input.startsOn, { zone: timezone }).startOf(
    "day",
  );
  if (!start.isValid)
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "Choose a valid start date.",
      { status: 422 },
    );
  const dates: string[] = [];
  const rolling = input.occurrenceCount === 0;
  const through = throughDate ?? start.plus({ days: 90 }).toISODate();
  const lower = fromDate
    ? DateTime.fromISO(fromDate, { zone: timezone })
    : start;
  const firstIndex = !rolling
    ? 0
    : Math.max(
        0,
        Math.floor(
          lower
            .diff(start, input.frequency === "monthly" ? "months" : "weeks")
            .get(input.frequency === "monthly" ? "months" : "weeks") /
            (input.frequency === "biweekly" ? 2 : 1),
        ) - 1,
      );
  for (
    let index = firstIndex;
    index < (rolling ? firstIndex + 100 : input.occurrenceCount);
    index += 1
  ) {
    const date =
      input.frequency === "monthly"
        ? start.plus({ months: index })
        : start.plus({
            weeks: index * (input.frequency === "biweekly" ? 2 : 1),
          });
    const iso = date.toISODate();
    if (!iso) throw new Error("partner_recurring_date_failed");
    if (rolling && (iso > through || (input.endsOn && iso > input.endsOn)))
      break;
    if (fromDate && iso < fromDate) continue;
    dates.push(iso);
  }
  return Object.freeze(dates);
}

async function updateOccurrence(input: {
  actor: PartnerSchedulingActor;
  occurrenceId: string;
  state: "tentative" | "confirmed" | "review" | "failed";
  bookingDraftId?: string | null;
  partnerBookingId?: string | null;
  failureCode?: string | null;
  evaluation?: Record<string, unknown>;
  evaluatedAt?: Date | null;
}): Promise<void> {
  await getDb()
    .update(partnerRecurringOccurrences)
    .set({
      state: input.state,
      bookingDraftId: input.bookingDraftId,
      partnerBookingId: input.partnerBookingId,
      failureCode: input.failureCode,
      evaluation: input.evaluation ?? {},
      evaluatedAt: input.evaluatedAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(partnerRecurringOccurrences.partnerAccountId, input.actor.accountId),
        eq(partnerRecurringOccurrences.id, input.occurrenceId),
        input.partnerBookingId
          ? or(
              eq(partnerRecurringOccurrences.state, "evaluating"),
              eq(
                partnerRecurringOccurrences.partnerBookingId,
                input.partnerBookingId,
              ),
            )
          : eq(partnerRecurringOccurrences.state, "evaluating"),
      ),
    );
}

async function evaluateRecurringOccurrence(input: {
  actor: PartnerSchedulingActor;
  template: PartnerServiceTemplateDto;
  occurrence: typeof partnerRecurringOccurrences.$inferSelect;
  timezone: string;
  preferredWindowStart: string | null;
  correlationId: string;
  now: Date;
}): Promise<void> {
  const recurringSource = {
    seriesId: input.occurrence.recurringSeriesId,
    occurrenceId: input.occurrence.id,
  };
  const day = DateTime.fromISO(input.occurrence.localDate, {
    zone: input.timezone,
  }).startOf("day");
  let bookingDraftId: string | null = null;
  const submitForReview = async (
    draft: PartnerDraftDto,
    reason: string,
  ): Promise<void> => {
    const submitted = await submitPartnerBookingDraft({
      actor: input.actor,
      recurringSource,
      draftId: draft.id,
      holdId: null,
      ifMatch: draft.etag,
      idempotencyKeyHash: sha256("recurring-review", input.occurrence.id),
      correlationId: input.correlationId,
      now: input.now,
    });
    await updateOccurrence({
      actor: input.actor,
      occurrenceId: input.occurrence.id,
      state: "review",
      bookingDraftId: draft.id,
      partnerBookingId: submitted.booking.id,
      failureCode: reason,
      evaluation: {
        reservationCreated: false,
        publicStatus: submitted.booking.publicStatus,
      },
      evaluatedAt: input.now,
    });
  };
  try {
    const location = input.template.locationId
      ? await loadLocationForActor(input.actor, input.template.locationId)
      : null;
    const created = await createPartnerBookingDraft({
      actor: input.actor,
      recurringSource,
      mutation: {
        ...mutationFromTemplate(input.template),
        onSiteContact: input.template.reusable.onSiteContact ??
          location?.onSiteContact ?? {
            name: "Account contact",
            email: input.actor.email,
          },
        preferredWindows: [
          {
            localDate: input.occurrence.localDate,
            timeOfDay: input.preferredWindowStart
              ? Number(input.preferredWindowStart.slice(0, 2)) < 12
                ? "morning"
                : "afternoon"
              : "anytime",
            timezone: input.timezone,
          },
        ],
      },
      idempotencyKeyHash: sha256("recurring-draft", input.occurrence.id),
      now: input.now,
    });
    bookingDraftId = created.draft.id;
    const [existingBooking] = await getDb()
      .select({
        id: partnerBookings.id,
        publicStatus: partnerBookings.publicStatus,
        confirmationMode: partnerBookings.confirmationMode,
        arrivalWindowStartAt: partnerBookings.arrivalWindowStartAt,
        arrivalWindowEndAt: partnerBookings.arrivalWindowEndAt,
      })
      .from(partnerBookings)
      .where(
        and(
          eq(partnerBookings.partnerAccountId, input.actor.accountId),
          eq(partnerBookings.bookingDraftId, created.draft.id),
        ),
      )
      .limit(1);
    if (existingBooking) {
      const confirmed = existingBooking.publicStatus === "confirmed";
      await updateOccurrence({
        actor: input.actor,
        occurrenceId: input.occurrence.id,
        state: confirmed ? "confirmed" : "review",
        bookingDraftId: created.draft.id,
        partnerBookingId: existingBooking.id,
        failureCode: confirmed ? null : "stonegate_review_required",
        evaluation: {
          publicStatus: existingBooking.publicStatus,
          confirmationMode: existingBooking.confirmationMode,
          arrivalWindowStartAt:
            existingBooking.arrivalWindowStartAt?.toISOString() ?? null,
          arrivalWindowEndAt:
            existingBooking.arrivalWindowEndAt?.toISOString() ?? null,
          reservationCreated: confirmed,
          reconciledFromIdempotentSubmission: true,
        },
        evaluatedAt: input.now,
      });
      return;
    }
    const availability = await getPartnerDraftAvailability({
      actor: input.actor,
      draftId: created.draft.id,
      rangeStartAt: day.toUTC().toJSDate(),
      rangeEndAt: day.plus({ days: 1 }).toUTC().toJSDate(),
      now: input.now,
    });
    const availableWindows = availability.windows.filter(
      (window) =>
        window.localDate === input.occurrence.localDate && window.available,
    );
    if (
      !input.preferredWindowStart ||
      !availability.instantConfirmationEligible
    ) {
      await submitForReview(
        created.draft,
        !input.preferredWindowStart
          ? "arrival_window_selection_required"
          : "stonegate_review_required",
      );
      return;
    }
    const window = availableWindows.find(
      (candidate) =>
        DateTime.fromISO(candidate.startAt)
          .setZone(input.timezone)
          .toFormat("HH:mm") === input.preferredWindowStart,
    );
    if (!window) {
      await submitForReview(created.draft, "preferred_window_unavailable");
      return;
    }
    const hold = await createOrReplacePartnerHold({
      actor: input.actor,
      recurringSource,
      draftId: created.draft.id,
      windowId: window.id,
      idempotencyKeyHash: sha256("recurring-hold", input.occurrence.id),
      ifMatch: created.draft.etag,
      correlationId: input.correlationId,
      now: input.now,
    });
    const submitted = await submitPartnerBookingDraft({
      actor: input.actor,
      recurringSource,
      draftId: created.draft.id,
      holdId: hold.hold.id,
      idempotencyKeyHash: sha256("recurring-submit", input.occurrence.id),
      ifMatch: created.draft.etag,
      correlationId: input.correlationId,
      now: input.now,
    });
    await updateOccurrence({
      actor: input.actor,
      occurrenceId: input.occurrence.id,
      state:
        submitted.booking.publicStatus === "confirmed" ? "confirmed" : "review",
      bookingDraftId: created.draft.id,
      partnerBookingId: submitted.booking.id,
      failureCode:
        submitted.booking.publicStatus === "confirmed"
          ? null
          : "stonegate_review_required",
      evaluation: {
        publicStatus: submitted.booking.publicStatus,
        confirmationMode: submitted.booking.confirmationMode,
        arrivalWindowStartAt: submitted.booking.arrivalWindowStartAt,
        arrivalWindowEndAt: submitted.booking.arrivalWindowEndAt,
        reservationCreated: submitted.booking.publicStatus === "confirmed",
      },
      evaluatedAt: input.now,
    });
  } catch (error) {
    const expectedReview = error instanceof PartnerPortalSchedulingError;
    if (
      expectedReview &&
      bookingDraftId &&
      [409, 410, 422, 503].includes(error.status)
    ) {
      try {
        const draft = await getPartnerBookingDraft({
          actor: input.actor,
          draftId: bookingDraftId,
        });
        await submitForReview(draft, error.code);
        return;
      } catch {
        /* Invalid scope or revoked access stays in the staff action queue. */
      }
    }
    await updateOccurrence({
      actor: input.actor,
      occurrenceId: input.occurrence.id,
      state: expectedReview ? "review" : "failed",
      bookingDraftId,
      failureCode: expectedReview ? error.code : "evaluation_failed",
      evaluation: { reservationCreated: false },
      evaluatedAt: input.now,
    });
  }
}

type RecurringOccurrenceActionContext = Readonly<{
  id: string;
  partnerAccountId: string;
  recurringSeriesId: string;
  localDate: string;
  state: string;
  bookingDraftId: string | null;
  partnerBookingId: string | null;
  failureCode: string | null;
  evaluation: Readonly<Record<string, unknown>>;
  evaluatedAt: Date | null;
}>;

async function ensureRecurringStaffAction(input: {
  series: typeof partnerRecurringSeries.$inferSelect;
  occurrence: RecurringOccurrenceActionContext;
  now: Date;
}): Promise<{ taskId: string | null; created: boolean }> {
  if (!["review", "failed"].includes(input.occurrence.state)) {
    return { taskId: null, created: false };
  }
  const title = `Partner recurring work requires action · ${input.occurrence.localDate} · ${input.occurrence.id}`;
  const result = await getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`partner_recurring_staff_action:${input.occurrence.id}`}))`,
    );
    const [existing] = await tx
      .select({ id: crmTasks.id })
      .from(crmTasks)
      .where(
        and(
          eq(crmTasks.partnerAccountId, input.occurrence.partnerAccountId),
          eq(crmTasks.title, title),
        ),
      )
      .limit(1);
    if (existing) return { taskId: existing.id, created: false };
    const [account] = await tx
      .select({ portalContactId: partnerAccounts.portalContactId })
      .from(partnerAccounts)
      .where(eq(partnerAccounts.id, input.occurrence.partnerAccountId))
      .limit(1);
    if (!account?.portalContactId) {
      return { taskId: null, created: false };
    }
    const [created] = await tx
      .insert(crmTasks)
      .values({
        contactId: account.portalContactId,
        partnerAccountId: input.occurrence.partnerAccountId,
        title,
        dueAt: input.now,
        status: "open",
        notes: [
          "[partner-recurring-work]",
          `kind=partner_recurring_action`,
          `partnerRecurringSeriesId=${input.series.id}`,
          `partnerRecurringOccurrenceId=${input.occurrence.id}`,
          `localDate=${input.occurrence.localDate}`,
          `state=${input.occurrence.state}`,
          `reason=${input.occurrence.failureCode ?? "review_required"}`,
          ...(input.occurrence.bookingDraftId
            ? [`partnerBookingDraftId=${input.occurrence.bookingDraftId}`]
            : []),
          ...(input.occurrence.partnerBookingId
            ? [`partnerBookingId=${input.occurrence.partnerBookingId}`]
            : []),
        ].join("\n"),
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning({ id: crmTasks.id });
    return { taskId: created?.id ?? null, created: Boolean(created?.id) };
  });
  if (result.created) {
    await recordAuditEvent({
      actor: { type: "worker", label: "partner-recurring-horizon" },
      action: "partner.recurring.staff_action_created",
      entityType: "partner_recurring_occurrence",
      entityId: input.occurrence.id,
      surface: "partner_recurring_horizon_worker",
      meta: {
        partnerAccountId: input.occurrence.partnerAccountId,
        partnerRecurringSeriesId: input.series.id,
        taskId: result.taskId,
        state: input.occurrence.state,
        reason: input.occurrence.failureCode,
      },
    });
  }
  return result;
}

async function loadRecurringOccurrenceActionContext(input: {
  accountId: string;
  occurrenceId: string;
}): Promise<RecurringOccurrenceActionContext | null> {
  const [row] = await getDb()
    .select({
      id: partnerRecurringOccurrences.id,
      partnerAccountId: partnerRecurringOccurrences.partnerAccountId,
      recurringSeriesId: partnerRecurringOccurrences.recurringSeriesId,
      localDate: partnerRecurringOccurrences.localDate,
      state: partnerRecurringOccurrences.state,
      bookingDraftId: partnerRecurringOccurrences.bookingDraftId,
      partnerBookingId: partnerRecurringOccurrences.partnerBookingId,
      failureCode: partnerRecurringOccurrences.failureCode,
      evaluation: partnerRecurringOccurrences.evaluation,
      evaluatedAt: partnerRecurringOccurrences.evaluatedAt,
    })
    .from(partnerRecurringOccurrences)
    .where(
      and(
        eq(partnerRecurringOccurrences.partnerAccountId, input.accountId),
        eq(partnerRecurringOccurrences.id, input.occurrenceId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function recordRecurringOccurrenceMaintenanceFailure(input: {
  accountId: string;
  seriesId: string;
  occurrenceId: string;
  state: "review" | "failed";
  reason: string;
  now?: Date;
}): Promise<{ taskId: string | null; created: boolean }> {
  const now = input.now ?? new Date();
  const [series] = await getDb()
    .select()
    .from(partnerRecurringSeries)
    .where(
      and(
        eq(partnerRecurringSeries.partnerAccountId, input.accountId),
        eq(partnerRecurringSeries.id, input.seriesId),
      ),
    )
    .limit(1);
  if (!series) return { taskId: null, created: false };
  await getDb()
    .update(partnerRecurringOccurrences)
    .set({
      state: input.state,
      failureCode: input.reason.slice(0, 120),
      evaluation: { reservationCreated: false },
      evaluatedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(partnerRecurringOccurrences.partnerAccountId, input.accountId),
        eq(partnerRecurringOccurrences.recurringSeriesId, input.seriesId),
        eq(partnerRecurringOccurrences.id, input.occurrenceId),
        eq(partnerRecurringOccurrences.state, "evaluating"),
        isNull(partnerRecurringOccurrences.partnerBookingId),
      ),
    );
  const occurrence = await loadRecurringOccurrenceActionContext({
    accountId: input.accountId,
    occurrenceId: input.occurrenceId,
  });
  return occurrence
    ? ensureRecurringStaffAction({ series, occurrence, now })
    : { taskId: null, created: false };
}

export async function evaluateClaimedPartnerRecurringOccurrence(input: {
  actor: PartnerSchedulingActor;
  seriesId: string;
  occurrenceId: string;
  correlationId: string;
  now?: Date;
}): Promise<{
  state: string;
  taskCreated: boolean;
  outsideHorizon: boolean;
}> {
  const now = input.now ?? new Date();
  const [series] = await getDb()
    .select()
    .from(partnerRecurringSeries)
    .where(
      and(
        eq(partnerRecurringSeries.partnerAccountId, input.actor.accountId),
        eq(partnerRecurringSeries.id, input.seriesId),
        eq(partnerRecurringSeries.state, "active"),
      ),
    )
    .limit(1);
  if (!series) {
    throw new Error("partner_recurring_series_unavailable");
  }
  const [occurrence] = await getDb()
    .select()
    .from(partnerRecurringOccurrences)
    .where(
      and(
        eq(partnerRecurringOccurrences.partnerAccountId, input.actor.accountId),
        eq(partnerRecurringOccurrences.recurringSeriesId, series.id),
        eq(partnerRecurringOccurrences.id, input.occurrenceId),
      ),
    )
    .limit(1);
  if (!occurrence) throw new Error("partner_recurring_occurrence_unavailable");

  const localToday = DateTime.fromJSDate(now, {
    zone: series.timezone,
  }).startOf("day");
  const localDay = DateTime.fromISO(occurrence.localDate, {
    zone: series.timezone,
  }).startOf("day");
  const horizonEnd = localToday.plus({
    days: RECURRING_CONFIRMATION_HORIZON_DAYS,
  });
  if (localDay > horizonEnd) {
    await getDb()
      .update(partnerRecurringOccurrences)
      .set({
        state: "tentative",
        evaluatedAt: null,
        failureCode: null,
        evaluation: { reservationCreated: false },
        updatedAt: now,
      })
      .where(
        and(
          eq(
            partnerRecurringOccurrences.partnerAccountId,
            input.actor.accountId,
          ),
          eq(partnerRecurringOccurrences.id, occurrence.id),
          eq(partnerRecurringOccurrences.state, "evaluating"),
        ),
      );
    return { state: "tentative", taskCreated: false, outsideHorizon: true };
  }
  if (localDay < localToday.plus({ days: 1 })) {
    const task = await recordRecurringOccurrenceMaintenanceFailure({
      accountId: input.actor.accountId,
      seriesId: series.id,
      occurrenceId: occurrence.id,
      state: "review",
      reason: "occurrence_date_elapsed",
      now,
    });
    return {
      state: "review",
      taskCreated: task.created,
      outsideHorizon: false,
    };
  }

  try {
    if (!series.templateId) {
      throw new PartnerPortalSchedulingError(
        "invalid_fields",
        "The recurring series no longer has a reusable template.",
        { status: 422 },
      );
    }
    const template =
      isRecord(series.templateSnapshot) &&
      isRecord(series.templateSnapshot["reusable"])
        ? (series.templateSnapshot as unknown as PartnerServiceTemplateDto)
        : await getPartnerServiceTemplate({
            actor: input.actor,
            templateId: series.templateId,
          });
    await evaluateRecurringOccurrence({
      actor: input.actor,
      template,
      occurrence,
      timezone: series.timezone,
      preferredWindowStart: series.preferredWindowStart,
      correlationId: input.correlationId,
      now,
    });
  } catch (error) {
    await recordRecurringOccurrenceMaintenanceFailure({
      accountId: input.actor.accountId,
      seriesId: series.id,
      occurrenceId: occurrence.id,
      state:
        error instanceof PartnerPortalSchedulingError ? "review" : "failed",
      reason:
        error instanceof PartnerPortalSchedulingError
          ? error.code
          : "evaluation_failed",
      now,
    });
  }

  const refreshed = await loadRecurringOccurrenceActionContext({
    accountId: input.actor.accountId,
    occurrenceId: occurrence.id,
  });
  if (!refreshed)
    throw new Error("partner_recurring_occurrence_refresh_failed");
  const task = await ensureRecurringStaffAction({
    series,
    occurrence: refreshed,
    now,
  });
  return {
    state: refreshed.state,
    taskCreated: task.created,
    outsideHorizon: false,
  };
}

type RecurringOccurrenceRead =
  typeof partnerRecurringOccurrences.$inferSelect & {
    currentJobStatus: string | null;
  };

function recurringDto(
  series: typeof partnerRecurringSeries.$inferSelect,
  occurrences: readonly RecurringOccurrenceRead[],
  lifecycle: PartnerRecurringSeriesLifecycle | null = null,
): PartnerRecurringSeriesDto {
  let recurrence: unknown = {};
  try {
    recurrence = JSON.parse(series.recurrenceRule) as unknown;
  } catch {
    recurrence = {};
  }
  return Object.freeze({
    id: series.id,
    name: series.name,
    templateId: series.templateId,
    recurrence,
    timezone: series.timezone,
    startsOn: series.startsOn,
    endsOn: series.endsOn,
    preferredWindowStart: series.preferredWindowStart,
    state: series.state,
    revision: series.revision,
    etag: createPortalV2StrongEtag(
      `partner-recurring-series:${series.id}:${series.revision}`,
    ),
    lifecycle,
    occurrences: Object.freeze(
      occurrences.map((occurrence) =>
        Object.freeze({
          id: occurrence.id,
          localDate: occurrence.localDate,
          state: occurrence.state,
          draftId: occurrence.bookingDraftId,
          jobId: occurrence.partnerBookingId,
          currentJobStatus: occurrence.currentJobStatus,
          reason: occurrence.failureCode,
          evaluation: Object.freeze({ ...occurrence.evaluation }),
          evaluatedAt: occurrence.evaluatedAt?.toISOString() ?? null,
        }),
      ),
    ),
  });
}

async function loadRecurringSeriesForActor(
  db: RepeatWorkDatabase,
  actor: PartnerSchedulingActor,
  seriesId: string,
): Promise<typeof partnerRecurringSeries.$inferSelect | null> {
  if (!UUID_PATTERN.test(seriesId)) return null;
  if (actor.accessLevel === "account") {
    const [series] = await db
      .select()
      .from(partnerRecurringSeries)
      .where(
        and(
          eq(partnerRecurringSeries.partnerAccountId, actor.accountId),
          eq(partnerRecurringSeries.id, seriesId),
        ),
      )
      .limit(1);
    return series ?? null;
  }

  const grants: SQL[] = [];
  if (actor.locationIds.length > 0) {
    grants.push(
      inArray(partnerRecurringSeries.locationId, [...actor.locationIds]),
    );
  }
  if (actor.propertyIds.length > 0) {
    grants.push(
      inArray(partnerAccountLocations.propertyId, [...actor.propertyIds]),
    );
  }
  if (grants.length === 0) return null;
  const [row] = await db
    .select({ series: partnerRecurringSeries })
    .from(partnerRecurringSeries)
    .innerJoin(
      partnerServiceTemplates,
      and(
        eq(partnerRecurringSeries.templateId, partnerServiceTemplates.id),
        eq(
          partnerRecurringSeries.partnerAccountId,
          partnerServiceTemplates.partnerAccountId,
        ),
      ),
    )
    .leftJoin(
      partnerAccountLocations,
      and(
        eq(partnerAccountLocations.id, partnerRecurringSeries.locationId),
        eq(
          partnerAccountLocations.partnerAccountId,
          partnerRecurringSeries.partnerAccountId,
        ),
      ),
    )
    .where(
      and(
        eq(partnerRecurringSeries.partnerAccountId, actor.accountId),
        eq(partnerRecurringSeries.id, seriesId),
        or(...grants) ?? sql`false`,
      ),
    )
    .limit(1);
  return row?.series ?? null;
}

async function loadRecurringOccurrences(
  db: RepeatWorkDatabase,
  accountId: string,
  seriesId: string,
): Promise<readonly RecurringOccurrenceRead[]> {
  const rows = await db
    .select({
      occurrence: partnerRecurringOccurrences,
      currentJobStatus: partnerBookings.publicStatus,
    })
    .from(partnerRecurringOccurrences)
    .leftJoin(
      partnerBookings,
      and(
        eq(partnerBookings.id, partnerRecurringOccurrences.partnerBookingId),
        eq(
          partnerBookings.partnerAccountId,
          partnerRecurringOccurrences.partnerAccountId,
        ),
      ),
    )
    .where(
      and(
        eq(partnerRecurringOccurrences.partnerAccountId, accountId),
        eq(partnerRecurringOccurrences.recurringSeriesId, seriesId),
        sql`${partnerRecurringOccurrences.localDate} >= (current_date - 30)`,
      ),
    )
    .orderBy(asc(partnerRecurringOccurrences.localDate))
    .limit(100);
  // Keep the evaluator's immutable submission outcome separate from the linked
  // job's current public status; staff review/approval can change it later.
  return rows.map(({ occurrence, currentJobStatus }) => ({
    ...occurrence,
    currentJobStatus,
  }));
}

function lifecycleFromAuditRow(
  row: Pick<typeof auditLogs.$inferSelect, "meta" | "createdAt"> | undefined,
): PartnerRecurringSeriesLifecycle | null {
  if (!row || !isRecord(row.meta)) return null;
  const action = row.meta["lifecycleAction"];
  const reason = row.meta["changeReason"];
  const changedAt = row.meta["lifecycleChangedAt"];
  if (
    !(action === "pause" || action === "resume" || action === "cancel") ||
    typeof reason !== "string"
  ) {
    return null;
  }
  return Object.freeze({
    action,
    reason,
    changedAt:
      typeof changedAt === "string" ? changedAt : row.createdAt.toISOString(),
  });
}

async function loadRecurringLifecycle(
  db: RepeatWorkDatabase,
  seriesId: string,
): Promise<PartnerRecurringSeriesLifecycle | null> {
  const [row] = await db
    .select({ meta: auditLogs.meta, createdAt: auditLogs.createdAt })
    .from(auditLogs)
    .where(
      and(
        eq(
          auditLogs.action,
          "partner.portal.v2.recurring_series.lifecycle_changed",
        ),
        eq(auditLogs.entityType, "partner_recurring_series"),
        eq(auditLogs.entityId, seriesId),
      ),
    )
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(1);
  return lifecycleFromAuditRow(row);
}

export async function getPartnerRecurringSeries(input: {
  actor: PartnerSchedulingActor;
  seriesId: string;
}): Promise<PartnerRecurringSeriesDto | null> {
  const db = getDb();
  const series = await loadRecurringSeriesForActor(
    db,
    input.actor,
    input.seriesId,
  );
  if (!series) return null;
  const [occurrences, lifecycle] = await Promise.all([
    loadRecurringOccurrences(db, input.actor.accountId, series.id),
    loadRecurringLifecycle(db, series.id),
  ]);
  return recurringDto(series, occurrences, lifecycle);
}

function recurringLifecycleRevision(
  series: Pick<typeof partnerRecurringSeries.$inferSelect, "id" | "revision">,
): string {
  return `partner-recurring-series:${series.id}:${series.revision}`;
}

function recurringLifecycleTargetState(
  current: string,
  action: RecurringSeriesLifecycleAction,
): "active" | "paused" | "canceled" | null {
  if (action === "pause") return current === "active" ? "paused" : null;
  if (action === "resume") return current === "paused" ? "active" : null;
  return current === "active" || current === "paused" ? "canceled" : null;
}

function lifecycleReceiptPayload(
  value: Record<string, unknown> | null,
): Omit<PartnerRecurringSeriesLifecycleResult, "replayed"> | null {
  if (!isRecord(value)) return null;
  const series = value["series"];
  const transition = value["transition"];
  if (!isRecord(series) || !isRecord(transition)) return null;
  if (
    typeof series["id"] !== "string" ||
    typeof series["etag"] !== "string" ||
    !Array.isArray(series["occurrences"]) ||
    !(
      transition["action"] === "pause" ||
      transition["action"] === "resume" ||
      transition["action"] === "cancel"
    ) ||
    typeof transition["reason"] !== "string" ||
    typeof transition["changedAt"] !== "string" ||
    typeof transition["changedOccurrences"] !== "number" ||
    typeof transition["preservedOccurrences"] !== "number"
  ) {
    return null;
  }
  return value as unknown as Omit<
    PartnerRecurringSeriesLifecycleResult,
    "replayed"
  >;
}

export async function mutatePartnerRecurringSeriesLifecycle(input: {
  actor: PartnerSchedulingActor;
  principal: PartnerPrincipal;
  seriesId: string;
  mutation: RecurringSeriesLifecycleMutation;
  idempotencyKeyHash: string;
  ifMatch: string | null | undefined;
  correlationId: string;
  now?: Date;
}): Promise<PartnerRecurringSeriesLifecycleResult> {
  if (input.mutation.action === "resume")
    await requireRepeatWorkTool(input.actor.accountId, "recurring");
  if (!UUID_PATTERN.test(input.seriesId)) {
    throw new PartnerPortalSchedulingError(
      "not_found",
      "The recurring schedule was not found.",
      { status: 404 },
    );
  }
  const now = input.now ?? new Date();
  const changedAt = now.toISOString();
  const principalHash = sha256(
    "partner-portal-v2-recurring-lifecycle",
    input.actor.partnerUserId,
  );
  const scopeHash = sha256(
    "partner-recurring-series-lifecycle",
    input.actor.accountId,
    input.seriesId,
  );
  const requestHash = sha256(stableJson(input.mutation));

  return getDb().transaction(async (tx) => {
    // Keep this order aligned with the horizon worker and every schedule write:
    // claim coordination, global schedule coordination, then the series lock.
    await acquirePartnerRecurringHorizonClaimLock(tx);
    await acquireScheduleConflictLock(tx);
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`partner_recurring_series_lifecycle_v1:${input.actor.accountId}:${input.seriesId}`}))`,
    );

    const series = await loadRecurringSeriesForActor(
      tx,
      input.actor,
      input.seriesId,
    );
    if (!series) {
      throw new PartnerPortalSchedulingError(
        "not_found",
        "The recurring schedule was not found.",
        { status: 404 },
      );
    }

    const [receipt] = await tx
      .select()
      .from(teamMutationIdempotency)
      .where(
        and(
          eq(teamMutationIdempotency.principalHash, principalHash),
          eq(
            teamMutationIdempotency.action,
            RECURRING_LIFECYCLE_RECEIPT_ACTION,
          ),
          eq(teamMutationIdempotency.keyHash, input.idempotencyKeyHash),
        ),
      )
      .limit(1);
    if (receipt) {
      if (
        receipt.scopeHash !== scopeHash ||
        receipt.requestHash !== requestHash
      ) {
        throw new PartnerPortalSchedulingError(
          "idempotency_conflict",
          "That request key was already used for a different change.",
          { status: 409 },
        );
      }
      const replay = lifecycleReceiptPayload(receipt.responseBody);
      if (receipt.status !== "succeeded" || !replay) {
        throw new PartnerPortalSchedulingError(
          "conflict",
          "That schedule change is still being reconciled. Refresh before retrying.",
          { status: 409, retryable: true },
        );
      }
      return Object.freeze({ ...replay, replayed: true });
    }

    const precondition = evaluatePortalV2RevisionPrecondition({
      ifMatch: input.ifMatch,
      currentRevision: recurringLifecycleRevision(series),
      correlationId: input.correlationId,
    });
    if (!precondition.ok) {
      throw new PartnerPortalSchedulingError(
        precondition.response.body.error,
        precondition.response.body.message,
        {
          status: precondition.response.status,
          additionalHeaders: precondition.response.headers,
        },
      );
    }

    const nextSeriesState = recurringLifecycleTargetState(
      series.state,
      input.mutation.action,
    );
    if (!nextSeriesState) {
      throw new PartnerPortalSchedulingError(
        "conflict",
        series.state === "completed" || series.state === "canceled"
          ? "This recurring schedule is complete and cannot be changed."
          : `This recurring schedule is already ${series.state}.`,
        { status: 409 },
      );
    }

    const occurrences = await loadRecurringOccurrences(
      tx,
      input.actor.accountId,
      series.id,
    );
    const tomorrow = DateTime.fromJSDate(now, { zone: series.timezone })
      .startOf("day")
      .plus({ days: 1 })
      .toISODate();
    if (!tomorrow) {
      throw new PartnerPortalSchedulingError(
        "conflict",
        "This recurring schedule needs staff review before it can be changed.",
        { status: 409 },
      );
    }
    const planned = occurrences.filter(
      (occurrence) =>
        recurringOccurrenceLifecycleTransition({
          action: input.mutation.action,
          localDate: occurrence.localDate,
          tomorrow,
          state: occurrence.state,
          failureCode: occurrence.failureCode,
          bookingDraftId: occurrence.bookingDraftId,
          partnerBookingId: occurrence.partnerBookingId,
        }) !== null,
    );

    if (planned.length > 0) {
      const targetOccurrenceState =
        input.mutation.action === "pause"
          ? "skipped"
          : input.mutation.action === "resume"
            ? "tentative"
            : "canceled";
      const priorStateCondition =
        input.mutation.action === "pause"
          ? inArray(partnerRecurringOccurrences.state, [
              "tentative",
              "evaluating",
            ])
          : input.mutation.action === "resume"
            ? and(
                eq(partnerRecurringOccurrences.state, "skipped"),
                eq(partnerRecurringOccurrences.failureCode, "series_paused"),
              )
            : or(
                inArray(partnerRecurringOccurrences.state, [
                  "tentative",
                  "evaluating",
                ]),
                and(
                  eq(partnerRecurringOccurrences.state, "skipped"),
                  eq(partnerRecurringOccurrences.failureCode, "series_paused"),
                ),
              );
      const changed = await tx
        .update(partnerRecurringOccurrences)
        .set({
          state: targetOccurrenceState,
          failureCode:
            input.mutation.action === "resume"
              ? null
              : input.mutation.action === "pause"
                ? "series_paused"
                : "series_canceled",
          evaluation:
            input.mutation.action === "resume"
              ? {
                  reservationCreated: false,
                  restoredAt: changedAt,
                  lifecycleState: "active",
                }
              : {
                  reservationCreated: false,
                  lifecycleChangedAt: changedAt,
                  lifecycleState: nextSeriesState,
                },
          evaluatedAt: input.mutation.action === "resume" ? null : now,
          updatedAt: now,
        })
        .where(
          and(
            eq(
              partnerRecurringOccurrences.partnerAccountId,
              input.actor.accountId,
            ),
            eq(partnerRecurringOccurrences.recurringSeriesId, series.id),
            inArray(
              partnerRecurringOccurrences.id,
              planned.map((occurrence) => occurrence.id),
            ),
            gte(partnerRecurringOccurrences.localDate, tomorrow),
            isNull(partnerRecurringOccurrences.partnerBookingId),
            priorStateCondition,
          ),
        )
        .returning({ id: partnerRecurringOccurrences.id });
      if (changed.length !== planned.length) {
        throw new PartnerPortalSchedulingError(
          "conflict",
          "An occurrence changed while this request was processed. Refresh and try again.",
          { status: 409, retryable: true },
        );
      }
      if (input.mutation.action !== "resume") {
        const draftIds = planned.flatMap((occurrence) =>
          occurrence.bookingDraftId ? [occurrence.bookingDraftId] : [],
        );
        if (draftIds.length)
          await tx
            .update(appointmentHolds)
            .set({ status: "released", updatedAt: now })
            .where(
              and(
                eq(appointmentHolds.partnerAccountId, input.actor.accountId),
                inArray(appointmentHolds.partnerBookingDraftId, draftIds),
                eq(appointmentHolds.status, "active"),
              ),
            );
      }
    }

    const [updatedSeries] = await tx
      .update(partnerRecurringSeries)
      .set({
        state: nextSeriesState,
        revision: series.revision + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(partnerRecurringSeries.partnerAccountId, input.actor.accountId),
          eq(partnerRecurringSeries.id, series.id),
          eq(partnerRecurringSeries.revision, series.revision),
          eq(partnerRecurringSeries.state, series.state),
        ),
      )
      .returning();
    if (!updatedSeries) {
      throw new PartnerPortalSchedulingError(
        "revision_mismatch",
        "The recurring schedule changed. Refresh and review the latest version.",
        {
          status: 412,
          additionalHeaders: { ETag: precondition.currentEtag },
        },
      );
    }

    const updatedOccurrences = await loadRecurringOccurrences(
      tx,
      input.actor.accountId,
      updatedSeries.id,
    );
    const lifecycle = Object.freeze({
      action: input.mutation.action,
      reason: input.mutation.reason,
      changedAt,
    });
    const transition = Object.freeze({
      ...lifecycle,
      changedOccurrences: planned.length,
      preservedOccurrences: occurrences.length - planned.length,
    });
    const response = Object.freeze({
      series: recurringDto(updatedSeries, updatedOccurrences, lifecycle),
      transition,
    });
    const receiptId = randomUUID();
    const receiptOperationId = randomUUID();
    await tx.insert(auditLogs).values({
      actorType: "human",
      actorId: input.principal.partnerUserId,
      actorLabel: input.principal.email,
      actorRole: input.principal.roleKey,
      sessionId: input.principal.session.id,
      authMethod: "partner_session",
      correlationId: input.correlationId,
      requiredPermissions: ["bookings.update"],
      outcome: "succeeded",
      surface: "partner_portal_v2",
      idempotencyKeyHash: input.idempotencyKeyHash,
      action: "partner.portal.v2.recurring_series.lifecycle_changed",
      entityType: "partner_recurring_series",
      entityId: updatedSeries.id,
      meta: sanitizeAuditMetadata({
        accountId: input.actor.accountId,
        membershipId: input.actor.membershipId,
        lifecycleAction: input.mutation.action,
        changeReason: input.mutation.reason,
        lifecycleChangedAt: changedAt,
        previousState: series.state,
        nextState: nextSeriesState,
        changedOccurrences: planned.length,
        preservedOccurrences: occurrences.length - planned.length,
        requestHash,
        operationReceiptId: receiptId,
      }),
      createdAt: now,
    });
    await tx.insert(teamMutationIdempotency).values({
      id: receiptId,
      principalHash,
      action: RECURRING_LIFECYCLE_RECEIPT_ACTION,
      keyHash: input.idempotencyKeyHash,
      scopeHash,
      requestHash,
      status: "succeeded",
      operationId: receiptOperationId,
      correlationId: input.correlationId,
      attemptCount: 1,
      claimedAt: now,
      claimExpiresAt: new Date(now.getTime() + 30_000),
      completedAt: now,
      expiresAt: new Date(
        now.getTime() + RECURRING_LIFECYCLE_RECEIPT_RETENTION_MS,
      ),
      responseStatus: 200,
      responseBody: response,
      createdAt: now,
      updatedAt: now,
    });
    return Object.freeze({ ...response, replayed: false });
  });
}

export async function createPartnerRecurringSeries(input: {
  actor: PartnerSchedulingActor;
  principal: PartnerPrincipal;
  recurrence: RecurrenceInput;
  idempotencyKeyHash: string;
  correlationId: string;
  now?: Date;
}) {
  await requireRepeatWorkTool(input.actor.accountId, "recurring");
  const now = input.now ?? new Date();
  const template = await getPartnerServiceTemplate({
    actor: input.actor,
    templateId: input.recurrence.templateId,
  });
  if (!template.locationId)
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "The template needs an active location.",
      { status: 422 },
    );
  const location = await loadLocationForActor(input.actor, template.locationId);
  const timezone = location.timezone;
  const start = DateTime.fromISO(input.recurrence.startsOn, {
    zone: timezone,
  }).startOf("day");
  const tomorrow = DateTime.fromJSDate(now, { zone: timezone })
    .startOf("day")
    .plus({ days: 1 });
  if (start < tomorrow)
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "Recurring work must begin on the next local calendar day or later.",
      {
        status: 422,
        fieldErrors: { startsOn: "Choose tomorrow or a later date." },
      },
    );
  const dates = recurrenceDates(input.recurrence, timezone);
  const opHash = operationHash(
    "recurring.create",
    input.actor.accountId,
    input.idempotencyKeyHash,
  );
  const requestHash = sha256(stableJson(input.recurrence));
  const created = await getDb().transaction(async (tx) => {
    await acquirePartnerRecurringHorizonClaimLock(tx);
    await acquireScheduleConflictLock(tx);
    const [account] = await tx
      .select({
        config: partnerAccounts.portalWorkflowConfig,
        lifecycle: partnerAccounts.portalLifecycleStatus,
        accessEnabled: partnerAccounts.portalAccessEnabled,
      })
      .from(partnerAccounts)
      .where(eq(partnerAccounts.id, input.actor.accountId))
      .for("update")
      .limit(1);
    if (
      !account ||
      account.lifecycle !== "active" ||
      !account.accessEnabled ||
      !normalizePartnerAccountWorkflow(account.config).tools.recurring
    )
      throw new PartnerPortalSchedulingError(
        "forbidden",
        "Recurring service is not enabled for this company.",
        { status: 403 },
      );
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`partner_recurring_v2:${input.actor.accountId}`}))`,
    );
    const [replay] = await tx
      .select()
      .from(partnerRecurringSeries)
      .where(eq(partnerRecurringSeries.createOperationKeyHash, opHash))
      .limit(1);
    let series = replay;
    let replayed = Boolean(replay);
    if (replay) {
      if (replay.createRequestHash !== requestHash)
        throw new PartnerPortalSchedulingError(
          "idempotency_conflict",
          "That request key was already used.",
          { status: 409 },
        );
    } else {
      [series] = await tx
        .insert(partnerRecurringSeries)
        .values({
          partnerAccountId: input.actor.accountId,
          templateId: template.id,
          locationId: template.locationId,
          name: input.recurrence.name,
          recurrenceRule: stableJson({
            frequency: input.recurrence.frequency,
            occurrenceCount: input.recurrence.occurrenceCount,
            endsOn: input.recurrence.endsOn ?? null,
          }),
          templateSnapshot: { ...template },
          timezone,
          preferredWindowStart: input.recurrence.preferredWindowStart,
          startsOn: dates[0]!,
          endsOn:
            input.recurrence.occurrenceCount === 0
              ? (input.recurrence.endsOn ?? null)
              : dates.at(-1)!,
          state: "active",
          revision: 1,
          createdByMembershipId: input.actor.membershipId,
          createOperationKeyHash: opHash,
          createRequestHash: requestHash,
        })
        .returning();
      if (!series) throw new Error("partner_recurring_series_create_failed");
      await tx.insert(partnerRecurringOccurrences).values(
        dates.map((localDate) => ({
          partnerAccountId: input.actor.accountId,
          recurringSeriesId: series!.id,
          localDate,
          state: "tentative" as const,
          evaluation: { reservationCreated: false },
        })),
      );
      replayed = false;
    }
    const occurrences = await tx
      .select()
      .from(partnerRecurringOccurrences)
      .where(
        and(
          eq(
            partnerRecurringOccurrences.partnerAccountId,
            input.actor.accountId,
          ),
          eq(partnerRecurringOccurrences.recurringSeriesId, series!.id),
        ),
      )
      .orderBy(asc(partnerRecurringOccurrences.localDate));
    return { series: series!, occurrences, replayed };
  });
  const horizonEnd = DateTime.fromJSDate(now, { zone: timezone })
    .startOf("day")
    .plus({ days: RECURRING_CONFIRMATION_HORIZON_DAYS });
  for (const occurrence of created.occurrences) {
    const localDay = DateTime.fromISO(occurrence.localDate, { zone: timezone });
    if (
      localDay > horizonEnd ||
      occurrence.partnerBookingId ||
      occurrence.evaluatedAt
    )
      continue;
    const claimed = await getDb().transaction(async (tx) => {
      await acquirePartnerRecurringHorizonClaimLock(tx);
      await acquireScheduleConflictLock(tx);
      const [account] = await tx
        .select({ config: partnerAccounts.portalWorkflowConfig })
        .from(partnerAccounts)
        .where(eq(partnerAccounts.id, input.actor.accountId))
        .for("update")
        .limit(1);
      if (
        !account ||
        !normalizePartnerAccountWorkflow(account.config).tools.recurring
      )
        return false;
      const [activeSeries] = await tx
        .select({ id: partnerRecurringSeries.id })
        .from(partnerRecurringSeries)
        .where(
          and(
            eq(partnerRecurringSeries.id, created.series.id),
            eq(partnerRecurringSeries.partnerAccountId, input.actor.accountId),
            eq(partnerRecurringSeries.state, "active"),
          ),
        )
        .for("update")
        .limit(1);
      if (!activeSeries) return false;
      const [row] = await tx
        .update(partnerRecurringOccurrences)
        .set({ state: "evaluating", evaluatedAt: now, updatedAt: now })
        .where(
          and(
            eq(partnerRecurringOccurrences.id, occurrence.id),
            eq(
              partnerRecurringOccurrences.partnerAccountId,
              input.actor.accountId,
            ),
            eq(partnerRecurringOccurrences.state, "tentative"),
            isNull(partnerRecurringOccurrences.partnerBookingId),
          ),
        )
        .returning({ id: partnerRecurringOccurrences.id });
      return Boolean(row);
    });
    if (!claimed) continue;
    await evaluateClaimedPartnerRecurringOccurrence({
      actor: input.actor,
      seriesId: created.series.id,
      occurrenceId: occurrence.id,
      correlationId: input.correlationId,
      now,
    });
  }
  const refreshed = await loadRecurringOccurrences(
    getDb(),
    input.actor.accountId,
    created.series.id,
  );
  if (!created.replayed)
    await audit({
      principal: input.principal,
      correlationId: input.correlationId,
      action: "partner.portal.v2.recurring_series.created",
      entityType: "partner_recurring_series",
      entityId: created.series.id,
      permission: "bookings.create",
      idempotencyKeyHash: opHash,
      meta: {
        occurrenceCount: dates.length,
        confirmationHorizonDays: RECURRING_CONFIRMATION_HORIZON_DAYS,
      },
    });
  return {
    series: recurringDto(created.series, refreshed),
    replayed: created.replayed,
  };
}

export async function listPartnerRecurringSeries(input: {
  actor: PartnerSchedulingActor;
  params?: URLSearchParams;
}) {
  const db = getDb();
  type Cursor = {
    accountId: string;
    membershipId: string;
    id: string;
    createdAt: string;
  };
  const pagination = parsePortalV2Pagination(
    input.params ?? new URLSearchParams(),
    {
      cursorKind: "partner_recurring_series",
      allowedQueryKeys: new Set<string>(),
      validateCursorPayload: (value: unknown): value is Cursor =>
        isRecord(value) &&
        value["accountId"] === input.actor.accountId &&
        value["membershipId"] === input.actor.membershipId &&
        typeof value["id"] === "string" &&
        UUID_PATTERN.test(value["id"]) &&
        typeof value["createdAt"] === "string" &&
        Number.isFinite(Date.parse(value["createdAt"])),
    },
  );
  if (!pagination.ok)
    throw new PartnerPortalSchedulingError(
      "invalid_cursor",
      "Reload recurring service.",
      { status: 400 },
    );
  const cursor = pagination.cursor?.payload;
  const cursorFilter = cursor
    ? sql`(${partnerRecurringSeries.createdAt}, ${partnerRecurringSeries.id}) < (${sql.param(new Date(cursor.createdAt), partnerRecurringSeries.createdAt)}, ${cursor.id}::uuid)`
    : undefined;
  const series =
    input.actor.accessLevel === "account"
      ? await db
          .select()
          .from(partnerRecurringSeries)
          .where(
            and(
              eq(
                partnerRecurringSeries.partnerAccountId,
                input.actor.accountId,
              ),
              cursorFilter,
            ),
          )
          .orderBy(
            desc(partnerRecurringSeries.createdAt),
            desc(partnerRecurringSeries.id),
          )
          .limit(pagination.limit + 1)
      : await (async () => {
          const grants: SQL[] = [];
          if (input.actor.locationIds.length > 0) {
            grants.push(
              inArray(partnerRecurringSeries.locationId, [
                ...input.actor.locationIds,
              ]),
            );
          }
          if (input.actor.propertyIds.length > 0) {
            grants.push(
              inArray(partnerAccountLocations.propertyId, [
                ...input.actor.propertyIds,
              ]),
            );
          }
          const rows = await db
            .select({ series: partnerRecurringSeries })
            .from(partnerRecurringSeries)
            .innerJoin(
              partnerServiceTemplates,
              and(
                eq(
                  partnerRecurringSeries.templateId,
                  partnerServiceTemplates.id,
                ),
                eq(
                  partnerRecurringSeries.partnerAccountId,
                  partnerServiceTemplates.partnerAccountId,
                ),
              ),
            )
            .leftJoin(
              partnerAccountLocations,
              and(
                eq(
                  partnerAccountLocations.id,
                  partnerRecurringSeries.locationId,
                ),
                eq(
                  partnerAccountLocations.partnerAccountId,
                  partnerRecurringSeries.partnerAccountId,
                ),
              ),
            )
            .where(
              and(
                eq(
                  partnerRecurringSeries.partnerAccountId,
                  input.actor.accountId,
                ),
                or(...grants) ?? sql`false`,
                cursorFilter,
              ),
            )
            .orderBy(
              desc(partnerRecurringSeries.createdAt),
              desc(partnerRecurringSeries.id),
            )
            .limit(pagination.limit + 1);
          return rows.map((row) => row.series);
        })();
  const result = [];
  for (const row of series.slice(0, pagination.limit)) {
    const [occurrences, lifecycle] = await Promise.all([
      loadRecurringOccurrences(db, input.actor.accountId, row.id),
      loadRecurringLifecycle(db, row.id),
    ]);
    result.push(recurringDto(row, occurrences, lifecycle));
  }
  const last = series[Math.min(series.length, pagination.limit) - 1];
  return {
    series: result,
    nextCursor:
      series.length > pagination.limit && last
        ? encodePortalV2Cursor({
            kind: "partner_recurring_series",
            limit: pagination.limit,
            payload: {
              accountId: input.actor.accountId,
              membershipId: input.actor.membershipId,
              id: last.id,
              createdAt: last.createdAt.toISOString(),
            },
          })
        : null,
  };
}

/** Materialize a bounded rolling horizon; dates beyond 30 days remain tentative. */
export async function extendPartnerRecurringOccurrences(
  now = new Date(),
  limit = 100,
): Promise<number> {
  return getDb().transaction(async (tx) => {
    await acquirePartnerRecurringHorizonClaimLock(tx);
    const rows = await tx
      .select({ series: partnerRecurringSeries })
      .from(partnerRecurringSeries)
      .innerJoin(
        partnerAccounts,
        eq(partnerAccounts.id, partnerRecurringSeries.partnerAccountId),
      )
      .where(
        and(
          eq(partnerRecurringSeries.state, "active"),
          eq(partnerAccounts.portalAccessEnabled, true),
          sql`${partnerAccounts.portalWorkflowConfig}->'tools'->>'recurring' = 'true'`,
        ),
      )
      .orderBy(
        sql`${partnerRecurringSeries.occurrencesExpandedAt} asc nulls first`,
        asc(partnerRecurringSeries.id),
      )
      .limit(Math.min(100, Math.max(1, limit)));
    let added = 0;
    for (const { series } of rows) {
      // Rotate every inspected row, including finite or malformed legacy rules,
      // so one unsupported series cannot starve the rolling-horizon queue.
      await tx
        .update(partnerRecurringSeries)
        .set({ occurrencesExpandedAt: now, updatedAt: series.updatedAt })
        .where(eq(partnerRecurringSeries.id, series.id));
      let rule: unknown;
      try {
        rule = JSON.parse(series.recurrenceRule);
      } catch {
        continue;
      }
      if (
        !isRecord(rule) ||
        rule["occurrenceCount"] !== 0 ||
        !["weekly", "biweekly", "monthly"].includes(String(rule["frequency"]))
      )
        continue;
      const today = DateTime.fromJSDate(now, { zone: series.timezone }).startOf(
        "day",
      );
      const dates = recurrenceDates(
        {
          templateId: series.templateId ?? "",
          name: series.name,
          startsOn: series.startsOn,
          occurrenceCount: 0,
          endsOn: series.endsOn,
          frequency: rule["frequency"] as RecurrenceInput["frequency"],
          preferredWindowStart: series.preferredWindowStart,
        },
        series.timezone,
        today.plus({ days: 90 }).toISODate()!,
        today.plus({ days: 1 }).toISODate()!,
      );
      if (dates.length) {
        const inserted = await tx
          .insert(partnerRecurringOccurrences)
          .values(
            dates.map((localDate) => ({
              partnerAccountId: series.partnerAccountId,
              recurringSeriesId: series.id,
              localDate,
              state: "tentative",
              evaluation: { reservationCreated: false },
            })),
          )
          .onConflictDoNothing({
            target: [
              partnerRecurringOccurrences.recurringSeriesId,
              partnerRecurringOccurrences.localDate,
            ],
          })
          .returning({ id: partnerRecurringOccurrences.id });
        added += inserted.length;
      }
    }
    return added;
  });
}

export function parseCsv(csv: string): readonly (readonly string[])[] {
  if (Buffer.byteLength(csv, "utf8") > MAX_CSV_BYTES)
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "The CSV file is too large.",
      {
        status: 422,
        fieldErrors: { file: "Use a CSV no larger than 256 KB." },
      },
    );
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index]!;
    if (quoted) {
      if (char === '"' && csv[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
      continue;
    }
    if (char === '"' && field.length === 0) {
      quoted = true;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (char === "\n") {
      row.push(field.replace(/\r$/u, ""));
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += char;
  }
  if (quoted)
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "The CSV contains an unclosed quoted field.",
      { status: 422 },
    );
  row.push(field.replace(/\r$/u, ""));
  if (row.some((entry) => entry.length > 0) || rows.length === 0)
    rows.push(row);
  return rows;
}

const BULK_HEADERS = [
  "location_id",
  "service_key",
  "tier_key",
  "description",
  "contact_name",
  "contact_phone",
  "contact_email",
  "preferred_date",
  "preferred_window_start",
  "crew_instructions",
  "item_count",
  "volume_cubic_yards",
  "po_number",
  "cost_center",
  "project_reference",
] as const;

function csvEscape(value: string): string {
  return csvCell(value);
}

export function correctionCsv(rows: readonly BulkValidationRow[]): string {
  return [
    [...BULK_HEADERS, "errors"].join(","),
    ...rows.map((row) =>
      [
        ...BULK_HEADERS.map((header) => row.raw[header] ?? ""),
        row.errors
          .map((issue) => `${issue.field}: ${issue.message}`)
          .join(" | "),
      ]
        .map(csvEscape)
        .join(","),
    ),
  ].join("\r\n");
}

export async function validatePartnerBulkCsv(input: {
  actor: PartnerSchedulingActor;
  csv: string;
}): Promise<readonly BulkValidationRow[]> {
  const parsed = parseCsv(input.csv);
  const header = parsed[0]?.map((entry) => entry.trim().toLowerCase()) ?? [];
  if (header.length > 30 || header.length === 0)
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "The CSV header is invalid.",
      { status: 422 },
    );
  const duplicateHeader = header.find(
    (item, index) => header.indexOf(item) !== index,
  );
  if (duplicateHeader)
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "The CSV contains duplicate columns.",
      {
        status: 422,
        fieldErrors: { file: `Duplicate column: ${duplicateHeader}` },
      },
    );
  for (const required of [
    "location_id",
    "service_key",
    "description",
    "contact_name",
  ] as const) {
    if (!header.includes(required))
      throw new PartnerPortalSchedulingError(
        "invalid_fields",
        "The CSV is missing required columns.",
        { status: 422, fieldErrors: { file: `Missing column: ${required}` } },
      );
  }
  const body = parsed
    .slice(1)
    .filter((row) => row.some((field) => field.trim()));
  if (body.length === 0 || body.length > MAX_BULK_ROWS)
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "Use a CSV with 1 to 100 data rows.",
      { status: 422 },
    );
  const rawRows = body.map((fields) =>
    Object.fromEntries(
      header.map((name, index) => [name, (fields[index] ?? "").trim()]),
    ),
  );
  const locationIds = [
    ...new Set(
      rawRows
        .map((row) => row["location_id"] ?? "")
        .filter((id) => UUID_PATTERN.test(id)),
    ),
  ];
  const [locations, services] = await Promise.all([
    getDb()
      .select()
      .from(partnerAccountLocations)
      .where(
        and(
          eq(partnerAccountLocations.partnerAccountId, input.actor.accountId),
          inArray(
            partnerAccountLocations.id,
            locationIds.length
              ? locationIds
              : ["00000000-0000-0000-0000-000000000000"],
          ),
        ),
      ),
    listPartnerServiceCatalog({
      accountId: input.actor.accountId,
      revealPrices: input.actor.canReadRates,
    }),
  ]);
  const accessibleLocations = new Map<
    string,
    typeof partnerAccountLocations.$inferSelect
  >();
  for (const location of locations) {
    try {
      assertActorLocation(input.actor, location);
      accessibleLocations.set(location.id, location);
    } catch {
      /* Tenant-safe invalid row. */
    }
  }
  const supported = new Set(services.map((service) => service.key));
  const tomorrowByTimezone = new Map<string, string>();
  return Object.freeze(
    rawRows.map((raw, index) => {
      const errors: BulkRowIssue[] = [];
      const locationId = raw["location_id"] ?? "";
      const location = accessibleLocations.get(locationId);
      const serviceKey = (raw["service_key"] ?? "").toLowerCase();
      const service = services.find((item) => item.key === serviceKey);
      const tierKey =
        cleanText(raw["tier_key"], 100) ??
        (service?.baseOptions.length === 1
          ? service.baseOptions[0]!.tierKey
          : null);
      const description = cleanText(raw["description"], 4_000) ?? "";
      const contactName = cleanText(raw["contact_name"], 120) ?? "";
      const contactPhone = cleanText(raw["contact_phone"], 40);
      const contactEmail =
        cleanText(raw["contact_email"], 254)?.toLowerCase() ?? null;
      const preferredDate = raw["preferred_date"] ?? "";
      const preferredWindowStart = cleanText(raw["preferred_window_start"], 5);
      if (!location)
        errors.push({
          field: "location_id",
          message: "Choose an accessible active location ID.",
        });
      if (!supported.has(serviceKey))
        errors.push({
          field: "service_key",
          message:
            "Choose a service enabled for your account, or service_request for Stonegate review.",
        });
      if (
        service &&
        ((tierKey &&
          !service.baseOptions.some((option) => option.tierKey === tierKey)) ||
          (!tierKey && service.baseOptions.length > 1))
      )
        errors.push({
          field: "tier_key",
          message:
            "Choose a current service option from your account's booking form.",
        });
      if (!description)
        errors.push({ field: "description", message: "Describe the work." });
      if (!contactName)
        errors.push({
          field: "contact_name",
          message: "Add an on-site contact name.",
        });
      if (!contactPhone && !contactEmail)
        errors.push({
          field: "contact_phone",
          message: "Add a contact phone or email.",
        });
      if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(contactEmail))
        errors.push({ field: "contact_email", message: "Use a valid email." });
      if (
        !/^\d{4}-\d{2}-\d{2}$/u.test(preferredDate) ||
        !DateTime.fromISO(preferredDate).isValid
      )
        errors.push({ field: "preferred_date", message: "Use YYYY-MM-DD." });
      if (location && preferredDate) {
        const tomorrow =
          tomorrowByTimezone.get(location.timezone) ??
          DateTime.now()
            .setZone(location.timezone)
            .startOf("day")
            .plus({ days: 1 })
            .toISODate()!;
        tomorrowByTimezone.set(location.timezone, tomorrow);
        if (preferredDate < tomorrow)
          errors.push({
            field: "preferred_date",
            message: "Choose tomorrow or a later local date.",
          });
        if (
          preferredDate >
          DateTime.fromISO(tomorrow).plus({ days: 29 }).toISODate()!
        )
          errors.push({
            field: "preferred_date",
            message:
              "Choose a date within the next 30 days. Use recurring service for ongoing work.",
          });
      }
      if (
        preferredWindowStart &&
        !/^([01]\d|2[0-3]):(00|30)$/u.test(preferredWindowStart)
      )
        errors.push({
          field: "preferred_window_start",
          message: "Use HH:00 or HH:30.",
        });
      const numberField = (name: "item_count" | "volume_cubic_yards") => {
        const rawValue = raw[name];
        if (!rawValue) return undefined;
        const value = Number(rawValue);
        if (!Number.isFinite(value) || value < 0) {
          errors.push({ field: name, message: "Use a non-negative number." });
          return undefined;
        }
        return value;
      };
      const itemCount = numberField("item_count");
      const volume = numberField("volume_cubic_yards");
      const normalized: NormalizedBulkRow | null = errors.length
        ? null
        : Object.freeze({
            locationId,
            serviceKey,
            tierKey,
            description,
            crewInstructions: cleanText(raw["crew_instructions"], 4_000),
            onSiteContact: {
              name: contactName,
              ...(contactPhone ? { phone: contactPhone } : {}),
              ...(contactEmail ? { email: contactEmail } : {}),
            },
            scope: {
              ...(itemCount !== undefined ? { itemCount } : {}),
              ...(volume !== undefined ? { volumeCubicYards: volume } : {}),
            },
            proofRequirements: { before: 1, after: 1 },
            commercial: {
              ...(cleanText(raw["po_number"], 500)
                ? { poNumber: cleanText(raw["po_number"], 500) }
                : {}),
              ...(cleanText(raw["cost_center"], 500)
                ? { costCenter: cleanText(raw["cost_center"], 500) }
                : {}),
              ...(cleanText(raw["project_reference"], 500)
                ? { projectReference: cleanText(raw["project_reference"], 500) }
                : {}),
            },
            preferredDate,
            preferredWindowStart,
            timezone: location!.timezone,
          });
      return Object.freeze({
        rowNumber: index + 2,
        raw: Object.freeze(raw),
        normalized,
        errors: Object.freeze(errors),
      });
    }),
  );
}

export async function createPartnerBulkImport(input: {
  actor: PartnerSchedulingActor;
  principal: PartnerPrincipal;
  sourceFilename: string;
  csv: string;
  dryRun: boolean;
  idempotencyKeyHash: string;
  correlationId: string;
}) {
  await requireRepeatWorkTool(input.actor.accountId, "bulk");
  const filename =
    cleanText(input.sourceFilename.replace(/^.*[\\/]/u, ""), 120) ??
    "partner-jobs.csv";
  if (!filename.toLowerCase().endsWith(".csv"))
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "Upload a CSV file.",
      { status: 422 },
    );
  const rows = await validatePartnerBulkCsv({
    actor: input.actor,
    csv: input.csv,
  });
  const sourceSha256 = sha256(input.csv);
  const opHash = operationHash(
    "bulk.create",
    input.actor.accountId,
    input.idempotencyKeyHash,
  );
  const requestHash = sha256(sourceSha256, String(input.dryRun));
  const result = await getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${"partner_bulk_v2:" + input.actor.accountId}))`,
    );
    const [replay] = await tx
      .select()
      .from(partnerBulkImports)
      .where(eq(partnerBulkImports.createOperationKeyHash, opHash))
      .limit(1);
    if (replay) {
      if (
        replay.createRequestHash !== requestHash ||
        replay.createdByMembershipId !== input.actor.membershipId
      )
        throw new PartnerPortalSchedulingError(
          "idempotency_conflict",
          "That request key was already used.",
          { status: 409 },
        );
      return { id: replay.id, replayed: true };
    }
    const validCount = rows.filter((row) => row.normalized).length;
    const [batch] = await tx
      .insert(partnerBulkImports)
      .values({
        partnerAccountId: input.actor.accountId,
        createdByMembershipId: input.actor.membershipId,
        sourceFilename: filename,
        sourceSha256,
        state: input.dryRun ? "validated" : "processing",
        dryRun: input.dryRun,
        rowCount: rows.length,
        validCount,
        errorCount: rows.length - validCount,
        createOperationKeyHash: opHash,
        createRequestHash: requestHash,
        completedAt: input.dryRun ? new Date() : null,
      })
      .returning();
    if (!batch) throw new Error("partner_bulk_import_create_failed");
    await tx.insert(partnerBulkImportRows).values(
      rows.map((row) => ({
        partnerAccountId: input.actor.accountId,
        partnerBulkImportId: batch.id,
        rowNumber: row.rowNumber,
        rawData: { ...row.raw },
        normalizedData: row.normalized as unknown as Record<
          string,
          unknown
        > | null,
        errors: row.errors.map((issue) => ({ ...issue })),
        state: row.normalized ? "pending" : "invalid",
      })),
    );
    if (!input.dryRun)
      await tx.insert(outboxEvents).values({
        type: "partner.bulk_import.process",
        payload: { importId: batch.id, accountId: input.actor.accountId },
      });
    return { id: batch.id, replayed: false };
  });
  if (!result.replayed)
    await audit({
      principal: input.principal,
      correlationId: input.correlationId,
      action: input.dryRun
        ? "partner.portal.v2.bulk_import.validated"
        : "partner.portal.v2.bulk_import.committed",
      entityType: "partner_bulk_import",
      entityId: result.id,
      permission: "bookings.create",
      idempotencyKeyHash: opHash,
      meta: { rowCount: rows.length, dryRun: input.dryRun },
    });
  return {
    import: await getPartnerBulkImport({
      actor: input.actor,
      importId: result.id,
    }),
    replayed: result.replayed,
  };
}

async function loadOwnedBulkImport(
  actor: PartnerSchedulingActor,
  importId: string,
) {
  const [batch] = await getDb()
    .select()
    .from(partnerBulkImports)
    .where(
      and(
        eq(partnerBulkImports.id, importId),
        eq(partnerBulkImports.partnerAccountId, actor.accountId),
        eq(partnerBulkImports.createdByMembershipId, actor.membershipId),
      ),
    )
    .limit(1);
  if (!batch)
    throw new PartnerPortalSchedulingError(
      "not_found",
      "The import was not found.",
      { status: 404 },
    );
  return batch;
}

export async function getPartnerBulkImport(input: {
  actor: PartnerSchedulingActor;
  importId: string;
}) {
  const batch = await loadOwnedBulkImport(input.actor, input.importId);
  const rows = await getDb()
    .select()
    .from(partnerBulkImportRows)
    .where(
      and(
        eq(partnerBulkImportRows.partnerAccountId, input.actor.accountId),
        eq(partnerBulkImportRows.partnerBulkImportId, batch.id),
      ),
    )
    .orderBy(asc(partnerBulkImportRows.rowNumber))
    .limit(MAX_BULK_ROWS);
  const locationIds = new Set(
    rows
      .map((row) => row.normalizedData?.["locationId"])
      .filter((id): id is string => typeof id === "string"),
  );
  for (const id of locationIds) await loadLocationForActor(input.actor, id);
  const failures = rows.filter(
    (row) => row.state === "invalid" || row.state === "failed",
  );
  return {
    id: batch.id,
    filename: batch.sourceFilename,
    state: batch.state,
    dryRun: batch.dryRun,
    createdAt: batch.createdAt.toISOString(),
    etag: createPortalV2StrongEtag(
      `partner-bulk-import:${batch.id}:${batch.sourceSha256}`,
    ),
    rowCount: batch.rowCount,
    validCount: batch.validCount,
    errorCount: failures.length,
    pendingCount: rows.filter(
      (row) => row.state === "pending" || row.state === "processing",
    ).length,
    confirmedCount: rows.filter((row) => row.state === "created").length,
    reviewCount: rows.filter((row) => row.state === "review").length,
    rows: rows.map((row) => ({
      rowNumber: row.rowNumber,
      state: row.state,
      draftId: row.bookingDraftId,
      jobId: row.partnerBookingId,
      errors: row.errors,
    })),
    correctionCsv: correctionCsv(
      failures.map((row) => ({
        rowNumber: row.rowNumber,
        raw: row.rawData,
        normalized: null,
        errors: row.errors as unknown as BulkRowIssue[],
      })),
    ),
    capacityReserved: rows.some((row) => row.state === "created"),
  };
}

export async function listPartnerBulkImports(input: {
  actor: PartnerSchedulingActor;
  params: URLSearchParams;
}) {
  type Cursor = {
    accountId: string;
    membershipId: string;
    id: string;
    createdAt: string;
  };
  const pagination = parsePortalV2Pagination(input.params, {
    cursorKind: "partner_bulk_imports",
    allowedQueryKeys: new Set<string>(),
    validateCursorPayload: (value: unknown): value is Cursor =>
      isRecord(value) &&
      value["accountId"] === input.actor.accountId &&
      value["membershipId"] === input.actor.membershipId &&
      typeof value["id"] === "string" &&
      UUID_PATTERN.test(value["id"]) &&
      typeof value["createdAt"] === "string" &&
      Number.isFinite(Date.parse(value["createdAt"])),
  });
  if (!pagination.ok)
    throw new PartnerPortalSchedulingError(
      "invalid_cursor",
      "Reload the import history.",
      { status: 400 },
    );
  const before = pagination.cursor?.payload;
  const rows = await getDb()
    .select({
      id: partnerBulkImports.id,
      filename: partnerBulkImports.sourceFilename,
      state: partnerBulkImports.state,
      dryRun: partnerBulkImports.dryRun,
      rowCount: partnerBulkImports.rowCount,
      createdAt: partnerBulkImports.createdAt,
    })
    .from(partnerBulkImports)
    .where(
      and(
        eq(partnerBulkImports.partnerAccountId, input.actor.accountId),
        eq(partnerBulkImports.createdByMembershipId, input.actor.membershipId),
        before
          ? sql`(${partnerBulkImports.createdAt}, ${partnerBulkImports.id}) < (${sql.param(new Date(before.createdAt), partnerBulkImports.createdAt)}, ${before.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(partnerBulkImports.createdAt), desc(partnerBulkImports.id))
    .limit(pagination.limit + 1);
  const visible = rows.slice(0, pagination.limit);
  const last = visible.at(-1);
  return {
    imports: visible.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor:
      rows.length > pagination.limit && last
        ? encodePortalV2Cursor({
            kind: "partner_bulk_imports",
            limit: pagination.limit,
            payload: {
              accountId: input.actor.accountId,
              membershipId: input.actor.membershipId,
              id: last.id,
              createdAt: last.createdAt.toISOString(),
            },
          })
        : null,
  };
}

/** Retry preserves each row's draft/job idempotency identity; accepted work is never duplicated. */
export async function commitPartnerBulkImport(input: {
  actor: PartnerSchedulingActor;
  importId: string;
  principal: PartnerPrincipal;
  correlationId: string;
  idempotencyKeyHash: string;
  ifMatch: string | null;
}) {
  await requireRepeatWorkTool(input.actor.accountId, "bulk");
  const previous = await getPartnerBulkImport(input);
  if (input.ifMatch !== previous.etag)
    throw new PartnerPortalSchedulingError(
      "revision_mismatch",
      "This checked import changed. Reload its saved results.",
      { status: 412 },
    );
  const stored = await getDb()
    .select()
    .from(partnerBulkImportRows)
    .where(
      and(
        eq(partnerBulkImportRows.partnerAccountId, input.actor.accountId),
        eq(partnerBulkImportRows.partnerBulkImportId, input.importId),
      ),
    )
    .orderBy(asc(partnerBulkImportRows.rowNumber))
    .limit(MAX_BULK_ROWS);
  const csv = [
    BULK_HEADERS.join(","),
    ...stored.map((row) =>
      BULK_HEADERS.map((field) => {
        const value = row.rawData[field] ?? "";
        return /[",\r\n]/u.test(value)
          ? `"${value.replace(/"/gu, '""')}"`
          : value;
      }).join(","),
    ),
  ].join("\r\n");
  const checked = await validatePartnerBulkCsv({ actor: input.actor, csv });
  await getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${"partner_bulk_v2:" + input.actor.accountId}))`,
    );
    const [batch] = await tx
      .select()
      .from(partnerBulkImports)
      .where(
        and(
          eq(partnerBulkImports.id, input.importId),
          eq(partnerBulkImports.partnerAccountId, input.actor.accountId),
          eq(
            partnerBulkImports.createdByMembershipId,
            input.actor.membershipId,
          ),
        ),
      )
      .limit(1);
    if (!batch)
      throw new PartnerPortalSchedulingError(
        "not_found",
        "The import was not found.",
        { status: 404 },
      );
    if (!batch.dryRun) return;
    for (const row of checked)
      await tx
        .update(partnerBulkImportRows)
        .set({
          normalizedData: row.normalized as unknown as Record<
            string,
            unknown
          > | null,
          errors: row.errors.map((issue) => ({ ...issue })),
          state: row.normalized ? "pending" : "invalid",
        })
        .where(
          and(
            eq(partnerBulkImportRows.partnerBulkImportId, batch.id),
            eq(partnerBulkImportRows.rowNumber, row.rowNumber),
          ),
        );
    const validCount = checked.filter((row) => row.normalized).length;
    await tx
      .update(partnerBulkImports)
      .set({
        dryRun: false,
        state: "processing",
        completedAt: null,
        validCount,
        errorCount: checked.length - validCount,
      })
      .where(eq(partnerBulkImports.id, batch.id));
    await tx.insert(outboxEvents).values({
      type: "partner.bulk_import.process",
      payload: { importId: batch.id, accountId: input.actor.accountId },
    });
    await tx.insert(auditLogs).values({
      actorType: "human",
      actorId: input.actor.partnerUserId,
      sessionId: input.actor.sessionId,
      action: "partner.portal.v2.bulk_import.committed",
      entityType: "partner_bulk_import",
      entityId: batch.id,
      correlationId: input.correlationId,
      idempotencyKeyHash: operationHash(
        "bulk.commit",
        input.actor.accountId,
        input.idempotencyKeyHash,
      ),
      meta: {
        accountId: input.actor.accountId,
        validCount,
        rowCount: checked.length,
      },
    });
  });
  return getPartnerBulkImport(input);
}

export async function retryPartnerBulkImport(input: {
  actor: PartnerSchedulingActor;
  importId: string;
  principal: PartnerPrincipal;
  correlationId: string;
  idempotencyKeyHash: string;
}) {
  await requireRepeatWorkTool(input.actor.accountId, "bulk");
  await getPartnerBulkImport(input);
  const batch = await loadOwnedBulkImport(input.actor, input.importId);
  if (batch.dryRun)
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "Submit the checked file before retrying.",
      { status: 422 },
    );
  await getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${"partner_bulk_v2:" + input.actor.accountId}))`,
    );
    await tx
      .update(partnerBulkImportRows)
      .set({ state: "pending", processingStartedAt: null })
      .where(
        and(
          eq(partnerBulkImportRows.partnerBulkImportId, batch.id),
          eq(partnerBulkImportRows.partnerAccountId, input.actor.accountId),
          eq(partnerBulkImportRows.state, "failed"),
          isNull(partnerBulkImportRows.partnerBookingId),
        ),
      );
    await tx
      .update(partnerBulkImports)
      .set({ state: "processing", completedAt: null })
      .where(eq(partnerBulkImports.id, batch.id));
    await tx.insert(outboxEvents).values({
      type: "partner.bulk_import.process",
      payload: { importId: batch.id, accountId: input.actor.accountId },
    });
  });
  await audit({
    principal: input.principal,
    correlationId: input.correlationId,
    action: "partner.portal.v2.bulk_import.retried",
    entityType: "partner_bulk_import",
    entityId: batch.id,
    permission: "bookings.create",
    idempotencyKeyHash: input.idempotencyKeyHash,
  });
  return getPartnerBulkImport(input);
}

async function submitBulkRow(
  actor: PartnerSchedulingActor,
  stored: typeof partnerBulkImportRows.$inferSelect,
) {
  const row = stored.normalizedData as unknown as NormalizedBulkRow;
  if (!row)
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "Correct this row and upload it again.",
      { status: 422 },
    );
  await loadLocationForActor(actor, row.locationId);
  if (stored.bookingDraftId) {
    const [accepted] = await getDb()
      .select()
      .from(partnerBookings)
      .where(
        and(
          eq(partnerBookings.partnerAccountId, actor.accountId),
          eq(partnerBookings.bookingDraftId, stored.bookingDraftId),
        ),
      )
      .limit(1);
    if (accepted)
      return {
        jobId: accepted.id,
        draftId: stored.bookingDraftId,
        state: accepted.publicStatus === "confirmed" ? "created" : "review",
      };
  }
  const created = await createPartnerBookingDraft({
    actor,
    mutation: {
      locationId: row.locationId,
      serviceKey: row.serviceKey,
      tierKey: row.tierKey ?? null,
      scope: { ...row.scope },
      description: row.description,
      crewInstructions: row.crewInstructions,
      accessDetails: null,
      onSiteContact: { ...row.onSiteContact },
      proofRequirements: { ...row.proofRequirements },
      commercial: { ...row.commercial },
      preferredWindows: [
        {
          localDate: row.preferredDate,
          timeOfDay: row.preferredWindowStart
            ? Number(row.preferredWindowStart.slice(0, 2)) < 12
              ? "morning"
              : "afternoon"
            : "anytime",
          timezone: row.timezone,
        },
      ],
    },
    idempotencyKeyHash: sha256("bulk-draft", stored.id),
  });
  await getDb()
    .update(partnerBulkImportRows)
    .set({ bookingDraftId: created.draft.id })
    .where(eq(partnerBulkImportRows.id, stored.id));
  let draft = created.draft;
  let holdId: string | null = null;
  const day = DateTime.fromISO(row.preferredDate, {
    zone: row.timezone,
  }).startOf("day");
  try {
    const availability = await getPartnerDraftAvailability({
      actor,
      draftId: draft.id,
      rangeStartAt: day.toJSDate(),
      rangeEndAt: day.endOf("day").toJSDate(),
    });
    const window = availability.instantConfirmationEligible
      ? availability.windows.find(
          (item) =>
            !row.preferredWindowStart ||
            DateTime.fromISO(item.startAt, { zone: row.timezone }).toFormat(
              "HH:mm",
            ) === row.preferredWindowStart,
        )
      : null;
    if (window) {
      const held = await createOrReplacePartnerHold({
        actor,
        draftId: draft.id,
        windowId: window.id,
        ifMatch: draft.etag,
        idempotencyKeyHash: sha256("bulk-hold", stored.id),
        correlationId: randomUUID(),
      });
      holdId = held.hold.id;
      draft = await getPartnerBookingDraft({ actor, draftId: draft.id });
    }
  } catch (error) {
    if (
      !(error instanceof PartnerPortalSchedulingError) ||
      ![409, 410, 422, 503].includes(error.status)
    )
      throw error;
    draft = await getPartnerBookingDraft({ actor, draftId: draft.id });
  }
  try {
    const submitted = await submitPartnerBookingDraft({
      actor,
      draftId: draft.id,
      holdId,
      ifMatch: draft.etag,
      idempotencyKeyHash: sha256("bulk-submit", stored.id),
      correlationId: randomUUID(),
    });
    return {
      jobId: submitted.booking.id,
      draftId: draft.id,
      state:
        submitted.booking.publicStatus === "confirmed" ? "created" : "review",
    };
  } catch (error) {
    if (
      !holdId ||
      !(error instanceof PartnerPortalSchedulingError) ||
      ![409, 410, 422].includes(error.status)
    )
      throw error;
    draft = await getPartnerBookingDraft({ actor, draftId: draft.id });
    const submitted = await submitPartnerBookingDraft({
      actor,
      draftId: draft.id,
      holdId: null,
      ifMatch: draft.etag,
      idempotencyKeyHash: sha256("bulk-review", stored.id),
      correlationId: randomUUID(),
    });
    return { jobId: submitted.booking.id, draftId: draft.id, state: "review" };
  }
}

/** Outbox handler: up to ten rows; continuation and completion are durable. Throw on infrastructure errors for outbox retry. */
export async function processPartnerBulkImport(payload: {
  importId: string;
  accountId: string;
}): Promise<void> {
  if (
    !UUID_PATTERN.test(payload.importId) ||
    !UUID_PATTERN.test(payload.accountId)
  )
    throw new Error("partner_bulk_invalid_payload");
  if (
    !arePartnerPortalV2WritesEnabled(payload.accountId) ||
    !(await isPartnerToolEnabled(payload.accountId, "bulk"))
  )
    throw new Error("partner_bulk_processing_disabled");
  const [batch] = await getDb()
    .select()
    .from(partnerBulkImports)
    .where(
      and(
        eq(partnerBulkImports.id, payload.importId),
        eq(partnerBulkImports.partnerAccountId, payload.accountId),
      ),
    )
    .limit(1);
  if (!batch || batch.dryRun || batch.state === "completed") return;
  for (let index = 0; index < 10; index++) {
    const actor = await loadPartnerBackgroundSchedulingActor(
      payload.accountId,
      batch.createdByMembershipId,
    );
    const row = await getDb().transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${"partner_bulk_v2:" + payload.accountId}))`,
      );
      const [candidate] = await tx
        .select()
        .from(partnerBulkImportRows)
        .where(
          and(
            eq(partnerBulkImportRows.partnerBulkImportId, batch.id),
            eq(partnerBulkImportRows.partnerAccountId, payload.accountId),
            or(
              eq(partnerBulkImportRows.state, "pending"),
              and(
                eq(partnerBulkImportRows.state, "processing"),
                sql`${partnerBulkImportRows.processingStartedAt} < now() - interval '15 minutes'`,
              ),
            ),
          ),
        )
        .orderBy(asc(partnerBulkImportRows.rowNumber))
        .limit(1);
      if (!candidate) return null;
      await tx
        .update(partnerBulkImportRows)
        .set({
          state: "processing",
          processingStartedAt: new Date(),
          processingAttempts: sql`${partnerBulkImportRows.processingAttempts} + 1`,
        })
        .where(eq(partnerBulkImportRows.id, candidate.id));
      return candidate;
    });
    if (!row) break;
    try {
      if (!actor)
        throw new PartnerPortalSchedulingError(
          "forbidden",
          "Your access changed. Contact Stonegate before retrying these rows.",
          { status: 403 },
        );
      const result = await submitBulkRow(actor, row);
      await getDb()
        .update(partnerBulkImportRows)
        .set({
          state: result.state,
          bookingDraftId: result.draftId,
          partnerBookingId: result.jobId,
          processingStartedAt: null,
          errors: [],
        })
        .where(eq(partnerBulkImportRows.id, row.id));
    } catch (error) {
      const recoverable =
        !(error instanceof PartnerPortalSchedulingError) ||
        error.status >= 500 ||
        error.status === 429;
      await getDb()
        .update(partnerBulkImportRows)
        .set({
          state: recoverable ? "pending" : "failed",
          processingStartedAt: null,
          errors: [
            {
              field: "status",
              message:
                error instanceof PartnerPortalSchedulingError
                  ? error.message
                  : "Processing was interrupted. The saved row will retry safely.",
            },
          ],
        })
        .where(eq(partnerBulkImportRows.id, row.id));
      if (recoverable) throw error;
    }
  }
  await getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${"partner_bulk_v2:" + payload.accountId}))`,
    );
    const rows = await tx
      .select({ state: partnerBulkImportRows.state })
      .from(partnerBulkImportRows)
      .where(eq(partnerBulkImportRows.partnerBulkImportId, batch.id));
    const pending = rows.some(
      (row) => row.state === "pending" || row.state === "processing",
    );
    await tx
      .update(partnerBulkImports)
      .set({
        state: pending
          ? "processing"
          : rows.some((row) => row.state === "failed")
            ? "failed"
            : "completed",
        completedAt: pending ? null : new Date(),
      })
      .where(eq(partnerBulkImports.id, batch.id));
    if (pending)
      await tx.insert(outboxEvents).values({
        type: "partner.bulk_import.process",
        payload,
        nextAttemptAt: new Date(
          Date.now() +
            (rows.some((row) => row.state === "processing") ? 60_000 : 1_000),
        ),
      });
  });
}

export function assertTemplateRevision(input: {
  template: PartnerServiceTemplateDto;
  ifMatch: string | null | undefined;
  correlationId: string;
}): void {
  const result = evaluatePortalV2RevisionPrecondition({
    ifMatch: input.ifMatch,
    currentRevision: templateRevision(input.template),
    correlationId: input.correlationId,
  });
  if (!result.ok)
    throw new PartnerPortalSchedulingError(
      result.response.body.error,
      result.response.body.message,
      {
        status: result.response.status,
        additionalHeaders: result.response.headers,
      },
    );
}
