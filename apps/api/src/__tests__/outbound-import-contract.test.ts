import { readFileSync } from "node:fs";
import { join } from "node:path";

const API_ROOT = process.cwd();
const SITE_ROOT = join(API_ROOT, "../site");

function apiSource(path: string): string {
  return readFileSync(join(API_ROOT, path), "utf8");
}

function siteSource(path: string): string {
  return readFileSync(join(SITE_ROOT, path), "utf8");
}

describe("Outbound import production contract", () => {
  const executeRoute = apiSource("app/api/admin/outbound/import/route.ts");
  const previewRoute = apiSource(
    "app/api/admin/outbound/import/preview/route.ts",
  );
  const parser = apiSource("src/lib/outbound-import.ts");
  const service = apiSource("src/lib/outbound-import-service.ts");
  const proxy = siteSource("src/app/api/team/outbound/import/route.ts");
  const client = siteSource("src/app/team/components/OutboundImportClient.tsx");
  const section = siteSource("src/app/team/components/OutboundSection.tsx");
  const resultParser = siteSource("src/app/team/lib/outbound-import-result.ts");
  const transaction = apiSource("src/lib/outbound-import-transaction.ts");
  const boundedRequest = siteSource("src/app/team/lib/bounded-request.ts");

  it("keeps preview authenticated, server-authoritative, and write-free", () => {
    expect(previewRoute).toContain(
      'requirePermission(request, "outbound.import")',
    );
    expect(previewRoute).toContain("parseOutboundImportPayload(payload)");
    expect(previewRoute).toContain(
      "prepareOutboundImportPreview(db, parsed, assignee)",
    );
    expect(previewRoute).not.toContain("beginTeamMutation(");
    expect(previewRoute).not.toContain("claimTeamMutationIdempotency(");
    expect(previewRoute).not.toContain("executePreparedOutboundImport(");
    expect(previewRoute).not.toContain(".transaction(");
    expect(previewRoute).not.toContain(".insert(");
    expect(previewRoute).not.toContain(".update(");
    expect(previewRoute).not.toContain(".delete(");
  });

  it("enforces exact input bounds, aliases, UTF-8, dedupe, and conflicts", () => {
    expect(parser).toContain("OUTBOUND_IMPORT_MAX_ROWS = 2_000");
    expect(parser).toContain("OUTBOUND_IMPORT_MAX_BYTES = 2 * 1024 * 1024");
    expect(parser).toContain('new TextDecoder("utf-8", { fatal: true })');
    expect(parser).toContain(
      "if (dataRecords.length > OUTBOUND_IMPORT_MAX_ROWS)",
    );
    expect(parser).not.toContain("slice(0, OUTBOUND_IMPORT_MAX_ROWS)");
    expect(parser).toContain("HEADER_ALIASES");
    expect(parser).toContain("applyConnectedDuplicateClusters");
    expect(parser).toContain("emailOwner");
    expect(parser).toContain("phoneOwner");
    expect(parser).toContain("Math.min(leftRoot, rightRoot)");
    expect(parser).toContain(
      "Email and phone map to different existing contacts.",
    );
    expect(service).toContain("Resolves to the same existing contact as row");
    expect(service).toContain("regexp_replace(coalesce(${contacts.phone}");
  });

  it("validates assignee eligibility from effective permissions", () => {
    expect(service).toContain("resolveOutboundImportAssignee");
    expect(service).toContain("computeEffectivePermissions(");
    expect(service).toContain(
      'permissionMatches(permission, "outbound.write")',
    );
    expect(service).toContain("member.active !== true || !eligible");
  });

  it("binds typed confirmation and If-Match to the exact preview hash", () => {
    expect(executeRoute).toContain("parsePreviewHash(");
    expect(executeRoute).toContain("mutation.expectedVersion !== previewHash");
    expect(executeRoute).toContain("parseOutboundImportConfirmation(");
    expect(executeRoute).toContain(
      "initialPreview.preview.previewHash !== previewHash",
    );
    expect(executeRoute).toContain(
      "currentPreview.preview.previewHash !== previewHash",
    );
    expect(parser).toContain("row.plannedChanges");
    expect(service).toContain("contactFieldChanges");
    expect(proxy).toContain('headers.set("If-Match", `"${previewHash}"`)');
    expect(client).toContain("preview.confirmationPhrase");
  });

  it("uses durable replay and one transaction for records, audit, and receipt", () => {
    expect(executeRoute).toContain("beginTeamMutation(request");
    expect(executeRoute).toContain('requiredPermissions: ["outbound.import"]');
    expect(executeRoute).toContain("requiresIdempotency: true");
    expect(executeRoute).toContain("claimTeamMutationIdempotency(");
    expect(executeRoute).toContain("teamMutationIdempotencyReplayResponse(");
    expect(executeRoute).toContain("extendTeamMutationIdempotencyLease(");
    expect(executeRoute).toContain("runOutboundImportAtomic(runTransaction");
    expect(transaction).toContain("return runTransaction(work)");
    expect(executeRoute).toContain("lockOutboundImportIdentities(tx, parsed)");
    expect(executeRoute).toContain(
      "lockOutboundImportMatchedContacts(tx, currentPreview)",
    );
    expect(executeRoute).toContain(
      "lockedPreview.preview.previewHash !== previewHash",
    );
    expect(executeRoute).toContain("executePreparedOutboundImport(");
    expect(executeRoute).toContain("mutation.audit.insertSuccess(tx");
    expect(executeRoute).toContain("completeTeamMutationIdempotency(");
    expect(service).toContain("pg_advisory_xact_lock");
    expect(service).toContain("outbound-import:partner:domain:");
    expect(service).toContain("outbound-import:partner:name:");
    expect(service).toContain("outbound-import:contact:id:");
    expect(service).toContain('.for("update")');
    expect(service).toContain("Partner resolution failed for CSV row");
    expect(service).toContain(
      "onConflictDoNothing({ target: crmPipeline.contactId })",
    );
    expect(executeRoute).not.toContain("recordAuditEvent(");
  });

  it("bounds API JSON and Site multipart bodies before materializing them", () => {
    expect(previewRoute).toContain("readOutboundImportJsonRequest(request)");
    expect(executeRoute).toContain("readOutboundImportJsonRequest(request)");
    expect(previewRoute).not.toContain("request.json()");
    expect(executeRoute).not.toContain("request.json()");
    expect(parser).toContain("OUTBOUND_IMPORT_MAX_REQUEST_BYTES");
    expect(parser).toContain("request.body.getReader()");
    expect(proxy).toContain(
      "readBoundedRequestBytes(request, MAX_REQUEST_BYTES)",
    );
    expect(proxy).not.toContain("request.formData()");
    expect(boundedRequest).toContain("request.body.getReader()");
  });

  it("returns every exclusion in a formula-neutralized report", () => {
    expect(parser).toContain("formulaNeutralize");
    expect(parser).toContain("truncated: false");
    expect(parser).toContain("for (const row of excluded)");
    expect(client).toContain("Download all {report.rowCount} excluded rows");
    expect(client).toContain("is not truncated");
    expect(resultParser).toContain('value["truncated"] !== false');
    expect(resultParser).toContain("physicalLines.length !== expectedRows + 2");
  });

  it("reports row classifications separately from actual record writes", () => {
    expect(service).toContain("rowsUpdated: prepared.preview.counts.update");
    expect(service).toContain("contactsModified += 1");
    expect(service).toContain(
      "partnerAccountsResolved: resolvedPartnerAccountIds.size",
    );
    expect(service).toContain("partnerLinksCreated += 1");
    expect(service).toContain("contactNotesCreated += 1");
    expect(service).toContain(
      "pipelineRowsCreated += insertedPipelineRows.length",
    );
    expect(resultParser).toContain(
      'rawCounts["rowsUpdated"] !== counts.update',
    );
    expect(resultParser).toContain(
      'Number(rawCounts["contactsModified"]) > counts.update',
    );
    expect(resultParser).toContain(
      'Number(rawCounts["partnerAccountsResolved"]) > counts.accepted',
    );
  });

  it("provides an accessible Preview, Review, Import flow on the canonical view", () => {
    expect(section).toContain('view === "import"');
    expect(section).toContain("const importHref = buildOutboundHref({");
    expect(section).toContain('view: "import"');
    expect(section).toContain("<OutboundImportClient");
    expect(section).not.toContain("action={importOutboundProspectsAction}");
    expect(client).toContain('aria-label="Import progress"');
    expect(client).toContain('aria-live="polite"');
    expect(client).toContain('role="alert"');
    expect(client).toContain("min-h-[44px]");
    expect(client).toContain("disabled={Boolean(busy)");
    expect(client).toContain("Your CSV is still here");
    expect(client).toContain("REVIEW_PAGE_SIZE = 50");
    expect(client).toContain("md:hidden");
    expect(client).toContain("Previous rows");
    expect(section).toContain(
      'hasTeamPermission(principal, "outbound.import")',
    );
    expect(section).toContain("Import access is required");
  });

  it("rejects malformed upstream successes instead of claiming import success", () => {
    expect(proxy).toContain(
      "parseOutboundImportPreviewEnvelope(upstreamPayload)",
    );
    expect(proxy).toContain("parseOutboundImportMutationSuccess(");
    expect(proxy).toContain("No success is being claimed");
    expect(resultParser).toContain(
      'receipt["entityType"] !== "outbound_import"',
    );
    expect(resultParser).toContain(
      'receipt["entityId"] !== expectedPreviewHash',
    );
    expect(resultParser).toContain(
      'receipt["version"] !== expectedPreviewHash',
    );
  });
});
