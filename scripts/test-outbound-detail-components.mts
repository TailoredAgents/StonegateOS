import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium, webkit, type BrowserType } from "@playwright/test";
import { resolveOutboundContactContext } from "../apps/site/src/app/team/outbound-detail";

const repo = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/u, "");
const require = createRequire(`${repo}/package.json`);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const siteRequire = createRequire(`${repo}/apps/site/package.json`);
const tailwindConfig = siteRequire(
  `${repo}/apps/site/tailwind.config.ts`,
).default;
const css = (
  await siteRequire("postcss")([
    siteRequire("tailwindcss")({
      ...tailwindConfig,
      content: [
        {
          raw: [
            "OutboundAccountDetail.tsx",
            "OutboundContactActions.tsx",
            "team-ui.ts",
          ]
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
const version = "2026-09-09T12:00:00.000Z";
const contacts = [
  {
    id: "primary",
    name: "Casey",
    phone: "4045550100",
    email: "casey@example.test",
    doNotContact: false,
    doNotContactAt: null,
    doNotContactReason: null,
  },
  {
    id: "linked",
    name: "Jordan",
    phone: null,
    email: "jordan@example.test",
    doNotContact: false,
    doNotContactAt: null,
    doNotContactReason: null,
  },
  {
    id: "dnc",
    name: "Alex",
    phone: "4045550101",
    email: "alex@example.test",
    doNotContact: true,
    doNotContactAt: version,
    doNotContactReason: "Customer request",
  },
  {
    id: "missing",
    name: "Taylor",
    phone: null,
    email: null,
    doNotContact: false,
    doNotContactAt: null,
    doNotContactReason: null,
  },
];
const tasks = [
  {
    id: "primary-task",
    contactId: "primary",
    contactName: "Casey",
    version,
    title: "First introduction",
    dueAt: null,
    attempt: 1,
    lastDisposition: null,
    doNotContact: false,
  },
  {
    id: "linked-task",
    contactId: "linked",
    contactName: "Jordan",
    version,
    title: "Follow-up",
    dueAt: version,
    attempt: 2,
    lastDisposition: "no_answer",
    doNotContact: false,
  },
  {
    id: "linked-task-2",
    contactId: "linked",
    contactName: "Jordan",
    version,
    title: "Other campaign",
    dueAt: version,
    attempt: 1,
    lastDisposition: null,
    doNotContact: false,
  },
  {
    id: "dnc-task",
    contactId: "dnc",
    contactName: "Alex",
    version,
    title: "Blocked",
    dueAt: null,
    attempt: 1,
    lastDisposition: "dnc",
    doNotContact: true,
  },
  {
    id: "missing-task",
    contactId: "missing",
    contactName: "Taylor",
    version,
    title: "Research contact details",
    dueAt: null,
    attempt: 1,
    lastDisposition: null,
    doNotContact: false,
  },
];
const item = {
  id: "account-a",
  title: "First introduction",
  dueAt: null,
  overdue: false,
  minutesUntilDue: null,
  attempt: 1,
  campaign: "property_management",
  lastDisposition: null,
  company: "Example company",
  noteSnippet: null,
  startedAt: null,
  reminderAt: null,
  assignedToMemberId: "owner",
  primaryTaskId: "primary-task",
  primaryTaskVersion: version,
  primaryContactId: "primary",
  taskIds: tasks.map((task) => task.id),
  contactCount: 4,
  dncContactCount: 1,
  openTaskCount: 5,
  contacts,
  tasks,
  account: {
    id: "account-a",
    name: "Example company",
    status: "new",
    segment: "property_manager",
    lastTouchAt: null,
    nextTouchAt: null,
    brief: null,
    history: [],
  },
};

void test("contact resolver never borrows another person's task or communication channel", () => {
  assert.equal(
    resolveOutboundContactContext(item, "linked")?.task?.id,
    "linked-task",
  );
  assert.equal(
    resolveOutboundContactContext(item, "linked", "primary-task")?.task,
    null,
  );
  assert.equal(resolveOutboundContactContext(item, "not-found"), null);
  assert.deepEqual(resolveOutboundContactContext(item, "linked")?.channels, [
    "email",
  ]);
  assert.deepEqual(
    resolveOutboundContactContext(item, "missing")?.channels,
    [],
  );
  assert.equal(
    resolveOutboundContactContext(item, "dnc")?.outreachBlocked,
    true,
  );
  assert.equal(
    resolveOutboundContactContext(
      {
        ...item,
        tasks: tasks.map((task) =>
          task.id === "primary-task" ? { ...task, doNotContact: true } : task,
        ),
      },
      "primary",
    )?.outreachBlocked,
    true,
  );
});

async function harness(engine: BrowserType, width: number, readOnly = false) {
  const bundle = await build({
    stdin: {
      contents: `import React from'react';import{createRoot}from'react-dom/client';import{OutboundAccountDetail}from'./src/app/team/components/OutboundAccountDetail';
      function App(){const[item,setItem]=React.useState(${JSON.stringify(item)});const[initialTaskId,setInitialTaskId]=React.useState(undefined);React.useEffect(()=>{window.__setInitialTask=setInitialTaskId;window.__refreshTask=(id)=>setItem(current=>({...current,tasks:current.tasks.map(task=>task.id===id?{...task,version:'2026-09-09T13:00:00.000Z'}:task)}))},[]);return <main><h1>Outbound</h1><OutboundAccountDetail item={item} initialTaskId={initialTaskId} members={[{id:'owner',name:'Owner'}]} permissions={{canCall:${!readOnly},canMessage:${!readOnly},canDraft:${!readOnly},canManage:${!readOnly}}} closeHref='/queue'/></main>}createRoot(document.getElementById('root')).render(<App/>);`,
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
        name: "safe-local-actions",
        setup(builder) {
          builder.onResolve(
            { filter: /^(\.\.\/actions|next\/navigation|node:crypto)$/ },
            (args) => ({ path: args.path, namespace: "local" }),
          );
          builder.onLoad({ filter: /.*/, namespace: "local" }, (args) => ({
            loader: "js",
            resolveDir: `${repo}/apps/site`,
            contents:
              args.path === "node:crypto"
                ? "export const randomUUID=()=>crypto.randomUUID()"
                : args.path === "next/navigation"
                  ? "const router={refresh(){}};export const useRouter=()=>router;"
                  : [
                      "draftOutboundFirstTouchAction",
                      "draftOutboundFollowupAction",
                      "openContactThreadAction",
                      "setOutboundDispositionAction",
                      "startContactCallAction",
                    ]
                      .map(
                        (name) =>
                          `export const ${name}=async(data)=>{window.__submissions=(window.__submissions||[]).concat({action:'${name}',data:Object.fromEntries(data.entries())})}`,
                      )
                      .join(";"),
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
      `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Outbound detail test</title><style>${css}</style><style>:root{--team-border:#cbd5e1;--team-surface:#fff;--team-surface-muted:#f1f5f9;--team-text:#0f172a;--team-text-muted:#475569;--team-text-soft:#475569;--team-focus-ring:#166534;--team-focus-offset:#fff;--team-action-primary:#14532d;--team-action-primary-text:#fff;--team-action-primary-hover:#166534;--team-danger-surface:#fff1f2;--team-danger-border:#fecdd3;--team-danger-text:#881337;--team-warning-surface:#fffbeb;--team-warning-border:#fde68a;--team-warning-text:#78350f}body{margin:0;font-family:Arial,sans-serif}main{max-width:40rem;margin:auto;padding:12px}h1{font-size:24px;margin-bottom:16px}</style></head><body><div id="root"></div><script src="/client.js"></script></body></html>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const browser = await engine.launch();
  const page = await browser.newPage({ viewport: { width, height: 850 } });
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.getByRole("heading", { name: "Example company" }).waitFor();
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
    void test(`${engine.name()} ${width}px: contact-specific actions, one outcome, draft retention and revision guard`, async () => {
      const { page, close } = await harness(engine, width);
      try {
        assert.equal(await page.locator("#outbound-account").count(), 1);
        await page.addScriptTag({
          path: require.resolve("axe-core/axe.min.js"),
        });
        const accessibility = await page.evaluate(async () =>
          (window as any).axe.run(document, {
            runOnly: {
              type: "tag",
              values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
            },
          }),
        );
        assert.deepEqual(
          accessibility.violations.map(
            (violation: { id: string }) => violation.id,
          ),
          [],
        );
        assert.equal(
          await page
            .getByRole("combobox", { name: "Outcome", exact: true })
            .count(),
          1,
        );
        await page
          .getByLabel("Quick recap", { exact: false })
          .fill("Primary notes stay with Casey");
        await page
          .getByRole("combobox", { name: "Contact", exact: true })
          .selectOption("linked");
        assert.equal(
          await page.getByText(/Follow up with Jordan/).isVisible(),
          true,
        );
        assert.equal(
          await page.getByRole("button", { name: "Call", exact: true }).count(),
          0,
        );
        assert.equal(
          await page.getByLabel("Quick recap", { exact: false }).inputValue(),
          "",
        );
        await page
          .getByLabel("Quick recap", { exact: false })
          .fill("Jordan first task notes");
        await page
          .getByRole("combobox", { name: "Outreach task", exact: true })
          .selectOption("linked-task-2");
        assert.equal(
          await page.getByLabel("Quick recap", { exact: false }).inputValue(),
          "",
        );
        await page
          .getByLabel("Quick recap", { exact: false })
          .fill("Jordan second task notes");
        await page
          .getByRole("combobox", { name: "Outreach task", exact: true })
          .selectOption("linked-task");
        assert.equal(
          await page.getByLabel("Quick recap", { exact: false }).inputValue(),
          "Jordan first task notes",
        );
        await page
          .getByRole("combobox", { name: "Outcome", exact: true })
          .selectOption("callback_requested");
        const callback = page.locator("input[name=callbackAt]");
        assert.equal(await callback.getAttribute("required"), "");
        await page
          .getByRole("button", { name: "Save callback", exact: true })
          .click();
        assert.equal(
          await page.evaluate(() => (window as any).__submissions?.length ?? 0),
          0,
        );
        await callback.fill("2026-09-10T09:00");
        await page
          .getByRole("button", { name: "Save callback", exact: true })
          .click();
        await page.waitForFunction(
          () => (window as any).__submissions?.length === 1,
        );
        const submission = await page.evaluate(
          () => (window as any).__submissions[0],
        );
        assert.equal(submission.action, "setOutboundDispositionAction");
        assert.equal(submission.data.taskId, "linked-task");
        assert.equal(submission.data.expectedVersion, version);
        assert.equal(submission.data.recap, "Jordan first task notes");
        assert.equal(submission.data.callbackAt, "2026-09-10T09:00");
        assert.match(submission.data.idempotencyKey, /^outbound-disposition:/);
        await page.evaluate(() => (window as any).__refreshTask("linked-task"));
        await page
          .getByRole("button", {
            name: "I reviewed the update — keep my notes",
          })
          .waitFor();
        assert.equal(
          await page
            .getByRole("button", { name: "Save callback", exact: true })
            .isDisabled(),
          true,
        );
        assert.equal(
          await page.getByLabel("Quick recap", { exact: false }).inputValue(),
          "Jordan first task notes",
        );
        await page
          .getByRole("button", {
            name: "I reviewed the update — keep my notes",
          })
          .click();
        assert.equal(
          await page
            .getByRole("button", { name: "Save callback", exact: true })
            .isDisabled(),
          false,
        );
        await page
          .getByRole("combobox", { name: "Contact", exact: true })
          .selectOption("primary");
        assert.equal(
          await page.getByLabel("Quick recap", { exact: false }).inputValue(),
          "Primary notes stay with Casey",
        );
        assert.equal(await page.locator("input[name=callbackAt]").count(), 0);
        await page.getByText("Help writing a message", { exact: true }).focus();
        await page.keyboard.press("Enter");
        await page
          .getByRole("combobox", { name: "Message type", exact: true })
          .selectOption("follow_up");
        await page
          .getByLabel("Extra context (optional)")
          .fill("Primary draft context");
        await page
          .getByRole("combobox", { name: "Latest outcome", exact: true })
          .selectOption("connected");
        await page
          .getByRole("combobox", { name: "Contact", exact: true })
          .selectOption("linked");
        assert.equal(
          await page.getByLabel("Extra context (optional)").inputValue(),
          "",
        );
        assert.equal(
          await page
            .getByRole("combobox", { name: "Latest outcome", exact: true })
            .inputValue(),
          "",
        );
        await page
          .getByRole("button", { name: "Create email suggestion", exact: true })
          .click();
        await page.waitForFunction(
          () => (window as any).__submissions?.length === 2,
        );
        const draft = await page.evaluate(
          () => (window as any).__submissions[1],
        );
        assert.equal(draft.action, "draftOutboundFollowupAction");
        assert.equal(draft.data.contactId, "linked");
        assert.equal(draft.data.taskId, "linked-task");
        assert.equal(draft.data.channel, "email");
        await page
          .getByRole("combobox", { name: "Contact", exact: true })
          .selectOption("dnc");
        assert.equal(await page.getByRole("button").count(), 0);
        assert.match(
          (await page.getByRole("status").textContent()) ?? "",
          /Do not contact/,
        );
        await page
          .getByRole("combobox", { name: "Contact", exact: true })
          .selectOption("missing");
        assert.equal(
          await page
            .getByRole("button", { name: /Call|Inbox|suggestion/ })
            .count(),
          0,
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
  void test(`${engine.name()}: task deep links select the matching contact and unknown tasks never fall back`, async () => {
    const { page, close } = await harness(engine, 375);
    try {
      await page
        .getByLabel("Quick recap", { exact: false })
        .fill("Casey notes");
      await page.evaluate(() =>
        (window as any).__setInitialTask("linked-task-2"),
      );
      await page.waitForFunction(
        () =>
          (document.querySelector("select") as HTMLSelectElement)?.value ===
          "linked",
      );
      assert.equal(
        await page
          .getByRole("combobox", { name: "Outreach task", exact: true })
          .inputValue(),
        "linked-task-2",
      );
      assert.equal(
        await page.getByLabel("Quick recap", { exact: false }).inputValue(),
        "",
      );
      await page
        .getByLabel("Quick recap", { exact: false })
        .fill("Jordan linked task notes");
      await page.evaluate(() =>
        (window as any).__setInitialTask("foreign-task"),
      );
      await page.getByRole("status").waitFor();
      assert.equal(await page.locator("form").count(), 0);
      await page.evaluate(() =>
        (window as any).__setInitialTask("primary-task"),
      );
      await page.waitForFunction(
        () =>
          (document.querySelector("select") as HTMLSelectElement)?.value ===
          "primary",
      );
      assert.equal(
        await page.getByLabel("Quick recap", { exact: false }).inputValue(),
        "Casey notes",
      );
      await page.evaluate(() =>
        (window as any).__setInitialTask("linked-task-2"),
      );
      await page.waitForFunction(
        () =>
          (document.querySelector("select") as HTMLSelectElement)?.value ===
          "linked",
      );
      assert.equal(
        await page.getByLabel("Quick recap", { exact: false }).inputValue(),
        "Jordan linked task notes",
      );
    } finally {
      await close();
    }
  });
  void test(`${engine.name()}: read-only access hides every mutation and message form`, async () => {
    const { page, close } = await harness(engine, 375, true);
    try {
      assert.equal(await page.locator("form").count(), 0);
      assert.equal(await page.getByRole("button").count(), 0);
      assert.equal(
        await page
          .getByText("You have read-only access to this account.")
          .isVisible(),
        true,
      );
      await page
        .getByText("History & account details", { exact: true })
        .click();
      assert.equal(
        await page.getByText("No activity recorded yet.").isVisible(),
        true,
      );
    } finally {
      await close();
    }
  });
}
