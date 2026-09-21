import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
const repo = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/u, "");
const require = createRequire(`${repo}/package.json`),
  { build } = createRequire(require.resolve("tsx"))("esbuild"),
  { chromium, webkit } = require("@playwright/test");
const appointmentId = "11111111-1111-4111-8111-111111111111",
  crewId = "22222222-2222-4222-8222-222222222222",
  truckId = "33333333-3333-4333-8333-333333333333";
const capacityWarningMessage =
  "This time exceeds schedule capacity. Review the overlapping jobs.";
for (const engine of [chromium, webkit])
  test(
    `${engine.name()}: actual CRM scheduler preserves resource retries and allows capacity warnings without override permission`,
    { timeout: 60000 },
    async () => {
      const bundle = await build({
        stdin: {
          resolveDir: `${repo}/apps/site`,
          loader: "tsx",
          contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {CalendarAppointmentActions} from './src/app/team/components/CalendarAppointmentActions'; createRoot(document.getElementById('root')).render(<CalendarAppointmentActions appointmentId='${appointmentId}' appointmentType='job' start='' version='2035-06-01T12:00:00.000Z' quotedTotalCents={null} finalTotalCents={null} isQuoteOnly={false} canEditStatus={false} canUpdateAppointments canCollectPayments={false} canSendCustomerMessages={false} canManageAppointmentMedia={false} canOverrideScheduleConflicts={false} teamMembers={[]} scheduleOnly/>);`,
        },
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
            name: "resource-action-fixture",
            setup(b) {
              b.onResolve({ filter: /actions\/scheduling-resources$/ }, () => ({
                path: "actions",
                namespace: "fixture",
              }));
              b.onResolve({ filter: /^next\/navigation$/ }, () => ({
                path: "navigation",
                namespace: "fixture",
              }));
              b.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
                loader: "js",
                contents:
                  args.path === "navigation"
                    ? `export const useRouter=()=>({refresh(){},push(){}});`
                    : `export async function loadStaffAppointmentResources(id){return {ok:true,data:{applicable:true,appointmentId:id,requirements:[{kind:'crew',quantity:1,capacityUnits:1,requiredSkillKeys:[]},{kind:'truck',quantity:1,capacityUnits:1,requiredSkillKeys:[]}],resources:[{id:'${crewId}',label:'Crew Alpha',kind:'crew',capacityUnits:1,skillKeys:[]},{id:'${truckId}',label:'Truck Alpha',kind:'truck',capacityUnits:1,skillKeys:[]}],selectedResourceIds:[],warning:null}}}`,
              }));
            },
          },
        ],
      });
      const sends: Array<{ body: string; key?: string }> = [];
      const server = createServer((request, response) => {
        if (request.url === "/client.js") {
          response.setHeader("content-type", "text/javascript");
          response.end(bundle.outputFiles[0].contents);
          return;
        }
        response.setHeader("content-type", "text/html");
        response.end(
          '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui}button,input,select{min-height:44px}svg{width:24px;height:24px}</style></head><body><div id="root"></div><script src="/client.js"></script></body></html>',
        );
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const browser = await engine.launch();
      try {
        const page = await browser.newPage({
          viewport: { width: 375, height: 812 },
        });
        const errors: string[] = [];
        page.on("pageerror", (error: Error) => errors.push(error.message));
        await page.route(
          "**/api/team/appointments/reschedule",
          async (route: any) => {
            const request = route.request();
            sends.push({
              body: request.postData() ?? "",
              key: request.headers()["idempotency-key"],
            });
            await route.fulfill({
              status: sends.length === 1 ? 409 : 200,
              json:
                sends.length === 1
                  ? {
                      ok: false,
                      error: "slot_unavailable",
                      message: "Selected crew is no longer available.",
                    }
                  : {
                      ok: true,
                      version: "2035-06-01T12:01:00.000Z",
                      data: {},
                      receipt: {
                        operationId: "local",
                        correlationId: "local",
                        actorId: "local",
                        committedAt: "2035-06-01T12:01:00.000Z",
                      },
                      ...(sends.length === 3
                        ? {
                            scheduleWarning: {
                              code: "schedule_capacity_exceeded",
                              message: capacityWarningMessage,
                              conflicts: [
                                {
                                  id: "44444444-4444-4444-8444-444444444444",
                                  title: "Overlapping job",
                                  startAt: "2035-06-04T14:00:00.000Z",
                                  endAt: "2035-06-04T16:00:00.000Z",
                                },
                              ],
                            },
                          }
                        : {}),
                    },
            });
          },
        );
        await page.goto(`http://127.0.0.1:${address.port}`);
        await page.getByLabel("New date", { exact: true }).fill("2035-06-04");
        await page.getByLabel("Eastern time", { exact: true }).fill("10:00");
        await page.getByLabel("Choose specific resources").check();
        await page.getByLabel(/Crew Alpha/u).check();
        await page.getByLabel(/Truck Alpha/u).check();
        await page
          .getByRole("button", { name: "Schedule service", exact: true })
          .click();
        await page
          .getByText(/^Selected crew is no longer available\./u)
          .waitFor();
        assert.equal(await page.getByLabel(/Crew Alpha/u).isChecked(), true);
        assert.equal(
          await page.getByLabel("New date", { exact: true }).inputValue(),
          "2035-06-04",
        );
        await page
          .getByRole("button", { name: "Schedule service", exact: true })
          .click();
        await page.getByText("Service scheduled.", { exact: true }).waitFor();
        assert.equal(await page.getByText(capacityWarningMessage).count(), 0);
        assert.equal(sends.length, 2);
        assert.equal(sends[0]?.key, sends[1]?.key);
        assert.ok(sends[0]?.key);
        for (const send of sends) {
          assert.match(send.body, /name="selectedResourceIds"/u);
          assert.ok(send.body.includes(crewId) && send.body.includes(truckId));
          assert.doesNotMatch(send.body, /commission|payout|finalTotal/u);
        }
        await page.getByLabel("Choose specific resources").uncheck();
        assert.equal(
          await page.locator('input[name="selectedResourceIds"]').count(),
          0,
        );
        await page.getByLabel("Eastern time", { exact: true }).fill("11:00");
        const scheduleButton = page.getByRole("button", {
          name: "Schedule service",
          exact: true,
        });
        await scheduleButton.click();
        const capacityFeedback = page
          .getByRole("status")
          .filter({ hasText: capacityWarningMessage });
        await capacityFeedback.waitFor();
        assert.match(
          await capacityFeedback.innerText(),
          /^Service scheduled\./u,
        );
        assert.match(
          (await capacityFeedback.getAttribute("class")) ?? "",
          /\bbg-amber-50\b/u,
        );
        assert.equal(await scheduleButton.isEnabled(), true);
        assert.equal(await page.getByRole("alert").count(), 0);
        assert.equal(
          await page
            .locator(
              '[name="conflictOverrideReason"], [name="conflictAcknowledgement"], [name="conflictFingerprint"]',
            )
            .count(),
          0,
        );
        assert.equal(sends.length, 3);
        assert.doesNotMatch(
          sends[2]?.body ?? "",
          /conflictOverrideReason|conflictAcknowledgement|conflictFingerprint/u,
        );

        await page.getByLabel("Eastern time", { exact: true }).fill("13:00");
        await scheduleButton.click();
        await page.getByText("Service scheduled.", { exact: true }).waitFor();
        assert.equal(await capacityFeedback.count(), 0);
        assert.equal(await scheduleButton.isEnabled(), true);
        assert.equal(sends.length, 4);
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
