import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Quote V2 acceptance certificate boundary", () => {
  it("materializes only after the acceptance transaction commits", () => {
    const service = source("src/lib/quote-v2-public-service.ts");
    const decisionStart = service.indexOf("recordQuoteV2Decision");
    const transactionStart = service.indexOf(
      "const receipt = await db.transaction",
      decisionStart,
    );
    const certificateCall = service.indexOf(
      "reconcileQuoteAcceptanceCertificate(db",
      transactionStart,
    );
    expect(transactionStart).toBeGreaterThan(decisionStart);
    expect(certificateCall).toBeGreaterThan(transactionStart);
    expect(service.slice(transactionStart, certificateCall)).toContain(
      "responseType",
    );
  });

  it("returns truthful pending state and retries derived evidence on every actor replay", () => {
    const certificate = source("src/lib/quote-v2-acceptance-certificate.ts");
    const publicCore = source("src/lib/quote-v2-public.ts");
    const publicService = source("src/lib/quote-v2-public-service.ts");
    const partnerService = source("src/lib/partner-portal-v2-quotes.ts");
    const partnerRoute = source(
      "app/api/portal/v2/quotes/[partnerQuoteId]/decision/route.ts",
    );
    const staffService = source("src/lib/quote-v2-staff-lifecycle.ts");
    const staffRoute = source("src/lib/quote-v2-staff-lifecycle-route.ts");
    expect(certificate).toContain('state: "pending"');
    expect(certificate).toContain(
      "every fresh or idempotent replay can safely retry",
    );
    expect(publicService).toContain("certificateState: certificate.state");
    expect(partnerService).toContain('certificateState: "pending"');
    expect(partnerRoute).toContain("reconcileQuoteAcceptanceCertificate");
    expect(staffService).toContain('certificateState: "pending"');
    expect(staffRoute).toContain(
      "receipt.certificateState = certificate.state",
    );
    for (const actorService of [publicService, partnerService, staffService]) {
      expect(actorService).toContain("certificateIntent");
    }
    for (const intentSource of [publicCore, partnerService, staffService]) {
      expect(intentSource).toContain('source: "immutable_quote_response"');
    }
  });

  it("serves certificates only through authenticated staff quote access", () => {
    const route = source(
      "app/api/quote-versions/[id]/acceptance-certificate/route.ts",
    );
    expect(route).toContain("isAdminRequest(request)");
    expect(route).toContain('requirePermission(request, "quotes.read")');
    expect(route).toContain("getQuoteAcceptanceCertificateDocument");
    expect(route).toContain("ensureQuoteAcceptanceCertificateForVersion");
    expect(route).toContain("getMediaObject");
    expect(route).toContain('createHash("sha256")');
    expect(route).not.toContain("shareToken");
    expect(route).not.toContain("quoteCapabilities");

    const management = source("src/lib/quote-v2-management.ts");
    expect(management).toContain("acceptanceCertificatePath");
    expect(management).toContain(
      "/api/quote-versions/${versionId}/acceptance-certificate",
    );
  });

  it("keeps the public customer PDF bound to the issued proposal document", () => {
    const publicService = source("src/lib/quote-v2-public-service.ts");
    const loaderStart = publicService.indexOf("loadQuoteV2ProposalDocument");
    const loaderEnd = publicService.indexOf(
      "recordQuoteV2CapabilityUse",
      loaderStart,
    );
    const proposalLoader = publicService.slice(loaderStart, loaderEnd);
    expect(proposalLoader).toContain(
      'eq(quoteVersionDocuments.kind, "proposal_pdf")',
    );
    expect(proposalLoader).not.toContain("acceptance_pdf");

    const publicPdf = source("app/api/public/quotes/[token]/pdf/route.ts");
    expect(publicPdf).not.toContain("acceptance-certificate");
    expect(publicPdf).not.toContain("acceptance_pdf");
  });

  it("stores a single immutable document key and no signer PII in metadata", () => {
    const certificate = source("src/lib/quote-v2-acceptance-certificate.ts");
    expect(certificate).toContain("putImmutableMediaObject");
    expect(certificate).toContain(".onConflictDoNothing");
    expect(certificate).toContain('kind: "acceptance_pdf"');
    const metadataStart = certificate.indexOf(
      "metadata: {",
      certificate.indexOf("return {"),
    );
    const metadataEnd = certificate.indexOf("},\n  };", metadataStart);
    const metadata = certificate.slice(metadataStart, metadataEnd);
    expect(metadata).toContain("responseId");
    expect(metadata).toContain("configurationHash");
    expect(metadata).toContain("consentHash");
    expect(metadata).not.toMatch(/signerName|signerTitle|signerCompany/iu);
  });
});
