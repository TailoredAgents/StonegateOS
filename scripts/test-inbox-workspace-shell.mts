import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium, expect } from "@playwright/test";
import tailwindConfig from "../apps/site/tailwind.config";

// Actual shell, drawers and action forms; synthetic API/action boundaries only.
// No account, database, message provider or booking mutation is contacted.
const repo = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/u, "");
const require = createRequire(`${repo}/package.json`);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const siteRequire = createRequire(`${repo}/apps/site/package.json`);
const contactId = "11111111-1111-4111-8111-111111111111";
const employeeId = "22222222-2222-4222-8222-222222222222";
const threadId = "33333333-3333-4333-8333-333333333333";
const property = {
  id: "property-1",
  addressLine1: "123 Local Lane",
  addressLine2: "Building 4, Unit 210",
  city: "Atlanta",
  state: "GA",
  postalCode: "30301",
};
const fixture = {
  ok: true,
  contact: {
    id: contactId,
    name: "Casey Customer",
    firstName: "Casey",
    lastName: "Customer",
    phone: "404-555-0100",
    phoneE164: "+14045550100",
    email: null,
    salespersonMemberId: null,
    pipeline: { stage: "new", notes: null },
    stats: { appointments: 1, quotes: 0 },
    notesCount: 0,
    remindersCount: 0,
    lastActivityAt: null,
  },
  properties: [property],
  upcomingAppointments: [
    {
      id: "appointment-1",
      status: "requested",
      startAt: "2026-10-20T14:00:00.000Z",
      durationMinutes: 90,
      travelBufferMinutes: 30,
      appointmentType: "job",
      rescheduleToken: "local-only",
      property,
    },
  ],
  quotes: [],
  missingFields: [],
  recommendedIntent: "booking",
};

async function harness() {
  const css = (
    await siteRequire("postcss")([
      siteRequire("tailwindcss")({
        ...tailwindConfig,
        content: [`${repo}/apps/site/src/**/*.{ts,tsx}`],
      }),
    ]).process(readFileSync(`${repo}/apps/site/src/app/globals.css`, "utf8"), {
      from: `${repo}/apps/site/src/app/globals.css`,
    })
  ).css;
  const bundle = await build({
    stdin: {
      contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {TeamAppShell} from './src/app/team/components/TeamAppShell';
      import {InboxCustomerWorkspaceClient} from './src/app/team/components/InboxCustomerWorkspaceClient';
      import {INBOX_DRAFT_INSERT_EVENT} from './src/app/team/inbox-composer-drafts';
      window.__insertions=[];window.__actions=[];
      window.addEventListener(INBOX_DRAFT_INSERT_EVENT,event=>{window.__insertions.push(event.detail);event.preventDefault();});
      const quickItems=[{id:'calendar',label:'Calendar',href:'/team/calendar'},{id:'inbox',label:'Inbox',href:'/team/inbox'},{id:'contacts',label:'Contacts',href:'/team/contacts'}];
      const groups=[{id:'marketing',label:'Marketing',items:[{id:'seo',label:'SEO',href:'/team/seo'}]},{id:'administration',label:'Administration',items:[{id:'policy',label:'Policy Center',href:'/team/policy'}]}];
      createRoot(document.getElementById('root')).render(<TeamAppShell activeId='inbox' title='Inbox' quickItems={quickItems} groups={groups} utilityItems={[{id:'settings',label:'Settings',href:'/team/settings'}]} access={{hasCrew:true,hasOffice:true,hasOwner:false}} user={{name:'Office User',email:'office@example.test'}} classicHref='/team/inbox?layout=classic'>
        <div className='flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-white p-3'>
          <InboxCustomerWorkspaceClient employeeId='${employeeId}' contactId='${contactId}' threadId='${threadId}' activeChannel='sms' services={[{id:'furniture',label:'Furniture',allowCustomPrice:true}]} zones={[{id:'zone-1',name:'Local'}]} teamMembers={[{id:'${employeeId}',name:'Office User'}]} details={<details><summary>Notes and reminders</summary><p>Extra details stay in the drawer.</p></details>} />
          <div data-conversation-scroll className='min-h-0 flex-1 overflow-y-auto'>{Array.from({length:50},(_,i)=><p key={i} className='py-2'>Customer message {i+1}</p>)}</div>
          <textarea aria-label='Reply' className='shrink-0 border p-2' defaultValue='Keep this unsent reply'/>
        </div>
      </TeamAppShell>);`,
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
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
    logLevel: "error",
    plugins: [
      {
        name: "local-only-boundaries",
        setup(builder: any) {
          const modules = new Map<string, string>();
          builder.onResolve(
            { filter: /^next\/(navigation|image|link)$/ },
            (args: any) => ({ path: args.path, namespace: "local" }),
          );
          builder.onLoad({ filter: /.*/, namespace: "local" }, (args: any) => ({
            loader: "jsx",
            resolveDir: `${repo}/apps/site`,
            contents:
              args.path === "next/navigation"
                ? `const router={push(href){window.__navigation=href},refresh(){},replace(){}};export const useRouter=()=>router;export const useSearchParams=()=>new URLSearchParams(location.search);`
                : args.path === "next/link"
                  ? `import React from 'react';export default function Link({children,...props}){return <a {...props}>{children}</a>}`
                  : `import React from 'react';export default function Image(props){return <img {...props}/>}`,
          }));
          builder.onResolve({ filter: /(?:^|\/)actions$/ }, (args: any) => {
            const source = readFileSync(args.importer, "utf8");
            const match = [
              ...source.matchAll(
                /import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/gu,
              ),
            ].find((entry) => entry[2] === args.path);
            assert.ok(match, `Action import boundary ${args.importer}`);
            const names = match[1]
              .split(",")
              .map((value) => value.trim())
              .filter((value) => value && !value.startsWith("type "));
            const key = `${args.importer}:${args.path}`;
            modules.set(
              key,
              names
                .map(
                  (name) =>
                    `export const ${name}=async form=>{window.__actions.push({name:'${name}',fields:Object.fromEntries(form)});return {ok:true,draftText:'Prepared local confirmation.'}};`,
                )
                .join("\n"),
            );
            return { path: key, namespace: "actions" };
          });
          builder.onLoad(
            { filter: /.*/, namespace: "actions" },
            (args: any) => ({ contents: modules.get(args.path), loader: "js" }),
          );
        },
      },
    ],
  });
  const server = createServer((request, response) => {
    if (request.url === "/client.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(bundle.outputFiles[0].contents);
    } else if (request.url === "/style.css") {
      response.setHeader("Content-Type", "text/css");
      response.end(css);
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end(
        '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/client.js"></script></body></html>',
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test(
  "Inbox shell and customer drawers remain compact, lazy, accessible and recipient-scoped",
  { timeout: 90_000 },
  async (t) => {
    const app = await harness();
    const browser = await chromium.launch();
    try {
      await t.test(
        "viewport fits phones and desktops; account tools and optional navigation are collapsed",
        async () => {
          for (const width of [320, 390, 1024, 1440]) {
            const page = await browser.newPage({
              viewport: { width, height: 900 },
            });
            let reads = 0;
            await page.route(
              "**/api/team/contacts/workspace?**",
              async (route) => {
                reads++;
                await route.fulfill({ json: fixture });
              },
            );
            await page.goto(app.url);
            await expect(
              page.getByRole("button", {
                name: "Customer details",
                exact: true,
              }),
            ).toBeVisible();
            await expect(
              page.getByRole("textbox", { name: "Reply", exact: true }),
            ).toBeVisible();
            assert.equal(
              reads,
              0,
              "Optional workspace must not fetch when the inbox opens",
            );
            assert.ok(
              await page.evaluate(
                () =>
                  document.documentElement.scrollHeight <= innerHeight + 1 &&
                  document.documentElement.scrollWidth <= innerWidth + 1,
              ),
              "Page fits the viewport",
            );
            const scroller = page.locator("[data-conversation-scroll]");
            assert.ok(
              await scroller.evaluate(
                (el) => el.scrollHeight > el.clientHeight,
              ),
            );
            await expect(
              page.getByText("Crew Access", { exact: true }),
            ).not.toBeVisible();
            const account = page.getByLabel("Account and settings", {
              exact: true,
            });
            await account.focus();
            await page.keyboard.press("Enter");
            await expect(
              page.getByRole("button", { name: "Settings", exact: true }),
            ).toBeVisible();
            await expect(
              page.getByRole("button", { name: "Classic layout", exact: true }),
            ).toBeVisible();
            await page.keyboard.press("Escape");
            await expect(account).toBeFocused();
            await expect(
              page.getByRole("button", { name: "Classic layout", exact: true }),
            ).not.toBeVisible();
            if (width >= 1024) {
              await expect(
                page.getByRole("button", { name: "Marketing", exact: true }),
              ).toHaveAttribute("aria-expanded", "false");
              await expect(
                page.getByRole("button", { name: "SEO", exact: true }),
              ).not.toBeVisible();
            }
            await page.close();
          }
        },
      );
      await t.test(
        "details loads on demand, sections stay closed, reschedule is attached to an actual appointment",
        async () => {
          const page = await browser.newPage({
            viewport: { width: 1440, height: 900 },
          });
          let reads = 0;
          await page.route(
            "**/api/team/contacts/workspace?**",
            async (route) => {
              reads++;
              await route.fulfill({ json: fixture });
            },
          );
          await page.goto(app.url);
          const trigger = page.getByRole("button", {
            name: "Customer details",
            exact: true,
          });
          await trigger.click();
          await expect(
            page.getByRole("heading", {
              name: "Customer details",
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            page
              .locator("dialog summary")
              .filter({ hasText: "Contact information" }),
          ).toBeVisible();
          assert.equal(reads, 1);
          assert.equal(await page.locator("dialog details[open]").count(), 0);
          await expect(
            page.getByRole("button", { name: "Reschedule", exact: true }),
          ).not.toBeVisible();
          await page
            .locator("dialog summary")
            .filter({ hasText: /^Appointments/ })
            .click();
          await page
            .getByRole("button", { name: "Reschedule", exact: true })
            .click();
          await expect(
            page.getByRole("heading", {
              name: "Reschedule appointment",
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            page.locator('select[name="appointmentId"] option'),
          ).toContainText("123 Local Lane, Building 4, Unit 210");
          assert.equal(
            reads,
            1,
            "Opening another workflow reuses the loaded customer",
          );
          await page.keyboard.press("Escape");
          await expect(trigger).toBeFocused();
          await expect(
            page.getByRole("textbox", { name: "Reply", exact: true }),
          ).toHaveValue("Keep this unsent reply");
          await page.close();
        },
      );
      await t.test(
        "booking choices distinguish units at the same street address",
        async () => {
          const page = await browser.newPage();
          await page.route("**/api/team/contacts/workspace?**", (route) =>
            route.fulfill({
              json: {
                ...fixture,
                properties: [
                  property,
                  {
                    ...property,
                    id: "property-2",
                    addressLine2: "Building 4, Unit 211",
                  },
                ],
              },
            }),
          );
          await page.goto(app.url);
          await page.getByRole("button", { name: "Book", exact: true }).click();
          const properties = page.locator('select[name="propertyId"]');
          await expect(
            properties.locator('option[value="property-1"]'),
          ).toHaveText(
            "123 Local Lane, Building 4, Unit 210, Atlanta, GA 30301",
          );
          await expect(
            properties.locator('option[value="property-2"]'),
          ).toHaveText(
            "123 Local Lane, Building 4, Unit 211, Atlanta, GA 30301",
          );
          await properties.selectOption("property-2");
          await expect(properties).toHaveValue("property-2");
          await page.close();
        },
      );
      await t.test(
        "optional detail failure stays local and retries without affecting the reply",
        async () => {
          const page = await browser.newPage({
            viewport: { width: 390, height: 900 },
          });
          let reads = 0;
          await page.route(
            "**/api/team/contacts/workspace?**",
            async (route) => {
              reads++;
              await route.fulfill(
                reads === 1
                  ? {
                      status: 503,
                      json: {
                        ok: false,
                        message: "Customer details are unavailable.",
                      },
                    }
                  : { json: { ...fixture, upcomingAppointments: [] } },
              );
            },
          );
          await page.goto(app.url);
          await page
            .getByRole("button", { name: "Customer details", exact: true })
            .click();
          await expect(
            page.getByRole("button", { name: "Retry details" }),
          ).toBeVisible();
          await page.getByRole("button", { name: "Retry details" }).click();
          await expect(
            page
              .locator("dialog summary")
              .filter({ hasText: "Contact information" }),
          ).toBeVisible();
          await expect(
            page.locator("dialog summary").filter({ hasText: /^Appointments/ }),
          ).toHaveCount(0);
          await page
            .getByRole("button", {
              name: "Close Customer details",
              exact: true,
            })
            .click();
          await expect(
            page.getByRole("textbox", { name: "Reply", exact: true }),
          ).toHaveValue("Keep this unsent reply");
          await page.close();
        },
      );
      await t.test(
        "quote form preserves its existing validation and inserts a scoped draft after success",
        async () => {
          const page = await browser.newPage({
            viewport: { width: 1440, height: 900 },
          });
          await page.route("**/api/team/contacts/workspace?**", async (route) =>
            route.fulfill({ json: fixture }),
          );
          await page.goto(app.url);
          await page
            .getByRole("button", { name: "Create quote", exact: true })
            .click();
          const submit = page.getByRole("button", {
            name: "Create quote and draft reply",
            exact: true,
          });
          await expect(submit).toBeDisabled();
          await page.getByRole("checkbox").check();
          await page.getByPlaceholder("Total price").fill("325");
          await page
            .getByLabel("Scope shown to customer")
            .fill("Remove the listed furniture.");
          await submit.click();
          await expect(
            page.getByRole("heading", { name: "Create quote", exact: true }),
          ).toHaveCount(0);
          const inserted = await page.evaluate(
            () => (window as any).__insertions,
          );
          assert.equal(inserted.length, 1);
          assert.deepEqual(inserted[0], {
            employeeId,
            contactId,
            threadId,
            channel: "sms",
            body: "Prepared local confirmation.",
          });
          const actions = await page.evaluate(() => (window as any).__actions);
          assert.equal(actions.length, 1);
          assert.equal(actions[0].name, "createInboxQuoteAction");
          assert.equal(actions[0].fields.contactId, contactId);
          await expect(
            page.getByRole("textbox", { name: "Reply", exact: true }),
          ).toHaveValue("Keep this unsent reply");
          await page.close();
        },
      );
      await t.test(
        "name editing refreshes cached contact details without leaving the drawer",
        async () => {
          const page = await browser.newPage({
            viewport: { width: 1440, height: 900 },
          });
          let current = fixture;
          await page.route("**/api/team/contacts/workspace?**", async (route) =>
            route.fulfill({ json: current }),
          );
          await page.route("**/api/team/contacts/name", async (route) => {
            const input = route.request().postDataJSON();
            assert.equal(input.contactId, contactId);
            current = {
              ...fixture,
              contact: {
                ...fixture.contact,
                name: `${input.firstName} ${input.lastName}`,
                firstName: input.firstName,
                lastName: input.lastName,
              },
            };
            await route.fulfill({ json: { ok: true } });
          });
          await page.goto(app.url);
          await page
            .getByRole("button", { name: "Customer details", exact: true })
            .click();
          await page
            .locator("dialog summary")
            .filter({ hasText: "Contact information" })
            .click();
          await page
            .getByRole("button", { name: "Edit name", exact: true })
            .click();
          await page.getByLabel("First", { exact: true }).fill("Taylor");
          await page.getByRole("button", { name: "Save", exact: true }).click();
          await expect(
            page.getByText("Taylor Customer", { exact: true }),
          ).toBeVisible();
          await expect(
            page.getByRole("heading", {
              name: "Customer details",
              exact: true,
            }),
          ).toBeVisible();
          await page.close();
        },
      );
      await t.test(
        "saved expanded navigation preference wins over the new default",
        async () => {
          const page = await browser.newPage({
            viewport: { width: 1440, height: 900 },
          });
          await page.addInitScript(() =>
            localStorage.setItem("team.sidebar.groups.collapsed.v1", "[]"),
          );
          await page.goto(app.url);
          await expect(
            page.getByRole("button", { name: "Marketing", exact: true }),
          ).toHaveAttribute("aria-expanded", "true");
          await expect(
            page.getByRole("button", { name: "SEO", exact: true }),
          ).toBeVisible();
          await page.close();
        },
      );
    } finally {
      await browser.close();
      await app.close();
    }
  },
);
