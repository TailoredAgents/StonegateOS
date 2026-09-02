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
const CORRELATION_ID = "partner-personal-profile-route-0001";

const partnerUsers = Object.fromEntries(
  ["id", "name", "active", "identityStatus", "updatedAt"].map((key) => [
    key,
    `partner_users.${key}`,
  ]),
);
const partnerAccountMemberships = Object.fromEntries(
  ["id", "partnerAccountId", "partnerUserId", "status"].map((key) => [
    key,
    `partner_account_memberships.${key}`,
  ]),
);
const partnerAccounts = {
  id: "partner_accounts.id",
  portalAccessEnabled: "partner_accounts.portalAccessEnabled",
};
const auditLogs = { id: "audit_logs.id" };

const mockResolvePartnerPrincipal = jest.fn();
const mockMutationOrigin = jest.fn(() => true);
const auditWrites: Array<Record<string, unknown>> = [];
let updateValues: Record<string, unknown> | null = null;
let bindingAvailable = true;
let state: { id: string; name: string; updatedAt: Date };

function createDb() {
  const readProfile = () => Promise.resolve([state]);
  const readBinding = () => Promise.resolve(bindingAvailable ? [state] : []);
  const transaction = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        innerJoin: jest.fn(() => ({
          innerJoin: jest.fn(() => ({
            where: jest.fn(() => ({
              for: jest.fn(() => ({ limit: jest.fn(readBinding) })),
            })),
          })),
        })),
      })),
    })),
    update: jest.fn((table: unknown) => {
      if (table !== partnerUsers) throw new Error("unexpected update table");
      return {
        set: jest.fn((values: Record<string, unknown>) => {
          updateValues = values;
          return {
            where: jest.fn(() => ({
              returning: jest.fn(() => {
                state = {
                  ...state,
                  name: String(values["name"]),
                  updatedAt: values["updatedAt"] as Date,
                };
                return Promise.resolve([state]);
              }),
            })),
          };
        }),
      };
    }),
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
        where: jest.fn(() => ({ limit: jest.fn(readProfile) })),
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
  partnerAccountMemberships,
  partnerAccounts,
  partnerUsers,
}));
mockModule("@/lib/partner-account-authorization", () => ({
  resolvePartnerPrincipal: mockResolvePartnerPrincipal,
}));
mockModule("@/lib/partner-portal-feature-flags", () => ({
  arePartnerPortalV2ReadsEnabled: () => true,
  arePartnerPortalV2WritesEnabled: () => true,
}));
mockModule("@/lib/partner-portal-v2-security", () => ({
  isAllowedPartnerPortalMutationOrigin: mockMutationOrigin,
}));

const { GET, PATCH, partnerPersonalProfileRevision } = await import(
  "../../app/api/portal/v2/personal-profile/route"
);
const { createPortalV2StrongEtag } = await import("@/lib/portal-v2-contract");

function principal(input?: { accountId?: string; membershipId?: string }) {
  return {
    partnerUserId: USER_ID,
    email: "alex@acme.example",
    name: state.name,
    accountId: input?.accountId ?? ACCOUNT_ID,
    membershipId: input?.membershipId ?? MEMBERSHIP_ID,
    roleKey: "operations",
    session: { id: SESSION_ID },
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
    "https://api.stonegate.example/api/portal/v2/personal-profile",
    {
      method: input?.method ?? "GET",
      headers,
      body: input?.body === undefined ? undefined : JSON.stringify(input.body),
    },
  );
}

function currentEtag(input?: {
  accountId?: string;
  membershipId?: string;
}): string {
  return createPortalV2StrongEtag(
    partnerPersonalProfileRevision({
      row: state,
      accountId: input?.accountId ?? ACCOUNT_ID,
      membershipId: input?.membershipId ?? MEMBERSHIP_ID,
    }),
  );
}

describe("partner personal profile route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    state = {
      id: USER_ID,
      name: "Alex Rivera",
      updatedAt: new Date("2026-09-01T12:00:00.000Z"),
    };
    updateValues = null;
    bindingAvailable = true;
    auditWrites.splice(0);
    mockMutationOrigin.mockReturnValue(true);
    mockResolvePartnerPrincipal.mockResolvedValue({
      ok: true,
      principal: principal(),
    });
  });

  it("returns only the self profile with an account-and-membership-bound strong ETag", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("etag")).toBe(currentEtag());
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      profile: {
        displayName: "Alex Rivera",
        updatedAt: "2026-09-01T12:00:00.000Z",
      },
      correlationId: CORRELATION_ID,
    });
    expect(JSON.stringify(body)).not.toMatch(
      /orgContact|crm|password|securityVersion/iu,
    );
    expect(
      currentEtag({
        accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    ).not.toBe(currentEtag());
  });

  it("normalizes a bounded display name and audits the identity-only write atomically", async () => {
    const response = await PATCH(
      request({
        method: "PATCH",
        ifMatch: currentEtag(),
        body: { displayName: "  Alex   M. Rivera  " },
      }),
    );
    expect(response.status).toBe(200);
    expect(updateValues).toMatchObject({ name: "Alex M. Rivera" });
    expect(updateValues).not.toHaveProperty("orgContactId");
    expect(updateValues).not.toHaveProperty("email");
    expect(auditWrites).toHaveLength(1);
    expect(auditWrites[0]).toMatchObject({
      action: "partner.personal_profile.updated",
      entityType: "partner_user",
      entityId: USER_ID,
      actorId: USER_ID,
      sessionId: SESSION_ID,
      outcome: "succeeded",
    });
    expect(auditWrites[0]?.["meta"]).toMatchObject({
      partnerAccountId: ACCOUNT_ID,
      partnerMembershipId: MEMBERSHIP_ID,
      changedFields: ["display_name"],
    });
    const body = (await response.json()) as {
      profile: { displayName: string };
    };
    expect(body.profile.displayName).toBe("Alex M. Rivera");
    expect(response.headers.get("etag")).toMatch(/^"portal-v2-/u);
  });

  it.each([
    { displayName: "A" },
    { displayName: "A".repeat(121) },
    { displayName: "Alex\u0000Rivera" },
    { displayName: "Alex", unexpected: true },
  ])("rejects an invalid or unbounded profile payload %#", async (body) => {
    const response = await PATCH(
      request({ method: "PATCH", ifMatch: currentEtag(), body }),
    );
    expect(response.status).toBe(422);
    expect(updateValues).toBeNull();
    expect(auditWrites).toHaveLength(0);
  });

  it("returns a revision conflict without overwriting or auditing", async () => {
    const stale = currentEtag();
    state = {
      ...state,
      name: "Changed Elsewhere",
      updatedAt: new Date("2026-09-01T12:01:00.000Z"),
    };
    const response = await PATCH(
      request({
        method: "PATCH",
        ifMatch: stale,
        body: { displayName: "Overwrite Attempt" },
      }),
    );
    expect(response.status).toBe(412);
    expect((await response.json()) as unknown).toMatchObject({
      ok: false,
      error: "revision_mismatch",
    });
    expect(updateValues).toBeNull();
    expect(auditWrites).toHaveLength(0);
  });

  it("requires If-Match instead of accepting a blind identity overwrite", async () => {
    const response = await PATCH(
      request({
        method: "PATCH",
        body: { displayName: "Blind Overwrite" },
      }),
    );
    expect(response.status).toBe(428);
    expect((await response.json()) as unknown).toMatchObject({
      ok: false,
      error: "if_match_required",
    });
    expect(updateValues).toBeNull();
    expect(auditWrites).toHaveLength(0);
  });

  it("revalidates the exact active membership before writing the global identity", async () => {
    bindingAvailable = false;
    const response = await PATCH(
      request({
        method: "PATCH",
        ifMatch: currentEtag(),
        body: { displayName: "Blocked Change" },
      }),
    );
    expect(response.status).toBe(404);
    expect(updateValues).toBeNull();
    expect(auditWrites).toHaveLength(0);
  });

  it("requires a verified mutation origin before parsing or writing", async () => {
    mockMutationOrigin.mockReturnValue(false);
    const response = await PATCH(
      request({
        method: "PATCH",
        ifMatch: currentEtag(),
        body: { displayName: "Blocked Change" },
      }),
    );
    expect(response.status).toBe(403);
    expect(mockResolvePartnerPrincipal).not.toHaveBeenCalled();
    expect(updateValues).toBeNull();
  });
});
