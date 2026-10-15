import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { contacts, partnerAccounts } from "@/db";

export const ACTIVE_OUTBOUND_ACCOUNT_STATUSES = [
  "imported",
  "ready_for_first_touch",
  "attempting_contact",
  "conversation_active",
  "qualified_partner",
] as const;

export type InboxThreadScope = "outbound" | null;

export type OutboundProspectScopeFilters = {
  campaign?: string | null;
  memberId?: string | null;
};

export function parseInboxThreadScope(
  value: string | null,
): { ok: true; scope: InboxThreadScope } | { ok: false } {
  if (value === null || value === "") return { ok: true, scope: null };
  return value === "outbound" ? { ok: true, scope: "outbound" } : { ok: false };
}

/** Active imported prospects only. History remains available in the normal Inbox. */
export function activeOutboundProspectCondition(
  filters: OutboundProspectScopeFilters = {},
) {
  return and(
    isNotNull(contacts.id),
    isNotNull(partnerAccounts.id),
    inArray(partnerAccounts.status, ACTIVE_OUTBOUND_ACCOUNT_STATUSES),
    or(
      sql`lower(coalesce(${partnerAccounts.source}, '')) like 'outbound:%'`,
      isNotNull(partnerAccounts.sourceCampaign),
      sql`lower(coalesce(${contacts.source}, '')) like 'outbound:%'`,
    ),
    filters.campaign
      ? sql`lower(coalesce(${partnerAccounts.sourceCampaign}, '')) = lower(${filters.campaign})`
      : undefined,
    filters.memberId
      ? eq(partnerAccounts.ownerMemberId, filters.memberId)
      : undefined,
  );
}
