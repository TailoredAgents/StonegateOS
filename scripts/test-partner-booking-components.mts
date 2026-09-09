import { createRequire } from "node:module";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const require = createRequire(`${repo}/package.json`);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const { chromium } = require("@playwright/test");
const bundle = await build({
  stdin: {
    resolveDir: `${repo}/apps/site`,
    loader: "tsx",
    contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {PartnerBookingWizard} from './src/app/partners/components/PartnerBookingWizard';
    const makeDraft=(id,locationId,description)=>({id,locationId,serviceKey:'junk_removal',tierKey:null,selectedAddOns:[],description,scope:{},commercial:{},crewInstructions:null,accessDetails:null,onSiteContact:{name:'Example contact',phone:'4045550100'},proofRequirements:{before:1,after:1,package:false},preferredWindows:[],scheduleAssistancePreference:'none',etag:'"draft-'+id+':1"',revision:1,state:'draft'});
    const a=makeDraft('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ORIGINAL DRAFT A');
    const b=makeDraft('22222222-2222-4222-8222-222222222222','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','TEMPLATE DRAFT B');
    window.auditDrafts={a,b};
    function App(){ const [draft,setDraft]=React.useState(a);return <><button id="replace-draft" onClick={()=>setDraft(b)}>Load template draft B</button><output id="supplied-draft">{draft.id}</output><PartnerBookingWizard initialDraft={draft} locations={[{id:a.locationId,name:'LOCATION A',address:'Sample site A',timezone:'America/New_York'},{id:b.locationId,name:'LOCATION B',address:'Sample site B',timezone:'America/New_York'}]} services={[{key:'junk_removal',label:'Junk removal',bookable:true,priceState:'quote_required',agreement:null,inclusions:[],exclusions:[],quoteRule:null,baseOptions:[],addOns:[]}]} canUploadPhotos={false} canManageLocations={false} cancellationPolicy={{minimumNoticeMinutes:1440,directCancellationEnabled:true,lateCancellationDisposition:'staff_review',automaticFeeMinor:null,source:'launch_default',revision:null}} persona="other" supportPhoneE164="+14047772631" supportPhoneDisplay="404-777-2631" /></> }
    createRoot(document.getElementById('root')).render(<App/>);
  `,
  },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
  logLevel: "error",
  plugins: [
    {
      name: "next-stubs",
      setup(b) {
        b.onResolve({ filter: /^next\/(navigation|link)$/ }, (args) => ({
          path: args.path,
          namespace: "audit-next",
        }));
        b.onLoad({ filter: /.*/, namespace: "audit-next" }, (args) => ({
          loader: "js",
          resolveDir: `${repo}/apps/site`,
          contents:
            args.path === "next/link"
              ? `import React from 'react'; export default function Link({children,...props}) {return React.createElement('a',props,children);}`
              : `export const useRouter=()=>({push:()=>{},refresh:()=>{}}); export const usePathname=()=>'/partners/book';`,
        }));
      },
    },
  ],
});
const server = createServer((req, res) => {
  if (req.url === "/client.js") {
    res.setHeader("Content-Type", "text/javascript");
    res.end(bundle.outputFiles[0].contents);
    return;
  }
  res.setHeader("Content-Type", "text/html");
  res.end(
    '<html><body><div id="root"></div><script src="/client.js"></script></body></html>',
  );
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw Error("missing port");
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => console.log("PAGE ERROR", error.message));
  const patches: string[] = [];
  const savedDescriptions: string[] = [];
  await page.route("**/api/partners/portal/**", async (route) => {
    const request = route.request();
    const body = request.postDataJSON();
    if (request.method() === "PATCH") {
      patches.push(request.url().split("/booking-drafts/")[1]);
      savedDescriptions.push(body.description);
      const drafts = await page.evaluate(() => window.auditDrafts);
      const draft = request.url().includes(drafts.a.id) ? drafts.a : drafts.b;
      await route.fulfill({ json: { ok: true, draft: { ...draft, ...body } } });
      return;
    }
    await route.fulfill({
      status: 200,
      json: { ok: true, drafts: [], page: { nextCursor: null } },
    });
  });
  await page.goto(`http://127.0.0.1:${address.port}/partners/book`);
  await page.locator("#supplied-draft").waitFor();
  const before = await page
    .locator('input[name="location"]:checked')
    .inputValue();
  await page.locator("#replace-draft").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#supplied-draft")
      ?.textContent?.startsWith("22222222"),
  );
  const after = await page
    .locator('input[name="location"]:checked')
    .inputValue();
  await page
    .getByRole("button", { name: /Continue|Next/ })
    .last()
    .click();
  const description = await page
    .locator("#partner-book-description")
    .inputValue();
  assert.equal(before, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(after, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  assert.equal(description, "TEMPLATE DRAFT B");
  assert.ok(patches.some((id) => id.startsWith("22222222")));
  await page.evaluate(() => history.pushState({}, "", "?step=description"));
  await page
    .locator("#partner-book-description")
    .fill("LATEST EDIT BEFORE BACK");
  await page.goBack();
  await page.waitForTimeout(150);
  assert.ok(
    savedDescriptions.includes("LATEST EDIT BEFORE BACK"),
    "Browser Back must flush the latest edit before the normal debounce",
  );
  console.log(
    JSON.stringify(
      {
        result: "PASS: draft isolation plus browser Back autosave flushing",
        suppliedDraft: "22222222-2222-4222-8222-222222222222",
        selectedLocationBefore: before,
        selectedLocationAfter: after,
        visibleDescription: description,
        patchTargets: patches,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
