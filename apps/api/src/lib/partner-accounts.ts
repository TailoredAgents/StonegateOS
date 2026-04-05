import { and, eq, sql } from "drizzle-orm";
import { contacts, crmTasks, getDb, partnerAccounts } from "@/db";

type DatabaseClient = ReturnType<typeof getDb>;
type TransactionExecutor = Parameters<DatabaseClient["transaction"]>[0] extends (
  tx: infer Tx,
) => Promise<unknown>
  ? Tx
  : never;
type DbExecutor = DatabaseClient | TransactionExecutor;

export type ResolvePartnerAccountInput = {
  name?: string | null;
  domain?: string | null;
  website?: string | null;
  city?: string | null;
  state?: string | null;
  source?: string | null;
  sourceCampaign?: string | null;
  sourceListName?: string | null;
  ownerMemberId?: string | null;
  notes?: string | null;
};

function readText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

export function normalizePartnerAccountName(value: string | null | undefined): string | null {
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

export function normalizePartnerAccountDomain(value: string | null | undefined): string | null {
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
  return candidate.length ? candidate : null;
}

function coalesceAccountName(input: ResolvePartnerAccountInput): string | null {
  const explicit = readText(input.name);
  if (explicit) return explicit;

  const normalizedDomain = normalizePartnerAccountDomain(input.domain ?? input.website ?? null);
  if (!normalizedDomain) return null;
  return normalizedDomain;
}

async function findExistingPartnerAccount(
  db: DbExecutor,
  input: { normalizedName: string | null; domain: string | null; city: string | null; state: string | null },
): Promise<
  | {
      id: string;
      status: string;
      name: string;
      normalizedName: string;
      domain: string | null;
      website: string | null;
      city: string | null;
      state: string | null;
      ownerMemberId: string | null;
      source: string | null;
      sourceCampaign: string | null;
      sourceListName: string | null;
      notes: string | null;
    }
  | null
> {
  if (input.domain) {
    const [byDomain] = await db
      .select({
        id: partnerAccounts.id,
        status: partnerAccounts.status,
        name: partnerAccounts.name,
        normalizedName: partnerAccounts.normalizedName,
        domain: partnerAccounts.domain,
        website: partnerAccounts.website,
        city: partnerAccounts.city,
        state: partnerAccounts.state,
        ownerMemberId: partnerAccounts.ownerMemberId,
        source: partnerAccounts.source,
        sourceCampaign: partnerAccounts.sourceCampaign,
        sourceListName: partnerAccounts.sourceListName,
        notes: partnerAccounts.notes,
      })
      .from(partnerAccounts)
      .where(eq(partnerAccounts.domain, input.domain))
      .limit(1);
    if (byDomain?.id) return byDomain;
  }

  if (!input.normalizedName) return null;

  const filters = [eq(partnerAccounts.normalizedName, input.normalizedName)];
  if (input.city) filters.push(sql`lower(coalesce(${partnerAccounts.city}, '')) = ${input.city.toLowerCase()}`);
  if (input.state) filters.push(sql`lower(coalesce(${partnerAccounts.state}, '')) = ${input.state.toLowerCase()}`);

  const [byName] = await db
    .select({
      id: partnerAccounts.id,
      status: partnerAccounts.status,
      name: partnerAccounts.name,
      normalizedName: partnerAccounts.normalizedName,
      domain: partnerAccounts.domain,
      website: partnerAccounts.website,
      city: partnerAccounts.city,
      state: partnerAccounts.state,
      ownerMemberId: partnerAccounts.ownerMemberId,
      source: partnerAccounts.source,
      sourceCampaign: partnerAccounts.sourceCampaign,
      sourceListName: partnerAccounts.sourceListName,
      notes: partnerAccounts.notes,
    })
    .from(partnerAccounts)
    .where(and(...filters))
    .limit(1);

  return byName ?? null;
}

export async function resolveOrCreatePartnerAccount(
  db: DbExecutor,
  input: ResolvePartnerAccountInput,
): Promise<{ id: string; name: string; status: string } | null> {
  const name = coalesceAccountName(input);
  const normalizedName = normalizePartnerAccountName(name);
  const domain = normalizePartnerAccountDomain(input.domain ?? input.website ?? null);
  const website = readText(input.website);
  const city = readText(input.city);
  const state = readText(input.state)?.toUpperCase() ?? null;
  const source = readText(input.source);
  const sourceCampaign = readText(input.sourceCampaign);
  const sourceListName = readText(input.sourceListName);
  const ownerMemberId = readText(input.ownerMemberId);
  const notes = readText(input.notes);

  if (!name || !normalizedName) return null;

  const existing = await findExistingPartnerAccount(db, {
    normalizedName,
    domain,
    city,
    state,
  });

  const now = new Date();
  if (existing?.id) {
    const patch: Partial<typeof partnerAccounts.$inferInsert> = {};
    if (!existing.domain && domain) patch.domain = domain;
    if (!existing.website && website) patch.website = website;
    if (!existing.city && city) patch.city = city;
    if (!existing.state && state) patch.state = state;
    if (!existing.ownerMemberId && ownerMemberId) patch.ownerMemberId = ownerMemberId;
    if (!existing.source && source) patch.source = source;
    if (!existing.sourceCampaign && sourceCampaign) patch.sourceCampaign = sourceCampaign;
    if (!existing.sourceListName && sourceListName) patch.sourceListName = sourceListName;
    if (!existing.notes && notes) patch.notes = notes;

    if (Object.keys(patch).length > 0) {
      await db
        .update(partnerAccounts)
        .set({ ...patch, updatedAt: now })
        .where(eq(partnerAccounts.id, existing.id));
    }

    return { id: existing.id, name: existing.name, status: existing.status };
  }

  const [created] = await db
    .insert(partnerAccounts)
    .values({
      name,
      normalizedName,
      domain,
      website,
      city,
      state,
      ownerMemberId,
      source,
      sourceCampaign,
      sourceListName,
      notes,
      status: "imported",
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

  if (readText(input.status)) patch.status = input.status as typeof partnerAccounts.$inferInsert.status;
  if (readText(input.lastDisposition)) patch.lastDisposition = input.lastDisposition;
  if (input.lastTouchAt !== undefined) patch.lastTouchAt = input.lastTouchAt;
  if (input.nextTouchAt !== undefined) patch.nextTouchAt = input.nextTouchAt;

  await db
    .update(partnerAccounts)
    .set(patch)
    .where(eq(partnerAccounts.id, input.partnerAccountId));
}
