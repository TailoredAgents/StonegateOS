import type { DatabaseClient } from "@/db";
import type { OutboundQueueAccount } from "@/lib/outbound-queue-query";
import type { loadOutboundSelectedEnrichment as LoadEnrichment } from "@/lib/outbound-queue-enrichment";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const accountTable = {
  id: "account.id",
  aiAccountBrief: "account.aiAccountBrief",
};
const taskTable = {
  id: "task.id",
  contactId: "task.contactId",
  createdAt: "task.createdAt",
};
const contactTable = {
  id: "contact.id",
  partnerAccountId: "contact.partnerAccountId",
};
const mockGetDb = jest.fn();
const mockUpdate = jest.fn();
const mockInsert = jest.fn();
let storedBrief: unknown;

const mockDb = {
  select: jest.fn(() => ({
    from: (source: unknown) => {
      const query = {
        innerJoin: () => query,
        where: () => query,
        orderBy: () => query,
        limit: () =>
          Promise.resolve(
            source === accountTable ? [{ aiAccountBrief: storedBrief }] : [],
          ),
      };
      return query;
    },
  })),
  update: mockUpdate,
  insert: mockInsert,
};

jest.mock("@/db", () => ({
  getDb: mockGetDb,
  partnerAccounts: accountTable,
  contacts: contactTable,
  crmTasks: taskTable,
  auditLogs: {},
  outboxEvents: {},
}));
jest.mock("drizzle-orm", () => ({
  and: (...values: unknown[]) => ({ kind: "and", values }),
  or: (...values: unknown[]) => ({ kind: "or", values }),
  eq: (...values: unknown[]) => ({ kind: "eq", values }),
  inArray: (...values: unknown[]) => ({ kind: "inArray", values }),
  desc: (value: unknown) => value,
  sql: (...values: unknown[]) => ({ kind: "sql", values }),
}));

let loadOutboundSelectedEnrichment: typeof LoadEnrichment;
beforeAll(async () => {
  ({ loadOutboundSelectedEnrichment } = await import(
    "@/lib/outbound-queue-enrichment"
  ));
});

beforeEach(() => {
  jest.clearAllMocks();
  storedBrief = null;
});

function load(
  accountKey = `account:${ACCOUNT_ID}`,
  selectedAccountId = ACCOUNT_ID,
) {
  return loadOutboundSelectedEnrichment({
    db: mockDb as unknown as DatabaseClient,
    items: [
      {
        id: ACCOUNT_ID,
        key: accountKey,
        contacts: [],
        taskIds: [],
      },
    ] as unknown as OutboundQueueAccount[],
    selectedAccountId,
    selectedTaskId: "",
  });
}

function expectReadOnly(): void {
  expect(mockGetDb).not.toHaveBeenCalled();
  expect(mockUpdate).not.toHaveBeenCalled();
  expect(mockInsert).not.toHaveBeenCalled();
}

describe("Outbound selected context remains read-only", () => {
  it.each([null, { summary: "An incomplete stored draft" }])(
    "keeps a missing or invalid stored brief optional instead of generating it",
    async (value) => {
      storedBrief = value;
      expect(await load()).toEqual({
        accountId: ACCOUNT_ID,
        brief: null,
        history: [],
      });
      expectReadOnly();
    },
  );

  it("displays a valid stored brief without refreshing or mutating it", async () => {
    storedBrief = {
      summary: "Stored company context",
      whyFit: "Repeat cleanup work",
      serviceAngle: "Cleanouts",
      bestOpener: "Can we help with the next cleanup?",
      likelyObjections: ["Already have a provider", "Not needed today"],
      recommendedNextMove: "Call the contact",
      partnerFit: "managed_direct",
      fitScore: 64,
      fitReason: "Existing relationship",
      provider: "fallback",
      model: null,
      updatedAt: "2025-01-01T12:00:00.000Z",
    };
    const result = await load();
    expect(result?.brief).toEqual(storedBrief);
    expectReadOnly();
  });

  it("does not infer or create a partner company for a contact-only prospect", async () => {
    expect(await load(`contact:${ACCOUNT_ID}`)).toBeNull();
    expect(mockDb.select).not.toHaveBeenCalled();
    expectReadOnly();
  });

  it("does not fall back to another account when selection is unavailable", async () => {
    expect(
      await load(
        `account:${ACCOUNT_ID}`,
        "22222222-2222-4222-8222-222222222222",
      ),
    ).toBeNull();
    expect(mockDb.select).not.toHaveBeenCalled();
    expectReadOnly();
  });
});
