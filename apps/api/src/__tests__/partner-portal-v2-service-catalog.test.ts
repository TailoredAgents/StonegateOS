import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

function source(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf8");
}

describe("partner V2 scheduling-safe service catalog", () => {
  it("is capability-scoped, account-priced, and bounded", () => {
    const route = source("apps/api/app/api/portal/v2/service-catalog/route.ts");
    const service = source(
      "apps/api/src/lib/partner-portal-v2-service-catalog.ts",
    );
    expect(route).toContain(
      'requirePartnerCapability(\n      request,\n      "portal.session.read"',
    );
    expect(route).toContain('capabilities.includes("bookings.create")');
    expect(route).toContain("listPartnerServiceCatalog({");
    expect(route).toContain('capabilities.includes("rates.read")');
    expect(service).toContain("partnerServiceCatalog.active");
    expect(service).toContain("partnerSchedulingProfiles.active");
    expect(service).toContain(
      "eq(partnerRateCards.partnerAccountId, input.accountId)",
    );
    expect(service).toContain("partnerRateAddOnItems.rateCardId");
    expect(service).toContain("isPartnerAddOnTierKey");
    expect(service).toContain("if (services.length >= 100) break");
    expect(service).toContain("MAX_PARTNER_SERVICE_ADD_ONS");
    expect(service).toContain("allBaseOptionsContracted");
  });

  it("renders only the account-selected V2 catalog with canonical base options and add-ons", () => {
    const page = source("apps/site/src/app/partners/(portal)/book/page.tsx");
    const billing = source(
      "apps/site/src/app/partners/(portal)/billing/page.tsx",
    );
    const wizard = source(
      "apps/site/src/app/partners/components/PartnerBookingWizard.tsx",
    );
    expect(page).toContain("/api/portal/v2/service-catalog");
    expect(page).not.toContain("/api/portal/rates");
    expect(page).not.toContain("mergeServices(");
    expect(page).toContain(
      "const services = parseCatalogServices(catalogPayload)",
    );
    expect(page).toContain("parseCatalogBaseOptions");
    expect(page).toContain("parseCatalogAddOns");
    expect(billing).toContain("/api/portal/v2/service-catalog");
    expect(billing).not.toContain("/api/portal/rates");
    expect(billing).toContain("parsePartnerServiceRateCard");
    expect(wizard).toContain("Base service option");
    expect(wizard).toContain("Optional add-ons");
    expect(wizard).toContain("serializePartnerAddOnQuantities");
    expect(wizard).toContain("Stonegate review requested");
  });
});
