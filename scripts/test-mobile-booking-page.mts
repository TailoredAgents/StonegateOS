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

const repo = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/u, "");
const siteRequire = createRequire(`${repo}/apps/site/package.json`);
const artifact = join(repo, "artifacts/mobile-booking-page");
const fixture = await mkdtemp(join(tmpdir(), "stonegate-mobile-page-"));
const fixtureSite = join(fixture, "apps/site");
const employeeId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const contactId = "33333333-3333-4333-8333-333333333333";
const secondCrewId = "66666666-6666-4666-8666-666666666666";
let noteVersion: string | null = null;
const completedId = "44444444-4444-4444-8444-444444444444";
const threadId = "55555555-5555-4555-8555-555555555555";
const date = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const version = new Date().toISOString();
const permissions = [
  "appointments.read",
  "appointments.update",
  "appointment_media.capture",
  "appointment_media.manage",
  "payments.read",
  "payments.collect",
  "messages.read",
  "messages.send",
];
const member = {
  id: employeeId,
  name: "Fixture Crew",
  email: "fixture@example.invalid",
  roleSlug: "crew",
  passwordSet: true,
  permissions,
};
const contact = {
  id: contactId,
  name: "Jordan Fixture",
  firstName: "Jordan",
  lastName: "Fixture",
  email: null,
  phone: "+12025550123",
  phoneE164: "+12025550123",
  source: null,
};
const payment = {
  jobTotalCents: 35000,
  paidTowardJobCents: 0,
  tipCents: 0,
  refundedCents: 0,
  balanceCents: 35000,
  status: "unpaid",
  activeAttemptId: null,
  latestReceiptUrl: null,
};
const media = {
  readyCount: 0,
  pendingCount: 0,
  coverMediaId: null,
  needsScope: false,
};
const jobs: any[] = [
  {
    id: `db:${jobId}`,
    appointmentId: jobId,
    title: contact.name,
    contactId,
    contactName: contact.name,
    source: "db",
    start: `${date}T13:00:00.000Z`,
    end: `${date}T14:00:00.000Z`,
    appointmentType: "job",
    address: "123 Oak Street, Atlanta, GA 30301",
    status: "confirmed",
    version,
    serviceCategoryLabel: "Demo",
    bookingDetails: { serviceType: "demolition" },
    partnerAffiliation: {
      basis: "partner_booking",
      accountId: "account-fixture",
      bookingId: "booking-fixture",
      displayName: "Oak Property Management",
    },
    quotedScopeText:
      "Remove the old deck. Keep the blue cabinet. Use the rear gate.",
    quotedTotalCents: 35000,
    finalTotalCents: 35000,
    paymentSummary: { ...payment },
    mediaSummary: { ...media },
    paymentLedgerAvailable: true,
    crewMembers: [{ memberId: employeeId }],
    notes: [],
  },
  {
    id: `db:${completedId}`,
    appointmentId: completedId,
    title: "Finished Fixture",
    contactId,
    contactName: "Finished Fixture",
    source: "db",
    start: `${date}T11:00:00.000Z`,
    end: `${date}T12:00:00.000Z`,
    appointmentType: "job",
    address: "456 Pine Street, Atlanta, GA 30301",
    status: "completed",
    version,
    serviceCategoryLabel: "Moving",
    bookingDetails: { serviceType: "moving" },
    partnerAffiliation: null,
    quotedScopeText: "Move the labeled boxes.",
    quotedTotalCents: 50000,
    finalTotalCents: 50000,
    paymentSummary: {
      ...payment,
      jobTotalCents: 50000,
      paidTowardJobCents: 50000,
      balanceCents: 0,
      status: "paid",
    },
    mediaSummary: { ...media },
    crewMembers: [
      { memberId: employeeId, hourlyRateCents: 2500, workedMinutes: 120 },
    ],
    notes: [],
  },
];
const thread = {
  id: threadId,
  status: "open",
  channel: "sms",
  subject: "Fixture conversation",
  lastMessageAt: null,
  lastMessagePreview: null,
  contact,
  property: null,
};
const apiCalls: Array<{ method: string; path: string; body: unknown }> = [];
const unexpected: Array<string> = [];
const workflowIssues: string[] = [];
const mutationCalls: Array<{
  method: string;
  path: string;
  body: any;
  key: string | undefined;
}> = [];
const api = createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  const method = req.method ?? "GET";
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : null;
  apiCalls.push({ method, path, body });
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
  if (method === "GET" && path === "/api/admin/calendar/feed")
    return send({ ok: true, appointments: jobs, externalEvents: [] });
  if (method === "GET" && path === "/api/admin/team/directory")
    return send({
      members: [
        { id: employeeId, name: member.name, active: true },
        { id: secondCrewId, name: "Fixture Helper", active: true },
      ],
    });
  if (method === "GET" && /^\/api\/appointments\/[^/]+\/media$/u.test(path))
    return send({
      items: [],
      mediaSummary: media,
      quotedScopeText:
        jobs.find((j) => path.includes(j.appointmentId))?.quotedScopeText ??
        null,
    });
  if (method === "GET" && /^\/api\/appointments\/[^/]+\/payments$/u.test(path))
    return send({
      payments: [],
      paymentSummary:
        jobs.find((j) => path.includes(j.appointmentId))?.paymentSummary ??
        payment,
      version,
    });
  if (method === "GET" && path === "/api/appointments")
    return send({
      appointments: jobs.map((j) => ({ ...j, id: j.appointmentId, contact })),
    });
  if (method === "GET" && path === "/api/admin/inbox/threads")
    return send({ threads: [thread] });
  if (method === "GET" && path === `/api/admin/inbox/threads/${threadId}`)
    return send({ thread, messages: [] });
  if (method === "GET" && path === "/api/admin/contacts")
    return send({ contacts: [contact] });
  if (
    method === "POST" &&
    [
      "/api/mobile/offline-media-queue-health",
      "/api/admin/expenses/queue-health",
    ].includes(path)
  )
    return send({ ok: true });
  if (method === "POST" && path === `/api/appointments/${jobId}/notes`) {
    mutationCalls.push({
      method,
      path,
      body,
      key: req.headers["idempotency-key"] as string | undefined,
    });
    const id = "77777777-7777-4777-8777-777777777777";
    noteVersion = new Date(Date.now() + 500).toISOString();
    jobs[0].version = noteVersion;
    jobs[0].notes.push({ id, body: body.body, createdAt: noteVersion });
    return send({
      ok: true,
      data: { note: { id, appointmentId: jobId }, version: noteVersion },
      receipt: {
        operationId: "fixture-note",
        correlationId: "fixture-note-correlation",
        actorId: employeeId,
        committedAt: noteVersion,
        entityType: "appointment_note",
        entityId: id,
        version: noteVersion,
      },
    });
  }
  if (method === "POST" && path === `/api/appointments/${jobId}/status`) {
    mutationCalls.push({
      method,
      path,
      body,
      key: req.headers["idempotency-key"] as string | undefined,
    });
    assert.equal(body.status, "completed");
    assert.equal(body.sendReviewRequest, false);
    assert.equal(body.sendCustomerNotification, false);
    const nextVersion = new Date(Date.now() + 1000).toISOString();
    jobs[0].status = "completed";
    jobs[0].version = nextVersion;
    jobs[0].finalTotalCents = body.finalTotalCents;
    jobs[0].paymentSummary.jobTotalCents = body.finalTotalCents;
    jobs[0].paymentSummary.balanceCents = body.finalTotalCents;
    return send({
      ok: true,
      data: {
        appointmentId: jobId,
        status: "completed",
        version: nextVersion,
        calendarSync: "not_required",
        customerNotification: "not_requested",
        reviewRequest: "not_requested",
      },
      receipt: {
        operationId: "fixture-operation",
        correlationId: "fixture-correlation",
        actorId: employeeId,
        committedAt: new Date().toISOString(),
        entityType: "appointment",
        entityId: jobId,
        version: nextVersion,
      },
    });
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
        MOBILE_BOOKING_CARDS_V2_ENABLED: "true",
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
  console.log("Disposable Next server ready; loading real /mobile page.");
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
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
  const response = await page.goto(`${siteBase}/mobile`, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  assert.equal(response?.status(), 200);
  await expect(
    page.getByRole("heading", { name: "Today", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Partner · Oak Property Management", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Demo", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Schedule", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Messages", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Finished (1)", { exact: true })).toBeVisible();
  await page.screenshot({
    caret: "initial",
    path: join(artifact, "today-390.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Open job", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText(jobs[0].quotedScopeText, { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText("Take photo", { exact: true })).toBeVisible();
  await expect(dialog.locator('input[capture="environment"]')).toHaveCount(1);
  assert.ok(page.url().includes(`jobId=${jobId}`));
  await dialog.getByRole("button", { name: "Finish job", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Change crew", exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Change total", exact: true })
    .click();
  await dialog.getByLabel("Final job total", { exact: true }).fill("375");
  await dialog
    .getByRole("button", { name: "Change crew", exact: true })
    .click();
  await dialog.getByRole("checkbox", { name: "Fixture Crew" }).uncheck();
  await dialog.getByRole("checkbox", { name: "Fixture Helper" }).check();
  await dialog.getByRole("button", { name: "Done changing crew" }).click();
  await dialog.locator("[data-mobile-note] > summary").click();
  await dialog
    .getByLabel("Job note")
    .fill("Gate access confirmed; blue cabinet stays.");
  await dialog.getByRole("button", { name: "Save note", exact: true }).click();
  await expect.poll(() => noteVersion).not.toBeNull();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("dialog")
    .locator("[data-mobile-completion] > summary")
    .evaluate((summary: HTMLElement) => {
      (summary.parentElement as HTMLDetailsElement).open = true;
    });
  await expect(
    page.getByRole("dialog").getByLabel("Final job total", { exact: true }),
  ).toHaveValue("375");
  await expect(
    page.getByRole("dialog").locator('[name="crewMemberId"]'),
  ).toHaveValue(secondCrewId);

  await dialog
    .getByRole("button", { name: "Back to jobs", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await page
    .getByRole("button", { name: "Open job", exact: true })
    .first()
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Finish job", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByLabel("Final job total", { exact: true }),
  ).toHaveValue("375");
  await page.setViewportSize({ width: 320, height: 800 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.screenshot({
    caret: "initial",
    path: join(artifact, "completion-320.png"),
    fullPage: false,
  });
  await page
    .getByRole("dialog")
    .locator('[data-mobile-completion-form] button[type="submit"]')
    .click();
  try {
    await expect(
      page.getByRole("dialog").getByText("Completed", { exact: true }),
    ).toBeVisible({ timeout: 3000 });
  } catch {
    workflowIssues.push(
      "The job view did not remain open with completed status after the confirmed save",
    );
    await page.screenshot({
      caret: "initial",
      path: join(artifact, "completion-result.png"),
    });
    console.log("Completion result URL:", page.url());
  }
  const completions = mutationCalls.filter((call) =>
    call.path.endsWith("/status"),
  );
  assert.equal(completions.length, 1);
  assert.equal(completions[0]!.body.finalTotalCents, 37500);
  assert.equal(completions[0]!.body.expectedVersion, noteVersion);
  assert.deepEqual(completions[0]!.body.crewMembers, [
    { memberId: secondCrewId, splitBps: 1 },
  ]);
  if (await page.getByRole("dialog").count()) {
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Back to jobs", exact: true })
      .click();
  }
  try {
    await expect(page.getByText("Finished (2)", { exact: true })).toBeVisible({
      timeout: 3000,
    });
  } catch {
    workflowIssues.push(
      "After closing the completed job, the list did not regroup it under Finished",
    );
    console.log("Closed job URL:", page.url());
    await page.screenshot({
      caret: "initial",
      path: join(artifact, "closed-completion-result.png"),
    });
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByText("Finished (2)", { exact: true })).toBeVisible();
  }
  await page.getByText("Finished (2)", { exact: true }).click();
  await page
    .locator(`article[data-appointment-id="${jobId}"]`)
    .getByRole("button", { name: "Open job", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Message", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "Back to job", exact: true }),
  ).toBeVisible();
  assert.ok(page.url().includes("threadId="));
  await page.getByRole("link", { name: "Back to job", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Back to jobs", exact: true })
    .click();
  await page.getByRole("link", { name: "Schedule", exact: true }).click();
  await expect(page).toHaveURL(/screen=calendar/u);
  await expect(
    page.getByRole("button", { name: "Open job", exact: true }).first(),
  ).toBeVisible();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.screenshot({
    caret: "initial",
    path: join(artifact, "schedule-320.png"),
    fullPage: true,
  });
  assert.deepEqual(unexpected, []);
  assert.deepEqual(workflowIssues, []);
  assert.deepEqual(pageErrors, []);
  assert.equal(
    consoleErrors.some((error) => /hydrat/iu.test(error)),
    false,
    "No hydration warnings; screenshots must not mutate input styles during hydration",
  );
  console.log(
    JSON.stringify({
      ok: true,
      viewports: [390, 320],
      actualCompletionWrites: mutationCalls.filter((call) =>
        call.path.endsWith("/status"),
      ).length,
      actualNoteWrites: mutationCalls.filter((call) =>
        call.path.endsWith("/notes"),
      ).length,
      externalWrites: 0,
      apiRequests: apiCalls.length,
      consoleErrors,
      artifacts: artifact,
    }),
  );
} catch (error) {
  const failedPage = browser?.contexts()[0]?.pages()[0];
  if (failedPage && !failedPage.isClosed()) {
    await failedPage
      .screenshot({ caret: "initial", path: join(artifact, "failure.png") })
      .catch(() => undefined);
    await writeFile(
      join(artifact, "failure.html"),
      await failedPage.content(),
    ).catch(() => undefined);
  }
  console.error("Browser errors:", pageErrors);
  console.error(nextLog.slice(-12000));
  throw error;
} finally {
  await writeFile(join(artifact, "next.log"), nextLog).catch(() => undefined);
  await writeFile(
    join(artifact, "browser-errors.json"),
    JSON.stringify({ pageErrors, consoleErrors }, null, 2),
  ).catch(() => undefined);
  await writeFile(
    join(artifact, "mock-api-requests.json"),
    JSON.stringify({ apiCalls, unexpected, mutationCalls }, null, 2),
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
  await new Promise<void>((resolve) => api.close(() => resolve()));
  await rm(fixture, { recursive: true, force: true });
}
