import { teamSurfaceHref } from "./surface-registry";
import { safeTeamReturnPath } from "@myst-os/sdk";
import { hasTeamPermissionValue } from "../../lib/team-permissions";
import {
  outboundSubviewHrefFromReturn,
  parseOutboundReturnHref,
} from "./outbound-navigation";
import type { PartnerCompanySection } from "./partner-company-navigation";
import type { Route } from "next";

export const PARTNER_ADMINISTRATION_VIEWS = [
  "requests",
  "administration",
  "account-merges",
  "accounts",
  "operations",
  "applications",
  "billing-disputes",
  "cancellation-requests",
  "change-requests",
  "commercial",
  "domains",
  "people",
  "memberships",
  "invitations",
  "join-requests",
  "location-reviews",
  "quarantine",
  "security",
  "relationships",
] as const;

export type PartnerAdministrationView =
  (typeof PARTNER_ADMINISTRATION_VIEWS)[number];

export const PARTNER_SCHEDULING_HREF = "/team/partners/scheduling" as Route;

/** Accept an internal Team origin while preventing a Partner-to-Partner loop. */
export function safePartnerReturnPath(value: unknown): string | null {
  const returnTo = safeTeamReturnPath(value);
  if (!returnTo) return null;
  const target = new URL(returnTo, "https://team-return.invalid");
  if (
    target.pathname === "/team/partners" ||
    target.pathname.startsWith("/team/partners/") ||
    target.pathname === "/team/sales/outbound/partners" ||
    (target.pathname === "/team" &&
      target.searchParams.get("tab") === "partners")
  ) {
    return null;
  }
  return returnTo;
}

export function partnerSchedulingHref(returnTo?: unknown): Route {
  const safeReturnTo = safePartnerReturnPath(returnTo);
  if (!safeReturnTo) return PARTNER_SCHEDULING_HREF;
  const query = new URLSearchParams({ p_return: safeReturnTo });
  return `${PARTNER_SCHEDULING_HREF}?${query.toString()}` as Route;
}

export function partnerAdministrationHref(input: {
  view: PartnerAdministrationView;
  q?: string;
  status?: string;
  cursor?: string;
  selectedId?: string;
  selectedUserId?: string;
  companyId?: string;
  companySection?: PartnerCompanySection;
  setup?: "create" | "existing";
  hash?: string;
  returnTo?: unknown;
}): ReturnType<typeof teamSurfaceHref> {
  const query = new URLSearchParams({ p_admin: input.view });
  if (input.q) query.set("p_admin_q", input.q);
  if (input.status) query.set("p_admin_status", input.status);
  if (input.cursor) query.set("p_admin_cursor", input.cursor);
  const selectedId = input.selectedId ?? input.selectedUserId;
  if (selectedId) query.set("p_selected", selectedId);
  if (input.companyId) query.set("p_company", input.companyId);
  if (input.companySection)
    query.set("p_company_section", input.companySection);
  if (input.setup) query.set("p_setup", input.setup);
  const returnTo = safePartnerReturnPath(input.returnTo);
  if (returnTo) query.set("p_return", returnTo);
  return teamSurfaceHref("partners", { query, hash: input.hash });
}

export type PartnerRelationshipFilters = {
  status?: string;
  ownerId?: string;
  type?: string;
  q?: string;
  cursor?: string;
  selectedId?: string;
  preview?: string;
  previewJobId?: string;
  outboundReturn?: string;
  returnTo?: string;
};

/** Legacy relationship bookmarks stay in their own view after any interaction. */
export function partnerRelationshipsHref(args: {
  filters: PartnerRelationshipFilters;
  patch?: Partial<PartnerRelationshipFilters>;
}) {
  const merged = { ...args.filters, ...args.patch };
  const query = new URLSearchParams({ p_admin: "relationships" });
  const fields = {
    p_status: merged.status,
    p_owner: merged.ownerId,
    p_type: merged.type,
    p_q: merged.q,
    p_cursor: merged.cursor,
    p_selected: merged.selectedId,
    p_preview: merged.preview,
    p_preview_job: merged.previewJobId,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value?.trim()) query.set(key, value.trim());
  }
  const legacyReturn = parseOutboundReturnHref(merged.outboundReturn);
  if (legacyReturn) {
    query.set(
      "out_return",
      String(
        outboundSubviewHrefFromReturn(merged.outboundReturn, legacyReturn.view),
      ),
    );
  }
  const returnTo = safePartnerReturnPath(merged.returnTo);
  if (returnTo) query.set("p_return", returnTo);
  return teamSurfaceHref("partners", { query });
}

/** Never derive a portal company from a CRM contact or carry its identifiers. */
export function partnerCompanyAccessHref(returnTo?: unknown) {
  return partnerAdministrationHref({
    view: "accounts",
    setup: "existing",
    hash: "partner-relationship-setup-heading",
    returnTo,
  });
}

export function partnerAccessCapabilities(permissions: readonly string[]) {
  const canReadPartners = hasTeamPermissionValue(
    permissions,
    "partners.accounts.read",
  );
  return {
    canReadPartners,
    canInvitePartners:
      canReadPartners &&
      hasTeamPermissionValue(permissions, "partners.invitations.send"),
  };
}
