import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repo = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/u, "");
const require = createRequire(`${repo}/package.json`);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const { chromium, webkit } = require("@playwright/test");
type RequestEvidence = {
  path: string;
  method: string;
  body: string | null;
  revision?: string;
  key?: string;
};
const deletedAt = "2026-09-09T12:00:00.000Z",
  revisedDeletion = "2026-09-09T12:01:00.000Z";
const media = (id: string, category = "before") => ({
  id,
  category,
  caption: `${id} caption`,
  status: "ready",
  filename: `${id}.${category === "document" ? "pdf" : "png"}`,
  byteSize: 100,
  sortOrder: 0,
  contentType: category === "document" ? "application/pdf" : "image/png",
  width: null,
  height: null,
  sha256: null,
  createdAt: "2026-09-09T12:00:00.000Z",
  readyAt: "2026-09-09T12:00:00.000Z",
  error: null,
  downloadIntent: null,
});
const proof = (files: any[], removed: any[] = []) => ({
  status: "complete",
  requirements: [],
  outstanding: [],
  media: files,
  deletedMedia: removed,
  packages: [],
  shareLinks: [],
});
const entry = `import React from 'react'; import {createRoot} from 'react-dom/client';
import {PartnerRepeatWorkManager} from './src/app/partners/components/PartnerRepeatWorkManager';
import {PartnerProofWorkspace} from './src/app/partners/components/PartnerProofWorkspace';
const media=${media.toString()}, proof=${proof.toString()};
function App(){const [enabled,setEnabled]=React.useState(true),[job,setJob]=React.useState('job-A'),[upload,setUpload]=React.useState(true);
return location.pathname==='/templates'?<><button onClick={()=>setEnabled(false)}>Disable optional templates</button><PartnerRepeatWorkManager canManageSeries persona='contractor' enabledTools={{templates:enabled,recurring:false,bulk:false}}/></>
:<><button onClick={()=>setJob('job-B')}>Switch proof job</button><button onClick={()=>setUpload(false)}>Make proof read only</button><PartnerProofWorkspace accountId='local-account' jobId={job} initialProof={proof(job==='job-A'?[media('photo-A'),media('document-A','document')]:[media('photo-B')])} canUpload={upload} canShare={false}/></>}
createRoot(document.getElementById('root')).render(<App/>);`;

async function harness(
  engine: any,
  run: (page: any, base: string, errors: string[]) => Promise<void>,
) {
  const bundle = await build({
    stdin: { contents: entry, loader: "tsx", resolveDir: `${repo}/apps/site` },
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
        name: "next-navigation-fixture",
        setup(builder: any) {
          builder.onResolve({ filter: /^next\/navigation$/ }, () => ({
            path: "navigation",
            namespace: "fixture",
          }));
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: "export const useRouter=()=>({refresh(){},push(){}});",
            loader: "js",
          }));
        },
      },
    ],
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 375, height: 812 },
    });
    page.setDefaultTimeout(8000);
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await run(page, `http://127.0.0.1:${address.port}`, errors);
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

for (const engine of [chromium, webkit]) {
  test(
    `${engine.name()}: actual template replacement refreshes revisions, retries safely, isolates resources and retains disabled-tool maintenance`,
    { timeout: 60000 },
    async () =>
      harness(engine, async (page, base, errors) => {
        let version = 1,
          templateId = "template-A",
          active = true,
          replacements = 0;
        const requests: RequestEvidence[] = [];
        await page.route("**/api/partners/portal/**", async (route: any) => {
          const req = route.request(),
            url = new URL(req.url()),
            path = url.pathname.split("/api/partners/portal/")[1]!,
            method = req.method();
          requests.push({
            path,
            method,
            body: req.postData(),
            revision: req.headers()["if-match"],
            key: req.headers()["idempotency-key"],
          });
          const answer = (json: any, status = 200) =>
            route.fulfill({ status, json });
          if (path === "service-templates" && method === "GET")
            return answer({
              ok: true,
              templates: [
                {
                  id: templateId,
                  active,
                  name: templateId,
                  serviceKey: "service_request",
                  locationId: null,
                  updatedAt: "2026-09-09T12:00:00.000Z",
                  etag: `"template-${version}"`,
                  reusable: {
                    description:
                      version >= 3
                        ? "Updated reusable scope"
                        : "Original reusable scope",
                  },
                },
              ],
              nextCursor: null,
            });
          if (path === "recurring-series")
            return answer({ ok: true, series: [], nextCursor: null });
          if (path === "bulk-imports")
            return answer({ ok: true, imports: [], nextCursor: null });
          if (path === "booking-drafts")
            return answer({
              ok: true,
              drafts: url.searchParams.has("cursor")
                ? [
                    { id: "draft-A", description: "First saved request" },
                    { id: "draft-B", description: "Second saved request" },
                  ]
                : [{ id: "draft-A", description: "First saved request" }],
              page: {
                nextCursor: url.searchParams.has("cursor")
                  ? null
                  : "draft-page-2",
              },
            });
          if (
            path === `service-templates/${templateId}` &&
            method === "PATCH"
          ) {
            const body = JSON.parse(req.postData());
            if (body.active === false) {
              active = false;
              version += 1;
              return answer({ ok: true });
            }
            replacements += 1;
            if (replacements === 1) {
              version = 2;
              return answer(
                {
                  ok: false,
                  error: "revision_mismatch",
                  message: "Template changed. Refresh before replacing it.",
                },
                412,
              );
            }
            if (replacements === 2)
              return answer(
                {
                  ok: false,
                  error: "service_unavailable",
                  message:
                    "Save result could not be confirmed. Retry this change.",
                },
                503,
              );
            version = 3;
            return answer({ ok: true });
          }
          return answer(
            { ok: false, error: "unexpected_test_request", message: path },
            500,
          );
        });
        await page.goto(`${base}/templates`);
        await page.getByText("template-A", { exact: true }).waitFor();
        async function selectSecondDraft() {
          await page
            .getByText("Replace saved details", { exact: true })
            .click();
          await page
            .getByRole("button", { name: "More saved requests", exact: true })
            .click();
          const field = page.getByRole("combobox", {
            name: /^Use details from/u,
          });
          await field.selectOption("draft-B");
          assert.equal(await field.locator("option").count(), 3);
        }
        await selectSecondDraft();
        await page
          .getByRole("button", {
            name: "Replace template details",
            exact: true,
          })
          .click();
        await page
          .getByText(/Template changed\. Refresh before replacing it\./u)
          .waitFor();
        assert.equal(
          await page
            .getByRole("combobox", { name: /^Use details from/u })
            .inputValue(),
          "draft-B",
        );
        await page
          .getByRole("button", { name: "Refresh", exact: true })
          .click();
        await page.getByText("template-A", { exact: true }).waitFor();
        await page.getByText("Replace saved details", { exact: true }).click();
        assert.equal(
          await page
            .getByRole("combobox", { name: /^Use details from/u })
            .inputValue(),
          "",
        );
        await page
          .getByRole("button", { name: "More saved requests", exact: true })
          .click();
        await page
          .getByRole("combobox", { name: /^Use details from/u })
          .selectOption("draft-B");
        await page
          .getByRole("button", {
            name: "Replace template details",
            exact: true,
          })
          .click();
        await page.getByText(/Save result could not be confirmed/u).waitFor();
        await page
          .getByRole("button", {
            name: "Replace template details",
            exact: true,
          })
          .click();
        await page.getByText("View saved details", { exact: true }).click();
        await page
          .getByText("Updated reusable scope", { exact: true })
          .waitFor();
        const patches = requests.filter((req) => req.method === "PATCH");
        assert.equal(patches.length, 3);
        assert.equal(patches[0]?.revision, '"template-1"');
        assert.equal(patches[1]?.revision, '"template-2"');
        assert.equal(patches[1]?.key, patches[2]?.key);
        assert.notEqual(patches[0]?.key, patches[1]?.key);
        for (const req of patches)
          assert.deepEqual(JSON.parse(req.body!), { draftId: "draft-B" });
        templateId = "template-B";
        await page
          .getByRole("button", { name: "Refresh", exact: true })
          .click();
        await page.getByText("template-B", { exact: true }).waitFor();
        await page.getByText("Replace saved details", { exact: true }).click();
        assert.equal(
          await page
            .getByRole("combobox", { name: /^Use details from/u })
            .inputValue(),
          "",
        );
        assert.equal(
          await page
            .getByRole("button", {
              name: "Replace template details",
              exact: true,
            })
            .isDisabled(),
          true,
        );
        await page
          .getByRole("button", {
            name: "Disable optional templates",
            exact: true,
          })
          .click();
        await page
          .getByRole("button", { name: "Remove shortcut", exact: true })
          .waitFor();
        assert.equal(
          await page
            .getByText("Replace saved details", { exact: true })
            .count(),
          0,
        );
        assert.equal(
          await page.getByRole("button", { name: "Use", exact: true }).count(),
          0,
        );
        page.once("dialog", (dialog: any) => dialog.accept());
        await page
          .getByRole("button", { name: "Remove shortcut", exact: true })
          .click();
        await page.getByText("Archived", { exact: true }).waitFor();
        assert.equal(
          await page
            .getByRole("button", { name: "Restore shortcut", exact: true })
            .count(),
          0,
        );
        assert.deepEqual(
          JSON.parse(
            requests.filter((req) => req.method === "PATCH").at(-1)!.body!,
          ),
          { active: false },
        );
        assert.deepEqual(errors, []);
      }),
  );

  test(
    `${engine.name()}: actual proof Undo handles retry, stale revision recovery, job isolation and read-only permissions`,
    { timeout: 60000 },
    async () =>
      harness(engine, async (page, base, errors) => {
        const live: Record<string, any[]> = {
            "job-A": [media("photo-A"), media("document-A", "document")],
            "job-B": [media("photo-B")],
          },
          removed: Record<string, any[]> = { "job-A": [], "job-B": [] },
          requests: RequestEvidence[] = [];
        let imageRestoreAttempts = 0,
          documentRestoreAttempts = 0;
        await page.route("**/api/partners/portal/**", async (route: any) => {
          const req = route.request(),
            path = new URL(req.url()).pathname.split(
              "/api/partners/portal/",
            )[1]!;
          requests.push({
            path,
            method: req.method(),
            body: req.postData(),
            revision: req.headers()["if-match"],
            key: req.headers()["idempotency-key"],
          });
          const [, job, , id, action] = path.split("/"),
            answer = (json: any, status = 200) =>
              route.fulfill({ status, json });
          if (!job || !live[job])
            return answer({ ok: false, error: "not_found" }, 404);
          if (req.method() === "GET")
            return answer({ ok: true, proof: proof(live[job], removed[job]) });
          if (req.method() === "DELETE") {
            const file = live[job].find((item) => item.id === id);
            if (!file) return answer({ ok: false, error: "not_found" }, 404);
            live[job] = live[job].filter((item) => item.id !== id);
            removed[job]!.push({
              id,
              category: file.category,
              filename: file.filename,
              deletedAt,
              recoverableUntil: "2026-10-09T12:00:00.000Z",
            });
            return answer({ ok: true, deleted: { id, deletedAt } });
          }
          if (action === "restore") {
            const target = removed[job]!.find((item) => item.id === id);
            if (!target) return answer({ ok: false, error: "not_found" }, 404);
            if (id === "photo-A" && ++imageRestoreAttempts === 1)
              return answer(
                {
                  ok: false,
                  error: "service_unavailable",
                  message: "Restore result uncertain. Retry safely.",
                },
                503,
              );
            if (id === "document-A" && ++documentRestoreAttempts === 1) {
              target.deletedAt = revisedDeletion;
              return answer(
                {
                  ok: false,
                  error: "revision_mismatch",
                  message:
                    "Removed file changed. Refresh the recently removed list.",
                },
                412,
              );
            }
            if (req.headers()["if-match"] !== `"${target.deletedAt}"`)
              return answer(
                {
                  ok: false,
                  error: "revision_mismatch",
                  message: "Refresh the recently removed list.",
                },
                412,
              );
            live[job]!.push(media(id!, target.category));
            removed[job] = removed[job]!.filter((item) => item.id !== id);
            return answer({ ok: true, restored: { id, restored: true } });
          }
          return answer({ ok: false, error: "unexpected_test_request" }, 500);
        });
        await page.goto(`${base}/proof`);
        const removeFile = async (caption: string) =>
          page
            .locator("li")
            .filter({ has: page.getByText(caption, { exact: true }) })
            .getByRole("button", { name: "Remove", exact: true })
            .click();
        await removeFile("photo-A caption");
        await page
          .getByRole("button", { name: "Undo removal", exact: true })
          .click();
        await page.getByText(/Restore result uncertain/u).waitFor();
        await page
          .getByRole("button", { name: "Undo removal", exact: true })
          .click();
        await page.getByText("photo-A caption", { exact: true }).waitFor();
        const photoRestores = requests.filter(
          (req) => req.path === "jobs/job-A/proof/photo-A/restore",
        );
        assert.equal(photoRestores.length, 2);
        assert.equal(photoRestores[0]?.key, photoRestores[1]?.key);
        assert.equal(photoRestores[0]?.revision, `"${deletedAt}"`);
        await removeFile("document-A caption");
        await page
          .getByRole("button", { name: "Undo removal", exact: true })
          .click();
        await page.getByText(/Removed file changed/u).waitFor();
        await page
          .getByRole("button", { name: "Refresh", exact: true })
          .click();
        await page.getByText("Recently removed files", { exact: true }).click();
        await page
          .getByRole("button", { name: "Restore file", exact: true })
          .click();
        await page.getByText("document-A caption", { exact: true }).waitFor();
        assert.equal(
          requests
            .filter((req) => req.path === "jobs/job-A/proof/document-A/restore")
            .at(-1)?.revision,
          `"${revisedDeletion}"`,
        );
        await removeFile("photo-A caption");
        await page
          .getByRole("button", { name: "Switch proof job", exact: true })
          .click();
        await page.getByText("photo-B caption", { exact: true }).waitFor();
        assert.equal(
          await page
            .getByRole("button", { name: "Undo removal", exact: true })
            .count(),
          0,
        );
        assert.equal(
          await page.getByText("document-A caption", { exact: true }).count(),
          0,
        );
        await removeFile("photo-B caption");
        await page
          .getByRole("button", { name: "Undo removal", exact: true })
          .waitFor();
        await page
          .getByRole("button", { name: "Make proof read only", exact: true })
          .click();
        assert.equal(
          await page
            .getByRole("button", { name: "Undo removal", exact: true })
            .count(),
          0,
        );
        assert.equal(
          await page
            .getByRole("button", { name: "Restore file", exact: true })
            .count(),
          0,
        );
        assert.equal(
          requests.some((req) => req.path.includes("jobs/job-B/proof/photo-A")),
          false,
        );
        assert.deepEqual(errors, []);
      }),
  );
}
