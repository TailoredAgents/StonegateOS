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
  test(`${engine.name()}: proof job switching and explicit invitation role`, { timeout: 60_000 }, async () => {
    const bundle = await build({ stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
        import {PartnerInvitationManager} from './src/app/partners/components/PartnerInvitationManager';
        import {PartnerProofWorkspace} from './src/app/partners/components/PartnerProofWorkspace';
        const proof=(id)=>({status:'complete',requirements:[],outstanding:[],media:[{id,category:'intake',caption:id+' photo',status:'ready',filename:id+'.jpg',byteSize:100,downloadIntent:null}],packages:[],shareLinks:[]});
        function App(){const [job,setJob]=React.useState('A');return <><PartnerInvitationManager initialInvitations={[]} roles={[{key:'administrator',name:'Administrator'},{key:'operations',name:'Operations'}]}/><button onClick={()=>setJob('B')}>Switch proof job</button><PartnerProofWorkspace accountId='account' jobId={job} initialProof={proof(job)} canUpload canShare={false}/></>}
        createRoot(document.getElementById('root')).render(<App/>);`,
      resolveDir: `${repo}/apps/site`, loader: "tsx",
    }, absWorkingDir: `${repo}/apps/site`, tsconfig: `${repo}/apps/site/tsconfig.json`, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", minify: true,
      define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" }, logLevel: "error" });
    const server = createServer((request, response) => {
      if (request.url === "/client.js") { response.setHeader("Content-Type", "text/javascript"); response.end(bundle.outputFiles[0].contents); return; }
      response.setHeader("Content-Type", "text/html");
      response.end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui}svg{width:24px;height:24px}button,input,select{min-height:44px}</style></head><body><div id="root"></div><script src="/client.js"></script></body></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
      const errors: string[] = [];
      const requests: Array<{ url: string; method: string; body: string | null }> = [];
      page.on("pageerror", (error: Error) => errors.push(error.message));
      await page.route("**/api/partners/portal/**", async (route: any) => {
        requests.push({ url: route.request().url(), method: route.request().method(), body: route.request().postData() });
        await route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ ok: false, error: "invalid_fields", message: "Synthetic validation response" }) });
      });
      await page.goto(`http://127.0.0.1:${address.port}`);
      await page.getByLabel("Full name").fill("Test teammate");
      await page.getByLabel("Work email").fill("teammate@example.test");
      const role = page.getByRole("combobox", { name: /^Role/u });
      assert.equal(await role.inputValue(), "");
      assert.equal(await role.evaluate((element: HTMLSelectElement) => element.checkValidity()), false);
      await role.selectOption("operations");
      await page.getByRole("button", { name: "Send invitation", exact: true }).click();
      await page.waitForFunction(() => document.body.textContent?.includes("Synthetic validation response"));
      const invitation = requests.find((request) => request.url.endsWith("/invitations"));
      assert.ok(invitation?.body);
      assert.equal(JSON.parse(invitation.body).roleKey, "operations");
      await page.getByRole("button", { name: "Switch proof job" }).click();
      assert.equal(await page.getByText("A photo", { exact: true }).count(), 0);
      assert.equal(await page.getByText("B photo", { exact: true }).count(), 1);
      await page.getByRole("button", { name: "Remove", exact: true }).click();
      await page.waitForTimeout(100);
      assert.ok(requests.some((request) => request.method === "DELETE" && request.url.endsWith("/jobs/B/proof/B")));
      assert.ok(!requests.some((request) => request.url.endsWith("/jobs/B/proof/A")));
      assert.deepEqual(errors, []);
    } finally { await browser.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
}
