import { teamSurfaceHref } from "./surface-registry";
import { hasTeamPermissionValue } from "../../lib/team-permissions";
import {
  outboundSubviewHrefFromReturn,
  parseOutboundReturnHref,
} from "./outbound-navigation";

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
  return teamSurfaceHref("partners", { query });
}

/** Never derive a portal company from a CRM contact or carry its identifiers. */
export function partnerCompanyAccessHref() {
  return teamSurfaceHref("partners", {
    query: { p_admin: "accounts", p_setup: "existing" },
    hash: "partner-relationship-setup-heading",
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
