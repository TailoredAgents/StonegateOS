import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Quote engagement privacy", () => {
  it("never records raw network or browser headers in either PDF path", () => {
    const legacy = source("app/api/public/quotes/[token]/pdf/route.ts");
    const v2 = source("src/lib/quote-v2-public-route.ts");
    expect(legacy).not.toMatch(/x-forwarded-for|user-agent|ipAddress/iu);
    expect(v2).not.toMatch(/x-forwarded-for|user-agent|ipAddress/iu);
    expect(legacy).toContain(".insert(quotePdfDownloads)");
    expect(v2).toContain(".insert(quotePdfDownloads)");
  });

  it("erases historic raw values and makes privacy minimization invariant", () => {
    const migration = source(
      "src/db/migrations/0125_quote_pdf_download_privacy.sql",
    );
    const schema = source("src/db/schema.ts");
    expect(migration).toContain('SET "user_agent" = NULL');
    expect(migration).toContain('"ip_address" = NULL');
    expect(migration).toContain(
      'CHECK ("user_agent" IS NULL AND "ip_address" IS NULL)',
    );
    expect(schema).toContain('"quote_pdf_downloads_no_raw_client_data_check"');
    const journal = JSON.parse(
      source("src/db/migrations/meta/_journal.json"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries).toContainEqual(
      expect.objectContaining({
        idx: 122,
        tag: "0125_quote_pdf_download_privacy",
      }),
    );
  });

  it("records visible engagement with ID-only metadata after browser visibility", () => {
    const route = source("src/lib/quote-v2-public-route.ts");
    const component = source(
      "../site/src/app/quote/[token]/QuoteV2CustomerProposal.tsx",
    );
    expect(route).toContain("quoteVisibleEngagementEvents");
    expect(route).toContain("capabilityId: capability.capabilityId");
    expect(route).toContain("idempotencyKeyHash: idempotency.hash");
    expect(route).toContain("visibleMsBucket:");
    expect(route).not.toContain("quoteActivityEvents");
    expect(component).toContain("visibleMs: 1_500");
    expect(component).toContain("globalThis.document.visibilityState");
  });
});
