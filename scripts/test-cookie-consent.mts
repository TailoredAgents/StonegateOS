import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  chromium,
  webkit,
  type BrowserType,
  type Page,
} from "@playwright/test";

const repo = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/u, "");
const require = createRequire(`${repo}/package.json`);
const siteRequire = createRequire(`${repo}/apps/site/package.json`);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const postcss = siteRequire("postcss");
const tailwindcss = siteRequire("tailwindcss");
const gaId = "G-COOKIE123";
const adsId = "AW-123456789";
const landing =
  "/book?oppref=synthetic-openai-click&utm_source=chatgpt&utm_campaign=cookie-test&gclid=synthetic-google-click&fbclid=synthetic-meta-click";

const assets = (async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import React from 'react';
        import {createRoot} from 'react-dom/client';
        import {CookieConsentManager} from './src/components/CookieConsentManager';
        import {CookieSettingsButton} from './src/components/CookieSettingsButton';
        import {WebAnalyticsClient} from './src/components/WebAnalyticsClient';
        import {getCookiePreferences} from './src/lib/cookie-consent';
        import {trackGoogleAdsConversion,setGoogleAdsEnhancedConversionsUserData} from './src/lib/google-ads';
        import {getOpenAiAdsAttribution,trackOpenAiAdsBooking,trackOpenAiAdsPhoneClick} from './src/lib/openai-ads';
        import {trackWebEvent,flushWebAnalytics} from './src/lib/web-analytics';
        import {useUTM,readConsentedUtm} from './src/lib/use-utm';
        import {HeroV2} from './src/components/HeroV2';
        import {PricingDumpsterEstimator} from './src/components/PricingDumpsterEstimator';
        window.__vendorCalls=[];
        window.__test={
          preferences:getCookiePreferences,
          flush:flushWebAnalytics,
          emit(id){
            trackGoogleAdsConversion('${adsId}/booking',{transaction_id:id});
            setGoogleAdsEnhancedConversionsUserData({email:'synthetic@example.test'});
            trackOpenAiAdsBooking(id);
            trackOpenAiAdsPhoneClick();
            getOpenAiAdsAttribution();
            readConsentedUtm();
            trackWebEvent({event:'cta_click',path:window.location.pathname,key:id});
            flushWebAnalytics();
          },
          navigate(path){history.pushState({},'',path);window.dispatchEvent(new Event('test:navigation'))}
        };
        function App(){const utm=useUTM();return <>
          <main style={{padding:24,minHeight:'110vh'}}>
            <h1>Request a junk removal quote</h1>
            <label>Name <input aria-label="Name" /></label>
            <a href="tel:+14047772631" data-cta="test-call" onClick={event=>event.preventDefault()}>Call Stonegate</a>
            <output data-testid="utm">{JSON.stringify(utm)}</output>
            {new URLSearchParams(location.search).get('fixture')==='marketing' && <>
              <div data-testid="real-hero"><HeroV2/></div>
              <div data-testid="real-pricing"><PricingDumpsterEstimator/></div>
            </>}
          </main>
          <footer style={{padding:24}}><CookieSettingsButton/></footer>
          <WebAnalyticsClient/>
          <CookieConsentManager ga4Id={${JSON.stringify(gaId)}} googleAdsTagId={${JSON.stringify(adsId)}} metaPixelId="12345678901" openAiPixelId="synthetic-openai-pixel"/>
        </>};
        createRoot(document.getElementById('root')).render(<App/>);
      `,
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
    define: {
      "process.env.NODE_ENV": '"production"',
      "process.env.NEXT_PUBLIC_API_BASE_URL": '"/measurement"',
      "process.env.NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID": '"synthetic-openai-pixel"',
      "process.env.NEXT_PUBLIC_OPENAI_ADS_REQUIRE_CONSENT": '"true"',
      "process.env.NEXT_PUBLIC_GOOGLE_ADS_CALL_SEND_TO": JSON.stringify(
        `${adsId}/call`,
      ),
      "process.env.NEXT_PUBLIC_GA4_ID": JSON.stringify(gaId),
      "process.env": "{}",
    },
    logLevel: "error",
    plugins: [
      {
        name: "local-next-boundaries",
        setup(builder) {
          builder.onResolve(
            { filter: /^next\/(link|navigation|image)$/ },
            (args) => ({ path: args.path, namespace: "next-local" }),
          );
          builder.onLoad({ filter: /.*/, namespace: "next-local" }, (args) => ({
            loader: "js",
            resolveDir: `${repo}/apps/site`,
            contents:
              args.path === "next/link"
                ? `import React from 'react';export default function Link({children,href,onClick,...props}){return React.createElement('a',{...props,href,onClick:event=>{onClick?.(event);if(!event.defaultPrevented){window.__lastNavigation=event.currentTarget.getAttribute('href');event.preventDefault()}}},children)}`
                : args.path === "next/image"
                  ? `import React from 'react';export default function Image({src,alt,width,height,style,className}){return React.createElement('img',{src:typeof src==='string'?src:src.src,alt,width,height,style,className})}`
                  : `import {useMemo,useSyncExternalStore} from 'react';const subscribe=listener=>{window.addEventListener('test:navigation',listener);return()=>window.removeEventListener('test:navigation',listener)};export const usePathname=()=>useSyncExternalStore(subscribe,()=>window.location.pathname,()=>'/');export const useSearchParams=()=>{const query=useSyncExternalStore(subscribe,()=>location.search,()=>'');return useMemo(()=>new URLSearchParams(query),[query])};const router={replace(path){history.replaceState({},'',path);window.dispatchEvent(new Event('test:navigation'))},push(path){window.__lastNavigation=path}};export const useRouter=()=>router;`,
          }));
        },
      },
    ],
  });
  const config = siteRequire(`${repo}/apps/site/tailwind.config.ts`).default;
  const css = await postcss([
    tailwindcss({
      ...config,
      content: [
        `${repo}/apps/site/src/components/Cookie{ConsentBanner,SettingsButton}.tsx`,
        `${repo}/apps/site/src/components/{HeroV2,PricingDumpsterEstimator}.tsx`,
        `${repo}/packages/ui/src/**/*.{ts,tsx}`,
      ],
    }),
  ]).process(await readFile(`${repo}/apps/site/src/app/globals.css`, "utf8"), {
    from: undefined,
  });
  return { script: bundle.outputFiles[0].contents, css: css.css };
})();

// These SDK stand-ins record real application commands and set representative
// first-party cookies. All provider requests are fulfilled locally, never sent.
const googleSdk = `(()=>{
  let analytics=false,ads=false;
  function handle(args){
    window.__vendorCalls.push(['google',args]);
    if(args[0]==='consent'){analytics=args[2].analytics_storage==='granted';ads=args[2].ad_storage==='granted'}
    if(args[0]==='config' && args[1].startsWith('AW-') && ads)document.cookie='_gcl_au=synthetic; Path=/; Max-Age=7776000';
    if(args[0]==='config' && args[1].startsWith('G-') && analytics)document.cookie='_ga=synthetic; Path=/; Max-Age=7776000';
  }
  for(const entry of window.dataLayer||[])handle(Array.from(entry));
  window.gtag=(...args)=>{window.dataLayer.push(args);handle(args)};
})();`;
const metaSdk = `(()=>{
  let allowed=false;
  function handle(...args){
    window.__vendorCalls.push(['meta',args]);
    if(args[0]==='consent')allowed=args[1]==='grant';
    if(args[0]==='track' && allowed)document.cookie='_fbp=synthetic; Path=/; Max-Age=7776000';
  }
  for(const args of window.fbq.queue||[])handle(...args);
  window.fbq.callMethod=handle;
  window.fbq.queue=[];
})();`;
const openAiSdk = `(()=>{
  function handle(...args){
    window.__vendorCalls.push(['openai',args]);
    if(args[0]==='consent'){
      localStorage.setItem('oaiq_consent',String(args[1]));
      if(args[1]){
        document.cookie='__obref=synthetic-browser; Path=/; Max-Age=31536000';
        const click=new URLSearchParams(location.search).get('oppref');
        if(click)document.cookie='__oppref='+encodeURIComponent(click)+'; Path=/; Max-Age=2592000';
      }
    }
  }
  const queue=window.oaiq.q||[];
  window.oaiq=handle;
  for(const args of queue)handle(...args);
})();`;

type VendorCall = ["google" | "meta" | "openai", unknown[]];
type HarnessApi = {
  __test: {
    emit(id: string): void;
    flush(): void;
    navigate(path: string): void;
    preferences(): { analytics: boolean; advertising: boolean } | null;
  };
  __vendorCalls: VendorCall[];
};

async function browserHarness(
  engine: BrowserType,
  width: number,
  signal?: "gpc" | "dnt",
  priorGrant = false,
  pagePath = landing,
) {
  const built = await assets;
  const requests: { path: string; body: string }[] = [];
  const externalRequests: string[] = [];
  const errors: string[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://local.test");
    if (url.pathname === "/client.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(built.script);
    } else if (url.pathname === "/style.css") {
      response.setHeader("Content-Type", "text/css");
      response.end(built.css);
    } else if (url.pathname.startsWith("/measurement/")) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({
        path: url.pathname,
        body: Buffer.concat(chunks).toString(),
      });
      response.setHeader("Content-Type", "application/json");
      response.end('{"ok":true}');
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end(
        '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/client.js"></script></body></html>',
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await engine.launch();
  const context = await browser.newContext({
    viewport: { width, height: width === 320 ? 640 : 900 },
  });
  context.on("page", (page) => {
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => errors.push(error.message));
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    externalRequests.push(url.href);
    const script =
      url.hostname === "www.googletagmanager.com"
        ? googleSdk
        : url.hostname === "connect.facebook.net"
          ? metaSdk
          : url.hostname === "bzrcdn.openai.com"
            ? openAiSdk
            : undefined;
    if (!script)
      errors.push(`Unexpected external request blocked: ${url.href}`);
    await route.fulfill({
      status: script ? 200 : 404,
      contentType: "text/javascript",
      body: script ?? "",
    });
  });
  if (signal)
    await context.addInitScript((kind) => {
      Object.defineProperty(
        navigator,
        kind === "gpc" ? "globalPrivacyControl" : "doNotTrack",
        { value: kind === "gpc" ? true : "1", configurable: true },
      );
    }, signal);
  if (priorGrant)
    await context.addCookies([
      {
        name: "sg_cookie_consent",
        value: encodeURIComponent(
          JSON.stringify({
            version: 1,
            analytics: true,
            advertising: true,
            updatedAt: Date.now(),
          }),
        ),
        url: origin,
      },
    ]);
  const page = await context.newPage();
  await page.goto(origin + pagePath);
  await page
    .getByRole("heading", { name: "Request a junk removal quote" })
    .waitFor();
  return {
    page,
    context,
    origin,
    requests,
    externalRequests,
    errors,
    async close() {
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function emit(page: Page, id: string) {
  await page.evaluate(
    (value) => (window as unknown as HarnessApi).__test.emit(value),
    id,
  );
}

async function calls(page: Page): Promise<VendorCall[]> {
  return page.evaluate(() => (window as unknown as HarnessApi).__vendorCalls);
}

async function assertOptionalStorageAbsent(page: Page) {
  const stored = await page.evaluate(() => ({
    session: localStorage.getItem("sg:session"),
    visit: sessionStorage.getItem("sg:visit"),
    campaign: sessionStorage.getItem("sg:utm"),
    attribution: localStorage.getItem("sg:openai-ads-attribution"),
    cookies: document.cookie,
  }));
  assert.equal(stored.session, null);
  assert.equal(stored.visit, null);
  assert.equal(stored.campaign, null);
  assert.equal(stored.attribution, null);
  assert.doesNotMatch(
    stored.cookies,
    /(?:^|;\s*)(?:_ga|_gcl_au|_fbp|__obref|__oppref|myst_utm)=/u,
  );
}

async function assertUsablePanel(page: Page) {
  const panel = page.getByRole("region", {
    name: /Your cookie choices|Cookie settings/u,
  });
  const box = await panel.boundingBox();
  assert.ok(box);
  const viewport = page.viewportSize();
  assert.ok(viewport);
  assert.ok(
    box.x >= 0 && box.x + box.width <= viewport.width + 1,
    "Panel stays within the viewport",
  );
  assert.ok(
    box.y >= 0 && box.y + box.height <= viewport.height,
    "Panel fits vertically",
  );
  assert.equal(
    await panel.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
    true,
    "Panel has no horizontal overflow",
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
    "Page has no horizontal overflow",
  );
  for (const button of await panel.getByRole("button").all()) {
    const size = await button.boundingBox();
    assert.ok(
      size && size.height >= 44,
      "Consent controls have usable touch targets",
    );
    if (
      await panel
        .getByRole("heading", { name: "Your cookie choices", exact: true })
        .count()
    ) {
      assert.ok(
        size.y >= box.y && size.y + size.height <= box.y + box.height,
        "All initial consent actions are visible without scrolling",
      );
    }
  }
}

async function screenshot(page: Page, name: string) {
  const directory = process.env["COOKIE_CONSENT_SCREENSHOT_DIR"];
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: join(directory, name + ".png") });
}

for (const engine of [chromium, webkit]) {
  for (const width of [320, 1280]) {
    void test(
      `${engine.name()} ${width}px: choice precedes tracking; rejection persists; settings retain keyboard access`,
      { timeout: 60_000 },
      async () => {
        const h = await browserHarness(engine, width);
        try {
          await h.page
            .getByRole("button", {
              name: "Accept optional cookies",
              exact: true,
            })
            .waitFor();
          await assertUsablePanel(h.page);
          await screenshot(h.page, `${engine.name()}-${width}-banner`);
          await emit(h.page, "before-choice");
          await assertOptionalStorageAbsent(h.page);
          assert.deepEqual(h.externalRequests, []);
          assert.deepEqual(h.requests, []);
          await h.page
            .getByRole("button", {
              name: "Reject optional cookies",
              exact: true,
            })
            .click();
          await h.page.reload();
          await h.page
            .getByRole("button", { name: "Cookie settings", exact: true })
            .waitFor();
          assert.equal(
            await h.page
              .getByRole("button", {
                name: "Accept optional cookies",
                exact: true,
              })
              .count(),
            0,
          );
          assert.deepEqual(
            await h.page.evaluate(() => {
              const p = (window as unknown as HarnessApi).__test.preferences();
              return p && [p.analytics, p.advertising];
            }),
            [false, false],
          );
          await emit(h.page, "after-rejection");
          await assertOptionalStorageAbsent(h.page);
          assert.deepEqual(h.externalRequests, []);
          assert.deepEqual(h.requests, []);
          const settings = h.page.getByRole("button", {
            name: "Cookie settings",
            exact: true,
          });
          await settings.click();
          await h.page
            .getByRole("heading", { name: "Cookie settings", exact: true })
            .waitFor();
          assert.equal(
            await h.page.evaluate(() => document.activeElement?.id),
            "cookie-preferences-heading",
          );
          await assertUsablePanel(h.page);
          await screenshot(h.page, `${engine.name()}-${width}-settings`);
          await h.page.keyboard.press("Escape");
          assert.equal(
            await settings.evaluate(
              (element) => element === document.activeElement,
            ),
            true,
          );
          assert.deepEqual(h.errors, []);
        } finally {
          await h.close();
        }
      },
    );
  }

  void test(
    `${engine.name()}: accepting loads configured providers; withdrawal revokes and preserves the form`,
    { timeout: 60_000 },
    async () => {
      const h = await browserHarness(engine, 1280);
      try {
        await h.page
          .getByRole("textbox", { name: "Name", exact: true })
          .fill("Keep this booking draft");
        await h.page
          .getByRole("button", { name: "Accept optional cookies", exact: true })
          .click();
        await h.page.waitForFunction(() =>
          (window as unknown as HarnessApi).__vendorCalls.some(
            ([provider, args]) =>
              provider === "openai" && args[0] === "measure",
          ),
        );
        await emit(h.page, "allowed-booking");
        await h.page.waitForFunction(
          () =>
            Boolean(localStorage.getItem("sg:session")) &&
            Boolean(sessionStorage.getItem("sg:visit")),
        );
        assert.deepEqual(
          h.externalRequests.map((url) => new URL(url).hostname).sort(),
          [
            "bzrcdn.openai.com",
            "connect.facebook.net",
            "www.googletagmanager.com",
          ],
        );
        const cookieNames = (await h.context.cookies()).map(
          (cookie) => cookie.name,
        );
        for (const name of [
          "sg_cookie_consent",
          "_ga",
          "_gcl_au",
          "_fbp",
          "__obref",
          "__oppref",
          "myst_utm",
        ])
          assert.ok(
            cookieNames.includes(name),
            `${name} exists only after acceptance`,
          );
        const grantedCalls = await calls(h.page);
        assert.ok(
          grantedCalls.some(
            ([provider, args]) =>
              provider === "google" &&
              args[0] === "event" &&
              args[1] === "conversion",
          ),
        );
        assert.ok(
          grantedCalls.some(
            ([provider, args]) =>
              provider === "openai" &&
              args[0] === "measure" &&
              args[1] === "appointment_scheduled",
          ),
        );
        await h.page
          .getByRole("button", { name: "Cookie settings", exact: true })
          .click();
        await h.page
          .getByRole("button", { name: "Reject optional cookies", exact: true })
          .click();
        await h.page.waitForFunction(
          () =>
            localStorage.getItem("sg:openai-ads-attribution") === null &&
            localStorage.getItem("sg:session") === null,
        );
        await assertOptionalStorageAbsent(h.page);
        assert.equal(
          await h.page
            .getByRole("textbox", { name: "Name", exact: true })
            .inputValue(),
          "Keep this booking draft",
        );
        const revokedCalls = await calls(h.page);
        assert.ok(
          revokedCalls.some(
            ([provider, args]) =>
              provider === "google" &&
              args[0] === "consent" &&
              (args[2] as { ad_storage?: string }).ad_storage === "denied",
          ),
        );
        assert.ok(
          revokedCalls.some(
            ([provider, args]) =>
              provider === "meta" &&
              args[0] === "consent" &&
              args[1] === "revoke",
          ),
        );
        assert.ok(
          revokedCalls.some(
            ([provider, args]) =>
              provider === "openai" &&
              args[0] === "consent" &&
              args[1] === false,
          ),
        );
        const measurementCount = (entries: VendorCall[]) =>
          entries.filter(
            ([, args]) =>
              args[0] === "measure" ||
              args[0] === "event" ||
              args[0] === "track" ||
              (args[0] === "set" && args[1] === "user_data"),
          ).length;
        const before = measurementCount(revokedCalls);
        const eventsBefore = h.requests.filter((request) =>
          request.path.endsWith("/web-events"),
        ).length;
        await emit(h.page, "denied-booking");
        await h.page
          .getByRole("link", { name: "Call Stonegate", exact: true })
          .click();
        await h.page.evaluate(() =>
          (window as unknown as HarnessApi).__test.flush(),
        );
        assert.equal(
          measurementCount(await calls(h.page)),
          before,
          "No new application conversion, phone, or user-data commands after withdrawal",
        );
        assert.equal(
          h.requests.filter((request) => request.path.endsWith("/web-events"))
            .length,
          eventsBefore,
        );
        assert.ok(
          h.requests.some(
            (request) =>
              request.path.endsWith("/openai/ads/consent") &&
              JSON.parse(request.body).consent === false,
          ),
          "Linked OpenAI server attribution receives a revocation",
        );
        assert.deepEqual(h.errors, []);
      } finally {
        await h.close();
      }
    },
  );

  void test(
    `${engine.name()}: analytics-only excludes advertising identifiers and providers`,
    { timeout: 60_000 },
    async () => {
      const h = await browserHarness(engine, 320);
      try {
        await h.page
          .getByRole("button", { name: "Customize", exact: true })
          .click();
        await h.page.getByRole("checkbox", { name: /^Analytics/u }).check();
        await h.page
          .getByRole("button", { name: "Save preferences", exact: true })
          .click();
        await h.page.waitForFunction(() =>
          Boolean(localStorage.getItem("sg:session")),
        );
        await h.page.waitForFunction(() =>
          (window as unknown as HarnessApi).__vendorCalls.some(
            ([provider, args]) => provider === "google" && args[0] === "config",
          ),
        );
        await emit(h.page, "analytics-only");
        const recorded = await calls(h.page);
        assert.deepEqual(
          h.externalRequests.map((url) => new URL(url).hostname),
          ["www.googletagmanager.com"],
        );
        assert.ok(
          recorded.some(
            ([provider, args]) =>
              provider === "google" && args[0] === "config" && args[1] === gaId,
          ),
        );
        assert.ok(
          !recorded.some(
            ([, args]) => args[0] === "config" && args[1] === adsId,
          ),
        );
        assert.ok(
          !recorded.some(
            ([, args]) => args[0] === "event" || args[0] === "measure",
          ),
        );
        const gaConfig = recorded.find(
          ([, args]) => args[0] === "config" && args[1] === gaId,
        )?.[1][2] as { page_location: string; allow_google_signals: boolean };
        assert.equal(gaConfig.page_location, h.origin + "/book");
        assert.equal(gaConfig.allow_google_signals, false);
        assert.equal(await h.page.getByTestId("utm").textContent(), "{}");
        assert.equal(
          await h.page.evaluate(() => sessionStorage.getItem("sg:utm")),
          null,
        );
        assert.doesNotMatch(
          (await h.context.cookies()).map((cookie) => cookie.name).join(" "),
          /_gcl_au|_fbp|__obref|__oppref|myst_utm/u,
        );
        assert.deepEqual(h.errors, []);
      } finally {
        await h.close();
      }
    },
  );

  for (const signal of ["gpc", "dnt"] as const) {
    void test(
      `${engine.name()}: ${signal} overrides an existing grant`,
      { timeout: 60_000 },
      async () => {
        const h = await browserHarness(engine, 320, signal, true);
        try {
          await h.page
            .getByRole("button", { name: "Cookie settings", exact: true })
            .click();
          await h.page
            .getByText(
              /Your browser sends a Global Privacy Control or Do Not Track signal/u,
            )
            .waitFor();
          for (const checkbox of await h.page.getByRole("checkbox").all()) {
            assert.equal(await checkbox.isDisabled(), true);
            assert.equal(await checkbox.isChecked(), false);
          }
          await emit(h.page, "signal-blocked");
          await assertOptionalStorageAbsent(h.page);
          assert.deepEqual(h.externalRequests, []);
          assert.deepEqual(h.requests, []);
          assert.deepEqual(h.errors, []);
        } finally {
          await h.close();
        }
      },
    );
  }

  void test(
    `${engine.name()}: another tab receives a withdrawal through shared preferences`,
    { timeout: 60_000 },
    async () => {
      const h = await browserHarness(engine, 1280);
      try {
        await h.page
          .getByRole("button", { name: "Accept optional cookies", exact: true })
          .click();
        await h.page.waitForFunction(() =>
          Boolean(localStorage.getItem("sg:session")),
        );
        const second = await h.context.newPage();
        await second.goto(h.origin + landing);
        await second.waitForFunction(() =>
          Boolean(sessionStorage.getItem("sg:visit")),
        );
        await second
          .getByRole("button", { name: "Cookie settings", exact: true })
          .click();
        await second
          .getByRole("button", { name: "Reject optional cookies", exact: true })
          .click();
        await h.page.waitForFunction(
          () => sessionStorage.getItem("sg:visit") === null,
          undefined,
          { polling: 50 },
        );
        await assertOptionalStorageAbsent(h.page);
        const before = (await calls(h.page)).filter(
          ([, args]) => args[0] === "measure" || args[0] === "event",
        ).length;
        await emit(h.page, "after-other-tab-withdrawal");
        assert.equal(
          (await calls(h.page)).filter(
            ([, args]) => args[0] === "measure" || args[0] === "event",
          ).length,
          before,
        );
        assert.deepEqual(h.errors, []);
      } finally {
        await h.close();
      }
    },
  );

  void test(
    `${engine.name()}: real hero and pricing controls respect categories and stop after withdrawal`,
    { timeout: 60_000 },
    async () => {
      const h = await browserHarness(
        engine,
        1280,
        undefined,
        false,
        landing.replace("/book?", "/pricing?fixture=marketing&"),
      );
      try {
        const hero = h.page.getByTestId("real-hero");
        const pricing = h.page.getByTestId("real-pricing");
        const book = pricing.getByRole("link", {
          name: "Get instant quote",
          exact: true,
        });
        const estimate = pricing.getByRole("link", {
          name: "Schedule an estimate",
          exact: true,
        });
        await book.waitFor();
        for (const link of [book, estimate])
          assert.doesNotMatch(
            (await link.getAttribute("href")) ?? "",
            /gclid|fbclid|utm_/u,
          );
        await h.page
          .getByRole("button", { name: "Close cookie notice", exact: true })
          .click();
        await hero
          .getByRole("link", { name: "Get Instant Quote", exact: true })
          .click();
        await pricing
          .getByRole("button", { name: "Reset", exact: true })
          .click();
        assert.deepEqual(await calls(h.page), []);
        await h.page
          .getByRole("button", { name: "Cookie settings", exact: true })
          .click();
        await h.page.getByRole("checkbox", { name: /^Analytics/u }).check();
        await h.page
          .getByRole("button", { name: "Save preferences", exact: true })
          .click();
        await h.page.waitForFunction(() =>
          (window as unknown as HarnessApi).__vendorCalls.some(
            ([provider, args]) => provider === "google" && args[0] === "config",
          ),
        );
        await hero
          .getByRole("link", { name: "Get Instant Quote", exact: true })
          .click();
        await pricing
          .getByRole("button", { name: "Reset", exact: true })
          .click();
        const events = (await calls(h.page)).filter(
          ([, args]) => args[0] === "event",
        );
        assert.ok(events.some(([, args]) => args[1] === "click"));
        assert.ok(events.some(([, args]) => args[1] === "reset"));
        for (const [, args] of events)
          assert.equal(
            (args[2] as { send_to: string }).send_to,
            gaId,
            "Custom analytics events target only the GA property",
          );
        for (const link of [book, estimate])
          assert.doesNotMatch(
            (await link.getAttribute("href")) ?? "",
            /gclid|fbclid|utm_/u,
          );
        await h.page
          .getByRole("button", { name: "Cookie settings", exact: true })
          .click();
        await h.page.getByRole("checkbox", { name: /^Advertising/u }).check();
        await h.page
          .getByRole("button", { name: "Save preferences", exact: true })
          .click();
        await h.page.waitForFunction(() =>
          document
            .querySelector('[data-testid="real-pricing"] a[href^="/book?"]')
            ?.getAttribute("href")
            ?.includes("gclid="),
        );
        await h.page
          .getByRole("button", { name: "Cookie settings", exact: true })
          .click();
        await h.page
          .getByRole("button", { name: "Reject optional cookies", exact: true })
          .click();
        const count = (await calls(h.page)).filter(
          ([, args]) => args[0] === "event",
        ).length;
        await hero
          .getByRole("link", { name: "Get Instant Quote", exact: true })
          .click();
        await pricing
          .getByRole("button", { name: "Reset", exact: true })
          .click();
        await book.click();
        assert.equal(
          (await calls(h.page)).filter(([, args]) => args[0] === "event")
            .length,
          count,
        );
        assert.doesNotMatch(
          await h.page.evaluate(
            () =>
              (window as unknown as { __lastNavigation: string })
                .__lastNavigation,
          ),
          /gclid|fbclid|utm_/u,
        );
        for (const link of [book, estimate])
          assert.doesNotMatch(
            (await link.getAttribute("href")) ?? "",
            /gclid|fbclid|utm_/u,
          );
        assert.deepEqual(h.errors, []);
      } finally {
        await h.close();
      }
    },
  );
}
