import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PublicQuoteRefreshCommandSchema } from "@/lib/quote-v2-contract";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Quote V2 expired proposal update boundary", () => {
  it("accepts only an exact version-bound, bounded refresh command", () => {
    const valid = {
      quoteId: "11111111-1111-4111-8111-111111111111",
      versionId: "22222222-2222-4222-8222-222222222222",
      message: "Please update the proposed timing.",
    };
    expect(PublicQuoteRefreshCommandSchema.parse(valid)).toEqual(valid);
    expect(() =>
      PublicQuoteRefreshCommandSchema.parse({
        ...valid,
        versionId: "not-a-version",
      }),
    ).toThrow();
    expect(() =>
      PublicQuoteRefreshCommandSchema.parse({
        ...valid,
        message: "x".repeat(2_001),
      }),
    ).toThrow();
    expect(() =>
      PublicQuoteRefreshCommandSchema.parse({ ...valid, token: "secret" }),
    ).toThrow();
  });

  it("enforces signer-only refresh grants and change-request evidence in the additive migration", () => {
    const migration = source(
      "src/db/migrations/0128_quote_v2_expired_refresh_request.sql",
    );
    expect(migration).toContain("quote_capabilities_actions_check");
    expect(migration).toContain("'change', 'refresh', 'accept'");
    expect(migration).toContain("\"recipient_role\" = 'signer'");
    expect(migration).toContain("'change_requested', 'refresh_requested'");
    expect(migration).toContain('"change_request_id" IS NOT NULL');
    expect(migration).toContain(
      '"allowed_actions" = array_append("capability"."allowed_actions", \'refresh\')',
    );
    expect(migration).toContain(
      '"version"."provenance" = \'legacy_current_state\'',
    );
    expect(migration).toContain(
      '"quote"."current_version_id" = "version"."id"',
    );
    expect(migration).toContain(
      '"quote"."published_version_id" = "version"."id"',
    );
    expect(migration).toContain(
      '"version"."document_snapshot" #>> \'{lifecycle,refreshRequestedAt}\' IS NULL',
    );
    expect(migration).toContain('"contact"."deleted_at" IS NULL');
    expect(migration).toContain(
      "'accepted', 'declined', 'change_requested', 'refresh_requested'",
    );
    expect(migration).toContain("NOT VALID");
    expect(migration).toContain("VALIDATE CONSTRAINT");
    const journal = JSON.parse(
      source("src/db/migrations/meta/_journal.json"),
    ) as { entries?: Array<{ idx?: number; tag?: string }> };
    expect(journal.entries).toContainEqual(
      expect.objectContaining({
        idx: 125,
        tag: "0128_quote_v2_expired_refresh_request",
      }),
    );
  });

  it("locks and checks the exact current/published version before one canonical workflow write", () => {
    const service = source("src/lib/quote-v2-public-service.ts");
    expect(service).toContain("currentVersionId: quotes.currentVersionId");
    expect(service).toContain("publishedVersionId: quotes.publishedVersionId");
    const start = service.indexOf("recordQuoteV2RefreshRequest");
    const end = service.indexOf("recordQuoteV2Decision", start);
    const branch = service.slice(start, end);
    expect(branch).toContain("lock: true");
    expect(branch.indexOf("assertBoundCapability")).toBeLessThan(
      branch.indexOf("findReplay"),
    );
    expect(branch.indexOf("findReplay")).toBeLessThan(
      branch.indexOf("assertRefreshAction"),
    );
    expect(branch).toContain('responseType: "refresh_requested"');
    expect(branch).toContain('reason: "expired_refresh"');
    expect(branch).toContain('eventType: "refresh_requested"');
    expect(branch.indexOf(".insert(crmTasks)")).toBeLessThan(
      branch.indexOf(".insert(quoteChangeRequests)"),
    );
    expect(branch.indexOf(".insert(quoteChangeRequests)")).toBeLessThan(
      branch.indexOf(".insert(quoteResponses)"),
    );
    expect(branch).toContain("eq(quotes.currentVersionId, row.versionId)");
    expect(branch).toContain("eq(quotes.publishedVersionId, row.versionId)");
    expect(branch).not.toContain(".update(quoteVersions)");
  });

  it("authorizes and capability-binds every response replay before reading its receipt", () => {
    const service = source("src/lib/quote-v2-public-service.ts");
    const branches = [
      service.slice(
        service.indexOf("recordQuoteV2ChangeRequest"),
        service.indexOf("recordQuoteV2RefreshRequest"),
      ),
      service.slice(
        service.indexOf("recordQuoteV2RefreshRequest"),
        service.indexOf("recordQuoteV2Decision"),
      ),
      service.slice(service.indexOf("recordQuoteV2Decision")),
    ];
    for (const branch of branches) {
      expect(branch.indexOf("assertBoundCapability")).toBeLessThan(
        branch.indexOf("assertPublicMutationAccess"),
      );
      expect(branch.indexOf("assertPublicMutationAccess")).toBeLessThan(
        branch.indexOf("findReplay"),
      );
      expect(branch).toContain("capabilityId: row.capabilityId");
    }
    const replayStart = service.indexOf("async function findReplay");
    const replayEnd = service.indexOf(
      "async function insertV2OutboxEvent",
      replayStart,
    );
    const replay = service.slice(replayStart, replayEnd);
    expect(replay).toContain(
      "priorCapabilityId(existing) !== input.capabilityId",
    );
    const accessStart = service.indexOf("function assertPublicMutationAccess");
    const accessEnd = service.indexOf("function priorRequestHash", accessStart);
    const access = service.slice(accessStart, accessEnd);
    expect(access).toContain('row.capabilityStatus !== "active"');
    expect(access).toContain("row.revokedAt");
    expect(access).toContain("row.readExpiresAt <= now");
    expect(access).toContain("row.contactDeletedAt");
    expect(access).toContain('row.recipientRole !== "signer"');
    expect(access).toContain('row.allowedActions.includes("refresh")');
    expect(access).toContain('row.allowedActions.includes("change")');
  });

  it("routes through prelookup abuse controls and keeps the durable event token-free", () => {
    const route = source("app/api/public/quotes/[token]/refresh/route.ts");
    expect(route).toContain("maybeHandleQuoteV2PublicRefresh");
    const publicRoute = source("src/lib/quote-v2-public-route.ts");
    const start = publicRoute.indexOf("maybeHandleQuoteV2PublicRefresh");
    const end = publicRoute.indexOf("maybeHandleQuoteV2PublicDecision", start);
    const branch = publicRoute.slice(start, end);
    expect(branch).toContain("identifyMutationCapability");
    expect(branch).toContain('scope: "change"');
    expect(branch).toContain("PublicQuoteRefreshCommandSchema.safeParse");
    expect(branch).toContain("recordQuoteV2RefreshRequest");

    const service = source("src/lib/quote-v2-public-service.ts");
    const helperStart = service.indexOf("async function insertV2OutboxEvent");
    const payloadStart = service.indexOf("const payload = {", helperStart);
    const payloadEnd = service.indexOf(
      "};\n  parseQuoteV2OutboxEvent",
      payloadStart,
    );
    const payload = service.slice(payloadStart, payloadEnd);
    expect(payload).toContain("quoteId: input.quoteId");
    expect(payload).toContain("versionId: input.versionId");
    expect(payload).toContain("responseId: input.responseId");
    expect(payload).not.toMatch(/token|email|phone|address|signer|message/iu);
  });

  it("recognizes refresh responses in the durable change worker and exposes a recoverable customer CTA", () => {
    const worker = source("src/lib/quote-v2-outbox-worker.ts");
    expect(worker).toContain(
      '"change_requested",\n          "refresh_requested"',
    );
    const proxy = source(
      "../site/src/app/api/public/quotes/[token]/[[...segments]]/route.ts",
    );
    expect(proxy).toContain('"refresh"');
    const client = source(
      "../site/src/app/quote/[token]/quote-v2-public-client.ts",
    );
    expect(client).toContain(
      'requestUpdatedProposal: (body) => post("/refresh", "refresh", body)',
    );
    const component = source(
      "../site/src/app/quote/[token]/QuoteV2CustomerProposal.tsx",
    );
    expect(component).toContain("Request updated proposal");
    expect(component).toContain("This version will stay read-only");
    expect(component).toContain("value={refreshMessage}");
    expect(component).toContain("Your note stays here if sending fails.");
    expect(component).toContain("setRefreshRequested(true)");
  });
});
