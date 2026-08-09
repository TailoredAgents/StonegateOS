import type { NextRequest } from "next/server";

const mockBeginTeamMutation = jest.fn();
const mockClaimIdempotency = jest.fn();
const mockCompleteIdempotency = jest.fn();
const mockExtendIdempotency = jest.fn();
const mockSettleIdempotency = jest.fn();
const mockRecordTeamMutationFailure = jest.fn();
const mockAssertExpectedVersion = jest.fn();
const mockSendEmail = jest.fn();
const mockSendSms = jest.fn();
const mockReadBoundedJsonRequest = jest.fn((request: NextRequest) =>
  request.json(),
);

const mockTables = {
  auditLogs: {
    id: "audit_logs.id",
    action: "audit_logs.action",
    actorId: "audit_logs.actor_id",
    entityId: "audit_logs.entity_id",
    idempotencyKeyHash: "audit_logs.idempotency_key_hash",
  },
  contacts: {
    id: "contacts.id",
    partnerStatus: "contacts.partner_status",
    partnerSince: "contacts.partner_since",
    deletedAt: "contacts.deleted_at",
    updatedAt: "contacts.updated_at",
  },
  partnerLoginTokens: {
    id: "partner_login_tokens.id",
    partnerUserId: "partner_login_tokens.partner_user_id",
    usedAt: "partner_login_tokens.used_at",
  },
  partnerSessions: {
    id: "partner_sessions.id",
    partnerUserId: "partner_sessions.partner_user_id",
    revokedAt: "partner_sessions.revoked_at",
  },
  partnerInviteOperations: {
    id: "partner_invite_operations.id",
    orgContactId: "partner_invite_operations.org_contact_id",
    partnerUserId: "partner_invite_operations.partner_user_id",
    state: "partner_invite_operations.state",
    version: "partner_invite_operations.version",
    dispatchedAt: "partner_invite_operations.dispatched_at",
    resolvedAt: "partner_invite_operations.resolved_at",
  },
  partnerUsers: {
    id: "partner_users.id",
    orgContactId: "partner_users.org_contact_id",
    email: "partner_users.email",
    phone: "partner_users.phone",
    phoneE164: "partner_users.phone_e164",
    name: "partner_users.name",
    active: "partner_users.active",
    passwordSetAt: "partner_users.password_set_at",
    createdAt: "partner_users.created_at",
    updatedAt: "partner_users.updated_at",
  },
};

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const MEMBER_ID = "33333333-3333-4333-8333-333333333333";
const SESSION_ID = "44444444-4444-4444-8444-444444444444";
const CREATED_AT = new Date("2026-08-08T12:00:00.000Z");

let replay: {
  result: Record<string, unknown>;
  status: number;
  correlationId: string;
} | null = null;
const auditRows: Array<Record<string, unknown>> = [];
const tokenRows: Array<Record<string, unknown>> = [];
let inviteOperation: Record<string, unknown> | null = null;
let readingPortalUsers = false;
let organizationExists = true;
let portalUserActive = true;

function rowsFor(table: unknown): Array<Record<string, unknown>> {
  if (table === mockTables.contacts) {
    if (!organizationExists) return [];
    return [
      {
        id: ORG_ID,
        partnerStatus: "partner",
        partnerSince: CREATED_AT,
        deletedAt: null,
        updatedAt: CREATED_AT,
      },
    ];
  }
  if (table === mockTables.auditLogs) return [];
  if (table === mockTables.partnerInviteOperations) {
    return inviteOperation ? [inviteOperation] : [];
  }
  if (table === mockTables.partnerUsers) {
    return readingPortalUsers
      ? [
          {
            id: USER_ID,
            orgContactId: ORG_ID,
            email: "portal@example.test",
            phone: null,
            phoneE164: null,
            name: "Portal User",
            active: portalUserActive,
            passwordSetAt: null,
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT,
          },
        ]
      : [];
  }
  return [];
}

function queryResult(rows: Array<Record<string, unknown>>) {
  const promise = Promise.resolve(rows);
  return {
    for: jest.fn(() => ({ limit: jest.fn(() => promise) })),
    limit: jest.fn(() => promise),
    orderBy: jest.fn(() => ({ limit: jest.fn(() => promise) })),
    then: promise.then.bind(promise),
  };
}

const mockTx = {
  select: jest.fn(() => ({
    from: jest.fn((table: unknown) => ({
      where: jest.fn(() => queryResult(rowsFor(table))),
    })),
  })),
  insert: jest.fn((table: unknown) => ({
    values: jest.fn((values: Record<string, unknown>) => {
      if (table === mockTables.auditLogs) auditRows.push(values);
      if (table === mockTables.partnerLoginTokens) tokenRows.push(values);
      if (table === mockTables.partnerInviteOperations) {
        inviteOperation = { ...values };
      }
      const promise = Promise.resolve(undefined);
      return Object.assign(promise, {
        returning: jest.fn(() => {
          if (table === mockTables.partnerUsers) {
            return Promise.resolve([
              {
                id: USER_ID,
                orgContactId: ORG_ID,
                email: "portal@example.test",
                phone: null,
                phoneE164: null,
                name: "Portal User",
                active: true,
                createdAt: CREATED_AT,
              },
            ]);
          }
          return Promise.resolve([]);
        }),
      });
    }),
  })),
  update: jest.fn((table: unknown) => ({
    set: jest.fn((values: Record<string, unknown>) => ({
      where: jest.fn(() => ({
        returning: jest.fn(() => {
          if (table === mockTables.partnerInviteOperations) {
            inviteOperation = { ...(inviteOperation ?? {}), ...values };
            return Promise.resolve([{ id: inviteOperation["id"] }]);
          }
          if (table === mockTables.partnerUsers) {
            if ("active" in values) {
              portalUserActive = values["active"] === true;
              return Promise.resolve([{ id: USER_ID }]);
            }
            return Promise.resolve([
              {
                id: USER_ID,
                orgContactId: ORG_ID,
                email: "portal@example.test",
                phone: null,
                phoneE164: null,
                name: values["name"] ?? "Portal User",
                active: true,
                createdAt: CREATED_AT,
                updatedAt: values["updatedAt"] ?? CREATED_AT,
              },
            ]);
          }
          if (table === mockTables.partnerSessions) {
            return Promise.resolve([{ id: "session-1" }]);
          }
          if (table === mockTables.partnerLoginTokens) {
            return Promise.resolve([{ id: "token-1" }]);
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
const mockGetDb = jest.fn(() => mockDb);

jest.mock("drizzle-orm", () => ({
  and: jest.fn((...values: unknown[]) => ({ kind: "and", values })),
  asc: jest.fn((value: unknown) => ({ kind: "asc", value })),
  eq: jest.fn((...values: unknown[]) => ({ kind: "eq", values })),
  inArray: jest.fn((...values: unknown[]) => ({ kind: "inArray", values })),
  isNull: jest.fn((value: unknown) => ({ kind: "isNull", value })),
}));

jest.mock("@/db", () => ({ ...mockTables, getDb: mockGetDb }));
jest.mock("@/lib/audit-metadata", () => ({
  sanitizeAuditMetadata: jest.fn((value: unknown) => value),
}));
jest.mock("@/lib/messaging", () => ({
  sendEmailMessage: mockSendEmail,
  sendSmsMessage: mockSendSms,
}));
jest.mock("@/lib/partner-portal-auth", () => ({
  getClientIp: jest.fn(() => "127.0.0.1"),
  getUserAgent: jest.fn(() => "test-agent"),
  normalizeEmail: jest.fn((value: unknown) =>
    typeof value === "string" ? value.trim().toLowerCase() : null,
  ),
  normalizePhoneE164: jest.fn(() => null),
  randomToken: jest.fn(() => "raw-partner-token"),
  replacePartnerLoginTokenInTransaction: jest.fn(
    async (
      tx: typeof mockTx,
      input: {
        partnerUserId: string;
        requestedIp: string | null;
        userAgent: string | null;
        ttlMinutes: number;
        now: Date;
      },
    ) => {
      const expiresAt = new Date(
        input.now.getTime() + input.ttlMinutes * 60 * 1_000,
      );
      await tx.insert(mockTables.partnerLoginTokens).values({
        partnerUserId: input.partnerUserId,
        tokenHash: "hashed-partner-token",
        requestedIp: input.requestedIp,
        userAgent: input.userAgent,
        expiresAt,
        createdAt: input.now,
      });
      return { rawToken: "raw-partner-token", expiresAt };
    },
  ),
  resolvePublicSiteBaseUrl: jest.fn(() => "https://site.test"),
  sha256Base64Url: jest.fn(() => "hashed-partner-token"),
}));
jest.mock("@/lib/permissions", () => ({ requirePermission: jest.fn() }));
jest.mock("../../app/api/web/admin", () => ({
  isAdminRequest: jest.fn(() => true),
}));

class MockBoundedJsonRequestError extends Error {
  readonly code: string;
  readonly status: 400 | 408 | 413 | 415;

  constructor(code: string, message: string, status: 400 | 408 | 413 | 415) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

jest.mock("@/lib/bounded-json-request", () => ({
  BoundedJsonRequestError: MockBoundedJsonRequestError,
  readBoundedJsonRequest: mockReadBoundedJsonRequest,
}));

class MockTeamMutationFailure extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly fieldErrors?: Record<string, string>;

  constructor(
    code: string,
    message: string,
    options: {
      status?: number;
      retryable?: boolean;
      fieldErrors?: Record<string, string>;
    } = {},
  ) {
    super(message);
    this.code = code;
    this.status =
      options.status ??
      (code === "invalid"
        ? 422
        : code === "conflict"
          ? 409
          : code === "provider_failed"
            ? 502
            : 500);
    this.retryable = options.retryable ?? false;
    this.fieldErrors = options.fieldErrors;
  }
}

function failureResult(error: unknown) {
  const failure =
    error instanceof MockTeamMutationFailure
      ? error
      : new MockTeamMutationFailure("internal", "Internal failure", {
          retryable: true,
        });
  return {
    result: {
      ok: false as const,
      code: failure.code,
      message: failure.message,
      retryable: failure.retryable,
      ...(failure.fieldErrors ? { fieldErrors: failure.fieldErrors } : {}),
    },
    status: failure.status,
  };
}

jest.mock("@/lib/team-mutation", () => ({
  assertTeamMutationExpectedVersion: mockAssertExpectedVersion,
  TeamMutationFailure: MockTeamMutationFailure,
  beginTeamMutation: mockBeginTeamMutation,
  recordTeamMutationFailure: mockRecordTeamMutationFailure,
  teamMutationErrorResponse: jest.fn(
    (code: string, message: string, options?: { correlationId?: string }) =>
      Response.json(
        { ok: false, code, message, retryable: false },
        {
          status:
            code === "invalid" ? 422 : code === "provider_failed" ? 502 : 500,
          headers: options?.correlationId
            ? { "x-correlation-id": options.correlationId }
            : undefined,
        },
      ),
  ),
  teamMutationExceptionResult: jest.fn(failureResult),
  teamMutationExceptionResponse: jest.fn((error: unknown) => {
    const terminal = failureResult(error);
    return Response.json(terminal.result, { status: terminal.status });
  }),
  teamMutationResultResponse: jest.fn(
    (
      result: unknown,
      status: number,
      correlationId: string,
      headers?: HeadersInit,
    ) => {
      const resolved = new Headers(headers);
      resolved.set("x-correlation-id", correlationId);
      return Response.json(result, { status, headers: resolved });
    },
  ),
  teamMutationSuccessResult: jest.fn(
    (_mutation: unknown, data: unknown, receipt: unknown) => ({
      ok: true,
      data,
      receipt,
    }),
  ),
}));

jest.mock("@/lib/team-mutation-idempotency", () => ({
  claimTeamMutationIdempotency: mockClaimIdempotency,
  completeTeamMutationIdempotency: mockCompleteIdempotency,
  extendTeamMutationIdempotencyLease: mockExtendIdempotency,
  settleTeamMutationIdempotencyFailure: mockSettleIdempotency,
  teamMutationIdempotencyReplayResponse: jest.fn(
    (stored: {
      result: Record<string, unknown>;
      status: number;
      correlationId: string;
    }) =>
      Response.json(stored.result, {
        status: stored.status,
        headers: {
          "idempotency-replayed": "true",
          "x-correlation-id": stored.correlationId,
        },
      }),
  ),
}));

import { GET, PATCH, POST } from "../../app/api/admin/partners/users/route";

const mutation = {
  policy: {
    principalTypes: ["human"],
    requiredPermissions: ["partners.invite"],
    risk: "external",
    requiresIdempotency: true,
    auditAction: "partner_user.invited",
  },
  actor: {
    type: "human",
    id: MEMBER_ID,
    role: "owner",
    label: "Owner",
    sessionId: SESSION_ID,
    authMethod: "team_session",
  },
  principalType: "human",
  operationId: "55555555-5555-4555-8555-555555555555",
  correlationId: "partner-invite-correlation",
  idempotencyKeyHash: "a".repeat(64),
  expectedVersion: "new",
  audit: {
    insertSuccess: jest.fn(
      (
        _tx: unknown,
        input: { entityId: string; metadata?: Record<string, unknown> },
      ) => {
        auditRows.push({
          action: "partner_user.invited",
          outcome: "succeeded",
          entityId: input.entityId,
          meta: input.metadata,
        });
        return Promise.resolve({
          auditEventId: "success-audit-id",
          committedAt: CREATED_AT.toISOString(),
        });
      },
    ),
  },
};

const accessMutation = {
  ...mutation,
  policy: {
    principalTypes: ["human"],
    requiredPermissions: ["partners.invite"],
    risk: "destructive",
    requiresIdempotency: true,
    auditAction: "partner_user.access_changed",
  },
  operationId: "66666666-6666-4666-8666-666666666666",
  correlationId: "partner-access-correlation",
  expectedVersion: CREATED_AT.toISOString(),
};

function inviteRequest(): NextRequest & { json: jest.Mock } {
  return {
    headers: new Headers(),
    nextUrl: new URL("https://api.test/api/admin/partners/users"),
    json: jest.fn(() =>
      Promise.resolve({
        orgContactId: ORG_ID,
        email: "portal@example.test",
        name: "Portal User",
        phone: null,
      }),
    ),
  } as unknown as NextRequest & { json: jest.Mock };
}

describe("partner portal invitation route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    replay = null;
    inviteOperation = null;
    readingPortalUsers = false;
    organizationExists = true;
    portalUserActive = true;
    auditRows.splice(0, auditRows.length);
    tokenRows.splice(0, tokenRows.length);
    mockBeginTeamMutation.mockResolvedValue({ ok: true, mutation });
    mockReadBoundedJsonRequest.mockImplementation((request: NextRequest) =>
      request.json(),
    );
    mockClaimIdempotency.mockImplementation(() =>
      replay
        ? { kind: "replay", replay }
        : {
            kind: "execute",
            claim: {
              id: "claim-id",
              operationId: mutation.operationId,
              principalHash: "principal-hash",
              keyHash: mutation.idempotencyKeyHash,
              scopeHash: "scope-hash",
              requestHash: "request-hash",
              attemptCount: 1,
            },
          },
    );
    mockCompleteIdempotency.mockImplementation(
      (
        _tx: unknown,
        _mutation: unknown,
        _claim: unknown,
        result: Record<string, unknown>,
        status: number,
      ) => {
        replay = {
          result,
          status,
          correlationId: mutation.correlationId,
        };
      },
    );
    mockSettleIdempotency.mockResolvedValue(undefined);
    mockExtendIdempotency.mockResolvedValue(
      new Date("2026-08-08T12:05:00.000Z"),
    );
  });

  it("deactivates the exact versioned portal user and revokes access state atomically", async () => {
    readingPortalUsers = true;
    mockBeginTeamMutation.mockResolvedValueOnce({
      ok: true,
      mutation: accessMutation,
    });
    const request = inviteRequest();
    request.json.mockResolvedValueOnce({
      active: false,
      confirmation: "DEACTIVATE",
      orgContactId: ORG_ID,
      userId: USER_ID,
    });

    const response = await PATCH(request);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      data: {
        userId: USER_ID,
        orgContactId: ORG_ID,
        active: false,
        sessionsRevoked: 1,
        tokensInvalidated: 1,
      },
    });
    expect(portalUserActive).toBe(false);
    expect(accessMutation.audit.insertSuccess).toHaveBeenCalledTimes(1);
    const successAuditInput =
      accessMutation.audit.insertSuccess.mock.calls[0]?.[1];
    expect(successAuditInput).toMatchObject({
      entityType: "partner_user",
      entityId: USER_ID,
      before: { active: true },
      after: { active: false },
    });
    expect(mockCompleteIdempotency).toHaveBeenCalled();
  });

  it.each([
    ["requested", "failed", "partner_user.invite.quarantined"],
    [
      "dispatched",
      "reconciliation_required",
      "partner_user.invite.reconciliation_required",
    ],
    ["reconciliation_required", "reconciliation_required", null],
  ] as const)(
    "deactivates through an unresolved %s invite while preserving terminal evidence",
    async (beforeState, afterState, expectedAuditAction) => {
      readingPortalUsers = true;
      inviteOperation = {
        id: "77777777-7777-4777-8777-777777777777",
        partnerUserId: USER_ID,
        state: beforeState,
        version: beforeState === "requested" ? 1 : 2,
        dispatchedAt:
          beforeState === "requested"
            ? null
            : new Date("2026-08-08T11:59:00.000Z"),
      };
      mockBeginTeamMutation.mockResolvedValueOnce({
        ok: true,
        mutation: accessMutation,
      });
      const request = inviteRequest();
      request.json.mockResolvedValueOnce({
        active: false,
        confirmation: "DEACTIVATE",
        orgContactId: ORG_ID,
        userId: USER_ID,
      });

      const response = await PATCH(request);

      expect(response.status).toBe(200);
      expect(portalUserActive).toBe(false);
      expect(inviteOperation).toMatchObject({ state: afterState });
      if (expectedAuditAction) {
        expect(auditRows).toContainEqual(
          expect.objectContaining({ action: expectedAuditAction }),
        );
      }
      expect(mockCompleteIdempotency).toHaveBeenCalled();
    },
  );

  it("continues to block activation while invite delivery is unresolved", async () => {
    readingPortalUsers = true;
    portalUserActive = false;
    inviteOperation = {
      id: "77777777-7777-4777-8777-777777777777",
      partnerUserId: USER_ID,
      state: "reconciliation_required",
      version: 3,
      dispatchedAt: new Date("2026-08-08T11:59:00.000Z"),
    };
    mockBeginTeamMutation.mockResolvedValueOnce({
      ok: true,
      mutation: accessMutation,
    });
    const request = inviteRequest();
    request.json.mockResolvedValueOnce({
      active: true,
      confirmation: "ACTIVATE",
      orgContactId: ORG_ID,
      userId: USER_ID,
    });

    const response = await PATCH(request);

    expect(response.status).toBe(409);
    expect(portalUserActive).toBe(false);
    expect(inviteOperation).toMatchObject({
      state: "reconciliation_required",
      version: 3,
    });
    expect(mockCompleteIdempotency).not.toHaveBeenCalled();
  });

  it("rejects a cross-organization access target before any state change", async () => {
    readingPortalUsers = true;
    mockBeginTeamMutation.mockResolvedValueOnce({
      ok: true,
      mutation: accessMutation,
    });
    const request = inviteRequest();
    request.json.mockResolvedValueOnce({
      active: false,
      confirmation: "DEACTIVATE",
      orgContactId: "77777777-7777-4777-8777-777777777777",
      userId: USER_ID,
    });

    const response = await PATCH(request);

    expect(response.status).toBe(409);
    expect(portalUserActive).toBe(true);
    expect(mockCompleteIdempotency).not.toHaveBeenCalled();
  });

  it("rejects an oversized body before database or provider work and audits the failure", async () => {
    mockReadBoundedJsonRequest.mockRejectedValueOnce(
      new MockBoundedJsonRequestError(
        "body_too_large",
        "The request body is too large.",
        413,
      ),
    );

    const response = await POST(inviteRequest());

    expect(response.status).toBe(413);
    expect(mockGetDb).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockRecordTeamMutationFailure).toHaveBeenCalledWith(
      mutation,
      expect.objectContaining({
        outcome: "denied",
        entityType: "partner_user",
        code: "invalid",
        metadata: { boundary: "input" },
      }),
    );
  });

  it("rejects unsupported invite fields before database or provider work", async () => {
    const request = inviteRequest();
    request.json.mockResolvedValueOnce({
      orgContactId: ORG_ID,
      email: "portal@example.test",
      name: "Portal User",
      phone: null,
      activateOrganization: true,
    });

    const response = await POST(request);

    expect(response.status).toBe(422);
    expect(mockGetDb).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("checks the verified mutation boundary before parsing or opening the database", async () => {
    const request = inviteRequest();
    mockBeginTeamMutation.mockResolvedValueOnce({
      ok: false,
      response: Response.json(
        { ok: false, code: "forbidden", message: "Forbidden" },
        { status: 403 },
      ),
    });

    const response = await POST(request);

    expect(response.status).toBe(403);
    expect(request.json).not.toHaveBeenCalled();
    expect(mockGetDb).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("rejects repeated or unknown portal-user query parameters before database access", async () => {
    const response = await GET({
      url: `https://api.test/api/admin/partners/users?orgContactId=${ORG_ID}&orgContactId=${ORG_ID}&extra=1`,
    } as NextRequest);

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mockGetDb).not.toHaveBeenCalled();
  });

  it("returns a strict, explicit organization and portal-user snapshot", async () => {
    readingPortalUsers = true;
    const response = await GET({
      url: `https://api.test/api/admin/partners/users?orgContactId=${ORG_ID}`,
    } as NextRequest);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body).toEqual({
      ok: true,
      organization: {
        id: ORG_ID,
        partnerStatus: "partner",
        version: CREATED_AT.toISOString(),
      },
      users: [
        {
          id: USER_ID,
          orgContactId: ORG_ID,
          email: "portal@example.test",
          phone: null,
          phoneE164: null,
          name: "Portal User",
          active: true,
          passwordSetAt: null,
          createdAt: CREATED_AT.toISOString(),
          updatedAt: CREATED_AT.toISOString(),
        },
      ],
    });
  });

  it("does not turn a missing organization into a silent empty user list", async () => {
    readingPortalUsers = true;
    organizationExists = false;
    const response = await GET({
      url: `https://api.test/api/admin/partners/users?orgContactId=${ORG_ID}`,
    } as NextRequest);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(404);
    expect(body).toMatchObject({
      ok: false,
      error: "partner_organization_not_found",
    });
  });

  it("returns provider_failed and audits every known non-send", async () => {
    mockSendEmail.mockResolvedValue({
      ok: false,
      provider: "smtp",
      deliveryCertainty: "not_sent",
      detail: "email_not_configured",
    });

    const response = await POST(inviteRequest());
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(502);
    expect(response.headers.get("x-operation-state")).toBe("failed");
    expect(body).toMatchObject({
      ok: false,
      code: "provider_failed",
      retryable: true,
    });
    expect(tokenRows).toHaveLength(1);
    expect(auditRows.map((row) => row["action"])).toEqual([
      "partner_user.invite.attempted",
      "partner_user.invite.dispatched",
      "partner_user.invite.channel.failed",
      "partner_user.invite.failed",
    ]);
    expect(auditRows[1]).toMatchObject({
      action: "partner_user.invite.dispatched",
    });
    expect(auditRows[2]).toMatchObject({
      providerOperationId: null,
      meta: {
        channel: "email",
        state: "failed",
        provider: "smtp",
        providerExactlyOnceClaimed: false,
        detail: "email_not_configured",
      },
    });
    expect(mockCompleteIdempotency).toHaveBeenCalledTimes(1);
    expect(mockExtendIdempotency).toHaveBeenCalledTimes(2);
    expect(mockExtendIdempotency.mock.invocationCallOrder[0]).toBeLessThan(
      mockSendEmail.mock.invocationCallOrder[0]!,
    );
    expect(mutation.audit.insertSuccess).not.toHaveBeenCalled();
  });

  it("requires the current portal-user version before editing or resending to an existing identity", async () => {
    readingPortalUsers = true;

    const response = await POST(inviteRequest());

    expect(response.status).toBe(409);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(tokenRows).toHaveLength(0);
  });

  it("binds an existing-user identity update and resend to If-Match", async () => {
    readingPortalUsers = true;
    const versionedMutation = {
      ...mutation,
      expectedVersion: CREATED_AT.toISOString(),
    };
    mockBeginTeamMutation.mockResolvedValueOnce({
      ok: true,
      mutation: versionedMutation,
    });
    mockSendEmail.mockResolvedValue({
      ok: true,
      provider: "smtp",
      providerMessageId: "mail-versioned-provider-id",
      deliveryCertainty: "accepted",
    });

    const response = await POST(inviteRequest());

    expect(response.status).toBe(200);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockAssertExpectedVersion).toHaveBeenCalledWith(
      versionedMutation,
      CREATED_AT,
    );
    expect(mockExtendIdempotency).toHaveBeenCalledWith(
      mockDb,
      versionedMutation,
      expect.anything(),
      5 * 60 * 1000,
    );
    expect(mockExtendIdempotency).toHaveBeenCalledTimes(2);
  });

  it("quarantines an uncertain provider effect and never reports success", async () => {
    mockSendEmail.mockResolvedValue({
      ok: false,
      provider: "smtp",
      deliveryCertainty: "uncertain",
      detail: "email_transport_error",
    });

    const response = await POST(inviteRequest());
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(response.headers.get("x-operation-state")).toBe(
      "reconciliation_required",
    );
    expect(body).toMatchObject({ ok: false, code: "conflict" });
    expect(auditRows.map((row) => row["action"])).toEqual([
      "partner_user.invite.attempted",
      "partner_user.invite.dispatched",
      "partner_user.invite.channel.reconciliation_required",
      "partner_user.invite.reconciliation_required",
    ]);
    expect(mutation.audit.insertSuccess).not.toHaveBeenCalled();
  });

  it("replays a completed caller key without creating another token or provider send", async () => {
    mockSendEmail.mockResolvedValue({
      ok: true,
      provider: "smtp",
      providerMessageId: "mail-provider-id",
      deliveryCertainty: "accepted",
    });

    const first = await POST(inviteRequest());
    const second = await POST(inviteRequest());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers.get("idempotency-replayed")).toBe("true");
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(tokenRows).toHaveLength(1);
    expect(auditRows.map((row) => row["action"])).toEqual([
      "partner_user.invite.attempted",
      "partner_user.invite.dispatched",
      "partner_user.invite.channel.succeeded",
      "partner_user.invited",
    ]);
  });

  it("preserves a late provider receipt when the terminal commit response is interrupted", async () => {
    mockSendEmail.mockResolvedValue({
      ok: true,
      provider: "smtp",
      providerMessageId: "mail-late-provider-id",
      deliveryCertainty: "accepted",
    });
    mockCompleteIdempotency.mockImplementationOnce(
      (
        _tx: unknown,
        _mutation: unknown,
        _claim: unknown,
        result: Record<string, unknown>,
        status: number,
      ) => {
        replay = {
          result,
          status,
          correlationId: mutation.correlationId,
        };
        throw new Error("commit_response_interrupted");
      },
    );

    const response = await POST(inviteRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("idempotency-replayed")).toBe("true");
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const lateOutcome = auditRows.find(
      (row) => row["action"] === "partner_user.invite.late_provider_outcome",
    );
    expect(lateOutcome).toMatchObject({
      action: "partner_user.invite.late_provider_outcome",
      providerOperationId: "mail-late-provider-id",
    });
    expect(lateOutcome?.["meta"]).toMatchObject({
      state: "succeeded",
      providerExactlyOnceClaimed: false,
      terminalReceiptAlreadyPresent: true,
    });
  });

  it("blocks an unresolved public login-link operation without redispatching from the admin route", async () => {
    inviteOperation = {
      id: "66666666-6666-4666-8666-666666666666",
      operationKind: "public_login_link",
      initiatorType: "public_request",
      partnerUserId: USER_ID,
      state: "reconciliation_required",
      version: 3,
    };

    const response = await POST(inviteRequest());

    expect(response.status).toBe(409);
    expect(response.headers.get("x-operation-state")).toBe(
      "reconciliation_required",
    );
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockSendSms).not.toHaveBeenCalled();
    expect(tokenRows).toHaveLength(0);
    expect(auditRows).toHaveLength(0);
  });
});
