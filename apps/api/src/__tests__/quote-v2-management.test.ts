import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  decodeQuoteV2ListCursor,
  encodeQuoteV2ListCursor,
  parseQuoteV2ListQuery,
  quoteV2ListFilterHash,
  quoteV2ListCursorPredicate,
} from "@/lib/quote-v2-management";

const API_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function source(relativePath: string): string {
  return fs.readFileSync(path.resolve(API_ROOT, relativePath), "utf8");
}

describe("Quote V2 staff management", () => {
  it("parses a bounded V2 list query and binds its cursor to every filter", () => {
    const first = parseQuoteV2ListQuery(
      new URLSearchParams({
        engine: "v2",
        bucket: "awaiting_client",
        search: "Acme",
        ownerId: "11111111-1111-4111-8111-111111111111",
        sort: "updated_desc",
        limit: "25",
      }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const cursor = encodeQuoteV2ListCursor({
      version: 1,
      filterHash: quoteV2ListFilterHash(first.query),
      sort: first.query.sort,
      primary: "2026-08-30T18:30:00.000Z",
      secondary: "2026-08-30T18:30:00.000Z",
      id: "22222222-2222-4222-8222-222222222222",
    });
    expect(decodeQuoteV2ListCursor(cursor, first.query)).toEqual(
      expect.objectContaining({ id: "22222222-2222-4222-8222-222222222222" }),
    );

    const changed = parseQuoteV2ListQuery(
      new URLSearchParams({
        engine: "v2",
        bucket: "drafts",
        search: "Acme",
        ownerId: "11111111-1111-4111-8111-111111111111",
        sort: "updated_desc",
        limit: "25",
        cursor,
      }),
    );
    expect(changed).toEqual({
      ok: false,
      fieldErrors: {
        cursor: "This quote page is stale. Return to the first page.",
      },
    });
  });

  it("rejects duplicate, unknown, oversized, and non-canonical pagination input", () => {
    const duplicate = new URLSearchParams("engine=v2&limit=20&limit=40");
    expect(parseQuoteV2ListQuery(duplicate)).toEqual({
      ok: false,
      fieldErrors: { limit: "Provide this filter only once." },
    });
    expect(
      parseQuoteV2ListQuery(
        new URLSearchParams("engine=v2&include=capabilities"),
      ),
    ).toEqual({
      ok: false,
      fieldErrors: { include: "This filter is not supported." },
    });
    expect(
      parseQuoteV2ListQuery(
        new URLSearchParams(`engine=v2&cursor=${"x".repeat(501)}`),
      ),
    ).toEqual(expect.objectContaining({ ok: false }));
  });

  it("binds canonical cursor instants as strings with explicit PostgreSQL casts", () => {
    const dialect = new PgDialect();
    const instant = "2026-08-30T18:30:00.000Z";
    const id = "22222222-2222-4222-8222-222222222222";

    for (const [sort, primary] of [
      ["updated_desc", instant],
      ["expiry_asc", instant],
      ["total_desc", 125_000],
      ["next_action", 20],
    ] as const) {
      const parsed = parseQuoteV2ListQuery(
        new URLSearchParams({ engine: "v2", sort }),
      );
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      const predicate = quoteV2ListCursorPredicate(parsed.query, {
        version: 1,
        filterHash: quoteV2ListFilterHash(parsed.query),
        sort,
        primary,
        secondary: instant,
        id,
      });
      expect(predicate).toBeDefined();
      const built = dialect.sqlToQuery(predicate!);
      expect(built.sql).toContain("::timestamptz");
      expect(built.params).toContain(instant);
      expect(built.params.some((value) => value instanceof Date)).toBe(false);
    }
  });

  it("keeps list/preview secret-blind while detail exposes only capability lifecycle metadata", () => {
    const management = source("src/lib/quote-v2-management.ts");
    for (const forbidden of [
      "tokenHash",
      "recipientAddressHash",
      "encryptedProviderPayload",
      "storageObjectKey",
      "storageBucket",
    ]) {
      expect(management).not.toContain(forbidden);
    }
    expect(management).toContain("recipientDisplayHint");
    expect(management).toContain("documentSnapshot");
    expect(management).toContain("issuedPdfHash");
    expect(management).toContain("capabilities: capabilities.map");
    expect(management).toContain(
      "allowedActions: quoteCapabilities.allowedActions",
    );
  });

  it("returns durable change-request ownership and exact resolution evidence", () => {
    const management = source("src/lib/quote-v2-management.ts");
    for (const field of [
      "ownerTaskId: quoteChangeRequests.ownerTaskId",
      "dueAt: quoteChangeRequests.dueAt",
      "resolutionKind: quoteChangeRequests.resolutionKind",
      "resultingVersionId: quoteChangeRequests.resultingVersionId",
      "resolvedByTeamMemberId:",
      "resolvedBy: resolvedByTeamMemberId",
    ]) {
      expect(management).toContain(field);
    }
    expect(management).toContain("dueAt: iso(change.dueAt)");
  });

  it("clones the issued snapshot into a draft without superseding it early", () => {
    const management = source("src/lib/quote-v2-management.ts");
    const revisionStart = management.indexOf(
      "export async function createQuoteV2Revision",
    );
    const revisionSource = management.slice(revisionStart);
    expect(revisionSource).toContain("supersedesVersionId: source.id");
    expect(revisionSource).toContain('state: "draft"');
    expect(revisionSource).toContain(
      "documentSnapshot: source.documentSnapshot",
    );
    expect(revisionSource).toContain("publishedVersionId, source.id");
    expect(revisionSource).not.toContain('state: "superseded"');

    const issue = source("src/lib/quote-v2-issue-persistence.ts");
    expect(issue).toContain('state: "superseded"');
    expect(issue).toContain('allowedActions: ["view", "pdf"]');
    expect(issue).toContain("previousPublishedVersionId");
  });

  it("requires permission, CAS, idempotency, and audit at the revision route", () => {
    const route = source("app/api/quotes/[id]/revisions/route.ts");
    expect(route).toContain('requiredPermissions: ["quotes.update"]');
    expect(route).toContain("requiresIdempotency: true");
    expect(route).toContain("mutation.expectedVersion");
    expect(route).toContain("claimTeamMutationIdempotency");
    expect(route).toContain("mutation.audit.insertSuccess");
  });
});
