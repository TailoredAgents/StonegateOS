import fs from "node:fs";
import path from "node:path";

const apiRoot = path.resolve(process.cwd());

function source(relativePath: string): string {
  return fs.readFileSync(path.join(apiRoot, relativePath), "utf8");
}

describe("partner portal V2 commercial route guards", () => {
  it.each([
    ["quotes", "rates.read"],
    ["invoices", "invoices.read"],
    ["statements", "invoices.read"],
    ["documents", "documents.read"],
    ["reports", "reports.read"],
  ])("binds %s reads to their account capability", (resource, capability) => {
    const route = source(`app/api/portal/v2/${resource}/route.ts`);
    expect(route).toContain(`capability: "${capability}"`);
    expect(route).toContain("handlePartnerCommercialList");
  });

  it("requires AAL2, origin, idempotency, ETag and approval capability", () => {
    const route = source(
      "app/api/portal/v2/approval-requests/[requestId]/decision/route.ts",
    );
    expect(route).toContain('"bookings.approve"');
    expect(route).toContain('assuranceLevel !== "aal2"');
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
    expect(route).toContain('"documents.read"');
    expect(route).toContain("isAllowedPartnerPortalMutationOrigin");
    expect(service).toContain("partnerDocumentAccessLogs");
    expect(service).toContain(
      "createMediaReadUrl(document.storageObjectKey, 300)",
    );
    expect(service).not.toContain(
      "storageObjectKey: document.storageObjectKey",
    );
    expect(service).not.toContain("storageBucket: document.storageBucket");
  });
});
