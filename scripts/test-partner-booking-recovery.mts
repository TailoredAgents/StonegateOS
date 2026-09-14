import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium, webkit, expect } from "@playwright/test";

const repo = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(`${repo}/package.json`);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const location = {
  id: "location-A",
  siteName: "First location",
  externalPropertyId: null,
  address: {
    line1: "1 Local Test Way",
    line2: null,
    city: "Atlanta",
    state: "GA",
    postalCode: "30301",
  },
  access: { details: null, parking: null, loading: null },
  onSiteContact: null,
  portfolio: {
    isDefault: false,
    isFavorite: false,
    parentLocationId: null,
    childCount: 0,
    directoryVersion: 1,
    mergedIntoLocationId: null,
    mergedAt: null,
  },
  addressVerification: {
    status: "review_required",
    provider: "unconfigured",
    confidence: null,
    suggestedAddress: null,
    verifiedAt: null,
  },
  serviceArea: { status: "review", reason: null },
  active: true,
  revision: 1,
  etag: '"location-1"',
  updatedAt: "2026-09-09T12:00:00Z",
};
const draft = {
  id: "draft-A",
  state: "draft",
  etag: '"draft-1"',
  revision: 1,
  rescheduleFromJobId: null,
  additionalServiceFromJobId: null,
  locationId: null,
  serviceKey: null,
  tierKey: null,
  selectedAddOns: [],
  scope: {},
  description: "Saved original",
  crewInstructions: null,
  accessDetails: null,
  onSiteContact: null,
  proofRequirements: {},
  commercial: {},
  preferredWindows: [],
  scheduleAssistancePreference: "none",
  reviewReasons: [],
  validation: {},
  expiresAt: null,
  submittedAt: null,
  createdAt: "2026-09-09T12:00:00Z",
  updatedAt: "2026-09-09T12:00:00Z",
};
const entry = `import React from 'react';import{createRoot}from'react-dom/client';
import{PartnerInlineLocationForm}from'./src/app/partners/components/PartnerInlineLocationForm';
import{PartnerLocationManager}from'./src/app/partners/components/PartnerLocationManager';
import{PartnerSavedRequests}from'./src/app/partners/components/PartnerSavedRequests';
import{PartnerBookingWizard}from'./src/app/partners/components/PartnerBookingWizard';
function App(){React.useEffect(()=>{document.documentElement.dataset.harnessReady='true'},[]);return location.pathname==='/inline'?<PartnerInlineLocationForm canManage onCreated={()=>{window.created=true}}/>:
location.pathname==='/directory'?<PartnerLocationManager initialLocations={[]} initialNextCursor={null} initialDirectoryEtag='"directory-1"' canManage canCreateLocation canFavorite canRequestService canManagePortfolio={false} canExport={false}/>:
location.pathname==='/saved'?<PartnerSavedRequests canDiscard={false}/>:
<PartnerBookingWizard locations={[]} services={[]} cancellationPolicy={{minimumNoticeMinutes:0,directCancellationEnabled:false,lateCancellationDisposition:'staff_review',automaticFeeMinor:null,source:'unconfigured',revision:null}} persona={null} supportPhoneE164='+14045550100' supportPhoneDisplay='404-555-0100'/>}
createRoot(document.getElementById('root')).render(<App/>);`;

for (const engine of [chromium, webkit]) {
  void test(
    `${engine.name()}: failed first-location and draft responses retry the same operation; malformed saved lists retain requests`,
    { timeout: 60_000 },
    async () => {
      const bundle = await build({
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
            name: "next-test-boundaries",
            setup(builder: any) {
              builder.onResolve(
                { filter: /^next\/(link|navigation)$/ },
                (args: any) => ({ path: args.path, namespace: "next-test" }),
              );
              builder.onLoad(
                { filter: /.*/, namespace: "next-test" },
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
      });
      const server = createServer((request, response) => {
        response.setHeader(
          "Content-Type",
          request.url === "/client.js" ? "text/javascript" : "text/html",
        );
        response.end(
          request.url === "/client.js"
            ? bundle.outputFiles[0].contents
            : '<!doctype html><html><body><div id="root"></div><script src="/client.js"></script></body></html>',
        );
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const base = `http://127.0.0.1:${address.port}`;
      const browser = await engine.launch();
      try {
        const page = await browser.newPage();
        page.setDefaultTimeout(8_000);
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        let locationPosts: { key: string; body: string | null }[] = [],
          draftPosts: { key: string; body: string | null }[] = [],
          validations = 0,
          draftReads = 0;
        let directoryReadGate: Promise<void> | null = null;
        let releaseDirectoryRead: (() => void) | null = null;
        await page.route("**/api/partners/portal/**", async (route) => {
          const request = route.request(),
            url = new URL(request.url()),
            path = url.pathname.split("/api/partners/portal/")[1],
            method = request.method();
          const answer = (json: unknown) =>
            route.fulfill({ status: 200, json });
          if (path === "locations/validate") {
            validations++;
            return answer({
              ok: true,
              validation: {
                status: "review_required",
                verification: {
                  status: "review_required",
                  suggestedAddress: null,
                },
                duplicates: [],
                canCreateForReview: true,
              },
            });
          }
          if (path === "locations" && method === "GET") {
            await directoryReadGate;
            return answer({
              ok: true,
              locations: [
                {
                  ...location,
                  id: "existing-location",
                  siteName: "Previously saved location",
                },
              ],
              directory: { etag: '"directory-1"' },
              page: { nextCursor: null },
            });
          }
          if (path === "locations" && method === "POST") {
            locationPosts.push({
              key: request.headers()["idempotency-key"]!,
              body: request.postData(),
            });
            return answer(
              locationPosts.length === 1
                ? { ok: true }
                : { ok: true, location },
            );
          }
          if (path === "booking-drafts" && method === "POST") {
            draftPosts.push({
              key: request.headers()["idempotency-key"]!,
              body: request.postData(),
            });
            return answer(
              draftPosts.length === 1 ? { ok: true } : { ok: true, draft },
            );
          }
          if (path === "booking-drafts/draft-A" && method === "PATCH")
            return answer({ ok: true, draft });
          if (path === "booking-drafts") {
            if (new URL(page.url()).pathname !== "/saved")
              return answer({
                ok: true,
                drafts: [],
                page: { nextCursor: null },
              });
            draftReads++;
            return answer({
              ok: true,
              drafts: draftReads === 2 ? [null] : [draft],
              page: { nextCursor: draftReads === 1 ? "next" : null },
            });
          }
          return answer({ ok: true });
        });
        for (const path of ["inline", "directory"]) {
          locationPosts = [];
          validations = 0;
          const directoryRequest =
            path === "directory"
              ? page.waitForRequest(
                  (request) =>
                    new URL(request.url()).pathname ===
                      "/api/partners/portal/locations" &&
                    request.method() === "GET",
                )
              : null;
          if (path === "directory")
            directoryReadGate = new Promise<void>((resolve) => {
              releaseDirectoryRead = resolve;
            });
          await page.goto(`${base}/${path}`);
          await expect(page.locator("html")).toHaveAttribute(
            "data-harness-ready",
            "true",
          );
          await page
            .getByRole("button", {
              name:
                path === "inline"
                  ? "Add a location without leaving"
                  : "Add location",
              exact: true,
            })
            .click();
          const form = page.locator("form");
          await form
            .getByLabel("Location name", { exact: true })
            .fill("First location");
          await form
            .getByLabel("Street address", { exact: true })
            .fill("1 Local Test Way");
          await form.getByLabel("City", { exact: true }).fill("Atlanta");
          await form.getByLabel("ZIP code", { exact: true }).fill("30301");
          assert.equal(
            await form.evaluate((element: HTMLFormElement) =>
              element.checkValidity(),
            ),
            true,
            `${path}: required fields are valid before submit`,
          );
          const save = form.getByRole("button", {
            name:
              path === "inline" ? "Save and use this location" : "Add location",
            exact: true,
          });
          await directoryRequest;
          const [firstResponse] = await Promise.all([
            page.waitForResponse(
              (response) =>
                new URL(response.url()).pathname ===
                  "/api/partners/portal/locations" &&
                response.request().method() === "POST",
            ),
            save.click(),
          ]);
          assert.deepEqual(
            await firstResponse.json(),
            { ok: true },
            `${path}: the first save receives the intended incomplete response`,
          );
          assert.equal(
            JSON.parse(locationPosts[0]!.body!).siteName,
            "First location",
            `${path}: submitted React form contains the filled name`,
          );
          await expect(
            page.getByText(/We couldn’t confirm the saved location/u),
            `${path}: failed save remains visible for a safe retry`,
          ).toBeVisible();
          if (path === "directory") {
            releaseDirectoryRead!();
            await expect(
              page.getByText("Previously saved location", { exact: true }),
            ).toBeVisible();
            await expect(
              page.getByText(/We couldn’t confirm the saved location/u),
              "directory: a later successful read must not clear the failed save",
            ).toBeVisible();
          }
          const [retryResponse] = await Promise.all([
            page.waitForResponse(
              (response) =>
                new URL(response.url()).pathname ===
                  "/api/partners/portal/locations" &&
                response.request().method() === "POST",
            ),
            save.click(),
          ]);
          assert.deepEqual(
            await retryResponse.json(),
            { ok: true, location },
            `${path}: retry recovers the saved location`,
          );
          await expect(form).toHaveCount(0);
          assert.equal(locationPosts.length, 2);
          assert.ok(locationPosts[0]?.key);
          assert.deepEqual(locationPosts[1], locationPosts[0]);
          if (path === "directory")
            assert.equal(
              validations,
              1,
              "retry bypasses duplicate precheck and recovers original result",
            );
        }
        await page.goto(`${base}/wizard`);
        await page
          .getByRole("button", { name: "Try saving again", exact: true })
          .click();
        await expect(
          page.getByRole("button", { name: "Continue", exact: true }),
        ).toBeEnabled();
        assert.equal(draftPosts.length, 2);
        assert.ok(draftPosts[0]?.key);
        assert.deepEqual(draftPosts[1], draftPosts[0]);
        assert.equal(
          new URL(page.url()).searchParams.get("draftId"),
          "draft-A",
        );
        await page.goto(`${base}/saved`);
        await page.getByText("Unfinished requests", { exact: true }).click();
        await expect(
          page.getByRole("link", { name: "Saved original" }),
        ).toBeVisible();
        await page.getByRole("button", { name: "More saved requests" }).click();
        await expect(
          page.getByText(/Saved requests could not be loaded/u),
        ).toBeVisible();
        await expect(
          page.getByRole("link", { name: "Saved original" }),
        ).toBeVisible();
        await page
          .getByRole("button", { name: "Try again", exact: true })
          .click();
        await expect(
          page.getByText(/Saved requests could not be loaded/u),
        ).toHaveCount(0);
        await expect(
          page.getByRole("link", { name: "Saved original" }),
        ).toHaveCount(1);
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
}
