import type { NextRequest } from "next/server";

const mockBeginTeamMutation = jest.fn();
const mockClaimIdempotency = jest.fn();
const mockCompleteIdempotency = jest.fn();
const mockSettleIdempotency = jest.fn();
const mockRecordFailure = jest.fn();
const mockRecover = jest.fn();
const mockRequirePermission = jest.fn();
const mockReadBoundedJsonRequest = jest.fn((request: NextRequest) =>
  request.json(),
);

const mockTables = {
  partnerInviteOperations: {
    id: "partner_invite_operations.id",
    orgContactId: "partner_invite_operations.org_contact_id",
    partnerUserId: "partner_invite_operations.partner_user_id",
    operationKind: "partner_invite_operations.operation_kind",
    initiatorType: "partner_invite_operations.initiator_type",
    requestedChannels: "partner_invite_operations.requested_channels",
    correlationId: "partner_invite_operations.correlation_id",
    actorMemberId: "partner_invite_operations.actor_member_id",
    actorLabel: "partner_invite_operations.actor_label",
    state: "partner_invite_operations.state",
    version: "partner_invite_operations.version",
    providerOperationIds: "partner_invite_operations.provider_operation_ids",
    providerEvidence: "partner_invite_operations.provider_evidence",
    failureCode: "partner_invite_operations.failure_code",
    failureDetail: "partner_invite_operations.failure_detail",
    requestedAt: "partner_invite_operations.requested_at",
    dispatchedAt: "partner_invite_operations.dispatched_at",
    reconciliationRequiredAt:
      "partner_invite_operations.reconciliation_required_at",
    resolvedAt: "partner_invite_operations.resolved_at",
    resolution: "partner_invite_operations.resolution",
    resolutionEvidence: "partner_invite_operations.resolution_evidence",
    resolvedBy: "partner_invite_operations.resolved_by",
    resolutionAuditEventId:
      "partner_invite_operations.resolution_audit_event_id",
    updatedAt: "partner_invite_operations.updated_at",
  },
  partnerLoginTokens: {
    id: "partner_login_tokens.id",
    partnerUserId: "partner_login_tokens.partner_user_id",
    usedAt: "partner_login_tokens.used_at",
  },
  partnerUsers: {
    id: "partner_users.id",
    name: "partner_users.name",
    email: "partner_users.email",
  },
};

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "33333333-3333-4333-8333-333333333333";
const MEMBER_ID = "44444444-4444-4444-8444-444444444444";
const SESSION_ID = "55555555-5555-4555-8555-555555555555";
const AUDIT_ID = "66666666-6666-4666-8666-666666666666";
const NOW = new Date("2026-08-08T12:00:00.000Z");

let operationVersion = 3;
let operationResolvedAt: Date | null = null;
let durableProviderOperationIds: string[] = [];
let durableProviderEvidence: Array<Record<string, unknown>> = [];
const operationUpdates: Array<Record<string, unknown>> = [];
const tokenUpdates: Array<Record<string, unknown>> = [];

function operationRow() {
  return {
    id: OPERATION_ID,
    orgContactId: ORG_ID,
    partnerUserId: USER_ID,
    userName: "Portal User",
    userEmail: "portal@example.test",
    operationKind: "team_invite",
    initiatorType: "team_member",
    requestedChannels: ["email"],
    correlationId: "partner-invite-correlation",
    actorMemberId: MEMBER_ID,
    actorLabel: "Owner",
    state: "reconciliation_required",
    version: operationVersion,
    providerOperationIds: durableProviderOperationIds,
    providerEvidence: durableProviderEvidence,
    failureCode: "provider_delivery_uncertain",
    failureDetail: "Provider outcome is uncertain.",
    requestedAt: new Date("2026-08-08T11:55:00.000Z"),
    dispatchedAt: new Date("2026-08-08T11:55:01.000Z"),
    reconciliationRequiredAt: new Date("2026-08-08T11:56:00.000Z"),
    resolvedAt: operationResolvedAt,
    updatedAt: new Date("2026-08-08T11:56:00.000Z"),
  };
}

const mockTx = {
  select: jest.fn(() => ({
    from: jest.fn(() => ({
      where: jest.fn(() => ({
        for: jest.fn(() => ({
          limit: jest.fn(() => Promise.resolve([operationRow()])),
        })),
      })),
    })),
  })),
  update: jest.fn((table: unknown) => ({
    set: jest.fn((values: Record<string, unknown>) => ({
      where: jest.fn(() => ({
        returning: jest.fn(() => {
          if (table === mockTables.partnerLoginTokens) {
            tokenUpdates.push(values);
            return Promise.resolve([{ id: "token-1" }]);
          }
          operationUpdates.push(values);
          operationVersion = Number(values["version"]);
          operationResolvedAt = values["resolvedAt"] as Date;
          return Promise.resolve([{ version: operationVersion }]);
        }),
      })),
    })),
  })),
};

const mockDb = {
  select: jest.fn(() => ({
    from: jest.fn(() => ({
      innerJoin: jest.fn(() => ({
        where: jest.fn(() => ({
          orderBy: jest.fn(() => ({
            limit: jest.fn(() => Promise.resolve([operationRow()])),
          })),
        })),
      })),
    })),
  })),
  transaction: jest.fn(
    async (callback: (transaction: typeof mockTx) => Promise<unknown>) =>
      callback(mockTx),
  ),
};

jest.mock("@/db", () => ({ ...mockTables, getDb: jest.fn(() => mockDb) }));
jest.mock("drizzle-orm", () => ({
  and: jest.fn((...values: unknown[]) => ({ kind: "and", values })),
  desc: jest.fn((value: unknown) => ({ kind: "desc", value })),
  eq: jest.fn((...values: unknown[]) => ({ kind: "eq", values })),
  isNull: jest.fn((value: unknown) => ({ kind: "isNull", value })),
}));
jest.mock("@/lib/permissions", () => ({
  requirePermission: mockRequirePermission,
}));
jest.mock("@/lib/partner-invite-recovery", () => ({
  recoverStalePartnerInviteOperations: mockRecover,
}));
jest.mock("@/lib/bounded-json-request", () => ({
  BoundedJsonRequestError: class BoundedJsonRequestError extends Error {},
  readBoundedJsonRequest: mockReadBoundedJsonRequest,
}));
jest.mock("../../app/api/web/admin", () => ({
  isAdminRequest: jest.fn(() => true),
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
      fieldErrors?: Record<string, string>;
      retryable?: boolean;
    } = {},
  ) {
    super(message);
    this.code = code;
    this.status = code === "invalid" ? 422 : code === "conflict" ? 409 : 500;
    this.retryable = options.retryable ?? false;
    this.fieldErrors = options.fieldErrors;
  }
}

function failureResponse(error: unknown): Response {
  const failure =
    error instanceof MockTeamMutationFailure
      ? error
      : new MockTeamMutationFailure("internal", "Internal failure");
  return Response.json(
    {
      ok: false,
      code: failure.code,
      message: failure.message,
      retryable: failure.retryable,
      ...(failure.fieldErrors ? { fieldErrors: failure.fieldErrors } : {}),
    },
    { status: failure.status },
  );
}

jest.mock("@/lib/team-mutation", () => ({
  beginTeamMutation: mockBeginTeamMutation,
  recordTeamMutationFailure: mockRecordFailure,
  TeamMutationFailure: MockTeamMutationFailure,
  teamMutationExceptionResponse: jest.fn(failureResponse),
  teamMutationResultResponse: jest.fn(
    (result: unknown, status: number, correlationId: string) =>
      Response.json(result, {
        status,
        headers: { "x-correlation-id": correlationId },
      }),
  ),
  teamMutationSuccessResult: jest.fn(
    (
      mutation: {
        operationId: string;
        correlationId: string;
        actor: { id: string };
      },
      data: unknown,
      receipt: Record<string, unknown>,
    ) => ({
      ok: true,
      data,
      receipt: {
        operationId: mutation.operationId,
        correlationId: mutation.correlationId,
        actorId: mutation.actor.id,
        ...receipt,
      },
    }),
  ),
}));
jest.mock("@/lib/team-mutation-idempotency", () => ({
  claimTeamMutationIdempotency: mockClaimIdempotency,
  completeTeamMutationIdempotency: mockCompleteIdempotency,
  settleTeamMutationIdempotencyFailure: mockSettleIdempotency,
  teamMutationIdempotencyReplayResponse: jest.fn(),
}));

import {
  GET,
  POST,
} from "../../app/api/admin/partners/invite-operations/route";

const mutation = {
  policy: {
    principalTypes: ["human"],
    requiredPermissions: ["partners.invite"],
    risk: "destructive",
    requiresIdempotency: true,
    auditAction: "partner_user.invite.reconciled",
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
  operationId: "77777777-7777-4777-8777-777777777777",
  correlationId: "partner-reconciliation-correlation",
  idempotencyKeyHash: "a".repeat(64),
  expectedVersion: "3",
  audit: {
    insertSuccess: jest.fn(
      (_transaction: unknown, _input: { metadata?: Record<string, unknown> }) =>
        Promise.resolve({
          auditEventId: AUDIT_ID,
          committedAt: NOW.toISOString(),
        }),
    ),
  },
};

function request(body: Record<string, unknown> = {}): NextRequest & {
  json: jest.Mock;
} {
  return {
    url: "https://api.test/api/admin/partners/invite-operations",
    headers: new Headers(),
    json: jest.fn(() => Promise.resolve(body)),
  } as unknown as NextRequest & { json: jest.Mock };
}

function validResolution() {
  return {
    operationId: OPERATION_ID,
    outcome: "confirmed_not_sent",
    confirmation: "CONFIRM NOT SENT",
    evidenceType: "provider_no_matching_send",
    reviewedChannels: ["email"],
    providerOperationIds: [],
    reason: "Provider search confirmed that no matching message was sent.",
  };
}

describe("partner invite operator reconciliation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    operationVersion = 3;
    operationResolvedAt = null;
    durableProviderOperationIds = [];
    durableProviderEvidence = [];
    operationUpdates.splice(0, operationUpdates.length);
    tokenUpdates.splice(0, tokenUpdates.length);
    mockBeginTeamMutation.mockResolvedValue({ ok: true, mutation });
    mockRequirePermission.mockResolvedValue(null);
    mockRecover.mockResolvedValue({
      scanned: 0,
      requestedQuarantined: 0,
      dispatchedReconciled: 0,
      skipped: 0,
      errors: 0,
    });
    mockClaimIdempotency.mockResolvedValue({
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
    });
    mockCompleteIdempotency.mockResolvedValue(undefined);
    mockSettleIdempotency.mockResolvedValue(undefined);
    mockReadBoundedJsonRequest.mockImplementation((input: NextRequest) =>
      input.json(),
    );
  });

  it("runs bounded recovery and exposes uncertain provider evidence without caching", async () => {
    const response = await GET(request());
    const body = (await response.json()) as {
      items: Array<Record<string, unknown>>;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mockRecover).toHaveBeenCalledWith({ db: mockDb, limit: 25 });
    expect(body.items[0]).toMatchObject({
      id: OPERATION_ID,
      state: "reconciliation_required",
      providerOutcomePreserved: true,
      automaticRedispatchAllowed: false,
    });
  });

  it("records conclusive non-send evidence, invalidates the token, and releases only the guard", async () => {
    const response = await POST(request(validResolution()));
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      data: {
        operationId: OPERATION_ID,
        outcome: "confirmed_not_sent",
        operationVersion: 4,
        guardReleased: true,
        providerCalled: false,
        tokensInvalidated: 1,
      },
    });
    expect(tokenUpdates[0]?.["usedAt"]).toBeInstanceOf(Date);
    expect(operationUpdates).toContainEqual(
      expect.objectContaining({
        resolution: "confirmed_not_sent",
        resolvedBy: MEMBER_ID,
        resolutionAuditEventId: AUDIT_ID,
        version: 4,
      }),
    );
    expect(mutation.audit.insertSuccess).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({
        entityType: "partner_invite_operation",
      }),
    );
    const auditInput = mutation.audit.insertSuccess.mock.calls[0]?.[1] as
      | { metadata?: Record<string, unknown> }
      | undefined;
    expect(auditInput?.metadata).toMatchObject({
      providerCalled: false,
      automaticRedispatchAttempted: false,
    });
    expect(mockCompleteIdempotency).toHaveBeenCalledTimes(1);
  });

  it("rejects stale reviewer versions without releasing the guard", async () => {
    operationVersion = 4;

    const response = await POST(request(validResolution()));

    expect(response.status).toBe(409);
    expect(operationUpdates).toHaveLength(0);
    expect(tokenUpdates).toHaveLength(0);
    expect(mockCompleteIdempotency).not.toHaveBeenCalled();
  });

  it("cannot overwrite durable provider acceptance with a confirmed non-send", async () => {
    durableProviderOperationIds = ["mail-provider-id"];
    durableProviderEvidence = [{ channel: "email", state: "succeeded" }];

    const response = await POST(request(validResolution()));

    expect(response.status).toBe(409);
    expect(operationUpdates).toHaveLength(0);
    expect(tokenUpdates).toHaveLength(0);
  });

  it("rejects incomplete provider evidence before opening the database", async () => {
    const response = await POST(
      request({ ...validResolution(), reviewedChannels: [] }),
    );

    expect(response.status).toBe(422);
    expect(mockClaimIdempotency).not.toHaveBeenCalled();
    expect(operationUpdates).toHaveLength(0);
  });
});
