import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium, webkit, expect, type Page } from "@playwright/test";
import type {
  PartnerRequestInboxItem,
  PartnerRequestInboxResponse,
} from "@myst-os/sdk";
import tailwindConfig from "../apps/site/tailwind.config";

const repo = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(`${repo}/package.json`);
const siteRequire = createRequire(`${repo}/apps/site/package.json`);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const accountId = "22222222-2222-4222-8222-222222222222";
const groupId = "33333333-3333-4333-8333-333333333333";
const kinds = [
  "service",
  "reschedule",
  "cancellation",
  "change",
  "billing",
  "address",
] as const;
function row(
  kind: (typeof kinds)[number],
  index: number,
): PartnerRequestInboxItem {
  const id = `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`;
  return {
    id,
    key: `${kind}:${id}`,
    kind,
    accountId,
    accountName: "Sample Bakery",
    jobId: id,
    service: "Facility cleanout",
    description: "Collect twelve unused shelves.",
    siteName: "Bakery warehouse",
    address: "100 Sample Road, Atlanta, GA 30301",
    requesterName: "Morgan Lee",
    preferredWindows: [
      {
        localDate: "2026-10-03",
        timeOfDay: "afternoon",
        timezone: "America/New_York",
      },
    ],
    receivedAt: "2026-09-19T12:00:00.000Z",
    state: "pending",
    stage: "needs_attention",
    statusLabel: "Needs review",
    detailHref: `/team/partners?p_admin=requests&p_request=${kind}:${id}`,
    canAct: true,
    canAcknowledge: kind === "service",
    alertGroupId: null,
    isNew: kind === "service",
  };
}
const rows = kinds.map((kind, index) => row(kind, index + 1));
const groupRows = [rows[0]!, row("service", 7), row("service", 8)].map(
  (item) => ({ ...item, alertGroupId: groupId }),
);
const counts = {
  needsAttention: 6,
  waitingOnClient: 1,
  handled: 1,
  byKind: Object.fromEntries(kinds.map((kind) => [kind, 1])),
  byCompany: { [accountId]: 6 },
} as PartnerRequestInboxResponse["counts"];
const entry = `import React from 'react';import{createRoot}from'react-dom/client';import{PartnerRequestInbox}from'./src/app/team/components/PartnerRequestInbox';import{PartnerRequestBadge,PartnerRequestShortcut,refreshPartnerRequestCounts}from'./src/app/team/components/PartnerRequestSummary';
window.__refreshCounts=refreshPartnerRequestCounts;
const params=new URLSearchParams(location.search);function App(){return <main className="mx-auto min-h-screen max-w-6xl space-y-6 bg-slate-50 p-4 text-slate-950"><header className="flex items-center gap-3"><h1 className="text-2xl font-semibold">Partners</h1><PartnerRequestBadge/><PartnerRequestBadge accountId="${accountId}"/></header><PartnerRequestShortcut/><PartnerRequestInbox initialRequestKey={params.get('p_request')||undefined} alertGroupId={params.get('p_alert')||undefined}/></main>}createRoot(document.getElementById('root')).render(<App/>);`;
let built: Promise<{ script: Uint8Array; css: string }> | undefined;
function assets() {
  return (built ??= (async () => {
    const [bundle, styles] = await Promise.all([
      build({
        stdin: {
          contents: entry,
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
            name: "staff-server-boundaries",
            setup(builder: any) {
              builder.onResolve(
                {
                  filter:
                    /^(?:next\/(?:link|navigation)|\.\.\/actions\/(?:partner-request-inbox|partner-service-reviews|partner-reschedule-reviews|partner-administration|scheduling-resources))$/,
                },
                (args: any) => ({ path: args.path, namespace: "fixture" }),
              );
              builder.onLoad(
                { filter: /.*/, namespace: "fixture" },
                (args: any) => {
                  const send =
                    "const call=async(name,input)=>{window.__fixturePending=(window.__fixturePending||0)+1;try{return await fetch('/fixture/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input??{})}).then(r=>r.json())}finally{window.__fixturePending--}};";
                  const contents =
                    args.path === "next/link"
                      ? "import React from'react';export default function Link({children,...props}){return React.createElement('a',props,children)}"
                      : args.path === "next/navigation"
                        ? "export const useRouter=()=>({refresh(){}});"
                        : args.path.endsWith("partner-request-inbox")
                          ? `import{parsePartnerRequestInbox,parsePartnerRequestInboxDetail}from'${repo}/packages/sdk/src/partner-request-inbox.ts';${send}const read=async(name,input,parse)=>{const response=await call(name,input);if(response.ok===false)return response;const data=parse(response);return data?{ok:true,data}:{ok:false,message:'The response could not be verified. Try again.'}};export const loadPartnerRequestInbox=input=>read('list',input,parsePartnerRequestInbox);export const loadPartnerRequestDetail=(key,accountId)=>read('detail',{key,accountId},parsePartnerRequestInboxDetail);export const markPartnerRequestOpened=input=>call('opened',input).then(r=>r.ok===true&&r.opened===true);`
                          : args.path.endsWith("partner-service-reviews")
                            ? `${send}export const loadPartnerServiceReviews=input=>call('service',input);export const previewPartnerServiceArrival=input=>call('preview',input);`
                            : args.path.endsWith("scheduling-resources")
                              ? `${send}export const loadStaffAppointmentResources=input=>call('resources',input);`
                              : args.path.endsWith("partner-reschedule-reviews")
                                ? `${send}export const loadPartnerRescheduleReviews=input=>call('reschedule',input);export const decidePartnerRescheduleReview=input=>call('decision',input);`
                                : `${send}export const partnerBillingDisputeDecisionAction=input=>call('decision',Object.fromEntries(input));export const partnerCancellationRequestDecisionAction=partnerBillingDisputeDecisionAction;export const partnerJobChangeRequestDecisionAction=partnerBillingDisputeDecisionAction;export const partnerLocationAddressReviewDecisionAction=partnerBillingDisputeDecisionAction;`;
                  return {
                    contents,
                    loader: "js",
                    resolveDir: `${repo}/apps/site`,
                  };
                },
              );
            },
          },
        ],
      }),
      siteRequire("postcss")([
        siteRequire("tailwindcss")({
          ...tailwindConfig,
          content: [
            `${repo}/apps/site/src/app/team/components/*.tsx`,
            { raw: entry, extension: "tsx" },
          ],
        }),
      ]).process(
        readFileSync(`${repo}/apps/site/src/app/globals.css`, "utf8"),
        { from: undefined },
      ),
    ]);
    return { script: bundle.outputFiles[0].contents, css: styles.css };
  })());
}
async function frames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
async function visibility(page: Page, hidden: boolean) {
  await page.evaluate((value) => {
    (window as any).__fixtureHidden = value;
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
  await frames(page);
  assert.deepEqual(
    await page.evaluate(() => ({
      visibility: document.visibilityState,
      hidden: (window as any).__fixtureHidden,
      own: Object.hasOwn(document, "visibilityState"),
    })),
    { visibility: hidden ? "hidden" : "visible", hidden, own: true },
  );
}
async function fits(page: Page) {
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
    "Inbox fits viewport without hiding content",
  );
}

for (const engine of [chromium, webkit])
  for (const width of [1440, 375])
    void test(
      `${engine.name()} ${width}px: requests, counts, review recovery and visible-only owner acknowledgment`,
      { timeout: 90_000 },
      async () => {
        const output = await assets();
        const server = createServer((request, response) => {
          const path = new URL(request.url ?? "/", "http://localhost").pathname;
          if (path === "/client.js") {
            response.setHeader("Content-Type", "text/javascript");
            response.end(output.script);
          } else if (path === "/styles.css") {
            response.setHeader("Content-Type", "text/css");
            response.end(output.css);
          } else {
            response.setHeader("Content-Type", "text/html");
            response.end(
              '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script src="/client.js"></script></body></html>',
            );
          }
        });
        await new Promise<void>((resolve) =>
          server.listen(0, "127.0.0.1", resolve),
        );
        const port = (server.address() as { port: number }).port;
        const browser = await engine.launch({ headless: true });
        const context = await browser.newContext({
          viewport: { width, height: 1000 },
        });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        let listFailure = false,
          malformed = false,
          serviceFailure = true,
          previewFailure = true,
          groupPaging = true,
          allowAck = true;
        const calls: Array<{ name: string; input: any }> = [];
        await page.addInitScript(
          "window.__fixtureHidden=false; Object.defineProperty(document,'visibilityState',{get:function(){return window.__fixtureHidden?'hidden':'visible'}});",
        );
        await page.route("**/fixture/*", async (route) => {
          const name = new URL(route.request().url()).pathname
            .split("/")
            .at(-1)!;
          const input = route.request().postDataJSON();
          calls.push({ name, input });
          let result: unknown;
          if (name === "list") {
            let items = input.alertGroupId ? groupRows : rows;
            if (input.status === "waiting_on_client")
              items = [
                {
                  ...rows[3]!,
                  stage: "waiting_on_client",
                  statusLabel: "Waiting on client",
                },
              ];
            if (input.status === "handled")
              items = [
                { ...rows[2]!, stage: "handled", statusLabel: "Handled" },
              ];
            if (input.kind)
              items = items.filter((item) => item.kind === input.kind);
            if (
              input.q &&
              !"Sample Bakery"
                .toLowerCase()
                .includes(String(input.q).toLowerCase())
            )
              items = [];
            const grouped = Boolean(input.alertGroupId);
            if (grouped && groupPaging)
              items = input.cursor ? items.slice(2) : items.slice(0, 2);
            result = listFailure
              ? {
                  ok: false,
                  message: "Requests unavailable. Reference: inbox-fixture.",
                }
              : malformed
                ? { ok: true, requests: [], counts: {} }
                : {
                    ok: true,
                    requests: items,
                    counts,
                    page: {
                      nextCursor:
                        grouped && groupPaging && !input.cursor
                          ? "next-group-page"
                          : null,
                    },
                    generatedAt: "2026-09-19T12:00:00.000Z",
                    group: grouped
                      ? {
                          id: groupId,
                          accountId,
                          bulkImportId: null,
                          createdAt: "2026-09-19T12:00:00.000Z",
                          openedAt: null,
                          memberCount: 3,
                          canAcknowledge: allowAck,
                        }
                      : null,
                  };
          } else if (name === "detail") {
            const item = [...rows, ...groupRows].find(
              (item) => item.key === input.key,
            )!;
            assert.ok(item, "Only a known request is read");
            assert.ok(
              !input.accountId || input.accountId === accountId,
              "Detail retains company binding",
            );
            result = {
              ok: true,
              request: { ...item, canAcknowledge: allowAck },
              record:
                item.kind === "service"
                  ? null
                  : {
                      state: "pending",
                      revision: 3,
                      reason:
                        "Please explain the charge for the extra collection.",
                    },
            };
          } else if (name === "service") {
            result = serviceFailure
              ? {
                  ok: false,
                  message:
                    "Request photos could not be verified. Reference: detail-fixture.",
                }
              : {
                  ok: true,
                  items: [],
                  nextCursor: null,
                  detail: {
                    id: rows[0]!.id,
                    accountId,
                    accountName: "Sample Bakery",
                    status: "requested",
                    createdAt: "2026-09-19T12:00:00.000Z",
                    service: "Facility cleanout",
                    siteName: "Bakery warehouse",
                    preferredWindows: rows[0]!.preferredWindows,
                    reasons: ["staff_confirmation_required"],
                    originalJob: null,
                    location: {
                      name: "Bakery warehouse",
                      timezone: "America/New_York",
                      address: {
                        line1: "100 Sample Road",
                        line2: null,
                        city: "Atlanta",
                        state: "GA",
                        postalCode: "30301",
                      },
                    },
                    description: "Collect twelve unused shelves.",
                    crewInstructions: "Keep the cold-room door closed.",
                    onSiteContact: {
                      name: "Morgan Lee",
                      phone: "+14045550100",
                      email: "morgan@example.test",
                    },
                    scopeFields: [],
                    proof: { before: 0, after: 2 },
                    photos: [],
                    appointment: {
                      id: "44444444-4444-4444-8444-444444444444",
                      type: "service",
                      startAt: null,
                      status: "requested",
                      version: "2026-09-19T12:00:00.000Z",
                    },
                    canSchedule: true,
                  },
                };
          } else if (name === "preview")
            result = previewFailure
              ? {
                  ok: false,
                  message:
                    "Arrival preview unavailable. Reference: preview-fixture.",
                }
              : {
                  ok: true,
                  startAt: `${input.preferredDate}T14:00:00.000Z`,
                  arrivalStartAt: `${input.preferredDate}T14:00:00.000Z`,
                  arrivalEndAt: `${input.preferredDate}T16:00:00.000Z`,
                  timezone: "America/New_York",
                };
          else if (name === "resources")
            result = {
              ok: true,
              data: {
                applicable: false,
                selectedResourceIds: [],
                resources: [],
              },
            };
          else if (name === "opened") result = { ok: true, opened: true };
          else throw new Error(`Unexpected fixture call: ${name}`);
          await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify(result),
          });
        });
        const base = `http://127.0.0.1:${port}/team/partners?p_admin=requests`;
        const list = page.locator('[aria-label="Request list"]');
        const ack = () => calls.filter((call) => call.name === "opened");
        try {
          await page.goto(base);
          await expect(list.locator("ul").getByRole("button")).toHaveCount(6);
          await expect(
            page.locator('[aria-label="6 requests needing attention"]'),
          ).toHaveCount(2);
          await expect(
            page.getByRole("combobox", { name: "Request type", exact: true }),
          ).toBeVisible();
          await fits(page);
          const artifacts = `${repo}/artifacts/partner-crm-requests`;
          mkdirSync(artifacts, { recursive: true });
          await page.screenshot({
            path: `${artifacts}/${engine.name()}-${width}-requests.png`,
            fullPage: true,
          });
          await page
            .getByRole("button", { name: /^Waiting on client/ })
            .click();
          await expect(list.locator("ul").getByRole("button")).toHaveCount(1);
          assert.equal(
            new URL(page.url()).searchParams.get("p_request_status"),
            "waiting_on_client",
          );
          await page.getByRole("button", { name: /^Handled/ }).click();
          await expect(list.locator("ul").getByRole("button")).toHaveCount(1);
          await page.getByRole("button", { name: /^Needs attention/ }).click();
          await expect(list.locator("ul").getByRole("button")).toHaveCount(6);
          await page
            .getByRole("combobox", { name: "Request type", exact: true })
            .selectOption("billing");
          await expect(list.locator("ul").getByRole("button")).toHaveCount(1);
          assert.equal(
            new URL(page.url()).searchParams.get("p_request_kind"),
            "billing",
          );
          await page
            .getByRole("combobox", { name: "Request type", exact: true })
            .selectOption("");
          await expect(list.locator("ul").getByRole("button")).toHaveCount(6);
          await page
            .getByRole("searchbox", { name: "Find company", exact: true })
            .fill("Unknown company");
          await page
            .getByRole("button", { name: "Search requests", exact: true })
            .click();
          await expect(
            page.getByText("No requests match these filters."),
          ).toBeVisible();
          await page
            .getByRole("searchbox", { name: "Find company", exact: true })
            .fill("Sample");
          await page
            .getByRole("button", { name: "Search requests", exact: true })
            .click();
          await expect(list.locator("ul").getByRole("button")).toHaveCount(6);
          listFailure = true;
          await page
            .getByRole("button", { name: "Refresh requests", exact: true })
            .click();
          await expect(
            page.getByText("Requests unavailable. Reference: inbox-fixture."),
          ).toBeVisible();
          await expect(list.locator("ul").getByRole("button")).toHaveCount(6);
          await expect(
            page.getByRole("button", { name: /^Needs attention/ }),
          ).toContainText("6");
          await page.evaluate(() => (window as any).__refreshCounts());
          await expect(
            page.locator('[aria-label="Request counts unavailable"]'),
          ).toHaveCount(2);
          await expect(
            page.getByText("No requests need attention."),
          ).toHaveCount(0);
          listFailure = false;
          malformed = true;
          await page
            .getByRole("button", { name: "Refresh requests", exact: true })
            .click();
          await expect(
            page.getByText("The response could not be verified. Try again."),
          ).toBeVisible();
          await expect(list.locator("ul").getByRole("button")).toHaveCount(6);
          malformed = false;
          await page
            .getByRole("button", { name: "Refresh requests", exact: true })
            .click();
          await page.evaluate(() => (window as any).__refreshCounts());
          await expect(
            page.locator('[aria-label="6 requests needing attention"]'),
          ).toHaveCount(2);
          const service = list
            .getByRole("button")
            .filter({ hasText: "Facility cleanout" });
          await service.focus();
          await service.press("Enter");
          await expect(
            page.getByRole("heading", {
              name: "Facility cleanout",
              exact: true,
            }),
          ).toBeFocused();
          await expect(
            page.getByText(/Request photos could not be verified/),
          ).toBeVisible();
          await frames(page);
          assert.equal(
            ack().length,
            0,
            "Opening a failed detail cannot suppress an owner reminder",
          );
          await visibility(page, true);
          serviceFailure = false;
          await page
            .getByRole("button", { name: "Try again", exact: true })
            .click();
          await expect(
            page.getByText("Collect twelve unused shelves.", { exact: true }),
          ).toBeVisible();
          await frames(page);
          assert.equal(
            ack().length,
            0,
            "A loaded detail in a hidden tab is not opened",
          );
          await visibility(page, false);
          await expect.poll(() => ack().length).toBe(1);
          assert.deepEqual(ack()[0]!.input, { bookingId: rows[0]!.id });
          await visibility(page, false);
          assert.equal(
            ack().length,
            1,
            "Repeated visibility events cannot duplicate opened writes",
          );
          await expect(
            page.getByRole("button", { name: "Confirm service", exact: true }),
          ).toBeDisabled();
          await page.getByLabel("New date", { exact: true }).fill("2026-10-03");
          await page.getByLabel("Eastern time", { exact: true }).fill("10:00");
          await expect(
            page.getByText(
              "Arrival preview unavailable. Reference: preview-fixture.",
            ),
          ).toBeVisible();
          await expect(
            page.getByRole("button", { name: "Confirm service", exact: true }),
          ).toBeDisabled();
          previewFailure = false;
          await page
            .getByRole("button", { name: "Retry arrival preview" })
            .click();
          await expect(
            page.getByRole("button", { name: "Confirm service", exact: true }),
          ).toBeEnabled();
          await expect(
            page.getByText(/Oct 3, 2026.*10:00\s*AM.*Oct 3, 2026.*12:00\s*PM/u),
          ).toBeVisible();
          await fits(page);
          await page.screenshot({
            path: `${artifacts}/${engine.name()}-${width}-review.png`,
            fullPage: true,
          });
          page.once("dialog", (dialog) => dialog.accept());
          await page.getByRole("button", { name: "Back to requests" }).click();
          await expect(list).toBeFocused();
          await list
            .getByRole("button")
            .filter({ hasText: "Billing questions" })
            .click();
          await expect(
            page.getByRole("heading", {
              name: "Billing questions",
              exact: true,
            }),
          ).toBeFocused();
          await page
            .getByRole("combobox", { name: "Decision", exact: true })
            .selectOption("information_provided");
          const note = page.getByLabel("Partner-visible outcome explanation", {
            exact: true,
          });
          await note.fill("We are checking the signed collection report.");
          await page
            .getByRole("button", { name: "Refresh requests", exact: true })
            .click();
          await expect(note).toHaveValue(
            "We are checking the signed collection report.",
          );
          page.once("dialog", (dialog) => dialog.dismiss());
          await page.getByRole("button", { name: "Back to requests" }).click();
          await expect(note).toBeVisible();
          await expect(note).toHaveValue(
            "We are checking the signed collection report.",
          );
          page.once("dialog", (dialog) => dialog.accept());
          await page.getByRole("button", { name: "Back to requests" }).click();
          await expect(list).toBeFocused();
          // A group is acknowledged only after every member has been rendered in a visible list.
          await visibility(page, true);
          await expect
            .poll(() =>
              page.evaluate(() => (window as any).__fixturePending || 0),
            )
            .toBe(0);
          calls.length = 0;
          await page.goto(`${base}&p_alert=${groupId}`);
          await expect(list.locator("ul").getByRole("button")).toHaveCount(2);
          await frames(page);
          assert.equal(
            ack().length,
            0,
            "Partial group page cannot mark unseen members opened",
          );
          await visibility(page, true);
          await page
            .getByRole("button", { name: "Load more requests" })
            .click();
          await expect(list.locator("ul").getByRole("button")).toHaveCount(3);
          await frames(page);
          assert.equal(
            ack().length,
            0,
            "A complete but hidden group is not opened",
          );
          await visibility(page, false);
          await expect.poll(() => ack().length).toBe(1);
          assert.deepEqual(ack()[0]!.input, { groupId });
          await visibility(page, false);
          assert.equal(ack().length, 1);
          // Nonrecipient staff can read permitted requests without acting as the alert recipient.
          allowAck = false;
          groupPaging = false;
          await visibility(page, true);
          await expect
            .poll(() =>
              page.evaluate(() => (window as any).__fixturePending || 0),
            )
            .toBe(0);
          calls.length = 0;
          await page.goto(`${base}&p_alert=${groupId}`);
          await expect(list.locator("ul").getByRole("button")).toHaveCount(3);
          await frames(page);
          assert.equal(ack().length, 0);
          await fits(page);
          assert.deepEqual(errors, [], "No browser runtime failures");
        } finally {
          await context.close();
          await browser.close();
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        }
      },
    );
