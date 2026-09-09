import { NextRequest } from "next/server";
import type { POST as OutboundDraftPost } from "../../app/api/admin/outbound/draft/route";

const CONTACT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_CONTACT_ID = "22222222-2222-4222-8222-222222222222";
const TASK_ID = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_ID = "44444444-4444-4444-8444-444444444444";
const GENERAL_THREAD_ID = "55555555-5555-4555-8555-555555555555";
const FINANCIAL_THREAD_ID = "66666666-6666-4666-8666-666666666666";

type Row = Record<string, unknown>;
type Table = Record<string, string>;
type Predicate = { kind: string; values: unknown[] };

function table(name: string, fields: string[]): Table {
  return Object.fromEntries(fields.map((field) => [field, `${name}.${field}`]));
}

const contactTable = table("contacts", [
  "id",
  "firstName",
  "lastName",
  "company",
  "email",
  "phone",
  "phoneE164",
  "salespersonMemberId",
  "partnerAccountId",
  "doNotContact",
  "deletedAt",
]);
const taskTable = table("tasks", [
  "id",
  "contactId",
  "partnerAccountId",
  "notes",
]);
const accountTable = table("accounts", [
  "id",
  "name",
  "segment",
  "city",
  "state",
]);
const threadTable = table("threads", [
  "id",
  "contactId",
  "channel",
  "staffScope",
  "status",
  "lastMessageAt",
  "updatedAt",
]);
const participantTable = table("participants", [
  "id",
  "threadId",
  "participantType",
  "displayName",
  "teamMemberId",
]);
const messageTable = table("messages", [
  "id",
  "threadId",
  "direction",
  "channel",
  "subject",
  "body",
  "createdAt",
  "metadata",
]);

let rows: Map<Table, Row[]>;
const mockInsert = jest.fn();
const mockUpdate = jest.fn();
const mockAudit = jest.fn();
const mockPermission = jest.fn();
const mockAdmin = jest.fn();
const mockFirstDraft = jest.fn();
const mockFollowupDraft = jest.fn();

function stored(source: Table, values: Row): Row {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [source[key]!, value]),
  );
}

function matches(condition: unknown, row: Row): boolean {
  if (!condition) return true;
  const { kind, values } = condition as Predicate;
  if (kind === "and") return values.every((value) => matches(value, row));
  if (kind === "or") return values.some((value) => matches(value, row));
  if (kind === "eq") {
    const left = String(values[0]);
    const right = values[1];
    return (
      row[left] ===
      (typeof right === "string" && right in row ? row[right] : right)
    );
  }
  return true;
}

const mockDb = {
  select: jest.fn((projection: Record<string, string>) => ({
    from: (source: Table) => {
      let selectedRows = rows.get(source) ?? [];
      const query = {
        innerJoin: (joined: Table, condition: unknown) => {
          selectedRows = selectedRows
            .flatMap((row) =>
              (rows.get(joined) ?? []).map((other) => ({ ...row, ...other })),
            )
            .filter((row) => matches(condition, row));
          return query;
        },
        where: (condition: unknown) => {
          selectedRows = selectedRows.filter((row) => matches(condition, row));
          return query;
        },
        orderBy: () => query,
        limit: (limit: number) =>
          Promise.resolve(
            selectedRows
              .slice(0, limit)
              .map((row) =>
                Object.fromEntries(
                  Object.entries(projection).map(([alias, key]) => [
                    alias,
                    row[key],
                  ]),
                ),
              ),
          ),
      };
      return query;
    },
  })),
  insert: (source: Table) => ({
    values: (values: Row) => {
      mockInsert(source, values);
      const id =
        source === threadTable ? GENERAL_THREAD_ID : crypto.randomUUID();
      const record = stored(source, { ...values, id });
      rows.set(source, [...(rows.get(source) ?? []), record]);
      return {
        returning: (projection: Record<string, string>) =>
          Promise.resolve([
            Object.fromEntries(
              Object.entries(projection).map(([alias, key]) => [
                alias,
                record[key],
              ]),
            ),
          ]),
      };
    },
  }),
  update: (source: Table) => ({
    set: (values: Row) => ({
      where: (condition: unknown) => {
        mockUpdate(source, values, condition);
        return Promise.resolve();
      },
    }),
  }),
};

jest.mock("drizzle-orm", () => ({
  and: (...values: unknown[]) => ({ kind: "and", values }),
  or: (...values: unknown[]) => ({ kind: "or", values }),
  eq: (...values: unknown[]) => ({ kind: "eq", values }),
  desc: (value: unknown) => value,
  sql: (...values: unknown[]) => ({ kind: "sql", values }),
}));
jest.mock("@/db", () => ({
  contacts: contactTable,
  crmTasks: taskTable,
  partnerAccounts: accountTable,
  conversationThreads: threadTable,
  conversationParticipants: participantTable,
  conversationMessages: messageTable,
  getDb: () => mockDb,
}));
jest.mock("../../app/api/web/admin", () => ({ isAdminRequest: mockAdmin }));
jest.mock("@/lib/permissions", () => ({ requirePermission: mockPermission }));
jest.mock("@/lib/audit", () => ({
  getAuditActorFromRequest: () => ({ type: "team", id: "test-owner" }),
  recordAuditEvent: mockAudit,
}));
jest.mock("@/lib/policy", () => ({
  getSalesAutopilotPolicy: () =>
    Promise.resolve({
      agentDisplayName: "Draft assistant",
    }),
}));
jest.mock("@/lib/outbound-drafts", () => ({
  generateOutboundFirstTouchDraft: mockFirstDraft,
  generateOutboundFollowupDraft: mockFollowupDraft,
}));

let POST: typeof OutboundDraftPost;
beforeAll(async () => {
  ({ POST } = await import("../../app/api/admin/outbound/draft/route"));
});

function request(payload: unknown): NextRequest {
  return new NextRequest("https://api.example.test/api/admin/outbound/draft", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function setContact(patch: Row): void {
  rows.set(contactTable, [
    { ...rows.get(contactTable)![0]!, ...stored(contactTable, patch) },
  ]);
}

function expectNoWrites(): void {
  expect(mockInsert).not.toHaveBeenCalled();
  expect(mockUpdate).not.toHaveBeenCalled();
  expect(mockFirstDraft).not.toHaveBeenCalled();
  expect(mockFollowupDraft).not.toHaveBeenCalled();
  expect(mockAudit).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAdmin.mockReturnValue(true);
  mockPermission.mockResolvedValue(null);
  const draft = {
    subject: "Draft subject",
    body: "A draft for staff review.",
    provider: "fallback",
    model: null,
  };
  mockFirstDraft.mockResolvedValue(draft);
  mockFollowupDraft.mockResolvedValue(draft);
  rows = new Map([
    [
      contactTable,
      [
        stored(contactTable, {
          id: CONTACT_ID,
          firstName: "Casey",
          lastName: "Contact",
          company: "Sample Company",
          email: "casey@example.test",
          phone: null,
          phoneE164: null,
          salespersonMemberId: null,
          partnerAccountId: null,
          doNotContact: false,
          deletedAt: null,
        }),
      ],
    ],
    [
      taskTable,
      [
        stored(taskTable, {
          id: TASK_ID,
          contactId: CONTACT_ID,
          partnerAccountId: null,
          notes:
            "kind=outbound\ncampaign=property_management\nattempt=2\nnotes=Needs a cleanout",
        }),
      ],
    ],
    [threadTable, []],
    [participantTable, []],
    [messageTable, []],
    [accountTable, []],
  ]);
});

describe("outbound draft route integrity", () => {
  it.each([
    { contactId: "not-an-id" },
    { contactId: CONTACT_ID, taskId: "not-an-id" },
    { contactId: CONTACT_ID, channel: "fax" },
    { contactId: CONTACT_ID, kind: "send_now" },
    { contactId: CONTACT_ID, recap: "x".repeat(4_001) },
    [],
  ])(
    "rejects invalid input before reading or changing CRM data: %j",
    async (payload) => {
      const response = await POST(request(payload));
      expect(response.status).toBe(400);
      expect(mockDb.select).not.toHaveBeenCalled();
      expectNoWrites();
    },
  );

  it("rejects missing write permission before CRM reads", async () => {
    mockPermission.mockResolvedValue(new Response(null, { status: 403 }));
    expect((await POST(request({ contactId: CONTACT_ID }))).status).toBe(403);
    expect(mockPermission).toHaveBeenCalledWith(
      expect.anything(),
      "outbound.write",
    );
    expect(mockDb.select).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it.each([
    [{ deletedAt: new Date() }, 404],
    [{ doNotContact: true }, 409],
  ])(
    "rejects unsafe contact state %j without side effects",
    async (patch, status) => {
      setContact(patch as Row);
      expect(
        (await POST(request({ contactId: CONTACT_ID, taskId: TASK_ID })))
          .status,
      ).toBe(status);
      expectNoWrites();
    },
  );

  it.each([
    { contactId: OTHER_CONTACT_ID },
    { notes: "kind=inbound" },
    { partnerAccountId: ACCOUNT_ID },
  ])("rejects mismatched task context %j before any write", async (patch) => {
    if ("partnerAccountId" in patch) {
      setContact({ partnerAccountId: "77777777-7777-4777-8777-777777777777" });
    }
    rows.set(taskTable, [
      { ...rows.get(taskTable)![0]!, ...stored(taskTable, patch) },
    ]);
    const response = await POST(
      request({ contactId: CONTACT_ID, taskId: TASK_ID }),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: "outbound_task_not_found",
    });
    expectNoWrites();
  });

  it("preserves explicitly account-linked legacy tasks without inferring a company", async () => {
    rows.set(taskTable, [
      {
        ...rows.get(taskTable)![0]!,
        ...stored(taskTable, { partnerAccountId: ACCOUNT_ID }),
      },
    ]);
    rows.set(accountTable, [
      stored(accountTable, {
        id: ACCOUNT_ID,
        name: "Explicitly linked company",
        segment: null,
        city: null,
        state: null,
      }),
    ]);
    const response = await POST(
      request({ contactId: CONTACT_ID, taskId: TASK_ID }),
    );
    expect(response.status).toBe(200);
    expect(mockFirstDraft).toHaveBeenCalledWith(
      expect.objectContaining({ company: "Explicitly linked company" }),
    );
    expect(
      mockInsert.mock.calls.some(
        ([source]) =>
          source === accountTable ||
          source === contactTable ||
          source === taskTable,
      ),
    ).toBe(false);
    expect(
      mockUpdate.mock.calls.every(([source]) => source === threadTable),
    ).toBe(true);
  });

  it("creates a review-only draft without creating or linking any company", async () => {
    const response = await POST(
      request({ contactId: CONTACT_ID, taskId: TASK_ID }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      contactId: CONTACT_ID,
      channel: "email",
    });
    expect(
      mockInsert.mock.calls.some(
        ([source]) =>
          source === accountTable ||
          source === contactTable ||
          source === taskTable,
      ),
    ).toBe(false);
    expect(
      mockUpdate.mock.calls.every(([source]) => source === threadTable),
    ).toBe(true);
    expect(mockFirstDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        campaign: "property_management",
        attempt: 2,
        company: "Sample Company",
      }),
    );
    const draftMetadata: unknown = expect.objectContaining({ draft: true });
    expect(mockInsert).toHaveBeenCalledWith(
      messageTable,
      expect.objectContaining({
        deliveryStatus: "queued",
        metadata: draftMetadata,
      }),
    );
  });

  it("keeps financial threads and financial message history out of ordinary outreach", async () => {
    rows.set(threadTable, [
      stored(threadTable, {
        id: FINANCIAL_THREAD_ID,
        contactId: CONTACT_ID,
        channel: "email",
        staffScope: "partner_billing",
        status: "open",
      }),
    ]);
    rows.set(messageTable, [
      stored(messageTable, {
        id: crypto.randomUUID(),
        threadId: FINANCIAL_THREAD_ID,
        direction: "inbound",
        channel: "email",
        subject: "Confidential balance",
        body: "Private financial details",
        createdAt: new Date(),
        metadata: {},
      }),
    ]);
    const response = await POST(
      request({ contactId: CONTACT_ID, kind: "follow_up" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      threadId: GENERAL_THREAD_ID,
    });
    expect(mockInsert).toHaveBeenCalledWith(
      threadTable,
      expect.objectContaining({ staffScope: "general" }),
    );
    expect(mockFollowupDraft).toHaveBeenCalledWith(
      expect.objectContaining({ recentMessages: [] }),
    );
    expect(mockUpdate).not.toHaveBeenCalledWith(
      threadTable,
      expect.anything(),
      expect.objectContaining({
        values: [threadTable.id, FINANCIAL_THREAD_ID],
      }),
    );
  });

  it("reuses a normal Inbox thread and its actual contact history", async () => {
    rows.set(threadTable, [
      stored(threadTable, {
        id: GENERAL_THREAD_ID,
        contactId: CONTACT_ID,
        channel: "email",
        staffScope: "general",
        status: "open",
      }),
    ]);
    rows.set(messageTable, [
      stored(messageTable, {
        id: crypto.randomUUID(),
        threadId: GENERAL_THREAD_ID,
        direction: "inbound",
        channel: "email",
        subject: null,
        body: "Please call about the next cleanout.",
        createdAt: new Date(),
        metadata: {},
      }),
    ]);
    expect(
      (await POST(request({ contactId: CONTACT_ID, kind: "follow_up" })))
        .status,
    ).toBe(200);
    expect(
      mockInsert.mock.calls.some(([source]) => source === threadTable),
    ).toBe(false);
    expect(mockFollowupDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        recentMessages: [
          expect.objectContaining({
            body: "Please call about the next cleanout.",
          }),
        ],
      }),
    );
  });
});
