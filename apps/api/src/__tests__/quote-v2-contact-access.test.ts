import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { requireActiveQuoteV2ContactForCapabilityMint } from "@/lib/quote-v2-contact-access";

const QUOTE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const CONTACT_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_CONTACT_ID = "44444444-4444-4444-8444-444444444444";
const WORKSPACE_ROOT = resolve(process.cwd(), "../..");

function source(path: string): string {
  return readFileSync(resolve(WORKSPACE_ROOT, path), "utf8");
}

function transactionWithRows(rows: Array<Array<Record<string, unknown>>>) {
  const events: string[] = [];
  let selectNumber = 0;
  let executeCount = 0;
  type QueryChain = {
    from: () => QueryChain;
    innerJoin: () => QueryChain;
    where: () => QueryChain;
    for: () => QueryChain;
    limit: () => Promise<Array<Record<string, unknown>>>;
  };
  const select = () => {
    const selectedRows = rows[selectNumber] ?? [];
    selectNumber += 1;
    events.push(`select:${selectNumber}`);
    const chain = {} as QueryChain;
    chain.from = () => chain;
    chain.innerJoin = () => chain;
    chain.where = () => chain;
    chain.for = () => chain;
    chain.limit = () => Promise.resolve(selectedRows);
    return chain;
  };
  const execute = () => {
    executeCount += 1;
    events.push("advisory-lock");
    return Promise.resolve();
  };
  return {
    tx: { select, execute },
    events,
    getExecuteCount: () => executeCount,
  };
}

describe("Quote V2 deleted-contact capability protection", () => {
  it("takes the per-contact advisory lock before the authoritative lifecycle read", async () => {
    const { tx, events, getExecuteCount } = transactionWithRows([
      [{ quoteId: QUOTE_ID, contactId: CONTACT_ID }],
      [{ quoteId: QUOTE_ID, contactId: CONTACT_ID, deletedAt: null }],
    ]);

    await expect(
      requireActiveQuoteV2ContactForCapabilityMint(tx as never, {
        quoteId: QUOTE_ID,
      }),
    ).resolves.toEqual({
      quoteId: QUOTE_ID,
      contactId: CONTACT_ID,
      deletedAt: null,
    });
    expect(events).toEqual(["select:1", "advisory-lock", "select:2"]);
    expect(getExecuteCount()).toBe(1);
  });

  it("resolves a version to its quote before taking the same contact lock", async () => {
    const { tx } = transactionWithRows([
      [{ quoteId: QUOTE_ID, contactId: CONTACT_ID }],
      [{ quoteId: QUOTE_ID, contactId: CONTACT_ID, deletedAt: null }],
    ]);

    await expect(
      requireActiveQuoteV2ContactForCapabilityMint(tx as never, {
        versionId: VERSION_ID,
      }),
    ).resolves.toMatchObject({ quoteId: QUOTE_ID, contactId: CONTACT_ID });
  });

  it("rejects a contact deleted before or during issue without returning access", async () => {
    const deletedAt = new Date("2026-08-31T12:00:00.000Z");
    const { tx } = transactionWithRows([
      [{ quoteId: QUOTE_ID, contactId: CONTACT_ID }],
      [{ quoteId: QUOTE_ID, contactId: CONTACT_ID, deletedAt }],
    ]);

    await expect(
      requireActiveQuoteV2ContactForCapabilityMint(tx as never, {
        quoteId: QUOTE_ID,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message:
        "This contact is in recovery. Restore it before creating a customer proposal link.",
    });
  });

  it("rejects a changed quote-to-contact binding instead of locking the wrong contact", async () => {
    const { tx } = transactionWithRows([
      [{ quoteId: QUOTE_ID, contactId: CONTACT_ID }],
      [
        {
          quoteId: QUOTE_ID,
          contactId: OTHER_CONTACT_ID,
          deletedAt: null,
        },
      ],
    ]);

    await expect(
      requireActiveQuoteV2ContactForCapabilityMint(tx as never, {
        quoteId: QUOTE_ID,
      }),
    ).rejects.toMatchObject({ code: "conflict", retryable: true });
  });

  it("runs the shared guard before every runtime capability-mint lock", () => {
    const issue = source("apps/api/src/lib/quote-v2-issue-persistence.ts");
    const replace = source(
      "apps/api/src/lib/quote-v2-capability-management.ts",
    );
    const resend = source("apps/api/src/lib/quote-v2-send-attempt-service.ts");
    const guard = "await requireActiveQuoteV2ContactForCapabilityMint";

    expect(issue.indexOf(guard)).toBeGreaterThan(0);
    expect(issue.indexOf(guard)).toBeLessThan(issue.indexOf("const [locked]"));
    expect(replace.indexOf(guard)).toBeGreaterThan(0);
    expect(replace.indexOf(guard)).toBeLessThan(
      replace.indexOf("await lockCapability"),
    );
    expect(resend.indexOf(guard)).toBeGreaterThan(0);
    expect(resend.indexOf(guard)).toBeLessThan(
      resend.indexOf("await loadLockedSendSource"),
    );
  });
});
