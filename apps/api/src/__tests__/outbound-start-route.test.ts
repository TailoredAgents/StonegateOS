import { NextRequest } from "next/server";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const CONTACT_ID = "22222222-2222-4222-8222-222222222222";
const MEMBER_ID = "33333333-3333-4333-8333-333333333333";
const VERSION = new Date("2026-08-09T12:00:00.000Z");

const mockClaim = jest.fn();
const mockComplete = jest.fn();
const mockSettle = jest.fn();
const mockBegin = jest.fn();

type RuntimeState = {
  dueAt: Date | null;
  notes: string;
  updatedAt: Date;
  contactDnc: boolean;
  contactDeletedAt: Date | null;
  audits: string[];
  receipts: string[];
};

let state: RuntimeState;
let casWins = true;
let transactionCount = 0;
let expectedVersion: string | null = VERSION.toISOString();

const taskTable = {
  id: "crm_tasks.id",
  contactId: "crm_tasks.contact_id",
  status: "crm_tasks.status",
  dueAt: "crm_tasks.due_at",
  notes: "crm_tasks.notes",
  updatedAt: "crm_tasks.updated_at",
};

const contactTable = {
  id: "contacts.id",
  doNotContact: "contacts.do_not_contact",
  deletedAt: "contacts.deleted_at",
};

function createTx(draft: RuntimeState) {
  return {
    __state: draft,
    execute: jest.fn(async () => Promise.resolve()),
    select: jest.fn(() => ({
      from: jest.fn((table: unknown) => ({
        where: jest.fn(() => {
          if (table === contactTable) {
            return {
              for: jest.fn(() => ({
                limit: jest.fn(() =>
                  Promise.resolve([
                    {
                      id: CONTACT_ID,
                      doNotContact: draft.contactDnc,
                      deletedAt: draft.contactDeletedAt,
                    },
                  ]),
                ),
              })),
            };
          }
          const task = {
            id: TASK_ID,
            contactId: CONTACT_ID,
            status: "open",
            dueAt: draft.dueAt,
            notes: draft.notes,
            updatedAt: draft.updatedAt,
          };
          return {
            limit: jest.fn(() => Promise.resolve([task])),
            for: jest.fn(() => ({
              limit: jest.fn(() => Promise.resolve([task])),
            })),
          };
        }),
      })),
    })),
    update: jest.fn(() => ({
      set: jest.fn(
        (patch: { dueAt: Date; notes: string; updatedAt: Date }) => ({
          where: jest.fn(() => ({
            returning: jest.fn(() => {
              if (!casWins) return Promise.resolve([]);
              draft.dueAt = patch.dueAt;
              draft.notes = patch.notes;
              draft.updatedAt = patch.updatedAt;
              return Promise.resolve([
                { dueAt: draft.dueAt, updatedAt: draft.updatedAt },
              ]);
            }),
          })),
        }),
      ),
    })),
  };
}

const mockDb = {
  transaction: jest.fn(
    async (work: (tx: ReturnType<typeof createTx>) => Promise<unknown>) => {
      transactionCount += 1;
      const draft = structuredClone(state);
      const result = await work(createTx(draft));
      state = draft;
      return result;
    },
  ),
};

jest.mock("drizzle-orm", () => ({
  and: jest.fn((...values: unknown[]) => ({ kind: "and", values })),
  eq: jest.fn((...values: unknown[]) => ({ kind: "eq", values })),
  sql: jest.fn((parts: TemplateStringsArray) => ({ kind: "sql", parts })),
}));

jest.mock("@/db", () => ({
  contacts: contactTable,
  crmTasks: taskTable,
  getDb: jest.fn(() => mockDb),
}));

class MockTeamMutationFailure extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly fieldErrors?: Record<string, string>;
  readonly retryAfter?: string;

  constructor(
    code: string,
    message: string,
    options: {
      status?: number;
      retryable?: boolean;
      fieldErrors?: Record<string, string>;
      retryAfter?: string;
    } = {},
  ) {
    super(message);
    this.code = code;
    this.status =
      options.status ??
      (code === "conflict" ? 409 : code === "invalid" ? 422 : 500);
    this.retryable = options.retryable ?? false;
    this.fieldErrors = options.fieldErrors;
    this.retryAfter = options.retryAfter;
  }
}

jest.mock("@/lib/team-mutation", () => ({
  TeamMutationFailure: MockTeamMutationFailure,
  beginTeamMutation: mockBegin,
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
  teamMutationExceptionResponse: jest.fn((error: unknown) => {
    const failure =
      error instanceof MockTeamMutationFailure
        ? error
        : new MockTeamMutationFailure("internal", "No success was confirmed.", {
            status: 500,
            retryable: true,
          });
    return Response.json(
      {
        ok: false,
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable,
      },
      { status: failure.status },
    );
  }),
}));

jest.mock("@/lib/team-mutation-idempotency", () => ({
  claimTeamMutationIdempotency: mockClaim,
  completeTeamMutationIdempotency: mockComplete,
  settleTeamMutationIdempotencyFailure: mockSettle,
  teamMutationIdempotencyReplayResponse: jest.fn(
    (replay: { result: unknown; status: number }) =>
      Response.json(replay.result, {
        status: replay.status,
        headers: { "idempotency-replayed": "true" },
      }),
  ),
}));

function request(): NextRequest {
  return new NextRequest("https://api.test/api/admin/outbound/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId: TASK_ID }),
  });
}

describe("POST /api/admin/outbound/start runtime safety", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    state = {
      dueAt: null,
      notes: "kind=outbound\nattempt=1",
      updatedAt: new Date(VERSION),
      contactDnc: false,
      contactDeletedAt: null,
      audits: [],
      receipts: [],
    };
    casWins = true;
    transactionCount = 0;
    expectedVersion = VERSION.toISOString();
    mockBegin.mockImplementation(async () => {
      await Promise.resolve();
      return {
        ok: true,
        mutation: {
          actor: { id: MEMBER_ID },
          operationId: "operation-1",
          correlationId: "correlation-1",
          expectedVersion,
          audit: {
            insertSuccess: async (tx: { __state: RuntimeState }) => {
              await Promise.resolve();
              tx.__state.audits.push("outbound.started");
              return {
                auditEventId: "audit-1",
                committedAt: "2026-08-09T12:00:01.000Z",
              };
            },
          },
        },
      };
    });
    mockClaim.mockResolvedValue({
      kind: "execute",
      claim: { id: "claim-1" },
    });
    mockComplete.mockImplementation(async (tx: { __state: RuntimeState }) => {
      await Promise.resolve();
      tx.__state.receipts.push("claim-1");
    });
    mockSettle.mockResolvedValue(undefined);
  });

  it("returns a durable replay without opening the business transaction", async () => {
    mockClaim.mockResolvedValueOnce({
      kind: "replay",
      replay: {
        status: 200,
        correlationId: "original-correlation",
        result: { ok: true, data: { taskId: TASK_ID }, receipt: {} },
      },
    });
    const { POST } = await import("../../app/api/admin/outbound/start/route");
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("idempotency-replayed")).toBe("true");
    expect(transactionCount).toBe(0);
  });

  it("commits the task, audit, and terminal replay receipt together", async () => {
    const { POST } = await import("../../app/api/admin/outbound/start/route");
    const response = await POST(request());
    const body = (await response.json()) as { ok: boolean; receipt?: unknown };
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.receipt).toBeDefined();
    expect(state.dueAt).toBeInstanceOf(Date);
    expect(state.notes).toContain("startedAt=");
    expect(state.audits).toEqual(["outbound.started"]);
    expect(state.receipts).toEqual(["claim-1"]);
  });

  it("rejects a stale version before writes and settles the claim", async () => {
    expectedVersion = "2026-08-09T11:59:00.000Z";
    const { POST } = await import("../../app/api/admin/outbound/start/route");
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(state.dueAt).toBeNull();
    expect(state.audits).toEqual([]);
    expect(state.receipts).toEqual([]);
    expect(mockSettle).toHaveBeenCalledTimes(1);
  });

  it("rejects a direct cadence start for a DNC contact", async () => {
    state.contactDnc = true;
    const { POST } = await import("../../app/api/admin/outbound/start/route");
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(state.dueAt).toBeNull();
    expect(state.audits).toEqual([]);
    expect(state.receipts).toEqual([]);
  });

  it("does not false-succeed when the compare-and-set loses", async () => {
    casWins = false;
    const { POST } = await import("../../app/api/admin/outbound/start/route");
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(state.dueAt).toBeNull();
    expect(state.audits).toEqual([]);
    expect(state.receipts).toEqual([]);
  });

  it("rolls task and audit writes back when receipt persistence fails", async () => {
    mockComplete.mockRejectedValueOnce(new Error("receipt_write_failed"));
    const { POST } = await import("../../app/api/admin/outbound/start/route");
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(state.dueAt).toBeNull();
    expect(state.audits).toEqual([]);
    expect(state.receipts).toEqual([]);
    expect(mockSettle).toHaveBeenCalledTimes(1);
  });
});
