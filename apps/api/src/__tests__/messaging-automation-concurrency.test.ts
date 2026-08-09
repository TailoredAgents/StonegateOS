import type { NextRequest } from "next/server";

const mockBeginTeamMutation = jest.fn();
const mockClaimIdempotency = jest.fn();
const mockCompleteIdempotency = jest.fn();
const mockSettleIdempotency = jest.fn();

const mockTables = {
  automationSettings: {
    name: "automation_settings",
    channel: "automation_settings.channel",
    mode: "automation_settings.mode",
    updatedAt: "automation_settings.updated_at",
    updatedBy: "automation_settings.updated_by",
  },
  facebookSalesAutopilotActions: {
    name: "facebook_sales_autopilot_actions",
  },
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
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string | null;
};

type AutomationRow = {
  channel: "sms" | "email" | "dm" | "call" | "web";
  mode: "draft" | "assist" | "auto";
  updatedAt: Date;
  updatedBy: string | null;
};

type State = {
  policies: Map<string, PolicyRow>;
  channels: Map<string, AutomationRow>;
};

type Predicate =
  | { kind: "eq"; left: unknown; right: unknown }
  | { kind: "inArray"; left: unknown; right: unknown[] };

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
    this.status =
      options.status ??
      (code === "conflict" ? 409 : code === "invalid" ? 422 : 500);
    this.retryable = options.retryable ?? false;
    this.fieldErrors = options.fieldErrors;
  }
}

jest.mock("drizzle-orm", () => ({
  desc: jest.fn((value: unknown) => value),
  eq: jest.fn((left: unknown, right: unknown) => ({
    kind: "eq",
    left,
    right,
  })),
  inArray: jest.fn((left: unknown, right: unknown[]) => ({
    kind: "inArray",
    left,
    right,
  })),
  sql: jest.fn((parts: TemplateStringsArray, ...values: unknown[]) => ({
    parts,
    values,
  })),
}));

let state: State;
let auditInputs: Array<Record<string, unknown>> = [];
let failAudit = false;
let lockCount = 0;

function cloneState(source: State): State {
  return {
    policies: new Map(
      [...source.policies].map(([key, row]) => [
        key,
        {
          ...row,
          value: structuredClone(row.value),
          createdAt: new Date(row.createdAt),
          updatedAt: new Date(row.updatedAt),
        },
      ]),
    ),
    channels: new Map(
      [...source.channels].map(([key, row]) => [
        key,
        { ...row, updatedAt: new Date(row.updatedAt) },
      ]),
    ),
  };
}

function rowsFor(
  table: unknown,
  predicate: Predicate,
  working: State,
): unknown[] {
  if (table === mockTables.policySettings) {
    if (predicate.kind !== "eq") return [];
    const row = working.policies.get(String(predicate.right));
    return row ? [row] : [];
  }
  if (table === mockTables.automationSettings) {
    if (predicate.kind === "eq") {
      const row = working.channels.get(String(predicate.right));
      return row ? [row] : [];
    }
    return predicate.right.flatMap((channel) => {
      const row = working.channels.get(String(channel));
      return row ? [row] : [];
    });
  }
  return [];
}

function queryResult(rows: unknown[]) {
  return {
    limit: jest.fn((limit: number) => Promise.resolve(rows.slice(0, limit))),
    then: (
      resolve: (value: unknown[]) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(rows).then(resolve, reject),
  };
}

function makeExecutor(working: State) {
  return {
    __working: working,
    execute: jest.fn(() => {
      lockCount += 1;
      return Promise.resolve();
    }),
    select: jest.fn(() => ({
      from: jest.fn((table: unknown) => ({
        where: jest.fn((predicate: Predicate) => {
          const rows = rowsFor(table, predicate, working);
          const result = queryResult(rows);
          return {
            limit: result.limit,
            then: result.then,
            for: jest.fn(() => queryResult(rows)),
          };
        }),
      })),
    })),
    update: jest.fn((table: unknown) => ({
      set: jest.fn((updates: Record<string, unknown>) => ({
        where: jest.fn((predicate: Predicate) => ({
          returning: jest.fn(() => {
            if (predicate.kind !== "eq") return Promise.resolve([]);
            if (table === mockTables.policySettings) {
              const key = String(predicate.right);
              const current = working.policies.get(key);
              if (!current) return Promise.resolve([]);
              const next = { ...current, ...updates } as PolicyRow;
              working.policies.set(key, next);
              return Promise.resolve([next]);
            }
            return Promise.resolve([]);
          }),
        })),
      })),
    })),
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((values: Record<string, unknown>) => ({
        returning: jest.fn(() => {
          if (table === mockTables.policySettings) {
            const row = values as PolicyRow;
            working.policies.set(row.key, row);
            return Promise.resolve([row]);
          }
          if (table === mockTables.automationSettings) {
            const row = values as AutomationRow;
            working.channels.set(row.channel, row);
            return Promise.resolve([row]);
          }
          return Promise.resolve([]);
        }),
        onConflictDoUpdate: jest.fn(
          (conflict: { set: Record<string, unknown> }) => ({
            returning: jest.fn(() => {
              if (table !== mockTables.automationSettings) {
                return Promise.resolve([]);
              }
              const incoming = values as AutomationRow;
              const current = working.channels.get(incoming.channel);
              const next = {
                ...(current ?? incoming),
                ...conflict.set,
                channel: incoming.channel,
              } as AutomationRow;
              working.channels.set(incoming.channel, next);
              return Promise.resolve([next]);
            }),
          }),
        ),
      })),
    })),
  };
}

const database = {
  __working: null as State | null,
  transaction: jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
    const working = cloneState(state);
    const result = await callback(makeExecutor(working));
    state = working;
    return result;
  }),
};

jest.mock("@/db", () => ({
  ...mockTables,
  getDb: jest.fn(() => database),
}));

const DEFAULT_POLICY = {
  enabled: false,
  mode: "off",
  channelModes: { sms: "off", email: "off", dm: "off" },
  emergencyStop: false,
  dailyAutomaticSendCap: 25,
  autoSendAfterMinutes: 30,
  activityWindowMinutes: 30,
  retryDelayMinutes: 5,
  dmSmsFallbackAfterMinutes: 60,
  dmMinSilenceBeforeSmsMinutes: 30,
  dmMissingInfoFollowupDelayMinutes: 60,
  dmQuoteFollowupDelayMinutes: 180,
  dmObjectionFollowupDelayMinutes: 180,
  agentDisplayName: "Devon",
  plannerAutoSendEnabled: false,
  plannerAutoSendMinDraftAgeMinutes: 15,
  plannerAutoSendChannels: [],
  plannerAutoSendActions: [],
  liveReplyAutonomyEnabled: false,
  liveReplyAutonomyChannels: [],
  liveReplyAutonomyActions: [],
  facebookCloser: {
    mode: "off",
    allowedServices: ["junk_removal"],
    maxAutoBookTotalCents: 50_000,
    minConfidence: "high",
    requireCustomerConfirmation: true,
    requirePhotosAboveCents: 0,
    allowDmSmsFallback: false,
    emergencyStop: false,
    messengerResponseWindowHours: 24,
  },
  facebookCoaching: {
    enabled: false,
    tone: "friendly",
    playbook: "",
    requirePhotosBeforeQuote: true,
    requireHumanReviewBeforeBooking: true,
    humanReviewKeywords: [],
    blockedAutoReplyKeywords: [],
  },
};

jest.mock("@/lib/policy", () => ({
  getSalesAutopilotPolicy: jest.fn(
    (executor: { __working?: State | null } = {}) => {
      const working = executor.__working ?? state;
      const stored = working.policies.get("sales_autopilot")?.value ?? {};
      const mode =
        typeof stored["mode"] === "string"
          ? stored["mode"]
          : DEFAULT_POLICY.mode;
      const channelModes =
        stored["channelModes"] && typeof stored["channelModes"] === "object"
          ? stored["channelModes"]
          : DEFAULT_POLICY.channelModes;
      return Promise.resolve({
        ...DEFAULT_POLICY,
        ...stored,
        mode,
        enabled: mode !== "off",
        channelModes: { ...DEFAULT_POLICY.channelModes, ...channelModes },
        facebookCloser: {
          ...DEFAULT_POLICY.facebookCloser,
          ...(stored["facebookCloser"] as Record<string, unknown> | undefined),
        },
        facebookCoaching: {
          ...DEFAULT_POLICY.facebookCoaching,
          ...(stored["facebookCoaching"] as
            | Record<string, unknown>
            | undefined),
        },
      });
    },
  ),
}));

jest.mock("@/lib/permissions", () => ({
  requirePermission: jest.fn(() => Promise.resolve(null)),
}));
jest.mock("../../app/api/web/admin", () => ({
  isAdminRequest: jest.fn(() => true),
}));

jest.mock("@/lib/team-mutation-idempotency", () => ({
  claimTeamMutationIdempotency: mockClaimIdempotency,
  completeTeamMutationIdempotency: mockCompleteIdempotency,
  settleTeamMutationIdempotencyFailure: mockSettleIdempotency,
  teamMutationIdempotencyReplayResponse: jest.fn(
    (replay: { result: unknown; status: number; correlationId: string }) =>
      Response.json(replay.result, {
        status: replay.status,
        headers: { "idempotency-replayed": "true" },
      }),
  ),
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

import { POST as updateCompatibilityChannel } from "../../app/api/admin/automation/route";
import { PATCH as updateSalesAutopilot } from "../../app/api/admin/sales/autopilot/route";

const MEMBER_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const EXISTING_VERSION = "2026-08-08T12:00:00.000Z";

const mutation = {
  actor: {
    type: "human",
    id: MEMBER_ID,
    role: "owner",
    label: "Owner",
    sessionId: SESSION_ID,
    authMethod: "team_session",
  },
  principalType: "human",
  operationId: "33333333-3333-4333-8333-333333333333",
  correlationId: "automation-correlation-123456",
  expectedVersion: EXISTING_VERSION as string | null,
  idempotencyKeyHash: "hashed-key",
  audit: {
    insertSuccess: jest.fn((_tx: unknown, input: Record<string, unknown>) => {
      if (failAudit) {
        return Promise.reject(new Error("audit unavailable"));
      }
      auditInputs.push(input);
      return Promise.resolve({
        auditEventId: "44444444-4444-4444-8444-444444444444",
        committedAt:
          (input["committedAt"] as Date | undefined)?.toISOString() ??
          "2026-08-08T12:00:00.001Z",
      });
    }),
  },
};

function request(body: unknown): NextRequest & { json: jest.Mock } {
  return {
    headers: new Headers(),
    json: jest.fn(() => Promise.resolve(body)),
  } as unknown as NextRequest & { json: jest.Mock };
}

function seedPolicy(value: Record<string, unknown> = {}): void {
  state.policies.set("sales_autopilot", {
    key: "sales_autopilot",
    value,
    createdAt: new Date(EXISTING_VERSION),
    updatedAt: new Date(EXISTING_VERSION),
    updatedBy: MEMBER_ID,
  });
}

function automaticPayload(): Record<string, unknown> {
  return {
    mode: "automatic",
    channelModes: {
      sms: "automatic",
      email: "assist",
      dm: "off",
    },
  };
}

describe("Messaging Automation optimistic concurrency and atomic evidence", () => {
  beforeEach(() => {
    state = { policies: new Map(), channels: new Map() };
    auditInputs = [];
    failAudit = false;
    lockCount = 0;
    mutation.expectedVersion = EXISTING_VERSION;
    mutation.audit.insertSuccess.mockClear();
    mockBeginTeamMutation.mockReset().mockResolvedValue({
      ok: true,
      mutation,
    });
    mockClaimIdempotency.mockReset().mockResolvedValue({
      kind: "execute",
      claim: {
        id: "55555555-5555-4555-8555-555555555555",
        operationId: mutation.operationId,
        attemptCount: 1,
        principalHash: "principal",
        keyHash: "key",
        scopeHash: "scope",
        requestHash: "request",
      },
    });
    mockCompleteIdempotency.mockReset().mockResolvedValue(undefined);
    mockSettleIdempotency.mockReset().mockResolvedValue(undefined);
    database.transaction.mockClear();
    jest.spyOn(Date, "now").mockReturnValue(Date.parse(EXISTING_VERSION));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("co-commits the global policy, all compatibility modes, audit, and receipt", async () => {
    seedPolicy({ mode: "off" });

    const response = await updateSalesAutopilot(request(automaticPayload()));
    const payload = (await response.json()) as {
      ok: boolean;
      data?: { metadata?: { version?: string } };
      receipt?: { auditEventId?: string; actorId?: string };
    };

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      receipt: {
        auditEventId: "44444444-4444-4444-8444-444444444444",
        actorId: MEMBER_ID,
      },
    });
    expect(state.policies.get("sales_autopilot")?.value).toMatchObject({
      mode: "full",
      channelModes: { sms: "full", email: "partial", dm: "off" },
    });
    expect(state.channels.get("sms")?.mode).toBe("auto");
    expect(state.channels.get("email")?.mode).toBe("assist");
    expect(state.channels.get("dm")?.mode).toBe("draft");
    expect(Date.parse(payload.data?.metadata?.version ?? "")).toBe(
      Date.parse(EXISTING_VERSION) + 1,
    );
    expect(auditInputs).toHaveLength(1);
    expect(mockCompleteIdempotency).toHaveBeenCalledTimes(1);
    expect(lockCount).toBe(4);
  });

  it("rejects a stale global save and preserves the newer policy", async () => {
    seedPolicy({ mode: "partial" });
    mutation.expectedVersion = "2026-08-08T11:59:59.000Z";

    const response = await updateSalesAutopilot(request(automaticPayload()));

    expect(response.status).toBe(409);
    expect(state.policies.get("sales_autopilot")?.value).toEqual({
      mode: "partial",
    });
    expect(state.channels.size).toBe(0);
    expect(auditInputs).toHaveLength(0);
    expect(mockCompleteIdempotency).not.toHaveBeenCalled();
    expect(mockSettleIdempotency).toHaveBeenCalledTimes(1);
  });

  it("serializes the absent first save and advances beyond the same millisecond", async () => {
    mutation.expectedVersion = "absent";

    const response = await updateSalesAutopilot(request(automaticPayload()));
    const payload = (await response.json()) as {
      data?: { metadata?: { version?: string } };
    };

    expect(response.status).toBe(200);
    expect(payload.data?.metadata?.version).toBe(
      new Date(Date.parse(EXISTING_VERSION)).toISOString(),
    );

    mutation.expectedVersion = "absent";
    mockClaimIdempotency.mockClear().mockResolvedValue({
      kind: "execute",
      claim: {
        id: "66666666-6666-4666-8666-666666666666",
        operationId: mutation.operationId,
        attemptCount: 1,
        principalHash: "principal",
        keyHash: "key-2",
        scopeHash: "scope",
        requestHash: "request-2",
      },
    });
    const staleResponse = await updateSalesAutopilot(
      request({ mode: "assist" }),
    );
    expect(staleResponse.status).toBe(409);
  });

  it("rolls back policy and channel rows when success audit persistence fails", async () => {
    seedPolicy({ mode: "off" });
    failAudit = true;

    const response = await updateSalesAutopilot(request(automaticPayload()));

    expect(response.status).toBe(500);
    expect(state.policies.get("sales_autopilot")?.value).toEqual({
      mode: "off",
    });
    expect(state.channels.size).toBe(0);
    expect(auditInputs).toHaveLength(0);
    expect(mockCompleteIdempotency).not.toHaveBeenCalled();
    expect(mockSettleIdempotency).toHaveBeenCalledTimes(1);
  });

  it("replays an exact duplicate receipt without executing a second transaction", async () => {
    seedPolicy({ mode: "off" });
    const first = await updateSalesAutopilot(request(automaticPayload()));
    const firstPayload = (await first.json()) as Record<string, unknown>;
    const transactionsAfterFirst = database.transaction.mock.calls.length;
    mockClaimIdempotency.mockResolvedValue({
      kind: "replay",
      replay: {
        result: firstPayload,
        status: 200,
        correlationId: mutation.correlationId,
      },
    });

    const duplicate = await updateSalesAutopilot(request(automaticPayload()));

    expect(duplicate.status).toBe(200);
    expect(duplicate.headers.get("idempotency-replayed")).toBe("true");
    expect(await duplicate.json()).toEqual(firstPayload);
    expect(database.transaction).toHaveBeenCalledTimes(transactionsAfterFirst);
    expect(auditInputs).toHaveLength(1);
  });

  it("returns a truthful conflict while the same duplicate click is in progress", async () => {
    seedPolicy({ mode: "off" });
    mockClaimIdempotency.mockRejectedValue(
      new MockTeamMutationFailure(
        "conflict",
        "This operation is already in progress.",
        { retryable: true },
      ),
    );

    const response = await updateSalesAutopilot(request(automaticPayload()));
    const payload = (await response.json()) as {
      ok?: boolean;
      code?: string;
      retryable?: boolean;
    };

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({
      ok: false,
      code: "conflict",
      retryable: true,
    });
    expect(database.transaction).not.toHaveBeenCalled();
    expect(auditInputs).toHaveLength(0);
  });

  it("keeps sensitive field values out of success audit evidence", async () => {
    seedPolicy({ agentDisplayName: "Devon" });

    const response = await updateSalesAutopilot(
      request({ agentDisplayName: "Private Operator Name" }),
    );

    expect(response.status).toBe(200);
    expect(JSON.stringify(auditInputs)).not.toContain("Private Operator Name");
    expect(auditInputs[0]).toMatchObject({
      metadata: { changedFields: ["agentDisplayName"] },
    });
  });

  it("synchronizes a legacy channel write into the current policy atomically", async () => {
    seedPolicy({
      mode: "full",
      channelModes: { sms: "full", email: "full", dm: "full" },
    });
    state.channels.set("sms", {
      channel: "sms",
      mode: "auto",
      updatedAt: new Date(EXISTING_VERSION),
      updatedBy: MEMBER_ID,
    });

    const response = await updateCompatibilityChannel(
      request({ channel: "sms", mode: "assist" }),
    );
    const payload = (await response.json()) as {
      ok?: boolean;
      data?: { version?: string; policyVersion?: string };
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(state.channels.get("sms")?.mode).toBe("assist");
    expect(state.policies.get("sales_autopilot")?.value).toMatchObject({
      channelModes: { sms: "partial", email: "full", dm: "full" },
    });
    expect(payload.data?.policyVersion).toBe(payload.data?.version);
    expect(auditInputs).toHaveLength(1);
  });

  it("safely creates absent compatibility and policy rows on the first save", async () => {
    mutation.expectedVersion = "absent";

    const response = await updateCompatibilityChannel(
      request({ channel: "email", mode: "automatic" }),
    );
    const payload = (await response.json()) as {
      data?: { version?: string; policyVersion?: string };
    };

    expect(response.status).toBe(200);
    expect(state.channels.get("email")?.mode).toBe("auto");
    expect(state.policies.get("sales_autopilot")?.value).toMatchObject({
      channelModes: { email: "full" },
    });
    expect(payload.data?.version).toBe(EXISTING_VERSION);
    expect(payload.data?.policyVersion).toBe(EXISTING_VERSION);
    expect(auditInputs).toHaveLength(1);
  });

  it("rejects a stale compatibility channel without changing either record", async () => {
    seedPolicy({ mode: "full" });
    state.channels.set("sms", {
      channel: "sms",
      mode: "auto",
      updatedAt: new Date(EXISTING_VERSION),
      updatedBy: MEMBER_ID,
    });
    mutation.expectedVersion = "2026-08-08T11:00:00.000Z";

    const response = await updateCompatibilityChannel(
      request({ channel: "sms", mode: "off" }),
    );

    expect(response.status).toBe(409);
    expect(state.channels.get("sms")?.mode).toBe("auto");
    expect(state.policies.get("sales_autopilot")?.value).toEqual({
      mode: "full",
    });
    expect(auditInputs).toHaveLength(0);
  });
});
