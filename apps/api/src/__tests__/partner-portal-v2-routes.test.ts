import { NextRequest } from "next/server";
import type { PartnerPrincipal } from "@/lib/partner-account-authorization";

const jest = import.meta.jest;
const mockModule = jest.unstable_mockModule as unknown as (
  moduleName: string,
  factory: () => Record<string, unknown>,
) => void;
const mockResolvePartnerPrincipal = jest.fn();
const mockRequirePartnerCapability = jest.fn();
const mockSwitchPartnerSessionAccount = jest.fn();
const mockRequirePartnerSession = jest.fn();

mockModule("@/lib/partner-account-authorization", () => ({
  resolvePartnerPrincipal: mockResolvePartnerPrincipal,
  requirePartnerCapability: mockRequirePartnerCapability,
  switchPartnerSessionAccount: mockSwitchPartnerSessionAccount,
}));

mockModule("@/lib/partner-portal-auth", () => ({
  requirePartnerSession: mockRequirePartnerSession,
  resolvePublicSiteBaseUrl: () => null,
}));

const { GET: getMe } = await import("../../app/api/portal/v2/me/route");
const { GET: getSession } = await import(
  "../../app/api/portal/v2/session/route"
);
const { POST: switchAccount } = await import(
  "../../app/api/portal/v2/session/account/route"
);

const CORRELATION_ID = "portal-test-correlation-0001";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function principal(): PartnerPrincipal {
  const createdAt = new Date("2026-08-30T12:00:00.000Z");
  const accountId = "22222222-2222-4222-8222-222222222222";
  const membershipId = "33333333-3333-4333-8333-333333333333";
  return {
    type: "partner",
    partnerUserId: "11111111-1111-4111-8111-111111111111",
    email: "partner@example.com",
    name: "Partner User",
    passwordSet: true,
    accountId,
    accountName: "Partner Company",
    membershipId,
    roleKey: "scheduler",
    persona: "property_manager",
    accessLevel: "account",
    accessScope: {
      locationIds: ["66666666-6666-4666-8666-666666666666"],
      propertyIds: ["77777777-7777-4777-8777-777777777777"],
    },
    preferences: { timezone: "America/New_York" },
    legacyOrgContactId: "44444444-4444-4444-8444-444444444444",
    capabilities: [
      "portal.session.read",
      "portal.session.switch_account",
      "bookings.read",
    ],
    accessSource: "membership",
    session: {
      id: "55555555-5555-4555-8555-555555555555",
      authMethod: "password",
      deviceName: "Safari on macOS",
      createdAt,
      lastSeenAt: new Date("2026-08-30T12:30:00.000Z"),
      expiresAt: new Date("2026-09-30T12:00:00.000Z"),
    },
    availableAccounts: [
      {
        accountId,
        accountName: "Partner Company",
        accountStatus: "portal_partner",
        membershipId,
        membershipStatus: "active",
        roleKey: "scheduler",
        persona: "property_manager",
        accessLevel: "account",
        accessScope: {
          locationIds: ["66666666-6666-4666-8666-666666666666"],
          propertyIds: ["77777777-7777-4777-8777-777777777777"],
        },
        preferences: { timezone: "America/New_York" },
        capabilities: [
          "portal.session.read",
          "portal.session.switch_account",
          "bookings.read",
        ],
        isDefault: true,
        legacyOrgContactId: "44444444-4444-4444-8444-444444444444",
        source: "membership",
      },
    ],
  };
}

function authenticatedSession() {
  const context = principal();
  return {
    ok: true as const,
    partnerUser: {
      id: context.partnerUserId,
      sessionId: context.session.id,
      orgContactId: context.legacyOrgContactId!,
      email: context.email,
      name: context.name,
      passwordSet: context.passwordSet,
    },
    session: {
      id: context.session.id,
      activePartnerAccountId: context.accountId,
      activeMembershipId: context.membershipId,
      authMethod: context.session.authMethod,
      securityVersion: 1,
      deviceName: context.session.deviceName,
      createdAt: context.session.createdAt,
      lastSeenAt: context.session.lastSeenAt,
      expiresAt: context.session.expiresAt,
    },
  };
}

describe("partner portal v2 identity routes", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("returns account-centric identity without session secrets", async () => {
    mockResolvePartnerPrincipal.mockResolvedValue({
      ok: true,
      principal: principal(),
    });
    const request = new NextRequest("http://localhost/api/portal/v2/me", {
      headers: {
        authorization: "Bearer secret-token",
        "x-correlation-id": CORRELATION_ID,
      },
    });

    const response = await getMe(request);
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-correlation-id")).toBe(CORRELATION_ID);
    expect(isRecord(body)).toBe(true);
    if (!isRecord(body)) throw new Error("expected object response");
    expect(body["ok"]).toBe(true);
    const account = body["account"];
    const membership = body["membership"];
    expect(isRecord(account)).toBe(true);
    expect(isRecord(membership)).toBe(true);
    if (!isRecord(account) || !isRecord(membership)) {
      throw new Error("expected account and membership response");
    }
    expect(account["id"]).toBe("22222222-2222-4222-8222-222222222222");
    expect(membership["roleKey"]).toBe("scheduler");
    expect(membership).not.toHaveProperty("accessScope");
    expect(JSON.stringify(body)).not.toContain(
      "44444444-4444-4444-8444-444444444444",
    );
    expect(JSON.stringify(body)).not.toContain(
      "66666666-6666-4666-8666-666666666666",
    );
    expect(JSON.stringify(body)).not.toContain(
      "77777777-7777-4777-8777-777777777777",
    );
    expect(JSON.stringify(body)).not.toContain("secret-token");
    expect(JSON.stringify(body)).not.toContain("sessionHash");
    expect(JSON.stringify(body)).not.toContain(
      "55555555-5555-4555-8555-555555555555",
    );
    expect(body["accounts"]).toEqual([
      expect.objectContaining({ defaultAccount: true, current: true }),
    ]);
  });

  it("requires the intrinsic session-read capability", async () => {
    mockRequirePartnerCapability.mockResolvedValue({
      ok: true,
      principal: principal(),
    });
    const request = new NextRequest("http://localhost/api/portal/v2/session", {
      headers: {
        authorization: "Bearer secret-token",
        "x-correlation-id": CORRELATION_ID,
      },
    });

    const response = await getSession(request);
    const body: unknown = await response.json();

    expect(mockRequirePartnerCapability).toHaveBeenCalledWith(
      request,
      "portal.session.read",
    );
    expect(response.status).toBe(200);
    expect(isRecord(body)).toBe(true);
    if (!isRecord(body)) throw new Error("expected object response");
    const session = body["session"];
    expect(isRecord(session)).toBe(true);
    if (!isRecord(session)) throw new Error("expected session response");
    expect(session).toEqual(
      expect.objectContaining({
        current: true,
        authMethod: "password",
        createdAt: "2026-08-30T12:00:00.000Z",
      }),
    );
    expect(JSON.stringify(body)).not.toContain(
      "55555555-5555-4555-8555-555555555555",
    );
  });

  it("authenticates before parsing or attempting an account switch", async () => {
    mockRequirePartnerSession.mockResolvedValue({
      ok: false,
      status: 401,
      error: "unauthorized",
    });
    const request = new NextRequest(
      "http://localhost/api/portal/v2/session/account",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-correlation-id": CORRELATION_ID,
        },
        body: "not json",
      },
    );

    const response = await switchAccount(request);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        error: "unauthorized",
        correlationId: CORRELATION_ID,
      }),
    );
    expect(mockSwitchPartnerSessionAccount).not.toHaveBeenCalled();
  });

  it("rejects extra fields and switches only to a verified membership", async () => {
    const authentication = authenticatedSession();
    mockRequirePartnerSession.mockResolvedValue(authentication);
    const invalidRequest = new NextRequest(
      "http://localhost/api/portal/v2/session/account",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-correlation-id": CORRELATION_ID,
        },
        body: JSON.stringify({
          accountId: "22222222-2222-4222-8222-222222222222",
          role: "owner",
        }),
      },
    );
    const invalidResponse = await switchAccount(invalidRequest);
    expect(invalidResponse.status).toBe(422);
    expect(mockSwitchPartnerSessionAccount).not.toHaveBeenCalled();

    mockSwitchPartnerSessionAccount.mockResolvedValue({
      ok: true,
      accountId: "22222222-2222-4222-8222-222222222222",
      membershipId: "33333333-3333-4333-8333-333333333333",
      defaultAccount: false,
    });
    const validRequest = new NextRequest(
      "http://localhost/api/portal/v2/session/account",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-correlation-id": CORRELATION_ID,
        },
        body: JSON.stringify({
          accountId: "22222222-2222-4222-8222-222222222222",
        }),
      },
    );
    const validResponse = await switchAccount(validRequest);

    expect(validResponse.status).toBe(200);
    expect(mockSwitchPartnerSessionAccount).toHaveBeenCalledWith(
      authentication,
      "22222222-2222-4222-8222-222222222222",
      { correlationId: CORRELATION_ID, makeDefault: false },
    );
    await expect(validResponse.json()).resolves.toEqual({
      ok: true,
      currentAccountId: "22222222-2222-4222-8222-222222222222",
      currentMembershipId: "33333333-3333-4333-8333-333333333333",
      defaultAccount: false,
      correlationId: CORRELATION_ID,
    });
  });

  it("accepts an explicit default-account preference with the account switch", async () => {
    const authentication = authenticatedSession();
    mockRequirePartnerSession.mockResolvedValue(authentication);
    mockSwitchPartnerSessionAccount.mockResolvedValue({
      ok: true,
      accountId: "22222222-2222-4222-8222-222222222222",
      membershipId: "33333333-3333-4333-8333-333333333333",
      defaultAccount: true,
    });
    const request = new NextRequest(
      "http://localhost/api/portal/v2/session/account",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-correlation-id": CORRELATION_ID,
        },
        body: JSON.stringify({
          accountId: "22222222-2222-4222-8222-222222222222",
          makeDefault: true,
        }),
      },
    );

    const response = await switchAccount(request);

    expect(response.status).toBe(200);
    expect(mockSwitchPartnerSessionAccount).toHaveBeenCalledWith(
      authentication,
      "22222222-2222-4222-8222-222222222222",
      { correlationId: CORRELATION_ID, makeDefault: true },
    );
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ defaultAccount: true }),
    );
  });
});
