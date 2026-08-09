import { createHash } from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { DatabaseClient } from "@/db";
import { contacts, crmPipeline, teamInboxNewLeadAcknowledgements } from "@/db";

export const INBOX_NEW_LEAD_ACKNOWLEDGEMENT_TTL_MS = 24 * 60 * 60 * 1_000;
export const INBOX_NEW_LEAD_ACKNOWLEDGEMENT_TTL_SECONDS =
  INBOX_NEW_LEAD_ACKNOWLEDGEMENT_TTL_MS / 1_000;

const MAX_NAME_PART_LENGTH = 100;
const MAX_PHONE_LENGTH = 32;
const E164_PATTERN = /^\+[1-9][0-9]{9,14}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type InboxNewLeadVersionSource = {
  contactId: string;
  contactUpdatedAt: Date;
  pipelineUpdatedAt: Date;
};

export type InboxNewLeadFeedRow = InboxNewLeadVersionSource & {
  firstName: string;
  lastName: string;
  phone: string | null;
  phoneE164: string | null;
  total: number | string;
};

export type InboxNewLeadFeed = {
  ok: true;
  generatedAt: string;
  acknowledgementTtlSeconds: number;
  total: number;
  next: {
    contactId: string;
    name: string;
    phone: string | null;
    phoneE164: string | null;
    pipelineStage: "new";
    pipelineVersion: string;
    version: string;
  } | null;
};

export class InboxNewLeadDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboxNewLeadDataError";
  }
}

export function isInboxNewLeadUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function inboxNewLeadAcknowledgementExpiry(acknowledgedAt: Date): Date {
  if (Number.isNaN(acknowledgedAt.getTime())) {
    throw new InboxNewLeadDataError(
      "The acknowledgement timestamp is invalid.",
    );
  }
  return new Date(
    acknowledgedAt.getTime() + INBOX_NEW_LEAD_ACKNOWLEDGEMENT_TTL_MS,
  );
}

export function isInboxNewLeadAcknowledgementActive(
  expiresAt: Date,
  now: Date,
): boolean {
  if (Number.isNaN(expiresAt.getTime()) || Number.isNaN(now.getTime())) {
    throw new InboxNewLeadDataError(
      "The acknowledgement expiry comparison is invalid.",
    );
  }
  return expiresAt.getTime() > now.getTime();
}

export function isNonOutboundInboxLeadSource(source: string | null): boolean {
  return !(source ?? "").toLowerCase().startsWith("outbound:");
}

export function inboxNewLeadVersion(source: InboxNewLeadVersionSource): string {
  if (
    !isInboxNewLeadUuid(source.contactId) ||
    Number.isNaN(source.contactUpdatedAt.getTime()) ||
    Number.isNaN(source.pipelineUpdatedAt.getTime())
  ) {
    throw new InboxNewLeadDataError(
      "The new-lead eligibility version source is invalid.",
    );
  }
  return createHash("sha256")
    .update(
      [
        "inbox-new-lead-v1",
        source.contactId.toLowerCase(),
        source.contactUpdatedAt.toISOString(),
        source.pipelineUpdatedAt.toISOString(),
      ].join("\u0000"),
      "utf8",
    )
    .digest("hex");
}

function strictBoundedText(
  value: unknown,
  field: string,
  maximumLength: number,
  nullable: boolean,
): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== "string" || value.length > maximumLength) {
    throw new InboxNewLeadDataError(
      `The new-lead ${field} value is malformed.`,
    );
  }
  return value;
}

function exactEligibleTotal(value: number | string): number {
  const total = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(total) || total < 1) {
    throw new InboxNewLeadDataError("The exact new-lead total is malformed.");
  }
  return total;
}

export function toInboxNewLeadFeed(
  row: InboxNewLeadFeedRow | undefined,
  generatedAt: Date,
): InboxNewLeadFeed {
  if (Number.isNaN(generatedAt.getTime())) {
    throw new InboxNewLeadDataError("The new-lead feed timestamp is invalid.");
  }
  if (!row) {
    return {
      ok: true,
      generatedAt: generatedAt.toISOString(),
      acknowledgementTtlSeconds: INBOX_NEW_LEAD_ACKNOWLEDGEMENT_TTL_SECONDS,
      total: 0,
      next: null,
    };
  }

  const firstName = strictBoundedText(
    row.firstName,
    "first name",
    MAX_NAME_PART_LENGTH,
    false,
  );
  const lastName = strictBoundedText(
    row.lastName,
    "last name",
    MAX_NAME_PART_LENGTH,
    false,
  );
  const phone = strictBoundedText(row.phone, "phone", MAX_PHONE_LENGTH, true);
  const rawPhoneE164 = strictBoundedText(
    row.phoneE164,
    "canonical phone",
    MAX_PHONE_LENGTH,
    true,
  );
  // Legacy rows may predate canonical phone enforcement. Never label or emit
  // a malformed value as E.164; the untrusted display phone remains separate.
  const phoneE164 =
    rawPhoneE164 && E164_PATTERN.test(rawPhoneE164) ? rawPhoneE164 : null;
  const name = `${firstName ?? ""} ${lastName ?? ""}`.trim() || "New lead";

  return {
    ok: true,
    generatedAt: generatedAt.toISOString(),
    acknowledgementTtlSeconds: INBOX_NEW_LEAD_ACKNOWLEDGEMENT_TTL_SECONDS,
    total: exactEligibleTotal(row.total),
    next: {
      contactId: row.contactId,
      name,
      phone,
      phoneE164,
      pipelineStage: "new",
      pipelineVersion: row.pipelineUpdatedAt.toISOString(),
      version: inboxNewLeadVersion(row),
    },
  };
}

/**
 * Load one bounded lead plus an exact total over the full eligible result set.
 * The active acknowledgement join is scoped to both the verified member and
 * the exact contact, so acknowledging contact A cannot suppress contact B.
 */
export async function loadInboxNewLeadFeed(
  db: DatabaseClient,
  teamMemberId: string,
  now = new Date(),
): Promise<InboxNewLeadFeed> {
  if (!isInboxNewLeadUuid(teamMemberId) || Number.isNaN(now.getTime())) {
    throw new InboxNewLeadDataError(
      "The verified new-lead feed principal is invalid.",
    );
  }

  const [row] = await db
    .select({
      contactId: contacts.id,
      firstName: sql<string>`left(${contacts.firstName}, ${MAX_NAME_PART_LENGTH})`,
      lastName: sql<string>`left(${contacts.lastName}, ${MAX_NAME_PART_LENGTH})`,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164,
      contactUpdatedAt: contacts.updatedAt,
      pipelineUpdatedAt: crmPipeline.updatedAt,
      total: sql<number>`count(*) over()`,
    })
    .from(contacts)
    .innerJoin(crmPipeline, eq(crmPipeline.contactId, contacts.id))
    .leftJoin(
      teamInboxNewLeadAcknowledgements,
      and(
        eq(teamInboxNewLeadAcknowledgements.teamMemberId, teamMemberId),
        eq(teamInboxNewLeadAcknowledgements.contactId, contacts.id),
        gt(teamInboxNewLeadAcknowledgements.expiresAt, now),
      ),
    )
    .where(
      and(
        isNull(contacts.deletedAt),
        eq(crmPipeline.stage, "new"),
        sql`coalesce(${contacts.source}, '') not ilike 'outbound:%'`,
        isNull(teamInboxNewLeadAcknowledgements.id),
      ),
    )
    .orderBy(
      desc(contacts.updatedAt),
      desc(crmPipeline.updatedAt),
      desc(contacts.id),
    )
    .limit(1);

  return toInboxNewLeadFeed(row, now);
}
