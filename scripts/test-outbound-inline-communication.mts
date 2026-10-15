import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium, expect, webkit, type BrowserType } from "@playwright/test";

const repo = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/u, "");
const require = createRequire(`${repo}/package.json`);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const siteRequire = createRequire(`${repo}/apps/site/package.json`);
const tailwindConfig = siteRequire(
  `${repo}/apps/site/tailwind.config.ts`,
).default;
const contactId = "33333333-3333-4333-8333-333333333333";
const taskId = "22222222-2222-4222-8222-222222222222";
const employeeId = "11111111-1111-4111-8111-111111111111";
const css = (
  await siteRequire("postcss")([
    siteRequire("tailwindcss")({
      ...tailwindConfig,
      content: [
        {
          raw: ["OutboundCommunicationClient.tsx", "team-ui.ts"]
            .map((name) =>
              readFileSync(
                `${repo}/apps/site/src/app/team/components/${name}`,
                "utf8",
              ),
            )
            .join("\n"),
          extension: "tsx",
        },
      ],
    }),
  ]).process("@tailwind base; @tailwind components; @tailwind utilities;", {
    from: undefined,
  })
).css;

const callReceipt = {
  ok: true,
  data: {
    callOperationId: "66666666-6666-4666-8666-666666666666",
    state: "active",
    provider: "twilio",
    providerIdempotencySupported: false,
    agentMemberId: employeeId,
    taskId,
    taskEffects: "pending",
    completedExplicitTaskId: null,
    completedFollowupTaskId: null,
    completedSpeedToLeadCount: 0,
  },
  receipt: {
    operationId: "call-operation",
    correlationId: "call-correlation",
    actorId: employeeId,
    committedAt: "2026-10-15T12:00:00.000Z",
    auditEventId: "77777777-7777-4777-8777-777777777777",
    entityType: "contact",
    entityId: contactId,
    version: 3,
    providerOperationId: `CA${"a".repeat(32)}`,
  },
};

async function harness(engine: BrowserType, width: number, blocked = false) {
  const bundle = await build({
    stdin: {
      contents: `import React from'react';import{createRoot}from'react-dom/client';import{OutboundCommunicationClient}from'./src/app/team/components/OutboundCommunicationClient';
      const emailPanel=<div data-testid="email-panel"><label>Email draft<input aria-label="Email draft"/></label></div>;
      const smsPanel=<div data-testid="sms-panel"><label>Text draft<input aria-label="Text draft"/></label></div>;
      function App(){return <main><OutboundCommunicationClient contactId="${contactId}" contactName="Shameel Khan" phone="+16785955653" taskId="${taskId}" initialChannel="email" channelHrefs={{email:'/team/sales/outbound?out_account=account-a&contactId=${contactId}&channel=email#outbound-communication',sms:'/team/sales/outbound?out_account=account-a&contactId=${contactId}&channel=sms#outbound-communication'}} fullInboxHrefs={{email:'/team/sales/outbound?view=inbox&contactId=${contactId}&channel=email',sms:'/team/sales/outbound?view=inbox&contactId=${contactId}&channel=sms'}} emailPanel={emailPanel} smsPanel={smsPanel} canCall canReadMessages outreachBlocked={${blocked}}/></main>}createRoot(document.getElementById('root')).render(<App/>);`,
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
  });
  const server = createServer((request, response) => {
    if (request.url === "/client.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(bundle.outputFiles[0].contents);
      return;
    }
    if (request.url === "/api/team/calls/start" && request.method === "POST") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(callReceipt));
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(
      `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>:root{--team-border:#cbd5e1;--team-card:#fff;--team-card-shadow:rgba(15,37,54,.08);--team-surface:#fff;--team-surface-muted:#f4f7f6;--team-panel-alt:#edf3f1;--team-text:#0f2536;--team-text-muted:#496273;--team-text-soft:#607786;--team-link:#116452;--team-brand-green:#167e69;--team-brand-green-strong:#116452;--team-selection:#eaf6f2;--team-focus-ring:#167e69;--team-focus-offset:#fff;--team-action-primary:#167e69;--team-action-primary-text:#fff;--team-action-shadow:rgba(22,126,105,.2);--team-danger-border:#fecdd3;--team-danger-surface:#fff1f2;--team-danger-text:#881337;--team-warning-border:#fde68a;--team-warning-surface:#fffbeb;--team-warning-text:#78350f;--team-success-border:#bbf7d0;--team-success-surface:#f0fdf4;--team-success-text:#166534}body{margin:0;background:#f3f6f5;font-family:Arial,sans-serif;color:var(--team-text)}main{max-width:62rem;margin:40px auto;padding:12px}</style></head><body><div id="root"></div><script src="/client.js"></script></body></html>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const browser = await engine.launch();
  const page = await browser.newPage({ viewport: { width, height: 700 } });
  await page.goto(
    `http://127.0.0.1:${address.port}/team/sales/outbound?out_account=account-a&contactId=${contactId}&channel=email`,
  );
  await page.getByRole("button", { name: "Email", exact: true }).waitFor();
  return {
    page,
    async close() {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

for (const engine of [chromium, webkit]) {
  for (const width of [320, 1440]) {
    void test(`${engine.name()} ${width}px: channels and calls stay in the workspace`, async () => {
      const { page, close } = await harness(engine, width);
      try {
        await page.evaluate(() => ((window as any).__workspaceMarker = "kept"));
        await page.getByLabel("Email draft").fill("Email draft remains here");
        await page.getByRole("button", { name: "Text", exact: true }).click();
        assert.equal(new URL(page.url()).searchParams.get("channel"), "sms");
        assert.equal(
          await page.evaluate(() => (window as any).__workspaceMarker),
          "kept",
        );
        await expect(page.getByTestId("sms-panel")).toBeVisible();
        await page.getByRole("button", { name: "Email", exact: true }).click();
        await expect(page.getByLabel("Email draft")).toHaveValue(
          "Email draft remains here",
        );
        await page.getByRole("button", { name: "Call", exact: true }).click();
        await expect(page.getByRole("status")).toContainText(
          "You can keep working here",
        );
        assert.equal(
          await page.evaluate(() => (window as any).__workspaceMarker),
          "kept",
        );
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
          true,
        );
      } finally {
        await close();
      }
    });
  }

  void test(`${engine.name()}: Do Not Contact disables every outreach control`, async () => {
    const { page, close } = await harness(engine, 375, true);
    try {
      await expect(page.getByRole("status")).toContainText(
        "outreach is blocked",
      );
      for (const label of ["Call", "Text", "Email"])
        await expect(
          page.getByRole("button", { name: label, exact: true }),
        ).toBeDisabled();
    } finally {
      await close();
    }
  });
}
