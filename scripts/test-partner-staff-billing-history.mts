import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repo = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/u, "");
const require = createRequire(`${repo}/package.json`);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const { chromium, webkit } = require("@playwright/test");

for (const engine of [chromium, webkit]) {
  test(`${engine.name()}: invoice history retains older-page retries and isolates invoice changes`, { timeout: 60_000 }, async () => {
    const bundle = await build({
      stdin: { contents: `import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
        import {PartnerBillingHistory} from './src/app/team/components/PartnerBillingHistory';
        function App(){const [id,setId]=useState('first');return <><button onClick={()=>setId('second')}>Open second invoice</button>{['documents','refunds'].map(kind=><PartnerBillingHistory key={id+kind} accountId='account' invoiceId={id} kind={kind} currency='EUR' download={async id=>window.downloaded=id}/>)}</>}
        createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: `${repo}/apps/site`, loader: "tsx" },
      absWorkingDir: `${repo}/apps/site`, tsconfig: `${repo}/apps/site/tsconfig.json`, bundle: true, write: false,
      platform: "browser", format: "iife", jsx: "automatic", minify: true,
      define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
      plugins: [{ name: "local-history-action", setup(builder: any) {
        builder.onResolve({ filter: /actions\/partner-billing$/ }, () => ({ path: "history-action", namespace: "local" }));
        builder.onLoad({ filter: /.*/, namespace: "local" }, () => ({ contents: `export async function loadPartnerBillingHistory(accountId,invoiceId,kind,cursor){return (await fetch('/history?'+new URLSearchParams({accountId,invoiceId,kind,...(cursor?{cursor}:{})}))).json()}`, loader: "js" }));
      } }],
    });
    const requests: URL[] = [];
    let failOlder = true;
    const row = (id: string) => ({ id, createdAt: "2026-09-01T12:00:00.123456Z", status: "ready", kind: "invoice", documentId: id });
    const server = createServer((request, response) => {
      if (request.url === "/client.js") { response.setHeader("Content-Type", "text/javascript"); response.end(bundle.outputFiles[0].contents); return; }
      if (request.url?.startsWith("/history?")) {
        const url = new URL(request.url, "http://local.test"); requests.push(url);
        response.setHeader("Content-Type", "application/json");
        const kind = url.searchParams.get("kind"), invoiceId = url.searchParams.get("invoiceId"), cursor = url.searchParams.get("cursor");
        if (cursor && failOlder) { failOlder = false; response.end(JSON.stringify({ ok: false, message: "Synthetic connection interruption; retry older records." })); return; }
        const items = invoiceId === "second" ? [] : kind === "refunds" ? [{ id: "refund", createdAt: "2026-09-01T12:00:00.123456Z", amountCents: 100, paymentId: "payment", status: "queued" }]
          : cursor ? [row("doc-49"), row("doc-50"), row("doc-51")] : Array.from({ length: 50 }, (_, index) => row(`doc-${index}`));
        response.end(JSON.stringify({ ok: true, data: { accountId: "account", invoiceId, kind, items,
          nextCursor: invoiceId === "first" && kind === "documents" && !cursor ? "older-page" : null } })); return;
      }
      response.setHeader("Content-Type", "text/html");
      response.end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui}button{min-height:44px}</style></head><body><main><div id="root"></div></main><script src="/client.js"></script></body></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
      const errors: string[] = []; page.on("pageerror", (error: Error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${address.port}`);
      const documents = page.getByRole("region", { name: "Document history" });
      const refunds = page.getByRole("region", { name: "Refund history" });
      assert.equal(await documents.getByText("No documents recorded for this invoice.").count(), 0);
      assert.equal(requests.length, 0);
      await documents.getByRole("button", { name: "View document history" }).click();
      await documents.getByRole("button", { name: "Load older records" }).waitFor();
      assert.equal(await documents.getByRole("listitem").count(), 50);
      await documents.getByRole("button", { name: "Load older records" }).click();
      await documents.getByRole("alert").waitFor();
      assert.equal(await documents.getByRole("listitem").count(), 50);
      await documents.getByRole("button", { name: "Retry older records" }).click();
      await documents.getByText("End of history.", { exact: true }).waitFor();
      assert.equal(await documents.getByRole("listitem").count(), 52);
      assert.deepEqual(requests.slice(1, 3).map((url) => url.searchParams.get("cursor")), ["older-page", "older-page"]);
      await documents.getByRole("button", { name: "Download invoice", exact: true }).last().click();
      assert.equal(await page.evaluate(() => (window as any).downloaded), "doc-51");
      await refunds.getByRole("button", { name: "View refund history" }).click();
      await refunds.getByText("Refund €1.00 · queued", { exact: true }).waitFor();
      await documents.getByRole("button", { name: "Refresh history" }).click();
      await documents.getByRole("button", { name: "Load older records" }).waitFor();
      assert.equal(await documents.getByRole("listitem").count(), 50);
      await page.getByRole("button", { name: "Open second invoice" }).click();
      await documents.getByRole("button", { name: "View document history" }).waitFor();
      assert.equal(await documents.getByRole("listitem").count(), 0);
      assert.equal(await refunds.getByRole("listitem").count(), 0);
      await documents.getByRole("button", { name: "View document history" }).click();
      await documents.getByText("No documents recorded for this invoice.", { exact: true }).waitFor();
      assert.equal(requests.at(-1)?.searchParams.get("invoiceId"), "second");
      assert.equal(requests.at(-1)?.searchParams.get("cursor"), null);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close(); server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
