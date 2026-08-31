import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseAgentOperationalMutationResult } from "@myst-os/sdk";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Quote V2 legacy creation adapter", () => {
  const route = source("app/api/admin/tools/quote/route.ts");
  const chat = source("../site/src/app/api/chat/route.ts");
  const quoteActionServices = source(
    "../site/src/app/api/chat/quote-action-services.ts",
  );

  it("delegates the old admin/chat surface to the canonical V2 draft services", () => {
    expect(route).toContain("createQuoteV2Draft(tx");
    expect(route).toContain("saveQuoteV2Draft(tx");
    expect(route).toContain('confirmation: "create_quote_v2"');
    expect(route).toContain('confirmation: "save_quote_draft"');
    expect(route).not.toContain(".insert(quotes)");
    expect(route).not.toContain("shareToken");
    expect(route).not.toContain('engineVersion: "legacy"');
  });

  it("uses bounded strict input, a human principal, idempotency, audit, and canonical CAS", () => {
    expect(route).toContain("readBoundedJsonRequest");
    expect(route).toContain(".strict()");
    expect(route).toContain('principalTypes: ["human"]');
    expect(route).toContain("requiresIdempotency: true");
    expect(route).toContain("claimTeamMutationIdempotency");
    expect(route).toContain("completeTeamMutationIdempotency");
    expect(route).toContain("mutation.audit.insertSuccess");
    expect(route).toContain("expectedDraftRevision: created.draftRevision");
    expect(route).toContain('isQuoteV2FeatureEnabled("staff")');
  });

  it("rejects unknown/duplicate services and leaves default-zone drafts unconfirmed", () => {
    expect(route).toContain('"unknown_service"');
    expect(route).toContain('"duplicate_service"');
    expect(route).toContain(
      "candidates.some((service) => !SERVICE_IDS.has(service))",
    );
    expect(route).toContain(
      "serviceZoneConfirmed: Boolean(parsed.data.zoneId)",
    );
    expect(route).toContain("Review it in Quotes before issuing.");
    expect(route).toContain('candidates.includes("other")');
    expect(chat).not.toContain(
      '{ id: "other", patterns: [/quote/i, /estimate/i] }',
    );
    expect(chat).not.toContain('services.push("other")');
    expect(chat).toContain(
      "if (!areCanonicalQuoteServicesActionable(services)) return null",
    );
    expect(chat).toContain(
      'parseAgentActionPayload("create_quote", action.payload)',
    );
    expect(quoteActionServices).toContain("Unknown hints are discarded");
    expect(quoteActionServices).not.toContain("services.push(hint.trim())");
  });

  it("keeps internal notes out of scope and returns an Agent-verifiable ISO receipt", () => {
    expect(route).toContain("internalNotes: parsed.data.notes ?? null");
    expect(route).not.toContain("scope:\n          parsed.data.notes");
    expect(route).toContain("updatedAt: quoteVersions.updatedAt");
    expect(route).toContain("version: recordVersion");

    const quoteId = "11111111-1111-4111-8111-111111111111";
    const actorId = "22222222-2222-4222-8222-222222222222";
    const version = "2026-08-31T12:00:00.000Z";
    expect(
      parseAgentOperationalMutationResult(
        "create_quote",
        {
          ok: true,
          data: {
            ok: true,
            quoteId,
            version,
            engineVersion: "v2",
            state: "draft",
          },
          receipt: {
            operationId: "33333333-3333-4333-8333-333333333333",
            correlationId: "quote-v2-adapter-test",
            actorId,
            committedAt: version,
            auditEventId: "44444444-4444-4444-8444-444444444444",
            entityType: "quote",
            entityId: quoteId,
            version,
          },
        },
        { actorId },
      ),
    ).toMatchObject({
      ok: true,
      descriptor: { entityType: "quote", entityId: quoteId, version },
    });
  });
});
