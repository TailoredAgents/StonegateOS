import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium, type Page } from "@playwright/test";

const repo = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(`${repo}package.json`);
const { build } = createRequire(require.resolve("tsx"))("esbuild");

type RecordedView = { provider: string; args: unknown[]; path: string };
type FixtureWindow = Window & {
  views: RecordedView[];
  revision: number;
  navigate: (path: string, group: string, mounted: boolean) => void;
  installTags: () => void;
};

async function views(page: Page): Promise<RecordedView[]> {
  return page.evaluate(() => (window as FixtureWindow).views);
}

async function navigate(
  page: Page,
  path: string,
  group: string,
  mounted = true,
): Promise<void> {
  const revision = await page.evaluate(
    ({ path, group, mounted }) => {
      const fixture = window as FixtureWindow;
      const previous = fixture.revision;
      fixture.navigate(path, group, mounted);
      return previous;
    },
    { path, group, mounted },
  );
  await page.waitForFunction(
    (previous) => (window as FixtureWindow).revision > previous,
    revision,
  );
}

void test("marketing page views survive public-layout remounts without duplicate initialization", async (t) => {
  const bundle = await build({
    stdin: {
      resolveDir: `${repo}apps/site`,
      loader: "tsx",
      contents: `
        import React from 'react';
        import {createRoot} from 'react-dom/client';
        import {GoogleTagPageView} from './src/components/GoogleTagPageView';
        import {MetaPixelPageView} from './src/components/MetaPixelPageView';
        import {setCookiePreferences} from './src/lib/cookie-consent';
        setCookiePreferences({analytics:true,advertising:true});
        window.views=[]; window.revision=0;
        window.installTags=()=>{
          window.gtag=(...args)=>window.views.push({provider:'google',args,path:location.pathname});
          window.fbq=(...args)=>window.views.push({provider:'meta',args,path:location.pathname});
        };
        if(!location.search.includes('absent')) window.installTags();
        function App(){
          const [route,setRoute]=React.useState({group:'site',mounted:true,revision:1});
          React.useEffect(()=>{window.revision=route.revision;},[route]);
          window.navigate=(path,group,mounted)=>{
            history.replaceState({},'',path);
            setRoute(previous=>({group,mounted,revision:previous.revision+1}));
          };
          return route.mounted ? <React.Fragment key={route.group}>
            <GoogleTagPageView ga4Id="G-LOCALTEST"/><MetaPixelPageView/>
          </React.Fragment> : null;
        }
        createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);
      `,
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [
      {
        name: "local-pathname",
        setup(build: {
          onResolve: (
            options: { filter: RegExp },
            callback: () => unknown,
          ) => void;
          onLoad: (
            options: { filter: RegExp; namespace: string },
            callback: () => unknown,
          ) => void;
        }) {
          build.onResolve({ filter: /^next\/navigation$/ }, () => ({
            path: "navigation",
            namespace: "fixture",
          }));
          build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: "export const usePathname=()=>window.location.pathname;",
            loader: "js",
          }));
        },
      },
    ],
  });
  const server = createServer((request, response) => {
    response.setHeader(
      "Content-Type",
      request.url === "/fixture.js" ? "text/javascript" : "text/html",
    );
    response.end(
      request.url === "/fixture.js"
        ? bundle.outputFiles[0].contents
        : '<!doctype html><html><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture address");
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch();
  try {
    await t.test(
      "initial, repeated, remounted, returning, and private-layout routes",
      async () => {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route("**/*", (route) =>
          route.request().url().startsWith(origin)
            ? route.continue()
            : route.abort(),
        );
        await page.goto(origin);
        await page.waitForFunction(
          () => (window as FixtureWindow).revision > 0,
        );
        assert.deepEqual(
          await views(page),
          [],
          "SDK initialization owns the first page view, including StrictMode replay",
        );
        await navigate(page, "/", "same-path-remount");
        assert.deepEqual(await views(page), []);
        await navigate(page, "/contractors", "commercial");
        assert.deepEqual(await views(page), [
          {
            provider: "google",
            args: ["config", "G-LOCALTEST", {
              page_path: "/contractors",
              page_location: `${origin}/contractors`,
              page_referrer: "",
              allow_google_signals: true,
              allow_ad_personalization_signals: true,
            }],
            path: "/contractors",
          },
          {
            provider: "meta",
            args: ["track", "PageView"],
            path: "/contractors",
          },
        ]);
        await navigate(page, "/contractors", "commercial");
        await navigate(page, "/contractors", "commercial-remount");
        assert.equal((await views(page)).length, 2);
        await navigate(page, "/", "site");
        await navigate(page, "/services", "site");
        assert.deepEqual(
          (await views(page)).map((view) => view.path),
          ["/contractors", "/contractors", "/", "/", "/services", "/services"],
        );
        await navigate(page, "/team/login", "private", false);
        assert.equal(
          (await views(page)).length,
          6,
          "Private layouts mount no marketing components",
        );
        await navigate(page, "/contractors", "commercial");
        assert.equal((await views(page)).length, 8);
        assert.deepEqual(errors, []);
        await page.close();
      },
    );
    await t.test(
      "late or absent SDK callbacks do not throw or lose the next navigation",
      async () => {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route("**/*", (route) =>
          route.request().url().startsWith(origin)
            ? route.continue()
            : route.abort(),
        );
        await page.goto(`${origin}/?absent`);
        await page.waitForFunction(
          () => (window as FixtureWindow).revision > 0,
        );
        await navigate(page, "/contractors", "commercial");
        assert.deepEqual(await views(page), []);
        await page.evaluate(() => (window as FixtureWindow).installTags());
        await navigate(page, "/contractors", "commercial-remount");
        assert.deepEqual(
          await views(page),
          [],
          "A newly initialized SDK already owns its current page view",
        );
        await navigate(page, "/", "site");
        assert.equal((await views(page)).length, 2);
        assert.deepEqual(errors, []);
        await page.close();
      },
    );
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
