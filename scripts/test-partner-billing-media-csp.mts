import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium, webkit } from "@playwright/test";
import { createPartnerBillingCsp } from "../apps/site/config/partner-billing-csp.mjs";

const photo = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4HsAAAAASUVORK5CYII=",
  "base64",
);

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `https://127.0.0.1:${address.port}`;
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "stonegate-billing-media-csp-"));
  const key = join(directory, "key.pem");
  const cert = join(directory, "cert.pem");
  // Disposable loopback TLS preserves the real upgrade-insecure-requests
  // policy in WebKit. This fixture never connects to production storage.
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
    ],
    { stdio: "ignore" },
  );
  const tls = { key: readFileSync(key), cert: readFileSync(cert) };
  let appOrigin = "";
  let puts = 0;
  const storage = createServer(tls, (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", appOrigin);
    response.setHeader("Access-Control-Allow-Methods", "PUT,GET,OPTIONS");
    response.setHeader(
      "Access-Control-Allow-Headers",
      "content-type,if-none-match",
    );
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
    } else if (request.method === "PUT") {
      request.resume();
      request.on("end", () => {
        puts++;
        response.writeHead(204).end();
      });
    } else {
      response.setHeader("Content-Type", "image/png");
      response.end(photo);
    }
  });
  const storageOrigin = await listen(storage);
  const app = createServer(tls, (request, response) => {
    if (request.url?.startsWith("/partners/billing")) {
      response.setHeader(
        "Content-Security-Policy",
        createPartnerBillingCsp(
          request.url.includes("configured=1") ? storageOrigin : undefined,
        ),
      );
    }
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><title>Partner media policy fixture</title>
      <a id="book" href="/partners/book">Request service</a>
      <script>
      window.documentToken = Math.random(); window.violations = [];
      document.addEventListener('securitypolicyviolation', event => window.violations.push(event.effectiveDirective));
      document.querySelector('#book').onclick = event => {
        event.preventDefault(); history.pushState({}, '', '/partners/book');
      };
      window.upload = (target = ${JSON.stringify(storageOrigin)}) => new Promise(resolve => {
        const request = new XMLHttpRequest();
        request.open('PUT', target + '/synthetic-photo'); request.timeout = 3000;
        request.setRequestHeader('content-type', 'image/png');
        request.setRequestHeader('if-none-match', '*');
        request.onload = () => resolve({event:'load',status:request.status});
        request.onerror = () => resolve({event:'error',status:request.status});
        request.ontimeout = () => resolve({event:'timeout',status:request.status});
        request.send(new Blob(['local synthetic bytes'], {type:'image/png'}));
      });
      window.preview = () => new Promise(resolve => {
        const image = new Image(); image.onload = () => resolve(true); image.onerror = () => resolve(false);
        image.src = ${JSON.stringify(`${storageOrigin}/synthetic-photo.png`)};
        document.body.append(image);
      });
      </script>`);
  });
  appOrigin = await listen(app);
  return {
    appOrigin,
    putCount: () => puts,
    async close() {
      await Promise.all(
        [app, storage].map(
          (server) =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
        ),
      );
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

type FixtureWindow = Window & {
  documentToken: number;
  violations: string[];
  upload: (target?: string) => Promise<{ event: string; status: number }>;
  preview: () => Promise<boolean>;
};

for (const [name, engine] of [
  ["Chromium", chromium],
  ["WebKit", webkit],
] as const) {
  test(
    `${name}: Billing document navigation permits only configured photo storage`,
    { timeout: 30_000 },
    async () => {
      const local = await fixture();
      try {
        const browser = await engine.launch();
        try {
          for (const scenario of [
            "direct_book",
            "billing_unconfigured",
            "billing_configured",
          ] as const) {
            const page = await browser.newPage({ ignoreHTTPSErrors: true });
            try {
              const start =
                scenario === "direct_book"
                  ? "/partners/book"
                  : `/partners/billing${scenario === "billing_configured" ? "?configured=1" : ""}`;
              await page.goto(local.appOrigin + start);
              const documentToken = await page.evaluate(
                () => (window as FixtureWindow).documentToken,
              );
              if (scenario !== "direct_book")
                await page.locator("#book").click();
              assert.equal(
                await page.evaluate(() => location.pathname),
                "/partners/book",
              );
              assert.equal(
                await page.evaluate(
                  () => (window as FixtureWindow).documentToken,
                ),
                documentToken,
              );
              const before = local.putCount();
              const upload = await page.evaluate(() =>
                (window as FixtureWindow).upload(),
              );
              const previewLoaded = await page.evaluate(() =>
                (window as FixtureWindow).preview(),
              );
              const blocked = scenario === "billing_unconfigured";
              assert.deepEqual(
                upload,
                {
                  event: blocked ? "error" : "load",
                  status: blocked ? 0 : 204,
                },
                scenario,
              );
              assert.equal(
                local.putCount() - before,
                blocked ? 0 : 1,
                scenario,
              );
              assert.equal(previewLoaded, !blocked, scenario);
              const violations = await page.evaluate(
                () => (window as FixtureWindow).violations,
              );
              assert.equal(
                violations.includes("connect-src"),
                blocked,
                scenario,
              );
              assert.equal(violations.includes("img-src"), blocked, scenario);
              if (scenario === "billing_configured") {
                // .invalid never receives a network request: CSP must reject it.
                const unrelated = await page.evaluate(() =>
                  (window as FixtureWindow).upload(
                    "https://unrelated-storage.invalid",
                  ),
                );
                assert.deepEqual(unrelated, { event: "error", status: 0 });
                assert.ok(
                  (
                    await page.evaluate(
                      () => (window as FixtureWindow).violations,
                    )
                  ).includes("connect-src"),
                );
              }
            } finally {
              await page.close();
            }
          }
        } finally {
          await browser.close();
        }
      } finally {
        await local.close();
      }
    },
  );
}
