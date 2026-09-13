import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium, expect, type Page } from "@playwright/test";

const repo = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/u, "");
const require = createRequire(`${repo}/package.json`);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const alice = "11111111-1111-4111-8111-111111111111";
const bob = "22222222-2222-4222-8222-222222222222";
const contents = `
  import React from 'react'; import {createRoot} from 'react-dom/client';
  import {MobileCompletionDraftForm} from './src/app/mobile/MobileCompletionDraft';
  import {MobileAppointmentNoteForm} from './src/app/mobile/MobileAppointmentNoteForm';
  import {MobileCompletionFinalTotalFields} from './src/app/mobile/MobileCompletionFinalTotalFields';
  import {CrewPayoutSelector} from './src/app/team/components/CrewPayoutSelector';
  import {readMobileJobDraft} from './src/app/mobile/lib/mobile-job-drafts';
  window.actionCalls=[]; window.actionOutcomes=[]; window.actionResolves=[]; window.refreshCount=0;
  window.getDraft=(kind)=>readMobileJobDraft({employeeId:'crew-test',appointmentId:'job-test',appointmentVersion:'v1',kind});
  function App(){
    const [opened,setOpened]=React.useState(true),[version,setVersion]=React.useState('v1'),[total,setTotal]=React.useState(35000),[completed,setCompleted]=React.useState(false),[serverCrew,setServerCrew]=React.useState('${alice}');
    const serverValues={finalTotal:(total/100).toFixed(2),expectedFinalTotalCents:String(total),finalTotalChangeReason:'',crewMemberIds:[serverCrew],crewHours:{[serverCrew]:serverCrew==='${alice}'?'2.5':'3.11666667'},crewRates:{[serverCrew]:serverCrew==='${alice}'?'25.50':'30.00'},proofOverrideReason:'',sendReviewRequest:false};
    return <main><h1>Booking recovery fixture</h1>
      <button onClick={()=>setOpened(!opened)}>{opened?'Close job':'Open job'}</button>
      <button onClick={()=>{setVersion('v2');setTotal(40000);}}>Newer server booking</button>
      <button onClick={()=>setVersion('v2')}>Refresh confirmed note</button>
      <button onClick={()=>{setVersion('v2');setCompleted(true);}}>Refresh completed booking</button>
      <button onClick={()=>{setVersion('v2');setTotal(40000);setServerCrew('${bob}');}}>Newer server crew</button>
      {opened?<section>
        <MobileCompletionDraftForm employeeId="crew-test" appointmentId="job-test" appointmentVersion={version} appointmentCompleted={completed} serverValues={serverValues}>
          <input type="hidden" name="appointmentId" value="job-test"/>
          <input type="hidden" name="expectedVersion" value={version}/>
          <input type="hidden" name="idempotencyKey" value={'render-key-'+version}/>
          <input type="hidden" name="status" value="completed"/>
          <input type="hidden" name="appointmentType" value="job"/>
          <MobileCompletionFinalTotalFields appointmentId="job-test" modern initialFinalTotalCents={total} quotedTotalCents={35000} initialPaymentSummary={null} pricingContext={null} canManagePayments/>
          <CrewPayoutSelector compact serviceType="moving" teamMembers={[{id:'${alice}',name:'Alice'},{id:'${bob}',name:'Bob'}]} initialCrewMembers={[{memberId:serverCrew,hourlyRateCents:serverCrew==='${alice}'?2550:3000,workedMinutes:serverCrew==='${alice}'?150:187}]}/>
          <details><summary>Existing proof exception</summary><label>Proof exception<textarea name="proofOverrideReason" minLength={10} maxLength={500}/></label></details>
          <label><input type="checkbox" name="sendReviewRequest"/>Request review</label>
          <button type="submit">Finish job</button>
        </MobileCompletionDraftForm>
        <MobileAppointmentNoteForm employeeId="crew-test" appointmentId="job-test" appointmentVersion={version}/>
      </section>:null}
    </main>;
  }
  createRoot(document.getElementById('root')).render(<App/>);
`;

const actionStub = `
  async function act(kind,data){
    const entries=Array.from(data.entries()); window.actionCalls.push({kind,entries});
    const next=window.actionOutcomes.shift()||{ok:true,appointmentId:'job-test',version:'v2',message:kind==='completion'?'Job completed':'Note saved'};
    if(next==='defer') return new Promise((resolve,reject)=>window.actionResolves.push(value=>value==='throw'?reject(new Error('Lost response')):resolve(value)));
    if(next==='throw') throw new Error('Lost response');
    return next;
  }
  export const saveMobileAppointmentCompletionAction=data=>act('completion',data);
  export const updateMobileAppointmentStatusAction=data=>act('legacy',data);
  export const saveMobileAppointmentNoteAction=data=>act('note',data);
`;

async function calls(
  page: Page,
  kind?: string,
): Promise<Array<{ kind: string; entries: Array<[string, string]> }>> {
  return page.evaluate(
    (kind) =>
      (window as any).actionCalls.filter(
        (call: any) => !kind || call.kind === kind,
      ),
    kind,
  );
}
async function outcomes(page: Page, ...values: unknown[]) {
  await page.evaluate(
    (values) => (window as any).actionOutcomes.push(...values),
    values,
  );
}
async function draft(page: Page, kind = "completion"): Promise<any> {
  return page.evaluate((kind) => (window as any).getDraft(kind), kind);
}
async function reopen(page: Page) {
  await page.getByRole("button", { name: "Close job", exact: true }).click();
  await page.getByRole("button", { name: "Open job", exact: true }).click();
  await page.locator("[data-mobile-completion-form]").waitFor();
}
async function editTotal(page: Page, value: string) {
  const change = page.getByRole("button", {
    name: "Change total",
    exact: true,
  });
  if (await change.count()) await change.click();
  await page.getByLabel("Final job total", { exact: true }).fill(value);
}
async function editCrew(page: Page) {
  const change = page.getByRole("button", { name: "Change crew", exact: true });
  if (await change.count()) await change.click();
}
async function openNote(page: Page) {
  await page.locator("[data-mobile-note] > summary").click();
}

void test("booking drafts recover without duplicate completion or note effects", async (t) => {
  const bundle = await build({
    stdin: { contents, resolveDir: `${repo}/apps/site`, loader: "tsx" },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "recovery-action-stubs",
        setup(build: any) {
          build.onResolve({ filter: /^\.\/actions$/ }, () => ({
            path: "actions",
            namespace: "recovery",
          }));
          build.onResolve({ filter: /^next\/navigation$/ }, () => ({
            path: "navigation",
            namespace: "recovery",
          }));
          build.onLoad(
            { filter: /.*/, namespace: "recovery" },
            ({ path }: { path: string }) => ({
              contents:
                path === "actions"
                  ? actionStub
                  : "const router={refresh:()=>{window.refreshCount+=1;}};export const useRouter=()=>router;",
              loader: "js",
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
        : '<!doctype html><html lang="en"><head><title>Booking recovery</title></head><body><div id="root"></div><script src="/client.js"></script></body></html>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Missing fixture server");
  const browser = await chromium.launch();
  const newPage = async () => {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.locator("[data-mobile-completion-form]").waitFor();
    return page;
  };
  try {
    await t.test(
      "close/remount restores total, selected crew, canonical moving minutes and note text",
      async () => {
        const page = await newPage();
        try {
          await editTotal(page, "375.50");
          await editCrew(page);
          await page.getByRole("checkbox", { name: "Alice" }).uncheck();
          await page.getByRole("checkbox", { name: "Bob" }).check();
          await page
            .getByRole("spinbutton", { name: "Bob hourly rate" })
            .fill("30.00");
          await page
            .getByRole("spinbutton", { name: "Bob hours worked" })
            .fill("3");
          await page
            .getByRole("spinbutton", { name: "Bob minutes worked" })
            .fill("7");
          await expect
            .poll(async () => (await draft(page))?.values.values.crewHours[bob])
            .toBe("3.11666667");
          await openNote(page);
          await page
            .getByLabel("Job note")
            .fill("Use rear gate; keep the blue cabinet.");
          await reopen(page);
          await expect(
            page.getByLabel("Final job total", { exact: true }),
          ).toHaveValue("375.50");
          await expect(page.locator('[name="crewMemberId"]')).toHaveCount(1);
          await expect(page.locator('[name="crewMemberId"]')).toHaveValue(bob);
          await editCrew(page);
          await expect(
            page.getByRole("spinbutton", { name: "Bob hours worked" }),
          ).toHaveValue("3");
          await expect(
            page.getByRole("spinbutton", { name: "Bob minutes worked" }),
          ).toHaveValue("7");
          await expect(
            page.getByRole("spinbutton", { name: "Bob hourly rate" }),
          ).toHaveValue("30.00");
          await openNote(page);
          await expect(page.getByLabel("Job note")).toHaveValue(
            "Use rear gate; keep the blue cabinet.",
          );
          assert.equal((await calls(page)).length, 0);
          await page.reload();
          await expect(
            page.getByLabel("Final job total", { exact: true }),
          ).toHaveValue("375.50");
          await expect(page.locator('[name="crewMemberId"]')).toHaveValue(bob);
          await openNote(page);
          await expect(page.getByLabel("Job note")).toHaveValue(
            "Use rear gate; keep the blue cabinet.",
          );
        } finally {
          await page.close();
        }
      },
    );

    await t.test(
      "a draft from another version waits for review and preserves the latest total",
      async () => {
        const page = await newPage();
        try {
          await editTotal(page, "375");
          await page
            .getByRole("button", { name: "Close job", exact: true })
            .click();
          await page
            .getByRole("button", { name: "Newer server booking" })
            .click();
          await page
            .getByRole("button", { name: "Open job", exact: true })
            .click();
          await expect(page.locator('[name="finalTotal"]')).toHaveValue(
            "400.00",
          );
          await page
            .getByText("Saved entries from an earlier version", { exact: true })
            .click();
          await page
            .getByRole("button", { name: "Review saved entries in form" })
            .click();
          await expect(
            page.getByLabel("Final job total", { exact: true }),
          ).toHaveValue("375");
          await expect(
            page.getByText(/The final total changed elsewhere to/),
          ).toBeVisible();
          await expect(
            page.locator('[name="expectedFinalTotalCents"]'),
          ).toHaveValue("35000");
          assert.equal((await calls(page)).length, 0);
        } finally {
          await page.close();
        }
      },
    );

    await t.test(
      "empty optional proof and review do not block completion; confirmed success clears the draft",
      async () => {
        const page = await newPage();
        try {
          await editTotal(page, "0");
          await page
            .getByRole("button", { name: "Finish job", exact: true })
            .click();
          await expect(
            page.getByText("Job completed", { exact: true }),
          ).toBeVisible();
          const [request] = await calls(page, "completion");
          assert.equal(new Map(request!.entries).get("finalTotal"), "0");
          assert.equal(
            new Map(request!.entries).get("proofOverrideReason"),
            "",
          );
          assert.equal(
            new Map(request!.entries).has("sendReviewRequest"),
            false,
          );
          assert.equal(await draft(page), null);
        } finally {
          await page.close();
        }
      },
    );

    await t.test(
      "known validation errors retain inputs and edited retry receives a new request identity",
      async () => {
        const page = await newPage();
        try {
          await outcomes(page, {
            ok: false,
            error: "Work details are missing",
            uncertain: false,
          });
          await editTotal(page, "375");
          await page
            .getByRole("button", { name: "Finish job", exact: true })
            .click();
          await expect(page.getByRole("alert")).toContainText(
            "Work details are missing",
          );
          await expect(
            page.getByLabel("Final job total", { exact: true }),
          ).toHaveValue("375");
          await editTotal(page, "390");
          await page
            .getByRole("button", { name: "Finish job", exact: true })
            .click();
          await expect(
            page.getByText("Job completed", { exact: true }),
          ).toBeVisible();
          const requests = await calls(page, "completion");
          assert.equal(requests.length, 2);
          assert.notEqual(
            new Map(requests[0]!.entries).get("idempotencyKey"),
            new Map(requests[1]!.entries).get("idempotencyKey"),
          );
          assert.equal(new Map(requests[1]!.entries).get("finalTotal"), "390");
        } finally {
          await page.close();
        }
      },
    );

    await t.test(
      "duplicate submits and lost response retry reuse the exact request across remount",
      async () => {
        const page = await newPage();
        try {
          await outcomes(page, "defer");
          await editTotal(page, "375");
          await page
            .getByRole("button", { name: "Finish job", exact: true })
            .click();
          await expect.poll(async () => (await calls(page)).length).toBe(1);
          await page
            .getByRole("button", { name: "Finish job", exact: true })
            .evaluate((button: HTMLButtonElement) => {
              button.click();
              button.click();
            });
          assert.equal((await calls(page)).length, 1);
          await page.evaluate(() =>
            (window as any).actionResolves.shift()("throw"),
          );
          await expect(page.getByRole("alert")).toContainText(
            "could not be confirmed",
          );
          await reopen(page);
          await page
            .getByRole("button", { name: "Finish job", exact: true })
            .click();
          await expect(
            page.getByText("Job completed", { exact: true }),
          ).toBeVisible();
          const requests = await calls(page, "completion");
          assert.equal(requests.length, 2);
          assert.deepEqual(requests[0]!.entries, requests[1]!.entries);
        } finally {
          await page.close();
        }
      },
    );

    await t.test(
      "newer completion edits survive confirmation of an earlier uncertain request",
      async () => {
        const page = await newPage();
        try {
          await outcomes(page, "throw");
          await editTotal(page, "375");
          await page
            .getByRole("button", { name: "Finish job", exact: true })
            .click();
          await expect(page.getByRole("alert")).toContainText(
            "could not be confirmed",
          );
          await editTotal(page, "399");
          await editCrew(page);
          await page
            .getByRole("spinbutton", { name: "Alice minutes worked" })
            .fill("37");
          await page
            .getByRole("button", { name: "Finish job", exact: true })
            .click();
          await expect.poll(async () => (await calls(page)).length).toBe(2);
          const requests = await calls(page);
          assert.deepEqual(requests[0]!.entries, requests[1]!.entries);
          await expect
            .poll(async () => (await draft(page))?.values.values.finalTotal)
            .toBe("399");
          const saved = await draft(page);
          assert.equal(saved.values.values.crewHours[alice], "2.61666667");
          assert.equal(saved.values.request, undefined);
        } finally {
          await page.close();
        }
      },
    );

    await t.test(
      "checking an uncertain save bypasses invalid newer inputs and reuses the frozen request",
      async () => {
        const page = await newPage();
        try {
          await outcomes(page, "throw");
          await editTotal(page, "375");
          await page
            .getByRole("button", { name: "Finish job", exact: true })
            .click();
          await expect(page.getByRole("alert")).toContainText(
            "could not be confirmed",
          );
          await editTotal(page, "");
          const total = page.getByLabel("Final job total", { exact: true });
          assert.equal(
            await total.evaluate(
              (input: HTMLInputElement) => input.validity.valid,
            ),
            false,
          );
          await page
            .getByRole("button", { name: "Check previous save", exact: true })
            .click();
          await expect(
            page.getByText(
              "Job completed Your later edits remain saved for review.",
              { exact: true },
            ),
          ).toBeVisible();
          const requests = await calls(page, "completion");
          assert.equal(requests.length, 2);
          assert.deepEqual(requests[0]!.entries, requests[1]!.entries);
          assert.equal(new Map(requests[1]!.entries).get("finalTotal"), "375");
          assert.equal((await draft(page)).values.values.finalTotal, "");
          assert.equal((await draft(page)).values.request, undefined);
        } finally {
          await page.close();
        }
      },
    );

    await t.test(
      "a confirmed local note safely advances the version while preserving dirty selected crew",
      async () => {
        const page = await newPage();
        try {
          await editCrew(page);
          await page.getByRole("checkbox", { name: "Alice" }).uncheck();
          await page.getByRole("checkbox", { name: "Bob" }).check();
          await page
            .getByRole("spinbutton", { name: "Bob hourly rate" })
            .fill("30.00");
          await page
            .getByRole("spinbutton", { name: "Bob hours worked" })
            .fill("3");
          await page
            .getByRole("spinbutton", { name: "Bob minutes worked" })
            .fill("7");
          await expect
            .poll(async () => (await draft(page))?.values.values.crewHours[bob])
            .toBe("3.11666667");
          await openNote(page);
          await page.getByLabel("Job note").fill("Use rear gate.");
          await page
            .getByRole("button", { name: "Save note", exact: true })
            .click();
          await expect(
            page.getByText("Note saved", { exact: true }),
          ).toBeVisible();
          await expect
            .poll(async () => (await draft(page))?.appointmentVersion)
            .toBe("v2");
          await page
            .getByRole("button", {
              name: "Refresh confirmed note",
              exact: true,
            })
            .click();
          await expect(page.locator('[name="expectedVersion"]')).toHaveValue(
            "v2",
          );
          await expect(
            page.getByRole("checkbox", { name: "Alice" }),
          ).not.toBeChecked();
          await expect(
            page.getByRole("checkbox", { name: "Bob" }),
          ).toBeChecked();
          await expect(
            page.getByRole("spinbutton", { name: "Bob hourly rate" }),
          ).toHaveValue("30.00");
          await expect(
            page.getByRole("spinbutton", { name: "Bob hours worked" }),
          ).toHaveValue("3");
          await expect(
            page.getByRole("spinbutton", { name: "Bob minutes worked" }),
          ).toHaveValue("7");
          await expect(
            page.getByText("Booking updated elsewhere", { exact: true }),
          ).toHaveCount(0);
          await page
            .getByRole("button", { name: "Finish job", exact: true })
            .click();
          await expect(
            page.getByText("Job completed", { exact: true }),
          ).toBeVisible();
          const [request] = await calls(page, "completion");
          const entries = new Map(request!.entries);
          assert.equal(entries.get("expectedVersion"), "v2");
          assert.equal(entries.get("crewMemberId"), bob);
          assert.equal(entries.get(`crewHours:${bob}`), "3.11666667");
          assert.equal(entries.get(`crewHourlyRate:${bob}`), "30.00");
        } finally {
          await page.close();
        }
      },
    );

    await t.test(
      "unrelated server changes keep the captured version until latest details are explicitly chosen",
      async () => {
        const page = await newPage();
        try {
          await editTotal(page, "375");
          await editCrew(page);
          await page.getByRole("checkbox", { name: "Alice" }).uncheck();
          await page.getByRole("checkbox", { name: "Bob" }).check();
          await page
            .getByRole("spinbutton", { name: "Bob hourly rate" })
            .fill("30.00");
          await page
            .getByRole("spinbutton", { name: "Bob hours worked" })
            .fill("3");
          await page
            .getByRole("button", { name: "Newer server booking", exact: true })
            .click();
          await expect(
            page.getByText("Booking updated elsewhere", { exact: true }),
          ).toBeVisible();
          await expect(
            page.getByLabel("Final job total", { exact: true }),
          ).toHaveValue("375");
          await expect(
            page.getByRole("checkbox", { name: "Alice" }),
          ).not.toBeChecked();
          await expect(
            page.getByRole("checkbox", { name: "Bob" }),
          ).toBeChecked();
          await outcomes(page, {
            ok: false,
            error: "Appointment changed elsewhere",
            submitted: true,
            uncertain: false,
          });
          await page
            .getByRole("button", { name: "Finish job", exact: true })
            .click();
          await expect(page.getByRole("alert")).toContainText(
            "Appointment changed elsewhere",
          );
          const [first] = await calls(page, "completion");
          const original = new Map(first!.entries);
          assert.equal(original.get("expectedVersion"), "v1");
          assert.equal(original.get("expectedFinalTotalCents"), "35000");
          assert.equal(original.get("finalTotal"), "375");
          assert.equal(original.get("crewMemberId"), bob);
          assert.equal((await draft(page)).appointmentVersion, "v1");
          await page
            .getByText("Booking updated elsewhere", { exact: true })
            .click();
          await page
            .getByRole("button", {
              name: "Use latest saved details",
              exact: true,
            })
            .click();
          await expect(
            page.getByLabel("Final job total", { exact: true }),
          ).toHaveValue("400.00");
          await expect(
            page.locator('[name="expectedFinalTotalCents"]'),
          ).toHaveValue("40000");
          await expect(
            page.getByRole("checkbox", { name: "Alice" }),
          ).toBeChecked();
          await expect(
            page.getByRole("checkbox", { name: "Bob" }),
          ).not.toBeChecked();
          await page
            .getByRole("button", { name: "Finish job", exact: true })
            .click();
          await expect(
            page.getByText("Job completed", { exact: true }),
          ).toBeVisible();
          const requests = await calls(page, "completion");
          assert.equal(requests.length, 2);
          const latest = new Map(requests[1]!.entries);
          assert.equal(latest.get("expectedVersion"), "v2");
          assert.equal(latest.get("expectedFinalTotalCents"), "40000");
          assert.equal(latest.get("finalTotal"), "400.00");
          assert.equal(latest.get("crewMemberId"), alice);
          assert.notEqual(
            latest.get("idempotencyKey"),
            original.get("idempotencyKey"),
          );
        } finally {
          await page.close();
        }
      },
    );

    await t.test(
      "an untouched form follows newer server crew and total without needing a reopen",
      async () => {
        const page = await newPage();
        try {
          await expect(page.locator('[name="crewMemberId"]')).toHaveValue(
            alice,
          );
          await page
            .getByRole("button", { name: "Newer server crew", exact: true })
            .click();
          await expect(page.locator('[name="finalTotal"]')).toHaveValue(
            "400.00",
          );
          await expect(
            page.locator('[name="expectedFinalTotalCents"]'),
          ).toHaveValue("40000");
          await expect(page.locator('[name="crewMemberId"]')).toHaveValue(bob);
          await editCrew(page);
          await expect(
            page.getByRole("checkbox", { name: "Alice" }),
          ).not.toBeChecked();
          await expect(
            page.getByRole("checkbox", { name: "Bob" }),
          ).toBeChecked();
          await expect(
            page.getByRole("spinbutton", { name: "Bob hourly rate" }),
          ).toHaveValue("30.00");
          await expect(
            page.getByRole("spinbutton", { name: "Bob hours worked" }),
          ).toHaveValue("3");
          await expect(
            page.getByRole("spinbutton", { name: "Bob minutes worked" }),
          ).toHaveValue("7");
          await expect(
            page.getByText("Booking updated elsewhere", { exact: true }),
          ).toHaveCount(0);
          await page
            .getByRole("button", { name: "Finish job", exact: true })
            .click();
          await expect(
            page.getByText("Job completed", { exact: true }),
          ).toBeVisible();
          const [request] = await calls(page, "completion");
          assert.equal(new Map(request!.entries).get("expectedVersion"), "v2");
          assert.equal(new Map(request!.entries).get("crewMemberId"), bob);
        } finally {
          await page.close();
        }
      },
    );

    await t.test(
      "a refreshed completed booking can be explicitly reopened for a new correction",
      async () => {
        const page = await newPage();
        try {
          await page
            .getByRole("button", { name: "Finish job", exact: true })
            .click();
          await expect(
            page.getByText("Job completed", { exact: true }),
          ).toBeVisible();
          await expect(
            page.getByRole("button", { name: "Finish job", exact: true }),
          ).toBeDisabled();
          await page
            .getByRole("button", {
              name: "Refresh completed booking",
              exact: true,
            })
            .click();
          await page
            .getByRole("button", { name: "Edit completed job", exact: true })
            .click();
          await expect(
            page.getByRole("button", { name: "Finish job", exact: true }),
          ).toBeEnabled();
          await page.getByLabel("Final job total", { exact: true }).fill("375");
          await page
            .getByRole("button", { name: "Finish job", exact: true })
            .click();
          await expect(
            page.getByText("Job completed", { exact: true }),
          ).toBeVisible();
          const requests = await calls(page, "completion");
          assert.equal(requests.length, 2);
          assert.equal(
            new Map(requests[1]!.entries).get("expectedVersion"),
            "v2",
          );
          assert.equal(new Map(requests[1]!.entries).get("finalTotal"), "375");
          assert.notEqual(
            new Map(requests[1]!.entries).get("idempotencyKey"),
            new Map(requests[0]!.entries).get("idempotencyKey"),
          );
        } finally {
          await page.close();
        }
      },
    );

    await t.test(
      "uncertain note retries the original payload while retaining newer text",
      async () => {
        const page = await newPage();
        try {
          await outcomes(page, "throw");
          await openNote(page);
          await page.getByLabel("Job note").fill("Original note");
          await page
            .getByRole("button", { name: "Save note", exact: true })
            .click();
          await expect(page.getByRole("alert")).toContainText(
            "could not be confirmed",
          );
          await page
            .getByLabel("Job note")
            .fill("Newer note for the next save");
          await reopen(page);
          await openNote(page);
          await expect(page.getByLabel("Job note")).toHaveValue(
            "Newer note for the next save",
          );
          await page
            .getByRole("button", { name: "Retry previous note" })
            .click();
          await expect(
            page.getByText(
              "Previous note saved. Your newer text is kept as a draft.",
            ),
          ).toBeVisible();
          const requests = await calls(page, "note");
          assert.deepEqual(requests[0]!.entries, requests[1]!.entries);
          assert.equal(
            (await draft(page, "note")).values.body,
            "Newer note for the next save",
          );
          await page
            .getByRole("button", { name: "Save note", exact: true })
            .click();
          await expect(
            page.getByText("Note saved", { exact: true }),
          ).toBeVisible();
          assert.equal(await draft(page, "note"), null);
        } finally {
          await page.close();
        }
      },
    );
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
