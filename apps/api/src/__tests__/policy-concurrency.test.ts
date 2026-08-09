import type { NextRequest } from "next/server";

const mockBeginTeamMutation = jest.fn();
const mockRequirePermission = jest.fn(() => Promise.resolve(null));
const mockClaimTeamMutationIdempotency = jest.fn();
const mockCompleteTeamMutationIdempotency = jest.fn();
const mockSettleTeamMutationIdempotencyFailure = jest.fn();

const tables = {
  auditLogs: { name: "audit_logs" },
  policySettings: {
    name: "policy_settings",
    key: "policy_settings.key",
    value: "policy_settings.value",
    updatedAt: "policy_settings.updated_at",
    updatedBy: "policy_settings.updated_by",
    createdAt: "policy_settings.created_at",
  },
};

type PolicyRow = {
  key: string;
  value: Record<string, unknown>;
  updatedAt: Date;
  updatedBy: string | null;
  createdAt: Date;
};

type Predicate = { kind: "eq"; right: unknown };

class MockTeamMutationFailure extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly fieldErrors?: Record<string, string>;

  constructor(
    readonly code: string,
    message: string,
    options: {
      status?: number;
      retryable?: boolean;
      fieldErrors?: Record<string, string>;
    } = {},
  ) {
    super(message);
    this.status = options.status ?? (code === "conflict" ? 409 : 500);
    this.retryable = options.retryable ?? false;
    this.fieldErrors = options.fieldErrors;
  }
}

jest.mock("drizzle-orm", () => ({
  eq: jest.fn((_left: unknown, right: unknown) => ({ kind: "eq", right })),
  inArray: jest.fn((_left: unknown, right: unknown) => ({
    kind: "inArray",
    right,
  })),
  sql: jest.fn((parts: TemplateStringsArray, ...values: unknown[]) => ({
    parts,
    values,
  })),
}));

let state = new Map<string, PolicyRow>();
let auditRows: Array<Record<string, unknown>> = [];
let lockCount = 0;
let failAudit = false;

function cloneState(): Map<string, PolicyRow> {
  return new Map(
    [...state].map(([key, row]) => [
      key,
      {
        ...row,
        value: { ...row.value },
        updatedAt: new Date(row.updatedAt),
        createdAt: new Date(row.createdAt),
      },
    ]),
  );
}

function selectionFor(
  table: unknown,
  predicate: Predicate | { kind: "inArray"; right: unknown } | undefined,
  working: Map<string, PolicyRow>,
): unknown[] {
  if (table !== tables.policySettings) return [];
  if (predicate?.kind === "eq") {
    const row = working.get(String(predicate.right));
    return row ? [row] : [];
  }
  if (predicate?.kind === "inArray" && Array.isArray(predicate.right)) {
    return predicate.right.flatMap((key) => {
      const row = working.get(String(key));
      return row ? [row] : [];
    });
  }
  return [...working.values()];
}

function makeTransaction(
  working: Map<string, PolicyRow>,
  pendingAudits: Array<Record<string, unknown>>,
) {
  return {
    execute: jest.fn(() => {
      lockCount += 1;
      return Promise.resolve();
    }),
    select: jest.fn(() => ({
      from: jest.fn((table: unknown) => ({
        where: jest.fn((predicate: Predicate) => {
          const rows = selectionFor(table, predicate, working);
          return {
            for: jest.fn(() => ({
              limit: jest.fn(() => Promise.resolve(rows.slice(0, 1))),
            })),
            then: (
              resolve: (value: unknown[]) => unknown,
              reject?: (reason: unknown) => unknown,
            ) => Promise.resolve(rows).then(resolve, reject),
          };
        }),
      })),
    })),
    update: jest.fn((table: unknown) => ({
      set: jest.fn((updates: Partial<PolicyRow>) => ({
        where: jest.fn((predicate: Predicate) => ({
          returning: jest.fn(() => {
            if (table !== tables.policySettings) return Promise.resolve([]);
            const key = String(predicate.right);
            const current = working.get(key);
            if (!current) return Promise.resolve([]);
            const next = { ...current, ...updates } as PolicyRow;
            working.set(key, next);
            return Promise.resolve([next]);
          }),
        })),
      })),
    })),
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((values: Record<string, unknown>) => {
        if (table === tables.auditLogs) {
          if (failAudit) return Promise.reject(new Error("audit unavailable"));
          pendingAudits.push(values);
          return Promise.resolve();
        }
        const row = values as PolicyRow;
        return {
          returning: jest.fn(() => {
            working.set(row.key, row);
            return Promise.resolve([row]);
          }),
        };
      }),
    })),
  };
}

const database = {
  select: jest.fn(() => ({
    from: jest.fn((table: unknown) => ({
      where: jest.fn(
        (predicate: Predicate | { kind: "inArray"; right: unknown }) =>
          Promise.resolve(selectionFor(table, predicate, state)),
      ),
    })),
  })),
  transaction: jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
    const working = cloneState();
    const pendingAudits: Array<Record<string, unknown>> = [];
    const result = await callback(makeTransaction(working, pendingAudits));
    state = working;
    auditRows.push(...pendingAudits);
    return result;
  }),
};

jest.mock("@/db", () => ({
  ...tables,
  getDb: jest.fn(() => database),
}));
jest.mock("@/lib/permissions", () => ({
  requirePermission: mockRequirePermission,
}));
jest.mock("../../app/api/web/admin", () => ({
  isAdminRequest: jest.fn(() => true),
}));
jest.mock("@/lib/team-mutation", () => ({
  TeamMutationFailure: MockTeamMutationFailure,
  beginTeamMutation: mockBeginTeamMutation,
  teamMutationExceptionResponse: jest.fn((error: unknown) => {
    const failure =
      error instanceof MockTeamMutationFailure
        ? error
        : new MockTeamMutationFailure(
            "internal",
            "The operation could not be completed.",
            { retryable: true },
          );
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
  }),
  teamMutationSuccessResponse: jest.fn(
    (
      mutation: {
        operationId: string;
        correlationId: string;
        actor: { id: string };
      },
      data: unknown,
      receipt: Record<string, unknown>,
    ) =>
      Response.json({
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
  teamMutationResultResponse: jest.fn((result: unknown, status: number) =>
    Response.json(result, { status }),
  ),
}));
jest.mock("@/lib/team-mutation-idempotency", () => ({
  claimTeamMutationIdempotency: mockClaimTeamMutationIdempotency,
  completeTeamMutationIdempotency: mockCompleteTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure:
    mockSettleTeamMutationIdempotencyFailure,
  teamMutationIdempotencyReplayResponse: jest.fn(
    (replay: { result: unknown; status: number }) =>
      Response.json(replay.result, { status: replay.status }),
  ),
}));

import { GET, POST } from "../../app/api/admin/policy/route";
import { PATCH as updateSalesAutopilotSignature } from "../../app/api/admin/sales/autopilot/signature/route";

const MEMBER_ID = "11111111-1111-4111-8111-111111111111";
const EXISTING_VERSION = "2026-08-08T12:00:00.000Z";

function bookingPolicy(bookingWindowDays: number): Record<string, unknown> {
  return {
    bookingWindowDays,
    bufferMinutes: 15,
    maxJobsPerDay: 5,
    maxJobsPerCrew: 3,
  };
}

const mutation = {
  actor: {
    type: "human",
    id: MEMBER_ID,
    role: "owner",
    label: "Owner",
    sessionId: "22222222-2222-4222-8222-222222222222",
    authMethod: "team_session",
  },
  operationId: "33333333-3333-4333-8333-333333333333",
  correlationId: "policy-correlation-123456",
  expectedVersion: "absent" as string | null,
  audit: {
    insertSuccess: jest.fn(
      async (
        tx: {
          insert: (table: unknown) => {
            values: (row: Record<string, unknown>) => Promise<void>;
          };
        },
        input: { entityId: string; before: unknown; after: unknown },
      ) => {
        await tx.insert(tables.auditLogs).values({
          action: "policy.update",
          entityId: input.entityId,
          before: input.before,
          after: input.after,
        });
        return {
          auditEventId: "44444444-4444-4444-8444-444444444444",
          committedAt: "2026-08-08T12:05:00.000Z",
        };
      },
    ),
  },
};

function request(body: unknown): NextRequest & { json: jest.Mock } {
  return {
    headers: new Headers(),
    json: jest.fn(() => Promise.resolve(body)),
  } as unknown as NextRequest & { json: jest.Mock };
}

describe("Policy Center optimistic concurrency", () => {
  beforeEach(() => {
    state = new Map();
    auditRows = [];
    lockCount = 0;
    failAudit = false;
    mutation.expectedVersion = "absent";
    mutation.audit.insertSuccess.mockClear();
    mockBeginTeamMutation.mockReset().mockResolvedValue({
      ok: true,
      mutation,
    });
    mockClaimTeamMutationIdempotency.mockReset().mockResolvedValue({
      kind: "execute",
      claim: {
        id: "55555555-5555-4555-8555-555555555555",
        operationId: mutation.operationId,
        attemptCount: 1,
      },
    });
    mockCompleteTeamMutationIdempotency
      .mockReset()
      .mockResolvedValue(undefined);
    mockSettleTeamMutationIdempotencyFailure
      .mockReset()
      .mockResolvedValue(undefined);
    mockRequirePermission.mockClear();
    database.transaction.mockClear();
  });

  it("exposes an explicit absent version for a default-backed card", async () => {
    const response = await GET(request(null));
    const payload = (await response.json()) as {
      settings: Array<{
        key: string;
        version: string;
        updatedAt: string | null;
      }>;
    };
    const booking = payload.settings.find(
      (setting) => setting.key === "booking_rules",
    );

    expect(response.status).toBe(200);
    expect(booking).toMatchObject({ version: "absent", updatedAt: null });
  });

  it("rejects a save that omits the loaded version before parsing input", async () => {
    mutation.expectedVersion = null;
    const incoming = request({ key: "booking_rules", value: {} });

    const response = await POST(incoming);

    expect(response.status).toBe(422);
    expect(incoming.json).not.toHaveBeenCalled();
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it("serializes and atomically audits the first save of a default-backed card", async () => {
    const response = await POST(
      request({
        key: "booking_rules",
        value: bookingPolicy(30),
      }),
    );
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ ok: true });
    expect(state.get("booking_rules")?.value).toMatchObject({
      bookingWindowDays: 30,
    });
    expect(lockCount).toBe(1);
    expect(auditRows).toHaveLength(1);
    expect(mockClaimTeamMutationIdempotency).toHaveBeenCalledWith(
      database,
      mutation,
      expect.objectContaining({
        route: "POST /api/admin/policy",
        entityType: "policy_setting",
        entityId: "booking_rules",
      }),
    );
    expect(mockCompleteTeamMutationIdempotency).toHaveBeenCalledTimes(1);
  });

  it("replays a completed duplicate without writing policy or audit rows again", async () => {
    mockClaimTeamMutationIdempotency.mockResolvedValueOnce({
      kind: "replay",
      replay: {
        status: 200,
        correlationId: mutation.correlationId,
        result: {
          ok: true,
          data: {
            key: "booking_rules",
            version: EXISTING_VERSION,
            updatedAt: EXISTING_VERSION,
            updatedBy: MEMBER_ID,
          },
          receipt: {
            operationId: mutation.operationId,
            correlationId: mutation.correlationId,
            actorId: MEMBER_ID,
            auditEventId: "44444444-4444-4444-8444-444444444444",
            committedAt: EXISTING_VERSION,
          },
        },
      },
    });

    const response = await POST(
      request({ key: "booking_rules", value: bookingPolicy(30) }),
    );
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ ok: true });
    expect(database.transaction).not.toHaveBeenCalled();
    expect(state.size).toBe(0);
    expect(auditRows).toHaveLength(0);
    expect(mockCompleteTeamMutationIdempotency).not.toHaveBeenCalled();
  });

  it("returns 409 and preserves the newer value when a card version is stale", async () => {
    state.set("booking_rules", {
      key: "booking_rules",
      value: bookingPolicy(60),
      createdAt: new Date(EXISTING_VERSION),
      updatedAt: new Date(EXISTING_VERSION),
      updatedBy: MEMBER_ID,
    });
    mutation.expectedVersion = "2026-08-08T11:00:00.000Z";

    const response = await POST(
      request({ key: "booking_rules", value: bookingPolicy(10) }),
    );

    expect(response.status).toBe(409);
    expect(state.get("booking_rules")?.value).toEqual(bookingPolicy(60));
    expect(auditRows).toHaveLength(0);
  });

  it("accepts the exact loaded version and advances it monotonically", async () => {
    state.set("booking_rules", {
      key: "booking_rules",
      value: bookingPolicy(60),
      createdAt: new Date(EXISTING_VERSION),
      updatedAt: new Date(EXISTING_VERSION),
      updatedBy: MEMBER_ID,
    });
    mutation.expectedVersion = EXISTING_VERSION;

    const response = await POST(
      request({ key: "booking_rules", value: bookingPolicy(10) }),
    );
    const payload = (await response.json()) as {
      data?: { version?: string };
    };

    expect(response.status).toBe(200);
    expect(state.get("booking_rules")?.value).toEqual(bookingPolicy(10));
    expect(Date.parse(payload.data?.version ?? "")).toBeGreaterThan(
      Date.parse(EXISTING_VERSION),
    );
    expect(auditRows).toHaveLength(1);
  });

  it("rolls back the policy value when success audit persistence fails", async () => {
    state.set("booking_rules", {
      key: "booking_rules",
      value: bookingPolicy(60),
      createdAt: new Date(EXISTING_VERSION),
      updatedAt: new Date(EXISTING_VERSION),
      updatedBy: MEMBER_ID,
    });
    mutation.expectedVersion = EXISTING_VERSION;
    failAudit = true;

    const response = await POST(
      request({ key: "booking_rules", value: bookingPolicy(10) }),
    );

    expect(response.status).toBe(500);
    expect(state.get("booking_rules")?.value).toEqual(bookingPolicy(60));
    expect(auditRows).toHaveLength(0);
    expect(mockSettleTeamMutationIdempotencyFailure).toHaveBeenCalledTimes(1);
  });
});

describe("Policy Center Sales agent signature concurrency", () => {
  beforeEach(() => {
    state = new Map();
    auditRows = [];
    lockCount = 0;
    failAudit = false;
    mutation.expectedVersion = EXISTING_VERSION;
    mutation.audit.insertSuccess.mockClear();
    mockBeginTeamMutation.mockReset().mockResolvedValue({
      ok: true,
      mutation,
    });
    mockClaimTeamMutationIdempotency.mockReset().mockResolvedValue({
      kind: "execute",
      claim: {
        id: "55555555-5555-4555-8555-555555555555",
        operationId: mutation.operationId,
        attemptCount: 1,
      },
    });
    mockCompleteTeamMutationIdempotency
      .mockReset()
      .mockResolvedValue(undefined);
    mockSettleTeamMutationIdempotencyFailure
      .mockReset()
      .mockResolvedValue(undefined);
    database.transaction.mockClear();
  });

  it("changes only the signature and preserves the rest of Sales Autopilot", async () => {
    state.set("sales_autopilot", {
      key: "sales_autopilot",
      value: { agentDisplayName: "Devon", emergencyStop: true },
      createdAt: new Date(EXISTING_VERSION),
      updatedAt: new Date(EXISTING_VERSION),
      updatedBy: MEMBER_ID,
    });

    const response = await updateSalesAutopilotSignature(
      request({ agentDisplayName: "Taylor" }),
    );
    const payload = (await response.json()) as {
      data?: { key?: string; agentDisplayName?: string };
    };

    expect(response.status).toBe(200);
    expect(payload.data).toMatchObject({
      key: "sales_autopilot_signature",
      agentDisplayName: "Taylor",
    });
    expect(state.get("sales_autopilot")?.value).toEqual({
      agentDisplayName: "Taylor",
      emergencyStop: true,
    });
    expect(auditRows).toHaveLength(1);
    expect(mockClaimTeamMutationIdempotency).toHaveBeenCalledWith(
      database,
      mutation,
      expect.objectContaining({
        route: "PATCH /api/admin/sales/autopilot/signature",
        entityId: "sales_autopilot",
      }),
    );
    expect(mockCompleteTeamMutationIdempotency).toHaveBeenCalledTimes(1);
  });

  it("rejects a stale signature without changing automation settings", async () => {
    state.set("sales_autopilot", {
      key: "sales_autopilot",
      value: { agentDisplayName: "Newer Name", emergencyStop: true },
      createdAt: new Date(EXISTING_VERSION),
      updatedAt: new Date(EXISTING_VERSION),
      updatedBy: MEMBER_ID,
    });
    mutation.expectedVersion = "2026-08-08T11:00:00.000Z";

    const response = await updateSalesAutopilotSignature(
      request({ agentDisplayName: "Stale Name" }),
    );

    expect(response.status).toBe(409);
    expect(state.get("sales_autopilot")?.value).toEqual({
      agentDisplayName: "Newer Name",
      emergencyStop: true,
    });
    expect(auditRows).toHaveLength(0);
  });
});
