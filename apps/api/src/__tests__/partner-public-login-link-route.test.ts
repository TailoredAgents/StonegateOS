import type { NextRequest } from "next/server";

const mockReadBoundedJsonRequest = jest.fn((request: NextRequest) =>
  request.json(),
);
const mockConsumeRateLimit = jest.fn();
const mockFindByEmail = jest.fn();
const mockFindByPhone = jest.fn();
const mockReplaceToken = jest.fn();
const mockSendEmail = jest.fn();
const mockSendSms = jest.fn();
const mockKillSwitch = jest.fn();

const mockTables = {
  auditLogs: { id: "audit_logs.id" },
  contacts: {
    id: "contacts.id",
    email: "contacts.email",
    phoneE164: "contacts.phone_e164",
    partnerStatus: "contacts.partner_status",
    deletedAt: "contacts.deleted_at",
  },
  crmPipeline: { contactId: "crm_pipeline.contact_id" },
  crmTasks: {
    contactId: "crm_tasks.contact_id",
    createdAt: "crm_tasks.created_at",
  },
  partnerInviteOperations: {
    id: "partner_invite_operations.id",
    partnerUserId: "partner_invite_operations.partner_user_id",
    state: "partner_invite_operations.state",
    version: "partner_invite_operations.version",
    requestedAt: "partner_invite_operations.requested_at",
    dispatchedAt: "partner_invite_operations.dispatched_at",
  },
  partnerUsers: {
    id: "partner_users.id",
    orgContactId: "partner_users.org_contact_id",
    name: "partner_users.name",
    email: "partner_users.email",
    phoneE164: "partner_users.phone_e164",
    active: "partner_users.active",
  },
};

const USER_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-08-08T12:00:00.000Z");
const activeUser = {
  id: USER_ID,
  orgContactId: ORG_ID,
  name: "Portal User",
  email: "portal@example.test",
  phoneE164: null,
};

const auditRows: Array<Record<string, unknown>> = [];
const lifecycleEvents: string[] = [];
let inviteOperation: Record<string, unknown> | null = null;

function rowsFor(table: unknown): Array<Record<string, unknown>> {
  if (table === mockTables.partnerUsers) return [activeUser];
  if (table === mockTables.partnerInviteOperations) {
    return inviteOperation ? [inviteOperation] : [];
  }
  return [];
}

type MockQuery = {
  innerJoin: jest.Mock<MockQuery, unknown[]>;
  where: jest.Mock<MockQuery, unknown[]>;
  for: jest.Mock<MockQuery, unknown[]>;
  limit: jest.Mock<Promise<Array<Record<string, unknown>>>, unknown[]>;
  orderBy: jest.Mock<MockQuery, unknown[]>;
};

function queryFor(table: unknown): MockQuery {
  const rows = () => Promise.resolve(rowsFor(table));
  const query = {} as MockQuery;
  query.innerJoin = jest.fn<MockQuery, unknown[]>(() => query);
  query.where = jest.fn<MockQuery, unknown[]>(() => query);
  query.for = jest.fn<MockQuery, unknown[]>(() => query);
  query.limit = jest.fn<Promise<Array<Record<string, unknown>>>, unknown[]>(
    () => rows(),
  );
  query.orderBy = jest.fn<MockQuery, unknown[]>(() => query);
  return query;
}

const mockTx = {
  select: jest.fn(() => ({
    from: jest.fn((table: unknown) => queryFor(table)),
  })),
  insert: jest.fn((table: unknown) => ({
    values: jest.fn((values: Record<string, unknown>) => {
      if (table === mockTables.auditLogs) auditRows.push(values);
      if (table === mockTables.partnerInviteOperations) {
        inviteOperation = { ...values };
        lifecycleEvents.push("operation:requested");
      }
      return Promise.resolve(undefined);
    }),
  })),
  update: jest.fn((table: unknown) => ({
    set: jest.fn((values: Record<string, unknown>) => ({
      where: jest.fn(() => ({
        returning: jest.fn(() => {
          if (table === mockTables.partnerInviteOperations) {
            inviteOperation = { ...(inviteOperation ?? {}), ...values };
            lifecycleEvents.push(`operation:${String(values["state"])}`);
            return Promise.resolve([{ id: inviteOperation["id"] }]);
          }
          return Promise.resolve([]);
        }),
      })),
    })),
  })),
};

const mockDb = {
  transaction: jest.fn(
    async (callback: (tx: typeof mockTx) => Promise<unknown>) =>
      callback(mockTx),
  ),
};

jest.mock("drizzle-orm", () => ({
  and: jest.fn((...values: unknown[]) => ({ kind: "and", values })),
  desc: jest.fn((value: unknown) => ({ kind: "desc", value })),
  eq: jest.fn((...values: unknown[]) => ({ kind: "eq", values })),
  inArray: jest.fn((...values: unknown[]) => ({ kind: "inArray", values })),
  isNull: jest.fn((value: unknown) => ({ kind: "isNull", value })),
  or: jest.fn((...values: unknown[]) => ({ kind: "or", values })),
  sql: jest.fn(() => ({ kind: "sql" })),
}));

jest.mock("@/db", () => ({
  ...mockTables,
  getDb: jest.fn(() => mockDb),
}));
jest.mock("@/lib/audit-metadata", () => ({
  sanitizeAuditMetadata: jest.fn((value: unknown) => value),
}));
jest.mock("@/lib/bounded-json-request", () => ({
  BoundedJsonRequestError: class extends Error {
    readonly code: string;
    readonly status: number;

    constructor(code: string, message: string, status: number) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
  readBoundedJsonRequest: mockReadBoundedJsonRequest,
}));
jest.mock("@/lib/team-auth-rate-limit", () => ({
  consumeTeamAuthRateLimit: mockConsumeRateLimit,
}));
jest.mock("@/lib/partner-portal-auth", () => ({
  findActivePartnerUserByEmail: mockFindByEmail,
  findActivePartnerUserByPhone: mockFindByPhone,
  getClientIp: jest.fn(() => "127.0.0.1"),
  getUserAgent: jest.fn(() => "test-agent"),
  normalizeEmail: jest.fn((value: unknown) =>
    typeof value === "string" ? value.trim().toLowerCase() : null,
  ),
  normalizePhoneE164: jest.fn(() => null),
  replacePartnerLoginTokenInTransaction: mockReplaceToken,
  resolvePublicSiteBaseUrl: jest.fn(() => "https://site.test"),
}));
jest.mock("@/lib/messaging", () => ({
  sendEmailMessage: mockSendEmail,
  sendSmsMessage: mockSendSms,
}));
jest.mock("@/lib/team-operation-kill-switch", () => ({
  getTeamOperationKillSwitchForRisk: mockKillSwitch,
}));
jest.mock("@/lib/team-mutation", () => ({
  TeamMutationFailure: class extends Error {
    readonly code: string;
    readonly retryable: boolean;

    constructor(
      code: string,
      message: string,
      options: { retryable?: boolean } = {},
    ) {
      super(message);
      this.code = code;
      this.retryable = options.retryable ?? false;
    }
  },
}));

import { POST } from "../../app/api/public/partners/request-link/route";

function request(): NextRequest & { json: jest.Mock } {
  return {
    headers: new Headers(),
    url: "https://api.test/api/public/partners/request-link",
    json: jest.fn(() => Promise.resolve({ email: activeUser.email })),
  } as unknown as NextRequest & { json: jest.Mock };
}

describe("public partner login-link durable boundary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    auditRows.splice(0, auditRows.length);
    lifecycleEvents.splice(0, lifecycleEvents.length);
    inviteOperation = null;
    mockConsumeRateLimit.mockResolvedValue({
      limited: false,
      retryAfterSeconds: 0,
    });
    mockFindByEmail.mockResolvedValue(activeUser);
    mockFindByPhone.mockResolvedValue(null);
    mockKillSwitch.mockReturnValue(null);
    mockReplaceToken.mockImplementation(() => {
      lifecycleEvents.push("token:replaced");
      return Promise.resolve({
        rawToken: "raw-public-login-token",
        expiresAt: new Date(NOW.getTime() + 30 * 60 * 1_000),
      });
    });
    mockSendEmail.mockImplementation(() => {
      lifecycleEvents.push(`provider:${String(inviteOperation?.["state"])}`);
      return Promise.resolve({
        ok: true,
        provider: "smtp",
        providerMessageId: "mail-1",
        providerOperationIds: ["mail-1"],
        providerIdempotencySupported: false,
        deliveryCertainty: "accepted",
      });
    });
    mockSendSms.mockResolvedValue({
      ok: true,
      provider: "twilio",
      providerMessageId: "sms-1",
      deliveryCertainty: "accepted",
    });
  });

  it("commits token, requested audit, and dispatched evidence before provider I/O", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(lifecycleEvents).toEqual([
      "token:replaced",
      "operation:requested",
      "operation:dispatched",
      "provider:dispatched",
      "operation:succeeded",
    ]);
    expect(inviteOperation).toMatchObject({
      operationKind: "public_login_link",
      initiatorType: "public_request",
      partnerUserId: USER_ID,
      orgContactId: ORG_ID,
      state: "succeeded",
      retryable: false,
      providerOperationIds: ["mail-1"],
    });
    expect(auditRows.map((row) => row["action"])).toEqual([
      "partner_user.login_link.attempted",
      "partner_user.login_link.dispatched",
      "partner_user.login_link.channel.succeeded",
      "partner_user.login_link.succeeded",
    ]);
  });

  it("does not replace a token or call a provider behind an unresolved team invite", async () => {
    inviteOperation = {
      id: "33333333-3333-4333-8333-333333333333",
      partnerUserId: USER_ID,
      orgContactId: ORG_ID,
      operationKind: "team_invite",
      initiatorType: "team_member",
      state: "reconciliation_required",
      version: 3,
      requestedAt: NOW,
      dispatchedAt: NOW,
    };

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mockReplaceToken).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(inviteOperation).toMatchObject({
      operationKind: "team_invite",
      state: "reconciliation_required",
    });
  });

  it("records uncertain provider delivery as reconciliation-required without leaking it", async () => {
    mockSendEmail.mockResolvedValueOnce({
      ok: false,
      provider: "smtp",
      deliveryCertainty: "uncertain",
      detail: "smtp_timeout_after_data",
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(inviteOperation).toMatchObject({
      state: "reconciliation_required",
      retryable: false,
      failureCode: "provider_delivery_uncertain",
    });
    expect(auditRows.map((row) => row["action"])).toContain(
      "partner_user.login_link.reconciliation_required",
    );
  });

  it("honors the external-send kill switch before token or operation work", async () => {
    mockKillSwitch.mockReturnValueOnce("external_sends");

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mockReplaceToken).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(inviteOperation).toBeNull();
  });

  it("keeps a valid request non-enumerating when identity lookup fails", async () => {
    mockFindByEmail.mockRejectedValueOnce(new Error("database unavailable"));

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mockReplaceToken).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});
