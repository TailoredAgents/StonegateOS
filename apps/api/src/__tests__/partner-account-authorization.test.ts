import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PARTNER_CAPABILITY_CATALOG,
  PARTNER_INTRINSIC_CAPABILITIES,
  PARTNER_SYSTEM_ROLE_TEMPLATES,
  adaptPartnerPrincipalToLegacySession,
  computePartnerCapabilities,
  hasPartnerCapability,
  isPartnerV2MembershipEligible,
  normalizePartnerPersona,
  partnerAccessRequiresMfa,
  selectPartnerAccountAccess,
  type PartnerAccountAccess,
  type PartnerPrincipal,
} from "@/lib/partner-account-authorization";

function principal(
  overrides: Partial<PartnerPrincipal> = {},
): PartnerPrincipal {
  const now = new Date("2026-08-30T12:00:00.000Z");
  return {
    type: "partner",
    partnerUserId: "11111111-1111-4111-8111-111111111111",
    email: "partner@example.com",
    name: "Partner User",
    passwordSet: true,
    accountId: "22222222-2222-4222-8222-222222222222",
    accountName: "Partner Company",
    membershipId: "33333333-3333-4333-8333-333333333333",
    roleKey: "operations",
    persona: "property_manager",
    accessLevel: "account",
    accessScope: {},
    preferences: { timezone: "America/New_York" },
    legacyOrgContactId: "44444444-4444-4444-8444-444444444444",
    capabilities: ["portal.session.read", "bookings.read"],
    accessSource: "membership",
    session: {
      id: "55555555-5555-4555-8555-555555555555",
      authMethod: "password",
      assuranceLevel: "aal1",
      mfaVerifiedAt: null,
      deviceName: null,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date("2026-09-30T12:00:00.000Z"),
    },
    security: {
      mfaRequired: false,
      mfaEnrolled: false,
      mfaSatisfied: true,
    },
    availableAccounts: [],
    ...overrides,
  };
}

describe("partner account capability authorization", () => {
  it("keeps the capability registry unique and every system template bounded", () => {
    expect(new Set(PARTNER_CAPABILITY_CATALOG).size).toBe(
      PARTNER_CAPABILITY_CATALOG.length,
    );
    for (const capabilities of Object.values(PARTNER_SYSTEM_ROLE_TEMPLATES)) {
      expect(capabilities).toEqual(
        expect.arrayContaining([...PARTNER_INTRINSIC_CAPABILITIES]),
      );
      expect(
        capabilities.every((capability) =>
          PARTNER_CAPABILITY_CATALOG.includes(capability),
        ),
      ).toBe(true);
    }
    expect(PARTNER_SYSTEM_ROLE_TEMPLATES.administrator).toEqual(
      PARTNER_CAPABILITY_CATALOG,
    );
  });

  it("materializes known grants and makes exact or prefix denies win", () => {
    expect(
      computePartnerCapabilities({
        roleCapabilities: ["bookings.*", "unknown.superpower"],
        grants: ["reports.financial.read", "not_in_the_registry"],
        denies: ["bookings.cancel", "reports.*"],
      }),
    ).toEqual([
      "portal.session.read",
      "portal.session.switch_account",
      "bookings.read",
      "bookings.create",
      "bookings.update",
      "bookings.pricing.read",
    ]);
  });

  it("keeps self-session operations intrinsic even under a broad deny", () => {
    expect(
      computePartnerCapabilities({
        roleCapabilities: [],
        denies: ["*"],
      }),
    ).toEqual(PARTNER_INTRINSIC_CAPABILITIES);
  });

  it("checks only materialized capabilities", () => {
    const context = principal();
    expect(hasPartnerCapability(context, "bookings.read")).toBe(true);
    expect(hasPartnerCapability(context, "bookings.create")).toBe(false);
  });

  it("requires MFA for privileged role templates and equivalent custom authority", () => {
    expect(
      partnerAccessRequiresMfa({ roleKey: "administrator", capabilities: [] }),
    ).toBe(true);
    expect(
      partnerAccessRequiresMfa({
        roleKey: "custom_finance",
        capabilities: ["payments.initiate"],
      }),
    ).toBe(true);
    expect(
      partnerAccessRequiresMfa({
        roleKey: "custom_commercial",
        capabilities: ["commercial.edit"],
      }),
    ).toBe(true);
    expect(
      partnerAccessRequiresMfa({
        roleKey: "operations",
        capabilities: ["bookings.create"],
      }),
    ).toBe(false);
  });

  it("maps legacy persona labels into the account membership vocabulary", () => {
    expect(normalizePartnerPersona("Independent Contractor")).toBe(
      "contractor",
    );
    expect(normalizePartnerPersona("Realtor / Listing Agent")).toBe(
      "real_estate_agent",
    );
    expect(normalizePartnerPersona("Property Management")).toBe(
      "property_manager",
    );
    expect(normalizePartnerPersona("Commercial Client")).toBe(
      "commercial_client",
    );
    expect(normalizePartnerPersona(null)).toBe("other");
  });

  it("selects an active canonical account membership", () => {
    const activeAccess: PartnerAccountAccess = {
      accountId: "22222222-2222-4222-8222-222222222222",
      accountName: "Canonical Company",
      accountStatus: "portal_partner",
      membershipId: "33333333-3333-4333-8333-333333333333",
      membershipStatus: "active",
      roleKey: "scheduler",
      persona: "other",
      accessLevel: "account",
      accessScope: {},
      preferences: {},
      capabilities: ["portal.session.read", "bookings.read"],
      isDefault: true,
      legacyOrgContactId: "44444444-4444-4444-8444-444444444444",
      source: "membership",
    };
    expect(
      selectPartnerAccountAccess({
        activeAccesses: [activeAccess],
        selectedAccountId: activeAccess.accountId,
        selectedMembershipId: activeAccess.membershipId,
      }),
    ).toEqual({ ok: true, access: activeAccess });
  });

  it("excludes disabled accounts before they can become V2 authority", () => {
    expect(
      isPartnerV2MembershipEligible({
        membershipStatus: "active",
        portalAccessEnabled: false,
      }),
    ).toBe(false);
    expect(
      selectPartnerAccountAccess({
        activeAccesses: [],
        selectedAccountId: null,
        selectedMembershipId: null,
      }),
    ).toEqual({
      ok: false,
      status: 403,
      error: "account_access_required",
    });
  });

  it.each(["suspended", "removed"])(
    "never lets a %s membership re-enter through contact-derived authority",
    (membershipStatus) => {
      expect(
        isPartnerV2MembershipEligible({
          membershipStatus,
          portalAccessEnabled: true,
        }),
      ).toBe(false);
      expect(
        selectPartnerAccountAccess({
          activeAccesses: [],
          selectedAccountId: null,
          selectedMembershipId: null,
        }),
      ).toEqual({
        ok: false,
        status: 403,
        error: "account_access_required",
      });
    },
  );

  it("treats contact linkage as compatibility data, never V2 account authority", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/partner-account-authorization.ts"),
      "utf8",
    );
    const resolver = source.slice(
      source.indexOf("export async function resolvePartnerPrincipal"),
      source.indexOf("export function hasPartnerCapability"),
    );

    expect(resolver).not.toContain("authentication.partnerUser.orgContactId");
    expect(source).not.toContain("loadLegacyContactAccess");
    expect(source).toContain("eq(partnerAccounts.portalAccessEnabled, true)");
    expect(source).toContain('eq(partnerAccountMemberships.status, "active")');
  });

  it("adapts an account principal to the exact V1 contact scope", () => {
    expect(adaptPartnerPrincipalToLegacySession(principal())).toEqual({
      ok: true,
      partnerUser: {
        id: "11111111-1111-4111-8111-111111111111",
        sessionId: "55555555-5555-4555-8555-555555555555",
        orgContactId: "44444444-4444-4444-8444-444444444444",
        email: "partner@example.com",
        name: "Partner User",
        passwordSet: true,
      },
    });
    expect(
      adaptPartnerPrincipalToLegacySession(
        principal({ legacyOrgContactId: null }),
      ),
    ).toEqual({
      ok: false,
      status: 409,
      error: "legacy_scope_unavailable",
    });
  });
});
