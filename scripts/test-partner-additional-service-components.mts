import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium, webkit, type BrowserType } from "@playwright/test";

const repo = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/u, "");
const require = createRequire(`${repo}/package.json`);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const source = "11111111-1111-4111-8111-111111111111";
const child = "22222222-2222-4222-8222-222222222222";
const other = "33333333-3333-4333-8333-333333333333";
const draftId = "44444444-4444-4444-8444-444444444444";
const summary = (id: string) => ({
  id,
  status: "under_review",
  serviceKey: "service_request",
  createdAt: "2026-09-09T12:00:00.000Z",
});

async function browserHarness(engine: BrowserType, staff = false) {
  const bundle = await build({
    stdin: {
      contents: staff
        ? `import React from'react';import{createRoot}from'react-dom/client';import{PartnerServiceReviews}from'./src/app/team/components/PartnerServiceReviews';createRoot(document.getElementById('root')).render(<main><h1>Staff service requests</h1><PartnerServiceReviews canSchedule/></main>);`
        : `import React from'react';import{createRoot}from'react-dom/client';import{PartnerAdditionalService}from'./src/app/partners/components/PartnerAdditionalService';
      function App(){const[state,setState]=React.useState({accountId:'account-a',membershipId:'membership-a',jobId:'${source}',allowedActions:['request_additional_service'],actionAvailability:[{action:'request_additional_service',allowed:true,reason:{code:'available',label:'Available'}}]});React.useEffect(()=>{window.__replace=(patch)=>setState((value)=>({...value,...patch}))},[]);return <main><h1>Job details</h1><PartnerAdditionalService {...state}/></main>}createRoot(document.getElementById('root')).render(<App/>);`,
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
        name: "local-next-boundaries",
        setup(builder) {
          builder.onResolve(
            {
              filter:
                /^(\.\.\/actions\/partner-service-reviews|\.\/CalendarAppointmentActions)$/,
            },
            (args) => ({ path: args.path, namespace: "staff-local" }),
          );
          builder.onLoad(
            { filter: /.*/, namespace: "staff-local" },
            (args) => ({
              loader: "js",
              resolveDir: `${repo}/apps/site`,
              contents: args.path.includes("actions/")
                ? `export const loadPartnerServiceReviews=(input={})=>fetch('/api/partners/portal/test-staff-review?'+new URLSearchParams(input)).then(response=>response.json())`
                : `import React from'react';export const CalendarAppointmentActions=()=>React.createElement('p',null,'Existing CRM scheduler')`,
            }),
          );
          builder.onResolve(
            { filter: /^next\/(link|navigation)$/ },
            (args) => ({ path: args.path, namespace: "next-local" }),
          );
          builder.onLoad({ filter: /.*/, namespace: "next-local" }, (args) => ({
            loader: "js",
            resolveDir: `${repo}/apps/site`,
            contents:
              args.path === "next/link"
                ? `import React from'react';export default function Link({children,href,...props}){return React.createElement('a',{...props,href},children)}`
                : `export const useRouter=()=>({push:(url)=>{window.__destinations=(window.__destinations||[]).concat(url)},refresh(){}});`,
          }));
        },
      },
    ],
  });
  const controls = {
    failPost: true,
    failMore: true,
    holdPost: false,
    failOriginal: true,
    held: [] as (() => void)[],
    requests: [] as {
      path: string;
      method: string;
      key: string | undefined;
      body: string;
    }[],
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://local.test");
    if (url.pathname === "/client.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(bundle.outputFiles[0].contents);
      return;
    }
    if (url.pathname.startsWith("/api/partners/portal/")) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      controls.requests.push({
        path: url.pathname + url.search,
        method: request.method ?? "GET",
        key: request.headers["idempotency-key"] as string | undefined,
        body: Buffer.concat(chunks).toString(),
      });
      const reply = (value: unknown, status = 200) => {
        response.statusCode = status;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(value));
      };
      const fail = () =>
        reply(
          {
            ok: false,
            error: "service_unavailable",
            message: "Synthetic uncertain response",
            retryable: true,
          },
          503,
        );
      if (url.pathname.endsWith("/test-staff-review")) {
        const id = url.searchParams.get("id");
        const isOriginal = id === source;
        const base = {
          id: child,
          accountId: "account-a",
          accountName: "Example partner",
          status: "under_review",
          createdAt: summary(child).createdAt,
          service: "Additional cleanout",
          siteName: "Example location",
          preferredWindows: [],
          reasons: [],
          originalJob: summary(source),
        };
        if (isOriginal && controls.failOriginal) {
          reply({ ok: false, message: "Synthetic original-job load failure" });
          return;
        }
        reply({
          ok: true,
          items: id ? [] : [base],
          nextCursor: null,
          detail: id
            ? {
                ...base,
                id,
                service: isOriginal ? "Original completed work" : base.service,
                status: isOriginal ? "completed" : "under_review",
                originalJob: isOriginal ? null : base.originalJob,
                location: null,
                description: isOriginal
                  ? "The original completed scope"
                  : "Separate new work only",
                crewInstructions: "",
                onSiteContact: {
                  name: "Example contact",
                  phone: "4045550100",
                  email: "example@example.test",
                },
                scopeFields: [],
                proof: { before: 1, after: 1 },
                photos: [],
                appointment: {
                  id,
                  type: null,
                  startAt: null,
                  status: isOriginal ? "completed" : "requested",
                  version: "2026-09-09T12:00:00.000Z",
                },
                canSchedule: !isOriginal,
              }
            : null,
        });
        return;
      }
      if (request.method === "POST") {
        const respond = () =>
          controls.failPost
            ? fail()
            : reply(
                {
                  ok: true,
                  draft: {
                    id: draftId,
                    additionalServiceFromJobId: url.pathname.includes(source)
                      ? source
                      : other,
                  },
                },
                201,
              );
        if (controls.holdPost) controls.held.push(respond);
        else respond();
      } else if (url.pathname.includes(other)) {
        reply({
          ok: true,
          originalJob: summary(source),
          jobs: [],
          page: { limit: 25, hasMore: false, nextCursor: null },
        });
      } else if (url.searchParams.has("cursor")) {
        if (controls.failMore) fail();
        else
          reply({
            ok: true,
            originalJob: null,
            jobs: [summary(other)],
            page: { limit: 25, hasMore: false, nextCursor: null },
          });
      } else
        reply({
          ok: true,
          originalJob: null,
          jobs: [summary(child)],
          page: { limit: 25, hasMore: true, nextCursor: "next-page" },
        });
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(
      '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui;margin:16px}svg{width:20px;height:20px}button,a{min-height:44px}button{padding:12px}li{margin:8px 0}</style></head><body><div id="root"></div><script src="/client.js"></script></body></html>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const browser = await engine.launch();
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    `http://127.0.0.1:${address.port}/partners/bookings/${source}`,
  );
  return {
    page,
    controls,
    errors,
    async close() {
      for (const release of controls.held.splice(0)) release();
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

for (const engine of [chromium, webkit]) {
  void test(
    `${engine.name()}: additional service requires both authority descriptors and durable retry storage`,
    { timeout: 60_000 },
    async () => {
      const { page, controls, errors, close } = await browserHarness(engine);
      try {
        await page
          .getByRole("button", {
            name: "Request additional service",
            exact: true,
          })
          .waitFor();
        await page.evaluate(() =>
          (
            window as unknown as { __replace: (patch: object) => void }
          ).__replace({
            actionAvailability: [
              {
                action: "request_additional_service",
                allowed: false,
                reason: {
                  code: "permission_required",
                  label: "Role does not allow this action",
                },
              },
            ],
          }),
        );
        assert.equal(
          await page
            .getByRole("button", {
              name: "Request additional service",
              exact: true,
            })
            .count(),
          0,
        );
        await page.evaluate(() => {
          (
            window as unknown as { __replace: (patch: object) => void }
          ).__replace({
            actionAvailability: [
              {
                action: "request_additional_service",
                allowed: true,
                reason: { code: "available", label: "Available" },
              },
            ],
          });
          Object.defineProperty(Storage.prototype, "setItem", {
            configurable: true,
            value() {
              throw new DOMException(
                "Synthetic blocked storage",
                "SecurityError",
              );
            },
          });
        });
        await page
          .getByRole("button", {
            name: "Request additional service",
            exact: true,
          })
          .click();
        await page.getByText(/couldn’t safely open the request/u).waitFor();
        await page
          .getByRole("button", {
            name: "Request additional service",
            exact: true,
          })
          .click();
        assert.equal(
          controls.requests.filter((request) => request.method === "POST")
            .length,
          0,
        );
        assert.deepEqual(errors, []);
      } finally {
        await close();
      }
    },
  );

  void test(
    `${engine.name()}: staff reads original job safely and returns to the separate request`,
    { timeout: 60_000 },
    async () => {
      const { page, controls, errors, close } = await browserHarness(
        engine,
        true,
      );
      try {
        await page
          .getByRole("button", {
            name: /Example partner · Additional cleanout/u,
          })
          .click();
        await page
          .getByText("Existing CRM scheduler", { exact: true })
          .waitFor();
        await page
          .getByRole("button", { name: "View original job 11111111" })
          .click();
        await page
          .getByText("Synthetic original-job load failure", { exact: true })
          .waitFor();
        controls.failOriginal = false;
        await page
          .getByRole("button", { name: "View original job 11111111" })
          .click();
        await page
          .getByRole("heading", {
            name: "Example partner · Original completed work",
          })
          .waitFor();
        assert.equal(
          await page
            .getByText("Existing CRM scheduler", { exact: true })
            .count(),
          0,
        );
        await page
          .getByRole("button", { name: "Return to additional service request" })
          .click();
        await page
          .getByRole("heading", {
            name: "Example partner · Additional cleanout",
          })
          .waitFor();
        assert.equal(
          await page
            .getByText("Existing CRM scheduler", { exact: true })
            .count(),
          1,
        );
        const originalReads = controls.requests.filter((request) =>
          request.path.includes(`id=${source}`),
        );
        assert.equal(originalReads.length, 2);
        assert.ok(
          originalReads.every(
            (request) =>
              request.method === "GET" &&
              request.path.includes("accountId=account-a"),
          ),
        );
        assert.deepEqual(errors, []);
      } finally {
        await close();
      }
    },
  );

  void test(
    `${engine.name()}: additional-service retries survive reload and preserve original billing`,
    { timeout: 60_000 },
    async () => {
      const { page, controls, errors, close } = await browserHarness(engine);
      try {
        await page
          .getByRole("button", {
            name: "Request additional service",
            exact: true,
          })
          .click();
        await page.getByText(/Synthetic uncertain response/u).waitFor();
        const first = controls.requests.find(
          (entry) => entry.method === "POST",
        );
        assert.ok(first?.key);
        assert.equal(first.body, "{}");
        await page.reload();
        controls.failPost = false;
        await page
          .getByRole("button", {
            name: "Request additional service",
            exact: true,
          })
          .click();
        await page.waitForFunction(() =>
          Boolean(
            (window as unknown as { __destinations?: string[] }).__destinations
              ?.length,
          ),
        );
        const mutations = controls.requests.filter(
          (entry) => entry.method === "POST",
        );
        assert.equal(mutations.length, 2);
        assert.equal(mutations[1]?.key, first.key);
        assert.deepEqual(
          await page.evaluate(
            () =>
              (window as unknown as { __destinations: string[] })
                .__destinations,
          ),
          [`/partners/book?draftId=${draftId}`],
        );
        assert.match(
          await page.locator("body").innerText(),
          /original bill and payment stay unchanged/u,
        );
        assert.equal(await page.evaluate(() => sessionStorage.length), 0);
        assert.deepEqual(errors, []);
      } finally {
        await close();
      }
    },
  );

  void test(
    `${engine.name()}: related-job pagination retries and stale account responses stay isolated`,
    { timeout: 60_000 },
    async () => {
      const { page, controls, errors, close } = await browserHarness(engine);
      try {
        await page.getByRole("link", { name: /22222222/u }).waitFor();
        await page
          .getByRole("button", { name: "Load more additional jobs" })
          .click();
        await page
          .getByRole("button", { name: "Try related jobs again" })
          .waitFor();
        assert.equal(
          await page.getByRole("link", { name: /22222222/u }).count(),
          1,
        );
        controls.failMore = false;
        await page
          .getByRole("button", { name: "Try related jobs again" })
          .click();
        await page.getByRole("link", { name: /33333333/u }).waitFor();
        assert.equal(
          await page
            .getByRole("button", { name: "Load more additional jobs" })
            .count(),
          0,
        );
        const pages = controls.requests.filter((entry) =>
          entry.path.includes("cursor="),
        );
        assert.equal(pages.length, 2);
        assert.equal(pages[0]?.path, pages[1]?.path);
        controls.failPost = false;
        controls.holdPost = true;
        await page
          .getByRole("button", {
            name: "Request additional service",
            exact: true,
          })
          .click();
        await page.waitForFunction(() =>
          document.body.textContent?.includes("Opening request…"),
        );
        await page.evaluate(
          ({ next }) =>
            (
              window as unknown as { __replace: (patch: object) => void }
            ).__replace({
              accountId: "account-b",
              membershipId: "member-b",
              jobId: next,
              allowedActions: [],
            }),
          { next: other },
        );
        await page
          .getByRole("link", { name: /original job 11111111/u })
          .waitFor();
        for (const release of controls.held.splice(0)) release();
        await page.waitForTimeout(100);
        assert.equal(
          await page.getByRole("link", { name: /22222222/u }).count(),
          0,
        );
        assert.equal(
          await page
            .getByRole("button", {
              name: "Request additional service",
              exact: true,
            })
            .count(),
          0,
        );
        assert.deepEqual(
          await page.evaluate(
            () =>
              (window as unknown as { __destinations?: string[] })
                .__destinations ?? [],
          ),
          [],
        );
        assert.deepEqual(errors, []);
      } finally {
        await close();
      }
    },
  );
}

void test("staff actions forward the selected change-order quote, never inject it into cancellation", async () => {
  const requests: { path: string; init: RequestInit }[] = [];
  const notices: object[] = [];
  const bundle = await build({
    entryPoints: [
      `${repo}/apps/site/src/app/team/actions/partner-administration.ts`,
    ],
    absWorkingDir: `${repo}/apps/site`,
    tsconfig: `${repo}/apps/site/tsconfig.json`,
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    logLevel: "error",
    plugins: [
      {
        name: "local-action-boundaries",
        setup(builder) {
          builder.onResolve(
            {
              filter:
                /^(next\/(headers|cache)|@\/lib\/team-principal|\.\.\/lib\/(api|mutation-feedback))$/,
            },
            (args) => ({ path: args.path, namespace: "action-local" }),
          );
          builder.onLoad(
            { filter: /.*/, namespace: "action-local" },
            (args) => ({
              loader: "js",
              contents:
                args.path === "next/headers"
                  ? "export const cookies=()=>Promise.resolve({set:value=>globalThis.testHarness.notices.push(value)})"
                  : args.path === "next/cache"
                    ? "export function revalidatePath(){}"
                    : args.path.includes("team-principal")
                      ? "export const hasTeamPermission=()=>true;export const requireCurrentTeamPrincipal=()=>Promise.resolve({})"
                      : args.path.endsWith("/api")
                        ? "export const callAdminApiAs=(_principal,path,init)=>{globalThis.testHarness.requests.push({path,init});return Promise.resolve(new Response('{}',{status:503}))}"
                        : "export const readTeamMutationError=()=>Promise.resolve('Synthetic API receipt');export const readTeamMutationException=()=>'';export const readTeamMutationSuccess=()=>Promise.resolve(null)",
            }),
          );
        },
      },
    ],
  });
  const module = {
    exports: {} as Record<string, (form: FormData) => Promise<void>>,
  };
  new Function("module", "exports", "globalThis", bundle.outputFiles[0].text)(
    module,
    module.exports,
    { testHarness: { requests, notices } },
  );
  const form = (decision: string, confirmation: string, quoteId?: string) => {
    const data = new FormData();
    for (const [key, value] of Object.entries({
      requestId: source,
      expectedVersion: "1",
      idempotencyKey: `test-job-change:${source}`,
      decision,
      confirmation,
      reason: "Verified the exact partner request.",
    }))
      data.set(key, value);
    if (quoteId !== undefined) data.set("partnerQuoteId", quoteId);
    return data;
  };
  await module.exports.partnerJobChangeRequestDecisionAction!(
    form("change_order_required", "REQUIRE CHANGE ORDER", child),
  );
  assert.equal(requests.length, 1);
  assert.equal(
    JSON.parse(String(requests[0]!.init.body)).partnerQuoteId,
    child,
  );
  await module.exports.partnerJobChangeRequestDecisionAction!(
    form("change_order_required", "REQUIRE CHANGE ORDER"),
  );
  await module.exports.partnerJobChangeRequestDecisionAction!(
    form("approved", "APPROVE JOB CHANGE", child),
  );
  assert.equal(
    requests.length,
    1,
    "Missing or inappropriate quotes must not reach the API",
  );
  await module.exports.partnerCancellationRequestDecisionAction!(
    form("approved", "APPROVE CANCELLATION"),
  );
  assert.equal(requests.length, 2);
  assert.deepEqual(JSON.parse(String(requests[1]!.init.body)), {
    decision: "approved",
    confirmation: "APPROVE CANCELLATION",
    reason: "Verified the exact partner request.",
  });
  assert.equal(new Headers(requests[0]!.init.headers).get("If-Match"), "1");
});
