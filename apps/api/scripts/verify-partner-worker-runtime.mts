/** Import the real worker dependency graph without processing events or contacting a provider. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Socket } from "node:net";
import { fileURLToPath } from "node:url";

// The worker starts at the repository root without the API's tsconfig path
// resolver. Verify actual dispatch paths there as well as the imports below.
const workerEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: "production",
  DOTENV_CONFIG_PATH: "/dev/null",
};
delete workerEnvironment["TSX_TSCONFIG_PATH"];
delete workerEnvironment["DATABASE_URL"];
const ownerRuntime = spawnSync(
  process.execPath,
  ["--import", "tsx", "scripts/verify-owner-alert-worker-runtime.ts"],
  {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    env: workerEnvironment,
    encoding: "utf8",
    timeout: 30_000,
  },
);
assert.equal(
  ownerRuntime.status,
  0,
  `Production worker dispatch verification failed: ${ownerRuntime.stderr}`,
);
process.stdout.write(ownerRuntime.stdout);

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
