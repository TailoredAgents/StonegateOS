import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { getDb } from "@/db";
import { contacts, crmTasks, partnerAccounts } from "@/db";
import { TeamMutationFailure } from "@/lib/team-mutation";

type DatabaseClient = ReturnType<typeof getDb>;
type TransactionExecutor = Parameters<
  DatabaseClient["transaction"]
>[0] extends (tx: infer Tx) => Promise<unknown>
  ? Tx
  : never;
type DbExecutor = DatabaseClient | TransactionExecutor;

export type ResolvePartnerAccountInput = {
  existingAccountId?: string | null;
  name?: string | null;
  domain?: string | null;
  website?: string | null;
  segment?: string | null;
  subsegment?: string | null;
  city?: string | null;
  state?: string | null;
  source?: string | null;
  sourceCampaign?: string | null;
  sourceListName?: string | null;
  externalCompanyId?: string | null;
  externalLocationId?: string | null;
  importedStatus?: string | null;
  outreachPriority?: string | null;
  importedNextAction?: string | null;
  importedEmailStatus?: string | null;
  status?: typeof partnerAccounts.$inferInsert.status;
  lastDisposition?: string | null;
  nextTouchAt?: Date | null;
  ownerMemberId?: string | null;
  notes?: string | null;
};

const PUBLIC_EMAIL_DOMAINS = new Set([
  "aol.com",
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "mail.com",
  "msn.com",
  "outlook.com",
  "proton.me",
  "protonmail.com",
  "yahoo.com",
  "ymail.com",
]);

function isPublicEmailDomain(value: string): boolean {
  return Array.from(PUBLIC_EMAIL_DOMAINS).some(
    (domain) => value === domain || value.endsWith(`.${domain}`),
  );
}

function readText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

export function normalizePartnerAccountName(
  value: string | null | undefined,
): string | null {
  const trimmed = readText(value);
  if (!trimmed) return null;
  return trimmed
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripCommonSubdomain(value: string): string {
  return value.replace(/^(www|m)\./i, "");
}

export function normalizePartnerAccountDomain(
  value: string | null | undefined,
): string | null {
  const trimmed = readText(value);
  if (!trimmed) return null;

  let candidate = trimmed.toLowerCase();
  if (candidate.includes("://")) {
    try {
      candidate = new URL(candidate).hostname.toLowerCase();
    } catch {
      candidate = candidate.replace(/^https?:\/\//i, "");
    }
  }

  candidate = candidate.replace(/^mailto:/i, "");
  if (candidate.includes("@")) {
    const [, emailDomain] = candidate.split("@");
    candidate = emailDomain ?? candidate;
  }

  candidate = stripCommonSubdomain(candidate).replace(/\/.*$/, "").trim();
  return candidate.length && !isPublicEmailDomain(candidate) ? candidate : null;
}

function coalesceAccountName(input: ResolvePartnerAccountInput): string | null {
  const explicit = readText(input.name);
  if (explicit) return explicit;

  const normalizedDomain = normalizePartnerAccountDomain(
    input.domain ?? input.website ?? null,
  );
  if (!normalizedDomain) return null;
  return normalizedDomain;
}

function importedStatusUpdate(
  current: typeof partnerAccounts.$inferSelect.status,
  requested: typeof partnerAccounts.$inferInsert.status | undefined,
): typeof partnerAccounts.$inferInsert.status | null {
  if (!requested || requested === current) return null;
  if (protectsLivePartnerWorkflow(current)) {
    return null;
  }
  const rank: Partial<
    Record<typeof partnerAccounts.$inferSelect.status, number>
  > = {
    imported: 0,
    ready_for_first_touch: 1,
    attempting_contact: 2,
    conversation_active: 3,
    qualified_partner: 4,
  };
  if (requested === "not_a_fit" || requested === "dormant") return requested;
  return (rank[requested] ?? -1) >= (rank[current] ?? -1) ? requested : null;
}

function protectsLivePartnerWorkflow(
  status: typeof partnerAccounts.$inferSelect.status,
): boolean {
  return [
    "trial_partner",
    "active_partner",
    "portal_partner",
    "managed_partner",
    "not_a_fit",
  ].includes(status);
}

async function findExistingPartnerAccount(
  db: DbExecutor,
  input: {
    existingAccountId: string | null;
    normalizedName: string | null;
    domain: string | null;
    city: string | null;
    state: string | null;
    externalCompanyId: string | null;
    externalLocationId: string | null;
  },
): Promise<{
  id: string;
  status: typeof partnerAccounts.$inferSelect.status;
  name: string;
  normalizedName: string;
  domain: string | null;
  website: string | null;
  segment: string | null;
  subsegment: string | null;
  city: string | null;
  state: string | null;
  ownerMemberId: string | null;
  source: string | null;
  sourceCampaign: string | null;
  sourceListName: string | null;
  externalCompanyId: string | null;
  externalLocationId: string | null;
  importedStatus: string | null;
  outreachPriority: string | null;
  importedNextAction: string | null;
  importedEmailStatus: string | null;
  lastDisposition: string | null;
  nextTouchAt: Date | null;
  notes: string | null;
} | null> {
  const selection = {
    id: partnerAccounts.id,
    status: partnerAccounts.status,
    name: partnerAccounts.name,
    normalizedName: partnerAccounts.normalizedName,
    domain: partnerAccounts.domain,
    website: partnerAccounts.website,
    segment: partnerAccounts.segment,
    subsegment: partnerAccounts.subsegment,
    city: partnerAccounts.city,
    state: partnerAccounts.state,
    ownerMemberId: partnerAccounts.ownerMemberId,
    source: partnerAccounts.source,
    sourceCampaign: partnerAccounts.sourceCampaign,
    sourceListName: partnerAccounts.sourceListName,
    externalCompanyId: partnerAccounts.externalCompanyId,
    externalLocationId: partnerAccounts.externalLocationId,
    importedStatus: partnerAccounts.importedStatus,
    outreachPriority: partnerAccounts.outreachPriority,
    importedNextAction: partnerAccounts.importedNextAction,
    importedEmailStatus: partnerAccounts.importedEmailStatus,
    lastDisposition: partnerAccounts.lastDisposition,
    nextTouchAt: partnerAccounts.nextTouchAt,
    notes: partnerAccounts.notes,
  };

  if (input.existingAccountId) {
    const [byId] = await db
      .select(selection)
      .from(partnerAccounts)
      .where(eq(partnerAccounts.id, input.existingAccountId))
      .limit(1);
    if (
      byId?.externalLocationId &&
      input.externalLocationId &&
      byId.externalLocationId !== input.externalLocationId
    ) {
      throw new TeamMutationFailure(
        "conflict",
        "The contact's current account has a different location ID. Nothing was changed.",
        { retryable: false },
      );
    }
    if (
      byId?.externalCompanyId &&
      input.externalCompanyId &&
      byId.externalCompanyId !== input.externalCompanyId
    ) {
      throw new TeamMutationFailure(
        "conflict",
        "The contact's current account has a different company ID. Nothing was changed.",
        { retryable: false },
      );
    }
    if (byId?.id) return byId;
  }

  if (input.externalLocationId) {
    const [byLocationId] = await db
      .select(selection)
      .from(partnerAccounts)
      .where(eq(partnerAccounts.externalLocationId, input.externalLocationId))
      .limit(1);
    if (
      byLocationId?.externalCompanyId &&
      input.externalCompanyId &&
      byLocationId.externalCompanyId !== input.externalCompanyId
    ) {
      throw new TeamMutationFailure(
        "conflict",
        "The supplied location ID already belongs to a different company ID. Nothing was changed.",
        { retryable: false },
      );
    }
    if (byLocationId?.id) return byLocationId;
  } else if (input.externalCompanyId) {
    const [byCompanyId] = await db
      .select(selection)
      .from(partnerAccounts)
      .where(eq(partnerAccounts.externalCompanyId, input.externalCompanyId))
      .limit(1);
    if (byCompanyId?.id) return byCompanyId;
  }

  if (input.normalizedName) {
    const filters = [eq(partnerAccounts.normalizedName, input.normalizedName)];
    if (input.city)
      filters.push(
        sql`lower(coalesce(${partnerAccounts.city}, '')) = ${input.city.toLowerCase()}`,
      );
    if (input.state)
      filters.push(
        sql`lower(coalesce(${partnerAccounts.state}, '')) = ${input.state.toLowerCase()}`,
      );
    if (input.externalLocationId) {
      filters.push(
        or(
          isNull(partnerAccounts.externalLocationId),
          eq(partnerAccounts.externalLocationId, input.externalLocationId),
        )!,
      );
    } else if (input.externalCompanyId) {
      filters.push(
        or(
          isNull(partnerAccounts.externalCompanyId),
          eq(partnerAccounts.externalCompanyId, input.externalCompanyId),
        )!,
      );
    }
    const [byName] = await db
      .select(selection)
      .from(partnerAccounts)
      .where(and(...filters))
      .limit(1);
    if (byName?.id) return byName;
  }

  // Domain is only a last-resort identity for rows without a location. Public
  // mailbox providers were already removed by normalizePartnerAccountDomain.
  if (
    input.domain &&
    !input.city &&
    !input.state &&
    !input.externalLocationId
  ) {
    const [byDomain] = await db
      .select(selection)
      .from(partnerAccounts)
      .where(eq(partnerAccounts.domain, input.domain))
      .limit(1);
    if (byDomain?.id) return byDomain;
  }
  return null;
}

export async function resolveOrCreatePartnerAccount(
  db: DbExecutor,
  input: ResolvePartnerAccountInput,
): Promise<{ id: string; name: string; status: string } | null> {
  const name = coalesceAccountName(input);
  const normalizedName = normalizePartnerAccountName(name);
  const domain = normalizePartnerAccountDomain(
    input.domain ?? input.website ?? null,
  );
  const website = readText(input.website);
  const segment = readText(input.segment);
  const subsegment = readText(input.subsegment);
  const city = readText(input.city);
  const state = readText(input.state)?.toUpperCase() ?? null;
  const source = readText(input.source);
  const sourceCampaign = readText(input.sourceCampaign);
  const sourceListName = readText(input.sourceListName);
  const ownerMemberId = readText(input.ownerMemberId);
  const notes = readText(input.notes);
  const externalCompanyId = readText(input.externalCompanyId);
  const externalLocationId = readText(input.externalLocationId);
  const importedStatus = readText(input.importedStatus);
  const outreachPriority = readText(input.outreachPriority);
  const importedNextAction = readText(input.importedNextAction);
  const importedEmailStatus = readText(input.importedEmailStatus);

  const existing = await findExistingPartnerAccount(db, {
    existingAccountId: readText(input.existingAccountId),
    normalizedName,
    domain,
    city,
    state,
    externalCompanyId,
    externalLocationId,
  });

  const now = new Date();
  if (existing?.id) {
    const patch: Partial<typeof partnerAccounts.$inferInsert> = {};
    if (!existing.domain && domain) patch.domain = domain;
    if (!existing.website && website) patch.website = website;
    if (!existing.segment && segment) patch.segment = segment;
    if (!existing.subsegment && subsegment) patch.subsegment = subsegment;
    if (!existing.city && city) patch.city = city;
    if (!existing.state && state) patch.state = state;
    if (!existing.ownerMemberId && ownerMemberId)
      patch.ownerMemberId = ownerMemberId;
    if (!existing.source && source) patch.source = source;
    if (!existing.sourceCampaign && sourceCampaign)
      patch.sourceCampaign = sourceCampaign;
    if (!existing.sourceListName && sourceListName)
      patch.sourceListName = sourceListName;
    if (!existing.externalCompanyId && externalCompanyId)
      patch.externalCompanyId = externalCompanyId;
    if (!existing.externalLocationId && externalLocationId)
      patch.externalLocationId = externalLocationId;
    if (importedStatus && existing.importedStatus !== importedStatus)
      patch.importedStatus = importedStatus;
    if (outreachPriority && existing.outreachPriority !== outreachPriority)
      patch.outreachPriority = outreachPriority;
    if (
      importedNextAction &&
      existing.importedNextAction !== importedNextAction
    )
      patch.importedNextAction = importedNextAction;
    if (
      importedEmailStatus &&
      existing.importedEmailStatus !== importedEmailStatus
    )
      patch.importedEmailStatus = importedEmailStatus;
    const nextStatus = importedStatusUpdate(existing.status, input.status);
    if (nextStatus) patch.status = nextStatus;
    const protectsWorkflow = protectsLivePartnerWorkflow(existing.status);
    if (
      input.lastDisposition &&
      existing.lastDisposition !== input.lastDisposition &&
      (!protectsWorkflow || !existing.lastDisposition)
    )
      patch.lastDisposition = input.lastDisposition;
    if (
      input.nextTouchAt &&
      existing.nextTouchAt?.getTime() !== input.nextTouchAt.getTime() &&
      (!protectsWorkflow || !existing.nextTouchAt)
    )
      patch.nextTouchAt = input.nextTouchAt;
    if (notes && !existing.notes?.includes(notes))
      patch.notes = existing.notes ? `${existing.notes}\n\n${notes}` : notes;

    if (Object.keys(patch).length > 0) {
      await db
        .update(partnerAccounts)
        .set({ ...patch, updatedAt: now })
        .where(eq(partnerAccounts.id, existing.id));
    }

    return { id: existing.id, name: existing.name, status: existing.status };
  }

  if (!name || !normalizedName) return null;

  const [created] = await db
    .insert(partnerAccounts)
    .values({
      name,
      normalizedName,
      domain,
      website,
      segment,
      subsegment,
      city,
      state,
      ownerMemberId,
      source,
      sourceCampaign,
      sourceListName,
      externalCompanyId,
      externalLocationId,
      importedStatus,
      outreachPriority,
      importedNextAction,
      importedEmailStatus,
      notes,
      status: input.status ?? "imported",
      lastDisposition: input.lastDisposition ?? null,
      nextTouchAt: input.nextTouchAt ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning({
      id: partnerAccounts.id,
      name: partnerAccounts.name,
      status: partnerAccounts.status,
    });

  return created ?? null;
}

export async function linkContactToPartnerAccount(
  db: DbExecutor,
  input: { contactId: string; partnerAccountId: string },
): Promise<void> {
  await db
    .update(contacts)
    .set({ partnerAccountId: input.partnerAccountId, updatedAt: new Date() })
    .where(eq(contacts.id, input.contactId));
}

export async function linkCrmTaskToPartnerAccount(
  db: DbExecutor,
  input: { taskId: string; partnerAccountId: string },
): Promise<void> {
  await db
    .update(crmTasks)
    .set({ partnerAccountId: input.partnerAccountId, updatedAt: new Date() })
    .where(eq(crmTasks.id, input.taskId));
}

export async function updatePartnerAccountAfterOutboundTouch(
  db: DbExecutor,
  input: {
    partnerAccountId: string;
    status?: string | null;
    lastDisposition?: string | null;
    lastTouchAt?: Date | null;
    nextTouchAt?: Date | null;
  },
): Promise<void> {
  const patch: Partial<typeof partnerAccounts.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (readText(input.status))
    patch.status = input.status as typeof partnerAccounts.$inferInsert.status;
  if (readText(input.lastDisposition))
    patch.lastDisposition = input.lastDisposition;
  if (input.lastTouchAt !== undefined) patch.lastTouchAt = input.lastTouchAt;
  if (input.nextTouchAt !== undefined) patch.nextTouchAt = input.nextTouchAt;

  await db
    .update(partnerAccounts)
    .set(patch)
    .where(eq(partnerAccounts.id, input.partnerAccountId));
}
