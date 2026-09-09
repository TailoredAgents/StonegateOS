import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repo = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const { chromium, webkit } = require("@playwright/test");
const base = "https://localhost:3112";
const password = "Local relationship browser passphrase 2026!";
function fixture(input: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [
        require.resolve("tsx/cli"),
        `${repo}apps/api/scripts/partner-access-browser-fixture.ts`,
      ],
      {
        cwd: `${repo}apps/api`,
        timeout: 30_000,
        maxBuffer: 256_000,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          NODE_ENV: "test",
          DOTENV_CONFIG_PATH: "/dev/null",
          DATABASE_URL:
            "postgresql://portal_test:portal_local_only@127.0.0.1:55443/portal_access_browser",
          DATABASE_SSL: "false",
        },
      },
      (error, stdout) => {
        if (error) {
          reject(
            new Error(
              `Local fixture ${input.action} failed (fixture output omitted to protect local credentials and tokens).`,
            ),
          );
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(Error("Local fixture returned invalid JSON"));
        }
      },
    );
    child.stdin!.end(JSON.stringify(input));
  });
}
async function company(staffPage: any, email: string, name: string) {
  staffPage.setDefaultTimeout(15_000);
  await staffPage.goto(`${base}/team/partners?p_admin=accounts`);
  await staffPage
    .getByText("Create a company and invite its Administrator", { exact: true })
    .click();
  await staffPage.getByLabel("Company name", { exact: true }).fill(name);
  await staffPage
    .getByLabel("Administrator name", { exact: true })
    .fill("Local invited partner");
  await staffPage
    .getByLabel("Administrator email", { exact: true })
    .fill(email);
  await staffPage
    .getByLabel("Relationship confirmation", { exact: true })
    .fill(
      "Disposable local browser rehearsal only, established synthetic relationship.",
    );
  await staffPage
    .getByRole("button", {
      name: "Create company & invite Administrator",
      exact: true,
    })
    .click();
  const feedback = staffPage.locator(
    'section[aria-labelledby="partner-relationship-setup-heading"] [role="status"], section[aria-labelledby="partner-relationship-setup-heading"] [role="alert"]',
  );
  await feedback.waitFor({ timeout: 30_000 });
  assert.equal(
    await feedback.getAttribute("role"),
    "status",
    await feedback.innerText(),
  );
  return fixture({ action: "invitation", email });
}
async function activate(
  page: any,
  invite: any,
  existing = false,
  rememberMe = false,
) {
  page.setDefaultTimeout(15_000);
  const token = new URL(invite.url).searchParams.get("token")!;
  try {
    await page.goto(invite.url);
  } catch {
    throw Error("Invitation navigation failed (token omitted)");
  }
  assert.equal(
    new URL(page.url()).searchParams.has("token"),
    false,
    "Invitation token is stripped before rendering",
  );
  assert.equal(
    (await page.content()).includes(token),
    false,
    "Raw invitation token is absent from HTML",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Continue to password setup", exact: true })
      .count(),
    1,
    JSON.stringify({
      path: new URL(page.url()).pathname,
      host: new URL(page.url()).host,
      headings: await page.getByRole("heading").allTextContents(),
      alerts: await page.getByRole("alert").allTextContents(),
      cookies: (await page.context().cookies()).map((cookie: any) => ({
        name: cookie.name,
        secure: cookie.secure,
        domain: cookie.domain,
        path: cookie.path,
      })),
    }),
  );
  await page
    .getByRole("button", { name: "Continue to password setup", exact: true })
    .click();
  await page.waitForURL(/\/partners\/activate/u);
  assert.equal(new URL(page.url()).searchParams.has("token"), false);
  assert.equal((await page.content()).includes(token), false);
  const passwordInput = page.getByLabel(
    existing ? "Current password" : "New password",
    { exact: true },
  );
  assert.equal(
    await passwordInput.count(),
    1,
    JSON.stringify({
      stage: "activation-inspection",
      path: new URL(page.url()).pathname,
      headings: await page.getByRole("heading").allTextContents(),
      alerts: await page.getByRole("alert").allTextContents(),
    }),
  );
  await passwordInput.fill(password);
  if (rememberMe)
    await page
      .getByLabel("Keep me signed in for 30 days on this private device", {
        exact: true,
      })
      .check();
  await page
    .getByRole("button", { name: "Finish and sign in", exact: true })
    .click();
  try {
    await page.waitForURL(/\/partners\/overview/u, { timeout: 15_000 });
  } catch {
    throw Error(
      JSON.stringify({
        stage: "activation-submit",
        path: new URL(page.url()).pathname,
        search: new URL(page.url()).searchParams.get("error"),
        alerts: await page.getByRole("alert").allTextContents(),
        headings: await page.getByRole("heading").allTextContents(),
      }),
    );
  }
  const session = (await page.context().cookies()).find(
    (cookie: any) => cookie.name === "myst-partner-session",
  );
  assert.ok(
    session?.secure && session.httpOnly && session.sameSite === "Lax",
    "Activated session has Secure, HttpOnly, SameSite=Lax protection",
  );
  const remaining = session.expires - Date.now() / 1000;
  const expected = rememberMe ? 30 * 86_400 : 12 * 3600;
  assert.ok(
    remaining > expected - 90 && remaining <= expected + 5,
    "Session expiry follows the explicit keep-signed-in choice",
  );
}
async function json(
  page: any,
  path: string,
  init: Record<string, unknown> = {},
) {
  return page.evaluate(
    async ({ path, init }: any) => {
      const response = await fetch(path, init);
      return {
        status: response.status,
        body: await response.json().catch(() => null),
      };
    },
    { path: `/api/partners/portal/${path}`, init },
  );
}
async function switchAccount(page: any, accountId: string) {
  await page
    .getByRole("combobox", { name: "Working account" })
    .selectOption(accountId);
  const [response] = await Promise.all([
    page.waitForResponse(
      (response: any) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname ===
          "/api/partners/portal/session/account",
    ),
    page.waitForNavigation({ waitUntil: "networkidle" }),
    page.getByRole("button", { name: "Switch workspace", exact: true }).click(),
  ]);
  assert.equal(response.status(), 200, "Explicit account switching succeeds");
}
async function login(page: any, email: string, credential = password) {
  page.setDefaultTimeout(15_000);
  await page.goto(`${base}/partners/login`);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.locator('input[name="password"]').fill(credential);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/partners\/overview/u, { timeout: 30_000 });
}
async function inviteCoworker(
  page: any,
  email: string,
  role: string,
  scoped = false,
) {
  await page.goto(`${base}/partners/settings/team`);
  const form = page
    .locator("form")
    .filter({ has: page.getByLabel("Work email", { exact: true }) });
  await form.getByLabel("Full name", { exact: true }).fill(`Local ${role}`);
  await form.getByLabel("Work email", { exact: true }).fill(email);
  assert.equal(
    await form
      .getByRole("combobox", { name: "Role", exact: true })
      .inputValue(),
    "",
    "Invitations require an explicit role choice",
  );
  await form
    .getByRole("combobox", { name: "Role", exact: true })
    .selectOption(role);
  if (scoped) {
    await form
      .getByLabel("Limit this person to selected locations or cost centers", {
        exact: true,
      })
      .check();
    await form
      .getByLabel("Location: Allowed local site", { exact: true })
      .check();
  }
  const [response] = await Promise.all([
    page.waitForResponse(
      (response: any) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/partners/portal/invitations",
    ),
    form.getByRole("button", { name: "Send invitation", exact: true }).click(),
  ]);
  assert.equal(
    response.status(),
    202,
    "Company administrator can invite the selected role",
  );
  return fixture({ action: "invitation", email });
}
async function invitationAction(
  page: any,
  email: string,
  action: "Resend" | "Revoke",
) {
  await page.goto(`${base}/partners/settings/team`);
  const card = page
    .getByRole("article")
    .filter({ has: page.locator("h4") })
    .filter({ hasText: email });
  const [response] = await Promise.all([
    page.waitForResponse(
      (response: any) =>
        response.request().method() === "POST" &&
        /\/invitations\/[0-9a-f-]{36}$/u.test(new URL(response.url()).pathname),
    ),
    card.getByRole("button", { name: action, exact: true }).click(),
  ]);
  assert.equal(response.status(), action === "Resend" ? 202 : 200);
}
async function checkRejectedInvitation(browser: any, invite: any) {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    try {
      await page.goto(invite.url);
    } catch {
      throw Error("Old invitation navigation failed (token omitted)");
    }
    await page
      .getByRole("button", { name: "Continue to password setup", exact: true })
      .click();
    const alert = page
      .getByRole("alert")
      .filter({ hasText: /expired|already used|canceled/iu });
    await alert.waitFor();
    assert.match(await alert.innerText(), /expired|already used|canceled/iu);
    assert.equal((await json(page, "me")).status, 401);
  } finally {
    await context.close();
  }
}
async function accessMatrix(
  browser: any,
  admin: any,
  first: any,
  locations: any[],
  id: string,
) {
  await switchAccount(admin, first.accountId);
  const roster = await json(admin, "members?status=all&limit=100");
  const self = roster.body.members.find((member: any) => member.currentUser);
  for (const body of [
    { action: "suspend" },
    { action: "role_update", roleKey: "viewer" },
  ]) {
    const attempt = await json(admin, `members/${self.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "If-Match": self.etag,
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify(body),
    });
    assert.equal(
      attempt.status,
      409,
      "The final active company Administrator cannot be suspended or demoted",
    );
  }
  let operationsPage: any;
  for (const role of ["operations", "billing_approver", "viewer"]) {
    const email = `${role}-${id}@example.test`;
    let invitation = await inviteCoworker(
      admin,
      email,
      role,
      role === "operations",
    );
    if (role === "operations") {
      const expired = invitation;
      await fixture({
        action: "expire",
        invitationId: invitation.id,
        accountId: invitation.accountId,
      });
      await checkRejectedInvitation(browser, expired);
      await invitationAction(admin, email, "Resend");
      invitation = await fixture({ action: "invitation", email });
      assert.equal(invitation.generation, expired.generation + 1);
      await checkRejectedInvitation(browser, expired);
    }
    const context = await browser.newContext({
      viewport: { width: 375, height: 900 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await activate(page, invitation);
    const me = await json(page, "me");
    assert.equal(me.status, 200);
    assert.equal(me.body.account.id, first.accountId);
    const billing = await json(page, "invoices");
    assert.equal(
      billing.status,
      role === "billing_approver" ? 200 : 403,
      `${role} billing boundary`,
    );
    assert.equal(
      (await json(page, "members")).status,
      403,
      `${role} cannot administer the company`,
    );
    if (role === "operations") {
      operationsPage = page;
      assert.equal(
        (await json(page, `locations/${locations[0].id}`)).status,
        200,
      );
      assert.equal(
        (await json(page, `locations/${locations[1].id}`)).status,
        404,
        "Restricted location substitution is opaque",
      );
    } else {
      const create = await json(page, "booking-drafts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify({ serviceKey: "service_request" }),
      });
      assert.equal(create.status, 403, `${role} cannot schedule by direct API`);
    }
    await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
    const issues = await page.evaluate(async () =>
      (
        await (window as any).axe.run(document, {
          runOnly: {
            type: "tag",
            values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
          },
        })
      ).violations.map((item: any) => ({
        id: item.id,
        targets: item.nodes.map((node: any) => node.target),
      })),
    );
    assert.deepEqual(issues, [], `${role} mobile job home accessibility`);
  }
  await admin.goto(`${base}/partners/settings/team`);
  const operations = admin.getByRole("article").filter({
    has: admin.getByRole("heading", {
      name: "Local operations",
      exact: true,
      level: 2,
    }),
  });
  await operations
    .getByRole("button", { name: "Suspend access", exact: true })
    .click();
  await operations
    .getByRole("button", { name: "Confirm suspension", exact: true })
    .click();
  await operations
    .getByText("Portal access suspended for this account.", { exact: true })
    .waitFor();
  assert.equal(
    (await json(operationsPage, "me")).status,
    403,
    "An already open session loses suspended account access immediately",
  );
  assert.equal((await json(admin, "me")).status, 200);
}

async function revokedHandoff(browser: any, admin: any, id: string) {
  const email = `revoked-${id}@example.test`;
  const invitation = await inviteCoworker(admin, email, "viewer");
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  try {
    try {
      await page.goto(invitation.url);
    } catch {
      throw Error("Invitation handoff navigation failed (token omitted)");
    }
    await page
      .getByRole("button", { name: "Continue to password setup", exact: true })
      .click();
    await page.waitForURL(/\/partners\/activate/u);
    await page.getByLabel("New password", { exact: true }).waitFor();
    await invitationAction(admin, email, "Revoke");
    await page.getByLabel("New password", { exact: true }).fill(password);
    const [rejected] = await Promise.all([
      page.waitForResponse(
        (response: any) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname ===
            "/api/partners/onboarding/activation/complete",
      ),
      page
        .getByRole("button", { name: "Finish and sign in", exact: true })
        .click(),
    ]);
    assert.equal(rejected.status(), 401);
    await page
      .locator('[role="alert"]:not(#__next-route-announcer__)')
      .waitFor();
    assert.equal(
      (await json(page, "me")).status,
      401,
      "Revoking an invitation also invalidates its already-open password handoff",
    );
    await checkRejectedInvitation(browser, invitation);
  } finally {
    await context.close();
  }
}

async function resetAndOldLinks(
  browser: any,
  email: string,
  signedInPages: any[],
) {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 375, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const replacement = "Replacement local browser passphrase 2026!";
  try {
    await page.goto(`${base}/partners/forgot-password`);
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page
      .getByRole("button", { name: "Email me a reset link", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Check your email", exact: true })
      .waitFor();
    const reset = await fixture({ action: "reset", email });
    assert.ok(new Date(reset.expiresAt).getTime() > Date.now() + 29 * 60_000);
    assert.ok(new Date(reset.expiresAt).getTime() < Date.now() + 31 * 60_000);
    const token = new URL(reset.url).searchParams.get("token")!;
    try {
      await page.goto(reset.url);
    } catch {
      throw Error("Reset navigation failed (token omitted)");
    }
    assert.equal(new URL(page.url()).searchParams.has("token"), false);
    assert.equal((await page.content()).includes(token), false);
    await page.getByLabel("New password", { exact: true }).fill(replacement);
    await page
      .getByLabel("Confirm new password", { exact: true })
      .fill(replacement);
    await page
      .getByRole("button", { name: "Reset password", exact: true })
      .click();
    await page.waitForURL(/\/partners\/login\?reset=1/u);
    assert.equal(
      (await json(page, "me")).status,
      401,
      "Password reset does not automatically sign in",
    );
    for (const signedIn of signedInPages)
      assert.equal(
        (await json(signedIn, "me")).status,
        401,
        "Reset revokes pre-existing sessions",
      );
    try {
      await page.goto(reset.url);
    } catch {
      throw Error("Reset replay navigation failed (token omitted)");
    }
    await page.getByLabel("New password", { exact: true }).fill(replacement);
    await page
      .getByLabel("Confirm new password", { exact: true })
      .fill(replacement);
    await page
      .getByRole("button", { name: "Reset password", exact: true })
      .click();
    await page
      .getByRole("alert")
      .filter({ hasText: /expired|used|invalid|no longer/iu })
      .waitFor();
    assert.equal((await json(page, "me")).status, 401);
    await login(page, email, replacement);
    assert.equal(
      (await json(page, "me")).status,
      200,
      "Native password login accepts the replacement password",
    );
  } finally {
    await context.close();
  }
  const legacy = await browser.newContext();
  const legacyPage = await legacy.newPage();
  try {
    for (const path of [
      "/partners/request-access",
      "/partners/application",
      "/partners/login/mfa",
      "/partners/verify?token=legacy-invalid",
      "/partners/request-access?email=private%40example.test",
    ]) {
      await legacyPage.goto(`${base}${path}`);
      assert.equal(
        (await legacyPage
          .getByRole("link", {
            name: "sales@stonegatejunkremoval.com",
            exact: true,
          })
          .count()) > 0,
        true,
        `${path.split("?")[0]} retains Sales email assistance`,
      );
      assert.equal(
        await legacyPage
          .locator('input[name="code"], input[autocomplete="one-time-code"]')
          .count(),
        0,
        "Old links never demand MFA",
      );
      assert.equal(
        await legacyPage
          .locator('form[action*="application"], form[action*="company-join"]')
          .count(),
        0,
        "Old links do not restore self-service company creation",
      );
    }
  } finally {
    await legacy.close();
  }
}

async function membershipIsolation(
  browser: any,
  admin: any,
  first: any,
  second: any,
  email: string,
  id: string,
) {
  const invitation = await inviteCoworker(
    admin,
    `backup-${id}@example.test`,
    "administrator",
  );
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const backup = await context.newPage();
  try {
    await activate(backup, invitation);
    const roster = await json(backup, "members?status=all&limit=100");
    const original = roster.body.members.find(
      (member: any) => member.user.email === email,
    );
    assert.ok(original, "Backup Administrator sees the account member");
    const removed = await json(backup, `members/${original.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "If-Match": original.etag,
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify({ action: "suspend" }),
    });
    assert.equal(
      removed.status,
      200,
      "A second Administrator can suspend one account membership",
    );
    assert.equal((await json(admin, "me")).status, 403);
    const staleCreate = await json(admin, "booking-drafts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify({
        serviceKey: "service_request",
        description:
          "This stale company request must never be created in the other company.",
      }),
    });
    assert.equal(
      staleCreate.status,
      403,
      "A stale company page cannot silently create work under another eligible company",
    );
    const recovery = await admin.context().newPage();
    try {
      await recovery.goto(`${base}/partners/overview`);
      await recovery.waitForURL(/\/partners\/login/u);
      await recovery.getByLabel("Email", { exact: true }).waitFor();
      assert.equal(
        await recovery
          .getByRole("button", { name: "Sign in", exact: true })
          .count(),
        1,
        "A refreshed suspended workspace provides visible password sign-in recovery",
      );
    } finally {
      await recovery.close();
    }
    await switchAccount(admin, second.accountId);
    assert.equal(
      (await json(admin, "me")).body.account.id,
      second.accountId,
      "The same identity retains its other approved company",
    );
    const state = await fixture({ action: "snapshot", email });
    assert.equal(state.users[0].status, "active");
    assert.equal(
      state.memberships.find(
        (member: any) => member.accountId === first.accountId,
      ).status,
      "suspended",
    );
    assert.equal(
      state.memberships.find(
        (member: any) => member.accountId === second.accountId,
      ).status,
      "active",
    );
  } finally {
    await context.close();
  }
}

async function zoomReflow(browser: any, signedInPage: any) {
  const cookies = await signedInPage.context().cookies();
  for (const scale of [2, 4]) {
    // Matching a 1280px browser at 200%/400% zoom: CSS viewport shrinks while
    // physical pixel density increases. This is reflow emulation, not a claim
    // of manual browser/OS zoom or assistive-technology certification.
    const context = await browser.newContext({
      viewport: { width: 1280 / scale, height: 960 / scale },
      deviceScaleFactor: scale,
      reducedMotion: "reduce",
    });
    await context.addCookies(cookies);
    const page = await context.newPage();
    try {
      await page.goto(`${base}/partners/overview`);
      await page
        .getByRole("heading", { name: "Home", exact: true, level: 1 })
        .waitFor();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        true,
        `${scale * 100}% zoom-equivalent job home has no overflow`,
      );
      await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
      const issues = await page.evaluate(async () =>
        (
          await (window as any).axe.run(document, {
            runOnly: {
              type: "tag",
              values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
            },
          })
        ).violations.map((item: any) => ({
          id: item.id,
          targets: item.nodes.map((node: any) => ({
            target: node.target,
            html: node.html,
            summary: node.failureSummary,
          })),
        })),
      );
      if (issues.length)
        await page.screenshot({
          path: `/tmp/stonegate-access-reflow-${scale}.png`,
          fullPage: true,
        });
      assert.deepEqual(
        issues,
        [],
        `${scale * 100}% zoom-equivalent job home accessibility`,
      );
    } finally {
      await context.close();
    }
  }
}

for (const engine of [chromium, webkit]) {
  test(
    `${engine.name()}: real staff invitation, native activation, existing identity and account isolation`,
    { timeout: 360_000 },
    async () => {
      const staff = await fixture({ action: "staff" });
      const browser = await engine.launch();
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async (options: Record<string, unknown> = {}) => {
        const context = await newContext({
          ignoreHTTPSErrors: true,
          ...options,
        });
        context.setDefaultTimeout(15_000);
        return context;
      };
      const staffContext = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      });
      await staffContext.addCookies([
        {
          name: "myst-team-session",
          value: staff.sessionToken,
          url: base,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
      const staffPage = await staffContext.newPage();
      const id = randomUUID(),
        email = `access-${id}@example.test`;
      try {
        const first = await company(
          staffPage,
          email,
          `Local access first ${id}`,
        );
        assert.equal(
          (await fixture({ action: "snapshot", email })).users.length,
          0,
          "Invitation does not precreate an identity",
        );
        assert.ok(
          new Date(first.expiresAt).getTime() > Date.now() + 6 * 86_400_000,
        );
        const nativeContext = await browser.newContext({
          javaScriptEnabled: false,
          viewport: { width: 375, height: 900 },
        });
        const nativePage = await nativeContext.newPage();
        await activate(nativePage, first);
        const activated = await fixture({ action: "snapshot", email });
        assert.equal(activated.users.length, 1);
        assert.equal(activated.users[0].status, "active");
        assert.equal(activated.memberships.length, 1);
        assert.equal(activated.memberships[0].role, "administrator");
        const second = await company(
          staffPage,
          email,
          `Local access second ${id}`,
        );
        const userContext = await browser.newContext({
          viewport: { width: 1440, height: 1000 },
        });
        const page = await userContext.newPage();
        await activate(page, second, true, true);
        const joined = await fixture({ action: "snapshot", email });
        assert.equal(
          joined.users.length,
          1,
          "Company join reuses the global identity",
        );
        assert.equal(joined.memberships.length, 2);
        assert.equal(
          (await json(page, "me")).body.account.id,
          second.accountId,
        );
        const firstLocations = await fixture({
          action: "locations",
          accountId: first.accountId,
        });
        const secondLocations = await fixture({
          action: "locations",
          accountId: second.accountId,
        });
        await switchAccount(page, first.accountId);
        assert.equal((await json(page, "me")).body.account.id, first.accountId);
        assert.equal(
          (await json(page, `locations/${secondLocations[0].id}`)).status,
          404,
        );
        assert.equal(
          (await json(page, `locations/${firstLocations[0].id}`)).status,
          200,
        );
        const draft = await json(page, "booking-drafts", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": randomUUID(),
          },
          body: JSON.stringify({
            serviceKey: "service_request",
            locationId: firstLocations[0].id,
            description:
              "Disposable local draft belonging to the first account only.",
          }),
        });
        assert.equal(draft.status, 201, JSON.stringify(draft.body));
        const draftId = draft.body.draft.id;
        await switchAccount(page, second.accountId);
        assert.equal(
          (await json(page, `booking-drafts/${draftId}`)).status,
          404,
          "A prior-account draft cannot be read after switching",
        );
        const replayContext = await browser.newContext();
        const replay = await replayContext.newPage();
        try {
          await replay.goto(first.url);
        } catch {
          throw Error("Invitation replay navigation failed (token omitted)");
        }
        await replay
          .getByRole("button", {
            name: "Continue to password setup",
            exact: true,
          })
          .click();
        const replayAlert = replay
          .getByRole("alert")
          .filter({ hasText: /expired|already used|canceled/iu });
        await replayAlert.waitFor();
        assert.match(
          await replayAlert.innerText(),
          /expired|already used|canceled/iu,
        );
        assert.equal(
          (await json(replay, "me")).status,
          401,
          "Replayed invitation never creates a session",
        );
        const reLoginContext = await browser.newContext({
          viewport: { width: 320, height: 900 },
          reducedMotion: "reduce",
        });
        const reLogin = await reLoginContext.newPage();
        await login(reLogin, email);
        assert.equal(
          (await json(reLogin, "me")).status,
          200,
          "Joining another company did not replace the password",
        );
        for (const width of [320, 375, 768, 1024, 1440]) {
          await reLogin.setViewportSize({ width, height: 900 });
          assert.equal(
            await reLogin.evaluate(
              () => document.documentElement.scrollWidth <= window.innerWidth,
            ),
            true,
            `${width}px account home has no horizontal overflow`,
          );
        }
        await zoomReflow(browser, reLogin);
        await accessMatrix(browser, page, first, firstLocations, id);
        await revokedHandoff(browser, page, id);
        await membershipIsolation(browser, page, first, second, email, id);
        await resetAndOldLinks(browser, email, [page, reLogin]);
      } finally {
        await browser.close();
      }
    },
  );
}
