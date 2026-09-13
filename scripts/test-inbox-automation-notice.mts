import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, expect, type Page } from "@playwright/test";

const repo = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(`${repo}/package.json`);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const hold = {
  ok: true,
  nextAction: {
    id: "action-1",
    channel: "sms",
    actionType: "human_follow_up",
    status: "pending",
    summary: "Review the customer request.",
  },
  executionState: { code: "human_review", label: "Needs human review" },
  liveContext: {
    latestLead: { id: "lead-1" },
    automation: [{ channel: "sms", paused: true }],
  },
};

async function resolveRequest(
  page: Page,
  payload: unknown,
  index = -1,
  status = 200,
) {
  await page.evaluate(
    async ({ payload, index, status }) => {
      (window as any).__requests
        .at(index)
        .resolve(new Response(JSON.stringify(payload), { status }));
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    },
    { payload, index, status },
  );
}

void test(
  "Inbox automation context is optional, scoped and read-only when required",
  { timeout: 60_000 },
  async (t) => {
    const bundle = await build({
      stdin: {
        contents: `
        import React from 'react';import {createRoot} from 'react-dom/client';
        import {InboxAutomationNoticeClient} from './src/app/team/components/InboxAutomationNoticeClient';
        import {ContactSalesAgentNextActionClient} from './src/app/team/components/ContactSalesAgentNextActionClient';
        window.__requests=[];
        window.fetch=(url,options={})=>new Promise((resolve,reject)=>window.__requests.push({url,options,resolve,reject}));
        function App(){const [props,setProps]=React.useState({contactId:'one',channel:'sms',view:'notice',readOnly:true,compact:false});
          window.__show=updates=>setProps(value=>({...value,...updates}));
          return <><p>Customer messages</p><textarea aria-label='Reply' defaultValue='Unsent reply'/>
            {props.view==='notice'?<InboxAutomationNoticeClient contactId={props.contactId} channel={props.channel}/>:<ContactSalesAgentNextActionClient contactId={props.contactId} readOnly={props.readOnly} compact={props.compact}/>}</>;}
        createRoot(document.getElementById('root')).render(<App/>);`,
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
      define: { "process.env.NODE_ENV": '"production"' },
      logLevel: "error",
    });
    const server = createServer((request, response) => {
      if (request.url === "/client.js") {
        response.setHeader("Content-Type", "text/javascript");
        response.end(bundle.outputFiles[0].contents);
      } else {
        response.setHeader("Content-Type", "text/html");
        response.end(
          '<!doctype html><div id="root"></div><script src="/client.js"></script>',
        );
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const browser = await chromium.launch();
    async function open() {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${address.port}`);
      await page.waitForFunction(() => (window as any).__requests.length === 1);
      return page;
    }
    try {
      await t.test(
        "pending, failed and off-mode reads leave messages and draft available without filler",
        async () => {
          for (const [payload, status] of [
            [{ ok: true, executionState: { code: "mode_off" } }, 200],
            [null, 500],
            [{ ok: true, liveContext: { automation: [null, "bad"] } }, 200],
          ] as const) {
            const page = await open();
            await expect(page.getByRole("status")).toHaveCount(0);
            await expect(
              page.getByRole("textbox", { name: "Reply" }),
            ).toHaveValue("Unsent reply");
            await resolveRequest(page, payload, -1, status);
            await expect(page.getByRole("status")).toHaveCount(0);
            await expect(
              page.getByText(/Loading|Unable to load|Off mode/u),
            ).toHaveCount(0);
            assert.equal(
              await page.evaluate(
                () => (window as any).__requests[0].options.method,
              ),
              "GET",
            );
            await page.close();
          }
        },
      );
      await t.test(
        "only actual concern states produce a short passive notice",
        async () => {
          for (const [code, text] of [
            ["paused", "Automation is paused"],
            ["human_takeover", "Human takeover"],
            ["human_review", "waiting for human review"],
            ["blocked", "Automation is blocked"],
          ]) {
            const page = await open();
            await resolveRequest(page, { ok: true, executionState: { code } });
            await expect(page.getByRole("status")).toContainText(text!);
            await expect(page.getByRole("button")).toHaveCount(0);
            await page.close();
          }
          const page = await open();
          await resolveRequest(page, {
            ok: true,
            liveContext: {
              automation: [{ channel: "sms", dnc: true, paused: true }],
            },
          });
          await expect(page.getByRole("status")).toContainText(
            "Do not contact",
          );
          await page.close();
        },
      );
      await t.test(
        "recipient switches abort reads and reject late previous-recipient or wrong-channel notices",
        async () => {
          const page = await open();
          await page.evaluate(() =>
            (window as any).__show({ contactId: "two" }),
          );
          await page.waitForFunction(
            () => (window as any).__requests.length === 2,
          );
          assert.equal(
            await page.evaluate(
              () => (window as any).__requests[0].options.signal.aborted,
            ),
            true,
          );
          await resolveRequest(page, hold, 0);
          await expect(page.getByRole("status")).toHaveCount(0);
          await resolveRequest(
            page,
            {
              ...hold,
              autopilot: { channel: "email" },
              liveContext: { automation: [{ channel: "email", paused: true }] },
            },
            1,
          );
          await expect(page.getByRole("status")).toHaveCount(0);
          await page.close();
        },
      );
      await t.test(
        "read-only full and compact details retain hold context without mutation controls",
        async () => {
          for (const compact of [false, true]) {
            const page = await open();
            await page.evaluate(
              (compact) => (window as any).__show({ view: "detail", compact }),
              compact,
            );
            await page.waitForFunction(
              () => (window as any).__requests.length === 2,
            );
            await resolveRequest(page, hold);
            await expect(
              page.getByText("Needs human review", { exact: true }).first(),
            ).toBeVisible();
            await expect(page.getByRole("button")).toHaveCount(0);
            await expect(
              page.getByPlaceholder("Optional review note for the agent"),
            ).toHaveCount(0);
            assert.ok(
              (
                await page.evaluate(() =>
                  (window as any).__requests.map(
                    (request: any) => request.options.method ?? "GET",
                  ),
                )
              ).every((method: string) => method === "GET"),
            );
            await page.close();
          }
        },
      );
      await t.test(
        "authorized details retain refresh and human-review controls",
        async () => {
          const page = await open();
          await page.evaluate(() =>
            (window as any).__show({ view: "detail", readOnly: false }),
          );
          await page.waitForFunction(
            () => (window as any).__requests.length === 2,
          );
          await resolveRequest(page, hold);
          await expect(
            page.getByRole("button", { name: "Refresh", exact: true }),
          ).toBeVisible();
          await expect(
            page.getByRole("button", { name: "Mark reviewed", exact: true }),
          ).toBeVisible();
          await expect(
            page.getByRole("button", {
              name: "Hand back to agent",
              exact: true,
            }),
          ).toBeVisible();
          await page
            .getByRole("button", { name: "Mark reviewed", exact: true })
            .click();
          assert.equal(
            await page.evaluate(
              () => (window as any).__requests.at(-1).options.method,
            ),
            "PATCH",
          );
          await resolveRequest(page, hold);
          await page
            .getByRole("button", { name: "Refresh", exact: true })
            .click();
          assert.equal(
            await page.evaluate(
              () => (window as any).__requests.at(-1).options.method,
            ),
            "POST",
          );
          await resolveRequest(page, hold);
          await page.close();
        },
      );
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
