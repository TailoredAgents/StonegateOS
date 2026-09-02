import fs from "node:fs";
import path from "node:path";
import {
  findPartnerServiceEntitlement,
  isPartnerAgreementEffective,
  PartnerAccountServiceAgreementMutationSchema,
  partnerPricingStateAllowsInstantConfirmation,
  partnerPricingStateRequiresRate,
  parsePersistedPartnerServiceEntitlements,
} from "@/lib/partner-account-service-agreement";

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const SERVICE = Object.freeze({
  serviceKey: "junk-removal",
  pricingState: "contracted" as const,
  inclusions: ["One scheduled load"],
  exclusions: ["Hazardous material"],
  quoteRule: "A scope discrepancy requires a revised quote.",
});

describe("Partner account service agreement", () => {
  it("accepts one bounded effective account currency and rejects duplicate services", () => {
    const valid = {
      active: true,
      agreementLabel: "2026 commercial agreement",
      currency: "usd",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveTo: "2027-01-01T00:00:00.000Z",
      inclusions: ["Scheduled removal"],
      exclusions: ["Hazardous material"],
      quoteRules: "Material differences require a new written quote.",
      agreementDocumentId: null,
      services: [SERVICE],
    };
    expect(PartnerAccountServiceAgreementMutationSchema.parse(valid)).toEqual(
      expect.objectContaining({ currency: "USD", services: [SERVICE] }),
    );
    expect(
      PartnerAccountServiceAgreementMutationSchema.safeParse({
        ...valid,
        services: [SERVICE, SERVICE],
      }).success,
    ).toBe(false);
    expect(
      PartnerAccountServiceAgreementMutationSchema.safeParse({
        ...valid,
        currency: "US dollars",
      }).success,
    ).toBe(false);
    expect(
      PartnerAccountServiceAgreementMutationSchema.safeParse({
        ...valid,
        effectiveTo: valid.effectiveFrom,
      }).success,
    ).toBe(false);
  });

  it("uses half-open effective periods and strict entitlement lookup", () => {
    const agreement = {
      active: true,
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      effectiveTo: new Date("2027-01-01T00:00:00.000Z"),
      services: [SERVICE],
    };
    expect(
      isPartnerAgreementEffective(
        agreement,
        new Date("2026-01-01T00:00:00.000Z"),
      ),
    ).toBe(true);
    expect(
      isPartnerAgreementEffective(
        agreement,
        new Date("2027-01-01T00:00:00.000Z"),
      ),
    ).toBe(false);
    expect(findPartnerServiceEntitlement(agreement, "junk-removal")).toBe(
      SERVICE,
    );
    expect(findPartnerServiceEntitlement(agreement, "moving")).toBeNull();
  });

  it("allows instant confirmation only for contracted pricing", () => {
    expect(partnerPricingStateAllowsInstantConfirmation("contracted")).toBe(
      true,
    );
    for (const state of [
      "estimate",
      "quote_required",
      "standard_rate",
    ] as const) {
      expect(partnerPricingStateAllowsInstantConfirmation(state)).toBe(false);
    }
    expect(partnerPricingStateRequiresRate("quote_required")).toBe(false);
    expect(partnerPricingStateRequiresRate("estimate")).toBe(true);
  });

  it("fails closed on malformed persisted entitlement evidence", () => {
    expect(parsePersistedPartnerServiceEntitlements([SERVICE])).toEqual([
      SERVICE,
    ]);
    expect(
      parsePersistedPartnerServiceEntitlements([
        { ...SERVICE, pricingState: "free" },
      ]),
    ).toBeNull();
    expect(
      parsePersistedPartnerServiceEntitlements([SERVICE, SERVICE]),
    ).toBeNull();
  });

  it("enforces the agreement inside draft validation, availability, and booking snapshots", () => {
    const scheduling = source(
      "src/lib/partner-portal-v2-scheduling/service.ts",
    );
    expect(scheduling).toContain("assertAccountServiceTier");
    expect(scheduling).toContain("requirePartnerServiceEntitlement");
    expect(scheduling).toContain(
      "Choose a service from the current account agreement",
    );
    expect(scheduling).toContain(
      "Account pricing cannot be verified in the agreement currency",
    );
    expect(scheduling).toContain(
      "partnerPricingStateAllowsInstantConfirmation",
    );
    expect(scheduling).toContain("agreementRevision");
    expect(scheduling).toContain("agreementEffectiveFrom");
    expect(scheduling).toContain("agreementEffectiveTo");
  });

  it("gives Staff a guarded CAS writer and Partner users a sanitized agreement presentation", () => {
    const route = source(
      "app/api/admin/partner-management/v1/accounts/[accountId]/service-agreement/route.ts",
    );
    const catalog = source("app/api/portal/v2/service-catalog/route.ts");
    const writer = source(
      "src/lib/partner-account-service-agreement-administration.ts",
    );
    expect(route).toContain(
      'requiredPermissions: ["partners.commercial.manage"]',
    );
    expect(route).toContain("maxAuthenticationAgeSeconds: 15 * 60");
    expect(route).toContain("requiresIdempotency: true");
    expect(route).toContain("readBoundedJsonRequest");
    expect(route).toContain("mutation.expectedVersion");
    expect(route).toContain("mutation.audit.insertSuccess");
    expect(writer).toContain('.for("update")');
    expect(writer).toContain("partnerAccountServiceAgreements.revision");
    expect(catalog).toContain("loadPartnerAgreementPresentation");
    expect(catalog).not.toContain("orgContactId");
  });

  it("binds material job changes to one exact issued Quote V2 and applies only safe public fields", () => {
    const changeOrder = source("src/lib/partner-job-change-orders.ts");
    const decision = source(
      "app/api/admin/partner-management/v1/change-requests/[requestId]/decision/route.ts",
    );
    const migration = source(
      "src/db/migrations/0159_partner_commercial_agreement_and_change_orders.sql",
    );
    expect(decision).toContain("partnerQuoteId");
    expect(decision).toContain("Choose the issued fixed-price Quote V2");
    expect(changeOrder).toContain("eq(partnerQuotes.partnerAccountId");
    expect(changeOrder).toContain("eq(partnerQuotes.partnerBookingId");
    expect(changeOrder).toContain('eq(partnerQuotes.authority, "quote_v2")');
    expect(changeOrder).toContain('eq(quotes.engineVersion, "v2")');
    expect(changeOrder).toContain("quoteContentHash");
    expect(changeOrder).toContain("applySafePublicFields");
    expect(changeOrder).toContain("pendingOperationalEffects");
    expect(changeOrder).toContain("job.change_order_accepted");
    expect(migration).toContain(
      'CONSTRAINT "partner_job_change_orders_request_account_job_fk"',
    );
    expect(migration).toContain(
      'CONSTRAINT "partner_job_change_orders_quote_account_job_fk"',
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "partner_job_change_orders_active_booking_key"',
    );
    expect(migration).toContain("partner_job_change_order_evidence_immutable");
  });
});
