import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
const repo = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/u, "");
const require = createRequire(`${repo}/package.json`);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const { chromium, webkit } = require("@playwright/test");
const fixture = {
  revision: "a".repeat(64),
  job: {
    id: "job",
    accountName: "Local test",
    finalTotalCents: 20000,
    quotedTotalCents: 20000,
    status: "completed",
  },
  blockers: [],
  unexplainedPaidPrincipalCents: 0,
  invoices: ["first", "second"].map((id) => ({
    id,
    number: id === "first" ? "INV-1" : "INV-2",
    status: "issued",
    currency: "USD",
    totalCents: 10000,
    paidCents: 0,
    creditedCents: 0,
    balanceCents: 10000,
    version: 1,
  })),
  payments: ["payment-one", "payment-two"].map((id) => ({
    id,
    method: "cash",
    currency: "USD",
    jobAmountCents: 10000,
    tipCents: 500,
    status: "completed",
    capturedAt: "2026-09-08T12:00:00Z",
    createdAt: "2026-09-08T12:00:00Z",
  })),
  allocations: [],
  refunds: [
    {
      id: "refund-one",
      paymentId: "payment-one",
      jobAmountCents: 3000,
      tipCents: 0,
      amountCents: 3000,
      status: "completed",
    },
  ],
  refundAllocations: [],
  history: [],
};
for (const engine of [chromium, webkit])
  for (const scenario of ["existing allocations", "historical receipt"])
    test(
      `${engine.name()}: ${scenario} review and idempotent failure recovery`,
      { timeout: 60000 },
      async () => {
        const historical = scenario === "historical receipt";
        const records = historical
          ? {
              ...fixture,
              payments: [],
              refunds: [],
              unexplainedPaidPrincipalCents: 20000,
              invoices: fixture.invoices.map((invoice) => ({
                ...invoice,
                status: "paid",
                paidCents: 10000,
                balanceCents: 0,
              })),
            }
          : fixture;
        const bundle = await build({
          stdin: {
            contents: `import React from 'react';import{createRoot}from'react-dom/client';import{PartnerAllocationReconciliation}from'./src/app/team/components/PartnerAllocationReconciliation';createRoot(document.getElementById('root')).render(<PartnerAllocationReconciliation accountId='account' jobId='job' canManage/>);`,
            resolveDir: `${repo}/apps/site`,
            loader: "tsx",
          },
          absWorkingDir: `${repo}/apps/site`,
          tsconfig: `${repo}/apps/site/tsconfig.json`,
          bundle: true,
          write: false,
          platform: "browser",
          format: "iife",
          jsx: "automatic",
          minify: true,
          define: { "process.env.NODE_ENV": '"production"' },
          logLevel: "error",
          plugins: [
            {
              name: "local-reconciliation-actions",
              setup(builder: any) {
                builder.onResolve(
                  { filter: /actions\/partner-allocation-reconciliation$/ },
                  () => ({ path: "reconciliation", namespace: "local" }),
                );
                builder.onLoad({ filter: /.*/, namespace: "local" }, () => ({
                  loader: "js",
                  contents: `export async function loadPartnerAllocationReconciliation(){return(await fetch('/records')).json()};export async function savePartnerAllocationReconciliation(accountId,jobId,revision,command,key){return(await fetch('/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accountId,jobId,revision,command,key})})).json()}`,
                }));
              },
            },
          ],
        });
        const requests: any[] = [];
        let reads = 0;
        const server = createServer(async (request, response) => {
          if (request.url === "/client.js") {
            response.setHeader("Content-Type", "text/javascript");
            response.end(bundle.outputFiles[0].contents);
            return;
          }
          if (request.url === "/records") {
            reads++;
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({ ok: true, data: records }));
            return;
          }
          if (request.url === "/save") {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            requests.push(JSON.parse(Buffer.concat(chunks).toString()));
            response.setHeader("Content-Type", "application/json");
            response.end(
              JSON.stringify(
                requests.length === 1
                  ? {
                      ok: false,
                      message:
                        "The result could not be confirmed. Retry this same request.",
                    }
                  : { ok: true, message: "Reconciliation recorded." },
              ),
            );
            return;
          }
          response.setHeader("Content-Type", "text/html");
          response.end(
            '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui}button,input,select{min-height:44px}input,select,textarea{max-width:100%}fieldset{min-width:0}</style></head><body><main><div id="root"></div></main><script src="/client.js"></script></body></html>',
          );
        });
        await new Promise<void>((resolve) =>
          server.listen(0, "127.0.0.1", resolve),
        );
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const browser = await engine.launch();
        try {
          const page = await browser.newPage({
            viewport: { width: 375, height: 812 },
          });
          const errors: string[] = [];
          page.on("pageerror", (error: Error) => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${address.port}`);
          await page
            .getByText("Reconcile existing payment allocations", {
              exact: true,
            })
            .click();
          assert.equal(reads, 0);
          await page
            .getByRole("button", { name: "Load payment and invoice evidence" })
            .click();
          if (historical) {
            await page
              .getByRole("button", { name: "Add verified historical receipt" })
              .click();
            await page
              .getByLabel("Original payment method")
              .selectOption("check");
            await page
              .getByLabel("Original service principal ($)")
              .fill("200.00");
            await page
              .getByLabel("Receipt date and time (your local time)")
              .fill("2025-06-15T11:30");
            await page
              .getByLabel("Original receipt or check reference")
              .fill("Original check 1042");
            await page
              .getByLabel("Apply historical principal to invoice")
              .selectOption("first");
            await page
              .getByLabel("Historical principal allocated ($)")
              .fill("100.00");
            await page
              .getByRole("button", {
                name: "Split historical receipt between invoices",
              })
              .click();
            await page
              .getByLabel("Apply historical principal to invoice")
              .nth(1)
              .selectOption("second");
            await page
              .getByLabel("Historical principal allocated ($)")
              .nth(1)
              .fill("100.00");
            assert.equal(
              await page
                .getByRole("checkbox", {
                  name: /verified the receipt has no unrecorded tip/,
                })
                .isChecked(),
              false,
            );
          } else {
            const include = page.getByRole("checkbox", {
              name: "Reconcile this payment using the supporting records",
            });
            await include.first().waitFor();
            assert.equal(await include.first().isChecked(), false);
            assert.equal(await include.nth(1).isChecked(), false);
            await include.first().check();
            const payment = page
              .locator("fieldset")
              .filter({ hasText: "Payment record payment-one" })
              .first();
            assert.equal(await payment.getByRole("combobox").inputValue(), "");
            await payment.getByRole("combobox").selectOption("first");
            await payment
              .getByLabel("Original service payment applied ($)")
              .fill("40.00");
            await payment.getByLabel(/Completed refund/).fill("10.00");
            await payment
              .getByRole("button", { name: "Split between another invoice" })
              .click();
            await payment.getByRole("combobox").nth(1).selectOption("second");
            await payment
              .getByLabel("Original service payment applied ($)")
              .nth(1)
              .fill("60.00");
            await payment
              .getByLabel(/Completed refund/)
              .nth(1)
              .fill("20.00");
          }
          await page
            .getByLabel("Supporting receipt or reconciliation reference")
            .fill("Verified local cash receipt");
          await page
            .getByLabel("Why these allocations are correct")
            .fill("Matched the original service and refund records.");
          await page
            .getByRole("checkbox", { name: /checked the original payment/ })
            .check();
          if (historical) {
            await page
              .getByRole("button", {
                name: "Review reconciliation",
                exact: true,
              })
              .click();
            assert.equal(
              await page
                .getByRole("region", { name: "Reconciliation review" })
                .count(),
              0,
            );
            assert.equal(requests.length, 0);
            await page
              .getByRole("checkbox", {
                name: /verified the receipt has no unrecorded tip/,
              })
              .check();
          }
          await page
            .getByRole("button", { name: "Review reconciliation", exact: true })
            .click();
          const review = page.getByRole("region", {
            name: "Reconciliation review",
          });
          await review.waitFor();
          await review
            .getByText(
              historical
                ? "INV-1: net paid $100.00 → $100.00"
                : "INV-1: net paid $0.00 → $30.00",
              { exact: true },
            )
            .waitFor();
          await review
            .getByText(
              historical
                ? "INV-2: net paid $100.00 → $100.00"
                : "INV-2: net paid $0.00 → $40.00",
              { exact: true },
            )
            .waitFor();
          assert.equal(requests.length, 0);
          await review
            .getByRole("button", { name: "Record audited reconciliation" })
            .click();
          await page
            .getByRole("status")
            .filter({ hasText: "The result could not be confirmed" })
            .waitFor();
          await review
            .getByRole("button", { name: "Record audited reconciliation" })
            .click();
          await page
            .getByRole("status")
            .filter({ hasText: "Reconciliation recorded" })
            .waitFor();
          assert.equal(requests.length, 2);
          assert.equal(requests[0].key, requests[1].key);
          assert.deepEqual(requests[0], requests[1]);
          assert.equal(requests[0].revision, fixture.revision);
          if (historical) {
            assert.equal(requests[0].command.payments.length, 0);
            const record = requests[0].command.historicalPayments[0];
            assert.equal(record.jobAmountCents, 20000);
            assert.equal(record.tenderType, "check");
            assert.equal(record.evidenceReference, "Original check 1042");
            assert.equal(record.tipAcknowledgment, "NO_UNRECORDED_TIP");
            assert.equal(record.tipCents, undefined);
            assert.equal(new Date(record.receivedAt).getUTCFullYear(), 2025);
            assert.deepEqual(record.allocations, [
              { invoiceId: "first", grossAmountCents: 10000, refunds: [] },
              { invoiceId: "second", grossAmountCents: 10000, refunds: [] },
            ]);
          } else {
            assert.equal(requests[0].command.payments.length, 1);
            assert.deepEqual(requests[0].command.payments[0].allocations, [
              {
                invoiceId: "first",
                grossAmountCents: 4000,
                refunds: [{ refundId: "refund-one", amountCents: 1000 }],
              },
              {
                invoiceId: "second",
                grossAmountCents: 6000,
                refunds: [{ refundId: "refund-one", amountCents: 2000 }],
              },
            ]);
          }
          assert.deepEqual(errors, []);
        } finally {
          await browser.close();
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      },
    );
