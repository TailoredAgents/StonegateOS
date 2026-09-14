import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium, webkit } from "@playwright/test";

const repo = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(`${repo}/package.json`);
type Builder = {
  onResolve(
    options: { filter: RegExp },
    callback: (args: { path: string }) => { path: string; namespace: string },
  ): void;
  onLoad(
    options: { filter: RegExp; namespace: string },
    callback: (args: { path: string }) => {
      loader: string;
      resolveDir: string;
      contents: string;
    },
  ): void;
};
const { build } = createRequire(require.resolve("tsx"))("esbuild") as {
  build(
    options: Record<string, unknown>,
  ): Promise<{ outputFiles: { contents: Uint8Array }[] }>;
};
type State = { account: string; error: string | null; label: string };
type HarnessWindow = Window & {
  replaceSection(state: State): void;
  refreshes?: number;
};

for (const engine of [chromium, webkit]) {
  void test(`${engine.name()}: Home retains a successful section during failure and clears it on account switch`, async () => {
    const bundle = await build({
      stdin: {
        contents: `import React from 'react';import{createRoot}from'react-dom/client';
          import{PartnerHomeSection}from'./src/app/partners/components/PartnerHomeSection';
          function App(){const[state,setState]=React.useState({account:'a',error:null,label:'Original job'});React.useEffect(()=>{window.replaceSection=setState},[]);return <main>
            <PartnerHomeSection key={state.account} title="Recent jobs" error={state.error}><p>{state.label}</p></PartnerHomeSection>
            <PartnerHomeSection title="Updates" error={null}><p>Other section remains available</p></PartnerHomeSection>
          </main>};createRoot(document.getElementById('root')).render(<App/>);`,
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
      plugins: [
        {
          name: "next-test-boundaries",
          setup(builder: Builder) {
            builder.onResolve(
              { filter: /^next\/(link|navigation)$/ },
              (args) => ({ path: args.path, namespace: "next-test" }),
            );
            builder.onLoad(
              { filter: /.*/, namespace: "next-test" },
              (args) => ({
                loader: "js",
                resolveDir: `${repo}/apps/site`,
                contents:
                  args.path === "next/link"
                    ? `import React from'react';export default function Link({href,children,...props}){return React.createElement('a',{...props,href},children)}`
                    : `export function useRouter(){return{refresh(){window.refreshes=(window.refreshes||0)+1}}}`,
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
          ? bundle.outputFiles[0]?.contents
          : '<!doctype html><html><body><div id="root"></div><script src="/client.js"></script></body></html>',
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${address.port}`);
      await page.getByText("Original job", { exact: true }).waitFor();
      await page.evaluate(() =>
        (window as HarnessWindow).replaceSection({
          account: "a",
          error:
            "Jobs could not be refreshed. Support reference: local_failure_123.",
          label: "Unverified replacement",
        }),
      );
      await page.getByText(/Previously loaded information/u).waitFor();
      assert.equal(
        await page.getByText("Original job", { exact: true }).count(),
        1,
      );
      assert.equal(
        await page.getByText("Unverified replacement", { exact: true }).count(),
        0,
      );
      assert.equal(
        await page
          .getByText("Other section remains available", { exact: true })
          .count(),
        1,
      );
      await page.getByRole("button", { name: "Retry recent jobs" }).click();
      assert.equal(
        await page.evaluate(() => (window as HarnessWindow).refreshes),
        1,
      );
      await page.evaluate(() =>
        (window as HarnessWindow).replaceSection({
          account: "a",
          error: null,
          label: "Refreshed job",
        }),
      );
      await page.getByText("Refreshed job", { exact: true }).waitFor();
      assert.equal(
        await page.getByText("Original job", { exact: true }).count(),
        0,
      );
      await page.evaluate(() =>
        (window as HarnessWindow).replaceSection({
          account: "b",
          error: "This company could not be loaded.",
          label: "Unavailable company",
        }),
      );
      await page
        .getByText("This company could not be loaded.", { exact: true })
        .waitFor();
      assert.equal(
        await page.getByText("Refreshed job", { exact: true }).count(),
        0,
      );
      assert.equal(
        await page.getByText(/Previously loaded information/u).count(),
        0,
      );
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
}
