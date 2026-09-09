import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repo = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/u, "");
const require = createRequire(`${repo}/package.json`);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const { chromium, webkit } = require("@playwright/test");
const date = (minute: number) =>
  new Date(Date.UTC(2026, 8, 9, 10, minute)).toISOString();
const message = (id: string, body: string, minute: number, extra = {}) => ({
  id,
  body,
  createdAt: date(minute),
  authorType: "partner",
  authorName: "Mia Contractor",
  isCurrentAuthor: false,
  direction: "inbound",
  channel: "portal",
  deliveryStatus: "delivered",
  attachmentIds: [],
  ...extra,
});
const initialMessages = [
  message("own", "Original message from me", 10, { isCurrentAuthor: true }),
  message("teammate", "Mia’s latest update", 20),
  message("staff", "Stonegate service update", 30, {
    authorType: "staff",
    authorName: "Sam at Stonegate",
    attachmentIds: ["file-one"],
    attachments: [{ id: "file-one", filename: "Site instructions.pdf" }],
  }),
];
const notification = (
  id: string,
  title: string,
  minute: number,
  read = false,
) => ({
  id,
  title,
  body: `Details for ${title}`,
  createdAt: date(minute),
  readAt: read ? date(minute + 1) : null,
  actionPath: `/partners/bookings/${id}`,
});
const initialNotifications = [
  notification("update-one", "Current job update", 30),
  notification("update-two", "Previously read update", 20, true),
];

async function harness(kind: "messages" | "updates") {
  const content =
    kind === "messages"
      ? `<PartnerJobMessages accountId={state.account} jobId={state.job} timezone="America/New_York" canSend initialMessages={state.items} initialPage={state.page}/>`
      : `<PartnerNotificationList key={state.account} initialNotifications={state.items} initialNextCursor={state.page.nextCursor} state="all" pageLimit={2}/>`;
  const bundle = await build({
    stdin: {
      contents: `import React from 'react';import{createRoot}from'react-dom/client';
    import{PartnerJobMessages}from'./src/app/partners/components/PartnerJobMessages';
    import{PartnerNotificationList}from'./src/app/partners/components/PartnerNotificationList';
    function App(){const[state,setState]=React.useState(window.__fixture);React.useEffect(()=>{window.__replace=setState},[]);return ${content}};
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
    minify: true,
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
    logLevel: "error",
    plugins: [
      {
        name: "local-next-browser-boundaries",
        setup(builder: any) {
          builder.onResolve(
            { filter: /^next\/(link|navigation)$/ },
            (args: any) => ({ path: args.path, namespace: "next-local" }),
          );
          builder.onLoad(
            { filter: /.*/, namespace: "next-local" },
            (args: any) => ({
              loader: "js",
              resolveDir: `${repo}/apps/site`,
              contents:
                args.path === "next/link"
                  ? `import React from 'react';export default function Link({href,children,prefetch,replace,scroll,...props}){return React.createElement('a',{...props,href},children)}`
                  : `export function useRouter(){return{refresh(){window.__refreshes=(window.__refreshes||0)+1}}}export function usePathname(){return '/partners/updates'}`,
            }),
          );
        },
      },
    ],
  });
  const fixture = {
    account: "account-a",
    job: "job-a",
    items: kind === "messages" ? initialMessages : initialNotifications,
    page: { limit: 2, nextCursor: "older-one", hasMore: true },
  };
  const control = {
    failSend: true,
    failOlder: true,
    failRead: true,
    holdHistory: false,
    holdRead: false,
    requests: [] as { path: string; method: string; key?: string; body: any }[],
    held: [] as (() => void)[],
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://local.test");
    if (url.pathname === "/client.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(bundle.outputFiles[0].contents);
      return;
    }
    if (url.pathname.startsWith("/partners/bookings/")) {
      response.setHeader("Content-Type", "text/html");
      response.end(
        "<!doctype html><html><body><h1>Opened linked job</h1></body></html>",
      );
      return;
    }
    const reply = (data: unknown, status = 200) => {
      response.statusCode = status;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(data));
    };
    const failure = () =>
      reply(
        {
          ok: false,
          error: "service_unavailable",
          message: "Local test service unavailable",
          retryable: true,
        },
        503,
      );
    if (url.pathname.startsWith("/api/partners/portal/")) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString())
        : null;
      control.requests.push({
        path: url.pathname + url.search,
        method: request.method ?? "GET",
        key: request.headers["idempotency-key"] as string | undefined,
        body,
      });
      if (url.pathname.endsWith("/proof")) {
        reply({
          ok: true,
          proof: {
            media: [
              {
                id: "file-one",
                status: "ready",
                filename: "Site instructions.pdf",
                caption: null,
              },
              {
                id: "unfinished",
                status: "pending",
                filename: "Not ready yet",
                caption: null,
              },
            ],
          },
        });
        return;
      }
      if (url.pathname.endsWith("/messages") && request.method === "POST") {
        if (control.failSend) {
          control.failSend = false;
          failure();
          return;
        }
        reply({
          ok: true,
          threadId: "thread-a",
          message: message(`sent-${control.requests.length}`, body.body, 45, {
            isCurrentAuthor: true,
            attachmentIds: body.attachmentIds,
          }),
        });
        return;
      }
      if (url.pathname.endsWith("/messages")) {
        const cursor = url.searchParams.get("cursor");
        const send = () => {
          if (cursor === "older-one")
            reply({
              ok: true,
              thread: { id: "thread-a" },
              messages: [
                message("older", "Older teammate message", 5),
                initialMessages[1],
              ],
              page: { limit: 2, nextCursor: "older-two", hasMore: true },
            });
          else if (cursor === "older-two" && control.failOlder) {
            control.failOlder = false;
            failure();
          } else if (cursor === "older-two")
            reply({
              ok: true,
              thread: { id: "thread-a" },
              messages: [message("oldest", "Oldest saved message", 0)],
              page: { limit: 2, nextCursor: null, hasMore: false },
            });
          else
            reply({
              ok: true,
              thread: { id: "thread-a" },
              messages: [
                message("newest", "Refreshed latest message", 40),
                ...initialMessages,
              ],
              page: { limit: 2, nextCursor: "older-one", hasMore: true },
            });
        };
        if (control.holdHistory) control.held.push(send);
        else send();
        return;
      }
      if (url.pathname.endsWith("/read")) {
        const send = () => {
          if (control.failRead) {
            control.failRead = false;
            failure();
          } else
            reply({
              ok: true,
              notification: {
                id: url.pathname.split("/").at(-2),
                readAt: date(50),
              },
            });
        };
        if (control.holdRead) control.held.push(send);
        else send();
        return;
      }
      if (url.pathname.endsWith("/notifications")) {
        const send = () => {
          if (control.failOlder) {
            control.failOlder = false;
            failure();
          } else
            reply({
              ok: true,
              notifications: [
                initialNotifications[1],
                notification("older-update", "Older job update", 0),
              ],
              page: { nextCursor: null },
            });
        };
        if (control.holdHistory) control.held.push(send);
        else send();
        return;
      }
      reply({ ok: false, error: "not_found" }, 404);
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(
      `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui}button,input,select,textarea{min-height:44px}svg{width:20px;height:20px}fieldset{min-width:0}.sr-only{position:absolute;clip:rect(0,0,0,0)}</style></head><body><main><div id="root"></div></main><script>window.__fixture=${JSON.stringify(fixture)}</script><script src="/client.js"></script></body></html>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    control,
    fixture,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      control.held.splice(0).forEach((release) => release());
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

for (const engine of [chromium, webkit]) {
  test(
    `${engine.name()}: job history, named authors, attachment visibility, send retry, and account/job isolation`,
    { timeout: 60000 },
    async () => {
      const local = await harness("messages"),
        browser = await engine.launch();
      try {
        const page = await browser.newPage({
          viewport: { width: 375, height: 812 },
        });
        page.setDefaultTimeout(5000);
        const errors: string[] = [];
        page.on("pageerror", (error: Error) => {
          errors.push(error.message);
          console.error("Component browser error:", error.message);
        });
        await page.goto(local.url);
        await page
          .getByRole("article", { name: "Message from Mia Contractor" })
          .waitFor();
        assert.equal(
          await page.getByRole("article", { name: "Message from you" }).count(),
          1,
        );
        await page
          .getByRole("article", { name: "Message from Sam at Stonegate" })
          .waitFor();
        // This must be a real, job-bound attachment link for ordinary messages,
        // not only for the component's system-event branch.
        await page
          .getByRole("link", { name: /Site instructions.pdf/ })
          .waitFor({ timeout: 3000 });
        assert.equal(
          await page
            .getByRole("link", { name: /Site instructions.pdf/ })
            .getAttribute("href"),
          "/partners/media/job-a/file-one",
        );
        await page.getByRole("button", { name: "Load older messages" }).click();
        await page
          .getByText("Older teammate message", { exact: true })
          .waitFor();
        assert.equal(
          await page.getByText("Mia’s latest update", { exact: true }).count(),
          1,
        );
        await page.getByRole("button", { name: "Load older messages" }).click();
        await page
          .getByText("Local test service unavailable", { exact: true })
          .waitFor();
        assert.equal(
          await page
            .getByRole("log", { name: "Job message history" })
            .isVisible(),
          true,
          "a failed fetch must preserve already-loaded conversation",
        );
        await page.getByRole("button", { name: "Load older messages" }).click();
        await page.getByText("Oldest saved message", { exact: true }).waitFor();
        await page
          .getByRole("button", { name: "Refresh", exact: true })
          .click();
        await page
          .getByText("Refreshed latest message", { exact: true })
          .waitFor();
        assert.equal(
          await page.getByText("Oldest saved message", { exact: true }).count(),
          1,
        );
        assert.equal(
          await page
            .getByRole("button", { name: "Load older messages" })
            .count(),
          0,
        );
        const draft = page.getByLabel("Message Stonegate");
        await draft.fill("Please use the side loading area.");
        await page
          .getByText("Attach files already on this job", { exact: true })
          .click();
        await page
          .getByRole("checkbox", { name: "Site instructions.pdf" })
          .check();
        assert.equal(
          await page.getByRole("checkbox", { name: "Not ready yet" }).count(),
          0,
        );
        await page
          .getByRole("button", { name: "Send message", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Retry this message" })
          .waitFor();
        assert.equal(
          await draft.inputValue(),
          "Please use the side loading area.",
        );
        assert.equal(
          await page
            .getByRole("checkbox", { name: "Site instructions.pdf" })
            .isChecked(),
          true,
        );
        await page.getByRole("button", { name: "Retry this message" }).click();
        await page
          .getByText("Message sent to Stonegate.", { exact: true })
          .waitFor();
        assert.equal(await draft.inputValue(), "");
        const sends = local.control.requests.filter(
          (request) =>
            request.method === "POST" && request.path.endsWith("/messages"),
        );
        assert.equal(sends.length, 2);
        assert.equal(sends[0].key, sends[1].key);
        assert.deepEqual(sends[0].body, sends[1].body);
        assert.deepEqual(sends[0].body.attachmentIds, ["file-one"]);
        local.control.failSend = true;
        await draft.fill("Draft before revision.");
        await page
          .getByRole("button", { name: "Send message", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Retry this message" })
          .waitFor();
        await draft.fill("Revised unsent draft.");
        assert.equal(
          await page
            .getByRole("button", { name: "Retry this message" })
            .count(),
          0,
        );
        await page
          .getByRole("button", { name: "Send message", exact: true })
          .click();
        await page
          .getByText("Message sent to Stonegate.", { exact: true })
          .waitFor();
        const changed = local.control.requests.filter(
          (request) =>
            request.method === "POST" && request.path.endsWith("/messages"),
        );
        assert.notEqual(changed[2].key, changed[3].key);
        assert.equal(changed[3].body.body, "Revised unsent draft.");
        await draft.fill("Account A private unfinished draft");
        local.control.holdHistory = true;
        await page
          .getByRole("button", { name: "Refresh", exact: true })
          .click();
        await page.waitForFunction(
          () => document.querySelector("button")?.disabled === true,
        );
        await page.evaluate(
          (items: any) =>
            (window as any).__replace({
              account: "account-b",
              job: "job-a",
              items,
              page: { limit: 2, nextCursor: null, hasMore: false },
            }),
          [message("b", "Account B only message", 1)],
        );
        await page
          .getByText("Account B only message", { exact: true })
          .waitFor();
        local.control.held.splice(0).forEach((release) => release());
        await page.waitForTimeout(50);
        assert.equal(
          await page
            .getByText("Original message from me", { exact: true })
            .count(),
          0,
        );
        assert.equal(
          await page.getByLabel("Message Stonegate").inputValue(),
          "",
        );
        await page.evaluate(
          (items: any) =>
            (window as any).__replace({
              account: "account-b",
              job: "job-c",
              items,
              page: { limit: 2, nextCursor: null, hasMore: false },
            }),
          [message("c", "Different job only message", 1)],
        );
        await page
          .getByText("Different job only message", { exact: true })
          .waitFor();
        assert.equal(
          await page
            .getByText("Account B only message", { exact: true })
            .count(),
          0,
        );
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
        await local.close();
      }
    },
  );
  test(
    `${engine.name()}: update pagination retry, mark-read recovery, preserved history and account-safe job links`,
    { timeout: 60000 },
    async () => {
      const local = await harness("updates"),
        browser = await engine.launch();
      try {
        const page = await browser.newPage({
          viewport: { width: 375, height: 812 },
        });
        page.setDefaultTimeout(5000);
        const errors: string[] = [];
        page.on("pageerror", (error: Error) => {
          errors.push(error.message);
          console.error("Component browser error:", error.message);
        });
        await page.goto(local.url);
        await page.getByText("Current job update", { exact: true }).waitFor();
        await page.getByRole("button", { name: "Older updates" }).click();
        await page
          .getByText("Older updates could not be loaded. Try again.", {
            exact: true,
          })
          .waitFor();
        assert.equal(
          await page
            .getByText("Current job update", { exact: true })
            .isVisible(),
          true,
        );
        await page.getByRole("button", { name: "Older updates" }).click();
        await page.getByText("Older job update", { exact: true }).waitFor();
        assert.equal(
          await page
            .getByText("Older updates could not be loaded. Try again.", {
              exact: true,
            })
            .count(),
          0,
          "a successful retry must clear its stale failure notice",
        );
        assert.equal(
          await page
            .getByText("Previously read update", { exact: true })
            .count(),
          1,
        );
        const current = page
          .getByRole("listitem")
          .filter({
            has: page.getByText("Current job update", { exact: true }),
          });
        await current
          .getByRole("button", { name: "Mark read", exact: true })
          .click();
        await page
          .getByText("Local test service unavailable", { exact: true })
          .waitFor();
        assert.equal(
          await current
            .getByRole("link", { name: "Open", exact: true })
            .getAttribute("href"),
          "/partners/bookings/update-one",
        );
        await current
          .getByRole("button", { name: "Mark read", exact: true })
          .click();
        await current
          .getByRole("button", { name: "Read", exact: true })
          .waitFor();
        await page.evaluate(
          (items: any) =>
            (window as any).__replace({
              account: "account-a",
              job: "job-a",
              items,
              page: { limit: 2, nextCursor: "new-cursor", hasMore: true },
            }),
          [
            notification("new-update", "Newly refreshed update", 40),
            notification("update-one", "Current job update", 30, true),
          ],
        );
        await page
          .getByText("Newly refreshed update", { exact: true })
          .waitFor();
        assert.equal(
          await page.getByText("Older job update", { exact: true }).count(),
          1,
        );
        local.control.failRead = true;
        await page.getByRole("button", { name: "Mark these read" }).click();
        await page
          .getByText(
            "Some updates could not be marked as read. Try again shortly.",
            { exact: true },
          )
          .waitFor();
        await page.getByRole("button", { name: "Mark these read" }).click();
        await page.waitForFunction(
          () =>
            Array.from(document.querySelectorAll("button")).find((button) =>
              button.textContent?.includes("Mark these read"),
            )?.disabled === true,
        );
        await page.evaluate(
          (items: any) =>
            (window as any).__replace({
              account: "account-b",
              job: "job-b",
              items,
              page: { limit: 2, nextCursor: "b-older", hasMore: true },
            }),
          [notification("b-update", "Account B private update", 10)],
        );
        await page
          .getByText("Account B private update", { exact: true })
          .waitFor();
        assert.equal(
          await page.getByText("Older job update", { exact: true }).count(),
          0,
        );
        local.control.holdHistory = true;
        await page.getByRole("button", { name: "Older updates" }).click();
        await page
          .getByRole("button", { name: "Loading…", exact: true })
          .waitFor();
        await page.evaluate(
          (items: any) =>
            (window as any).__replace({
              account: "account-c",
              job: "job-c",
              items,
              page: { limit: 2, nextCursor: null, hasMore: false },
            }),
          [notification("c-update", "Account C private update", 10)],
        );
        await page
          .getByText("Account C private update", { exact: true })
          .waitFor();
        local.control.held.splice(0).forEach((release) => release());
        await page.waitForTimeout(50);
        assert.equal(
          await page.getByText("Older job update", { exact: true }).count(),
          0,
        );
        assert.equal(
          await page
            .getByText("Account B private update", { exact: true })
            .count(),
          0,
        );
        local.control.failRead = true;
        local.control.holdRead = true;
        await page.getByRole("link", { name: "Open", exact: true }).click();
        await page
          .getByRole("heading", { name: "Opened linked job" })
          .waitFor({ timeout: 3000 });
        assert.equal(
          new URL(page.url()).pathname,
          "/partners/bookings/c-update",
        );
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
        await local.close();
      }
    },
  );
}
