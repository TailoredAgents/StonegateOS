import fs from "node:fs";
import path from "node:path";

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("partner V2 media integrity contracts", () => {
  it("binds finalization to durable idempotency and guarded asset transitions", () => {
    const service = source("src/lib/partner-portal-v2-media.ts");
    const draftRoute = source(
      "app/api/portal/v2/booking-drafts/[draftId]/media/[mediaId]/finalize/route.ts",
    );
    const jobRoute = source(
      "app/api/portal/v2/jobs/[jobId]/proof/[evidenceId]/finalize/route.ts",
    );

    expect(draftRoute).toContain("idempotencyKeyHash: idempotency.keyHash");
    expect(jobRoute).toContain("idempotencyKeyHash: idempotency.keyHash");
    expect(service).toContain("claimPartnerMediaFinalizeOperation(tx");
    expect(service).toContain("completePartnerMediaFinalizeOperation(tx");
    expect(service).toContain('eq(mediaAssets.status, "processing")');
    expect(service).toContain("eq(mediaAssets.partnerAccountId, accountId)");
    expect(service).toContain(
      "replacementRequired: portalError.status === 422",
    );
    expect(service).toContain("putImmutableMediaObject({");
  });

  it("adds fail-closed tenant preflight and composite media ownership", () => {
    const migration = source(
      "src/db/migrations/0145_partner_media_tenant_integrity.sql",
    );

    expect(migration).toContain(
      "partner media migration blocked: media asset is associated with multiple tenants",
    );
    expect(migration).toContain(
      'ADD CONSTRAINT "partner_draft_media_asset_account_fk"',
    );
    expect(migration).toContain(
      'ADD CONSTRAINT "partner_job_evidence_asset_account_fk"',
    );
    expect(migration).toContain(
      'CREATE TABLE "partner_media_mutation_operations"',
    );
  });
});
