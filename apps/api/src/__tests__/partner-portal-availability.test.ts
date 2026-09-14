import type { PartnerPrincipal } from "@/lib/partner-account-authorization";

const jest = import.meta.jest;
const mockModule = jest.unstable_mockModule as unknown as (
  name: string,
  factory: () => Record<string, unknown>,
) => void;
const actualDb = await import("@/db");
const mockPolicy = jest.fn();
const mockStorage = jest.fn();
const mockScanner = jest.fn();
const mockEmbedded = jest.fn();
const mockHosted = jest.fn();
mockModule("@/db", () => ({
  ...actualDb,
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: mockPolicy }) }) }),
  }),
}));
mockModule("@/lib/media-storage", () => ({
  isMediaStorageConfigured: mockStorage,
}));
mockModule("@/lib/partner-document-scan", () => ({
  isPartnerDocumentScanningConfigured: mockScanner,
}));
mockModule("@/lib/partner-embedded-payment-provider", () => ({
  createSquarePartnerEmbeddedPaymentProvider: mockEmbedded,
}));
mockModule("@/lib/partner-hosted-checkout-provider", () => ({
  createSquarePartnerHostedCheckoutProvider: mockHosted,
}));
const { getPartnerPortalAvailability } = await import(
  "@/lib/partner-portal-availability"
);
const accountId = "11111111-1111-4111-8111-111111111111";
const principal: Pick<PartnerPrincipal, "accountId" | "capabilities"> = {
  accountId,
  capabilities: ["bookings.create", "media.upload", "payments.initiate"],
};
const flags = [
  "PARTNER_PORTAL_V2_READS_ENABLED",
  "PARTNER_PORTAL_V2_WRITES_ENABLED",
  "PARTNER_PORTAL_INSTANT_CONFIRMATION_ENABLED",
  "PARTNER_PORTAL_EMBEDDED_PAYMENTS_ENABLED",
  "PARTNER_PORTAL_EMBEDDED_ACH_ENABLED",
  "PARTNER_PORTAL_HOSTED_PAYMENTS_ENABLED",
  "PARTNER_PORTAL_INTERNAL_TEST_MODE",
  "PARTNER_PORTAL_V2_CANARY_ACCOUNT_IDS",
  "TEAM_KILL_FINANCIAL_MUTATIONS",
  "NODE_ENV",
];
const previous = new Map(flags.map((key) => [key, process.env[key]]));
describe("partner portal availability", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    for (const key of flags) delete process.env[key];
    process.env.NODE_ENV = "production";
    mockPolicy.mockResolvedValue([{ enabled: true }]);
    mockStorage.mockReturnValue(true);
    mockScanner.mockReturnValue(true);
    mockEmbedded.mockReturnValue({ webPayments: { methods: { ach: true } } });
    mockHosted.mockReturnValue({});
  });
  afterAll(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  function enableFlags() {
    for (const key of flags.filter((name) => name.endsWith("_ENABLED")))
      process.env[key] = "true";
  }
  it("reports unavailable instead of probing providers when core reads are disabled", async () => {
    expect(await getPartnerPortalAvailability(principal)).toEqual({
      reads: false,
      writes: false,
      payments: { card: false, ach: false, hosted: false },
      uploads: { photos: false, documents: false },
      instantConfirmation: false,
    });
    expect(mockEmbedded).not.toHaveBeenCalled();
    expect(mockStorage).not.toHaveBeenCalled();
    expect(mockPolicy).not.toHaveBeenCalled();
  });
  it("separates read-only access from optional writes", async () => {
    enableFlags();
    process.env.PARTNER_PORTAL_V2_WRITES_ENABLED = "false";
    expect(await getPartnerPortalAvailability(principal)).toMatchObject({
      reads: true,
      writes: false,
      instantConfirmation: false,
      payments: { card: false, ach: false, hosted: false },
      uploads: { photos: false, documents: false },
    });
  });
  it("does not grant upload, scheduling or payment capabilities through configuration", async () => {
    enableFlags();
    expect(
      await getPartnerPortalAvailability({
        accountId,
        capabilities: ["portal.session.read"],
      }),
    ).toMatchObject({
      reads: true,
      writes: true,
      instantConfirmation: false,
      payments: { card: false, ach: false, hosted: false },
      uploads: { photos: false, documents: false },
    });
  });
  it("reports each configured optional service without exposing configuration values", async () => {
    enableFlags();
    expect(await getPartnerPortalAvailability(principal)).toEqual({
      reads: true,
      writes: true,
      instantConfirmation: true,
      payments: { card: true, ach: true, hosted: true },
      uploads: { photos: true, documents: true },
    });
  });
  it("allows photos while PDFs and unconfigured payments remain unavailable", async () => {
    enableFlags();
    mockScanner.mockReturnValue(false);
    mockEmbedded.mockImplementation(() => {
      throw new Error("secret-provider-detail");
    });
    mockHosted.mockImplementation(() => {
      throw new Error("secret-provider-detail");
    });
    expect(await getPartnerPortalAvailability(principal)).toMatchObject({
      payments: { card: false, ach: false, hosted: false },
      uploads: { photos: true, documents: false },
    });
  });
  it.each([{ policy: [] }, { policy: [{ enabled: false }] }])(
    "keeps confirmation manual when the company policy is absent or disabled",
    async ({ policy }) => {
      enableFlags();
      mockPolicy.mockResolvedValue(policy);
      expect(
        (await getPartnerPortalAvailability(principal)).instantConfirmation,
      ).toBe(false);
    },
  );
});
