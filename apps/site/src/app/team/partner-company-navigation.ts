import { teamSurfaceHref } from "./surface-registry";
import { safePartnerReturnPath } from "./partner-entry-navigation";

export const PARTNER_COMPANY_SECTIONS = [
  "details",
  "people",
  "jobs",
  "billing",
  "settings",
] as const;
export type PartnerCompanySection = (typeof PARTNER_COMPANY_SECTIONS)[number];

export function normalizePartnerCompanySection(
  value: unknown,
): PartnerCompanySection {
  return PARTNER_COMPANY_SECTIONS.includes(value as PartnerCompanySection)
    ? (value as PartnerCompanySection)
    : "details";
}

export function partnerCompanyHref(
  accountId: string,
  section: PartnerCompanySection = "details",
  view?: string,
  returnTo?: unknown,
) {
  const params = new URLSearchParams({
    p_admin:
      view ??
      (section === "people"
        ? "memberships"
        : section === "billing"
          ? "commercial"
          : section === "jobs"
            ? "operations"
            : "accounts"),
    p_company: accountId,
    p_company_section: section,
  });
  const safeReturnTo = safePartnerReturnPath(returnTo);
  if (safeReturnTo) params.set("p_return", safeReturnTo);
  return teamSurfaceHref("partners", { query: params });
}
