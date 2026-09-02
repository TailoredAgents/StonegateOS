import fs from "node:fs";
import path from "node:path";

const apiRoot = path.resolve(process.cwd());

function source(relativePath: string): string {
  return fs.readFileSync(path.join(apiRoot, relativePath), "utf8");
}

describe("partner portal V2 commercial route guards", () => {
  it.each([
    ["invoices", "invoices.read"],
    ["statements", "invoices.read"],
    ["documents", "documents.financial.read"],
    ["reports", "reports.financial.read"],
  ])("binds %s reads to their account capability", (resource, capability) => {
    const route = source(`app/api/portal/v2/${resource}/route.ts`);
    expect(route).toContain(`capability: "${capability}"`);
    expect(route).toContain("handlePartnerCommercialList");
  });

  it("uses canonical Quote V2 authority while preserving legacy snapshots as non-actionable", () => {
    const listRoute = source("app/api/portal/v2/quotes/route.ts");
    const detailRoute = source(
      "app/api/portal/v2/quotes/[partnerQuoteId]/route.ts",
    );
    const decisionRoute = source(
      "app/api/portal/v2/quotes/[partnerQuoteId]/decision/route.ts",
    );
    const documentRoute = source(
      "app/api/portal/v2/quotes/[partnerQuoteId]/document/route.ts",
    );
    const service = source("src/lib/partner-portal-v2-quotes.ts");
    expect(listRoute).toContain(
      'requirePartnerCapability(request, "quotes.read")',
    );
    expect(listRoute).toContain("listCanonicalPartnerQuotes");
    expect(detailRoute).toContain(
      'requirePartnerCapability(request, "quotes.read")',
    );
    expect(documentRoute).toContain(
      'requirePartnerCapability(request, "quotes.read")',
    );
    expect(decisionRoute).toContain("requireRecentPartnerMfaCapability");
    expect(decisionRoute).toContain('"quotes.respond"');
    expect(decisionRoute).toContain("isAllowedPartnerPortalMutationOrigin");
    expect(decisionRoute).toContain("readPortalV2IdempotencyKey");
    expect(decisionRoute).toContain('request.headers.get("if-match")');
    expect(service).toContain('authority: "legacy_snapshot"');
    expect(service).toContain("actionable: false");
    expect(service).toContain('authority: "quote_v2"');
    expect(service).toContain("persistQuoteV2TerminalDecision");
    expect(listRoute).not.toContain("handlePartnerCommercialList");
  });

  it("uses one terminal decision core for public, Staff, and Partner actors", () => {
    const terminal = source("src/lib/quote-v2-terminal-decision.ts");
    const publicService = source("src/lib/quote-v2-public-service.ts");
    const staffService = source("src/lib/quote-v2-staff-lifecycle.ts");
    const partnerService = source("src/lib/partner-portal-v2-quotes.ts");
    expect(terminal).toContain("Sole canonical terminal transition");
    expect(terminal).toContain(".insert(quoteResponses)");
    for (const actorService of [publicService, staffService, partnerService]) {
      expect(actorService).toContain("persistQuoteV2TerminalDecision");
    }
    expect(partnerService).toContain("requestHash: input.requestHash");
    expect(partnerService).toContain("headers: { ETag: replayEtag }");
    expect(partnerService).toContain("isUniqueViolation(error)");
  });

  it("binds Staff-created Partner quotes to one account-owned target", () => {
    const contract = source("src/lib/quote-v2-contract.ts");
    const createService = source("src/lib/quote-v2-staff-service.ts");
    const contextService = source("src/lib/partner-quote-v2-staff-context.ts");
    const contextRoute = source(
      "app/api/admin/partner-management/v1/accounts/[accountId]/quote-context/route.ts",
    );
    expect(contract).toContain("partnerContext");
    expect(createService).toContain("validatePartnerQuoteContext");
    expect(createService).toContain(".insert(partnerQuotes)");
    expect(createService).toContain('authority: "quote_v2"');
    expect(contextService).toContain("contacts.partnerAccountId");
    expect(contextService).toContain(
      "partnerAccountLocations.partnerAccountId",
    );
    expect(contextRoute).toContain('"partners.commercial.read"');
    expect(contextRoute).toContain('"quotes.write"');
    expect(contextRoute).toContain(
      '"Cache-Control": "private, no-store, max-age=0"',
    );
  });

  it("keeps Partner approval evidence exact and account-bound", () => {
    const service = source("src/lib/partner-portal-v2-quotes.ts");
    const publicService = source("src/lib/quote-v2-public-service.ts");
    const staffService = source("src/lib/quote-v2-staff-lifecycle.ts");
    const approval = source("src/lib/partner-quote-v2-approval.ts");
    const authorityMigration = source(
      "src/db/migrations/0151_partner_quote_v2_authority.sql",
    );
    const responseBindingMigration = source(
      "src/db/migrations/0153_partner_quote_response_account_binding.sql",
    );
    for (const actorService of [service, publicService, staffService]) {
      expect(actorService).toContain("partnerQuoteApprovalAllowsAcceptance");
    }
    expect(approval).toContain("resolvePartnerApprovalRequirement");
    expect(approval).toContain("loadTargetContext");
    expect(approval).toContain("partnerQuoteApprovalEvidenceMatches");
    expect(approval).toContain("partnerBookings.requestedByMembershipId");
    expect(approval).toContain("partnerBookingDrafts.createdByMembershipId");
    expect(approval).toContain("expected.ruleSnapshot");
    expect(approval).toContain("expected.requestSnapshot");
    expect(approval).toContain("MAX_APPROVAL_CANDIDATES + 1");
    expect(authorityMigration).toContain("partner_quotes_quote_account_fk");
    expect(authorityMigration).toContain(
      "partner_quotes_canonical_binding_immutable",
    );
    expect(responseBindingMigration).toContain(
      "quote_responses_quote_partner_account_fk",
    );
  });

  it("requires recent MFA, origin, idempotency, ETag and approval capability", () => {
    const route = source(
      "app/api/portal/v2/approval-requests/[requestId]/decision/route.ts",
    );
    expect(route).toContain('"approvals.decide"');
    expect(route).toContain("requireRecentPartnerMfaCapability");
    expect(route).toContain("isAllowedPartnerPortalMutationOrigin");
    expect(route).toContain("readPortalV2IdempotencyKey");
    expect(route).toContain('request.headers.get("if-match")');
    expect(route).toContain("runPortalV2IdempotentMutation");
  });

  it("keeps document object coordinates server-side and logs intents", () => {
    const route = source(
      "app/api/portal/v2/documents/[documentId]/download-intent/route.ts",
    );
    const service = source("src/lib/partner-portal-v2-documents.ts");
    expect(route).toContain('"documents.financial.read"');
    expect(route).toContain("isAllowedPartnerPortalMutationOrigin");
    expect(service).toContain("partnerDocumentAccessLogs");
    expect(service).toContain(
      "createMediaReadUrl(document.storageObjectKey, 300)",
    );
    expect(service).not.toContain(
      "storageObjectKey: document.storageObjectKey",
    );
    expect(service).not.toContain("storageBucket: document.storageBucket");
    expect(route).not.toContain('principal.accessLevel !== "account"');
    expect(service).toContain("createPartnerJobAccessCondition");
  });

  it("filters scoped commercial reads before pagination and fails closed for account statements", () => {
    const handler = source("src/lib/partner-portal-v2-commercial-route.ts");
    const commercial = source("src/lib/partner-portal-v2-commercial.ts");
    expect(handler).not.toContain('principal.accessLevel !== "account"');
    expect(handler).toContain("access: principal");
    expect(commercial).toContain("scopedJobCondition(input.access)");
    expect(commercial).toContain(
      "createPartnerInvoiceAccessCondition(input.access)",
    );
    expect(commercial).toContain("partnerAccountCostCenters.id");
    expect(commercial).toContain(
      "Account statements require account-wide financial access",
    );
  });
});
