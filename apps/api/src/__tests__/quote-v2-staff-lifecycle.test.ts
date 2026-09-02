import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  QuoteV2ArchiveCommandSchema,
  QuoteV2ChangeResolutionCommandSchema,
  QuoteV2StaffDecisionCommandSchema,
  QuoteV2VoidCommandSchema,
} from "@/lib/quote-v2-contract";
import { quoteV2LifecycleOpportunityTarget } from "@/lib/quote-v2-staff-lifecycle";

const QUOTE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const REPLACEMENT_ID = "33333333-3333-4333-8333-333333333333";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Quote V2 staff lifecycle contracts", () => {
  it("binds staff acceptance to the exact quote and version with explicit evidence", () => {
    const parsed = QuoteV2StaffDecisionCommandSchema.parse({
      confirmation: "record_quote_v2_decision",
      quoteId: QUOTE_ID,
      versionId: VERSION_ID,
      quoteRevision: 4,
      decision: "accepted",
      source: "phone",
      notes: "Customer approved during the recorded call.",
      signer: {
        name: "Avery Client",
        title: "Facilities Director",
        company: "Avery Industries",
        authorityAffirmed: true,
      },
      consentVersion: "commercial-fixed-v1",
      consentAffirmed: true,
    });

    expect(parsed).toEqual(
      expect.objectContaining({
        quoteId: QUOTE_ID,
        versionId: VERSION_ID,
        selectedOptionIds: [],
        notifyCustomer: false,
      }),
    );
    expect(
      QuoteV2StaffDecisionCommandSchema.safeParse({
        ...parsed,
        versionId: undefined,
      }).success,
    ).toBe(false);
    expect(
      QuoteV2StaffDecisionCommandSchema.safeParse({
        ...parsed,
        signer: { ...parsed.signer, authorityAffirmed: false },
      }).success,
    ).toBe(false);
  });

  it("requires an exact resulting version for either change resolution path", () => {
    const revision = QuoteV2ChangeResolutionCommandSchema.parse({
      confirmation: "resolve_quote_change_request",
      quoteId: QUOTE_ID,
      quoteVersionId: VERSION_ID,
      quoteRevision: 8,
      resolution: "revision",
      replacementVersionId: REPLACEMENT_ID,
      resolutionNote: "Published the requested scope correction.",
    });
    const unchanged = QuoteV2ChangeResolutionCommandSchema.parse({
      confirmation: "resolve_quote_change_request",
      quoteId: QUOTE_ID,
      quoteVersionId: VERSION_ID,
      quoteRevision: 8,
      resolution: "reopen_unchanged",
      resolutionNote: "Confirmed the existing scope with the customer.",
      notifyCustomer: true,
    });

    expect(revision).toEqual(
      expect.objectContaining({ replacementVersionId: REPLACEMENT_ID }),
    );
    expect(unchanged).toEqual(
      expect.objectContaining({
        quoteVersionId: VERSION_ID,
        notifyCustomer: true,
      }),
    );
    expect(
      QuoteV2ChangeResolutionCommandSchema.safeParse({
        ...revision,
        replacementVersionId: undefined,
      }).success,
    ).toBe(false);
  });

  it("requires exact current-version confirmation for void and archive", () => {
    const base = {
      versionId: VERSION_ID,
      quoteRevision: 3,
      reason: "Project was cancelled by the owner.",
    };
    expect(
      QuoteV2VoidCommandSchema.parse({
        ...base,
        confirmation: "void_quote_v2",
      }),
    ).toEqual(expect.objectContaining({ notifyCustomer: false }));
    expect(
      QuoteV2ArchiveCommandSchema.parse({
        ...base,
        confirmation: "archive_quote_v2",
      }),
    ).toEqual(expect.objectContaining({ notifyCustomer: false }));
  });
});

describe("Quote V2 staff lifecycle monotonicity", () => {
  it("advances approval and closes decline/void only when no proposal remains", () => {
    expect(
      quoteV2LifecycleOpportunityTarget({
        operation: "accept",
        currentStatus: "open",
        hasOtherRelevantQuote: false,
      }),
    ).toEqual({ status: "approved", pipelineStage: "approved", closes: false });
    expect(
      quoteV2LifecycleOpportunityTarget({
        operation: "decline",
        currentStatus: "open",
        hasOtherRelevantQuote: true,
      }),
    ).toEqual({ status: "open", pipelineStage: "quoted", closes: false });
    expect(
      quoteV2LifecycleOpportunityTarget({
        operation: "void",
        currentStatus: "open",
        hasOtherRelevantQuote: false,
      }),
    ).toEqual({ status: "lost", pipelineStage: "lost", closes: true });
  });

  it("archives the opportunity only after its final non-archived quote", () => {
    expect(
      quoteV2LifecycleOpportunityTarget({
        operation: "archive",
        currentStatus: "won",
        hasOtherRelevantQuote: true,
      }),
    ).toEqual({ status: "won", closes: false });
    expect(
      quoteV2LifecycleOpportunityTarget({
        operation: "archive",
        currentStatus: "lost",
        hasOtherRelevantQuote: false,
      }),
    ).toEqual({ status: "archived", pipelineStage: "archived", closes: true });
  });
});

describe("Quote V2 staff lifecycle persistence boundaries", () => {
  const lifecycle = source("src/lib/quote-v2-staff-lifecycle.ts");
  const terminal = source("src/lib/quote-v2-terminal-decision.ts");
  const route = source("src/lib/quote-v2-staff-lifecycle-route.ts");
  const migration = source(
    "src/db/migrations/0124_quote_v2_change_resolution.sql",
  );

  it("uses CAS, immutable response evidence, ID-only V2 outbox, and no token fields", () => {
    expect(lifecycle).toContain("command.versionId !== input.versionId");
    expect(lifecycle).toContain("prepareQuoteV2AcceptanceEvidence");
    expect(lifecycle).toContain(
      "issuedPdfHash: acceptedEvidence.issuedPdfHash",
    );
    expect(lifecycle).toContain("persistQuoteV2TerminalDecision");
    expect(terminal).toContain('type: "quote.response_recorded.v2"');
    expect(terminal).toContain(
      "eq(quotes.aggregateRevision, context.quoteRevision)",
    );
    const eventStart = terminal.indexOf(
      "async function insertResponseOutboxEvent",
    );
    const eventEnd = terminal.indexOf(
      "function centsToLegacyNumeric",
      eventStart,
    );
    const eventSource = terminal.slice(eventStart, eventEnd);
    expect(eventSource).not.toMatch(/token|email|phone|address|signer|notes/iu);
  });

  it("requires a human updater, idempotency, If-Match CAS, and send permission only for opt-in notification", () => {
    expect(route).toContain('principalTypes: ["human"]');
    expect(route).toContain('requiredPermissions: ["quotes.update"]');
    expect(route).toContain("requiresIdempotency: true");
    expect(route).toContain(
      'requiredPermissions: ["quotes.update", "quotes.send"]',
    );
    expect(route).toContain("parsed.data.notifyCustomer === true");
    expect(route).toContain(
      "expectedQuoteRevision !== parsed.data.quoteRevision",
    );
    expect(route).toContain("claimTeamMutationIdempotency");
  });

  it("persists exact resolution evidence and prevents duplicate or regressive requests", () => {
    expect(migration).toContain('ADD COLUMN "resolution_kind" text');
    expect(migration).toContain('ADD COLUMN "resulting_version_id" uuid');
    expect(migration).toContain(
      'FOREIGN KEY ("resulting_version_id", "quote_id")',
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "quote_change_requests_actionable_quote_key"',
    );
    expect(migration).toContain('ON "quote_change_requests" ("quote_id")');
    expect(migration).toContain(
      "terminal quote change request evidence is immutable",
    );
    expect(migration).toContain("illegal quote change request transition");
    expect(lifecycle).toContain("resolutionKind: command.resolution");
    expect(lifecycle).toContain("resultingVersionId: resulting.id");
  });

  it("registers resolution migration 0124 after the existing 0122 and 0123 work", () => {
    const journal = JSON.parse(
      source("src/db/migrations/meta/_journal.json"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    const attachmentIndex = journal.entries.findIndex(
      (entry) => entry.tag === "0122_quote_v2_attachment_purpose",
    );
    expect(journal.entries.slice(attachmentIndex, attachmentIndex + 5)).toEqual(
      [
        {
          idx: 119,
          version: "7",
          when: 1791417600000,
          tag: "0122_quote_v2_attachment_purpose",
          breakpoints: true,
        },
        {
          idx: 120,
          version: "7",
          when: 1791504000000,
          tag: "0123_partner_access_application_tenant_binding",
          breakpoints: true,
        },
        {
          idx: 121,
          version: "7",
          when: 1791590400000,
          tag: "0124_quote_v2_change_resolution",
          breakpoints: true,
        },
        {
          idx: 122,
          version: "7",
          when: 1791676800000,
          tag: "0125_quote_pdf_download_privacy",
          breakpoints: true,
        },
        {
          idx: 123,
          version: "7",
          when: 1791763200000,
          tag: "0126_quote_v2_engagement_retention",
          breakpoints: true,
        },
      ],
    );
  });

  it("exposes only quote-scoped lifecycle routes behind update permission", () => {
    for (const path of [
      "app/api/quotes/[id]/decisions/route.ts",
      "app/api/quotes/[id]/change-requests/[requestId]/resolve/route.ts",
      "app/api/quotes/[id]/void/route.ts",
      "app/api/quotes/[id]/archive/route.ts",
    ]) {
      const routeSource = source(path);
      expect(routeSource).toContain(
        'requirePermission(request, "quotes.update")',
      );
    }
    const bff = source(
      "../site/src/app/api/team/quotes/v2/[...segments]/route.ts",
    );
    expect(bff).toContain("/decisions`");
    expect(bff).toContain(
      "/change-requests/${encodeURIComponent(match[2])}/resolve`",
    );
    expect(bff).toContain("`^quotes/(${UUID})/(void|archive)$`");
  });
});
