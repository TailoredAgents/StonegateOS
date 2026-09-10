import { teamSurfaceHref } from "./surface-registry";

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
  return teamSurfaceHref("partners", { query: params });
}
