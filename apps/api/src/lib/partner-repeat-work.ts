import { createHash } from "node:crypto";
import { DateTime } from "luxon";
import { and, asc, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import {
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
  partnerServiceCatalog,
  partnerServiceTemplates,
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
  evaluatePortalV2RevisionPrecondition,
} from "@/lib/portal-v2-contract";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import { projectPartnerAddOnSnapshots } from "@/lib/partner-portal-v2-service-add-ons";

const MAX_TEMPLATES = 100;
const MAX_BULK_ROWS = 100;
const MAX_CSV_BYTES = 256 * 1024;
const MAX_OCCURRENCES = 24;
const RECURRING_CONFIRMATION_HORIZON_DAYS = 30;

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
  preferredWindowStart: string | null;
}>;

export type BulkRowIssue = Readonly<{
  field: string;
  message: string;
}>;

export type NormalizedBulkRow = Readonly<{
  locationId: string;
  serviceKey: string;
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
}): Promise<readonly PartnerServiceTemplateDto[]> {
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
              eq(partnerServiceTemplates.active, true),
            ),
          )
          .orderBy(
            asc(partnerServiceTemplates.name),
            asc(partnerServiceTemplates.id),
          )
          .limit(MAX_TEMPLATES)
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
                eq(partnerServiceTemplates.active, true),
                or(...grants) ?? sql`false`,
              ),
            )
            .orderBy(
              asc(partnerServiceTemplates.name),
              asc(partnerServiceTemplates.id),
            )
            .limit(MAX_TEMPLATES);
          return scopedRows.map((row) => row.template);
        })();
  return Object.freeze(rows.map(toTemplateDto));
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
  return toTemplateDto(row);
}

export async function applyPartnerServiceTemplate(input: {
  actor: PartnerSchedulingActor;
  templateId: string;
  idempotencyKeyHash: string;
}): Promise<{ draft: PartnerDraftDto; replayed: boolean }> {
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
  const occurrenceCount = value["occurrenceCount"];
  const preferredWindowStart = cleanText(value["preferredWindowStart"], 5);
  const errors: Record<string, string> = {};
  if (!/^[0-9a-f-]{36}$/iu.test(templateId))
    errors["templateId"] = "Choose a saved template.";
  if (name.length < 2) errors["name"] = "Use 2 to 120 characters.";
  if (!(["weekly", "biweekly", "monthly"] as unknown[]).includes(frequency))
    errors["frequency"] = "Choose weekly, every two weeks, or monthly.";
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(startsOn) ||
    !DateTime.fromISO(startsOn).isValid
  )
    errors["startsOn"] = "Choose a valid start date.";
  if (
    !Number.isSafeInteger(occurrenceCount) ||
    (occurrenceCount as number) < 2 ||
    (occurrenceCount as number) > MAX_OCCURRENCES
  )
    errors["occurrenceCount"] = `Choose 2 to ${MAX_OCCURRENCES} occurrences.`;
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
    preferredWindowStart,
  });
}

export function recurrenceDates(
  input: RecurrenceInput,
  timezone: string,
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
  for (let index = 0; index < input.occurrenceCount; index += 1) {
    const date =
      input.frequency === "monthly"
        ? start.plus({ months: index })
        : start.plus({
            weeks: index * (input.frequency === "biweekly" ? 2 : 1),
          });
    const iso = date.toISODate();
    if (!iso) throw new Error("partner_recurring_date_failed");
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
  const day = DateTime.fromISO(input.occurrence.localDate, {
    zone: input.timezone,
  }).startOf("day");
  let bookingDraftId: string | null = null;
  try {
    const created = await createPartnerBookingDraft({
      actor: input.actor,
      mutation: mutationFromTemplate(input.template),
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
    const publicStarts = availableWindows.map((window) =>
      DateTime.fromISO(window.startAt)
        .setZone(input.timezone)
        .toFormat("HH:mm"),
    );
    if (!input.preferredWindowStart) {
      await updateOccurrence({
        actor: input.actor,
        occurrenceId: input.occurrence.id,
        state: "review",
        bookingDraftId: created.draft.id,
        failureCode: "arrival_window_selection_required",
        evaluation: {
          availableWindowStarts: publicStarts.slice(0, 12),
          reservationCreated: false,
        },
        evaluatedAt: input.now,
      });
      return;
    }
    const window = availableWindows.find(
      (candidate) =>
        DateTime.fromISO(candidate.startAt)
          .setZone(input.timezone)
          .toFormat("HH:mm") === input.preferredWindowStart,
    );
    if (!window) {
      await updateOccurrence({
        actor: input.actor,
        occurrenceId: input.occurrence.id,
        state: "review",
        bookingDraftId: created.draft.id,
        failureCode: "preferred_window_unavailable",
        evaluation: {
          availableWindowStarts: publicStarts.slice(0, 12),
          reservationCreated: false,
        },
        evaluatedAt: input.now,
      });
      return;
    }
    const hold = await createOrReplacePartnerHold({
      actor: input.actor,
      draftId: created.draft.id,
      windowId: window.id,
      idempotencyKeyHash: sha256("recurring-hold", input.occurrence.id),
      ifMatch: created.draft.etag,
      correlationId: input.correlationId,
      now: input.now,
    });
    const submitted = await submitPartnerBookingDraft({
      actor: input.actor,
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
    const template = await getPartnerServiceTemplate({
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

function recurringDto(
  series: typeof partnerRecurringSeries.$inferSelect,
  occurrences: readonly (typeof partnerRecurringOccurrences.$inferSelect)[],
) {
  return {
    id: series.id,
    name: series.name,
    templateId: series.templateId,
    recurrence: JSON.parse(series.recurrenceRule) as unknown,
    timezone: series.timezone,
    startsOn: series.startsOn,
    endsOn: series.endsOn,
    preferredWindowStart: series.preferredWindowStart,
    state: series.state,
    revision: series.revision,
    etag: createPortalV2StrongEtag(
      `partner-recurring-series:${series.id}:${series.revision}`,
    ),
    occurrences: occurrences.map((occurrence) => ({
      id: occurrence.id,
      localDate: occurrence.localDate,
      state: occurrence.state,
      draftId: occurrence.bookingDraftId,
      jobId: occurrence.partnerBookingId,
      reason: occurrence.failureCode,
      evaluation: occurrence.evaluation,
      evaluatedAt: occurrence.evaluatedAt?.toISOString() ?? null,
    })),
  };
}

export async function createPartnerRecurringSeries(input: {
  actor: PartnerSchedulingActor;
  principal: PartnerPrincipal;
  recurrence: RecurrenceInput;
  idempotencyKeyHash: string;
  correlationId: string;
  now?: Date;
}) {
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
          name: input.recurrence.name,
          recurrenceRule: stableJson({
            frequency: input.recurrence.frequency,
            occurrenceCount: input.recurrence.occurrenceCount,
          }),
          timezone,
          preferredWindowStart: input.recurrence.preferredWindowStart,
          startsOn: dates[0]!,
          endsOn: dates.at(-1)!,
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
    await evaluateClaimedPartnerRecurringOccurrence({
      actor: input.actor,
      seriesId: created.series.id,
      occurrenceId: occurrence.id,
      correlationId: input.correlationId,
      now,
    });
  }
  const refreshed = await getDb()
    .select()
    .from(partnerRecurringOccurrences)
    .where(
      and(
        eq(partnerRecurringOccurrences.partnerAccountId, input.actor.accountId),
        eq(partnerRecurringOccurrences.recurringSeriesId, created.series.id),
      ),
    )
    .orderBy(asc(partnerRecurringOccurrences.localDate));
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
}) {
  const db = getDb();
  const series =
    input.actor.accessLevel === "account"
      ? await db
          .select()
          .from(partnerRecurringSeries)
          .where(
            eq(partnerRecurringSeries.partnerAccountId, input.actor.accountId),
          )
          .orderBy(desc(partnerRecurringSeries.createdAt))
          .limit(50)
      : await (async () => {
          const grants: SQL[] = [];
          if (input.actor.locationIds.length > 0) {
            grants.push(
              inArray(partnerServiceTemplates.locationId, [
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
                  partnerServiceTemplates.locationId,
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
              ),
            )
            .orderBy(desc(partnerRecurringSeries.createdAt))
            .limit(50);
          return rows.map((row) => row.series);
        })();
  const result = [];
  for (const row of series) {
    const occurrences = await db
      .select()
      .from(partnerRecurringOccurrences)
      .where(
        and(
          eq(
            partnerRecurringOccurrences.partnerAccountId,
            input.actor.accountId,
          ),
          eq(partnerRecurringOccurrences.recurringSeriesId, row.id),
        ),
      )
      .orderBy(asc(partnerRecurringOccurrences.localDate))
      .limit(MAX_OCCURRENCES);
    result.push(recurringDto(row, occurrences));
  }
  return result;
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
  return /[",\r\n]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value;
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
    ...new Set(rawRows.map((row) => row["location_id"] ?? "").filter(Boolean)),
  ];
  const serviceKeys = [
    ...new Set(
      rawRows
        .map((row) => (row["service_key"] ?? "").toLowerCase())
        .filter(Boolean),
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
    getDb()
      .select({ key: partnerServiceCatalog.key })
      .from(partnerServiceCatalog)
      .where(
        and(
          eq(partnerServiceCatalog.active, true),
          inArray(
            partnerServiceCatalog.key,
            serviceKeys.length ? serviceKeys : ["__none__"],
          ),
        ),
      ),
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
          message: "Choose an active service key.",
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
          DateTime.fromISO(tomorrow).plus({ days: 365 }).toISODate()!
        )
          errors.push({
            field: "preferred_date",
            message: "Choose a date within one year.",
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
  const initial = await getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`partner_bulk_v2:${input.actor.accountId}`}))`,
    );
    const [replay] = await tx
      .select()
      .from(partnerBulkImports)
      .where(eq(partnerBulkImports.createOperationKeyHash, opHash))
      .limit(1);
    if (replay) {
      if (replay.createRequestHash !== requestHash)
        throw new PartnerPortalSchedulingError(
          "idempotency_conflict",
          "That request key was already used.",
          { status: 409 },
        );
      const storedRows = await tx
        .select()
        .from(partnerBulkImportRows)
        .where(
          and(
            eq(partnerBulkImportRows.partnerAccountId, input.actor.accountId),
            eq(partnerBulkImportRows.partnerBulkImportId, replay.id),
          ),
        )
        .orderBy(asc(partnerBulkImportRows.rowNumber));
      return { batch: replay, storedRows, replayed: true };
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
        updatedAt: new Date(),
      })
      .returning();
    if (!batch) throw new Error("partner_bulk_import_create_failed");
    const storedRows = await tx
      .insert(partnerBulkImportRows)
      .values(
        rows.map((row) => ({
          partnerAccountId: input.actor.accountId,
          partnerBulkImportId: batch.id,
          rowNumber: row.rowNumber,
          normalizedData: row.normalized as unknown as Record<
            string,
            unknown
          > | null,
          errors: row.errors.map((issue) => ({ ...issue })),
          state: row.normalized
            ? input.dryRun
              ? "pending"
              : "review"
            : "invalid",
        })),
      )
      .returning();
    return { batch, storedRows, replayed: false };
  });
  if (!input.dryRun && !initial.replayed) {
    const sourceByRow = new Map(rows.map((row) => [row.rowNumber, row]));
    for (const stored of initial.storedRows) {
      const row = sourceByRow.get(stored.rowNumber);
      if (!row?.normalized) continue;
      try {
        const created = await createPartnerBookingDraft({
          actor: input.actor,
          mutation: {
            locationId: row.normalized.locationId,
            serviceKey: row.normalized.serviceKey,
            scope: { ...row.normalized.scope },
            description: row.normalized.description,
            crewInstructions: row.normalized.crewInstructions,
            accessDetails: null,
            onSiteContact: { ...row.normalized.onSiteContact },
            proofRequirements: { ...row.normalized.proofRequirements },
            commercial: { ...row.normalized.commercial },
            preferredWindows: [
              {
                localDate: row.normalized.preferredDate,
                timeOfDay: row.normalized.preferredWindowStart
                  ? Number(row.normalized.preferredWindowStart.slice(0, 2)) < 12
                    ? "morning"
                    : "afternoon"
                  : "anytime",
                timezone: row.normalized.timezone,
              },
            ],
          },
          idempotencyKeyHash: sha256("bulk-draft", stored.id),
        });
        await getDb()
          .update(partnerBulkImportRows)
          .set({
            bookingDraftId: created.draft.id,
            state: "review",
            errors: [
              {
                field: "status",
                message:
                  "Draft created. Open it to select a live arrival window and confirm; no capacity is reserved yet.",
              },
            ],
          })
          .where(
            and(
              eq(partnerBulkImportRows.partnerAccountId, input.actor.accountId),
              eq(partnerBulkImportRows.id, stored.id),
            ),
          );
      } catch (error) {
        await getDb()
          .update(partnerBulkImportRows)
          .set({
            state: "failed",
            errors: [
              {
                field: "status",
                message:
                  error instanceof PartnerPortalSchedulingError
                    ? error.message
                    : "Draft creation failed. Try this row again.",
              },
            ],
          })
          .where(
            and(
              eq(partnerBulkImportRows.partnerAccountId, input.actor.accountId),
              eq(partnerBulkImportRows.id, stored.id),
            ),
          );
      }
    }
    await getDb()
      .update(partnerBulkImports)
      .set({
        state: "completed",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(partnerBulkImports.partnerAccountId, input.actor.accountId),
          eq(partnerBulkImports.id, initial.batch.id),
        ),
      );
  }
  const finalRows = await getDb()
    .select()
    .from(partnerBulkImportRows)
    .where(
      and(
        eq(partnerBulkImportRows.partnerAccountId, input.actor.accountId),
        eq(partnerBulkImportRows.partnerBulkImportId, initial.batch.id),
      ),
    )
    .orderBy(asc(partnerBulkImportRows.rowNumber));
  if (!initial.replayed)
    await audit({
      principal: input.principal,
      correlationId: input.correlationId,
      action: input.dryRun
        ? "partner.portal.v2.bulk_import.validated"
        : "partner.portal.v2.bulk_import.committed",
      entityType: "partner_bulk_import",
      entityId: initial.batch.id,
      permission: "bookings.create",
      idempotencyKeyHash: opHash,
      meta: {
        rowCount: rows.length,
        validCount: rows.filter((row) => row.normalized).length,
        dryRun: input.dryRun,
      },
    });
  return {
    import: {
      id: initial.batch.id,
      state: input.dryRun ? "validated" : "completed",
      dryRun: input.dryRun,
      rowCount: rows.length,
      validCount: rows.filter((row) => row.normalized).length,
      errorCount: rows.filter((row) => !row.normalized).length,
      rows: finalRows.map((row) => ({
        rowNumber: row.rowNumber,
        state: row.state,
        draftId: row.bookingDraftId,
        errors: row.errors,
      })),
      correctionCsv: correctionCsv(rows),
      capacityReserved: false,
    },
    replayed: initial.replayed,
  };
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
