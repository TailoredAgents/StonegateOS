import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isPublicQuoteMutationSuccessBody,
  normalizePublicQuoteIdempotencyKey,
  publicQuoteMutationKeyHash,
  publicQuoteMutationRequestHash,
} from "@/lib/public-quote-mutation";

const API_ROOT = process.cwd();

function source(relativePath: string): string {
  return readFileSync(join(API_ROOT, relativePath), "utf8");
}

describe("public quote mutation replay", () => {
  it("accepts bounded caller keys and rejects absent, short, or unsafe keys", () => {
    expect(normalizePublicQuoteIdempotencyKey(null)).toBeNull();
    expect(normalizePublicQuoteIdempotencyKey("too-short")).toBeNull();
    expect(
      normalizePublicQuoteIdempotencyKey("quote decision key with spaces"),
    ).toBeNull();
    expect(
      normalizePublicQuoteIdempotencyKey(" quote-decision:1234567890 "),
    ).toBe("quote-decision:1234567890");
    expect(
      normalizePublicQuoteIdempotencyKey(`q${"x".repeat(200)}`),
    ).toBeNull();
  });

  it("persists only a one-way key fingerprint", () => {
    const key = "quote-decision:caller-key-123";
    expect(publicQuoteMutationKeyHash(key)).toBe(
      createHash("sha256").update(key, "utf8").digest("hex"),
    );
    expect(publicQuoteMutationKeyHash(key)).not.toContain(key);
  });

  it("fingerprints normalized token-free action details deterministically", () => {
    const accepted = {
      action: "decision" as const,
      decision: "accepted" as const,
      reason: null,
      notes: "Looks good",
      quoteId: "11111111-1111-4111-8111-111111111111",
      expectedRevision: 3,
    };
    expect(publicQuoteMutationRequestHash(accepted)).toBe(
      publicQuoteMutationRequestHash({ ...accepted }),
    );
    expect(publicQuoteMutationRequestHash(accepted)).not.toBe(
      publicQuoteMutationRequestHash({
        ...accepted,
        decision: "declined",
      }),
    );
    expect(publicQuoteMutationRequestHash(accepted)).not.toBe(
      publicQuoteMutationRequestHash({
        ...accepted,
        expectedRevision: 4,
      }),
    );
  });

  it.each([
    [null, false],
    [{}, false],
    [{ ok: false, quoteId: "quote-1" }, false],
    [{ ok: true, quoteId: "" }, false],
    [{ ok: true, quoteId: "quote-1" }, true],
  ])("validates stored replay body %#", (value, expected) => {
    expect(isPublicQuoteMutationSuccessBody(value)).toBe(expected);
  });

  it("registers an additive, token-free receipt table and migration", () => {
    const migration = source(
      "src/db/migrations/0077_public_quote_mutation_receipts.sql",
    );
    const route = source("app/api/public/quotes/[token]/route.ts");
    const journal = JSON.parse(
      source("src/db/migrations/meta/_journal.json"),
    ) as { entries?: Array<{ idx?: number; tag?: string }> };

    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS "public_quote_mutation_receipts"',
    );
    expect(migration).toContain('"key_hash" varchar(64) NOT NULL');
    expect(migration).toContain('"request_hash" varchar(64) NOT NULL');
    expect(migration).not.toContain('"share_token"');
    expect(migration).toContain(
      "SET \"payload\" = \"payload\" - 'shareToken' - 'shareUrl'",
    );
    expect(journal.entries).toContainEqual(
      expect.objectContaining({
        idx: 74,
        tag: "0077_public_quote_mutation_receipts",
      }),
    );
    expect(route).toContain("idempotency-replayed");
    expect(route).toContain("receipt.requestHash !== requestHash");
    expect(route).toContain("receipt.expiresAt.getTime() <= Date.now()");
  });
});
