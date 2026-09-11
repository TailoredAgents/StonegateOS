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
const tailwindConfig = siteRequire(
  `${repo}/apps/site/tailwind.config.ts`,
).default;
const contents = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {AppointmentBookingDetailsFields} from './src/app/team/components/AppointmentBookingDetailsFields';
  import {CrewPayoutSelector} from './src/app/team/components/CrewPayoutSelector';
  import {parseCrewPayoutFormData} from './src/app/team/lib/crew-payout-form';
  const dark = new URLSearchParams(location.search).has('dark');
  const saved = new URLSearchParams(location.search).has('saved');
  const teamMembers = [{id:'11111111-1111-4111-8111-111111111111',name:'Alex'}, {id:'22222222-2222-4222-8222-222222222222',name:'Jordan'}];
  function App() {
    const [result,setResult]=React.useState(null);
    return <main className={dark ? 'min-h-screen bg-slate-950 p-4 text-white' : 'min-h-screen bg-slate-50 p-4 text-slate-900'}>
      <form className="mx-auto max-w-xl space-y-5" onSubmit={event=>{event.preventDefault();setResult(parseCrewPayoutFormData(new FormData(event.currentTarget)));}}>
        <h1 className="text-xl font-semibold">{dark ? 'Complete moving job' : 'Book and complete job'}</h1>
        {dark ? <input type="hidden" name="serviceType" value="moving"/> : <div className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2">
          <AppointmentBookingDetailsFields teamMembers={teamMembers} allowServiceTypeSelection hideLeadSource
            bookingDetails={{serviceType:'moving',source:{type:'google'},pricing:{mode:'exact'}}}
            quotedTotalCents={65000} labelClassName="block space-y-1 text-sm font-medium" fieldClassName="min-h-11 w-full min-w-0 rounded-lg border border-slate-300 px-3 py-2 text-base"/>
        </div>}
        <CrewPayoutSelector teamMembers={teamMembers} serviceType="moving" stacked theme={dark?'dark':'light'} showSplitPercentages={false}
          initialCrewMembers={saved?[{memberId:teamMembers[0].id,hourlyRateCents:2750,workedMinutes:135}]:[]}/>
        <button className="min-h-11 w-full rounded-xl bg-emerald-700 px-4 py-3 font-semibold text-white">Complete job</button>
        <output aria-label="Saved crew" className="block break-all text-xs">{result?JSON.stringify(result):''}</output>
      </form>
    </main>;
  }
  createRoot(document.getElementById('root')).render(<App/>);
`;

void test("moving booking and completion work on desktop and narrow mobile screens", async () => {
  const bundle = await build({
    stdin: { contents, resolveDir: `${repo}/apps/site`, loader: "tsx" },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const sources = await Promise.all(
    [
      "team/components/CrewPayoutSelector.tsx",
      "team/components/AppointmentBookingDetailsFields.tsx",
      "team/components/LeadSourceFields.tsx",
    ].map((path) => readFile(`${repo}/apps/site/src/app/${path}`, "utf8")),
  );
  const css = (
    await siteRequire("postcss")([
      siteRequire("tailwindcss")({
        ...tailwindConfig,
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
        `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Moving job validation</title><style>${css}</style></head><body><div id="root"></div><script src="/client.js"></script></body></html>`,
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Missing local test server port");
  const browser = await chromium.launch();
  try {
    await mkdir(`${repo}/artifacts/moving-jobs`, { recursive: true });
    for (const [width, dark] of [
      [1024, false],
      [375, true],
      [320, true],
    ] as const) {
      const page = await browser.newPage({ viewport: { width, height: 950 } });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(
        `http://127.0.0.1:${address.port}/?${dark ? "dark" : ""}`,
      );
      if (!dark) {
        await expect(
          page.getByLabel("Destination address", { exact: false }),
        ).toBeVisible();
        await expect(page.locator('[name="loadSize"]')).toHaveCount(0);
      }
      await expect(
        page.getByRole("spinbutton", { name: "Alex hourly rate" }),
      ).toHaveCount(0);
      await page.getByRole("checkbox", { name: "Alex" }).check();
      await page
        .getByRole("spinbutton", { name: "Alex hourly rate" })
        .fill("27.50");
      await page
        .getByRole("spinbutton", { name: "Alex hours worked" })
        .fill("2.25");
      await page.getByRole("checkbox", { name: "Jordan" }).check();
      await page
        .getByRole("spinbutton", { name: "Jordan hourly rate" })
        .fill("30");
      await page
        .getByRole("spinbutton", { name: "Jordan hours worked" })
        .fill("3.5");
      await expect(page.locator('[aria-live="polite"]')).toContainText(
        "$166.88",
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth,
        ),
        false,
        `No overflow at ${width}px`,
      );
      await page.screenshot({
        path: `${repo}/artifacts/moving-jobs/completion-${width}.png`,
        fullPage: true,
      });
      await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
      const violations = await page.evaluate(async () =>
        (
          await (window as any).axe.run(document, {
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
          })
        ).violations.map((v: any) => ({
          id: v.id,
          impact: v.impact,
          nodes: v.nodes.map((n: any) => n.target),
        })),
      );
      assert.deepEqual(violations, [], `Accessibility at ${width}px`);
      await page
        .getByRole("button", { name: "Complete job", exact: true })
        .click();
      await expect(page.getByLabel("Saved crew")).toContainText(
        '"workedMinutes":135',
      );
      await expect(page.getByLabel("Saved crew")).toContainText(
        '"hourlyRateCents":3000',
      );
      await page.getByRole("checkbox", { name: "Jordan" }).uncheck();
      await expect(
        page.getByRole("spinbutton", { name: "Jordan hours worked" }),
      ).toHaveCount(0);
      await expect(page.locator('[aria-live="polite"]')).toContainText(
        "$61.88",
      );
      if (!dark) {
        await page
          .getByRole("combobox", { name: "Job type" })
          .selectOption("junk_removal");
        await expect(
          page.getByRole("spinbutton", { name: "Alex hourly rate" }),
        ).toHaveCount(0);
        await expect(page.locator('[name="crewCompensationMode"]')).toHaveValue(
          "percentage",
        );
        await page
          .getByRole("combobox", { name: "Job type" })
          .selectOption("moving");
        await expect(
          page.getByRole("spinbutton", { name: "Alex hourly rate" }),
        ).toHaveValue("27.50");
      }
      await page.goto(
        `http://127.0.0.1:${address.port}/?saved&${dark ? "dark" : ""}`,
      );
      await expect(page.getByRole("checkbox", { name: "Alex" })).toBeChecked();
      await expect(
        page.getByRole("spinbutton", { name: "Alex hourly rate" }),
      ).toHaveValue("27.50");
      await expect(
        page.getByRole("spinbutton", { name: "Alex hours worked" }),
      ).toHaveValue("2.25");
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
