import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { closeDbForTests, getDb, partnerAccounts } from "@/db";
import { listPartnerManagementResource } from "@/lib/partner-management-directory";
import { parsePartnerManagementListQuery } from "@/lib/partner-management-list";

const local =
  process.env["DATABASE_URL"] &&
  ["localhost", "127.0.0.1"].includes(
    new URL(process.env["DATABASE_URL"]).hostname,
  );
const suite = local ? describe : describe.skip;

suite("exact company lookup in local PostgreSQL", () => {
  const prefix = `Company lookup ${randomUUID()}`;
  const ids = Array.from({ length: 102 }, () => randomUUID());
  beforeAll(async () => {
    await getDb()
      .insert(partnerAccounts)
      .values(
        ids.map((id, index) => ({
          id,
          name: `${prefix} ${index}`,
          normalizedName: `${prefix.toLowerCase()} ${index}`,
          createdAt: new Date(Date.UTC(2020, 0, index + 1)),
        })),
      );
  });
  afterAll(async () => {
    await getDb()
      .delete(partnerAccounts)
      .where(inArray(partnerAccounts.id, ids));
    await closeDbForTests();
  });

  it("opens an explicitly selected company beyond the first 100 without matching by name", async () => {
    const first = await listPartnerManagementResource(
      "accounts",
      parsePartnerManagementListQuery(
        new URLSearchParams({ q: prefix, limit: "100" }),
        "accounts",
      ),
    );
    expect(first.items).toHaveLength(100);
    expect(first.page.hasMore).toBe(true);
    expect(first.items.some((item) => item.id === ids[0])).toBe(false);
    const exact = await listPartnerManagementResource(
      "accounts",
      parsePartnerManagementListQuery(
        new URLSearchParams({ accountId: ids[0]!, limit: "1" }),
        "accounts",
      ),
    );
    expect(exact.items).toHaveLength(1);
    expect(exact.items[0]).toMatchObject({ id: ids[0], name: `${prefix} 0` });
    expect(exact.page.hasMore).toBe(false);
  });

  it("does not replace an unavailable company with another directory result", async () => {
    const result = await listPartnerManagementResource(
      "accounts",
      parsePartnerManagementListQuery(
        new URLSearchParams({ accountId: randomUUID(), limit: "1" }),
        "accounts",
      ),
    );
    expect(result.items).toEqual([]);
    expect(result.page.nextCursor).toBeNull();
  });

  it("rejects a global directory cursor on an exact company lookup", async () => {
    const first = await listPartnerManagementResource(
      "accounts",
      parsePartnerManagementListQuery(
        new URLSearchParams({ q: prefix, limit: "1" }),
        "accounts",
      ),
    );
    expect(first.page.nextCursor).toEqual(expect.any(String));
    expect(() =>
      parsePartnerManagementListQuery(
        new URLSearchParams({
          accountId: ids[0]!,
          limit: "1",
          cursor: first.page.nextCursor!,
        }),
        "accounts",
      ),
    ).toThrow("different list or filter set");
  });
});
