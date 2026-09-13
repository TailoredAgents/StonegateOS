import { createHash, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import type { TeamMutationContext } from "@/lib/team-mutation";
import type * as TeamMutationModule from "@/lib/team-mutation";
import type * as InboxRoute from "../../app/api/admin/inbox/threads/[threadId]/messages/route";

// Exercise the actual durable claim/complete/replay helpers and route against
// a serializable in-memory transaction store. Provider delivery is never run.
type Row = Record<string, unknown>;
type Column = { table: string; key: string };
type Table = { name: string; [key: string]: unknown };
type Condition =
  | { kind: "eq" | "lte"; column: Column; value: unknown }
  | { kind: "and"; conditions: Condition[] };
const mockTables: Record<string, Table> = {};
for (const [name, fields] of Object.entries({
  conversationThreads: [
    "id",
    "channel",
    "contactId",
    "portalVisible",
    "partnerBookingId",
    "staffScope",
  ],
  conversationMessages: [
    "id",
    "threadId",
    "direction",
    "channel",
    "createdAt",
    "fromAddress",
    "metadata",
  ],
  conversationParticipants: [
    "id",
    "threadId",
    "participantType",
    "teamMemberId",
  ],
  contacts: [
    "id",
    "doNotContact",
    "firstName",
    "lastName",
    "email",
    "phone",
    "phoneE164",
    "salespersonMemberId",
  ],
  outboxEvents: ["id"],
  auditLogs: ["id"],
  teamMutationIdempotency: [
    "id",
    "principalHash",
    "action",
    "keyHash",
    "operationId",
    "attemptCount",
    "status",
    "claimExpiresAt",
    "scopeHash",
    "requestHash",
  ],
})) {
  mockTables[name] = { name };
  for (const key of fields) mockTables[name][key] = { table: name, key };
}
let mockStore: Record<string, Row[]>;
let mockTransactionTail: Promise<void> = Promise.resolve();
let mockFailAudit = false;
let mockAdmin = true;
const mockPermission = jest.fn(
  (): Promise<Response | null> => Promise.resolve(null),
);
const mockActiveContact = jest.fn(() => Promise.resolve());
const mockFollowup = jest.fn(() => Promise.resolve());
const mockLegacyAudit = jest.fn(() => Promise.resolve());
const mockPartnerSend = jest.fn(() =>
  Promise.resolve({ id: "partner-message" }),
);
const mockBoundary = jest.fn<
  Promise<unknown>,
  [NextRequest, TeamMutationContext["policy"]]
>();

jest.mock("drizzle-orm", () => ({
  eq: (column: Column, value: unknown) => ({ kind: "eq", column, value }),
  lte: (column: Column, value: unknown) => ({ kind: "lte", column, value }),
  and: (...conditions: Condition[]) => ({ kind: "and", conditions }),
  desc: (column: Column) => column,
}));
jest.mock("@/db", () => ({ ...mockTables, getDb: () => mockDb }));
jest.mock("@/lib/permissions", () => ({
  requirePermission: (...args: unknown[]) => mockPermission(...(args as [])),
}));
jest.mock("@/lib/contact-outbound-safety", () => ({
  requireActiveContactForDirectOutbound: (...args: unknown[]) =>
    mockActiveContact(...(args as [])),
}));
jest.mock("@/lib/audit", () => ({
  getAuditActorFromRequest: () => ({
    type: "human",
    id: "staff-1",
    label: "Crew",
  }),
  recordAuditEvent: (...args: unknown[]) => mockLegacyAudit(...(args as [])),
}));
jest.mock("@/lib/sales-followups", () => ({
  completeNextFollowupTaskOnTouch: (...args: unknown[]) =>
    mockFollowup(...(args as [])),
}));
jest.mock("@/lib/partner-job-communication", () => ({
  sendStaffPartnerJobMessage: (...args: unknown[]) =>
    mockPartnerSend(...(args as [])),
}));
jest.mock("../../app/api/web/admin", () => ({
  isAdminRequest: () => mockAdmin,
}));
jest.mock("@/lib/team-mutation", () => ({
  ...jest.requireActual<typeof TeamMutationModule>("@/lib/team-mutation"),
  beginTeamMutation: (
    request: NextRequest,
    policy: TeamMutationContext["policy"],
  ) => mockBoundary(request, policy),
}));

function matches(
  store: Record<string, Row[]>,
  row: Row,
  condition?: Condition,
): boolean {
  if (!condition) return true;
  if (condition.kind === "and")
    return condition.conditions.every((part) => matches(store, row, part));
  const value = readColumn(store, row, condition.column);
  return condition.kind === "eq"
    ? value === condition.value
    : (value as Date) <= (condition.value as Date);
}
function readColumn(
  store: Record<string, Row[]>,
  row: Row,
  column: Column,
): unknown {
  return column.table === "contacts" && row.contactId
    ? store.contacts!.find((contact) => contact.id === row.contactId)?.[
        column.key
      ]
    : row[column.key];
}
function client(store: () => Record<string, Row[]>) {
  return {
    select(selection?: Record<string, Column>) {
      let table: Table;
      let condition: Condition | undefined;
      const query = {
        from(value: Table) {
          table = value;
          return query;
        },
        leftJoin() {
          return query;
        },
        where(value: Condition) {
          condition = value;
          return query;
        },
        for() {
          return query;
        },
        orderBy() {
          return query;
        },
        limit(count: number) {
          return Promise.resolve(
            store()
              [table.name]!.filter((row) => matches(store(), row, condition))
              .slice(0, count)
              .map((row) =>
                selection
                  ? Object.fromEntries(
                      Object.entries(selection).map(([key, column]) => [
                        key,
                        readColumn(store(), row, column),
                      ]),
                    )
                  : structuredClone(row),
              ),
          );
        },
      };
      return query;
    },
    insert(table: Table) {
      let values: Row;
      let uniqueColumns: Column[] | null = null;
      let applied = false;
      let rows: Row[] = [];
      const apply = () => {
        if (applied) return rows;
        applied = true;
        if (
          uniqueColumns &&
          store()[table.name]!.some((row) =>
            uniqueColumns!.every(
              (column) => row[column.key] === values[column.key],
            ),
          )
        )
          return [];
        const row = {
          id: randomUUID(),
          ...(table.name === "teamMutationIdempotency"
            ? {
                status: "in_progress",
                responseBody: null,
                responseStatus: null,
              }
            : {}),
          ...values,
        };
        store()[table.name]!.push(row);
        rows = [row];
        return rows;
      };
      const query = {
        values(value: Row) {
          values = value;
          return query;
        },
        onConflictDoNothing({ target }: { target: Column[] }) {
          uniqueColumns = target;
          return query;
        },
        returning() {
          return Promise.resolve(apply());
        },
        then(
          resolve: (value: Row[]) => unknown,
          reject?: (error: unknown) => unknown,
        ) {
          return Promise.resolve().then(apply).then(resolve, reject);
        },
      };
      return query;
    },
    update(table: Table) {
      let values: Row;
      let condition: Condition;
      let applied = false;
      let rows: Row[] = [];
      const apply = () => {
        if (applied) return rows;
        applied = true;
        rows = store()[table.name]!.filter((row) =>
          matches(store(), row, condition),
        );
        for (const row of rows) Object.assign(row, values);
        return rows;
      };
      const query = {
        set(value: Row) {
          values = value;
          return query;
        },
        where(value: Condition) {
          condition = value;
          return query;
        },
        returning() {
          return Promise.resolve(apply());
        },
        then(
          resolve: (value: Row[]) => unknown,
          reject?: (error: unknown) => unknown,
        ) {
          return Promise.resolve().then(apply).then(resolve, reject);
        },
      };
      return query;
    },
  };
}
const mockDb = {
  ...client(() => mockStore),
  async transaction<T>(
    work: (tx: ReturnType<typeof client>) => Promise<T>,
  ): Promise<T> {
    const previous = mockTransactionTail;
    let release!: () => void;
    mockTransactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const transactionStore = structuredClone(mockStore);
    try {
      const value = await work(client(() => transactionStore));
      mockStore = transactionStore;
      return value;
    } finally {
      release();
    }
  },
};
const threadId = "11111111-1111-4111-8111-111111111111";
const { POST } = jest.requireActual<typeof InboxRoute>(
  "../../app/api/admin/inbox/threads/[threadId]/messages/route",
);
const { TeamMutationFailure } = jest.requireActual<typeof TeamMutationModule>(
  "@/lib/team-mutation",
);
const key = "team-inbox:22222222-2222-4222-8222-222222222222";
function send(
  payload: Row = { body: "On our way", channel: "sms" },
  requestKey: string | null = key,
  id = threadId,
) {
  return POST(
    new NextRequest(`http://localhost/api/admin/inbox/threads/${id}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(requestKey === null ? {} : { "idempotency-key": requestKey }),
      },
      body: JSON.stringify(payload),
    }),
    { params: Promise.resolve({ threadId: id }) },
  );
}
function committedCounts() {
  return {
    messages: mockStore.conversationMessages!.length,
    outbox: mockStore.outboxEvents!.length,
    audit: mockStore.auditLogs!.length,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStore = Object.fromEntries(
    Object.keys(mockTables).map((name) => [name, []]),
  );
  mockStore.conversationThreads!.push({
    id: threadId,
    channel: "sms",
    contactId: "44444444-4444-4444-8444-444444444444",
    portalVisible: false,
    partnerBookingId: null,
    staffScope: "general",
  });
  mockStore.contacts!.push({
    id: "44444444-4444-4444-8444-444444444444",
    phoneE164: "+15555550123",
    email: "customer@example.test",
    doNotContact: false,
  });
  mockTransactionTail = Promise.resolve();
  mockFailAudit = false;
  mockAdmin = true;
  mockPermission.mockResolvedValue(null);
  mockActiveContact.mockResolvedValue(undefined);
  mockBoundary.mockImplementation(
    (request: NextRequest, policy: TeamMutationContext["policy"]) =>
      Promise.resolve({
        ok: true,
        mutation: {
          policy,
          actor: { type: "human", id: "staff-1", sessionId: "session-1" },
          principalType: "human",
          operationId: randomUUID(),
          correlationId: randomUUID(),
          idempotencyKeyHash: createHash("sha256")
            .update(request.headers.get("idempotency-key") ?? "")
            .digest("hex"),
          expectedVersion: null,
          audit: {
            async insertSuccess(tx: ReturnType<typeof client>, input: Row) {
              if (mockFailAudit) throw new Error("Audit unavailable");
              const [audit] = await tx
                .insert(mockTables.auditLogs!)
                .values({ ...input, action: policy.auditAction })
                .returning();
              return {
                auditEventId: String(audit!.id),
                committedAt: (input.committedAt as Date).toISOString(),
              };
            },
          },
        },
      }),
  );
});

describe("regular staff Inbox message idempotency", () => {
  it("binds and replays the verified recipient and channel without a separate detail read", async () => {
    const payload = {
      body: "On our way",
      channel: "sms",
      expectedContactId: "44444444-4444-4444-8444-444444444444",
    };
    const first = await send(payload);
    const receipt: unknown = await first.json();
    expect(first.status).toBe(200);
    const replay = await send(payload);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(receipt);
    expect(committedCounts()).toEqual({ messages: 1, outbox: 1, audit: 1 });
  });

  it.each([
    {
      expectedContactId: "55555555-5555-4555-8555-555555555555",
      channel: "sms",
    },
    { expectedContactId: null, channel: "sms" },
    {
      expectedContactId: "44444444-4444-4444-8444-444444444444",
      channel: "email",
    },
    { expectedContactId: "44444444-4444-4444-8444-444444444444" },
  ])(
    "rejects a mismatched bound recipient/channel before inserts and replays that failure: %j",
    async (context) => {
      const payload = { body: "On our way", ...context };
      const first = await send(payload);
      const replay = await send(payload);
      expect(first.status).toBe(409);
      expect(await first.json()).toEqual({ error: "thread_context_mismatch" });
      expect(replay.status).toBe(409);
      expect(await replay.json()).toEqual({ error: "thread_context_mismatch" });
      expect(replay.headers.get("idempotency-replayed")).toBe("true");
      expect(first.headers.get("retry-after")).toBeNull();
      expect(committedCounts()).toEqual({ messages: 0, outbox: 0, audit: 0 });
      expect(mockStore.conversationParticipants).toHaveLength(0);
      expect(mockActiveContact).not.toHaveBeenCalled();
    },
  );

  it("includes supplied recipient context in the exact request fingerprint", async () => {
    expect((await send()).status).toBe(200);
    const response = await send({
      body: "On our way",
      channel: "sms",
      expectedContactId: "44444444-4444-4444-8444-444444444444",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "conflict",
      retryable: false,
    });
    expect(committedCounts()).toEqual({ messages: 1, outbox: 1, audit: 1 });
  });

  it("keeps legacy channel override behavior when recipient binding is omitted", async () => {
    const response = await send({ body: "An email update", channel: "email" });
    expect(response.status).toBe(200);
    expect(mockStore.conversationMessages![0]).toMatchObject({
      channel: "email",
      toAddress: "customer@example.test",
    });
  });

  it("rejects malformed supplied recipient identity before a claim or send", async () => {
    const response = await send({
      body: "Update",
      channel: "sms",
      expectedContactId: "not-a-uuid",
    });
    expect(response.status).toBe(400);
    expect(mockBoundary).not.toHaveBeenCalled();
    expect(committedCounts()).toEqual({ messages: 0, outbox: 0, audit: 0 });
  });

  it("replays the exact generic response with one message, outbox item and atomic audit", async () => {
    const first = await send();
    const original = (await first.json()) as {
      message: Record<string, unknown>;
    };
    const replay = await send();
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(original);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(Object.keys(original)).toEqual(["message"]);
    expect(Object.keys(original.message).sort()).toEqual([
      "channel",
      "createdAt",
      "deliveryStatus",
      "direction",
      "id",
      "threadId",
    ]);
    expect(committedCounts()).toEqual({ messages: 1, outbox: 1, audit: 1 });
    expect(mockFollowup).toHaveBeenCalledTimes(1);
    expect(mockLegacyAudit).not.toHaveBeenCalled();
    expect(mockStore.auditLogs![0]!.action).toBe("message.queued");
  });

  it.each([
    { body: "Changed message", channel: "sms" },
    { body: "On our way", channel: "email" },
    { body: "On our way", channel: "sms", direction: "inbound" },
    { body: "On our way", channel: "sms", toAddress: "+15555550999" },
    { body: "On our way", channel: "sms", allowDncOverride: true },
    {
      body: "On our way",
      channel: "sms",
      mediaUrls: ["https://example.test/photo.png"],
    },
  ])(
    "rejects changed payload without creating another message: %j",
    async (changed) => {
      await send();
      const response = await send(changed);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "conflict",
        retryable: false,
      });
      expect(response.headers.get("retry-after")).toBeNull();
      expect(committedCounts()).toEqual({ messages: 1, outbox: 1, audit: 1 });
    },
  );

  it("scopes one key to one thread for the verified principal", async () => {
    await send();
    const other = "33333333-3333-4333-8333-333333333333";
    mockStore.conversationThreads!.push({
      ...mockStore.conversationThreads![0],
      id: other,
    });
    expect((await send(undefined, key, other)).status).toBe(409);
    expect(committedCounts()).toEqual({ messages: 1, outbox: 1, audit: 1 });
  });

  it("serializes concurrent double clicks and confirms the same saved message on retry", async () => {
    const responses = await Promise.all([send(), send()]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    const pending = responses.find((response) => response.status === 409)!;
    expect(pending.headers.get("retry-after")).toMatch(/^\d+$/u);
    expect(await pending.json()).toMatchObject({
      code: "conflict",
      retryable: true,
    });
    const confirmed: unknown = await responses
      .find((response) => response.status === 200)!
      .json();
    expect(await (await send()).json()).toEqual(confirmed);
    expect(committedCounts()).toEqual({ messages: 1, outbox: 1, audit: 1 });
  });

  it("rolls message/outbox/audit back together and safely retries the same key after audit failure", async () => {
    mockFailAudit = true;
    const failure = await send();
    expect(failure.status).toBe(500);
    expect(await failure.json()).toMatchObject({ retryable: true });
    expect(committedCounts()).toEqual({ messages: 0, outbox: 0, audit: 0 });
    mockFailAudit = false;
    expect((await send()).status).toBe(200);
    expect(committedCounts()).toEqual({ messages: 1, outbox: 1, audit: 1 });
  });

  it.each(["dnc_confirmation_required", "missing_recipient"])(
    "preserves deterministic %s failures and their replay",
    async (error) => {
      if (error === "dnc_confirmation_required")
        mockStore.contacts![0]!.doNotContact = true;
      else mockStore.contacts![0]!.phoneE164 = null;
      const first = await send();
      const replay = await send();
      expect(first.status).toBe(400);
      expect(replay.status).toBe(400);
      expect(await first.json()).toEqual({ error });
      expect(await replay.json()).toEqual({ error });
      expect(replay.headers.get("idempotency-replayed")).toBe("true");
      expect(committedCounts()).toEqual({ messages: 0, outbox: 0, audit: 0 });
    },
  );

  it("retains explicit reviewed DNC override and recipient resolution", async () => {
    mockStore.contacts![0]!.doNotContact = true;
    expect(
      (await send({ body: "Requested reply", allowDncOverride: true })).status,
    ).toBe(200);
    expect(mockStore.conversationMessages![0]).toMatchObject({
      toAddress: "+15555550123",
      metadata: {
        allowDncOverride: true,
        dncOverrideSource: "explicit_inbox_send",
        dncOverrideActorId: "staff-1",
      },
    });
  });

  it("does not expose an old receipt after a thread leaves generic staff scope", async () => {
    await send();
    mockStore.conversationThreads![0]!.staffScope = "partner_billing";
    const replay = await send();
    expect(replay.status).toBe(404);
    expect(await replay.json()).toEqual({ error: "thread_not_found" });
    expect(committedCounts()).toEqual({ messages: 1, outbox: 1, audit: 1 });
  });

  it("keeps archived contacts blocked before outbound inserts", async () => {
    mockActiveContact.mockRejectedValue(
      new TeamMutationFailure("forbidden", "Contact archived"),
    );
    const response = await send();
    expect(response.status).toBe(403);
    expect(committedCounts()).toEqual({ messages: 0, outbox: 0, audit: 0 });
  });

  it("preserves legacy callers with no key", async () => {
    expect((await send(undefined, null)).status).toBe(200);
    expect((await send(undefined, null)).status).toBe(200);
    expect(mockBoundary).not.toHaveBeenCalled();
    expect(mockStore.teamMutationIdempotency).toHaveLength(0);
    expect(mockStore.conversationMessages).toHaveLength(2);
    expect(mockLegacyAudit).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["inbound", "delivered", "message.received"],
    ["internal", "sent", "message.queued"],
  ])(
    "preserves %s delivery and audit rules without enqueueing external delivery",
    async (direction, deliveryStatus, action) => {
      const payload = { body: "Recorded message", direction };
      const response = await send(payload);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        message: { direction, deliveryStatus },
      });
      expect((await send(payload)).headers.get("idempotency-replayed")).toBe(
        "true",
      );
      expect(committedCounts()).toEqual({ messages: 1, outbox: 0, audit: 1 });
      expect(mockStore.auditLogs![0]!.action).toBe(action);
      expect(mockActiveContact).not.toHaveBeenCalled();
    },
  );

  it("does not fall back to a legacy send when a supplied key fails its boundary", async () => {
    mockBoundary.mockResolvedValue({
      ok: false,
      response: NextResponse.json(
        { ok: false, code: "invalid" },
        { status: 422 },
      ),
    });
    expect((await send(undefined, "")).status).toBe(422);
    expect(mockStore.teamMutationIdempotency).toHaveLength(0);
    expect(committedCounts()).toEqual({ messages: 0, outbox: 0, audit: 0 });
  });

  it("keeps partner-job communication on its existing required-idempotency path", async () => {
    mockStore.conversationThreads![0]!.portalVisible = true;
    mockStore.conversationThreads![0]!.partnerBookingId = "partner-job";
    const response = await send({
      body: "Partner update",
      audience: "partner",
    });
    expect(response.status).toBe(200);
    expect(mockPartnerSend).toHaveBeenCalledTimes(1);
    expect(mockBoundary.mock.calls[0]![1]).toMatchObject({
      requiresIdempotency: true,
      requiredPermissions: ["messages.send", "partners.accounts.read"],
    });
    expect(mockStore.teamMutationIdempotency).toHaveLength(0);
  });

  it("passes explicit partner web context to the existing partner transaction and fingerprint", async () => {
    Object.assign(mockStore.conversationThreads![0]!, {
      portalVisible: true,
      partnerBookingId: "partner-job",
      contactId: null,
      channel: "web",
    });
    const response = await send({
      body: "Partner update",
      audience: "partner",
      expectedContactId: null,
      channel: "web",
    });
    expect(response.status).toBe(200);
    expect(mockPartnerSend).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedContactId: null,
        expectedChannel: "web",
        audience: "partner",
      }),
    );
  });

  it.each([
    {
      expectedContactId: "44444444-4444-4444-8444-444444444444",
      channel: "web",
    },
    { expectedContactId: null, channel: "sms" },
  ])(
    "rejects partner context mismatch before dispatch: %j",
    async (context) => {
      Object.assign(mockStore.conversationThreads![0]!, {
        portalVisible: true,
        partnerBookingId: "partner-job",
        contactId: null,
        channel: "web",
      });
      const response = await send({
        body: "Partner update",
        audience: "partner",
        ...context,
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: "thread_context_mismatch",
      });
      expect(mockPartnerSend).not.toHaveBeenCalled();
      expect(committedCounts()).toEqual({ messages: 0, outbox: 0, audit: 0 });
    },
  );

  it("denies unauthorized requests before claiming or inserting", async () => {
    mockPermission.mockResolvedValue(
      NextResponse.json({ error: "forbidden" }, { status: 403 }),
    );
    expect((await send()).status).toBe(403);
    expect(mockBoundary).not.toHaveBeenCalled();
    expect(mockStore.teamMutationIdempotency).toHaveLength(0);
    expect(committedCounts()).toEqual({ messages: 0, outbox: 0, audit: 0 });
  });
});
