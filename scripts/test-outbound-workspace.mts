import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium, webkit, expect } from "@playwright/test";
import tailwindConfig from "../apps/site/tailwind.config";
import {
  buildOutboundFilterHref,
  buildOutboundPartnerSetupHref,
} from "../apps/site/src/app/team/outbound-navigation";

// Real components, local synthetic data and disabled external actions. Not a
// production session or delivery/invitation certification.
const repo = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const require = createRequire(`${repo}/package.json`);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const siteRequire = createRequire(`${repo}/apps/site/package.json`);
const postcss = siteRequire("postcss");
const tailwind = siteRequire("tailwindcss");
const memberId = "11111111-1111-4111-8111-111111111111";
const accountId = "44444444-4444-4444-8444-444444444444";
const contactId = "33333333-3333-4333-8333-333333333333";
const taskId = "22222222-2222-4222-8222-222222222222";
const stamp = "2026-09-09T13:00:00.000Z";
const item = {
  id: accountId,
  title: "Follow up",
  dueAt: stamp,
  overdue: true,
  minutesUntilDue: -5,
  attempt: 2,
  campaign: "property_management",
  lastDisposition: "no_answer",
  company: "Example Property Management",
  noteSnippet: null,
  startedAt: stamp,
  reminderAt: null,
  assignedToMemberId: memberId,
  primaryTaskId: taskId,
  primaryTaskVersion: stamp,
  primaryContactId: contactId,
  taskIds: [taskId],
  contactCount: 1,
  dncContactCount: 0,
  openTaskCount: 1,
  contacts: [
    {
      id: contactId,
      name: "Casey Contact",
      email: "casey@example.test",
      phone: "+14045550100",
      source: "outbound",
      doNotContact: false,
      doNotContactAt: null,
      doNotContactReason: null,
    },
  ],
  tasks: [
    {
      id: taskId,
      version: stamp,
      title: "Follow up",
      dueAt: stamp,
      attempt: 2,
      lastDisposition: "no_answer",
      contactId,
      contactName: "Casey Contact",
      doNotContact: false,
    },
  ],
  account: {
    id: accountId,
    name: "Example Property Management",
    status: "conversation_active",
    segment: "property_manager",
    portalFit: null,
    fitScore: null,
    lastTouchAt: stamp,
    nextTouchAt: stamp,
    brief: null,
    history: [],
  },
};
const payload = {
  ok: true,
  memberId,
  timezone: "America/New_York",
  q: null,
  snapshotAt: stamp,
  scope: {
    facets: "assignee_snapshot",
    summary: "filtered_account_snapshot",
    scoreboard: "assignee_campaign_snapshot",
  },
  total: 1,
  truncated: false,
  scanLimit: 1,
  offset: 0,
  limit: 50,
  nextOffset: null,
  nextCursor: null,
  previousCursor: null,
  summary: {
    dueNow: 1,
    overdue: 1,
    callbacksToday: 0,
    notStarted: 0,
    scoreboard: {
      accountsTouched: 1,
      conversationsStarted: 1,
      qualifiedPartners: 0,
      activePartners: 0,
      avgFitScore: null,
      partnerPathMix: {
        portalFirst: 0,
        managedDirect: 0,
        hybrid: 0,
        notAFit: 0,
      },
    },
  },
  facets: {
    campaigns: ["property_management"],
    dispositions: ["no_answer", "callback_requested"],
    attempts: ["2"],
  },
  items: [item],
};
const css = (
  await postcss([
    tailwind({
      ...tailwindConfig,
      content: [`${repo}/apps/site/src/**/*.{ts,tsx}`],
    }),
  ]).process(readFileSync(`${repo}/apps/site/src/app/globals.css`, "utf8"), {
    from: `${repo}/apps/site/src/app/globals.css`,
  })
).css;

async function harness() {
  const bundle = await build({
    stdin: {
      contents: `import React from'react';import{createRoot}from'react-dom/client';import{OutboundSection}from'./src/app/team/components/OutboundSection';import{PartnerRelationshipSetup}from'./src/app/team/components/PartnerRelationshipSetup';
        const p=new URLSearchParams(location.search);window.__calls=[];
        const filters={due:p.get('out_due')||'',disposition:p.get('out_disposition')||'',accountId:p.get('out_account')||'',taskId:p.get('out_taskId')||'',cursor:p.get('out_cursor')||'',q:p.get('out_q')||''};
        const render=element=>createRoot(document.getElementById('root')).render(<main style={{padding:16,maxWidth:1280,margin:'auto'}}><h1 className='sr-only'>Stonegate CRM</h1>{element}</main>);
        if(location.pathname==='/team/partners'){render(<PartnerRelationshipSetup canCreate canInvite canConfigure openCreate={p.get('p_setup')==='create'}/>)}else{OutboundSection({filters,view:p.get('view')||'queue'}).then(render)}`,
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
        name: "local-read-only-boundaries",
        setup(builder: any) {
          builder.onResolve(
            {
              filter:
                /^(node:crypto|next\/navigation|@\/lib\/team-principal|\.\.\/lib\/api|\.\.\/actions|\.\.\/actions\/partner-relationships)$/,
            },
            (args: any) => ({ path: args.path, namespace: "diagnostic" }),
          );
          builder.onLoad(
            { filter: /.*/, namespace: "diagnostic" },
            (args: any) => ({
              loader: "js",
              contents:
                args.path === "node:crypto"
                  ? `export const randomUUID=()=>crypto.randomUUID();`
                  : args.path === "../actions/partner-relationships"
                    ? `export const searchPartnerRelationshipCompanies=async()=>({ok:true,choices:[],nextCursor:null});export const loadPartnerRelationshipContext=async()=>({ok:false});export const savePartnerRelationship=async()=>{throw Error('No invitations may be sent from this harness')};`
                    : args.path === "next/navigation"
                      ? `export const useRouter=()=>({refresh(){},push(){}});export const usePathname=()=>location.pathname;`
                      : args.path === "@/lib/team-principal"
                        ? `export const requireCurrentTeamPrincipal=async()=>({memberId:'${memberId}'});export const hasTeamPermission=(_p,key)=>{const role=new URLSearchParams(location.search).get('role');return role==='viewer'?key==='outbound.read':true};`
                        : args.path === "../lib/api"
                          ? `export const callAdminApiAs=async(_principal,path)=>{const p=new URLSearchParams(location.search);window.__calls.push(path);if(path.includes('/directory'))return Response.json({members:[{id:'${memberId}',name:'Alex Owner',active:true}]});if(p.has('unavailable'))return Response.json({error:'outbound_assignee_required'},{status:422});const data=${JSON.stringify(payload)};if(p.has('empty')){data.items=[];data.total=0;data.scanLimit=0;}if(p.has('blocked')){data.items[0].contacts[0].doNotContact=true;data.items[0].tasks[0].doNotContact=true;data.items[0].dncContactCount=1;}return Response.json(data);};`
                          : `export const bulkOutboundAction=async(data)=>{window.__bulk=Object.fromEntries(data);window.__bulk.taskRefs=data.getAll('taskRefs');};export const setOutboundDispositionAction=async()=>{};export const draftOutboundFirstTouchAction=async()=>{};export const draftOutboundFollowupAction=async()=>{};export const openContactThreadAction=async()=>{};export const startContactCallAction=async()=>{};`,
            }),
          );
        },
      },
    ],
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://diagnostic.test");
    if (url.pathname === "/client.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(bundle.outputFiles[0].contents);
    } else if (url.pathname === "/style.css") {
      response.setHeader("Content-Type", "text/css");
      response.end(css);
    } else if (url.pathname === "/favicon.ico") {
      response.statusCode = 404;
      response.end();
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end(
        `<!doctype html><html lang="en"><head><title>Local Outbound check</title><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body class="${url.searchParams.get("theme") === "dark" ? "team-theme-dark" : "team-theme-light"}" style="background:var(--team-app-bg);color:var(--team-text)"><div id="root"></div><script src="/client.js"></script></body></html>`,
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("changing quick filters clears stale callback, selection and pagination state", () => {
  const href = buildOutboundFilterHref({
    memberId,
    filters: {
      due: "today",
      disposition: "callback_requested",
      accountId,
      taskId,
      cursor: "old",
      direction: "next",
      q: "Example",
    },
    patch: { due: "overdue", disposition: "" },
  });
  const query = new URL(String(href), "https://example.test").searchParams;
  assert.equal(query.get("out_due"), "overdue");
  assert.equal(query.get("out_q"), "Example");
  for (const key of [
    "out_disposition",
    "out_account",
    "out_taskId",
    "out_cursor",
    "out_direction",
  ])
    assert.equal(query.has(key), false);
  const setup = new URL(
    String(buildOutboundPartnerSetupHref({ memberId, filters: {} })),
    "https://example.test",
  );
  assert.equal(setup.pathname, "/team/partners");
  assert.equal(setup.searchParams.get("p_setup"), "create");
  assert.equal(setup.hash, "#partner-relationship-setup-heading");
});

for (const engine of [chromium, webkit]) {
  test(`${engine.name()}: complete workspace layout, permission and recovery checks`, async () => {
    const app = await harness();
    const browser = await engine.launch();
    try {
      for (const width of [320, 375, 768, 1024, 1440]) {
        const page = await browser.newPage({
          viewport: { width, height: 900 },
        });
        page.on("pageerror", (error) =>
          console.error("Local workspace error:", error.message),
        );
        await page.goto(`${app.url}/?out_account=${accountId}`);
        await expect(
          page.getByRole("heading", { name: "Outbound", exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("link", { name: "Add partner", exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Call", exact: true }),
        ).toBeVisible();
        assert.equal(await page.locator("#outbound-account").count(), 1);
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
          `overflow at ${width}`,
        );
        await page
          .locator("summary")
          .filter({ hasText: "Update several accounts" })
          .focus();
        await page.keyboard.press("Enter");
        await expect(
          page.getByRole("button", { name: "Apply to 0 selected accounts" }),
        ).toBeDisabled();
        await page
          .getByRole("button", { name: "Select page", exact: true })
          .click();
        await page.locator('select[name="action"]').selectOption("snooze");
        await expect(page.locator('select[name="snoozePreset"]')).toBeVisible();
        await expect(
          page.locator('select[name="assignedToMemberId"]'),
        ).toHaveCount(0);
        await page
          .getByRole("button", { name: "Apply to 1 selected accounts" })
          .click();
        await expect
          .poll(() => page.evaluate(() => (window as any).__bulk?.action))
          .toBe("snooze");
        const submitted = await page.evaluate(() => (window as any).__bulk);
        assert.deepEqual(JSON.parse(submitted.taskRefs[0]), [
          { id: taskId, version: stamp },
        ]);
        assert.match(submitted.idempotencyKey, /^outbound-bulk:/);
        await expect(
          page.getByRole("button", { name: "Apply to 0 selected accounts" }),
        ).toBeDisabled();
        await page
          .locator("summary")
          .filter({ hasText: "Update several accounts" })
          .click();
        if (engine === chromium && (width === 320 || width === 1440))
          await page.screenshot({
            path: `/tmp/stonegate-outbound-${width}.png`,
            fullPage: true,
          });
        await page.close();
      }
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
      });
      await page.goto(`${app.url}/?role=viewer&out_account=${accountId}`);
      await expect(
        page.getByText("You have read-only access to this account."),
      ).toBeVisible();
      for (const name of ["Add partner", "Partners", "Import contacts"])
        await expect(page.getByRole("link", { name, exact: true })).toHaveCount(
          0,
        );
      await expect(
        page.getByRole("button", { name: "Call", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.locator("summary").filter({ hasText: "Update several accounts" }),
      ).toHaveCount(0);
      await page.goto(`${app.url}/?unavailable=1`);
      await expect(
        page.getByRole("heading", { name: "Follow-ups could not be loaded" }),
      ).toBeVisible();
      await expect(
        page.getByLabel("Choose whose follow-ups to open"),
      ).toBeVisible();
      await page.goto(
        `${app.url}/?empty=1&out_q=missing&out_account=${accountId}`,
      );
      await expect(
        page.getByText("Nothing matches these filters"),
      ).toBeVisible();
      await expect(
        page.getByText(/No other account has been opened/),
      ).toBeVisible();
      await expect(page.locator("#outbound-account")).toHaveCount(0);
      await page.goto(`${app.url}/?blocked=1&out_account=${accountId}`);
      await expect(
        page.getByRole("button", { name: "Call", exact: true }),
      ).toHaveCount(0);
      await page
        .locator("summary")
        .filter({ hasText: "Update several accounts" })
        .click();
      await expect(page.getByRole("checkbox")).toBeDisabled();
      // Real Axe, using generated current Tailwind styles; no live service calls.
      for (const variant of [
        "light",
        "dark",
        "light&view=import",
        "dark&view=import",
      ]) {
        await page.goto(
          `${app.url}/?theme=${variant}&out_account=${accountId}`,
        );
        if (variant.includes("import"))
          await expect(page.locator('input[type="file"]')).toBeVisible();
        else
          await expect(
            page.getByRole("button", { name: "Call", exact: true }),
          ).toBeVisible();
        await page.addScriptTag({
          path: require.resolve("axe-core/axe.min.js"),
        });
        const violations = await page.evaluate(async () =>
          (
            await (window as any).axe.run(document, {
              runOnly: {
                type: "tag",
                values: ["wcag2a", "wcag2aa", "wcag21aa"],
              },
            })
          ).violations.map((value: any) => ({
            id: value.id,
            nodes: value.nodes.map((node: any) => node.target),
          })),
        );
        assert.deepEqual(violations, [], `${variant} accessibility violations`);
      }
      await page.goto(app.url);
      await page
        .getByRole("link", { name: "Add partner", exact: true })
        .click();
      await expect(
        page.getByRole("button", {
          name: "Create company & invite Administrator",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByLabel("Company name", { exact: true }),
      ).toBeVisible();
      assert.equal(new URL(page.url()).searchParams.get("p_setup"), "create");
      await page.close();
    } finally {
      await browser.close();
      await app.close();
    }
  });
}
