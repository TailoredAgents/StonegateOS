import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repo = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/u, "");
const require = createRequire(`${repo}/package.json`);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const { chromium, webkit } = require("@playwright/test");

for (const engine of [chromium, webkit]) {
  test(
    `${engine.name()}: no-contact partner job thread uses explicit reply visibility`,
    { timeout: 60_000 },
    async () => {
      const bundle = await build({
        stdin: {
          contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
        import {MobileThreadConversation} from './src/app/mobile/MobileThreadConversation';
        createRoot(document.getElementById('root')).render(<MobileThreadConversation threadId='11111111-1111-4111-8111-111111111111' channel='web' isPartnerJob initialMessages={[{id:'22222222-2222-4222-8222-222222222222',direction:'internal',channel:'web',body:'Synthetic staff-only note',deliveryStatus:'sent',participantName:'Staff',createdAt:new Date().toISOString()}]}/>);`,
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
        response.setHeader("Content-Type", "text/html");
        response.end(
          '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui}svg{width:24px;height:24px}button,input,select{min-height:44px}</style></head><body><div id="root"></div><script src="/client.js"></script></body></html>',
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
        const errors: string[] = [],
          sends: Array<{
            body: Record<string, unknown>;
            key: string | undefined;
          }> = [];
        page.on("pageerror", (error: Error) => errors.push(error.message));
        await page.route(
          "**/api/mobile/inbox/threads/**",
          async (route: any) => {
            const request = route.request();
            if (request.method() === "POST")
              sends.push({
                body: request.postDataJSON(),
                key: request.headers()["idempotency-key"],
              });
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({ ok: true, messages: [] }),
            });
          },
        );
        await page.goto(`http://127.0.0.1:${address.port}`);
        assert.equal(
          await page
            .getByText("Synthetic staff-only note", { exact: true })
            .count(),
          1,
        );
        assert.equal(await page.getByText(/Internal note ·/u).count(), 1);
        const audience = page.getByRole("combobox", {
          name: "Who can see this message?",
        });
        assert.equal(await audience.inputValue(), "");
        await page
          .getByRole("textbox", { name: "Reply", exact: true })
          .fill("Synthetic partner reply");
        assert.equal(
          await page
            .getByRole("button", { name: "Send reply", exact: true })
            .isDisabled(),
          true,
        );
        await audience.selectOption("partner");
        await page
          .getByRole("button", { name: "Send reply", exact: true })
          .click();
        await page.waitForFunction(
          () => !document.querySelector("select")?.disabled,
        );
        await audience.selectOption("internal");
        await page
          .getByRole("textbox", { name: "Reply", exact: true })
          .fill("Synthetic internal response");
        await page
          .getByRole("button", { name: "Save internal note", exact: true })
          .click();
        await page.waitForFunction(
          () => !document.querySelector("select")?.disabled,
        );
        assert.equal(sends.length, 2);
        assert.deepEqual(
          sends.map((send) => send.body["audience"]),
          ["partner", "internal"],
        );
        assert.ok(
          sends.every(
            (send) =>
              send.body["channel"] === "web" &&
              !("contactId" in send.body) &&
              send.key,
          ),
        );
        assert.notEqual(sends[0]?.key, sends[1]?.key);
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
}
