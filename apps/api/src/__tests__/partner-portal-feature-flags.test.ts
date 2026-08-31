import {
  arePartnerPortalEmbeddedPaymentsEnabled,
  arePartnerPortalHostedPaymentsEnabled,
  arePartnerPortalV2ReadsEnabled,
  arePartnerPortalV2WritesEnabled,
  getPartnerPortalFeatureState,
  isPartnerPortalInstantConfirmationEnabled,
  isPartnerPortalV2AccountEligible,
} from "@/lib/partner-portal-feature-flags";

const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_B = "22222222-2222-4222-8222-222222222222";

describe("partner portal feature flags", () => {
  const priorNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = "production";
    delete process.env.PARTNER_PORTAL_V2_READS_ENABLED;
    delete process.env.PARTNER_PORTAL_V2_WRITES_ENABLED;
    delete process.env.PARTNER_PORTAL_V2_CANARY_ACCOUNT_IDS;
    delete process.env.PARTNER_PORTAL_INSTANT_CONFIRMATION_ENABLED;
    delete process.env.PARTNER_PORTAL_EMBEDDED_PAYMENTS_ENABLED;
    delete process.env.PARTNER_PORTAL_HOSTED_PAYMENTS_ENABLED;
    delete process.env.PARTNER_PORTAL_OUTBOUND_NOTIFICATIONS_ENABLED;
    delete process.env.TEAM_KILL_FINANCIAL_MUTATIONS;
  });

  afterAll(() => {
    process.env.NODE_ENV = priorNodeEnv;
  });

  it("fails closed in production", () => {
    expect(getPartnerPortalFeatureState(ACCOUNT_A)).toEqual({
      eligible: true,
      reads: false,
      writes: false,
      instantConfirmation: false,
      hostedPayments: false,
      embeddedPayments: false,
      outboundNotifications: false,
    });
  });

  it("restricts enabled features to configured canary accounts", () => {
    process.env.PARTNER_PORTAL_V2_READS_ENABLED = "1";
    process.env.PARTNER_PORTAL_V2_WRITES_ENABLED = "1";
    process.env.PARTNER_PORTAL_INSTANT_CONFIRMATION_ENABLED = "1";
    process.env.PARTNER_PORTAL_EMBEDDED_PAYMENTS_ENABLED = "1";
    process.env.PARTNER_PORTAL_HOSTED_PAYMENTS_ENABLED = "1";
    process.env.PARTNER_PORTAL_V2_CANARY_ACCOUNT_IDS = `invalid, ${ACCOUNT_A}`;

    expect(isPartnerPortalV2AccountEligible(ACCOUNT_A)).toBe(true);
    expect(isPartnerPortalV2AccountEligible(ACCOUNT_B)).toBe(false);
    expect(arePartnerPortalV2ReadsEnabled(ACCOUNT_A)).toBe(true);
    expect(arePartnerPortalV2WritesEnabled(ACCOUNT_A)).toBe(true);
    expect(isPartnerPortalInstantConfirmationEnabled(ACCOUNT_A)).toBe(true);
    expect(arePartnerPortalEmbeddedPaymentsEnabled(ACCOUNT_A)).toBe(true);
    expect(arePartnerPortalHostedPaymentsEnabled(ACCOUNT_A)).toBe(true);
    expect(arePartnerPortalV2ReadsEnabled(ACCOUNT_B)).toBe(false);
    expect(arePartnerPortalV2WritesEnabled(ACCOUNT_B)).toBe(false);
  });

  it("does not allow a child feature to bypass disabled V2 writes", () => {
    process.env.PARTNER_PORTAL_V2_READS_ENABLED = "1";
    process.env.PARTNER_PORTAL_INSTANT_CONFIRMATION_ENABLED = "1";
    process.env.PARTNER_PORTAL_EMBEDDED_PAYMENTS_ENABLED = "1";
    process.env.PARTNER_PORTAL_HOSTED_PAYMENTS_ENABLED = "1";

    expect(arePartnerPortalV2ReadsEnabled(ACCOUNT_A)).toBe(true);
    expect(arePartnerPortalV2WritesEnabled(ACCOUNT_A)).toBe(false);
    expect(isPartnerPortalInstantConfirmationEnabled(ACCOUNT_A)).toBe(false);
    expect(arePartnerPortalEmbeddedPaymentsEnabled(ACCOUNT_A)).toBe(false);
    expect(arePartnerPortalHostedPaymentsEnabled(ACCOUNT_A)).toBe(false);
  });

  it("honors the global financial-mutation kill switch", () => {
    process.env.PARTNER_PORTAL_V2_READS_ENABLED = "1";
    process.env.PARTNER_PORTAL_V2_WRITES_ENABLED = "1";
    process.env.PARTNER_PORTAL_EMBEDDED_PAYMENTS_ENABLED = "1";
    process.env.PARTNER_PORTAL_HOSTED_PAYMENTS_ENABLED = "1";
    process.env.TEAM_KILL_FINANCIAL_MUTATIONS = "1";

    expect(arePartnerPortalEmbeddedPaymentsEnabled(ACCOUNT_A)).toBe(false);
    expect(arePartnerPortalHostedPaymentsEnabled(ACCOUNT_A)).toBe(false);
  });

  it("rolls hosted and embedded checkout independently", () => {
    process.env.PARTNER_PORTAL_V2_READS_ENABLED = "1";
    process.env.PARTNER_PORTAL_V2_WRITES_ENABLED = "1";
    process.env.PARTNER_PORTAL_HOSTED_PAYMENTS_ENABLED = "1";

    expect(arePartnerPortalHostedPaymentsEnabled(ACCOUNT_A)).toBe(true);
    expect(arePartnerPortalEmbeddedPaymentsEnabled(ACCOUNT_A)).toBe(false);
  });
});
