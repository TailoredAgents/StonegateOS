import { readFileSync } from "node:fs";
import path from "node:path";
import {
  encodeExpenseHistoryCursor,
  parseExpenseHistoryQuery,
} from "@/lib/expense-submission-history";

const submissionsRoute = readFileSync(
  path.join(process.cwd(), "app/api/admin/expenses/submissions/route.ts"),
  "utf8",
);

describe("expense submission history pagination", () => {
  const cursor = {
    filter: "pending" as const,
    ownerQueue: true,
    pendingRank: 0 as const,
    paidAt: new Date("2026-08-25T16:00:00.000Z"),
    createdAt: new Date("2026-08-25T18:30:00.000Z"),
    id: "11111111-1111-4111-8111-111111111111",
  };

  it("uses a bounded default page", () => {
    expect(parseExpenseHistoryQuery(new URLSearchParams(), false)).toEqual({
      filter: "all",
      limit: 40,
      cursor: null,
    });
  });

  it("accepts the focused dump-ticket cleanup filter", () => {
    expect(
      parseExpenseHistoryQuery(
        new URLSearchParams({ filter: "dump_tickets" }),
        true,
      ),
    ).toEqual({ filter: "dump_tickets", limit: 40, cursor: null });
  });

  it("gates the dump-ticket filter while keeping correction lineage explicit", () => {
    expect(submissionsRoute).toContain('query.filter === "dump_tickets" &&');
    expect(submissionsRoute).toContain("!isExpenseDumpTicketsEnabled()");
    expect(submissionsRoute).toContain(
      "reversalOfExpenseId: row.reversalOfExpenseId",
    );
    expect(submissionsRoute).toContain(
      "correctionOfExpenseId: row.correctionOfExpenseId",
    );
    expect(submissionsRoute).toContain(
      "correctedByExpenseId: row.correctedByExpenseId",
    );
  });

  it("round-trips a cursor bound to its filter and owner scope", () => {
    const encoded = encodeExpenseHistoryCursor(cursor);
    expect(
      parseExpenseHistoryQuery(
        new URLSearchParams({
          filter: "pending",
          limit: "25",
          cursor: encoded,
        }),
        true,
      ),
    ).toEqual({ filter: "pending", limit: 25, cursor });
  });

  it.each([
    ["different filter", false, "all"],
    ["different access scope", false, "pending"],
  ])("rejects a cursor used with a %s", (_label, ownerQueue, filter) => {
    expect(() =>
      parseExpenseHistoryQuery(
        new URLSearchParams({
          filter,
          cursor: encodeExpenseHistoryCursor(cursor),
        }),
        ownerQueue,
      ),
    ).toThrow("Refresh expense history");
  });

  it.each(["0", "101", "1.5", "lots"])("rejects invalid limit %s", (limit) => {
    expect(() =>
      parseExpenseHistoryQuery(new URLSearchParams({ limit }), false),
    ).toThrow("Use a history page size");
  });
});
