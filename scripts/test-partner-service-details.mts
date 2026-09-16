import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  chromium,
  webkit,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
import tailwindConfig from "../apps/site/tailwind.config";

const repo = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(`${repo}/package.json`);
const siteRequire = createRequire(`${repo}/apps/site/package.json`);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const siteTheme = (
  "default" in tailwindConfig ? tailwindConfig.default : tailwindConfig
) as typeof tailwindConfig;
const draftId = "11111111-1111-4111-8111-111111111115";
const initialDraft = {
  id: draftId,
  state: "draft",
  etag: '"draft-1"',
  revision: 1,
  rescheduleFromJobId: null,
  additionalServiceFromJobId: null,
  locationId: "facility-address",
  serviceKey: "facility_cleanout",
  tierKey: "standard",
  selectedAddOns: [],
  scope: {},
  description: null,
  crewInstructions: null,
  accessDetails: null,
  onSiteContact: {
    name: "Morgan Lee",
    phone: "+14045550100",
    email: "facilities@example.test",
  },
  proofRequirements: { before: 1, after: 1, package: false },
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
const service = {
  key: "facility_cleanout",
  label: "Facility cleanout",
  bookable: true,
  priceState: "estimate",
  pricingStatus: "review_required",
  agreement: null,
  inclusions: [],
  exclusions: [],
  quoteRule: null,
  baseOptions: [
    {
      tierKey: "standard",
      label: "Standard collection",
      priceState: "estimate",
      pricingStatus: "review_required",
      price: null,
    },
    {
      tierKey: "large",
      label: "Large collection",
      priceState: "estimate",
      pricingStatus: "review_required",
      price: null,
    },
  ],
  addOns: [
    {
      key: "stairs",
      label: "Stair carry",
      detail: "Items carried between floors.",
      priceState: "estimate",
      unitLabel: "floor",
      minimumQuantity: 1,
      maximumQuantity: 5,
      instantConfirmationMaxQuantity: null,
      requiresReview: true,
      pricingStatus: "review_required",
      unitPrice: null,
    },
  ],
};
const services = [
  service,
  {
    ...service,
    key: "general_request",
    label: "General service request",
    baseOptions: [],
    addOns: [],
  },
];
const photo = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4HsAAAAASUVORK5CYII=",
  "base64",
);
const entry = `import React from 'react';import{createRoot}from'react-dom/client';
import{PartnerBookingWizard}from'./src/app/partners/components/PartnerBookingWizard';
const draft=${JSON.stringify(initialDraft)},services=${JSON.stringify(services)};
const scenario=new URLSearchParams(location.search).get('scenario');
const catalog=scenario?[{...services[0],key:'appliance_collection',label:'Appliance collection',baseOptions:[{...services[0].baseOptions[0],tierKey:'appliance_pickup'}],addOns:[]},...services,{...services[1],key:'service_request',label:'Request service',bookable:scenario!=='disabled'}]:services;
const savedDraft=scenario?{...draft,serviceKey:scenario==='blank-saved'?null:scenario==='unavailable'?'retired_service':scenario==='switch'?'facility_cleanout':'service_request',tierKey:scenario==='switch'?'standard':null,description:'Keep the saved description and attached photo.',selectedAddOns:scenario==='switch'?[{key:'stairs',quantity:2}]:[],preferredWindows:[{localDate:new Date(Date.now()+2*86400000).toISOString().slice(0,10),timeOfDay:'afternoon',timezone:'America/New_York'}]}:draft;
function App(){return <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6"><PartnerBookingWizard
 initialDraft={scenario==='new'||scenario==='explicit'?null:savedDraft} defaultLocationId={scenario?'facility-address':''} defaultServiceKey={scenario==='explicit'||scenario==='blank-saved'?'appliance_collection':''} locations={[{id:'facility-address',name:'Northside facility',address:'100 Facility Drive, Atlanta, GA 30301',accessDetails:'Old location instructions removed from this draft.'}]}
 services={catalog} canUploadPhotos canManageLocations persona="commercial_client"
 cancellationPolicy={{minimumNoticeMinutes:0,directCancellationEnabled:false,lateCancellationDisposition:'staff_review',automaticFeeMinor:null,source:'unconfigured',revision:null}}
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
          ...siteTheme,
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

function disclosure(page: Page, name: string): Locator {
  return page.locator("details").filter({
    has: page.locator(":scope > summary", {
      hasText: new RegExp(`^${name}`),
    }),
  });
}
async function toggle(details: Locator, open: boolean, key = "Enter") {
  const summary = details.locator(":scope > summary");
  await summary.focus();
  await summary.press(key);
  await expect(details).toHaveJSProperty("open", open);
}
async function fits(page: Page) {
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
    "The details step fits the viewport",
  );
}
async function screenshot(
  page: Page,
  engine: string,
  width: number,
  state = "initial",
) {
  const directory = process.env["PARTNER_SERVICE_DETAILS_PREVIEW_DIR"];
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await page.screenshot({
    path: join(directory, `service-details-${engine}-${width}-${state}.png`),
    fullPage: true,
  });
}

async function specialRequirementsScreenshot(
  details: Locator,
  engine: string,
  width: number,
  state: string,
) {
  const directory = process.env["PARTNER_SPECIAL_REQUIREMENTS_PREVIEW_DIR"];
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await details.screenshot({
    path: join(
      directory,
      `special-requirements-${engine}-${width}-${state}.png`,
    ),
  });
}

for (const engine of [chromium, webkit]) {
  for (const width of [1440, 375]) {
    void test(
      `${engine.name()} ${width}px: service details keeps a clear first view, keyboard access, optional values and photos`,
      { timeout: 60_000 },
      async () => {
        const built = await assets();
        const server = createServer((request, response) => {
          if (request.url === "/client.js") {
            response.setHeader("Content-Type", "text/javascript");
            response.end(built.script);
          } else if (request.url === "/styles.css") {
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
        const browser = await engine.launch();
        try {
          const page = await browser.newPage({
            viewport: { width, height: 1000 },
            hasTouch: width === 375,
            isMobile: width === 375,
          });
          page.setDefaultTimeout(8_000);
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.addInitScript(
            (id) => sessionStorage.setItem(`partner-request-step:${id}`, "1"),
            draftId,
          );
          let saved: Record<string, any> = structuredClone(initialDraft);
          const mediaReads: string[] = [];
          const photoAttempts: { key: string | undefined; body: unknown }[] =
            [];
          let finishValidation: (() => void) | undefined;
          let pauseValidation = false;
          const attachedPhoto = {
            id: "photo-reference",
            category: "issue",
            caption: "Keep the entrance clear.",
            sortOrder: 0,
            status: "ready",
            filename: "facility-reference.png",
            contentType: "image/png",
            byteSize: photo.byteLength,
            width: 1,
            height: 1,
            sha256: null,
            createdAt: initialDraft.createdAt,
            readyAt: initialDraft.createdAt,
            error: null,
            downloadIntent: null,
          };
          await page.route("**/api/partners/portal/**", async (route) => {
            const request = route.request(),
              path = new URL(request.url()).pathname;
            if (path.endsWith(`/booking-drafts/${draftId}/media`)) {
              assert.equal(request.method(), "GET");
              mediaReads.push(path);
              if (photoAttempts.length === 1)
                return route.fulfill({
                  status: 503,
                  json: { ok: false, error: "temporary_failure" },
                });
              return route.fulfill({
                json: {
                  ok: true,
                  media: photoAttempts.length > 1 ? [attachedPhoto] : [],
                },
              });
            }
            if (
              path.endsWith(`/booking-drafts/${draftId}/media/upload-intents`)
            ) {
              photoAttempts.push({
                key: request.headers()["idempotency-key"],
                body: request.postDataJSON(),
              });
              return route.fulfill({
                json: {
                  ok: true,
                  intents: [
                    {
                      id: attachedPhoto.id,
                      status: "ready",
                      alreadyExists: true,
                      requiresUpload: false,
                      uploadIntent: null,
                    },
                  ],
                },
              });
            }
            if (path.endsWith(`/booking-drafts/${draftId}/validate`)) {
              assert.equal(request.method(), "POST");
              if (pauseValidation)
                await new Promise<void>((resolve) => {
                  finishValidation = resolve;
                });
              return route.fulfill({
                json: {
                  ok: true,
                  draft: saved,
                  validation: {
                    valid: false,
                    ready: false,
                    fieldErrors: {
                      "commercial.billingContact.email":
                        "Check the billing email address.",
                    },
                  },
                },
              });
            }
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
            if (path.endsWith("/booking-drafts"))
              return route.fulfill({
                json: { ok: true, drafts: [], page: { nextCursor: null } },
              });
            throw new Error(
              `Unexpected portal action in design preview: ${request.method()} ${path}`,
            );
          });
          await page.goto(`http://127.0.0.1:${address.port}/`);
          await expect(
            page.getByRole("heading", {
              name: "Service details",
              exact: true,
              level: 2,
            }),
          ).toBeVisible();
          const serviceInput = page.locator("#partner-book-service");
          const description = page.locator("#partner-book-description");
          await expect(serviceInput).toBeVisible();
          await expect(description).toBeVisible();
          await expect(page.locator("#partner-book-base-option")).toBeVisible();
          const addPhotos = page.getByRole("button", {
            name: "Choose photos",
            exact: true,
          });
          await expect(addPhotos).toBeVisible();
          assert.ok(
            mediaReads.length > 0,
            "Photo state is loaded through the real component",
          );
          const names = [
            "Contact and access",
            "Special requirements",
            "Work order and billing",
            "Completion photos",
            "Additional services",
          ];
          for (const name of names) {
            await expect(disclosure(page, name)).toHaveJSProperty(
              "open",
              false,
            );
            await expect(
              disclosure(page, name).locator(":scope > summary"),
            ).toBeVisible();
          }
          await expect(disclosure(page, "Contact and access")).toContainText(
            "Morgan Lee",
          );
          await expect(
            disclosure(page, "Contact and access").locator(":scope > summary"),
          ).toContainText(/404|facilities@example\.test/);
          await fits(page);
          await screenshot(page, engine.name(), width);

          // Native select and textarea stay in the main flow, while irrelevant
          // base options and add-ons disappear for a service without them.
          await serviceInput.selectOption("general_request");
          await expect(page.locator("#partner-book-base-option")).toHaveCount(
            0,
          );
          await expect(disclosure(page, "Additional services")).toHaveCount(0);
          await serviceInput.selectOption("facility_cleanout");
          await page
            .locator("#partner-book-base-option")
            .selectOption("standard");
          await description.fill(
            "Collect four empty shelving units from the loading area.",
          );

          const contact = disclosure(page, "Contact and access");
          await toggle(contact, true);
          await expect(page.locator("#partner-book-access")).toHaveValue("");
          await page
            .locator("#partner-book-access")
            .fill("Use the south loading dock.");
          await toggle(contact, false, "Space");
          await toggle(contact, true);
          await expect(page.locator("#partner-book-access")).toHaveValue(
            "Use the south loading dock.",
          );
          await toggle(contact, false);

          const special = disclosure(page, "Special requirements");
          await toggle(special, true);
          const specialGroups = [
            "Handling and access",
            "Materials needing review",
            "Completion deadline",
            "Additional stops",
            "Quantity estimate",
          ];
          for (const name of specialGroups) {
            const group = disclosure(page, name);
            await expect(group).toHaveJSProperty("open", false);
            await expect(group.locator(":scope > summary")).toBeVisible();
          }
          // Collapsed controls remain mounted but outside the keyboard flow.
          await expect(page.locator("#partner-book-item-count")).toHaveCount(1);
          await expect(
            page.locator("#partner-book-item-count"),
          ).not.toBeVisible();
          const firstSpecialSummary = disclosure(
            page,
            specialGroups[0]!,
          ).locator(":scope > summary");
          await firstSpecialSummary.focus();
          for (const name of specialGroups.slice(1)) {
            await page.keyboard.press("Tab");
            await expect(
              disclosure(page, name).locator(":scope > summary"),
            ).toBeFocused();
          }
          await fits(page);
          await specialRequirementsScreenshot(
            special,
            engine.name(),
            width,
            "empty",
          );

          const handling = disclosure(page, "Handling and access");
          await toggle(handling, true);
          await handling
            .getByRole("checkbox", { name: /Heavy items or unusual work/ })
            .check();
          await handling
            .getByRole("checkbox", { name: "Loading dock", exact: true })
            .check();
          await fits(page);
          await specialRequirementsScreenshot(
            special,
            engine.name(),
            width,
            "handling-expanded",
          );
          await toggle(handling, false, "Space");
          await expect(handling.locator(":scope > summary")).toContainText(
            "Loading dock",
          );

          const materials = disclosure(page, "Materials needing review");
          await toggle(materials, true, "Space");
          await materials
            .getByRole("checkbox", {
              name: /Materials needing special handling/,
            })
            .check();
          await materials
            .getByRole("checkbox", { name: "Paint or coatings", exact: true })
            .check();
          await toggle(materials, false);
          await expect(materials.locator(":scope > summary")).toContainText(
            "Paint or coatings",
          );

          const deadline = disclosure(page, "Completion deadline");
          await toggle(deadline, true);
          await page.locator("#partner-book-required-date").fill("2026-10-04");
          await page.locator("#partner-book-required-time").fill("16:00");
          await toggle(deadline, false);
          await expect(deadline.locator(":scope > summary")).toContainText(
            /Oct|10\/4|2026-10-04/,
          );

          const stops = disclosure(page, "Additional stops");
          await toggle(stops, true);
          await stops
            .getByRole("checkbox", {
              name: "More than one service stop",
            })
            .check();
          await page
            .locator("#partner-book-multi-stop-details")
            .fill("Collect the second shelf from Suite 9.");
          await toggle(stops, false);
          await expect(stops.locator(":scope > summary")).toContainText(
            "Suite 9",
          );

          const quantity = disclosure(page, "Quantity estimate");
          await toggle(quantity, true);
          await page.locator("#partner-book-item-count").fill("4");
          await page.locator("#partner-book-volume").fill("2.5");
          await toggle(quantity, false);
          await expect(quantity.locator(":scope > summary")).toContainText("4");
          await expect(quantity.locator(":scope > summary")).toContainText(
            "2.5",
          );
          const expectedScope = {
            itemCount: 4,
            volumeCubicYards: 2.5,
            restrictedItems: true,
            nonStandard: true,
            hazardCategories: ["paint"],
            equipmentNeeds: ["loading_dock"],
            requiredCompletion: { localDate: "2026-10-04", localTime: "16:00" },
            multiStop: true,
            multiStopDetails: "Collect the second shelf from Suite 9.",
          };
          await expect.poll(() => saved.scope).toEqual(expectedScope);
          await fits(page);
          await specialRequirementsScreenshot(
            special,
            engine.name(),
            width,
            "saved-summaries",
          );
          await toggle(special, false);
          await toggle(special, true, "Space");
          for (const name of specialGroups)
            await expect(disclosure(page, name)).toHaveJSProperty(
              "open",
              false,
            );
          await toggle(quantity, true);
          await expect(page.locator("#partner-book-item-count")).toHaveValue(
            "4",
          );
          await expect(page.locator("#partner-book-volume")).toHaveValue("2.5");
          // A validation link must reveal both the outer row and nested group.
          await page.locator("#partner-book-item-count").fill("-1");
          await expect(page.locator("#partner-book-item-count")).toHaveValue(
            "-1",
          );
          await toggle(quantity, false);
          await toggle(special, false);
          await page
            .getByRole("button", {
              name: "Continue to scheduling",
              exact: true,
            })
            .click();
          const scopeErrorSummary = page.locator("#partner-book-error-summary");
          await expect(scopeErrorSummary).toBeFocused();
          await expect(scopeErrorSummary).toContainText(
            "Enter a whole item count of zero or more.",
          );
          await expect(special).toHaveJSProperty("open", true);
          await expect(quantity).toHaveJSProperty("open", true);
          await toggle(quantity, false);
          await toggle(special, false);
          // Repeating unchanged validation must reopen both levels too.
          await page
            .getByRole("button", {
              name: "Continue to scheduling",
              exact: true,
            })
            .click();
          await expect(scopeErrorSummary).toBeFocused();
          await expect(special).toHaveJSProperty("open", true);
          await expect(quantity).toHaveJSProperty("open", true);
          await toggle(quantity, false);
          await toggle(special, false);
          const quantityError = scopeErrorSummary.getByRole("link", {
            name: "Enter a whole item count of zero or more.",
            exact: true,
          });
          await quantityError.focus();
          await quantityError.press("Enter");
          await expect(special).toHaveJSProperty("open", true);
          await expect(quantity).toHaveJSProperty("open", true);
          await expect(page.locator("#partner-book-item-count")).toBeFocused();
          await page.locator("#partner-book-item-count").fill("4");
          await toggle(quantity, false);
          await toggle(special, false);

          const billing = disclosure(page, "Work order and billing");
          await toggle(billing, true);
          await page.locator("#partner-book-po").fill("WO-2026-015");
          await page
            .locator("#partner-book-billing-name")
            .fill("Accounts team");
          await toggle(billing, false);
          await toggle(billing, true);
          await expect(page.locator("#partner-book-po")).toHaveValue(
            "WO-2026-015",
          );
          await toggle(billing, false);

          const completion = disclosure(page, "Completion photos");
          await toggle(completion, true);
          await completion
            .getByLabel("Number of photos", { exact: true })
            .first()
            .fill("2");
          await toggle(completion, false);
          await toggle(completion, true);
          await expect(
            completion.getByLabel("Number of photos", { exact: true }).first(),
          ).toHaveValue("2");
          await toggle(completion, false);

          const addOns = disclosure(page, "Additional services");
          await toggle(addOns, true);
          await addOns.getByRole("checkbox", { name: /Stair carry/ }).check();
          await page.locator("#partner-book-add-on-stairs").fill("2");
          await toggle(addOns, false);
          await toggle(addOns, true);
          await expect(page.locator("#partner-book-add-on-stairs")).toHaveValue(
            "2",
          );
          await toggle(addOns, false);
          await expect
            .poll(() => saved.commercial.poNumber)
            .toBe("WO-2026-015");
          await expect.poll(() => saved.proofRequirements.before).toBe(2);
          assert.deepEqual(
            saved.scope,
            expectedScope,
            "Closing requirement groups preserves the complete outbound scope",
          );

          // Keyboard activation opens the real file input. Preferences for crew
          // completion photos cannot erase reference files awaiting attachment.
          const chooser = page.waitForEvent("filechooser");
          await addPhotos.focus();
          await addPhotos.press("Enter");
          await (
            await chooser
          ).setFiles({
            name: "facility-reference.png",
            mimeType: "image/png",
            buffer: photo,
          });
          await expect(
            page.getByRole("img", {
              name: "Selected photo: facility-reference.png",
              exact: true,
            }),
          ).toBeVisible();
          const photoDetails = disclosure(page, "Photo details");
          await expect(photoDetails).toHaveJSProperty("open", false);
          await toggle(photoDetails, true);
          await page
            .locator(`#draft-photo-caption-${draftId}`)
            .fill("Shelving by the loading dock.");
          await toggle(photoDetails, false);
          await toggle(completion, true);
          await toggle(completion, false);
          await toggle(photoDetails, true);
          await expect(
            page.locator(`#draft-photo-caption-${draftId}`),
          ).toHaveValue("Shelving by the loading dock.");
          assert.equal(
            await page
              .locator(`#draft-photo-files-${draftId}`)
              .evaluate((input: HTMLInputElement) => input.files?.[0]?.name),
            "facility-reference.png",
          );
          await toggle(photoDetails, false);
          await fits(page);
          await screenshot(page, engine.name(), width, "with-photo");

          // A paired billing-field error expands its section. After the user
          // closes it again, the error link must reopen it before moving focus.
          await page
            .getByRole("button", {
              name: "Continue to scheduling",
              exact: true,
            })
            .click();
          const errorSummary = page.locator("#partner-book-error-summary");
          await expect(errorSummary).toBeFocused();
          await expect(billing).toHaveJSProperty("open", true);
          await toggle(billing, false);
          const billingError = errorSummary.getByRole("link", {
            name: /Add both the billing contact name and email/,
          });
          await billingError.focus();
          await billingError.press("Enter");
          await expect(billing).toHaveJSProperty("open", true);
          await expect(
            page.locator("#partner-book-billing-name"),
          ).toBeFocused();
          await page
            .locator("#partner-book-billing-email")
            .fill("accounts@example.test");
          await toggle(billing, false);

          // Selected files are not saved attachments. Neither Continue, Back,
          // nor the step controls may silently unmount and discard this batch.
          await page
            .getByRole("button", {
              name: "Continue to scheduling",
              exact: true,
            })
            .click();
          await expect(page.locator("#partner-book-photos")).toBeFocused();
          await expect(
            page.getByText(
              "Attach your selected photos, or clear the selection, before leaving Service details.",
            ),
          ).toBeVisible();
          await page.getByRole("button", { name: "Back", exact: true }).click();
          await expect(page.locator("[data-booking-step]")).toHaveAttribute(
            "data-booking-step",
            "1",
          );
          await page
            .locator('ol[aria-label="Service request progress"] button')
            .first()
            .click();
          await expect(page.locator("[data-booking-step]")).toHaveAttribute(
            "data-booking-step",
            "1",
          );
          await expect(
            page.getByText("1 photo selected · Ready to attach"),
          ).toBeVisible();
          await expect(page.locator("[data-partner-unsaved]")).toHaveAttribute(
            "data-partner-unsaved",
            "true",
          );
          await toggle(photoDetails, true);
          await expect(
            page.locator(`#draft-photo-caption-${draftId}`),
          ).toHaveValue("Shelving by the loading dock.");
          await toggle(photoDetails, false);
          await page.locator(`#draft-photo-files-${draftId}`).setInputFiles({
            name: "unsupported.pdf",
            mimeType: "application/pdf",
            buffer: Buffer.from("%PDF-1.4"),
          });
          await expect(
            page.getByRole("img", {
              name: "Selected photo: facility-reference.png",
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            page.getByText(/unsupported.pdf is not a supported image/),
          ).toBeVisible();
          await page
            .getByRole("button", { name: "Clear selection", exact: true })
            .click();

          pauseValidation = true;
          await page
            .getByRole("button", {
              name: "Continue to scheduling",
              exact: true,
            })
            .click();
          try {
            await expect.poll(() => Boolean(finishValidation)).toBe(true);
            await expect(addPhotos).toBeDisabled();
            await expect(
              page.locator(`#draft-photo-files-${draftId}`),
            ).toBeDisabled();
          } finally {
            pauseValidation = false;
            finishValidation?.();
          }
          await expect(errorSummary).toBeFocused();
          await expect(billing).toHaveJSProperty("open", true);
          await toggle(billing, false);
          const nestedBillingError = errorSummary.getByRole("link", {
            name: "Check the billing email address.",
            exact: true,
          });
          await nestedBillingError.focus();
          await nestedBillingError.press("Enter");
          await expect(billing).toHaveJSProperty("open", true);
          await expect(
            page.locator("#partner-book-billing-email"),
          ).toBeFocused();
          await toggle(billing, false);

          // Required contact and job fields remain enforced in the condensed UI.
          await page.locator(`#draft-photo-files-${draftId}`).setInputFiles({
            name: "facility-reference.png",
            mimeType: "image/png",
            buffer: photo,
          });
          await toggle(contact, true);
          await page.locator("#partner-book-contact-name").fill("");
          await page.locator("#partner-book-contact-phone").fill("");
          await page.locator("#partner-book-contact-email").fill("");
          await toggle(contact, false);
          await description.fill("");
          await page
            .getByRole("button", {
              name: "Continue to scheduling",
              exact: true,
            })
            .click();
          await expect(errorSummary).toBeFocused();
          await expect(contact).toHaveJSProperty("open", true);
          await expect(description).toHaveAttribute("aria-invalid", "true");
          await expect(
            page.locator("#partner-book-contact-name"),
          ).toHaveAttribute("aria-invalid", "true");
          await expect(
            page.locator("#partner-book-contact-phone"),
          ).toHaveAttribute("aria-invalid", "true");
          await expect(
            page.getByRole("img", {
              name: "Selected photo: facility-reference.png",
              exact: true,
            }),
          ).toBeVisible();
          // If a transfer succeeded but the saved-photo read failed, retain the
          // selection and its request identity until retry confirms attachment.
          await toggle(photoDetails, true);
          await page
            .locator(`#draft-photo-category-${draftId}`)
            .selectOption("issue");
          await page
            .locator(`#draft-photo-caption-${draftId}`)
            .fill("Keep the entrance clear.");
          await page
            .getByRole("button", { name: "Attach photos", exact: true })
            .click();
          await expect(
            page.getByText(
              /Your photos were transferred, but we could not confirm they were attached/,
            ),
          ).toBeVisible();
          await expect(
            page.getByRole("img", {
              name: "Selected photo: facility-reference.png",
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            page.locator(`#draft-photo-caption-${draftId}`),
          ).toHaveValue("Keep the entrance clear.");
          await page
            .getByRole("button", { name: "Retry photos", exact: true })
            .click();
          await expect(
            page.getByText("Photos attached to this saved request.", {
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            page.getByRole("img", {
              name: "Selected photo: facility-reference.png",
              exact: true,
            }),
          ).toHaveCount(0);
          await expect(
            page.getByText("Keep the entrance clear.", { exact: true }),
          ).toBeVisible();
          assert.equal(photoAttempts.length, 2);
          assert.ok(photoAttempts[0]?.key);
          assert.deepEqual(
            photoAttempts[1],
            photoAttempts[0],
            "Retry preserves the photo identity, category and client note",
          );
          await fits(page);
          assert.deepEqual(
            errors,
            [],
            "The details preview has no client rendering errors",
          );
        } finally {
          await browser.close();
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      },
    );
  }
}

for (const engine of [chromium, webkit]) {
  void test(
    `${engine.name()}: multiple services preserve drafts and require fresh scheduling after a change`,
    { timeout: 60_000 },
    async () => {
      const built = await assets();
      const server = createServer((request, response) => {
        const path = new URL(request.url ?? "/", "http://localhost").pathname;
        if (path === "/client.js") {
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
      const browser = await engine.launch();
      try {
        for (const scenario of [
          "new",
          "explicit",
          "saved",
          "blank-saved",
          "unavailable",
          "disabled",
          "switch",
        ]) {
          const page = await browser.newPage({
            viewport: { width: 375, height: 1000 },
          });
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          let saved: Record<string, any> = {
            ...structuredClone(initialDraft),
            serviceKey:
              scenario === "blank-saved"
                ? null
                : scenario === "unavailable"
                  ? "retired_service"
                  : scenario === "switch"
                    ? "facility_cleanout"
                    : "service_request",
            tierKey: scenario === "switch" ? "standard" : null,
            description: "Keep the saved description and attached photo.",
            selectedAddOns:
              scenario === "switch" ? [{ key: "stairs", quantity: 2 }] : [],
            preferredWindows: [
              {
                localDate: new Date(Date.now() + 2 * 86400000)
                  .toISOString()
                  .slice(0, 10),
                timeOfDay: "afternoon",
                timezone: "America/New_York",
              },
            ],
          };
          let validations = 0;
          const availabilityServices: string[] = [];
          const attachedPhoto = {
            id: "saved-photo",
            category: "issue",
            caption: "Saved reference photo.",
            sortOrder: 0,
            status: "ready",
            filename: "reference.png",
            contentType: "image/png",
            byteSize: photo.byteLength,
            width: 1,
            height: 1,
            sha256: null,
            createdAt: initialDraft.createdAt,
            readyAt: initialDraft.createdAt,
            error: null,
            downloadIntent: null,
          };
          await page.addInitScript(
            (id) => sessionStorage.setItem(`partner-request-step:${id}`, "1"),
            draftId,
          );
          await page.route("**/api/partners/portal/**", async (route) => {
            const request = route.request(),
              path = new URL(request.url()).pathname;
            if (path.endsWith(`/booking-drafts/${draftId}/media`))
              return route.fulfill({
                json: { ok: true, media: [attachedPhoto] },
              });
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
            if (path.endsWith(`/booking-drafts/${draftId}/availability`)) {
              availabilityServices.push(saved.serviceKey);
              const amount = {
                amountMinor:
                  saved.serviceKey === "facility_cleanout" ? 12345 : 67890,
                currency: "USD",
                minorUnit: 2,
              };
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
                      status: "estimate",
                      currency: "USD",
                      baseAmount: amount,
                      addOnTotal: null,
                      total: amount,
                      addOns: [],
                    },
                    windows: [],
                    rankedAlternatives: [],
                  },
                },
              });
            }
            if (
              path.endsWith(`/booking-drafts/${draftId}`) ||
              (path.endsWith("/booking-drafts") && request.method() === "POST")
            ) {
              assert.ok(["PATCH", "POST"].includes(request.method()));
              saved = {
                ...saved,
                ...request.postDataJSON(),
                revision: saved.revision + 1,
                etag: `"draft-${saved.revision + 1}"`,
              };
              return route.fulfill({ json: { ok: true, draft: saved } });
            }
            if (path.endsWith("/booking-drafts"))
              return route.fulfill({
                json: { ok: true, drafts: [], page: { nextCursor: null } },
              });
            throw new Error(
              `Unexpected multi-service action: ${request.method()} ${path}`,
            );
          });
          try {
            await page.goto(
              `http://127.0.0.1:${address.port}/?scenario=${scenario}`,
            );
            if (scenario === "new" || scenario === "explicit")
              await page
                .getByRole("button", { name: "Continue", exact: true })
                .click();
            const select = page.locator("#partner-book-service");
            await expect(select).toBeVisible();
            if (scenario === "new" || scenario === "blank-saved") {
              await expect(select).toHaveValue("");
              await page
                .getByRole("button", {
                  name: "Continue to scheduling",
                  exact: true,
                })
                .click();
              await expect(
                page.locator("#partner-book-service-error"),
              ).toHaveText("Choose a service.");
              assert.equal(validations, 0);
              if (scenario === "blank-saved") {
                await expect(
                  page.locator("#partner-book-description"),
                ).toHaveValue("Keep the saved description and attached photo.");
                await expect(
                  page.getByText("Saved reference photo.", { exact: true }),
                ).toBeVisible();
              }
            } else if (scenario === "explicit") {
              await expect(select).toHaveValue("appliance_collection");
              await expect(
                page.locator("#partner-book-base-option"),
              ).toHaveValue("appliance_pickup");
            } else if (scenario === "saved") {
              await expect(select).toHaveValue("service_request");
              await expect.poll(() => saved.tierKey).toBe(null);
              await expect(
                page.locator("#partner-book-base-option"),
              ).toHaveCount(0);
              await expect(
                page.locator("#partner-book-description"),
              ).toHaveValue("Keep the saved description and attached photo.");
              await expect(
                page.getByText("Saved reference photo.", { exact: true }),
              ).toBeVisible();
            } else if (scenario === "unavailable" || scenario === "disabled") {
              await expect(select).toHaveAttribute("aria-invalid", "true");
              await expect(
                page.locator("#partner-book-service-error"),
              ).toContainText("Your other request details have been kept");
              await page
                .getByRole("button", {
                  name: "Continue to scheduling",
                  exact: true,
                })
                .click();
              await expect(
                page.locator("#partner-book-service-error"),
              ).toContainText("Choose another service");
              assert.equal(
                validations,
                0,
                "An unavailable service must be rejected before scheduling",
              );
              await select.selectOption("appliance_collection");
              await expect(select).toHaveAttribute("aria-invalid", "false");
              await expect(
                page.locator("#partner-book-service-error"),
              ).toHaveCount(0);
              await expect(
                page.getByText("Add the highlighted details to continue.", {
                  exact: true,
                }),
              ).toHaveCount(0);
              await expect(
                page.locator("#partner-book-description"),
              ).toHaveValue("Keep the saved description and attached photo.");
              await expect(
                page.getByText("Saved reference photo.", { exact: true }),
              ).toBeVisible();
            } else {
              await page
                .getByRole("button", {
                  name: "Continue to scheduling",
                  exact: true,
                })
                .click();
              await expect(page.locator("[data-booking-step]")).toHaveAttribute(
                "data-booking-step",
                "2",
              );
              await page
                .getByRole("button", { name: "Continue", exact: true })
                .click();
              await expect(page.locator("[data-booking-step]")).toHaveAttribute(
                "data-booking-step",
                "3",
              );
              await expect(
                page.getByText("$123.45", { exact: true }).first(),
              ).toBeVisible();
              const progress = page.getByRole("list", {
                name: "Service request progress",
              });
              await progress.locator("li").nth(1).getByRole("button").click();
              await page
                .locator(`#draft-photo-files-${draftId}`)
                .setInputFiles({
                  name: "unsaved-reference.png",
                  mimeType: "image/png",
                  buffer: photo,
                });
              await select.selectOption("service_request");
              await expect(
                page.getByRole("img", {
                  name: "Selected photo: unsaved-reference.png",
                  exact: true,
                }),
              ).toBeVisible();
              await expect(
                progress.locator("li").nth(2).getByRole("button"),
              ).toHaveCount(0);
              await expect(
                progress.locator("li").nth(3).getByRole("button"),
              ).toHaveCount(0);
              await expect(
                page.getByText("$123.45", { exact: true }),
              ).toHaveCount(0);
              await expect(
                page.locator("#partner-book-description"),
              ).toHaveValue("Keep the saved description and attached photo.");
              await expect(
                page.getByText("Saved reference photo.", { exact: true }),
              ).toBeVisible();
              await page
                .getByRole("button", { name: "Clear selection", exact: true })
                .click();
              await page
                .getByRole("button", {
                  name: "Continue to scheduling",
                  exact: true,
                })
                .click();
              await expect(page.locator("[data-booking-step]")).toHaveAttribute(
                "data-booking-step",
                "2",
              );
              await expect.poll(() => saved.tierKey).toBe(null);
              assert.deepEqual(saved.selectedAddOns, []);
              await page
                .getByRole("button", { name: "Continue", exact: true })
                .click();
              await expect(
                page.getByText("$678.90", { exact: true }).first(),
              ).toBeVisible();
              await expect(
                page.getByText("$123.45", { exact: true }),
              ).toHaveCount(0);
              assert.deepEqual(availabilityServices, [
                "facility_cleanout",
                "service_request",
              ]);
            }
            await expect(
              page.getByText("Saved", { exact: true }).first(),
            ).toBeVisible();
            if (scenario === "blank-saved") {
              assert.equal(saved.serviceKey, null);
              assert.equal(saved.tierKey, null);
            }
            if (scenario === "saved") {
              assert.equal(
                saved.tierKey,
                null,
                "Saving a reopened generic request must not inherit the first service's tier",
              );
              assert.equal(saved.serviceKey, "service_request");
            }
            await fits(page);
            assert.deepEqual(errors, []);
          } finally {
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
