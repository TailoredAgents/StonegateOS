import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium, webkit, expect, type Page } from "@playwright/test";
import type {
  PartnerRequestDetails,
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
const crewId = "66666666-6666-4666-8666-666666666666";
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
      {
        localDate: "2026-10-05",
        timeOfDay: "morning",
        timezone: "America/New_York",
      },
      {
        localDate: "2026-10-06",
        timeOfDay: "anytime",
        timezone: "America/Chicago",
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
const submittedRequest: PartnerRequestDetails = {
  version: 1,
  jobId: rows[0]!.id,
  accountId,
  accountName: "Sample Bakery",
  service: {
    key: "cleanout",
    label: "Facility cleanout",
    tierKey: null,
    tierLabel: null,
  },
  publicStatus: "requested",
  confirmationMode: "review",
  originalJob: null,
  visibility: { financials: true, photos: true },
  location: {
    id: "55555555-5555-4555-8555-555555555555",
    name: "Bakery warehouse",
    externalPropertyId: null,
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
  onSiteContact: {
    name: "Morgan Lee",
    phone: "+14045550100",
    email: "morgan@example.test",
  },
  alternateContact: null,
  accessDetails: "Use the east loading dock.",
  crewInstructions: "Keep the cold-room door closed.",
  scope: {
    itemCount: null,
    volumeCubicYards: null,
    restrictedItems: false,
    nonStandard: false,
    hazardCategories: [],
    equipmentNeeds: ["loading_dock"],
    requiredCompletion: null,
    multiStop: false,
    multiStopDetails: null,
    additionalFields: [],
  },
  addOns: [],
  commercial: {
    poNumber: "PO-BAKERY-123",
    costCenter: null,
    projectReference: null,
    billingContact: null,
  },
  proof: { before: 0, after: 2, package: false },
  scheduling: {
    timezone: "America/New_York",
    preferredWindows: rows[0]!.preferredWindows,
    requestedWindow: null,
    confirmedWindow: null,
    confirmedStartAt: null,
    assistancePreference: "none",
  },
  photos: { count: 0, detailPath: null },
};
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
const entry = `import React from 'react';import{createRoot}from'react-dom/client';import{PartnerRequestInbox}from'./src/app/team/components/PartnerRequestInbox';import{PartnerAdministrationNavigation}from'./src/app/team/components/PartnerAdministrationNavigation';import{PartnerRequestBadge,PartnerRequestShortcut,refreshPartnerRequestCounts}from'./src/app/team/components/PartnerRequestSummary';
window.__refreshCounts=refreshPartnerRequestCounts;
const params=new URLSearchParams(location.search);const destinations=['requests','accounts','administration'].map((id,index)=>({id,label:['Requests','Companies','Administration'][index],href:'/team/partners?p_admin='+id,active:id==='requests'}));function App(){return <><main className="team-theme-light mx-auto min-h-screen max-w-6xl space-y-6 bg-slate-50 p-4 text-slate-950"><PartnerAdministrationNavigation destinations={destinations}/><PartnerRequestInbox initialRequestKey={params.get('p_request')||undefined} alertGroupId={params.get('p_alert')||undefined}/></main><aside aria-label="Count recovery test fixtures"><PartnerRequestBadge/><PartnerRequestBadge accountId="${accountId}"/><PartnerRequestShortcut/></aside></>}createRoot(document.getElementById('root')).render(<App/>);`;
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
          allowAck = true,
          confirmed = false,
          mutationFailure = true;
        const mutations: Array<{
          fields: Record<string, FormDataEntryValue>;
          key: string | undefined;
        }> = [];
        let releaseMutation: (() => void) | undefined;
        let releasePreview: (() => void) | undefined;
        let pauseNextPreview = false;
        let minimalRequest = false,
          unknownProof = false;
        let assistancePreference: "none" | "callback" | "waitlist" = "none";
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
              request: {
                ...item,
                ...(confirmed && item.key === rows[0]!.key
                  ? {
                      state: "confirmed",
                      stage: "handled",
                      statusLabel: "Scheduled",
                    }
                  : {}),
                canAcknowledge: allowAck,
              },
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
                    status: confirmed ? "confirmed" : "requested",
                    arrivalStartAt: confirmed
                      ? "2026-10-05T14:00:00.000Z"
                      : null,
                    arrivalEndAt: confirmed ? "2026-10-05T16:00:00.000Z" : null,
                    createdAt: "2026-09-19T12:00:00.000Z",
                    service: "Facility cleanout",
                    siteName: "Bakery warehouse",
                    preferredWindows: rows[0]!.preferredWindows,
                    reasons: ["manual_review_required"],
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
                    partnerRequest: {
                      ...submittedRequest,
                      publicStatus: confirmed ? "confirmed" : "requested",
                      ...(minimalRequest
                        ? {
                            onSiteContact: {
                              ...submittedRequest.onSiteContact!,
                              phone: null,
                            },
                            crewInstructions: "",
                            scope: {
                              ...submittedRequest.scope,
                              equipmentNeeds: [],
                            },
                            proof: {
                              before: unknownProof ? null : 0,
                              after: unknownProof ? null : 0,
                              package: false,
                            },
                          }
                        : {}),
                      scheduling: {
                        ...submittedRequest.scheduling,
                        assistancePreference,
                        confirmedWindow: confirmed
                          ? {
                              startAt: "2026-10-05T14:00:00.000Z",
                              endAt: "2026-10-05T16:00:00.000Z",
                            }
                          : null,
                        confirmedStartAt: confirmed
                          ? "2026-10-05T14:30:00.000Z"
                          : null,
                      },
                    },
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
                      startAt: confirmed ? "2026-10-05T14:30:00.000Z" : null,
                      status: confirmed ? "confirmed" : "requested",
                      version: "2026-09-19T12:00:00.000Z",
                    },
                    canSchedule: !confirmed,
                  },
                };
          } else if (name === "preview") {
            if (pauseNextPreview) {
              pauseNextPreview = false;
              await new Promise<void>((resolve) => {
                releasePreview = resolve;
              });
            }
            result = previewFailure
              ? {
                  ok: false,
                  message:
                    "Arrival preview unavailable. Reference: preview-fixture.",
                }
              : {
                  ok: true,
                  startAt: `${input.preferredDate}T14:30:00.000Z`,
                  arrivalStartAt: `${input.preferredDate}T14:00:00.000Z`,
                  arrivalEndAt: `${input.preferredDate}T16:00:00.000Z`,
                  timezone: "America/New_York",
                };
          } else if (name === "resources")
            result = {
              ok: true,
              data: {
                applicable: true,
                appointmentId: "44444444-4444-4444-8444-444444444444",
                requirements: [
                  {
                    kind: "crew",
                    quantity: 1,
                    capacityUnits: 1,
                    requiredSkillKeys: [],
                  },
                ],
                selectedResourceIds: [],
                resources: [
                  {
                    id: crewId,
                    label: "Crew Alpha",
                    kind: "crew",
                    capacityUnits: 1,
                    skillKeys: [],
                  },
                ],
                warning: null,
              },
            };
          else if (name === "opened") result = { ok: true, opened: true };
          else throw new Error(`Unexpected fixture call: ${name}`);
          await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify(result),
          });
        });
        await page.route(
          "**/api/team/appointments/reschedule",
          async (route) => {
            const request = route.request();
            const fields = await new Response(request.postDataBuffer(), {
              headers: { "content-type": request.headers()["content-type"]! },
            }).formData();
            mutations.push({
              fields: Object.fromEntries(fields),
              key: request.headers()["idempotency-key"],
            });
            if (mutationFailure) {
              await new Promise<void>((resolve) => {
                releaseMutation = resolve;
              });
              await route.fulfill({
                status: 503,
                contentType: "application/json",
                body: JSON.stringify({
                  ok: false,
                  error: "schedule_unavailable",
                  message:
                    "Scheduling unavailable. Reference: schedule-fixture.",
                }),
              });
            } else {
              confirmed = true;
              await route.fulfill({
                contentType: "application/json",
                body: JSON.stringify({
                  ok: true,
                  version: "2026-09-19T13:00:00.000Z",
                  calendarSync: "not_required",
                }),
              });
            }
          },
        );
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
          await page.getByRole("main").screenshot({
            path: `${artifacts}/${engine.name()}-${width}-requests.png`,
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
            page.getByText(/^No requests match these filters\./u),
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
          const listScroll = await page.evaluate(() => window.scrollY);
          await service.press("Enter");
          await expect(
            page.getByRole("heading", {
              name: "Facility cleanout",
              exact: true,
            }),
          ).toBeFocused();
          await expect(list).toBeHidden();
          await expect(list.locator("ul button")).toHaveCount(6);
          await expect(
            page.getByRole("searchbox", { name: "Find company", exact: true }),
          ).toHaveCount(0);
          await expect(
            page.getByRole("combobox", { name: "Request type", exact: true }),
          ).toHaveCount(0);
          await expect(
            page.getByRole("navigation", {
              name: "Request status",
              exact: true,
            }),
          ).toHaveCount(0);
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
          await expect(
            page.getByLabel("Service date", { exact: true }),
          ).toBeVisible();
          await expect(
            page.getByLabel("Planned start time", { exact: true }),
          ).toBeVisible();
          await expect(
            page.getByRole("link", { name: "Call Morgan Lee", exact: true }),
          ).toHaveAttribute("href", "tel:+14045550100");
          await expect(
            page.getByRole("link", { name: "Email Morgan Lee", exact: true }),
          ).toHaveAttribute("href", "mailto:morgan@example.test");
          await expect(
            page.getByText("No customer photos attached.", { exact: true }),
          ).toHaveCount(0);
          const submitted = page.locator(
            `[data-partner-request="${rows[0]!.id}"]`,
          );
          for (const title of [
            "Contact and access",
            "Work order and billing",
            "Job requirements",
          ]) {
            const summary = submitted
              .locator("summary")
              .filter({ hasText: new RegExp(`^${title}`) });
            await expect(summary.locator("..")).toHaveJSProperty("open", false);
          }
          await expect(
            submitted.locator("summary").filter({
              hasText:
                /^(?:Service details|Special requirements|Completion photos|Scheduling)/u,
            }),
          ).toHaveCount(0);
          if (width === 375) {
            await page
              .getByRole("button", { name: "Set schedule", exact: true })
              .click();
            await expect(
              page.getByRole("complementary", {
                name: "Service scheduling",
                exact: true,
              }),
            ).toBeFocused();
          }
          await expect(
            page.getByText("Client asked for a call to arrange service.", {
              exact: true,
            }),
          ).toHaveCount(0);
          await expect(
            page.getByText("Client asked to join the waitlist.", {
              exact: true,
            }),
          ).toHaveCount(0);
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
          const serviceDate = page.getByLabel("Service date", { exact: true });
          const plannedTime = page.getByLabel("Planned start time", {
            exact: true,
          });
          const firstRequestedDate = page.getByRole("button", {
            name: "Use date: Oct 3, 2026",
            exact: true,
          });
          const secondRequestedDate = page.getByRole("button", {
            name: "Use date: Oct 5, 2026",
            exact: true,
          });
          const otherTimezone = page.getByRole("button", {
            name: "Use date: Oct 6, 2026",
            exact: true,
          });
          await expect(firstRequestedDate).toHaveAccessibleDescription(
            "Client prefers afternoon",
          );
          await expect(otherTimezone).toBeDisabled();
          await expect(otherTimezone).toHaveAccessibleDescription(
            /Client is flexible on time.*Requested in America\/Chicago\. Enter the matching Eastern date below\./u,
          );
          await firstRequestedDate.focus();
          await firstRequestedDate.press("Enter");
          await expect(serviceDate).toHaveValue("2026-10-03");
          await expect(firstRequestedDate).toHaveAttribute(
            "aria-pressed",
            "true",
          );
          await expect(secondRequestedDate).toHaveAttribute(
            "aria-pressed",
            "false",
          );
          await expect(otherTimezone).toHaveAttribute("aria-pressed", "false");
          await expect(plannedTime).toHaveValue("");
          await expect(plannedTime).toBeFocused();
          assert.equal(
            mutations.length,
            0,
            "Choosing a client date never confirms service",
          );
          assert.equal(
            calls.filter((call) => call.name === "preview").length,
            0,
            "A date shortcut must not guess a planned time",
          );
          await expect(
            page.getByRole("button", { name: "Confirm service", exact: true }),
          ).toBeDisabled();
          const shortcutDialog = page.waitForEvent("dialog");
          const shortcutBack = page
            .getByRole("button", { name: "Back to requests" })
            .click();
          await (await shortcutDialog).dismiss();
          await shortcutBack;
          await expect(serviceDate).toHaveValue("2026-10-03");
          await expect(list).toBeHidden();
          await page
            .getByLabel("Planned start time", { exact: true })
            .fill("10:30");
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
            page.getByText(/Oct 3, 2026.*10:00\s*AM.*12:00\s*PM.*EDT/u),
          ).toBeVisible();
          const previewsBeforeShortcut = calls.filter(
            (call) => call.name === "preview",
          ).length;
          pauseNextPreview = true;
          await secondRequestedDate.click();
          await expect(serviceDate).toHaveValue("2026-10-05");
          await expect(firstRequestedDate).toHaveAttribute(
            "aria-pressed",
            "false",
          );
          await expect(secondRequestedDate).toHaveAttribute(
            "aria-pressed",
            "true",
          );
          await expect(plannedTime).toHaveValue("10:30");
          await expect(plannedTime).toBeFocused();
          await expect
            .poll(() => calls.filter((call) => call.name === "preview").length)
            .toBeGreaterThan(previewsBeforeShortcut);
          await expect(
            page.getByRole("button", { name: "Confirm service", exact: true }),
          ).toBeDisabled();
          assert.ok(
            releasePreview,
            "The changed date must request a fresh preview before confirmation",
          );
          releasePreview();
          const latestPreview = calls
            .filter((call) => call.name === "preview")
            .at(-1)!;
          assert.equal(latestPreview.input.preferredDate, "2026-10-05");
          assert.equal(latestPreview.input.startTime, "10:30");
          await expect(
            page.getByText(/Oct 5, 2026.*10:00\s*AM.*12:00\s*PM.*EDT/u),
          ).toBeVisible();
          assert.equal(
            mutations.length,
            0,
            "Date and time editing only requests an arrival preview",
          );
          const resourceSummary = page
            .locator("summary")
            .filter({ hasText: /^Crew, truck & equipment/u });
          await expect(resourceSummary.locator("..")).toHaveJSProperty(
            "open",
            false,
          );
          await expect(
            page.locator('input[name="resourceSelectionMode"]'),
          ).toHaveCount(0);
          await resourceSummary.focus();
          await resourceSummary.press("Enter");
          await page
            .getByRole("checkbox", {
              name: "Choose crew, truck or equipment",
              exact: true,
            })
            .check();
          const crew = page.getByRole("checkbox", { name: /Crew Alpha/u });
          await crew.check();
          await resourceSummary.focus();
          await resourceSummary.press("Enter");
          await expect(resourceSummary.locator("..")).toHaveJSProperty(
            "open",
            false,
          );
          const selectedResources = await page
            .getByRole("button", { name: "Confirm service", exact: true })
            .evaluate((button) => {
              const form = button.closest("form");
              if (!form) throw Error("Confirmation must have a form");
              const data = new FormData(form);
              return {
                mode: data.get("resourceSelectionMode"),
                startTime: data.get("startTime"),
                preferredDate: data.get("preferredDate"),
                ids: data.getAll("selectedResourceIds"),
              };
            });
          assert.deepEqual(
            selectedResources,
            {
              mode: "manual",
              startTime: "10:30",
              preferredDate: "2026-10-05",
              ids: [crewId],
            },
            "Collapsing optional resource choices preserves the exact confirmation input",
          );
          await fits(page);
          await page.getByRole("main").screenshot({
            path: `${artifacts}/${engine.name()}-${width}-review.png`,
          });
          page.once("dialog", (dialog) => dialog.accept());
          await page.getByRole("button", { name: "Back to requests" }).click();
          await expect(list).toBeFocused();
          await expect(
            page.getByRole("searchbox", { name: "Find company", exact: true }),
          ).toHaveValue("Sample");
          await expect(
            page.getByRole("combobox", { name: "Request type", exact: true }),
          ).toHaveValue("");
          await expect
            .poll(() => page.evaluate(() => window.scrollY))
            .toBe(listScroll);
          for (const preference of ["waitlist", "callback"] as const) {
            assistancePreference = preference;
            minimalRequest = true;
            unknownProof = preference === "callback";
            await service.click();
            const requestedHelp =
              preference === "waitlist"
                ? "Client asked to join the waitlist."
                : "Client asked for a call to arrange service.";
            await expect(
              page.getByText(requestedHelp, { exact: true }),
            ).toBeVisible();
            await expect(
              page.getByRole("link", { name: "Call Morgan Lee", exact: true }),
            ).toHaveCount(0);
            await expect(
              page.getByRole("link", { name: "Email Morgan Lee", exact: true }),
            ).toHaveAttribute("href", "mailto:morgan@example.test");
            const requirementSummary = page
              .locator("summary")
              .filter({ hasText: /^Job requirements/u });
            if (unknownProof) {
              await expect(requirementSummary).toBeVisible();
              await requirementSummary.click();
              await expect(
                page.getByText("Not recorded", { exact: true }).first(),
              ).toBeVisible();
            } else {
              await expect(requirementSummary).toHaveCount(0);
            }
            await expect(
              page.getByText("No customer photos attached.", { exact: true }),
            ).toHaveCount(0);
            await page
              .getByRole("button", { name: "Back to requests" })
              .click();
            await expect(list).toBeFocused();
          }
          assistancePreference = "none";
          minimalRequest = false;
          unknownProof = false;
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
          const readsBeforeRefresh = calls.filter(
            (call) => call.name === "list",
          ).length;
          await visibility(page, true);
          await visibility(page, false);
          await expect
            .poll(() => calls.filter((call) => call.name === "list").length)
            .toBeGreaterThan(readsBeforeRefresh);
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
          // Confirmation uses the actual form transport. A failed response must
          // retain edits and the same retry identity; only verified success can
          // replace the form with the confirmed arrival window.
          await service.click();
          await secondRequestedDate.click();
          await plannedTime.fill("10:30");
          const confirmService = page.getByRole("button", {
            name: "Confirm service",
            exact: true,
          });
          await expect(confirmService).toBeEnabled();
          assert.equal(mutations.length, 0);
          await confirmService.click();
          await expect.poll(() => mutations.length).toBe(1);
          await expect(serviceDate).toBeDisabled();
          await expect(plannedTime).toBeDisabled();
          await expect(firstRequestedDate).toBeDisabled();
          await expect(secondRequestedDate).toBeDisabled();
          assert.ok(releaseMutation);
          releaseMutation();
          await expect(
            page.getByText(/Scheduling unavailable.*schedule-fixture/u),
          ).toBeVisible();
          await expect(serviceDate).toHaveValue("2026-10-05");
          await expect(plannedTime).toHaveValue("10:30");
          await expect(
            page.getByRole("heading", {
              name: "Service confirmed",
              exact: true,
            }),
          ).toHaveCount(0);
          assert.equal(mutations.length, 1);
          assert.equal(mutations[0]!.fields["preferredDate"], "2026-10-05");
          assert.equal(mutations[0]!.fields["startTime"], "10:30");
          assert.equal(
            mutations[0]!.fields["appointmentId"],
            "44444444-4444-4444-8444-444444444444",
          );
          assert.ok(
            mutations[0]!.key,
            "A scheduling attempt carries an idempotency key",
          );
          const failedLeaveDialog = page.waitForEvent("dialog");
          const failedBack = page
            .getByRole("button", { name: "Back to requests" })
            .click();
          await (await failedLeaveDialog).dismiss();
          await failedBack;
          await expect(plannedTime).toHaveValue("10:30");
          mutationFailure = false;
          await confirmService.click();
          await expect(
            page.getByRole("heading", {
              name: "Service confirmed",
              exact: true,
            }),
          ).toBeVisible();
          assert.equal(mutations.length, 2);
          assert.equal(
            mutations[1]!.key,
            mutations[0]!.key,
            "Retrying unchanged failed work reuses its original operation",
          );
          assert.deepEqual(mutations[1]!.fields, mutations[0]!.fields);
          await expect(
            page.getByText(
              /Confirmed arrival:.*Oct 5, 2026.*10:00\s*AM.*12:00\s*PM.*Eastern/u,
            ),
          ).toBeVisible();
          await expect(confirmService).toHaveCount(0);
          await expect(
            page.getByRole("complementary", {
              name: "Service scheduling",
              exact: true,
            }),
          ).toBeFocused();
          const calendarHref = await page
            .getByRole("link", { name: "Open in calendar", exact: true })
            .getAttribute("href");
          assert.ok(calendarHref);
          const calendarUrl = new URL(calendarHref, base);
          assert.equal(calendarUrl.pathname, "/team/calendar");
          assert.equal(calendarUrl.searchParams.get("cal"), "2026-10-05");
          assert.equal(
            calendarUrl.searchParams.get("eventId"),
            "db:44444444-4444-4444-8444-444444444444",
          );
          const schedulingDetails = page
            .locator("summary")
            .filter({ hasText: /^Scheduling details$/u });
          await expect(schedulingDetails.locator("..")).toHaveJSProperty(
            "open",
            false,
          );
          await fits(page);
          await page.getByRole("main").screenshot({
            path: `${artifacts}/${engine.name()}-${width}-confirmed.png`,
          });
          let staleDirtyDialog = false;
          const unexpectedDialog = async (
            dialog: import("@playwright/test").Dialog,
          ) => {
            staleDirtyDialog = true;
            await dialog.dismiss();
          };
          page.on("dialog", unexpectedDialog);
          await page.getByRole("button", { name: "Back to requests" }).click();
          await expect(list).toBeFocused();
          page.off("dialog", unexpectedDialog);
          assert.equal(
            staleDirtyDialog,
            false,
            "Confirmed work no longer warns that its schedule is unsaved",
          );
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
