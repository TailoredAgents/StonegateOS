import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "@playwright/test";

// Real Next route, SSR and client navigation. Only synthetic loopback services.
// The disposable Site excludes every .env file and cannot fetch external hosts.
const repo = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/u, "");
const siteRequire = createRequire(`${repo}/apps/site/package.json`);
const artifact = join(repo, "artifacts/team-inbox-page");
const fixture = await mkdtemp(join(tmpdir(), "stonegate-inbox-page-"));
const fixtureSite = join(fixture, "apps/site");
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const employeeId = id(1),
  contactId = id(2),
  otherContactId = id(3),
  threadId = id(100),
  emailThreadId = id(101),
  otherThreadId = id(102),
  emptyThreadId = id(103),
  errorThreadId = id(104);
const member = {
  id: employeeId,
  name: "Fixture Office",
  email: "fixture@example.invalid",
  roleSlug: "owner",
  passwordSet: true,
  permissions: ["*"],
};
const contact = {
  id: contactId,
  name: "Casey Customer",
  firstName: "Casey",
  lastName: "Customer",
  email: "casey@example.invalid",
  phone: "+12025550123",
  phoneE164: "+12025550123",
  source: null,
  properties: [],
};
const otherContact = {
  ...contact,
  id: otherContactId,
  name: "Taylor Customer",
  firstName: "Taylor",
  email: "taylor@example.invalid",
  phone: "+12025550124",
  phoneE164: "+12025550124",
};
const at = (n: number) => new Date(Date.UTC(2026, 8, 13, 14, n)).toISOString();
function makeThread(n: number, c: typeof contact, channel = "sms") {
  return {
    id: id(n),
    status: n === 102 ? "pending" : "open",
    state: "new",
    channel,
    subject: `${c.name} ${channel}`,
    lastMessageAt: at(120 - n),
    lastMessagePreview: `${c.name} latest ${channel} message`,
    contact: c,
    property: null,
    messageCount: 35,
    failedMessageCount: 0,
  };
}
const threads = [
  makeThread(100, contact),
  makeThread(102, otherContact),
  makeThread(101, contact, "email"),
  makeThread(103, { ...contact, id: id(4), name: "Empty Customer" }),
  makeThread(104, { ...contact, id: id(5), name: "Error Customer" }),
  ...Array.from({ length: 55 }, (_, i) =>
    makeThread(110 + i, {
      ...contact,
      id: id(200 + i),
      name: `Customer ${i + 1}`,
    }),
  ),
];
const apiCalls: Array<{
  method: string;
  path: string;
  query: Record<string, string>;
}> = [];
const unexpected: string[] = [];
let failMessages = true;
let stallOptional = true;
let stallAutomation = false;
let handoffDraft = false;
const stalled = new Set<import("node:http").ServerResponse>();
const stalledAutomation = new Set<import("node:http").ServerResponse>();
function messagesFor(thread: (typeof threads)[number]) {
  if (thread.id === emptyThreadId) return [];
  const prefix =
    thread.id === threadId
      ? "Casey SMS"
      : thread.id === emailThreadId
        ? "Casey EMAIL"
        : thread.id === otherThreadId
          ? "Taylor SMS"
          : "Recovered SMS";
  return Array.from({ length: 35 }, (_, i) => ({
    id: id(Number(thread.id.slice(-12)) * 100 + i),
    threadId: thread.id,
    direction: i % 2 === 0 ? "inbound" : "outbound",
    channel: thread.channel,
    subject: thread.channel === "email" ? "Email subject" : null,
    body: `${prefix} message ${i + 1}: Please remove the old furniture from the garage.`,
    mediaUrls: [],
    deliveryStatus: i % 2 === 0 ? "received" : "delivered",
    participantName: null,
    createdAt: at(i),
    metadata: null,
  }));
}
const api = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1"),
    path = url.pathname,
    method = req.method ?? "GET";
  let rawBody = "";
  for await (const chunk of req) rawBody += String(chunk);
  const body = rawBody ? JSON.parse(rawBody) : null;
  apiCalls.push({ method, path, query: Object.fromEntries(url.searchParams) });
  const send = (data: unknown, status = 200) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(data));
  };
  if (method === "GET" && path === "/api/public/team/session")
    return send({
      ok: true,
      sessionId: "fixture-session",
      authMethod: "team_session",
      teamMember: member,
    });
  if (method === "GET" && path === "/api/admin/inbox/threads") {
    let filtered = threads;
    const q = url.searchParams.get("q");
    if (q)
      filtered = filtered.filter((t) =>
        `${t.contact.name} ${t.lastMessagePreview}`
          .toLowerCase()
          .includes(q.toLowerCase()),
      );
    const offset = Number(url.searchParams.get("offset") ?? 0),
      limit = Number(url.searchParams.get("limit") ?? 50),
      rows = filtered.slice(offset, offset + limit);
    return send({
      ok: true,
      threads: rows,
      queueCounts: {
        all: filtered.length,
        needsReply: 2,
        waiting: 1,
        failed: 0,
      },
      snapshot: { signature: `list-${q ?? "all"}-${offset}` },
      pagination: {
        limit,
        offset,
        total: filtered.length,
        nextOffset:
          offset + rows.length < filtered.length ? offset + rows.length : null,
      },
    });
  }
  if (method === "GET" && path === "/api/admin/inbox/timeline") {
    const c = threads.find(
      (t) => t.contact.id === url.searchParams.get("contactId"),
    )?.contact;
    if (!c) return send({ error: "not_found" }, 404);
    return send({
      ok: true,
      contact: c,
      threads: threads.filter((t) => t.contact.id === c.id),
      messages: [],
      snapshot: { signature: `timeline-${c.id}`, messageCount: 35 },
    });
  }
  if (method === "GET" && /^\/api\/admin\/inbox\/threads\/[^/]+$/u.test(path)) {
    const t = threads.find((t) => path.endsWith(t.id));
    if (!t) return send({ error: "not_found" }, 404);
    if (t.id === errorThreadId && failMessages)
      return send({ error: "fixture_unavailable" }, 503);
    const allMessages = messagesFor(t),
      limit = Number(url.searchParams.get("limit") ?? 50),
      messages = allMessages.slice(-limit),
      last = messages.at(-1),
      history = url.searchParams.has("cursor");
    return send({
      ok: true,
      thread: t,
      participants: [],
      messages,
      messagePage: {
        version: 1,
        state: messages.length ? "available" : "empty",
        complete: true,
        order: "oldest_to_newest",
        position: history ? "history" : "newest",
        limit,
        returned: messages.length,
        snapshot: last ? { createdAt: last.createdAt, id: last.id } : null,
        hasOlder: allMessages.length > limit,
        hasNewer: history,
        olderCursor: allMessages.length > limit ? "fixture_older" : null,
        newerCursor: history ? "fixture_newer" : null,
      },
    });
  }
  if (method === "POST" && /\/inbox\/threads\/[^/]+\/suggest$/u.test(path)) {
    if (handoffDraft && body?.auto !== true)
      return send({
        ok: true,
        created: true,
        threadId: emailThreadId,
        channel: "email",
        draft: { body: "Prepared email handoff.", subject: "Email handoff" },
      });
    return send({ ok: true, created: false });
  }
  if (
    method === "GET" &&
    /^\/api\/admin\/contacts\/[^/]+\/sales-agent-next-action$/u.test(path)
  ) {
    if (stallAutomation) {
      stalledAutomation.add(res);
      res.once("close", () => stalledAutomation.delete(res));
      return;
    }
    const dnc = path.includes(otherContactId);
    return send({
      ok: true,
      nextAction: { channel: "sms", actionType: dnc ? "do_not_contact" : null },
      autopilot: { mode: "off", channelMode: "off", channel: "sms" },
      executionState: {
        code: dnc ? "blocked" : "off",
        label: dnc ? "Do not contact" : "Off mode",
      },
      liveContext: {
        automation: [
          { channel: "sms", dnc, paused: false, humanTakeover: false },
        ],
      },
    });
  }
  if (
    method === "GET" &&
    [
      "/api/admin/contacts",
      "/api/appointments",
      "/api/quotes",
      "/api/admin/team/directory",
      "/api/admin/crm/tasks",
      "/api/admin/messaging/providers",
    ].includes(path)
  ) {
    if (stallOptional) {
      stalled.add(res);
      res.once("close", () => stalled.delete(res));
      return;
    }
    if (path === "/api/admin/contacts") {
      const c =
        threads.find((t) => t.contact.id === url.searchParams.get("contactId"))
          ?.contact ?? contact;
      return send({ contacts: [c] });
    }
    if (path === "/api/appointments") return send({ appointments: [] });
    if (path === "/api/quotes") return send({ quotes: [] });
    if (path === "/api/admin/team/directory")
      return send({ members: [member] });
    if (path === "/api/admin/crm/tasks") return send({ tasks: [] });
    return send({ providers: [] });
  }
  unexpected.push(`${method} ${path}`);
  return send({ error: "Unexpected fixture request" }, 501);
});
let next: ChildProcess | undefined;
let nextLog = "";
const pageErrors: string[] = [];
const consoleErrors: string[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await mkdir(artifact, { recursive: true });
  await mkdir(join(fixture, "apps"), { recursive: true });
  await cp(`${repo}/apps/site`, fixtureSite, {
    recursive: true,
    filter: (path) =>
      !["node_modules", ".next", ".contentlayer"].includes(basename(path)) &&
      !basename(path).startsWith(".env"),
  });
  await symlink(`${repo}/packages`, join(fixture, "packages"), "dir");
  await symlink(`${repo}/node_modules`, join(fixture, "node_modules"), "dir");
  await symlink(
    `${repo}/apps/site/node_modules`,
    join(fixtureSite, "node_modules"),
    "dir",
  );
  await cp(`${repo}/package.json`, join(fixture, "package.json"));
  const guard = join(fixture, "local-network-only.cjs");
  await writeFile(
    guard,
    `const actualFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input.url??String(input));if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('Smoke test blocked external fetch: '+url.origin);return actualFetch(input,init);};`,
  );
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const apiAddress = api.address();
  if (!apiAddress || typeof apiAddress === "string")
    throw Error("No mock API port");
  const base = `http://127.0.0.1:${apiAddress.port}`;
  const portServer = createServer();
  await new Promise<void>((resolve) =>
    portServer.listen(0, "127.0.0.1", resolve),
  );
  const siteAddress = portServer.address();
  if (!siteAddress || typeof siteAddress === "string")
    throw Error("No site port");
  const sitePort = siteAddress.port;
  await new Promise<void>((resolve) => portServer.close(() => resolve()));
  const siteBase = `http://127.0.0.1:${sitePort}`;
  next = spawn(
    process.execPath,
    [
      siteRequire.resolve("next/dist/bin/next"),
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(sitePort),
    ],
    {
      cwd: fixtureSite,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        NODE_ENV: "development",
        API_BASE_URL: base,
        NEXT_PUBLIC_API_BASE_URL: base,
        ADMIN_API_KEY: "fixture-only",
        SITE_URL: siteBase,
        NEXT_PUBLIC_SITE_URL: siteBase,

        NEXT_TELEMETRY_DISABLED: "1",
        CONTENTLAYER_TELEMETRY_DISABLED: "1",
        NODE_OPTIONS: `--require ${guard}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  next.stdout?.on("data", (chunk) => {
    nextLog += String(chunk);
  });
  next.stderr?.on("data", (chunk) => {
    nextLog += String(chunk);
  });
  for (let tries = 0; tries < 180; tries++) {
    if (next.exitCode !== null)
      throw Error(`Next stopped: ${nextLog.slice(-5000)}`);
    if (nextLog.includes("Ready in")) break;
    if (tries === 179)
      throw Error(`Next startup timed out: ${nextLog.slice(-5000)}`);
    await delay(500);
  }
  console.log("Disposable Next server ready; loading real /team/inbox page.");
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    serviceWorkers: "block",
  });
  await context.addCookies([
    {
      name: "myst-team-session",
      value: "fixture-session-token",
      url: siteBase,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return ["127.0.0.1", "localhost"].includes(url.hostname)
      ? route.continue()
      : route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  const response = await page.goto(
    `${siteBase}/team/inbox?threadId=${threadId}&contactId=${otherContactId}&channel=email`,
    { waitUntil: "domcontentloaded", timeout: 90000 },
  );
  assert.equal(response?.status(), 200);
  await expect(
    page.getByRole("heading", { name: "Casey Customer", exact: true }),
  ).toBeVisible();
  const reply = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(reply).toBeVisible();
  await expect(page.locator("#inbox-thread-scroll")).toContainText(
    "Casey SMS message 35",
  );
  await expect(page.locator("#inbox-thread-scroll")).not.toContainText(
    "Taylor SMS",
  );
  await expect(
    page.getByRole("button", { name: "Filters", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  for (const label of [
    "Waiting",
    "Done",
    "Mark contacted",
    "Acknowledge for me",
  ])
    await expect(
      page.getByRole("button", { name: label, exact: true }),
    ).toHaveCount(0);
  await expect(page.getByText(/new leads ready/i)).toHaveCount(0);
  assert.equal(apiCalls.filter((c) => c.path.includes("new-leads")).length, 0);
  assert.equal(
    apiCalls.filter((c) =>
      [
        "/api/admin/contacts",
        "/api/admin/team/directory",
        "/api/appointments",
        "/api/quotes",
        "/api/admin/crm/tasks",
      ].includes(c.path),
    ).length,
    0,
    "Optional customer reads do not delay opening messages",
  );
  console.log("Direct thread identity and lazy optional reads verified.");

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(reply).toBeInViewport();
    await expect(
      page.getByRole("button", { name: "Send", exact: true }),
    ).toBeInViewport();
    assert.ok(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <= innerWidth + 1 &&
          document.documentElement.scrollHeight <= innerHeight + 1,
      ),
      `Inbox fits ${width}px viewport`,
    );
    assert.ok(
      await page
        .locator("#inbox-thread-scroll")
        .evaluate((el) => el.scrollHeight > el.clientHeight),
      "Messages independently scroll",
    );
    if (width === 1440) {
      await expect
        .poll(() =>
          page.locator("#inbox-thread-scroll").evaluate((el) => el.scrollTop),
        )
        .toBeGreaterThan(0);
      const before = await page
        .locator("#inbox-thread-scroll")
        .evaluate((el) => el.scrollTop);
      await page
        .locator("[data-inbox-list-scroll]")
        .evaluate((el) => (el.scrollTop = 400));
      assert.ok(
        await page
          .locator("[data-inbox-list-scroll]")
          .evaluate((el) => el.scrollTop > 0),
      );
      assert.equal(
        await page
          .locator("#inbox-thread-scroll")
          .evaluate((el) => el.scrollTop),
        before,
      );
      await page
        .locator("[data-inbox-list-scroll]")
        .evaluate((el) => (el.scrollTop = 0));
    }
    await page.addStyleTag({
      content: "nextjs-portal { display: none !important; }",
    });
    await page.screenshot({
      path: join(artifact, `inbox-${width}.png`),
      fullPage: false,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await reply.fill("Casey's unsent furniture reply.");
  await page.locator('input[type="file"][name="attachments"]').setInputFiles({
    name: "fixture-photo.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvSAAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(page.getByRole("list", { name: "Attachments" })).toContainText(
    "fixture-photo.png",
  );
  await page
    .getByRole("navigation", { name: "Conversation channel" })
    .getByRole("link", { name: "Email", exact: true })
    .click();
  await expect(page.locator("#inbox-thread-scroll")).toContainText(
    "Casey EMAIL message 35",
  );
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 664 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(
      page.getByRole("textbox", { name: "Message", exact: true }),
    ).toBeInViewport();
    await expect(
      page.getByRole("button", { name: "Send", exact: true }),
    ).toBeInViewport();
    await expect(page.getByLabel("Subject", { exact: true })).toBeInViewport();
    const messageBounds = await page
      .locator("#inbox-thread-scroll")
      .boundingBox();
    assert.ok(
      messageBounds && messageBounds.height >= 48,
      "Email thread retains room to read messages on a short phone",
    );
    assert.ok(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <= innerWidth + 1 &&
          document.documentElement.scrollHeight <= innerHeight + 1,
      ),
    );
    await page.addStyleTag({
      content: "nextjs-portal { display: none !important; }",
    });
    await page.screenshot({
      path: join(artifact, `email-${viewport.width}x${viewport.height}.png`),
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("");
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Casey's unsent email reply.");
  await page.goBack();
  await expect(page.locator("#inbox-thread-scroll")).toContainText(
    "Casey SMS message 35",
  );
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("Casey's unsent furniture reply.");
  await expect(page.getByRole("list", { name: "Attachments" })).toContainText(
    "fixture-photo.png",
  );
  await expect(page.getByText(/Reattach these files/)).toHaveCount(0);
  await page.goForward();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("Casey's unsent email reply.");
  await page
    .getByRole("complementary", { name: "Conversations", exact: true })
    .getByText("Taylor Customer", { exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Taylor Customer", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#inbox-thread-scroll")).toContainText(
    "Taylor SMS message 35",
  );
  await expect(
    page.getByText("Do not contact is active for this conversation.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("");
  await page.goBack();
  await expect(
    page.getByText("Do not contact is active for this conversation.", {
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("Casey's unsent email reply.");
  console.log(
    "Customer/channel navigation and Back/Forward preserve separate text and attached files.",
  );

  await page.goto(
    `${siteBase}/team/inbox?threadId=${threadId}&inbox_offset=50&inbox_first_from=2026-08-01`,
    { waitUntil: "domcontentloaded" },
  );
  await expect(
    page.getByRole("button", { name: "Filters (1)", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Filters (1)", exact: true }).click();
  await expect(
    page.getByLabel("First message from", { exact: true }),
  ).toHaveValue("2026-08-01");
  await page.getByLabel("Search conversations", { exact: true }).fill("Casey");
  await page.getByLabel("Last message to", { exact: true }).fill("2026-09-13");
  await page
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("inbox_q"))
    .toBe("Casey");
  assert.equal(
    new URL(page.url()).searchParams.get("inbox_offset"),
    null,
    "Filter apply resets list page",
  );
  assert.equal(
    new URL(page.url()).searchParams.get("inbox_first_from"),
    "2026-08-01",
  );
  assert.equal(
    new URL(page.url()).searchParams.get("inbox_last_to"),
    "2026-09-13",
  );
  await expect(page.locator("#inbox-thread-scroll")).toContainText(
    "Casey SMS message 35",
  );
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("inbox_first_from"))
    .toBe(null);
  assert.equal(new URL(page.url()).searchParams.get("inbox_last_to"), null);
  assert.equal(
    new URL(page.url()).searchParams.get("inbox_q"),
    "Casey",
    "Clearing filters retains the separate customer search",
  );
  console.log(
    "Collapsed filters preserve inputs and reset pagination correctly.",
  );

  handoffDraft = true;
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Keep this SMS draft while preparing email.");
  await page
    .getByRole("button", { name: "Draft a reply", exact: true })
    .click();
  const draftDialog = page.getByRole("dialog", {
    name: "Reply draft",
    exact: true,
  });
  await expect(
    draftDialog.getByText("Prepared email handoff.", { exact: true }),
  ).toBeVisible();
  await draftDialog
    .getByRole("button", { name: "Add to reply", exact: true })
    .click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("threadId"))
    .toBe(emailThreadId);
  assert.equal(new URL(page.url()).searchParams.get("channel"), "email");
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("Casey's unsent email reply.\n\nPrepared email handoff.");
  await expect(page.locator("#inbox-thread-scroll")).toContainText(
    "Casey EMAIL message 35",
  );
  await page.goBack();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("Keep this SMS draft while preparing email.");
  handoffDraft = false;
  console.log(
    "AI channel handoff appends to the correct saved draft and preserves the source draft.",
  );

  await page.goto(`${siteBase}/team/inbox`, { waitUntil: "domcontentloaded" });
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 664 },
  ]) {
    await page.setViewportSize(viewport);
    const filtersButton = page.getByRole("button", {
      name: "Filters",
      exact: true,
    });
    if ((await filtersButton.getAttribute("aria-expanded")) === "false")
      await filtersButton.click();
    await page
      .getByRole("button", { name: "Apply filters", exact: true })
      .scrollIntoViewIfNeeded();
    await expect(
      page.getByRole("button", { name: "Apply filters", exact: true }),
    ).toBeInViewport();
    assert.ok(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <= innerWidth + 1 &&
          document.documentElement.scrollHeight <= innerHeight + 1,
      ),
    );
    await page.addStyleTag({
      content: "nextjs-portal { display: none !important; }",
    });
    await page.screenshot({
      path: join(artifact, `filters-${viewport.width}x${viewport.height}.png`),
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${siteBase}/team/inbox?threadId=${errorThreadId}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(
    page.getByText("Messages could not be loaded", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("No messages yet.", { exact: true })).toHaveCount(
    0,
  );
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Keep this reply through message retry.");
  failMessages = false;
  await page
    .getByRole("button", { name: "Retry messages", exact: true })
    .click();
  await expect(page.locator("#inbox-thread-scroll")).toContainText(
    "Recovered SMS message 35",
  );
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("Keep this reply through message retry.");
  await page.goto(`${siteBase}/team/inbox?threadId=${emptyThreadId}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(
    page.getByText("No messages yet.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry messages", exact: true }),
  ).toHaveCount(0);
  console.log(
    "Failed pages and verified empty pages are distinct; retry keeps drafts.",
  );

  stallAutomation = true;
  await page.goto(`${siteBase}/team/inbox?threadId=${threadId}`, {
    waitUntil: "domcontentloaded",
  });
  await page
    .getByRole("button", { name: "Customer details", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Customer details", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Loading customer details…", { exact: true }),
  ).toBeVisible();
  await expect.poll(() => stalled.size, { timeout: 30000 }).toBeGreaterThan(0);
  await expect
    .poll(() => stalledAutomation.size, { timeout: 15000 })
    .toBeGreaterThan(0);
  await page
    .getByRole("button", { name: "Close Customer details", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Still usable while details are loading.");
  await expect(page.locator("#inbox-thread-scroll")).toContainText(
    "Casey SMS message 35",
  );
  assert.ok(stalled.size > 0, "Optional API read really is stalled");
  assert.ok(
    stalledAutomation.size > 0,
    "Background automation lookup really is stalled",
  );
  console.log(
    "Stalled optional customer details do not block the conversation.",
  );
  assert.deepEqual(unexpected, []);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(
    consoleErrors,
    [],
    "No hydration, duplicate-key or browser request errors",
  );
  console.log(
    JSON.stringify({
      ok: true,
      viewports: ["1440x900", "390x900", "320x900", "390x664", "320x568"],
      externalWrites: 0,
      apiRequests: apiCalls.length,
      artifacts: artifact,
    }),
  );
} catch (error) {
  const failed = browser?.contexts()[0]?.pages()[0];
  if (failed && !failed.isClosed()) {
    await failed
      .screenshot({ path: join(artifact, "failure.png") })
      .catch(() => undefined);
    await writeFile(
      join(artifact, "failure.html"),
      await failed.content(),
    ).catch(() => undefined);
  }
  console.error("Browser errors:", pageErrors);
  console.error(nextLog.slice(-12000));
  throw error;
} finally {
  await writeFile(join(artifact, "next.log"), nextLog).catch(() => undefined);
  await writeFile(
    join(artifact, "mock-api-requests.json"),
    JSON.stringify({ apiCalls, unexpected }, null, 2),
  ).catch(() => undefined);
  await writeFile(
    join(artifact, "browser-errors.json"),
    JSON.stringify({ pageErrors, consoleErrors }, null, 2),
  ).catch(() => undefined);
  await browser?.close();
  if (next && next.exitCode === null) {
    next.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => next!.once("exit", () => resolve())),
      delay(3000),
    ]);
    if (next.exitCode === null) next.kill("SIGKILL");
  }
  for (const response of [...stalled, ...stalledAutomation]) response.destroy();
  api.closeAllConnections();
  await new Promise<void>((resolve) => api.close(() => resolve()));
  await rm(fixture, { recursive: true, force: true });
}
