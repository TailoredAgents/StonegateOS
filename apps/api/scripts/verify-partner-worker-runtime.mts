/** Import the real worker dependency graph without processing events or contacting a provider. */
import assert from "node:assert/strict";
import { Socket } from "node:net";

let networkAttempts = 0;
const originalConnect = Object.getOwnPropertyDescriptor(
  Socket.prototype,
  "connect",
);
assert.ok(
  originalConnect,
  "Node Socket.connect must exist before installing the network guard.",
);
Socket.prototype.connect = function () {
  networkAttempts += 1;
  throw new Error("Network access is forbidden in the worker import smoke.");
};
try {
  const { renderPartnerBillingDocument } = await import(
    "../src/lib/partner-billing-document-renderer"
  );
  const { renderPartnerServiceReportPdf } = await import(
    "../src/lib/partner-service-report-pdf"
  );

  const outbox = await import("../src/lib/outbox-processor");
  assert.equal(typeof outbox.processOutboxBatch, "function");
  const invoice = await renderPartnerBillingDocument({
    title: "Invoice",
    number: "LOCAL-TEST",
    accountName: "Local test",
    issuedAt: "2026-09-09T12:00:00Z",
    currency: "USD",
    lines: [{ description: "Local test service", amountCents: 10000 }],
    totals: [{ label: "Total", amountCents: 10000 }],
    notes: [],
  });
  assert.equal(invoice.subarray(0, 5).toString(), "%PDF-");
  const report = await renderPartnerServiceReportPdf({
    kind: "operational",
    asOf: "2026-09-09T12:00:00Z",
    timezone: "America/New_York",
    count: 0,
    filters: {
      kind: "operational",
      format: "pdf",
      from: "2026-09-01",
      to: "2026-09-09",
    },
    items: [],
    summary: [],
    snapshotHash: "a".repeat(64),
    page: { limit: 100, nextCursor: null, hasMore: false },
    options: { locations: [], requesters: [], services: [] },
  });
  assert.equal(report.subarray(0, 5).toString(), "%PDF-");
  assert.equal(networkAttempts, 0);
  console.log(
    JSON.stringify({
      workerImports: "passed",
      invoicePdfBytes: invoice.length,
      reportPdfBytes: report.length,
      networkAttempts,
    }),
  );
} finally {
  Object.defineProperty(Socket.prototype, "connect", originalConnect);
}
