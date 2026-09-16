import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium, expect, webkit } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

const repo = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/u, "");
const require = createRequire(`${repo}/package.json`);
const siteRequire = createRequire(`${repo}/apps/site/package.json`);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const contents = `
  import React from 'react'; import {createRoot} from 'react-dom/client';
  import {CrewPayoutSelector} from './src/app/team/components/CrewPayoutSelector';
  import {MobileCompletionFinalTotalFields} from './src/app/mobile/MobileCompletionFinalTotalFields';
  import {CompletionDraftContext} from './src/app/mobile/mobile-completion-draft-context';
  import {parseCrewPayoutFormData} from './src/app/team/lib/crew-payout-form';
  const alice='11111111-1111-4111-8111-111111111111', bob='22222222-2222-4222-8222-222222222222';
  const scenario=new URLSearchParams(location.search).get('scenario');
  const unsetTotal=scenario==='unset-total';
  const emptyCrew=scenario==='empty-crew'||scenario==='empty-moving-crew';
  function App(){
    const [total,setTotal]=React.useState(unsetTotal?null:35000);
    const [result,setResult]=React.useState(null);
    const [restored,setRestored]=React.useState({draft:null,revision:0});
    return <main className="min-h-screen bg-slate-950 p-4 text-white"><h1 className="text-lg">Finish job</h1>
      <CompletionDraftContext.Provider value={restored}>
        <form className="space-y-4" onSubmit={event=>{event.preventDefault(); const form=new FormData(event.currentTarget); setResult({crew:parseCrewPayoutFormData(form),total:form.get('finalTotal'),expected:form.get('expectedFinalTotalCents')});}}>
          <MobileCompletionFinalTotalFields appointmentId="test" initialFinalTotalCents={total} quotedTotalCents={unsetTotal?null:35000} initialPaymentSummary={null} pricingContext={null} canManagePayments modern/>
          <CrewPayoutSelector compact stacked theme="dark" serviceType={scenario==='empty-crew'?'junk_removal':'moving'} teamMembers={[{id:alice,name:'Alice'},{id:bob,name:'Bob'}]} initialCrewMembers={emptyCrew?[]:[{memberId:alice,hourlyRateCents:scenario==='incomplete-moving-crew'?null:2750,workedMinutes:135}]}/>
          <button className="min-h-11 w-full bg-emerald-300 p-3 text-slate-950">Mark complete</button>
        </form>
      </CompletionDraftContext.Provider>
      <button className="min-h-11" onClick={()=>setTotal(40000)}>Receive newer total</button>
      <button className="min-h-11" onClick={()=>setRestored({revision:restored.revision+1,draft:{finalTotal:'425',expectedFinalTotalCents:'35000',crewMemberIds:[bob],crewHours:{[bob]:'3.75'},crewRates:{[bob]:'30.00'}}})}>Restore draft</button>
      <button className="min-h-11" onClick={()=>setRestored({revision:restored.revision+1,draft:{crewMemberIds:[alice],crewHours:{[alice]:'2.25'},crewRates:{[alice]:''}}})}>Restore incomplete crew</button>
      <output aria-label="Submitted values" className="block break-all">{result?JSON.stringify(result):''}</output>
    </main>;
  }
  createRoot(document.getElementById('root')).render(<App/>);
`;

async function typeWithoutLosingFocus(
  page: Page,
  input: Locator,
  value: string,
) {
  const originalInput = await input.elementHandle();
  assert.ok(originalInput, "The editor input is mounted before typing");
  await input.focus();
  try {
    for (const character of value) {
      await page.keyboard.type(character);
      assert.deepEqual(
        await originalInput.evaluate((node) => ({
          connected: node.isConnected,
          focused: document.activeElement === node,
        })),
        { connected: true, focused: true },
        `Typing ${JSON.stringify(character)} must preserve the original focused input`,
      );
    }
    await expect(input).toHaveValue(value);
  } finally {
    await originalInput.dispose();
  }
}

void test("compact mobile completion edits, submits and restores exact totals and moving time", async (t) => {
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
      "team/components/CrewWorkedTimeFields.tsx",
      "mobile/MobileCompletionFinalTotalFields.tsx",
    ].map((file) => readFile(`${repo}/apps/site/src/app/${file}`, "utf8")),
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
    response.setHeader(
      "Content-Type",
      request.url === "/client.js" ? "text/javascript" : "text/html",
    );
    response.end(
      request.url === "/client.js"
        ? bundle.outputFiles[0].contents
        : `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Compact completion test</title><style>${css}</style></head><body><div id="root"></div><script src="/client.js"></script></body></html>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Missing local server");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 320, height: 900 },
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page
      .getByRole("button", { name: "Change crew", exact: true })
      .waitFor();
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    await expect(page.getByRole("spinbutton")).toHaveCount(0);
    assert.equal(
      await page
        .locator("form")
        .evaluate((form: HTMLFormElement) => form.checkValidity()),
      true,
    );
    await page
      .getByRole("button", { name: "Mark complete", exact: true })
      .click();
    await expect(page.getByLabel("Submitted values")).toContainText(
      '"workedMinutes":135',
    );
    await expect(page.getByLabel("Submitted values")).toContainText(
      '"total":"350.00"',
    );

    await page
      .getByRole("button", { name: "Change crew", exact: true })
      .click();
    await expect(
      page.getByRole("spinbutton", { name: "Alice hours worked" }),
    ).toHaveValue("2");
    await expect(
      page.getByRole("spinbutton", { name: "Alice minutes worked" }),
    ).toHaveValue("15");
    await page
      .getByRole("spinbutton", { name: "Alice minutes worked" })
      .fill("16");
    await page.getByRole("checkbox", { name: "Bob" }).check();
    await page.getByRole("spinbutton", { name: "Bob hourly rate" }).fill("30");
    await page
      .getByRole("spinbutton", { name: "Bob minutes worked" })
      .fill("1");
    await page.getByRole("button", { name: "Done changing crew" }).click();
    assert.equal(
      await page
        .locator("form")
        .evaluate((form: HTMLFormElement) => form.checkValidity()),
      true,
    );
    await page
      .getByRole("button", { name: "Mark complete", exact: true })
      .click();
    await expect(page.getByLabel("Submitted values")).toContainText(
      '"workedMinutes":136',
    );
    await expect(page.getByLabel("Submitted values")).toContainText(
      '"workedMinutes":1',
    );

    await page
      .getByRole("button", { name: "Change total", exact: true })
      .click();
    await page.getByLabel("Final job total", { exact: true }).fill("375");
    await page.getByRole("button", { name: "Receive newer total" }).click();
    await expect(
      page.getByText(/The final total changed elsewhere/),
    ).toBeVisible();
    await expect(
      page.getByLabel("Final job total", { exact: true }),
    ).toHaveValue("375");
    await expect(page.locator('[name="expectedFinalTotalCents"]')).toHaveValue(
      "35000",
    );
    await page.getByRole("button", { name: "Restore draft" }).click();
    await expect(
      page.getByLabel("Final job total", { exact: true }),
    ).toHaveValue("425");
    await expect(
      page.getByText(/The final total changed elsewhere/),
    ).toBeVisible();
    await expect(page.locator('[name="expectedFinalTotalCents"]')).toHaveValue(
      "35000",
    );
    await expect(page.locator('[name="crewMemberId"]')).toHaveCount(1);
    await expect(page.locator('[name="crewMemberId"]')).toHaveValue(
      "22222222-2222-4222-8222-222222222222",
    );
    await page.getByRole("button", { name: "Use latest amount" }).click();
    await expect(
      page.getByLabel("Final job total", { exact: true }),
    ).toHaveValue("400.00");
    await page.getByLabel("Final job total", { exact: true }).fill("430");
    await expect(page.locator('[name="expectedFinalTotalCents"]')).toHaveValue(
      "40000",
    );
    await page
      .getByRole("button", { name: "Change crew", exact: true })
      .click();
    await expect(
      page.getByRole("spinbutton", { name: "Bob hours worked" }),
    ).toHaveValue("3");
    await expect(
      page.getByRole("spinbutton", { name: "Bob minutes worked" }),
    ).toHaveValue("45");
    await page
      .getByRole("button", { name: "Mark complete", exact: true })
      .click();
    await expect(page.getByLabel("Submitted values")).toContainText(
      '"workedMinutes":225',
    );
    await expect(page.getByLabel("Submitted values")).toContainText(
      '"total":"430"',
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.deepEqual(errors, []);

    for (const browserType of [chromium, webkit]) {
      await t.test(
        `${browserType.name()} mobile first-entry editors`,
        async (browserTest) => {
          const mobileBrowser = await browserType.launch();
          browserTest.after(() => mobileBrowser.close());

          async function scenarioPage(scenario: string) {
            const mobilePage = await mobileBrowser.newPage({
              viewport: { width: 390, height: 844 },
              isMobile: true,
              hasTouch: true,
            });
            await mobilePage.goto(
              `http://127.0.0.1:${address.port}/?scenario=${scenario}`,
            );
            return mobilePage;
          }

          await browserTest.test(
            "an unset total keeps the same focused input through multi-digit entry",
            async () => {
              const mobilePage = await scenarioPage("unset-total");
              try {
                const totalInput = mobilePage.getByLabel("Final job total", {
                  exact: true,
                });
                await expect(totalInput).toHaveValue("");
                await typeWithoutLosingFocus(mobilePage, totalInput, "1234.56");
                await mobilePage
                  .getByRole("button", { name: "Mark complete", exact: true })
                  .click();
                await expect(
                  mobilePage.getByLabel("Submitted values"),
                ).toContainText('"total":"1234.56"');
                await expect(
                  mobilePage.getByLabel("Submitted values"),
                ).toContainText('"expected":"null"');

                await totalInput.fill("");
                await typeWithoutLosingFocus(mobilePage, totalInput, "875.25");
                await mobilePage
                  .getByRole("button", { name: "Mark complete", exact: true })
                  .click();
                await expect(
                  mobilePage.getByLabel("Submitted values"),
                ).toContainText('"total":"875.25"');
              } finally {
                await mobilePage.close();
              }
            },
          );

          await browserTest.test(
            "an empty crew stays open while selecting multiple members until Done",
            async () => {
              const mobilePage = await scenarioPage("empty-crew");
              try {
                const alice = mobilePage.getByRole("checkbox", {
                  name: "Alice",
                });
                const bob = mobilePage.getByRole("checkbox", { name: "Bob" });
                const originalCheckbox = await alice.elementHandle();
                assert.ok(originalCheckbox);
                await alice.click();
                assert.equal(
                  await originalCheckbox.evaluate((node) => node.isConnected),
                  true,
                  "Selecting the first crew member must keep its checkbox mounted",
                );
                await expect(alice).toBeChecked();
                await expect(bob).toBeVisible();
                await bob.check();
                await expect(alice).toBeChecked();
                await expect(bob).toBeChecked();
                await mobilePage
                  .getByRole("button", {
                    name: "Done changing crew",
                    exact: true,
                  })
                  .click();
                await expect(mobilePage.getByRole("checkbox")).toHaveCount(0);
                await expect(
                  mobilePage.locator(
                    'input[type="hidden"][name="crewMemberId"]',
                  ),
                ).toHaveCount(2);
                await mobilePage
                  .getByRole("button", { name: "Mark complete", exact: true })
                  .click();
                const result = JSON.parse(
                  await mobilePage.getByLabel("Submitted values").innerText(),
                );
                assert.deepEqual(result.crew, {
                  ok: true,
                  crewMembers: [
                    {
                      memberId: "11111111-1111-4111-8111-111111111111",
                      splitBps: 1,
                    },
                    {
                      memberId: "22222222-2222-4222-8222-222222222222",
                      splitBps: 1,
                    },
                  ],
                });
                await mobilePage
                  .getByRole("button", { name: "Change crew", exact: true })
                  .click();
                await expect(alice).toBeChecked();
                await expect(bob).toBeChecked();
              } finally {
                await mobilePage.close();
              }
            },
          );

          await browserTest.test(
            "new hourly crew details stay focused when the first payout becomes valid",
            async () => {
              const mobilePage = await scenarioPage("empty-moving-crew");
              try {
                await mobilePage
                  .getByRole("checkbox", { name: "Alice" })
                  .check();
                await typeWithoutLosingFocus(
                  mobilePage,
                  mobilePage.getByRole("spinbutton", {
                    name: "Alice hourly rate",
                  }),
                  "27.50",
                );
                await typeWithoutLosingFocus(
                  mobilePage,
                  mobilePage.getByRole("spinbutton", {
                    name: "Alice hours worked",
                  }),
                  "12",
                );
                await typeWithoutLosingFocus(
                  mobilePage,
                  mobilePage.getByRole("spinbutton", {
                    name: "Alice minutes worked",
                  }),
                  "34",
                );
                await mobilePage.getByRole("checkbox", { name: "Bob" }).check();
                await typeWithoutLosingFocus(
                  mobilePage,
                  mobilePage.getByRole("spinbutton", {
                    name: "Bob hourly rate",
                  }),
                  "30",
                );
                await typeWithoutLosingFocus(
                  mobilePage,
                  mobilePage.getByRole("spinbutton", {
                    name: "Bob hours worked",
                  }),
                  "2",
                );
                await typeWithoutLosingFocus(
                  mobilePage,
                  mobilePage.getByRole("spinbutton", {
                    name: "Bob minutes worked",
                  }),
                  "15",
                );
                await mobilePage
                  .getByRole("button", {
                    name: "Done changing crew",
                    exact: true,
                  })
                  .click();
                await expect(mobilePage.getByRole("checkbox")).toHaveCount(0);
                await mobilePage
                  .getByRole("button", { name: "Mark complete", exact: true })
                  .click();
                const result = JSON.parse(
                  await mobilePage.getByLabel("Submitted values").innerText(),
                );
                assert.deepEqual(result.crew, {
                  ok: true,
                  crewMembers: [
                    {
                      memberId: "11111111-1111-4111-8111-111111111111",
                      hourlyRateCents: 2750,
                      workedMinutes: 754,
                    },
                    {
                      memberId: "22222222-2222-4222-8222-222222222222",
                      hourlyRateCents: 3000,
                      workedMinutes: 135,
                    },
                  ],
                });
              } finally {
                await mobilePage.close();
              }
            },
          );

          for (const scenario of [
            "incomplete-moving-crew",
            "restored-incomplete-crew",
          ]) {
            await browserTest.test(
              `${scenario} stays open when hourly inputs become valid`,
              async () => {
                const mobilePage = await scenarioPage(scenario);
                try {
                  if (scenario === "restored-incomplete-crew") {
                    await mobilePage
                      .getByRole("button", {
                        name: "Restore incomplete crew",
                        exact: true,
                      })
                      .click();
                  }
                  const rate = mobilePage.getByRole("spinbutton", {
                    name: "Alice hourly rate",
                  });
                  await expect(rate).toHaveValue("");
                  await typeWithoutLosingFocus(mobilePage, rate, "27.50");
                  await expect(
                    mobilePage.getByRole("checkbox", { name: "Bob" }),
                  ).toBeVisible();
                  await mobilePage
                    .getByRole("button", {
                      name: "Done changing crew",
                      exact: true,
                    })
                    .click();
                  await expect(rate).toHaveCount(0);
                  await mobilePage
                    .getByRole("button", { name: "Mark complete", exact: true })
                    .click();
                  const result = JSON.parse(
                    await mobilePage.getByLabel("Submitted values").innerText(),
                  );
                  assert.deepEqual(result.crew, {
                    ok: true,
                    crewMembers: [
                      {
                        memberId: "11111111-1111-4111-8111-111111111111",
                        hourlyRateCents: 2750,
                        workedMinutes: 135,
                      },
                    ],
                  });
                } finally {
                  await mobilePage.close();
                }
              },
            );
          }
        },
      );
    }
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
