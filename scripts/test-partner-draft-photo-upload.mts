import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium, webkit, expect, type Page } from "@playwright/test";
import tailwindConfig from "../apps/site/tailwind.config";

const repo = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(`${repo}/package.json`);
const siteRequire = createRequire(`${repo}/apps/site/package.json`);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const theme =
  "default" in tailwindConfig ? tailwindConfig.default : tailwindConfig;
const draftId = "11111111-1111-4111-8111-111111111116";
const photoId = "photo-transfer";
const photo = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4HsAAAAASUVORK5CYII=",
  "base64",
);
const initialDraft = {
  id: draftId,
  state: "draft",
  etag: '"draft-1"',
  revision: 1,
  rescheduleFromJobId: null,
  additionalServiceFromJobId: null,
  locationId: "photo-location",
  serviceKey: "service_request",
  tierKey: null,
  selectedAddOns: [],
  scope: {},
  description:
    "Keep this request and reference photo until attachment is verified.",
  crewInstructions: null,
  accessDetails: null,
  onSiteContact: { name: "Morgan Lee", phone: "+14045550100", email: "" },
  proofRequirements: { before: 0, after: 0, package: false },
  commercial: {},
  preferredWindows: [],
  scheduleAssistancePreference: "none",
  reviewReasons: [],
  validation: {},
  expiresAt: null,
  submittedAt: null,
  createdAt: "2026-09-15T12:00:00Z",
  updatedAt: "2026-09-15T12:00:00Z",
};
const attachedPhoto = {
  id: photoId,
  category: "issue",
  caption: "Preserve this photo note.",
  sortOrder: 0,
  status: "ready",
  filename: "reference.png",
  contentType: "image/png",
  byteSize: photo.length,
  width: 1,
  height: 1,
  sha256: null,
  createdAt: initialDraft.createdAt,
  readyAt: initialDraft.createdAt,
  error: null,
  downloadIntent: null,
};
const entry = `import React from 'react';import{createRoot}from'react-dom/client';
import{PartnerBookingWizard}from'./src/app/partners/components/PartnerBookingWizard';
const draft=${JSON.stringify(initialDraft)};
function App(){return <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6"><PartnerBookingWizard
 initialDraft={draft} locations={[{id:'photo-location',name:'Test facility',address:'1 Local Photo Way, Atlanta, GA 30301'}]}
 services={[{key:'service_request',label:'Request service',bookable:true,priceState:'estimate',pricingStatus:'review_required',agreement:null,inclusions:[],exclusions:[],quoteRule:null,baseOptions:[],addOns:[]}]}
 canUploadPhotos persona="commercial_client" cancellationPolicy={{minimumNoticeMinutes:0,directCancellationEnabled:false,lateCancellationDisposition:'staff_review',automaticFeeMinor:null,source:'unconfigured',revision:null}}
 supportPhoneE164="+14045550100" supportPhoneDisplay="404-555-0100"/></main>}
createRoot(document.getElementById('root')).render(<App/>);`;

let compiled: Promise<{ script: Uint8Array; css: string }> | undefined;
function assets() {
  return (compiled ??= (async () => {
    const [bundle, styles] = await Promise.all([
      build({
        stdin: {
          contents: entry,
          loader: "tsx",
          resolveDir: `${repo}/apps/site`,
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
            name: "next-test-boundaries",
            setup(builder: any) {
              builder.onResolve(
                { filter: /^next\/(link|navigation)$/ },
                (args: any) => ({ path: args.path, namespace: "fixture" }),
              );
              builder.onLoad(
                { filter: /.*/, namespace: "fixture" },
                (args: any) => ({
                  loader: "js",
                  resolveDir: `${repo}/apps/site`,
                  contents:
                    args.path === "next/link"
                      ? "import React from'react';export default function Link({href,children,...props}){return React.createElement('a',{...props,href},children)}"
                      : "export const useRouter=()=>({refresh(){},push(){}});export const usePathname=()=>location.pathname;",
                }),
              );
            },
          },
        ],
      }),
      siteRequire("postcss")([
        siteRequire("tailwindcss")({
          ...theme,
          content: [
            `${repo}/apps/site/src/app/partners/**/*.tsx`,
            `${repo}/packages/ui/src/**/*.tsx`,
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

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function assertPending(page: Page) {
  await expect(page.getByText("Saved", { exact: true })).toHaveCount(0);
  await page
    .getByRole("button", { name: "Continue to scheduling", exact: true })
    .click();
  await expect(page.locator("[data-booking-step]")).toHaveAttribute(
    "data-booking-step",
    "1",
  );
  await expect(
    page.getByRole("img", {
      name: "Selected photo: reference.png",
      exact: true,
    }),
  ).toBeVisible();
}

async function assertAttached(page: Page) {
  await expect(
    page.getByText("Photos attached to this saved request.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", {
      name: "Selected photo: reference.png",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Preserve this photo note.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();
  await page
    .getByRole("button", { name: "Continue to scheduling", exact: true })
    .click();
  await expect(page.locator("[data-booking-step]")).toHaveAttribute(
    "data-booking-step",
    "2",
  );
}

const scenarios = [
  "delayed",
  "intent_failure",
  "put_failure",
  "finalize_failure",
  "lost_finalize",
  "read_failure",
  "malformed_read",
  "wrong_id_read",
  "resume",
] as const;

for (const engine of [chromium, webkit]) {
  for (const width of [1440, 375]) {
    void test(
      `${engine.name()} ${width}px: photo transfer phases, verified attachment and safe retry`,
      { timeout: 90_000 },
      async () => {
        const built = await assets();
        let handleStorage: (
          request: IncomingMessage,
          response: ServerResponse,
        ) => Promise<void> = async (_request, response) => {
          response.writeHead(500).end();
        };
        const server = createServer((request, response) => {
          const path = new URL(request.url ?? "/", "http://localhost").pathname;
          if (path === "/storage/upload") {
            void handleStorage(request, response).catch((error) => {
              response.writeHead(500).end();
              process.stderr.write(
                `Local storage fixture failed: ${String(error)}\n`,
              );
            });
          } else if (path === "/client.js") {
            response.setHeader("Content-Type", "text/javascript");
            response.end(built.script);
          } else if (path === "/styles.css") {
            response.setHeader("Content-Type", "text/css");
            response.end(built.css);
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
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const base = `http://127.0.0.1:${address.port}`;
        const browser = await engine.launch();
        try {
          for (const scenario of scenarios) {
            const page = await browser.newPage({
              viewport: { width, height: 1000 },
              hasTouch: width === 375,
              isMobile: width === 375,
            });
            page.setDefaultTimeout(8_000);
            const pageErrors: string[] = [];
            page.on("pageerror", (error) => pageErrors.push(error.message));
            const intentGate = gate(),
              putGate = gate(),
              finalizeGate = gate(),
              readGate = gate();
            let saved: Record<string, any> = structuredClone(initialDraft);
            let mediaReady = false,
              putCompleted = scenario === "resume";
            let puts = 0,
              finalizes = 0,
              reads = 0,
              validations = 0;
            const intents: { key: string | undefined; body: any }[] = [];
            const finalizeKeys: (string | undefined)[] = [];
            const xhrMethods: string[] = [];
            page.on("request", (request) => {
              if (new URL(request.url()).pathname === "/storage/upload")
                xhrMethods.push(
                  `${request.method()}:${request.resourceType()}`,
                );
            });
            handleStorage = async (request, response) => {
              puts++;
              assert.equal(request.method, "PUT");
              assert.equal(request.headers["content-type"], "image/png");
              assert.equal(request.headers["x-local-intent"], photoId);
              const chunks: Buffer[] = [];
              for await (const chunk of request)
                chunks.push(Buffer.from(chunk));
              assert.deepEqual(
                Buffer.concat(chunks),
                photo,
                "The actual browser XHR sends the selected File bytes",
              );
              if (scenario === "delayed") await putGate.promise;
              if (scenario === "put_failure" && puts === 1)
                response.writeHead(403).end();
              else {
                putCompleted = true;
                response.writeHead(204).end();
              }
            };
            await page.addInitScript(
              (id) => sessionStorage.setItem(`partner-request-step:${id}`, "1"),
              draftId,
            );
            await page.route("**/api/partners/portal/**", async (route) => {
              const request = route.request(),
                path = new URL(request.url()).pathname;
              if (path.endsWith("/booking-drafts"))
                return route.fulfill({
                  json: { ok: true, drafts: [], page: { nextCursor: null } },
                });
              if (path.endsWith(`/booking-drafts/${draftId}/media`)) {
                reads++;
                if (scenario === "delayed" && reads > 1) await readGate.promise;
                if (scenario === "read_failure" && reads === 2)
                  return route.fulfill({
                    status: 503,
                    headers: { "X-Correlation-ID": "photo-read-ref" },
                    json: { ok: false, error: "temporary_failure" },
                  });
                if (scenario === "malformed_read" && reads === 2)
                  return route.fulfill({
                    json: { ok: true, media: [{ id: photoId }] },
                  });
                if (scenario === "wrong_id_read" && reads === 2)
                  return route.fulfill({
                    json: {
                      ok: true,
                      media: [{ ...attachedPhoto, id: "different-photo" }],
                    },
                  });
                return route.fulfill({
                  json: { ok: true, media: mediaReady ? [attachedPhoto] : [] },
                });
              }
              if (
                path.endsWith(`/booking-drafts/${draftId}/media/upload-intents`)
              ) {
                intents.push({
                  key: request.headers()["idempotency-key"],
                  body: request.postDataJSON(),
                });
                if (scenario === "delayed") await intentGate.promise;
                if (scenario === "intent_failure" && intents.length === 1)
                  return route.fulfill({
                    status: 503,
                    headers: { "X-Correlation-ID": "photo-intent-ref" },
                    json: { ok: false, error: "temporary_failure" },
                  });
                return route.fulfill({
                  headers: { "X-Correlation-ID": "photo-intent-ref" },
                  json: {
                    ok: true,
                    intents: [
                      {
                        id: photoId,
                        status: mediaReady ? "ready" : "staging",
                        alreadyExists:
                          intents.length > 1 || scenario === "resume",
                        requiresUpload: !putCompleted,
                        uploadIntent: putCompleted
                          ? null
                          : {
                              url: `${base}/storage/upload`,
                              method: "PUT",
                              headers: {
                                "Content-Type": "image/png",
                                "X-Local-Intent": photoId,
                              },
                            },
                      },
                    ],
                  },
                });
              }
              if (path.endsWith(`/media/${photoId}/finalize`)) {
                finalizes++;
                finalizeKeys.push(request.headers()["idempotency-key"]);
                assert.equal(
                  putCompleted,
                  true,
                  "Finalize follows a completed or resumed transfer",
                );
                if (scenario === "delayed" || scenario === "resume")
                  await finalizeGate.promise;
                if (scenario === "finalize_failure" && finalizes === 1)
                  return route.fulfill({
                    status: 503,
                    headers: { "X-Correlation-ID": "photo-finalize-ref" },
                    json: { ok: false, error: "temporary_failure" },
                  });
                mediaReady = true;
                if (scenario === "lost_finalize") return route.abort("failed");
                return route.fulfill({
                  json: { ok: true, media: attachedPhoto },
                });
              }
              if (path.endsWith(`/booking-drafts/${draftId}/validate`)) {
                validations++;
                return route.fulfill({
                  json: {
                    ok: true,
                    draft: saved,
                    validation: { valid: true, ready: true, fieldErrors: {} },
                  },
                });
              }
              if (path.endsWith(`/booking-drafts/${draftId}/availability`))
                return route.fulfill({
                  json: {
                    ok: true,
                    availability: {
                      draft: saved,
                      timezone: "America/New_York",
                      calendar: { state: "current" },
                      reviewReasons: ["manual_review_required"],
                      instantConfirmationEligible: false,
                      pricing: {
                        status: "review_required",
                        currency: "USD",
                        baseAmount: null,
                        addOnTotal: null,
                        total: null,
                        addOns: [],
                      },
                      windows: [],
                      rankedAlternatives: [],
                    },
                  },
                });
              if (path.endsWith(`/booking-drafts/${draftId}`)) {
                assert.equal(request.method(), "PATCH");
                saved = {
                  ...saved,
                  ...request.postDataJSON(),
                  revision: saved.revision + 1,
                  etag: `"draft-${saved.revision + 1}"`,
                };
                return route.fulfill({ json: { ok: true, draft: saved } });
              }
              throw new Error(
                `Unexpected photo fixture request: ${request.method()} ${path}`,
              );
            });
            try {
              await page.goto(base);
              await expect(
                page.getByText("Saved", { exact: true }).first(),
              ).toBeVisible();
              await expect(
                page.getByRole("button", {
                  name: "Choose photos",
                  exact: true,
                }),
              ).toBeVisible();
              await expect(
                page.getByText(
                  "Choose photos, then attach them to this request.",
                  { exact: true },
                ),
              ).toBeVisible();
              const input = page.locator(`#draft-photo-files-${draftId}`);
              await input.setInputFiles({
                name: "reference.png",
                mimeType: "image/png",
                buffer: photo,
              });
              await expect(
                page.getByText("Ready to attach", { exact: true }),
              ).toBeVisible();
              await expect(
                page.getByText("Photos ready to attach", { exact: true }),
              ).toBeVisible();
              await expect(page.getByRole("progressbar")).toHaveCount(0);
              await expect(page.getByText("0%", { exact: true })).toHaveCount(
                0,
              );
              assert.equal(
                intents.length,
                0,
                "Selection does not start a transfer",
              );
              const attach = page.getByRole("button", {
                name: "Attach photos",
                exact: true,
              });
              const image = page.getByRole("img", {
                name: "Selected photo: reference.png",
                exact: true,
              });
              const actionBox = await attach.boundingBox(),
                previewBox = await image.boundingBox();
              assert.ok(
                actionBox && previewBox && actionBox.y < previewBox.y,
                "Attach action appears before the previews",
              );
              await page
                .locator("summary")
                .filter({ hasText: /^Photo details/ })
                .click();
              await page
                .locator(`#draft-photo-category-${draftId}`)
                .selectOption("issue");
              await page
                .locator(`#draft-photo-caption-${draftId}`)
                .fill(attachedPhoto.caption);
              await assertPending(page);
              assert.equal(validations, 0);
              await attach.click();
              if (scenario === "delayed") {
                await expect(
                  page
                    .getByText("Starting photo upload…", { exact: true })
                    .first(),
                ).toBeVisible();
                await expect(page.getByRole("progressbar")).toHaveCount(0);
                await expect(input).toBeDisabled();
                intentGate.release();
                await expect.poll(() => puts).toBe(1);
                await expect(
                  page.getByText("Uploading photos…", { exact: true }).first(),
                ).toBeVisible();
                await expect(page.getByRole("progressbar")).toHaveCount(1);
                await assertPending(page);
                putGate.release();
                await expect.poll(() => finalizes).toBe(1);
                await expect(
                  page.getByText("Saving photos…", { exact: true }).first(),
                ).toBeVisible();
                await expect(
                  page.getByText("Saving photo…", { exact: true }),
                ).toBeVisible();
                await expect(page.getByRole("progressbar")).toHaveCount(0);
                await assertPending(page);
                finalizeGate.release();
                await expect.poll(() => reads).toBe(2);
                await expect(
                  page.getByText("Saving photos…", { exact: true }).first(),
                ).toBeVisible();
                await expect(input).toBeDisabled();
                await expect(
                  page.getByRole("button", {
                    name: "Choose different photos",
                    exact: true,
                  }),
                ).toBeDisabled();
                await assertPending(page);
                readGate.release();
              } else if (scenario === "resume") {
                await expect.poll(() => finalizes).toBe(1);
                assert.equal(puts, 0);
                await expect(
                  page.getByText("Saving photos…", { exact: true }).first(),
                ).toBeVisible();
                await expect(page.getByRole("progressbar")).toHaveCount(0);
                await expect(page.getByText("0%", { exact: true })).toHaveCount(
                  0,
                );
                await assertPending(page);
                finalizeGate.release();
              } else if (
                scenario === "intent_failure" ||
                scenario === "put_failure" ||
                scenario === "finalize_failure" ||
                scenario === "wrong_id_read"
              ) {
                await expect(
                  page.getByText("Photos need attention", { exact: true }),
                ).toBeVisible();
                await expect(
                  page.getByText("Needs retry", { exact: true }),
                ).toBeVisible();
                await assertPending(page);
                assert.equal(
                  await input.evaluate(
                    (node) => (node as HTMLInputElement).files?.length,
                  ),
                  1,
                );
                await expect(
                  page.locator(`#draft-photo-caption-${draftId}`),
                ).toHaveValue(attachedPhoto.caption);
                await page
                  .getByRole("button", { name: "Retry photos", exact: true })
                  .click();
              } else if (
                scenario === "read_failure" ||
                scenario === "malformed_read"
              ) {
                await expect(
                  page.getByText("Photos need attention", { exact: true }),
                ).toBeVisible();
                await assertPending(page);
                await page
                  .getByRole("button", { name: "Try again", exact: true })
                  .first()
                  .click();
              }
              await assertAttached(page);
              assert.equal(
                validations,
                1,
                "Scheduling starts only after attachment is verified",
              );
              assert.equal(
                puts,
                scenario === "resume" ? 0 : scenario === "put_failure" ? 2 : 1,
              );
              assert.equal(finalizes, scenario === "finalize_failure" ? 2 : 1);
              assert.equal(
                intents.length,
                [
                  "intent_failure",
                  "put_failure",
                  "finalize_failure",
                  "wrong_id_read",
                ].includes(scenario)
                  ? 2
                  : 1,
              );
              assert.ok(intents[0]?.key);
              assert.equal(intents[0]?.body.files[0].category, "issue");
              assert.equal(
                intents[0]?.body.files[0].caption,
                attachedPhoto.caption,
              );
              for (const retried of intents.slice(1))
                assert.deepEqual(
                  retried,
                  intents[0],
                  "Retry preserves operation key, client ID and metadata",
                );
              if (finalizeKeys.length > 1)
                assert.equal(finalizeKeys[1], finalizeKeys[0]);
              assert.ok(xhrMethods.every((method) => method === "PUT:xhr"));
              assert.deepEqual(pageErrors, []);
              assert.equal(
                await page.evaluate(
                  () => document.documentElement.scrollWidth > innerWidth + 1,
                ),
                false,
                `${scenario} fits viewport`,
              );
            } finally {
              intentGate.release();
              putGate.release();
              finalizeGate.release();
              readGate.release();
              await page.close();
            }
          }
        } finally {
          await browser.close();
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      },
    );
  }
}
