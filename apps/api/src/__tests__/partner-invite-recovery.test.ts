const mockQuarantine = jest.fn();
const mockTerminal = jest.fn(
  (
    _transaction: unknown,
    _input: {
      operationId: string;
      evidence: unknown[];
      summary: { state: string };
    },
  ): Promise<unknown> => Promise.resolve(undefined),
);
const mockBuildAudit = jest.fn(() => ({
  id: "99999999-9999-4999-8999-999999999999",
  action: "partner_user.invite.recovery",
}));
const mockPlanTerminal = jest.fn(() => ({
  state: "reconciliation_required",
  acceptedChannels: [],
  failedChannels: [],
  uncertainChannels: ["email"],
  providerOperationIds: [],
}));

const mockTables = {
  auditLogs: { id: "audit_logs.id" },
  partnerInviteOperations: {
    id: "partner_invite_operations.id",
    orgContactId: "partner_invite_operations.org_contact_id",
    partnerUserId: "partner_invite_operations.partner_user_id",
    operationKind: "partner_invite_operations.operation_kind",
    correlationId: "partner_invite_operations.correlation_id",
    idempotencyKeyHash: "partner_invite_operations.idempotency_key_hash",
    requestedChannels: "partner_invite_operations.requested_channels",
    state: "partner_invite_operations.state",
    updatedAt: "partner_invite_operations.updated_at",
    resolvedAt: "partner_invite_operations.resolved_at",
  },
  partnerLoginTokens: {
    partnerUserId: "partner_login_tokens.partner_user_id",
    usedAt: "partner_login_tokens.used_at",
  },
};

jest.mock("@/db", () => ({
  ...mockTables,
  getDb: jest.fn(),
}));
jest.mock("drizzle-orm", () => ({
  and: jest.fn((...values: unknown[]) => ({ kind: "and", values })),
  asc: jest.fn((value: unknown) => ({ kind: "asc", value })),
  eq: jest.fn((...values: unknown[]) => ({ kind: "eq", values })),
  isNull: jest.fn((value: unknown) => ({ kind: "isNull", value })),
  lte: jest.fn((...values: unknown[]) => ({ kind: "lte", values })),
  or: jest.fn((...values: unknown[]) => ({ kind: "or", values })),
}));
jest.mock("@/lib/partner-invite-operations", () => ({
  buildPartnerInviteOperationAuditRecord: mockBuildAudit,
  planPartnerInviteTerminal: mockPlanTerminal,
  transitionPartnerInviteOperationToQuarantinedFailure: mockQuarantine,
  transitionPartnerInviteOperationToTerminal: mockTerminal,
}));

import { recoverStalePartnerInviteOperations } from "@/lib/partner-invite-recovery";

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-08-08T12:00:00.000Z");

type Operation = {
  id: string;
  orgContactId: string;
  partnerUserId: string;
  operationKind: "team_invite" | "public_login_link";
  correlationId: string;
  idempotencyKeyHash: string;
  requestedChannels: string[];
  state: "requested" | "dispatched" | "reconciliation_required";
  updatedAt: Date;
  resolvedAt: Date | null;
};

function recoveryDb(operation: Operation | null) {
  const candidateRows = operation ? [{ id: operation.id }] : [];
  const tokenUpdates: Array<Record<string, unknown>> = [];
  const auditRows: Array<Record<string, unknown>> = [];
  const tx = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          for: jest.fn(() => ({
            limit: jest.fn(() => Promise.resolve(operation ? [operation] : [])),
          })),
        })),
      })),
    })),
    insert: jest.fn(() => ({
      values: jest.fn((value: Record<string, unknown>) => {
        auditRows.push(value);
        return Promise.resolve();
      }),
    })),
    update: jest.fn(() => ({
      set: jest.fn((value: Record<string, unknown>) => ({
        where: jest.fn(() => {
          tokenUpdates.push(value);
          return Promise.resolve();
        }),
      })),
    })),
  };
  const db = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          orderBy: jest.fn(() => ({
            limit: jest.fn(() => Promise.resolve(candidateRows)),
          })),
        })),
      })),
    })),
    transaction: jest.fn(
      async (callback: (transaction: typeof tx) => Promise<unknown>) =>
        callback(tx),
    ),
  };
  return { db, auditRows, tokenUpdates };
}

function operation(
  state: Operation["state"],
  updatedAt: Date,
  operationKind: Operation["operationKind"] = "team_invite",
): Operation {
  return {
    id: OPERATION_ID,
    orgContactId: ORG_ID,
    partnerUserId: USER_ID,
    operationKind,
    correlationId: "partner-invite-correlation",
    idempotencyKeyHash: "a".repeat(64),
    requestedChannels: ["email"],
    state,
    updatedAt,
    resolvedAt: null,
  };
}

describe("partner invite crash recovery", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuarantine.mockResolvedValue({ version: 2, completedAt: NOW });
    mockTerminal.mockResolvedValue({
      state: "reconciliation_required",
      version: 3,
      completedAt: NOW,
    });
  });

  it("quarantines a stale pre-dispatch request and invalidates its unused token", async () => {
    const fixture = recoveryDb(
      operation("requested", new Date(NOW.getTime() - 31_000)),
    );

    const stats = await recoverStalePartnerInviteOperations({
      db: fixture.db as never,
      now: NOW,
      requestedStaleMs: 30_000,
      dispatchedStaleMs: 30_000,
    });

    expect(stats).toEqual({
      scanned: 1,
      requestedQuarantined: 1,
      dispatchedReconciled: 0,
      skipped: 0,
      errors: 0,
    });
    expect(mockQuarantine).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operationId: OPERATION_ID,
        failureCode: "requested_operation_lease_expired",
      }),
    );
    expect(mockTerminal).not.toHaveBeenCalled();
    expect(fixture.tokenUpdates).toContainEqual({ usedAt: NOW });
    expect(mockBuildAudit).toHaveBeenCalledWith(
      expect.objectContaining({ actorType: "worker" }),
      expect.objectContaining({
        action: "partner_user.invite.recovery_quarantined",
      }),
    );
    const requestedAuditInput = mockBuildAudit.mock.calls[0]?.[1] as
      | { metadata?: Record<string, unknown> }
      | undefined;
    expect(requestedAuditInput?.metadata).toMatchObject({
      providerCalled: false,
    });
  });

  it("moves a stale post-dispatch public login link to reconciliation without retrying", async () => {
    const fixture = recoveryDb(
      operation(
        "dispatched",
        new Date(NOW.getTime() - 31_000),
        "public_login_link",
      ),
    );

    const stats = await recoverStalePartnerInviteOperations({
      db: fixture.db as never,
      now: NOW,
      requestedStaleMs: 30_000,
      dispatchedStaleMs: 30_000,
    });

    expect(stats.dispatchedReconciled).toBe(1);
    expect(mockQuarantine).not.toHaveBeenCalled();
    expect(mockTerminal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operationId: OPERATION_ID,
        evidence: [],
      }),
    );
    const terminalInput = mockTerminal.mock.calls[0]?.[1] as
      | { summary?: { state?: string } }
      | undefined;
    expect(terminalInput?.summary).toMatchObject({
      state: "reconciliation_required",
    });
    expect(fixture.tokenUpdates).toHaveLength(0);
    expect(mockBuildAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "partner_user.login_link.recovery_reconciliation_required",
      }),
    );
    const dispatchedAuditInput = mockBuildAudit.mock.calls[0]?.[1] as
      | { metadata?: Record<string, unknown> }
      | undefined;
    expect(dispatchedAuditInput?.metadata).toMatchObject({
      automaticProviderRetryAttempted: false,
      redispatchPrevented: true,
    });
  });

  it("rechecks freshness under the row lock and skips a live request", async () => {
    const fixture = recoveryDb(operation("requested", NOW));

    const stats = await recoverStalePartnerInviteOperations({
      db: fixture.db as never,
      now: NOW,
      requestedStaleMs: 30_000,
      dispatchedStaleMs: 30_000,
    });

    expect(stats.skipped).toBe(1);
    expect(mockQuarantine).not.toHaveBeenCalled();
    expect(mockTerminal).not.toHaveBeenCalled();
    expect(fixture.auditRows).toHaveLength(0);
  });
});
