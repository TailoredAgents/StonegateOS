import { NextRequest } from "next/server";

const jest = import.meta.jest;
const mockModule = jest.unstable_mockModule as unknown as (
  moduleName: string,
  factory: () => Record<string, unknown>,
) => void;

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const MEMBERSHIP_ID = "33333333-3333-4333-8333-333333333333";
const SESSION_ID = "44444444-4444-4444-8444-444444444444";
const CORRELATION_ID = "partner-account-profile-route-0001";

const partnerAccounts = Object.fromEntries(
  [
    "id",
    "name",
    "normalizedName",
    "website",
    "portalAccessEnabled",
    "profileRevision",
    "serviceContactName",
    "serviceContactEmail",
    "serviceContactPhoneE164",
    "billingContactName",
    "billingContactEmail",
    "billingContactPhoneE164",
    "billingAddressLine1",
    "billingAddressLine2",
    "billingAddressCity",
    "billingAddressState",
    "billingAddressPostalCode",
    "billingAddressCountry",
    "defaultPoNumber",
    "costCenterGuidance",
    "updatedAt",
  ].map((key) => [key, `partner_accounts.${key}`]),
);
const auditLogs = { id: "audit_logs.id" };
const mockRequirePartnerCapability = jest.fn();
const mockResolvePartnerPrincipal = jest.fn();
const mockForUpdate = jest.fn();
const auditWrites: Array<Record<string, unknown>> = [];
let updateValues: Record<string, unknown> | null = null;
let state: Record<string, unknown>;

function profileState(): Record<string, unknown> {
  return {
    id: ACCOUNT_ID,
    name: "Acme Property Group",
    normalizedName: "acme property group",
    website: null,
    portalAccessEnabled: true,
    profileRevision: 1,
    serviceContactName: "Alex Service",
    serviceContactEmail: "alex@acme.example",
    serviceContactPhoneE164: "+15555550101",
    billingContactName: "Bill Payable",
    billingContactEmail: "billing@acme.example",
    billingContactPhoneE164: null,
    billingAddressLine1: "1 Main Street",
    billingAddressLine2: null,
    billingAddressCity: "Boston",
    billingAddressState: "MA",
    billingAddressPostalCode: "02108",
    billingAddressCountry: "US",
    defaultPoNumber: "PO-DEFAULT",
    costCenterGuidance: "Use the property cost center.",
    updatedAt: new Date("2026-09-01T12:00:00.000Z"),
    notes: "staff-only note",
    providerCustomerId: "provider-secret",
    paymentTerms: "staff-only terms",
  };
}

function createDb() {
  const read = () => Promise.resolve([state]);
  const transaction = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          for: mockForUpdate.mockImplementation(() => ({
            limit: jest.fn(read),
          })),
        })),
      })),
    })),
    update: jest.fn(() => ({
      set: jest.fn((values: Record<string, unknown>) => {
        updateValues = values;
        return {
          where: jest.fn(() => ({
            returning: jest.fn(() => {
              state = {
                ...state,
                ...values,
                profileRevision: Number(state["profileRevision"]) + 1,
              };
              return Promise.resolve([state]);
            }),
          })),
        };
      }),
    })),
    insert: jest.fn((table: unknown) => {
      if (table !== auditLogs) throw new Error("unexpected insert table");
      return {
        values: jest.fn((values: Record<string, unknown>) => {
          auditWrites.push(values);
          return Promise.resolve();
        }),
      };
    }),
  };
  return {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({ limit: jest.fn(read) })),
      })),
    })),
    transaction: jest.fn(
      <Result>(work: (tx: typeof transaction) => Promise<Result>) =>
        work(transaction),
    ),
  };
}

const mockDb = createDb();

mockModule("@/db", () => ({
  auditLogs,
  getDb: () => mockDb,
  partnerAccounts,
}));
mockModule("@/lib/partner-account-authorization", () => ({
  hasPartnerCapability: (
    principal: { capabilities: string[] },
    capability: string,
  ) => principal.capabilities.includes(capability),
  requirePartnerCapability: mockRequirePartnerCapability,
  resolvePartnerPrincipal: mockResolvePartnerPrincipal,
}));
mockModule("@/lib/partner-accounts", () => ({
  normalizePartnerAccountName: (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, " ")
      .trim(),
}));
mockModule("@/lib/partner-portal-feature-flags", () => ({
  arePartnerPortalV2ReadsEnabled: () => true,
  arePartnerPortalV2WritesEnabled: () => true,
}));
mockModule("@/lib/partner-portal-v2-security", () => ({
  isAllowedPartnerPortalMutationOrigin: () => true,
}));

const { GET, PATCH, partnerAccountProfileRevision } = await import(
  "../../app/api/portal/v2/account-profile/route"
);
const { createPortalV2StrongEtag } = await import("@/lib/portal-v2-contract");

function principal(input?: {
  capabilities?: string[];
  accessLevel?: "account" | "scoped";
  mfaRequired?: boolean;
  mfaSatisfied?: boolean;
  assuranceLevel?: "aal1" | "aal2";
  mfaVerifiedAt?: Date | null;
}) {
  return {
    partnerUserId: USER_ID,
    email: "user@acme.example",
    accountId: ACCOUNT_ID,
    membershipId: MEMBERSHIP_ID,
    roleKey: "custom",
    accessLevel: input?.accessLevel ?? "account",
    capabilities: input?.capabilities ?? ["account.read"],
    session: {
      id: SESSION_ID,
      assuranceLevel: input?.assuranceLevel ?? "aal1",
      mfaVerifiedAt: input?.mfaVerifiedAt ?? null,
    },
    security: {
      mfaRequired: input?.mfaRequired ?? false,
      mfaSatisfied: input?.mfaSatisfied ?? true,
    },
  };
}

function request(input?: {
  method?: "GET" | "PATCH";
  body?: unknown;
  ifMatch?: string | null;
}): NextRequest {
  const headers: Record<string, string> = {
    authorization: "Bearer redacted",
    origin: "https://portal.stonegate.example",
    "x-correlation-id": CORRELATION_ID,
  };
  if (input?.body !== undefined) headers["content-type"] = "application/json";
  if (input?.ifMatch) headers["if-match"] = input.ifMatch;
  return new NextRequest(
    "https://api.stonegate.example/api/portal/v2/account-profile",
    {
      method: input?.method ?? "GET",
      headers,
      body: input?.body === undefined ? undefined : JSON.stringify(input.body),
    },
  );
}

function currentEtag(): string {
  return createPortalV2StrongEtag(
    partnerAccountProfileRevision(state as never),
  );
}

describe("partner account profile route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    state = profileState();
    updateValues = null;
    auditWrites.splice(0);
    mockRequirePartnerCapability.mockResolvedValue({
      ok: true,
      principal: principal(),
    });
    mockResolvePartnerPrincipal.mockResolvedValue({
      ok: true,
      principal: principal(),
    });
  });

  it("returns an account-native, sanitized profile with a strong ETag", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toMatch(/^"portal-v2-/u);
    expect(mockRequirePartnerCapability).toHaveBeenCalledWith(
      expect.any(NextRequest),
      "account.read",
    );
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      profile: {
        id: ACCOUNT_ID,
        organization: {
          name: "Acme Property Group",
          website: null,
        },
        billing: null,
        permissions: { canViewBilling: false },
      },
    });
    expect(JSON.stringify(body)).not.toMatch(
      /staff-only|provider-secret|paymentTerms|portalAccessEnabled/u,
    );
  });

  it("returns billing data only to a financial reader", async () => {
    mockRequirePartnerCapability.mockResolvedValue({
      ok: true,
      principal: principal({
        capabilities: ["account.read", "invoices.read"],
      }),
    });
    const response = await GET(request());
    const body = (await response.json()) as {
      profile: Record<string, unknown>;
    };
    expect(response.status).toBe(200);
    expect(body.profile["billing"]).toMatchObject({
      contact: { email: "billing@acme.example" },
      defaultPoNumber: "PO-DEFAULT",
    });
    expect(body.profile["permissions"]).toEqual(
      expect.objectContaining({
        canViewBilling: true,
        canEditBilling: false,
      }),
    );
  });

  it("updates organization and service contact under account.update", async () => {
    mockResolvePartnerPrincipal.mockResolvedValue({
      ok: true,
      principal: principal({
        capabilities: ["account.read", "account.update"],
        assuranceLevel: "aal2",
        mfaVerifiedAt: new Date(),
      }),
    });
    const response = await PATCH(
      request({
        method: "PATCH",
        ifMatch: currentEtag(),
        body: {
          organization: {
            name: "Acme & Sons",
            website: "https://acme.example/about#private-fragment",
          },
          serviceContact: {
            name: "Sam Service",
            email: "SAM@ACME.EXAMPLE",
            phoneE164: null,
          },
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(mockForUpdate).toHaveBeenCalledWith("update");
    expect(updateValues).toEqual(
      expect.objectContaining({
        name: "Acme & Sons",
        normalizedName: "acme sons",
        website: "https://acme.example/about",
        serviceContactName: "Sam Service",
        serviceContactEmail: "sam@acme.example",
      }),
    );
    expect(updateValues).not.toHaveProperty("billingContactName");
    expect(auditWrites).toEqual([
      expect.objectContaining({
        action: "partner.account_profile.updated",
        entityType: "partner_account",
        entityId: ACCOUNT_ID,
        requiredPermissions: ["account.update"],
      }),
    ]);
  });

  it("allows commercial.edit to change billing without account.update", async () => {
    mockResolvePartnerPrincipal.mockResolvedValue({
      ok: true,
      principal: principal({
        capabilities: ["account.read", "commercial.edit"],
        mfaRequired: true,
        mfaSatisfied: true,
        assuranceLevel: "aal2",
        mfaVerifiedAt: new Date(),
      }),
    });
    const response = await PATCH(
      request({
        method: "PATCH",
        ifMatch: currentEtag(),
        body: {
          billing: {
            contact: {
              name: "New Billing",
              email: "billing2@acme.example",
              phoneE164: "+15555550199",
            },
            address: {
              line1: null,
              line2: null,
              city: null,
              state: null,
              postalCode: null,
              country: null,
            },
            defaultPoNumber: null,
            costCenterGuidance: "Use the site code.",
          },
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(updateValues).toEqual(
      expect.objectContaining({
        billingContactName: "New Billing",
        billingContactEmail: "billing2@acme.example",
        costCenterGuidance: "Use the site code.",
      }),
    );
    expect(updateValues).not.toHaveProperty("name");
    expect(auditWrites[0]?.["requiredPermissions"]).toEqual([
      "commercial.edit",
    ]);
  });

  it("requires recent AAL2 verification for an MFA-required editor", async () => {
    mockResolvePartnerPrincipal.mockResolvedValue({
      ok: true,
      principal: principal({
        capabilities: ["account.update"],
        mfaRequired: true,
        mfaSatisfied: true,
        assuranceLevel: "aal2",
        mfaVerifiedAt: new Date(Date.now() - 16 * 60 * 1_000),
      }),
    });
    const response = await PATCH(
      request({
        method: "PATCH",
        ifMatch: currentEtag(),
        body: { organization: { name: "Acme", website: null } },
      }),
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ error: "mfa_step_up_required" }),
    );
    expect(updateValues).toBeNull();
  });

  it.each([
    {
      label: "missing organization authority",
      capabilities: ["account.read", "commercial.edit"],
      accessLevel: "account" as const,
      security: {},
      body: {
        organization: { name: "Unauthorized", website: null },
      },
      error: "forbidden",
    },
    {
      label: "missing billing authority",
      capabilities: ["account.read", "account.update"],
      accessLevel: "account" as const,
      security: {},
      body: {
        billing: {
          contact: { name: null, email: null, phoneE164: null },
          address: {
            line1: null,
            line2: null,
            city: null,
            state: null,
            postalCode: null,
            country: null,
          },
          defaultPoNumber: null,
          costCenterGuidance: null,
        },
      },
      error: "forbidden",
    },
    {
      label: "scoped membership",
      capabilities: ["account.read", "account.update", "commercial.edit"],
      accessLevel: "scoped" as const,
      security: {},
      body: {
        organization: { name: "Unauthorized", website: null },
      },
      error: "forbidden",
    },
    {
      label: "unsatisfied required MFA",
      capabilities: ["account.read", "account.update"],
      accessLevel: "account" as const,
      security: { mfaRequired: true, mfaSatisfied: false },
      body: {
        organization: { name: "Unauthorized", website: null },
      },
      error: "mfa_step_up_required",
    },
  ])("fails closed for $label", async (testCase) => {
    mockResolvePartnerPrincipal.mockResolvedValue({
      ok: true,
      principal: principal({
        capabilities: testCase.capabilities,
        accessLevel: testCase.accessLevel,
        ...testCase.security,
      }),
    });
    const response = await PATCH(
      request({
        method: "PATCH",
        ifMatch: currentEtag(),
        body: testCase.body,
      }),
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ ok: false, error: testCase.error }),
    );
    expect(updateValues).toBeNull();
  });

  it("requires the exact current ETag before acquiring a write", async () => {
    mockResolvePartnerPrincipal.mockResolvedValue({
      ok: true,
      principal: principal({
        capabilities: ["account.update"],
        assuranceLevel: "aal2",
        mfaVerifiedAt: new Date(),
      }),
    });
    const missing = await PATCH(
      request({
        method: "PATCH",
        body: { organization: { name: "Acme", website: null } },
      }),
    );
    expect(missing.status).toBe(428);
    expect(updateValues).toBeNull();

    const stale = await PATCH(
      request({
        method: "PATCH",
        ifMatch: createPortalV2StrongEtag("stale-profile"),
        body: { organization: { name: "Acme", website: null } },
      }),
    );
    expect(stale.status).toBe(412);
    expect(stale.headers.get("etag")).toBe(currentEtag());
    expect(updateValues).toBeNull();
  });

  it("rejects unknown fields and partial contacts before mutation", async () => {
    mockResolvePartnerPrincipal.mockResolvedValue({
      ok: true,
      principal: principal({ capabilities: ["account.update"] }),
    });
    const unknown = await PATCH(
      request({
        method: "PATCH",
        ifMatch: currentEtag(),
        body: {
          organization: { name: "Acme", website: null, providerId: "nope" },
        },
      }),
    );
    expect(unknown.status).toBe(422);

    const partial = await PATCH(
      request({
        method: "PATCH",
        ifMatch: currentEtag(),
        body: {
          serviceContact: { name: "No email", email: null, phoneE164: null },
        },
      }),
    );
    expect(partial.status).toBe(422);
    expect(updateValues).toBeNull();
  });
});
