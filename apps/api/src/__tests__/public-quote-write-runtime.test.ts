import { NextRequest } from "next/server";
import { jest as esmJest } from "@jest/globals";

type JestWithEsmMocks = Pick<
  typeof globalThis.jest,
  "clearAllMocks" | "fn"
> & {
  unstable_mockModule: (
    moduleName: string,
    moduleFactory: () => unknown,
  ) => typeof globalThis.jest;
};

const jest = esmJest as unknown as JestWithEsmMocks;

const QUOTE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_QUOTE_ID = "77777777-7777-4777-8777-777777777777";
const CONTACT_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_ID = "33333333-3333-4333-8333-333333333333";
const CHANGE_ID = "44444444-4444-4444-8444-444444444444";
const TASK_ID = "55555555-5555-4555-8555-555555555555";
const OUTBOX_ID = "66666666-6666-4666-8666-666666666666";
const TOKEN = "runtime-public-capability";
const CREATED_AT = new Date("2026-08-30T16:00:00.000Z");
const mockDefaultAssignee = jest.fn(() => Promise.resolve(OWNER_ID));

const quoteTable = {
  id: "quotes.id",
  contactId: "quotes.contact_id",
  status: "quotes.status",
  revision: "quotes.revision",
  expiresAt: "quotes.expires_at",
  refreshRequestedAt: "quotes.refresh_requested_at",
  shareToken: "quotes.share_token",
};
const receiptTable = {
  quoteId: "public_quote_mutation_receipts.quote_id",
  action: "public_quote_mutation_receipts.action",
  keyHash: "public_quote_mutation_receipts.key_hash",
  requestHash: "public_quote_mutation_receipts.request_hash",
  responseStatus: "public_quote_mutation_receipts.response_status",
  responseBody: "public_quote_mutation_receipts.response_body",
  expiresAt: "public_quote_mutation_receipts.expires_at",
};
const outboxTable = {
  id: "outbox_events.id",
  type: "outbox_events.type",
  payload: "outbox_events.payload",
  createdAt: "outbox_events.created_at",
  processedAt: "outbox_events.processed_at",
  quarantinedAt: "outbox_events.quarantined_at",
};
const changeTable = {
  id: "quote_change_requests.id",
  createdAt: "quote_change_requests.created_at",
};
const taskTable = { id: "crm_tasks.id" };
const contactTable = {
  id: "contacts.id",
  salespersonMemberId: "contacts.salesperson_member_id",
};
const auditTable = { id: "audit_logs.id" };

type Write = Record<string, unknown>;
type RuntimeState = {
  quote: {
    id: string;
    contactId: string;
    status: string;
    revision: number;
    expiresAt: Date | null;
    refreshRequestedAt: Date | null;
  };
  auditWrites: Write[];
  changeWrites: Write[];
  taskWrites: Write[];
  outboxWrites: Array<{ type: string; payload: Record<string, unknown> }>;
};

let state: RuntimeState;
let transactionTail: Promise<void> = Promise.resolve();
let contactOwnerId: string | null;

function createTx() {
  return {
    select: jest.fn(() => ({
      from: jest.fn((table: unknown) => {
        if (table === quoteTable) {
          return {
            where: jest.fn(() => ({
              for: jest.fn(() => ({
                limit: jest.fn(() => Promise.resolve([state.quote])),
              })),
            })),
          };
        }
        if (table === receiptTable) {
          return {
            where: jest.fn(() => ({
              limit: jest.fn(() => Promise.resolve([])),
            })),
          };
        }
        if (table === outboxTable) {
          return {
            where: jest.fn(() => ({
              orderBy: jest.fn(() => ({
                limit: jest.fn(() => {
                  const prior = state.outboxWrites.at(-1);
                  return Promise.resolve(
                    prior ? [{ payload: prior.payload }] : [],
                  );
                }),
              })),
            })),
          };
        }
        if (table === contactTable) {
          return {
            where: jest.fn(() => ({
              limit: jest.fn(() =>
                Promise.resolve([{ salespersonMemberId: contactOwnerId }]),
              ),
            })),
          };
        }
        throw new Error("unexpected_select_table");
      }),
    })),
    insert: jest.fn((table: unknown) => {
      if (table === auditTable) {
        return {
          values: jest.fn((value: Write) => {
            state.auditWrites.push(value);
            return Promise.resolve();
          }),
        };
      }
      if (table === changeTable) {
        return {
          values: jest.fn((value: Write) => {
            state.changeWrites.push(value);
            return {
              returning: jest.fn(() =>
                Promise.resolve([{ id: CHANGE_ID, createdAt: CREATED_AT }]),
              ),
            };
          }),
        };
      }
      if (table === taskTable) {
        return {
          values: jest.fn((value: Write) => {
            state.taskWrites.push(value);
            return {
              returning: jest.fn(() => Promise.resolve([{ id: TASK_ID }])),
            };
          }),
        };
      }
      if (table === outboxTable) {
        return {
          values: jest.fn(
            (value: { type: string; payload: Record<string, unknown> }) => {
              state.outboxWrites.push(value);
              return {
                returning: jest.fn(() => Promise.resolve([{ id: OUTBOX_ID }])),
              };
            },
          ),
        };
      }
      throw new Error("unexpected_insert_table");
    }),
  };
}

const mockDb = {
  transaction: jest.fn(
    <Result>(work: (tx: ReturnType<typeof createTx>) => Promise<Result>) => {
      const run = transactionTail.then(() => work(createTx()));
      transactionTail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  ),
  select: jest.fn(() => {
    throw new Error("unexpected_non_transactional_select");
  }),
  insert: jest.fn(() => {
    throw new Error("unexpected_non_transactional_insert");
  }),
};

jest.unstable_mockModule("drizzle-orm", () => ({
  and: jest.fn((...values: unknown[]) => ({ kind: "and", values })),
  desc: jest.fn((value: unknown) => ({ kind: "desc", value })),
  eq: jest.fn((...values: unknown[]) => ({ kind: "eq", values })),
  inArray: jest.fn((...values: unknown[]) => ({ kind: "inArray", values })),
  isNull: jest.fn((value: unknown) => ({ kind: "isNull", value })),
  sql: jest.fn((parts: TemplateStringsArray, ...values: unknown[]) => ({
    kind: "sql",
    parts,
    values,
  })),
}));

jest.unstable_mockModule("@/db", () => ({
  auditLogs: auditTable,
  contacts: contactTable,
  crmPipeline: {},
  crmTasks: taskTable,
  getDb: jest.fn(() => mockDb),
  leadAutomationStates: {},
  leads: {},
  outboxEvents: outboxTable,
  properties: {},
  publicQuoteMutationReceipts: receiptTable,
  quoteChangeRequests: changeTable,
  quotes: quoteTable,
}));

jest.unstable_mockModule("@/lib/sales-scorecard", () => ({
  getDefaultSalesAssigneeMemberId: mockDefaultAssignee,
}));

jest.unstable_mockModule("@/lib/quote-v2-public-route", () => ({
  maybeHandleQuoteV2PublicChange: jest.fn(() =>
    Promise.resolve({ handled: false }),
  ),
  maybeHandleQuoteV2PublicDecision: jest.fn(() =>
    Promise.resolve({ handled: false }),
  ),
  maybeHandleQuoteV2PublicGet: jest.fn(() =>
    Promise.resolve({ handled: false }),
  ),
}));

function request(path: string, key: string, body: unknown): NextRequest {
  return new NextRequest(`https://api.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": key,
      "x-correlation-id": "quote-runtime-correlation-123",
    },
    body: JSON.stringify(body),
  });
}

function resetState(): void {
  state = {
    quote: {
      id: QUOTE_ID,
      contactId: CONTACT_ID,
      status: "sent",
      revision: 3,
      expiresAt: new Date("2026-09-06T16:00:00.000Z"),
      refreshRequestedAt: null,
    },
    auditWrites: [],
    changeWrites: [],
    taskWrites: [],
    outboxWrites: [],
  };
  transactionTail = Promise.resolve();
  contactOwnerId = null;
}

describe("public quote write runtime", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetState();
  });

  it("returns the current revision and performs no business write for a stale decision", async () => {
    const { POST } = await import("../../app/api/public/quotes/[token]/route");
    const response = await POST(
      request(`/api/public/quotes/${TOKEN}`, "decision-key:1234567890", {
        quoteId: QUOTE_ID,
        expectedRevision: 2,
        decision: "accepted",
      }),
      { params: Promise.resolve({ token: TOKEN }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "stale_quote",
      retryable: true,
      quoteId: QUOTE_ID,
      expectedRevision: 2,
      currentRevision: 3,
    });
    expect(state.changeWrites).toHaveLength(0);
    expect(state.taskWrites).toHaveLength(0);
    expect(state.outboxWrites).toHaveLength(0);
  });

  it("does not let a capability act on a different displayed quote", async () => {
    const { POST } = await import("../../app/api/public/quotes/[token]/route");
    const response = await POST(
      request(`/api/public/quotes/${TOKEN}`, "binding-key:1234567890", {
        quoteId: OTHER_QUOTE_ID,
        expectedRevision: 3,
        decision: "accepted",
      }),
      { params: Promise.resolve({ token: TOKEN }) },
    );

    expect(response.status).toBe(404);
    expect(state.changeWrites).toHaveLength(0);
    expect(state.taskWrites).toHaveLength(0);
    expect(state.outboxWrites).toHaveLength(0);
  });

  it("co-commits one owner task and one outbox event across concurrent retries", async () => {
    const { POST } = await import(
      "../../app/api/public/quotes/[token]/changes/route"
    );
    const key = "change-request-key:1234567890";
    const body = {
      quoteId: QUOTE_ID,
      expectedRevision: 3,
      reason: "Scope changed",
      message: "Please remove the sofa.",
    };

    const [first, second] = await Promise.all([
      POST(request(`/api/public/quotes/${TOKEN}/changes`, key, body), {
        params: Promise.resolve({ token: TOKEN }),
      }),
      POST(request(`/api/public/quotes/${TOKEN}/changes`, key, body), {
        params: Promise.resolve({ token: TOKEN }),
      }),
    ]);

    expect([first.status, second.status]).toEqual([201, 201]);
    expect(
      [
        first.headers.get("idempotency-replayed"),
        second.headers.get("idempotency-replayed"),
      ].filter(Boolean),
    ).toEqual(["true"]);
    await expect(first.clone().json()).resolves.toMatchObject({
      ok: true,
      quoteId: QUOTE_ID,
      revision: 3,
      changeRequestId: CHANGE_ID,
    });
    await expect(second.clone().json()).resolves.toMatchObject({
      ok: true,
      quoteId: QUOTE_ID,
      revision: 3,
      changeRequestId: CHANGE_ID,
    });
    expect(state.changeWrites).toHaveLength(1);
    expect(state.taskWrites).toHaveLength(1);
    expect(state.taskWrites[0]).toMatchObject({ assignedTo: OWNER_ID });
    expect(mockDefaultAssignee).toHaveBeenCalledTimes(1);
    expect(state.outboxWrites).toHaveLength(1);
    expect(state.outboxWrites[0]?.payload).toMatchObject({
      quoteId: QUOTE_ID,
      changeRequestId: CHANGE_ID,
      taskId: TASK_ID,
      assignedTo: OWNER_ID,
    });
    const durablePayload = JSON.stringify(state.outboxWrites[0]?.payload);
    expect(durablePayload).not.toContain(TOKEN);
    expect(durablePayload).not.toContain(key);
    expect(state.outboxWrites[0]?.payload["idempotencyKeyHash"]).toMatch(
      /^[0-9a-f]{64}$/u,
    );
  });

  it("rejects reuse of a change-request key with different details", async () => {
    const { POST } = await import(
      "../../app/api/public/quotes/[token]/changes/route"
    );
    const key = "change-conflict-key:1234567890";
    const base = {
      quoteId: QUOTE_ID,
      expectedRevision: 3,
      reason: "Other" as const,
    };

    const created = await POST(
      request(`/api/public/quotes/${TOKEN}/changes`, key, {
        ...base,
        message: "First request",
      }),
      { params: Promise.resolve({ token: TOKEN }) },
    );
    const conflict = await POST(
      request(`/api/public/quotes/${TOKEN}/changes`, key, {
        ...base,
        message: "Different request",
      }),
      { params: Promise.resolve({ token: TOKEN }) },
    );

    expect(created.status).toBe(201);
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      ok: false,
      error: "idempotency_key_reused",
    });
    expect(state.changeWrites).toHaveLength(1);
    expect(state.taskWrites).toHaveLength(1);
    expect(state.outboxWrites).toHaveLength(1);
  });

  it.each([
    [
      "accepted",
      new Date("2026-09-06T16:00:00.000Z"),
      409,
      "quote_not_open_for_changes",
    ],
    ["sent", new Date(0), 410, "expired"],
  ])(
    "rejects change requests when status is %s or the sent quote is expired",
    async (status, expiresAt, expectedStatus, expectedError) => {
      state.quote.status = status;
      state.quote.expiresAt = expiresAt;
      const { POST } = await import(
        "../../app/api/public/quotes/[token]/changes/route"
      );
      const response = await POST(
        request(
          `/api/public/quotes/${TOKEN}/changes`,
          `state-guard-key:${status}:1234567890`,
          {
            quoteId: QUOTE_ID,
            expectedRevision: 3,
            reason: "Timing issue",
          },
        ),
        { params: Promise.resolve({ token: TOKEN }) },
      );

      expect(response.status).toBe(expectedStatus);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: expectedError,
      });
      expect(state.changeWrites).toHaveLength(0);
      expect(state.taskWrites).toHaveLength(0);
      expect(state.outboxWrites).toHaveLength(0);
    },
  );
});
