import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium, expect } from "@playwright/test";

const repo = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/u, "");
const require = createRequire(`${repo}/package.json`);
const siteRequire = createRequire(`${repo}/apps/site/package.json`);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const scope =
  "Remove the deck and haul away the lumber.\nLeave the donation bin.\nUse the side gate; the dog stays inside.\nDo not remove the flowering tree.";
const contents = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {MobileAppointmentCard} from './src/app/mobile/MobileAppointmentCard';
import {publishMobileAppointmentSummary} from './src/app/mobile/mobile-appointment-summary';
history.replaceState({__NA:true,__PRIVATE_NEXTJS_INTERNALS_TREE:[]},'',location.href);
const pushHistory=history.pushState.bind(history);
history.pushState=(data,...args)=>{(window.__pushedHistory??=[]).push(data);pushHistory(data,...args)};
const initial={scope:${JSON.stringify(scope)},media:{readyCount:22,pendingCount:4,coverMediaId:null,needsScope:true},payment:{status:'unpaid',jobTotalCents:50000,paidTowardJobCents:0,tipCents:0,refundedCents:0,balanceCents:50000,activeAttemptId:null,latestReceiptUrl:null}};
function App(){
 const [state,setState]=React.useState(initial);
 const [submits,setSubmits]=React.useState(0);
 const legacy=new URLSearchParams(location.search).has('legacy');
 React.useEffect(()=>{window.updateServer=(patch)=>setState(s=>({...s,...patch}));window.publishSummary=(patch)=>publishMobileAppointmentSummary({appointmentId:'job-a',...patch});},[]);
 return <main className="min-h-screen space-y-4 bg-slate-950 p-4 text-white">
   <div className="h-80">Jobs for September 12</div>
   {['job-a','job-b'].map((id,index)=><MobileAppointmentCard key={id} cardId={id} customerName={index?'Jordan Smith':'Taylor Cooper'} timeLabel={index?'11:00–12:00 PM':'9:00–10:00 AM'} statusLabel="Confirmed" statusTone="confirmed" serviceCategoryLabel={index?'Moving':'Demo'} modern={!legacy}
     jobHref={'/mobile?screen=calendar&date=2026-09-12&jobId='+id}
     partnerAffiliation={index?{accountId:'contact-account',bookingId:null,displayName:'Contact affiliation',basis:'contact'}:{accountId:'account-a',bookingId:'partner-a',displayName:'Oak Property Management and Building Restoration',basis:'partner_booking'}}
     address="123 Long Residential Avenue, Atlanta, GA" mapsHref="https://maps.example.test/directions" quotedScopeText={state.scope} mediaSummary={state.media} paymentSummary={state.payment}
     quickActions={<><a className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm" href="tel:4045550101">Call</a><a className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm" href="/mobile?tab=inbox">Message</a></>}>
       <div data-mobile-photo-actions className="space-y-3"><button type="button" className="min-h-11">Take photo</button><p>Photo gallery loading</p></div>
       <details><summary>Other options</summary><button type="button">Reschedule</button></details>
       <details data-mobile-completion><summary className="min-h-11">Completion review</summary><form onSubmit={e=>{e.preventDefault();setSubmits(s=>s+1)}}><p>Saved total and selected crew</p><button type="submit" className="min-h-11">Save completion</button></form></details>
       <div className="h-80">Job history</div>
   </MobileAppointmentCard>)}
   <output aria-label="Submitted count">{submits}</output><div className="h-80"/>
 </main>;
}
createRoot(document.getElementById('root')).render(<App/>);
`;

void test("mobile cards keep identity clear and open an accessible job with direct, nonblocking completion access", async () => {
  const bundle = await build({
    stdin: { contents, resolveDir: `${repo}/apps/site`, loader: "tsx" },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "standalone-mobile-router",
        setup(builder) {
          builder.onResolve({ filter: /^next\/navigation$/ }, () => ({
            path: "router",
            namespace: "mobile-test",
          }));
          builder.onLoad({ filter: /.*/, namespace: "mobile-test" }, () => ({
            contents:
              "const router={refresh(){(window.__refreshLocations??=[]).push(location.href)},replace(href){history.replaceState({},'',href);(window.__replaceLocations??=[]).push(href)}};export function useRouter(){return router}",
            loader: "js",
          }));
        },
      },
    ],
  });
  const sources = await Promise.all(
    [
      "MobileAppointmentCard.tsx",
      "MobileJobView.tsx",
      "mobile-appointment-card-styles.ts",
    ].map((path) =>
      readFile(`${repo}/apps/site/src/app/mobile/${path}`, "utf8"),
    ),
  );
  const css = (
    await siteRequire("postcss")([
      siteRequire("tailwindcss")({
        ...siteRequire(`${repo}/apps/site/tailwind.config.ts`).default,
        content: [{ raw: [...sources, contents].join("\n"), extension: "tsx" }],
      }),
    ]).process("@tailwind base; @tailwind components; @tailwind utilities;", {
      from: undefined,
    })
  ).css;
  const server = createServer((request, response) => {
    if (request.url === "/client.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(bundle.outputFiles[0].contents);
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end(
        `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Booking cards</title><style>${css}</style></head><body><div id="root"></div><script src="/client.js"></script></body></html>`,
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing test port");
  const base = `http://127.0.0.1:${address.port}/mobile?tab=today&date=2026-09-12`;
  const browser = await chromium.launch();
  try {
    await mkdir(`${repo}/artifacts/mobile-booking-cards`, { recursive: true });
    for (const width of [320, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(base);
      const card = page.locator('article[data-appointment-id="job-a"]');
      await expect(card.getByText("Demo", { exact: true })).toBeVisible();
      await expect(card.getByText("Confirmed", { exact: true })).toBeVisible();
      await expect(
        card.getByText("Partner · Oak Property", { exact: false }),
      ).toBeVisible();
      await expect(
        page
          .locator('article[data-appointment-id="job-b"]')
          .getByText(/Partner/),
      ).toHaveCount(0);
      await expect(card.getByText(/22 photos|4 processing/)).toHaveCount(0);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );

      await card.scrollIntoViewIfNeeded();
      const scroll = await page.evaluate(() => scrollY);
      await page.screenshot({
        path: `${repo}/artifacts/mobile-booking-cards/cards-${width}.png`,
      });
      await card.getByRole("button", { name: "Open job", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(
        card.getByRole("button", { name: "Open job for Taylor Cooper" }),
      ).toHaveAttribute("aria-expanded", "true");
      await expect(dialog).toHaveAttribute("data-appointment-id", "job-a");
      await expect(
        dialog.getByRole("heading", { name: "Taylor Cooper" }),
      ).toBeVisible();
      await expect(
        dialog.getByRole("region", { name: "Work details" }),
      ).toContainText(scope);
      await expect(
        dialog.getByRole("button", { name: "Back to jobs" }),
      ).toBeFocused();
      await expect(
        dialog.getByRole("link", { name: "Call", exact: true }),
      ).toBeVisible();
      assert.equal(new URL(page.url()).searchParams.get("jobId"), "job-a");
      assert.equal(
        await page.evaluate(() =>
          (window as any).__pushedHistory.every(
            (state: object) =>
              !Object.prototype.hasOwnProperty.call(state, "__NA"),
          ),
        ),
        true,
      );
      assert.equal(new URL(page.url()).searchParams.get("date"), "2026-09-12");
      await page.screenshot({
        path: `${repo}/artifacts/mobile-booking-cards/job-${width}.png`,
      });

      await dialog
        .getByRole("button", { name: "Finish job", exact: true })
        .focus();
      await page.keyboard.press("Tab");
      await expect(
        dialog.getByRole("button", { name: "Back to jobs" }),
      ).toBeFocused();

      await dialog
        .getByRole("button", { name: "Finish job", exact: true })
        .click();
      await expect(dialog.locator("[data-mobile-completion]")).toHaveAttribute(
        "open",
        "",
      );
      await expect(
        dialog.getByText("Completion review", { exact: true }),
      ).toBeFocused();
      await expect(
        dialog.getByRole("button", { name: "Save completion" }),
      ).toBeVisible();
      await expect(dialog.locator("footer")).toHaveCount(0);
      await dialog.getByText("Completion review", { exact: true }).click();
      await expect(
        dialog.locator("footer").getByRole("button", { name: "Finish job" }),
      ).toBeVisible();
      await dialog
        .locator("footer")
        .getByRole("button", { name: "Finish job" })
        .click();
      await expect(dialog.locator("footer")).toHaveCount(0);
      await expect(
        dialog.locator("details").filter({ hasText: "Other options" }),
      ).not.toHaveAttribute("open", "");
      assert.equal(
        await page
          .locator('output[aria-label="Submitted count"]')
          .textContent(),
        "0",
      );
      assert.equal(
        await dialog.evaluate((node) => node.scrollWidth <= innerWidth),
        true,
      );
      await page.screenshot({
        path: `${repo}/artifacts/mobile-booking-cards/completion-${width}.png`,
      });

      // Next refresh drops custom history entries; the mounted card still
      // needs to traverse back to its list so Forward can restore this job.
      await page.evaluate(() =>
        history.replaceState({ __NA: true }, "", location.href),
      );

      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect
        .poll(() => new URL(page.url()).searchParams.get("jobId"))
        .toBe(null);
      await expect
        .poll(() =>
          page.evaluate(() => (window as any).__refreshLocations?.length ?? 0),
        )
        .toBeGreaterThan(0);
      assert.equal(
        await page.evaluate(() =>
          (window as any).__refreshLocations.every(
            (href: string) => !new URL(href).searchParams.has("jobId"),
          ),
        ),
        true,
      );
      assert.equal(await page.evaluate(() => scrollY), scroll);
      await expect(
        card.getByRole("button", { name: "Open job", exact: true }),
      ).toBeFocused();
      await page.goForward();
      await expect(dialog).toBeVisible();
      await page.goBack();
      await expect(dialog).toHaveCount(0);

      await page.evaluate(() => {
        (window as any).publishSummary({
          quotedScopeText: "Updated scope. Keep all flowers.",
          mediaSummary: {
            readyCount: 23,
            pendingCount: 0,
            coverMediaId: null,
            needsScope: false,
          },
          paymentSummary: {
            status: "paid",
            jobTotalCents: 50000,
            paidTowardJobCents: 50000,
            tipCents: 0,
            refundedCents: 0,
            balanceCents: 0,
            activeAttemptId: null,
            latestReceiptUrl: null,
          },
        });
        (window as any).updateServer({ unrelated: "stale refresh" });
      });
      await expect(card).toContainText("Updated scope. Keep all flowers.");
      await expect(card.getByText(/Scope needed|due|Paid/)).toHaveCount(0);
      await page.evaluate(() =>
        (window as any).updateServer({
          scope: "New server scope",
          media: {
            readyCount: 24,
            pendingCount: 0,
            coverMediaId: null,
            needsScope: true,
          },
        }),
      );
      await expect(card).toContainText("New server scope");
      await expect(card).toContainText("Scope needed");

      await page.goto(`${base}&jobId=job-b`);
      await expect(page.getByRole("dialog")).toHaveAttribute(
        "data-appointment-id",
        "job-b",
      );
      await page.reload();
      await expect(page.getByRole("dialog")).toHaveAttribute(
        "data-appointment-id",
        "job-b",
      );
      await page.getByRole("button", { name: "Back to jobs" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      assert.equal(new URL(page.url()).searchParams.get("jobId"), null);
      assert.equal(new URL(page.url()).searchParams.get("date"), "2026-09-12");

      await page.goto(`http://127.0.0.1:${address.port}/mobile`);
      await card.scrollIntoViewIfNeeded();
      const bareScroll = await page.evaluate(() => scrollY);
      await card.getByRole("button", { name: "Open job", exact: true }).click();
      assert.equal(new URL(page.url()).searchParams.get("date"), "2026-09-12");
      assert.equal(new URL(page.url()).searchParams.get("screen"), "calendar");
      await page.goBack();
      await expect(dialog).toHaveCount(0);
      await expect.poll(() => new URL(page.url()).search).toBe("");
      assert.equal(await page.evaluate(() => scrollY), bareScroll);
      await expect(
        card.getByRole("button", { name: "Open job", exact: true }),
      ).toBeFocused();

      await page.goto(`${base}&legacy=1`);
      await page
        .locator('article[data-appointment-id="job-a"]')
        .getByRole("button", { name: /Show details/ })
        .click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(
        page
          .locator('article[data-appointment-id="job-a"]')
          .getByText("Photo gallery loading"),
      ).toBeVisible();
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
