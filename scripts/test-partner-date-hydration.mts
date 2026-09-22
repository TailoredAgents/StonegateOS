import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium, webkit, expect } from "@playwright/test";
import {
  formatPartnerDate,
  formatPartnerDateTime,
} from "../apps/site/src/app/partners/lib/partner-date-time";

const repo = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(`${repo}/package.json`);
const siteRequire = createRequire(`${repo}/apps/site/package.json`);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const React = siteRequire("react");
const { renderToString } = siteRequire("react-dom/server");
const examples = [
  {
    iso: "2026-09-24T14:00:00.000Z",
    timezone: "America/New_York",
    expected: "Sep 24, 2026, 10:00 AM",
  },
  {
    iso: "2026-11-03T05:00:00.000Z",
    timezone: "America/New_York",
    expected: "Nov 3, 2026, 12:00 AM",
  },
  {
    iso: "2026-09-24T16:00:00.000Z",
    timezone: "America/New_York",
    expected: "Sep 24, 2026, 12:00 PM",
  },
  {
    iso: "2026-09-24T02:00:00.000Z",
    timezone: "America/New_York",
    expected: "Sep 23, 2026, 10:00 PM",
  },
  {
    iso: "2026-09-24T02:00:00.000Z",
    timezone: "America/Los_Angeles",
    expected: "Sep 23, 2026, 7:00 PM",
  },
  {
    iso: "2026-03-08T06:30:00.000Z",
    timezone: "America/New_York",
    expected: "Mar 8, 2026, 1:30 AM",
  },
  {
    iso: "2026-03-08T07:30:00.000Z",
    timezone: "America/New_York",
    expected: "Mar 8, 2026, 3:30 AM",
  },
  {
    iso: "2026-11-01T05:30:00.000Z",
    timezone: "America/New_York",
    expected: "Nov 1, 2026, 1:30 AM",
  },
  {
    iso: "2026-11-01T06:30:00.000Z",
    timezone: "America/New_York",
    expected: "Nov 1, 2026, 1:30 AM",
  },
];
const labels = examples.flatMap(({ iso, timezone }) => [
  formatPartnerDate(new Date(iso), timezone),
  formatPartnerDateTime(new Date(iso), timezone),
]);

test("Portal dates preserve the account timezone, midnight, noon and DST", () => {
  for (const example of examples)
    assert.equal(
      formatPartnerDateTime(new Date(example.iso), example.timezone),
      example.expected,
    );
  assert.equal(
    formatPartnerDate(new Date("2026-09-24T02:00:00.000Z")),
    "Sep 23, 2026",
  );
  assert.throws(() => formatPartnerDateTime(new Date("invalid")), RangeError);
  assert.throws(
    () => formatPartnerDateTime(new Date(), "Invalid/Timezone"),
    RangeError,
  );
});

for (const [engine, browserType] of [
  ["chromium", chromium],
  ["webkit", webkit],
] as const) {
  test(`${engine}: Portal server dates hydrate without changed text in a different browser timezone`, async () => {
    const bundle = await build({
      stdin: {
        contents: `
          import React from 'react';
          import { hydrateRoot } from 'react-dom/client';
          import { formatPartnerDate, formatPartnerDateTime } from './apps/site/src/app/partners/lib/partner-date-time';
          const examples = ${JSON.stringify(examples)};
          window.recoverableErrors = [];
          function Example() {
            React.useEffect(() => { window.hydrated = true; }, []);
            return React.createElement('div', null, examples.flatMap(({iso,timezone}) => [
              formatPartnerDate(new Date(iso), timezone),
              formatPartnerDateTime(new Date(iso), timezone)
            ]).map((label,index) => React.createElement('p', {key:index}, label)));
          }
          hydrateRoot(document.getElementById('root'), React.createElement(Example), {
            onRecoverableError(error) { window.recoverableErrors.push(error.message); }
          });
        `,
        resolveDir: repo,
        sourcefile: "partner-date-hydration.ts",
      },
      bundle: true,
      format: "iife",
      platform: "browser",
      write: false,
      alias: {
        react: siteRequire.resolve("react"),
        "react-dom/client": siteRequire.resolve("react-dom/client"),
      },
      define: { "process.env.NODE_ENV": '"production"' },
    });
    const markup = renderToString(
      React.createElement(
        "div",
        null,
        labels.map((label, index) =>
          React.createElement("p", { key: index }, label),
        ),
      ),
    );
    const server = createServer((request, response) => {
      if (request.url === "/bundle.js") {
        response.setHeader("content-type", "text/javascript");
        response.end(bundle.outputFiles[0].text);
      } else {
        response.setHeader("content-type", "text/html");
        response.end(
          `<!doctype html><html><body><main id="root">${markup}</main><script src="/bundle.js"></script></body></html>`,
        );
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const browser = await browserType.launch();
    try {
      const page = await browser.newPage({
        timezoneId: "Asia/Tokyo",
        locale: "en-GB",
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await page.goto(`http://127.0.0.1:${address.port}`);
      await expect
        .poll(() => page.evaluate(() => Boolean((window as any).hydrated)))
        .toBe(true);
      assert.deepEqual(await page.locator("#root p").allTextContents(), labels);
      assert.deepEqual(
        await page.evaluate(() => (window as any).recoverableErrors),
        [],
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
