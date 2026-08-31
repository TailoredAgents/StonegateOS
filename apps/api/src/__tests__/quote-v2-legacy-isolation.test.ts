import fs from "node:fs";
import path from "node:path";

function source(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("Quote V2 legacy endpoint isolation", () => {
  it("keeps V2 aggregates out of both legacy list branches", () => {
    const route = source("app/api/quotes/route.ts");
    const legacyList = route.slice(
      route.indexOf("const statusParam"),
      route.indexOf("export async function POST"),
    );
    expect(legacyList).toContain('eq(quotes.engineVersion, "legacy")');
    expect(legacyList).toMatch(
      /statusFilter[\s\S]*eq\(quotes\.engineVersion, "legacy"\)[\s\S]*eq\(quotes\.status, statusFilter\)[\s\S]*baseQuery\.where\(eq\(quotes\.engineVersion, "legacy"\)\)/u,
    );
  });

  it.each([
    ["edit and delete", "app/api/quotes/[id]/route.ts"],
    ["send", "app/api/quotes/[id]/send/route.ts"],
    ["decision", "app/api/quotes/[id]/decision/route.ts"],
  ])(
    "rejects V2 before legacy %s mutations and binds CAS to the engine",
    (_, file) => {
      const route = source(file);
      expect(route).toContain("engineVersion: quotes.engineVersion");
      expect(route).toContain('existing.engineVersion !== "legacy"');
      expect(route).toContain('eq(quotes.engineVersion, "legacy")');
      expect(route).toMatch(/versioned quote must be/iu);
    },
  );

  it("guards legacy idempotency replay before reconstructing a bearer URL", () => {
    const route = source("app/api/quotes/[id]/send/route.ts");
    expect(
      route.indexOf('replayQuote?.engineVersion !== "legacy"'),
    ).toBeLessThan(route.indexOf("const replayShareUrl"));
  });

  it("retains the authenticated V2-first shared detail resolver", () => {
    const route = source("app/api/quotes/[id]/route.ts");
    expect(route).toContain("getQuoteV2StaffDetail(db, id)");
    expect(route).toContain("shareToken: null");
    expect(route).toContain(
      'and(eq(quotes.id, id), eq(quotes.engineVersion, "legacy"))',
    );
  });
});
