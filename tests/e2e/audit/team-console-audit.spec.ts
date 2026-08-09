import { randomUUID } from "node:crypto";
import {
  test,
  expect,
  type Browser,
  type BrowserContext,
  type Locator,
  type TestInfo,
} from "@playwright/test";
import { ensureE2ECommissionPrincipals } from "../support/db";
import {
  monitorTeamSurfaceHealth,
  waitForTeamSurfaceToSettle,
} from "./surface-health";
import { parseOutboundCallbackLocal } from "../../../apps/site/src/app/team/lib/outbound-mutation-result";
import {
  assertNoCurrentCanonicalPayout,
  auditMarker,
  auditOwnerApi,
  cleanupAccessFixture,
  cleanupAuthMatrixFixture,
  cleanupCustomerFixture,
  cleanupPayoutRun,
  closeJourneyFixtures,
  createAuthMatrixFixture,
  createConversationFixture,
  createDayOfServiceFixture,
  createInstantQuoteFixture,
  createMoneyCloseFixture,
  createTeamSessionRecordForMember,
  auditTeamApiAsSession,
  findContactByEmail,
  findExpenseByVendor,
  findOutboundByEmail,
  findPayoutForAppointment,
  findRoleAndMember,
  findRoleBySlug,
  getAccessRevocationSnapshot,
  getAuditActor,
  getAuditEventsSince,
  getAuthMatrixState,
  getContactEffectCounts,
  getContactReminderSnapshot,
  getConversationSnapshot,
  getDayOfServiceSnapshot,
  getInstantQuoteBookingSnapshot,
  getLeadJourneySnapshot,
  getLatestAppointmentForContact,
  getMoneyCloseSnapshot,
  getMutationEvidence,
  getVerifiedTeamSessionSnapshot,
  getPartnerInvite,
  getQuietHoursChannel,
  getSettingValues,
  restoreSetting,
  restoreSettings,
  setSalesDefaultAssignee,
  snapshotAutomationSetting,
  snapshotPolicySetting,
  storageStateForToken,
  type AuditActor,
} from "./journey-fixtures";

const OWNER_STORAGE = "tests/e2e/storage/audit-owner.json";
const DESKTOP_PROJECT = "chromium-1440-light";
const ANONYMOUS_STORAGE_STATE = { cookies: [], origins: [] };

function localDateTimeInput(daysFromNow: number, hour = 11): string {
  const date = new Date(Date.now() + daysFromNow * 24 * 60 * 60_000);
  date.setMinutes(0, 0, 0);
  date.setHours(hour);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function dateInput(daysFromNow = 0): string {
  return localDateTimeInput(daysFromNow).slice(0, 10);
}

function phoneDisplay(phoneDigits: string): string {
  return `(${phoneDigits.slice(0, 3)}) ${phoneDigits.slice(3, 6)}-${phoneDigits.slice(6)}`;
}

async function expectSuccessfulAuditActions(
  since: Date,
  actions: readonly string[],
  actor?: AuditActor,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const events = await getAuditEventsSince(since, actions);
        return actions.map((action) => {
          const event = events.find(
            (candidate) =>
              candidate.action === action &&
              (!actor || candidate.actorId === actor.memberId),
          );
          return {
            action,
            present: Boolean(event),
            outcome: event?.outcome ?? null,
          };
        });
      },
      { timeout: 15_000 },
    )
    .toEqual(
      actions.map((action) => ({
        action,
        present: true,
        outcome: "succeeded",
      })),
    );
}

async function formContaining(
  root: Locator,
  selector: string,
): Promise<Locator> {
  // Responsive list/detail workspaces intentionally render a hidden mobile or
  // desktop counterpart. Always act on the form available to the user at the
  // current viewport, not whichever duplicate appears first in DOM order.
  const form = root
    .locator(`form:has(${selector})`)
    .filter({ visible: true })
    .first();
  await expect(form).toBeVisible();
  return form;
}

async function expectUsdInputCents(
  input: Locator,
  expectedCents: number,
): Promise<void> {
  await expect(input).toHaveAttribute("type", "number");
  await expect(input).toHaveAttribute("step", "0.01");
  const value = await input.inputValue();
  expect(value).toMatch(/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/u);
  expect(Math.round(Number(value) * 100)).toBe(expectedCents);
}

function getProjectBaseURL(testInfo: TestInfo): string {
  const baseURL = testInfo.project.use.baseURL;
  if (typeof baseURL !== "string" || !baseURL) {
    throw new Error("The team audit project must define a baseURL.");
  }
  return baseURL;
}

function getAuditTheme(testInfo: TestInfo): "light" | "dark" {
  const value: unknown = testInfo.project.metadata["auditTheme"];
  return value === "dark" ? "dark" : "light";
}

async function createTeamContext(
  browser: Browser,
  storageState: string,
  testInfo: TestInfo,
): Promise<BrowserContext> {
  const viewport = testInfo.project.use.viewport;
  return browser.newContext({
    storageState,
    baseURL: getProjectBaseURL(testInfo),
    ...(viewport ? { viewport } : {}),
  });
}

const TABS = [
  "expenses",
  "quotes",
  "inbox",
  "chat",
  "pipeline",
  "sales-hq",
  "simulated-chat",
  "outbound",
  "partners",
  "calendar",
  "contacts",
  "owner",
  "policy",
  "commissions",
  "google-ads",
  "web-analytics",
  "seo",
  "automation",
  "access",
  "sales-log",
  "audit",
  "merge",
  "settings",
] as const;

test.beforeEach(async ({ page }, testInfo) => {
  const theme = getAuditTheme(testInfo);
  await page.addInitScript((value) => {
    globalThis.localStorage.setItem("team.theme.v1", value);
  }, theme);
});

test.describe("authentication and authorization gate", () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(
      testInfo.project.name !== DESKTOP_PROJECT,
      "Authentication is theme/viewport independent and runs once.",
    );
  });

  test("anonymous users are redirected to login", async ({ page }) => {
    await page.goto("/team?tab=settings");
    await expect(page).toHaveURL(/\/team\/login/);
  });

  test("a forged legacy owner cookie is rejected", async ({
    page,
  }, testInfo) => {
    await page.context().addCookies([
      {
        name: "myst-admin-session",
        value: "forged-audit-value",
        url: new URL("/", getProjectBaseURL(testInfo)).toString(),
      },
    ]);
    await page.goto("/team?tab=settings");
    await expect(page).toHaveURL(/\/team\/login/);
  });

  test("a forged legacy crew cookie is rejected", async ({
    page,
  }, testInfo) => {
    await page.context().addCookies([
      {
        name: "myst-crew-session",
        value: "forged-audit-value",
        url: new URL("/", getProjectBaseURL(testInfo)).toString(),
      },
    ]);
    await page.goto("/team?tab=calendar");
    await expect(page).toHaveURL(/\/team\/login/);
  });

  test("anonymous instant-quote detail is rejected before customer data loads", async ({
    page,
  }) => {
    await page.goto("/team/instant-quotes/not-a-real-id");
    await expect(page).toHaveURL(/\/team\/login/);
  });

  for (const [role, storage, route, expectedText] of [
    ["office", "tests/e2e/storage/audit-office.json", "/team", "Inbox"],
    ["sales", "tests/e2e/storage/audit-sales.json", "/team", "Inbox"],
    ["crew", "tests/e2e/storage/audit-crew.json", "/team", "Calendar"],
    [
      "read-only",
      "tests/e2e/storage/audit-read-only.json",
      "/team?tab=settings",
      "Account",
    ],
    [
      "custom grant",
      "tests/e2e/storage/audit-custom-grant.json",
      "/team",
      "Inbox",
    ],
  ] as const) {
    test(`${role} team session reaches its permitted landing surface`, async ({
      browser,
    }, testInfo) => {
      const context = await createTeamContext(browser, storage, testInfo);
      try {
        const page = await context.newPage();
        await page.goto(route);
        await expect(page).not.toHaveURL(/\/team\/login/);
        await expect(page.locator("main")).toContainText(expectedText);
      } finally {
        await context.close();
      }
    });
  }

  test("office permissions render an allowed Policy destination", async ({
    browser,
  }, testInfo) => {
    const context = await createTeamContext(
      browser,
      "tests/e2e/storage/audit-office.json",
      testInfo,
    );
    try {
      const page = await context.newPage();
      await page.goto("/team?tab=policy");
      await expect(page.locator("main")).toContainText("Policy Center");
    } finally {
      await context.close();
    }
  });

  test("custom deny can read quotes without a delete control", async ({
    browser,
  }, testInfo) => {
    const context = await createTeamContext(
      browser,
      "tests/e2e/storage/audit-custom-deny.json",
      testInfo,
    );
    try {
      const page = await context.newPage();
      await page.goto("/team?tab=quotes");
      await expect(page.locator("main")).toContainText("Quote Workspace");
      await expect(page.getByRole("button", { name: /delete/i })).toHaveCount(
        0,
      );
    } finally {
      await context.close();
    }
  });

  for (const [state, storage] of [
    ["inactive", "tests/e2e/storage/audit-inactive.json"],
    ["expired", "tests/e2e/storage/audit-expired.json"],
  ] as const) {
    test(`${state} team session is rejected`, async ({ browser }, testInfo) => {
      const context = await createTeamContext(browser, storage, testInfo);
      try {
        const page = await context.newPage();
        await page.goto("/team?tab=settings");
        await expect(page).toHaveURL(/\/team\/login/);
      } finally {
        await context.close();
      }
    });
  }

  test("an expired session cookie does not hide the login form", async ({
    browser,
  }, testInfo) => {
    const context = await createTeamContext(
      browser,
      "tests/e2e/storage/audit-expired.json",
      testInfo,
    );
    try {
      const page = await context.newPage();
      await page.goto("/team/login");
      await expect(
        page.getByRole("heading", { name: "Stonegate Team Console" }),
      ).toBeVisible();
      await expect(page.getByText("You're already signed in.")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("password setup lands on the visible Settings form", async ({
    browser,
  }, testInfo) => {
    const context = await createTeamContext(
      browser,
      "tests/e2e/storage/audit-office.json",
      testInfo,
    );
    try {
      const page = await context.newPage();
      await page.goto("/team?setup=1");
      await expect(page).toHaveURL(/\/team\/settings\?setup=1$/u);
      await expect(
        page.getByRole("heading", { name: "Set password" }),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("anonymous contact analysis proxy is denied before upstream access", async ({
    request,
  }) => {
    const response = await request.get(
      "/api/team/contacts/media-analysis?contactId=00000000-0000-4000-8000-000000000001",
    );
    expect(response.status()).toBe(401);
  });
});

test.describe("owner all-tab smoke", () => {
  test.use({ storageState: OWNER_STORAGE });

  for (const tab of TABS) {
    test(`${tab} renders a settled, error-free surface`, async ({
      page,
    }, testInfo) => {
      const health = await monitorTeamSurfaceHealth(
        page,
        getProjectBaseURL(testInfo),
      );
      try {
        const response = await page.goto(`/team?tab=${tab}`);
        expect(response?.status() ?? 599).toBeLessThan(400);
        await expect(page).not.toHaveURL(/\/team\/login/);
        await expect(page.locator("main")).toBeVisible();
        const theme = getAuditTheme(testInfo);
        await expect(
          page.locator(`.team-theme-${theme}`).first(),
        ).toBeVisible();
        await waitForTeamSurfaceToSettle(page);
        await health.assertHealthy(testInfo);
        await page.screenshot({
          path: testInfo.outputPath(`${tab}-full-page.png`),
          fullPage: true,
          animations: "disabled",
        });
      } finally {
        await health.stop();
      }
    });
  }
});

test.describe("navigation, aliases, and compatibility", () => {
  test.use({ storageState: OWNER_STORAGE });

  test("invalid tab falls back to a real, visible destination", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== DESKTOP_PROJECT,
      "Invalid-route behavior is viewport and theme independent and runs once.",
    );
    await page.goto("/team?tab=not-a-real-tab");
    await expect(page.locator("main")).toContainText(/Inbox|Expenses/);
  });

  for (const [alias, expectedHeading, expectedPath] of [
    ["quote-builder", "Quotes", /\/team\/quotes\/create/],
    ["canvass", "Quotes", /\/team\/quotes\/create/],
    ["marketing", "Ads", /\/team\/marketing\/ads/],
    ["myday", "Calendar", /\/team\/calendar/],
    ["estimates", "Calendar", /\/team\/calendar/],
  ] as const) {
    test(`legacy alias ${alias} resolves to visible content`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== DESKTOP_PROJECT,
        "Canonical alias resolution is viewport and theme independent and runs once.",
      );
      await page.goto(`/team?tab=${alias}`);
      await expect(page).toHaveURL(expectedPath);
      await expect(
        page.getByRole("heading", { level: 1, name: expectedHeading }),
      ).toBeVisible();
    });
  }

  test("classic layout remains a desktop compatibility path", async ({
    page,
  }, testInfo) => {
    test.skip(
      ![DESKTOP_PROJECT, "chromium-375-light"].includes(testInfo.project.name),
      "Classic is regression-only and runs at one desktop and one phone width.",
    );
    await page.goto("/team?tab=calendar&layout=classic");
    await expect(page.locator("main")).toContainText("Calendar");
  });

  test("modern shell Classic layout control changes the layout URL", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== DESKTOP_PROJECT,
      "The compatibility switch is exercised once; the resulting layout has its own width coverage.",
    );
    await page.goto("/team?tab=settings");
    await page.getByRole("button", { name: "Classic layout" }).click();
    await expect(page).toHaveURL(/layout=classic/);
  });
});

test.describe("shell accessibility and responsive behavior", () => {
  test.use({ storageState: OWNER_STORAGE });

  test("each supported viewport has a named page heading", async ({ page }) => {
    await page.goto("/team?tab=settings");
    const heading = page.getByRole("heading", { level: 1 });
    await expect(heading).toHaveCount(1);
    await expect(heading).toBeVisible();
    await expect(page.locator("main")).toHaveAttribute(
      "aria-labelledby",
      "team-page-title",
    );
  });

  test("mobile navigation traps focus and closes with Escape", async ({
    page,
  }, testInfo) => {
    const viewport = testInfo.project.use.viewport;
    test.skip(
      !viewport || viewport.width >= 1024,
      "The drawer exists only below the desktop navigation breakpoint.",
    );
    await page.goto("/team?tab=settings");
    await page.getByRole("button", { name: "Open navigation" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Open navigation" }),
    ).toBeFocused();
  });

  test("desktop collapsed navigation controls retain accessible names", async ({
    page,
  }, testInfo) => {
    const viewport = testInfo.project.use.viewport;
    test.skip(
      !viewport || viewport.width < 1024,
      "The collapsible sidebar exists only at desktop widths.",
    );
    await page.goto("/team?tab=settings");
    await page.getByRole("button", { name: "Collapse" }).click();
    await expect(
      page.getByRole("button", { name: "Expand sidebar" }),
    ).toBeVisible();
  });
});

test.describe("critical end-to-end journeys", () => {
  test.use({ storageState: OWNER_STORAGE });

  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(
      testInfo.project.name !== DESKTOP_PROJECT,
      "State-changing journeys run once against the isolated audit database.",
    );
    testInfo.setTimeout(120_000);
  });

  test.afterAll(async () => {
    await closeJourneyFixtures();
  });

  test("password, magic-link expiry, and token replay matrix", async ({
    browser,
  }, testInfo) => {
    const fixture = await createAuthMatrixFixture();
    const baseURL = getProjectBaseURL(testInfo);
    const contexts: BrowserContext[] = [];
    try {
      const expiredContext = await browser.newContext({
        baseURL,
        storageState: ANONYMOUS_STORAGE_STATE,
      });
      contexts.push(expiredContext);
      const expiredPage = await expiredContext.newPage();
      await expiredPage.goto(
        `/team/auth?token=${encodeURIComponent(fixture.expiredToken)}`,
      );
      await expect(expiredPage).toHaveURL(
        /\/team\/login\?error=expired_or_invalid/,
      );
      await expect(
        expiredPage
          .getByRole("alert")
          .filter({ hasText: /expired or has already been used/i }),
      ).toBeVisible();

      const magicContext = await browser.newContext({
        baseURL,
        storageState: ANONYMOUS_STORAGE_STATE,
      });
      contexts.push(magicContext);
      const magicPage = await magicContext.newPage();
      await magicPage.goto(
        `/team/auth?token=${encodeURIComponent(fixture.validToken)}`,
      );
      await expect(magicPage).not.toHaveURL(/\/team\/login/);
      await expect(magicPage.locator("main")).toBeVisible();

      const replayContext = await browser.newContext({
        baseURL,
        storageState: ANONYMOUS_STORAGE_STATE,
      });
      contexts.push(replayContext);
      const replayPage = await replayContext.newPage();
      await replayPage.goto(
        `/team/auth?token=${encodeURIComponent(fixture.validToken)}`,
      );
      await expect(replayPage).toHaveURL(
        /\/team\/login\?error=expired_or_invalid/,
      );

      const passwordContext = await browser.newContext({
        baseURL,
        storageState: ANONYMOUS_STORAGE_STATE,
      });
      contexts.push(passwordContext);
      const passwordPage = await passwordContext.newPage();
      await passwordPage.goto("/team/login");
      await passwordPage
        .getByLabel("Email", { exact: true })
        .fill(fixture.email);
      await passwordPage
        .getByLabel("Password", { exact: true })
        .fill(fixture.password);
      await passwordPage
        .getByRole("button", { name: "Sign in with password" })
        .click();
      await expect(passwordPage).not.toHaveURL(/\/team\/login/);
      await expect(passwordPage.locator("main")).toBeVisible();

      await expect
        .poll(() => getAuthMatrixState(fixture.memberId))
        .toMatchObject({ activeTokens: 0, activeSessions: 2 });
    } finally {
      // A timed-out assertion can close the shared browser before this cleanup
      // runs. Preserve the original assertion error instead of replacing it
      // with a secondary "browser has been closed" rejection.
      await Promise.allSettled(contexts.map((context) => context.close()));
      await cleanupAuthMatrixFixture(fixture);
    }
  });

  test("instant-quote booking CTA consumes prefill and creates a booking", async ({
    page,
  }) => {
    const fixture = await createInstantQuoteFixture();
    const actor = await getAuditActor();
    const startedAt = new Date();
    try {
      await page.goto(`/team/instant-quotes/${fixture.instantQuoteId}`);
      await expect(page.locator("main")).toContainText(fixture.name);
      await page.getByRole("link", { name: "Book from this quote" }).click();

      await expect(page).toHaveURL(
        new RegExp(
          `/team/contacts.*contactId=${fixture.contactId}.*instantQuoteId=${fixture.instantQuoteId}`,
        ),
      );
      await expect(
        page
          .getByRole("status")
          .filter({ hasText: "Verified instant quote loaded" }),
      ).toBeVisible();
      const bookingForm = await formContaining(
        page.locator("main"),
        `input[name="instantQuoteId"][value="${fixture.instantQuoteId}"]`,
      );
      await expect(bookingForm.locator('input[name="source"]')).toHaveValue(
        "team_instant_quote",
      );
      await expect(
        bookingForm.locator('select[name="propertyId"]'),
      ).toHaveValue(fixture.propertyId);
      await expectUsdInputCents(
        bookingForm.locator('input[name="priceRangeMin"]'),
        30_000,
      );
      await expectUsdInputCents(
        bookingForm.locator('input[name="priceRangeMax"]'),
        45_000,
      );
      await expect(bookingForm.locator('select[name="loadSize"]')).toHaveValue(
        "quarter_to_half",
      );

      await bookingForm
        .locator('input[name="startAt"]')
        .fill(localDateTimeInput(3));
      await bookingForm
        .locator('select[name="assignedAssociateMemberId"]')
        .selectOption(actor.memberId);
      await bookingForm
        .locator('select[name="soldByMemberId"]')
        .selectOption(actor.memberId);
      await bookingForm
        .getByRole("button", { name: "Confirm booking" })
        .click();
      await expect(
        page.getByText("Appointment booked", { exact: true }),
      ).toBeVisible();

      await expect
        .poll(() => getInstantQuoteBookingSnapshot(fixture.instantQuoteId))
        .toMatchObject({
          contactId: fixture.contactId,
          propertyId: fixture.propertyId,
          status: "confirmed",
        });
      await expectSuccessfulAuditActions(
        startedAt,
        ["appointment.booked"],
        actor,
      );
    } finally {
      await cleanupCustomerFixture(fixture.contactId);
    }
  });

  test("lead to booked job with database and audit assertions", async ({
    page,
  }, testInfo) => {
    const marker = auditMarker("lead-booked");
    const email = `${marker}@mystos.test`;
    const phone = `470${String(Date.now()).slice(-7)}`;
    const actor = await getAuditActor();
    const startedAt = new Date();
    let contactId: string | null = null;
    let leadReceipt: { leadId: string; auditEventId: string } | null = null;
    try {
      await test.step("customer submits an inbound estimate request", async () => {
        await page.goto("/estimate");
        await page.getByRole("button", { name: /Furniture Removal/ }).click();
        await page
          .getByPlaceholder("Jamie Customer", { exact: true })
          .fill(`Audit Lead ${marker.slice(-8)}`);
        await page
          .getByPlaceholder("(404) 777-2631", { exact: true })
          .fill(phoneDisplay(phone));
        await page
          .getByPlaceholder("you@example.com", { exact: true })
          .fill(email);
        await page
          .getByPlaceholder("Street address", { exact: true })
          .fill(`812 ${marker} Way`);
        await page.getByPlaceholder("City", { exact: true }).fill("Roswell");
        await page.getByPlaceholder("GA", { exact: true }).fill("GA");
        await page.getByPlaceholder("ZIP", { exact: true }).fill("30075");
        const visitDates = page.locator('input[type="date"]');
        await visitDates.first().fill(dateInput(4));
        await visitDates.nth(1).fill(dateInput(5));
        const intakeResponsePromise = page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            new URL(response.url()).pathname === "/api/web/lead-intake",
        );
        await page.getByRole("button", { name: "Request estimate" }).click();
        const intakeResponse = await intakeResponsePromise;
        expect(intakeResponse.status()).toBe(201);
        const intakeRequest = intakeResponse.request();
        const intakeKey = await intakeRequest.headerValue("idempotency-key");
        if (!intakeKey) {
          throw new Error("Lead intake did not send a stable idempotency key.");
        }
        const intakePayload = intakeRequest.postDataJSON() as Record<
          string,
          unknown
        >;
        const originalReceipt = (await intakeResponse.json()) as {
          ok?: unknown;
          leadId?: unknown;
          auditEventId?: unknown;
        };
        expect(originalReceipt).toMatchObject({
          ok: true,
          leadId: expect.any(String),
          auditEventId: expect.any(String),
        });
        if (
          typeof originalReceipt.leadId !== "string" ||
          typeof originalReceipt.auditEventId !== "string"
        ) {
          throw new Error("Lead intake returned an invalid audit receipt.");
        }
        leadReceipt = {
          leadId: originalReceipt.leadId,
          auditEventId: originalReceipt.auditEventId,
        };

        const replay = await page.request.post(intakeResponse.url(), {
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": intakeKey,
          },
          data: intakePayload,
        });
        expect(replay.status()).toBe(201);
        expect(replay.headers()["idempotency-replayed"]).toBe("true");
        await expect(replay.json()).resolves.toMatchObject({
          ok: true,
          leadId: leadReceipt.leadId,
          auditEventId: leadReceipt.auditEventId,
        });

        const conflictingReplay = await page.request.post(
          intakeResponse.url(),
          {
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": intakeKey,
            },
            data: {
              ...intakePayload,
              notes: `Conflicting replay ${marker}`,
            },
          },
        );
        expect(conflictingReplay.status()).toBe(409);
        await expect(conflictingReplay.json()).resolves.toMatchObject({
          ok: false,
          error: "idempotency_conflict",
          retryable: false,
        });
        await expect(
          page.getByRole("heading", { name: "You’re all set" }),
        ).toBeVisible();
      });

      const contact = await expect
        .poll(() => findContactByEmail(email), { timeout: 15_000 })
        .not.toBeNull()
        .then(() => findContactByEmail(email));
      if (!contact?.leadId)
        throw new Error("Inbound audit lead was not persisted.");
      contactId = contact.contactId;
      expect(contact.leadId).toBe(leadReceipt?.leadId);

      await test.step("owner finds the lead in Inbox and Contacts", async () => {
        await page.goto(`/team/inbox?inbox_q=${encodeURIComponent(email)}`);
        await expect(page.locator("main")).toContainText(/Inbox/);
        await page.goto(`/team/contacts?contactId=${contact.contactId}`);
        await expect(page.locator("main")).toContainText(contact.name);
      });

      const publicOrigin = new URL(getProjectBaseURL(testInfo)).origin;
      const created = await auditOwnerApi<{
        ok: true;
        data: { quote: { id: string; revision: number } };
      }>("/api/quotes", {
        method: "POST",
        headers: {
          "Idempotency-Key": `quote-audit-create:${randomUUID()}`,
        },
        data: {
          confirmation: "create_quote",
          contactId: contact.contactId,
          propertyId: contact.propertyId,
          zoneId: "zone-core",
          selectedServices: ["furniture"],
          applyBundles: true,
          notes: `Reviewed E2E scope ${marker}`,
        },
      });
      const sent = await auditOwnerApi<{
        ok: true;
        data: { shareUrl: string };
      }>(`/api/quotes/${created.data.quote.id}/send`, {
        method: "POST",
        headers: {
          "Idempotency-Key": `quote-audit-send:${randomUUID()}`,
          "If-Match": String(created.data.quote.revision),
        },
        data: {
          confirmation: "send_quote",
          expiresInDays: 7,
          shareBaseUrl: publicOrigin,
        },
      });

      await test.step("customer accepts the full quote", async () => {
        const shareUrl = new URL(sent.data.shareUrl);
        await page.goto(`${shareUrl.pathname}${shareUrl.search}`);
        await expect(
          page.getByRole("heading", { name: /your junk removal proposal/i }),
        ).toBeVisible();
        const approveAndBook = page
          .getByRole("button", { name: /^Approve and book /i })
          .first();
        if ((await approveAndBook.count()) > 0) {
          await approveAndBook.click();
          await expect(
            page.getByText(/service window is booked/i),
          ).toBeVisible();
        } else {
          await page
            .getByRole("button", {
              name: "Approve quote and have Stonegate schedule me",
            })
            .click();
          await expect(page.getByText(/quote approved/i)).toBeVisible();
        }
        await expect(page.getByText(/^(Accepted|Booked)$/)).toBeVisible();
      });

      let appointment = await getLatestAppointmentForContact(contact.contactId);
      if (!appointment) {
        await test.step("owner books the accepted quote", async () => {
          await page.goto(
            `/team/contacts?contactId=${contact.contactId}&action=book`,
          );
          const form = await formContaining(
            page.locator("main"),
            `input[name="contactId"][value="${contact.contactId}"]`,
          );
          await form
            .locator('select[name="appointmentType"]')
            .selectOption("junk_removal");
          await form
            .locator('select[name="propertyId"]')
            .selectOption(contact.propertyId);
          await form
            .locator('input[name="startAt"]')
            .fill(localDateTimeInput(6));
          await form
            .locator('select[name="assignedAssociateMemberId"]')
            .selectOption(actor.memberId);
          await form
            .locator('select[name="soldByMemberId"]')
            .selectOption(actor.memberId);
          await form
            .locator('select[name="sourceType"]')
            .selectOption("google");
          await form
            .locator('select[name="priceInputMode"]')
            .selectOption("exact");
          await form.locator('input[name="quotedTotal"]').fill("475");
          await form
            .locator('select[name="loadSize"]')
            .selectOption("half_to_three_quarters");
          await form.getByRole("button", { name: "Confirm booking" }).click();
          await expect(
            page.getByText("Appointment booked", { exact: true }),
          ).toBeVisible();
        });
        appointment = await expect
          .poll(() => getLatestAppointmentForContact(contact.contactId))
          .not.toBeNull()
          .then(() => getLatestAppointmentForContact(contact.contactId));
      }
      expect(appointment?.leadId).toBe(contact.leadId);
      expect(appointment?.propertyId).toBe(contact.propertyId);

      await expect
        .poll(() => getLeadJourneySnapshot(contact.contactId))
        .toMatchObject({
          quoteStatus: "accepted",
          pipelineStage: expect.stringMatching(/quoted|won|booked/),
          appointmentId: expect.any(String),
          appointmentStatus: expect.stringMatching(/requested|confirmed/),
        });
      const audit = await getAuditEventsSince(startedAt, [
        "lead.public_created",
        "quote.created",
        "quote.sent",
        "appointment.booked",
      ]);
      expect(
        audit.filter(
          (event) =>
            event.action === "lead.public_created" &&
            event.id === leadReceipt?.auditEventId,
        ),
      ).toHaveLength(1);
      expect(
        audit.some((event) => event.actorId === actor.memberId),
        "At least one human CRM mutation must retain the verified owner actor.",
      ).toBe(true);
    } finally {
      if (contactId) await cleanupCustomerFixture(contactId);
    }
  });

  test("day-of-service completion through payment and crew attribution", async ({
    page,
  }) => {
    await ensureE2ECommissionPrincipals();
    const fixture = await createDayOfServiceFixture();
    const owner = await getAuditActor();
    const crew = await getAuditActor("audit-crew@mystos.test");
    const startedAt = new Date();
    const note = `Service note ${fixture.marker}`;
    try {
      await page.goto(`/team/calendar?calView=day&cal=${fixture.calendarDay}`);
      await page
        .getByRole("button", { name: new RegExp(fixture.name, "i") })
        .first()
        .click();
      await page.getByLabel("Add appointment note").fill(note);
      await page.getByRole("button", { name: "Add note" }).click();
      await expect(
        page.getByRole("status").filter({ hasText: "Note added" }),
      ).toBeVisible();

      await page.getByLabel("Final job total").fill("725");
      await page.getByLabel(crew.name, { exact: true }).check();
      await page
        .getByLabel(
          "I confirmed the final total and everyone who worked this job.",
        )
        .check();
      await page.getByRole("button", { name: "Complete job" }).click();
      await expect(
        page.getByRole("status").filter({
          hasText: "Job completed with the confirmed total and crew",
        }),
      ).toBeVisible();

      const beforePayment = await getDayOfServiceSnapshot(
        fixture.appointmentId,
      );
      await auditOwnerApi(
        `/api/appointments/${fixture.appointmentId}/manual-payments`,
        {
          method: "POST",
          headers: {
            "Idempotency-Key": `manual-payment-audit:${randomUUID()}`,
            "If-Match": beforePayment.version,
          },
          data: {
            clientRequestId: randomUUID(),
            tenderType: "cash",
            tipCents: 2500,
            note: `Cash collected ${fixture.marker}`,
          },
        },
      );

      await expect
        .poll(() => getDayOfServiceSnapshot(fixture.appointmentId))
        .toMatchObject({
          status: "completed",
          finalTotalCents: 72500,
          notes: expect.arrayContaining([note]),
          crewMemberIds: [crew.memberId],
          commissionCount: expect.any(Number),
          payment: {
            jobAmountCents: 72500,
            tipCents: 2500,
            initiatedBy: owner.memberId,
          },
        });
      const snapshot = await getDayOfServiceSnapshot(fixture.appointmentId);
      expect(snapshot.commissionCount).toBeGreaterThan(0);
      await expectSuccessfulAuditActions(
        startedAt,
        [
          "appointment.note.created",
          "appointment.status.updated",
          "payment.manual.recorded",
        ],
        owner,
      );
    } finally {
      await cleanupCustomerFixture(fixture.contactId);
    }
  });

  test("Sales HQ lead recovery through Inbox outcome", async ({ page }) => {
    const owner = await getAuditActor();
    const policySnapshot = await setSalesDefaultAssignee(owner.memberId);
    const fixture = await createConversationFixture("sales-recovery", {
      withSalesTask: true,
      assignedTo: owner.memberId,
    });
    const startedAt = new Date();
    try {
      expect(await getConversationSnapshot(fixture)).toMatchObject({
        draft: true,
        outboxCount: 0,
        taskStatus: "open",
      });
      await page.goto(
        `/team/sales/hq?queue=speed_to_lead&taskId=${fixture.taskId}`,
      );
      await expect(page.locator("main")).toContainText(fixture.name);
      await expect(page.locator("main")).toContainText("Draft ready");
      await page.getByRole("link", { name: "Open draft" }).click();
      await expect(page).toHaveURL(/\/team\/inbox/);
      await expect(page.locator("main")).toContainText(fixture.name);

      const reminderTitle = `Follow up ${fixture.marker}`;
      const details = page
        .locator("details")
        .filter({ has: page.locator("summary", { hasText: "Details" }) })
        .first();
      await details.locator("summary").first().click();
      const reminders = page.getByRole("region", {
        name: "Contact reminders",
      });
      await reminders.getByRole("button", { name: "Add", exact: true }).click();
      await reminders.getByLabel("Title", { exact: true }).fill(reminderTitle);
      await reminders
        .getByLabel("When", { exact: true })
        .fill(localDateTimeInput(2, 10));
      await reminders
        .getByLabel("Notes (optional)", { exact: true })
        .fill(`Sales recovery ${fixture.marker}`);
      await reminders
        .getByRole("button", { name: "Save", exact: true })
        .click();
      await expect(reminders.getByRole("status")).toHaveText(
        "Reminder created and notification scheduled.",
      );
      await expect(reminders).toContainText(reminderTitle);
      await expect
        .poll(() =>
          getContactReminderSnapshot(fixture.contactId, reminderTitle),
        )
        .toMatchObject({
          assignedTo: owner.memberId,
          dueAt: expect.any(Date),
          outboxCount: 1,
          status: "open",
          title: reminderTitle,
          updatedAt: expect.any(Date),
        });

      await page
        .getByRole("button", { name: /^(Send suggestion|Send now)$/ })
        .click();
      await expect
        .poll(() => getConversationSnapshot(fixture))
        .toMatchObject({ draft: false, outboxCount: 1 });

      const removeSummary = page
        .locator("summary")
        .filter({ hasText: /^Remove$/u })
        .first();
      const remove = removeSummary.locator("..");
      await removeSummary.click();
      await remove
        .locator('select[name="disposition"]')
        .selectOption("handled");
      await remove.getByRole("button", { name: "Confirm remove" }).click();
      await expect
        .poll(() => getConversationSnapshot(fixture))
        .toMatchObject({ taskStatus: "completed", pipelineStage: "lost" });

      await expectSuccessfulAuditActions(
        startedAt,
        ["crm.reminder.created", "message.retry", "sales.disposition.set"],
        owner,
      );
    } finally {
      await restoreSetting(policySnapshot);
      await cleanupCustomerFixture(fixture.contactId);
    }
  });

  test("outbound import through partner conversion", async ({ page }) => {
    const owner = await getAuditActor();
    const marker = auditMarker("outbound-partner");
    const prospectEmail = `${marker}@mystos.test`;
    const inviteEmail = `portal-${marker}@mystos.test`;
    const phone = `470${String(Date.now() + 13).slice(-7)}`;
    const startedAt = new Date();
    let contactId: string | null = null;
    try {
      await page.goto(
        `/team/sales/outbound?view=import&memberId=${owner.memberId}`,
      );
      await page.getByLabel("Campaign", { exact: true }).fill(marker);
      await expect(
        page.getByRole("combobox", { name: "Assign accepted rows to" }),
      ).toHaveValue(owner.memberId);
      await page
        .getByLabel("Paste CSV", { exact: true })
        .fill(
          [
            "company,contactName,title,email,phone,website,city,state,zip,notes",
            `Audit Property Group,Pat ${marker.slice(-6)},Manager,${prospectEmail},${phone},example.invalid,Roswell,GA,30075,${marker}`,
          ].join("\n"),
        );
      await page.getByRole("button", { name: "Preview import" }).click();
      await expect(
        page.getByRole("heading", { name: "Review exact import" }),
      ).toBeVisible();
      await expect(page.getByText("Assignment:")).toContainText(owner.name);
      await page.getByLabel(/Type IMPORT 1 to import/u).fill("IMPORT 1");
      await page
        .getByRole("button", { name: "Import 1 accepted rows" })
        .click();
      await expect(
        page.getByRole("status").filter({ hasText: "Import committed" }),
      ).toBeVisible();

      const imported = await expect
        .poll(() => findOutboundByEmail(prospectEmail), { timeout: 15_000 })
        .not.toBeNull()
        .then(() => findOutboundByEmail(prospectEmail));
      if (!imported) throw new Error("Outbound import was not persisted.");
      contactId = imported.contactId;
      expect(imported).toMatchObject({
        taskStatus: "open",
        assignedToMemberId: owner.memberId,
        dueAt: null,
        partnerStatus: "prospect",
      });

      const selectedOutboundHref = `/team/sales/outbound?memberId=${owner.memberId}&out_account=${imported.accountId}&out_taskId=${imported.taskId}`;
      await page.goto(selectedOutboundHref);
      await expect(page.locator("main")).toContainText(prospectEmail);
      await page.getByRole("button", { name: "Message", exact: true }).click();
      await expect(page).toHaveURL(/\/team\/inbox/u);
      await expect(page.locator("main")).toContainText(prospectEmail);

      await page.goto(selectedOutboundHref);
      const callbackForm = page
        .locator(
          'form:has(input[name="disposition"][value="callback_requested"]):visible',
        )
        .first();
      await expect(callbackForm).toBeVisible();
      const callbackLocal = localDateTimeInput(2, 14);
      const expectedCallbackAt = parseOutboundCallbackLocal(callbackLocal);
      if (!expectedCallbackAt) {
        throw new Error(
          "The callback fixture did not resolve to one Eastern instant.",
        );
      }
      await callbackForm
        .locator('input[name="callbackAt"]')
        .fill(callbackLocal);
      await callbackForm.getByRole("button", { name: "Set callback" }).click();
      const callbackFeedback = page.locator("[data-team-flash]").first();
      await expect(callbackFeedback).toBeVisible();
      await expect(callbackFeedback).toHaveAttribute(
        "data-team-flash",
        "success",
      );
      await expect(callbackFeedback).toHaveText(
        "Outbound updated and the next touch was scheduled.",
      );

      await expect
        .poll(async () => {
          const snapshot = await findOutboundByEmail(prospectEmail);
          return snapshot
            ? {
                assignedToMemberId: snapshot.assignedToMemberId,
                dueAt: snapshot.dueAt?.toISOString() ?? null,
                openOutboundTaskCount: snapshot.openOutboundTaskCount,
                pendingReminderCount: snapshot.pendingReminderCount,
                scheduledNewTask: snapshot.taskId !== imported.taskId,
                taskStatus: snapshot.taskStatus,
              }
            : null;
        })
        .toEqual({
          assignedToMemberId: owner.memberId,
          dueAt: expectedCallbackAt,
          openOutboundTaskCount: 1,
          pendingReminderCount: 1,
          scheduledNewTask: true,
          taskStatus: "open",
        });
      const callback = await findOutboundByEmail(prospectEmail);
      if (!callback) throw new Error("Callback task was not scheduled.");
      await page.goto(
        `/team/sales/outbound?memberId=${owner.memberId}&out_account=${callback.accountId}&out_taskId=${callback.taskId}`,
      );
      await page.getByRole("button", { name: "Partner", exact: true }).click();
      const partnerFeedback = page.locator("[data-team-flash]").first();
      await expect(partnerFeedback).toBeVisible();
      await expect(partnerFeedback).toHaveAttribute(
        "data-team-flash",
        "success",
      );
      await expect(partnerFeedback).toHaveText(
        "Outbound updated and the cadence was stopped.",
      );

      await expect
        .poll(() => findOutboundByEmail(prospectEmail))
        .toMatchObject({
          partnerStatus: "partner",
          accountStatus: "active_partner",
        });
      await page.goto(
        `/team/sales/outbound/partners?p_selected=${imported.contactId}`,
      );
      await expect(
        page.getByRole("heading", { name: "Partner Portal Access" }),
      ).toBeVisible();
      const inviteForm = await formContaining(
        page.locator("main"),
        `input[name="orgContactId"][value="${imported.contactId}"]`,
      );
      await inviteForm
        .getByLabel("Name", { exact: true })
        .fill("Audit Portal User");
      await inviteForm.getByLabel("Email", { exact: true }).fill(inviteEmail);
      await inviteForm.getByLabel("Phone (optional)").fill(phoneDisplay(phone));
      await inviteForm.getByRole("button", { name: "Send invite" }).click();
      await expect(
        page.getByText(/Invite accepted for delivery by/i),
      ).toBeVisible();

      await expect
        .poll(() => getPartnerInvite(inviteEmail))
        .toMatchObject({ orgContactId: imported.contactId, tokenCount: 1 });
      const invite = await getPartnerInvite(inviteEmail);
      expect(invite?.rateItemCount ?? 0).toBeGreaterThan(0);
      await expect
        .poll(async () => {
          const events = await getAuditEventsSince(startedAt, [
            "partner_user.invite.attempted",
            "partner_user.invited",
          ]);
          const attempted = events.find(
            (event) =>
              event.action === "partner_user.invite.attempted" &&
              event.actorId === owner.memberId,
          );
          const succeeded = events.find(
            (event) =>
              event.action === "partner_user.invited" &&
              event.actorId === owner.memberId,
          );
          return {
            attemptedOutcome: attempted?.outcome ?? null,
            succeededOutcome: succeeded?.outcome ?? null,
            providerExactlyOnceClaimed:
              succeeded?.meta?.["providerExactlyOnceClaimed"] ?? null,
            acceptedChannels: succeeded?.meta?.["acceptedChannels"] ?? null,
          };
        })
        .toMatchObject({
          attemptedOutcome: "attempted",
          succeededOutcome: "succeeded",
          providerExactlyOnceClaimed: false,
          acceptedChannels: expect.arrayContaining(["email"]),
        });
      await expectSuccessfulAuditActions(
        startedAt,
        [
          "outbound.imported",
          "thread.created",
          "outbound.disposition",
          "partner.converted",
          "partner_user.invited",
        ],
        owner,
      );
    } finally {
      if (contactId) await cleanupCustomerFixture(contactId);
    }
  });

  test("money close through locked and paid payout", async ({ page }) => {
    await assertNoCurrentCanonicalPayout();
    await ensureE2ECommissionPrincipals();
    const fixture = await createMoneyCloseFixture();
    const owner = await getAuditActor();
    const marker = auditMarker("expense");
    const vendor = `Audit Vendor ${marker}`;
    const startedAt = new Date();
    let expenseId: string | null = null;
    let payoutRunId: string | null = null;
    let retainedFinancialEvidence = false;
    try {
      const currentAppointment = await getDayOfServiceSnapshot(
        fixture.appointmentId,
      );
      const paymentKey = `money-close-payment:${randomUUID()}`;
      const paymentMutation = await auditOwnerApi<{
        ok: true;
        data: {
          appointmentId: string;
          paymentId: string;
          jobAmountCents: number;
          tipCents: number;
          totalAmountCents: number;
          status: "completed";
          version: string;
        };
        receipt: {
          operationId: string;
          correlationId: string;
          actorId: string;
          auditEventId: string;
          entityType: string;
          entityId: string;
          version: string;
        };
      }>(`/api/appointments/${fixture.appointmentId}/manual-payments`, {
        method: "POST",
        headers: {
          "Idempotency-Key": paymentKey,
          "If-Match": currentAppointment.version,
        },
        data: {
          clientRequestId: randomUUID(),
          tenderType: "cash",
          tipCents: 0,
          note: `Money close ${fixture.marker}`,
        },
      });
      expect(paymentMutation).toMatchObject({
        ok: true,
        data: {
          appointmentId: fixture.appointmentId,
          jobAmountCents: 90_000,
          tipCents: 0,
          totalAmountCents: 90_000,
          status: "completed",
        },
        receipt: {
          actorId: owner.memberId,
          entityType: "payment",
        },
      });
      expect(paymentMutation.receipt.entityId).toBe(
        paymentMutation.data.paymentId,
      );
      const paymentId = paymentMutation.data.paymentId;

      await page.goto("/team/expenses");
      await page.getByRole("link", { name: "Add draft", exact: true }).click();
      await expect
        .poll(() => {
          const url = new URL(page.url());
          return {
            pathname: url.pathname,
            expenseView: url.searchParams.get("expenseView"),
          };
        })
        .toEqual({ pathname: "/team/expenses", expenseView: "add" });
      const expenseForm = page
        .locator("#expense-add")
        .getByRole("form", { name: "Add draft", exact: true });
      await expect(expenseForm).toBeVisible();
      await expect(expenseForm).toHaveAttribute("action", "/api/team/expenses");
      const expenseCreateKey = await expenseForm
        .locator('input[name="idempotencyKey"]')
        .inputValue();
      expect(expenseCreateKey).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u);
      await expenseForm.getByLabel("Date", { exact: true }).fill(dateInput());
      await expenseForm.getByLabel("Amount (USD)").fill("42.75");
      await expenseForm.getByLabel("Category").fill("Fuel");
      await expenseForm.getByLabel("Vendor").fill(vendor);
      await expenseForm.getByLabel("Payment method").selectOption("card");
      await expenseForm.getByLabel("Notes").fill(marker);
      await expenseForm.getByRole("button", { name: "Save draft" }).click();

      const draft = await expect
        .poll(() => findExpenseByVendor(vendor))
        .not.toBeNull()
        .then(() => findExpenseByVendor(vendor));
      if (!draft) throw new Error("Expense draft was not persisted.");
      expenseId = draft.id;
      expect(draft).toMatchObject({
        lifecycleStatus: "draft",
        amount: 4275,
        version: 1,
        postedAt: null,
        postedBy: null,
      });

      await page.getByRole("link", { name: "Ledger", exact: true }).click();
      await expect
        .poll(() => new URL(page.url()).searchParams.get("expenseView"))
        .toBe("ledger");
      const postForm = page.locator(
        `form[action="/api/team/expenses/${draft.id}/post"]`,
      );
      await expect(postForm).toBeVisible();
      const expensePostKey = await postForm
        .locator('input[name="idempotencyKey"]')
        .inputValue();
      expect(await postForm.locator('input[name="version"]').inputValue()).toBe(
        "1",
      );
      await postForm.getByRole("button", { name: "Post Fuel draft" }).click();
      await expect
        .poll(() => findExpenseByVendor(vendor))
        .toMatchObject({
          lifecycleStatus: "posted",
          amount: 4275,
          version: 2,
          postedAt: expect.any(Date),
          postedBy: owner.memberId,
        });

      await page.goto("/team/admin/commissions");
      const createPayoutForm = page.locator(
        'form[action="/api/team/commissions/payout-runs"]:has(input[name="action"][value="create"])',
      );
      const payoutCreateKey = await createPayoutForm
        .locator('input[name="idempotencyKey"]')
        .inputValue();
      await createPayoutForm
        .getByRole("button", { name: "Create this week's payout" })
        .click();
      const payout = await expect
        .poll(
          () => findPayoutForAppointment(fixture.appointmentId, startedAt),
          { timeout: 20_000 },
        )
        .not.toBeNull()
        .then(() => findPayoutForAppointment(fixture.appointmentId, startedAt));
      if (!payout) throw new Error("Payout run was not created.");
      payoutRunId = payout.id;

      let runForm = page.locator(
        `form:has(input[name="action"][value="lock"]):has(input[name="payoutRunId"][value="${payout.id}"])`,
      );
      const lockKey = await runForm
        .locator('input[name="idempotencyKey"]')
        .inputValue();
      expect(
        await runForm.locator('input[name="expectedVersion"]').inputValue(),
      ).toBe(payout.version);
      await runForm
        .getByRole("checkbox", {
          name: "I reviewed every recipient and total.",
        })
        .check();
      await runForm.getByRole("button", { name: "Lock" }).click();
      await expect
        .poll(() =>
          getMoneyCloseSnapshot(payout.id, fixture.appointmentId, paymentId),
        )
        .toMatchObject({ status: "locked", lockedAt: expect.any(Date) });
      const locked = await getMoneyCloseSnapshot(
        payout.id,
        fixture.appointmentId,
        paymentId,
      );
      expect(locked.version).not.toBe(payout.version);
      expect(locked.lineCount).toBeGreaterThan(0);
      expect(locked.lineTotalCents).toBe(
        locked.periodCommissionTotalCents + locked.payoutAdjustmentTotalCents,
      );

      runForm = page.locator(
        `form:has(input[name="action"][value="paid"]):has(input[name="payoutRunId"][value="${payout.id}"])`,
      );
      const paidKey = await runForm
        .locator('input[name="idempotencyKey"]')
        .inputValue();
      expect(
        await runForm.locator('input[name="expectedVersion"]').inputValue(),
      ).toBe(locked.version);
      await runForm
        .getByRole("checkbox", { name: "I confirm these funds were paid." })
        .check();
      await runForm.getByRole("button", { name: "Mark Paid" }).click();
      await expect
        .poll(() =>
          getMoneyCloseSnapshot(payout.id, fixture.appointmentId, paymentId),
        )
        .toMatchObject({
          status: "paid",
          lockedAt: expect.any(Date),
          paidAt: expect.any(Date),
          payrollExpenseCount: 1,
        });
      const close = await getMoneyCloseSnapshot(
        payout.id,
        fixture.appointmentId,
        paymentId,
      );
      expect(close.lineCount).toBeGreaterThan(0);
      expect(close.lineTotalCents).toBeGreaterThan(0);
      expect(close.lineTotalCents).toBe(
        close.periodCommissionTotalCents + close.payoutAdjustmentTotalCents,
      );
      expect(close.periodCommissionCount).toBeGreaterThanOrEqual(
        close.appointmentCommissionCount,
      );
      expect(close.appointmentCommissionCount).toBeGreaterThan(0);
      expect(close.crewCommissionRecipientIds).toEqual([fixture.crewMemberId]);
      expect(close.payrollExpenseAmount).toBe(
        close.lineTotalCents - close.payoutReimbursementTotalCents,
      );
      expect(close.payrollExpenseLifecycle).toBe("posted");
      expect(close.payrollExpenseVersion).toBe(1);
      expect(close.payrollExpensePostedAt).toEqual(expect.any(Date));
      expect(close.payrollExpensePostedBy).toBe(owner.memberId);
      expect(close.payrollExpensePaidAt?.getTime()).toBe(
        close.paidAt?.getTime(),
      );
      expect(close.payrollExpenseMemo).toBe(`payout_run:${payout.id}`);
      expect(close.paymentCount).toBe(1);
      expect(close.paymentAmountCents).toBe(90_000);
      expect(close.paymentStatus).toBe("completed");
      expect(close.paymentActorId).toBe(owner.memberId);

      await page.goto("/team/owner?ownerView=pl");
      const last30Card = page.locator('[data-owner-pl-window="last30Days"]');
      await expect(last30Card).toBeVisible();
      await expect(last30Card).toHaveAttribute(
        "data-owner-pl-revenue-cents",
        String(close.last30RevenueTotalCents),
      );
      await expect(last30Card).toHaveAttribute(
        "data-owner-pl-expense-cents",
        String(close.last30ExpenseTotalCents),
      );
      await expect(last30Card).toHaveAttribute(
        "data-owner-pl-profit-cents",
        String(close.last30ProfitTotalCents),
      );
      await expectSuccessfulAuditActions(
        startedAt,
        [
          "payment.manual.recorded",
          "expense.draft_created",
          "expense.posted",
          "commission.payout_run.created",
          "commission.payout_run.locked",
          "commission.payout_run.paid",
        ],
        owner,
      );

      for (const expected of [
        {
          key: paymentKey,
          action: "payment.manual.recorded",
          entityId: paymentId,
          permission: "payments.collect",
          status: 200,
        },
        {
          key: expenseCreateKey,
          action: "expense.draft_created",
          entityId: draft.id,
          permission: "expenses.write",
          status: 201,
        },
        {
          key: expensePostKey,
          action: "expense.posted",
          entityId: draft.id,
          permission: "expenses.write",
          status: 200,
        },
        {
          key: payoutCreateKey,
          action: "commission.payout_run.created",
          entityId: payout.id,
          permission: "commissions.manage",
          status: 200,
        },
        {
          key: lockKey,
          action: "commission.payout_run.locked",
          entityId: payout.id,
          permission: "commissions.manage",
          status: 200,
        },
        {
          key: paidKey,
          action: "commission.payout_run.paid",
          entityId: payout.id,
          permission: "commissions.pay",
          status: 200,
        },
      ]) {
        const evidence = await expect
          .poll(() => getMutationEvidence(expected.key, expected.action))
          .not.toBeNull()
          .then(() => getMutationEvidence(expected.key, expected.action));
        if (!evidence) throw new Error(`Missing ${expected.action} receipt.`);
        expect(evidence).toMatchObject({
          status: "succeeded",
          attemptCount: 1,
          responseStatus: expected.status,
          actorId: owner.memberId,
          outcome: "succeeded",
          entityId: expected.entityId,
          authMethod: "team_session",
        });
        expect(evidence.requiredPermissions).toContain(expected.permission);
        expect(evidence.idempotencyKeyHash).toMatch(/^[0-9a-f]{64}$/u);
        expect(evidence.responseBody).toMatchObject({
          ok: true,
          receipt: {
            operationId: evidence.operationId,
            correlationId: evidence.correlationId,
            actorId: owner.memberId,
            auditEventId: evidence.auditEventId,
            entityId: expected.entityId,
          },
        });
      }
    } finally {
      const cleanup = await cleanupPayoutRun(payoutRunId, expenseId);
      retainedFinancialEvidence = cleanup === "retained_for_shard_reset";
      if (!retainedFinancialEvidence) {
        await cleanupCustomerFixture(fixture.contactId);
      }
    }
  });

  test("automation policy through simulation and approval boundary", async ({
    page,
  }) => {
    const owner = await getAuditActor();
    const quietSnapshot = await snapshotPolicySetting("quiet_hours");
    const autopilotSnapshot = await snapshotPolicySetting("sales_autopilot");
    const [smsSnapshot, emailSnapshot, dmSnapshot] = await Promise.all([
      snapshotAutomationSetting("sms"),
      snapshotAutomationSetting("email"),
      snapshotAutomationSetting("dm"),
    ]);
    const fixture = await createConversationFixture("automation-boundary", {
      assignedTo: owner.memberId,
    });
    const startedAt = new Date();
    try {
      await page.goto("/team/admin/policy#quiet_hours");
      const quietForm = page
        .locator('[data-policy-card="quiet_hours"] form')
        .first();
      await expect(
        quietForm.locator('input[name="expectedVersion"]'),
      ).toHaveValue(
        /^(?:absent|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/u,
      );
      const quietKey = await quietForm
        .locator('input[name="idempotencyKey"]')
        .inputValue();
      expect(quietKey).toMatch(/^policy:quiet_hours:[A-Za-z0-9-]{16,}$/u);
      const existingStart = await quietForm
        .locator('input[name="sms_start"]')
        .inputValue();
      await quietForm
        .locator('input[name="sms_start"]')
        .fill(existingStart === "21:00" ? "20:00" : "21:00");
      await quietForm.locator('input[name="sms_end"]').fill("08:30");
      await quietForm.getByRole("button", { name: "Save quiet hours" }).click();

      // A server-action click only proves submission began. Wait for the Site
      // to validate the committed API receipt before querying the database.
      await expect(
        page.getByText("Quiet hours updated", { exact: true }),
      ).toBeVisible();
      await expect
        .poll(async () => (await getQuietHoursChannel("sms"))?.end ?? null)
        .toBe("08:30");

      await page.goto("/team/admin/automation");
      const automationForm = page
        .locator('form:has(select[name="channelMode_sms"])')
        .first();
      const automationVersion = automationForm.locator(
        'input[name="expectedVersion"]',
      );
      const automationKey = automationForm.locator(
        'input[name="idempotencyKey"]',
      );
      await expect(automationVersion).toHaveValue(
        /^(?:absent|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/u,
      );
      let finalAutomationKey = await automationKey.inputValue();
      expect(finalAutomationKey).toMatch(
        /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u,
      );
      const currentModes = await Promise.all(
        ["mode", "channelMode_sms", "channelMode_email", "channelMode_dm"].map(
          (name) =>
            automationForm.locator(`select[name="${name}"]`).inputValue(),
        ),
      );
      const firstMode = currentModes.every((mode) => mode === "assist")
        ? "off"
        : "assist";
      for (const name of [
        "mode",
        "channelMode_sms",
        "channelMode_email",
        "channelMode_dm",
      ]) {
        await automationForm
          .locator(`select[name="${name}"]`)
          .selectOption(firstMode);
      }
      await automationForm
        .getByLabel("I reviewed these settings and their sending impact.")
        .check();
      await automationForm
        .getByRole("button", { name: "Save reviewed settings" })
        .click();
      await expect(automationForm.getByRole("status")).toContainText(
        "Sales Autopilot settings saved",
      );

      if (firstMode !== "assist") {
        await page.goto("/team/admin/automation");
        const secondForm = page
          .locator('form:has(select[name="channelMode_sms"])')
          .first();
        finalAutomationKey = await secondForm
          .locator('input[name="idempotencyKey"]')
          .inputValue();
        expect(finalAutomationKey).toMatch(
          /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u,
        );
        for (const name of [
          "mode",
          "channelMode_sms",
          "channelMode_email",
          "channelMode_dm",
        ]) {
          await secondForm
            .locator(`select[name="${name}"]`)
            .selectOption("assist");
        }
        await secondForm
          .getByLabel("I reviewed these settings and their sending impact.")
          .check();
        await secondForm
          .getByRole("button", { name: "Save reviewed settings" })
          .click();
        await expect(secondForm.getByRole("status")).toContainText(
          "Sales Autopilot settings saved",
        );
      }
      await expect
        .poll(() => getSettingValues())
        .toMatchObject({
          autopilotMode: "partial",
          dmMode: "assist",
          emailMode: "assist",
          smsMode: "assist",
        });

      const beforeSimulation = await getContactEffectCounts(fixture.contactId);
      const simulationOrigin = new URL(page.url()).origin;
      const simulation = await page.request.post("/api/team/simulated-chat", {
        headers: {
          Origin: simulationOrigin,
          "Sec-Fetch-Site": "same-origin",
        },
        data: {
          channel: "sms",
          simulationMode: "assist",
          contactId: fixture.contactId,
          messages: [
            {
              role: "customer",
              body: `Can you book this without my approval? ${fixture.marker}`,
            },
          ],
        },
      });
      const simulationText = await simulation.text();
      expect(simulation.ok(), simulationText).toBe(true);
      const simulationPayload = JSON.parse(simulationText) as {
        ok?: boolean;
        result?: {
          debug?: {
            realBookingCreated?: boolean;
            realMessageQueued?: boolean;
            simulationOnly?: boolean;
          };
          executedAction?: string;
          proposedAction?: string;
        };
      };
      expect(simulationPayload).toMatchObject({
        ok: true,
        result: {
          debug: {
            realBookingCreated: false,
            realMessageQueued: false,
            simulationOnly: true,
          },
        },
      });
      expect(simulationPayload.result?.proposedAction).toEqual(
        expect.any(String),
      );
      expect(simulationPayload.result?.executedAction).toMatch(
        /^(?:none|simulated_)/u,
      );
      expect(await getContactEffectCounts(fixture.contactId)).toEqual(
        beforeSimulation,
      );

      expect(await getConversationSnapshot(fixture)).toMatchObject({
        auditCount: 0,
        dispatchCount: 0,
        draft: true,
        outboxCount: 0,
        providerRequestKey: null,
      });
      await page.goto(
        `/team/inbox?threadId=${fixture.threadId}&contactId=${fixture.contactId}&channel=sms`,
      );
      const sendButton = page.getByRole("button", {
        name: /^(Send suggestion|Send now)$/,
      });
      const messageKey = await sendButton
        .locator("xpath=ancestor::form[1]")
        .locator('input[name="idempotencyKey"]')
        .inputValue();
      expect(messageKey).toMatch(/^message-send:[A-Za-z0-9-]{16,}$/u);
      await sendButton.click();
      await expect
        .poll(() => getConversationSnapshot(fixture))
        .toMatchObject({ auditCount: 1, draft: false, outboxCount: 1 });
      const dispatched = await expect
        .poll(() => getConversationSnapshot(fixture), { timeout: 15_000 })
        .toMatchObject({ dispatchCount: 1 })
        .then(() => getConversationSnapshot(fixture));
      expect(dispatched.dispatchState).toMatch(
        /^(?:requested|dispatched|succeeded|failed|reconciliation_required)$/u,
      );
      expect(dispatched.providerRequestKey).toMatch(/^[A-Za-z0-9._:-]{16,}$/u);
      await expectSuccessfulAuditActions(
        startedAt,
        ["policy.update", "sales.autopilot.policy.updated", "message.retry"],
        owner,
      );
      for (const expected of [
        {
          key: quietKey,
          action: "policy.update",
          entityId: "quiet_hours",
          permission: "policy.write",
        },
        {
          key: finalAutomationKey,
          action: "sales.autopilot.policy.updated",
          entityId: "sales_autopilot",
          permission: "automation.write",
        },
        {
          key: messageKey,
          action: "message.retry",
          entityId: fixture.draftMessageId,
          permission: "messages.send",
        },
      ]) {
        const evidence = await expect
          .poll(() => getMutationEvidence(expected.key, expected.action))
          .not.toBeNull()
          .then(() => getMutationEvidence(expected.key, expected.action));
        if (!evidence) throw new Error(`Missing ${expected.action} receipt.`);
        expect(evidence).toMatchObject({
          status: "succeeded",
          attemptCount: 1,
          responseStatus: 200,
          actorId: owner.memberId,
          outcome: "succeeded",
          entityId: expected.entityId,
          authMethod: "team_session",
        });
        expect(evidence.requiredPermissions).toContain(expected.permission);
        expect(evidence.idempotencyKeyHash).toMatch(/^[0-9a-f]{64}$/u);
        expect(evidence.responseBody).toMatchObject({
          ok: true,
          receipt: {
            operationId: evidence.operationId,
            correlationId: evidence.correlationId,
            actorId: owner.memberId,
            auditEventId: evidence.auditEventId,
            entityId: expected.entityId,
          },
        });
      }
    } finally {
      try {
        await restoreSettings([
          quietSnapshot,
          autopilotSnapshot,
          smsSnapshot,
          emailSnapshot,
          dmSnapshot,
        ]);
      } finally {
        await cleanupCustomerFixture(fixture.contactId);
      }
    }
  });

  test("custom role creation through revocation", async ({
    browser,
    page,
  }, testInfo) => {
    const owner = await getAuditActor();
    const marker = auditMarker("access").slice(0, 48);
    const slug = marker.toLowerCase();
    const email = `${marker}@mystos.test`;
    const roleName = `Audit Contacts ${marker.slice(-8)}`;
    const startedAt = new Date();
    let roleId: string | null = null;
    let memberId: string | null = null;
    let memberContext: BrowserContext | null = null;
    try {
      await page.goto("/team/admin/access#roles");
      const roleForm = page.locator('form[action="/api/team/access/roles"]');
      await roleForm.getByLabel("Role name").fill(roleName);
      await roleForm.getByLabel("Slug").fill(slug);
      await roleForm
        .locator('input[name="permissions"][value="contacts.read"]')
        .check();
      await roleForm
        .locator('input[name="permissions"][value="contacts.write"]')
        .check();
      await roleForm
        .locator('input[name="permissions"][value="expenses.export"]')
        .check();
      const roleCreateKey = await roleForm
        .locator('input[name="idempotencyKey"]')
        .inputValue();
      await roleForm
        .getByRole("button", { name: "Create reviewed role" })
        .click();
      const role = await expect
        .poll(() => findRoleBySlug(slug))
        .not.toBeNull()
        .then(() => findRoleBySlug(slug));
      if (!role) throw new Error("Custom audit role was not persisted.");
      roleId = role.id;
      expect(role.permissions).toEqual([
        "contacts.read",
        "contacts.write",
        "expenses.export",
      ]);

      const memberForm = page.locator(
        'form[action="/api/team/access/members"]',
      );
      const memberRole = memberForm.locator('select[name="roleId"]');
      await expect(memberForm).toBeVisible();
      await expect(
        memberRole.locator(`option[value="${role.id}"]`),
      ).toHaveCount(1);
      await memberForm
        .getByLabel("Name", { exact: true })
        .fill(`Audit Member ${marker.slice(-8)}`);
      await memberForm.getByLabel("Email", { exact: true }).fill(email);
      await memberRole.selectOption(role.id);
      const memberCreateKey = await memberForm
        .locator('input[name="idempotencyKey"]')
        .inputValue();
      await memberForm.getByRole("button", { name: "Add member" }).click();
      const initialMembership = await expect
        .poll(() => findRoleAndMember(slug, email))
        .not.toBeNull()
        .then(() => findRoleAndMember(slug, email));
      if (!initialMembership)
        throw new Error("Custom audit member was not persisted.");
      memberId = initialMembership.memberId;
      expect(initialMembership).toMatchObject({
        roleId: role.id,
        active: true,
        permissions: ["contacts.read", "contacts.write", "expenses.export"],
        permissionsGrant: [],
        permissionsDeny: [],
      });

      const bootstrapSession = await createTeamSessionRecordForMember(
        initialMembership.memberId,
      );
      const inheritedSnapshot = await getVerifiedTeamSessionSnapshot(
        bootstrapSession.token,
      );
      expect(inheritedSnapshot).toMatchObject({
        status: 200,
        ok: true,
        memberId: initialMembership.memberId,
      });
      expect(inheritedSnapshot.permissions).toEqual(
        expect.arrayContaining([
          "contacts.read",
          "contacts.write",
          "expenses.export",
          "sessions.manage_self",
        ]),
      );
      expect(inheritedSnapshot.permissions).not.toContain("expenses.read");

      await page.goto("/team/admin/access#members");
      const overrideForm = page.locator(
        `form[action="/api/team/access/members/${initialMembership.memberId}"]`,
      );
      await overrideForm
        .getByText("Individual permission overrides", { exact: true })
        .click();
      await overrideForm
        .locator('input[name="permissionsGrant"][value="expenses.read"]')
        .check();
      await overrideForm
        .locator('input[name="permissionsDeny"][value="contacts.write"]')
        .check();
      await overrideForm
        .locator('input[name="permissionsDeny"][value="expenses.export"]')
        .check();
      const overrideKey = await overrideForm
        .locator('input[name="idempotencyKey"]')
        .inputValue();
      await overrideForm.getByRole("button", { name: "Update" }).click();

      const membership = await expect
        .poll(async () => {
          const current = await findRoleAndMember(slug, email);
          return current?.permissionsGrant.includes("expenses.read") &&
            current.permissionsDeny.includes("contacts.write") &&
            current.permissionsDeny.includes("expenses.export")
            ? current
            : null;
        })
        .not.toBeNull()
        .then(() => findRoleAndMember(slug, email));
      if (!membership)
        throw new Error("Member permission overrides were not persisted.");
      expect(membership).toMatchObject({
        permissionsGrant: ["expenses.read"],
        permissionsDeny: ["contacts.write", "expenses.export"],
      });
      await expect
        .poll(() => getAccessRevocationSnapshot(membership.memberId))
        .toEqual({ active: true, activeSessions: 0 });
      expect(
        await getVerifiedTeamSessionSnapshot(bootstrapSession.token),
      ).toMatchObject({ status: 401, ok: false, memberId: null });

      const primarySession = await createTeamSessionRecordForMember(
        membership.memberId,
      );
      const secondarySession = await createTeamSessionRecordForMember(
        membership.memberId,
      );
      const effectiveSnapshot = await getVerifiedTeamSessionSnapshot(
        primarySession.token,
      );
      expect(effectiveSnapshot).toMatchObject({
        status: 200,
        ok: true,
        memberId: membership.memberId,
      });
      expect(effectiveSnapshot.permissions).toEqual(
        expect.arrayContaining([
          "contacts.read",
          "expenses.read",
          "sessions.manage_self",
        ]),
      );
      expect(effectiveSnapshot.permissions).not.toContain("contacts.write");
      expect(effectiveSnapshot.permissions).not.toContain("expenses.export");
      expect(effectiveSnapshot.permissions).not.toContain("audit.read");

      expect(
        (
          await auditTeamApiAsSession(
            primarySession.token,
            "/api/admin/contacts?limit=1",
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await auditTeamApiAsSession(
            primarySession.token,
            "/api/admin/expenses?limit=1",
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await auditTeamApiAsSession(
            primarySession.token,
            "/api/admin/contacts",
            { method: "POST", data: {} },
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await auditTeamApiAsSession(
            primarySession.token,
            "/api/admin/expenses/export",
          )
        ).status,
      ).toBe(403);
      expect(
        (await auditTeamApiAsSession(primarySession.token, "/api/admin/audit"))
          .status,
      ).toBe(403);

      memberContext = await browser.newContext({
        baseURL: getProjectBaseURL(testInfo),
        storageState: storageStateForToken(
          getProjectBaseURL(testInfo),
          primarySession.token,
        ),
      });
      const memberPage = await memberContext.newPage();
      await memberPage.goto("/team/contacts");
      await expect(memberPage).not.toHaveURL(/\/team\/login/);
      await expect(memberPage.locator("main")).toContainText("Contacts");
      const primaryNavigation = memberPage.getByRole("navigation", {
        name: "Primary team navigation",
      });
      await expect(
        primaryNavigation.getByRole("button", {
          name: "Contacts",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        primaryNavigation.getByRole("button", {
          name: "Expenses",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        primaryNavigation.getByRole("button", {
          name: "Audit Log",
          exact: true,
        }),
      ).toHaveCount(0);
      await memberPage.goto("/team/expenses");
      await expect(memberPage).toHaveURL(/\/team\/expenses/);
      await expect(memberPage.locator("main")).toContainText("Expenses");
      await memberPage.goto("/team/admin/audit");
      await expect(memberPage).toHaveURL(/\/team\/contacts/);

      await page.goto("/team/admin/access#sessions");
      // A hash-only navigation does not rerun the Access server loader. Refresh
      // through the product control so sessions created after the initial render
      // are visible before exercising the revocation workflow.
      await page
        .getByRole("button", { name: "Refresh sessions", exact: true })
        .click();
      const revokeSessionForm = page
        .locator(
          `input[name="sessionId"][value="${secondarySession.sessionId}"]`,
        )
        .locator("xpath=ancestor::form[1]");
      await expect(revokeSessionForm).toBeVisible();
      const sessionRevokeKey = await revokeSessionForm
        .locator('input[name="idempotencyKey"]')
        .inputValue();
      await revokeSessionForm
        .getByRole("button", { name: "Revoke this session" })
        .click();
      await expect
        .poll(() => getAccessRevocationSnapshot(membership.memberId))
        .toEqual({ active: true, activeSessions: 1 });
      expect(
        await getVerifiedTeamSessionSnapshot(secondarySession.token),
      ).toMatchObject({ status: 401, ok: false, memberId: null });
      expect(
        await getVerifiedTeamSessionSnapshot(primarySession.token),
      ).toMatchObject({ status: 200, ok: true, memberId: membership.memberId });

      await page.goto("/team/admin/access#members");
      const updateForm = page.locator(
        `form[action="/api/team/access/members/${membership.memberId}"]`,
      );
      const deactivateKey = await updateForm
        .locator('input[name="idempotencyKey"]')
        .inputValue();
      await updateForm.locator('input[name="active"]').uncheck();
      await updateForm.getByRole("button", { name: "Update" }).click();
      await expect
        .poll(() => getAccessRevocationSnapshot(membership.memberId))
        .toEqual({ active: false, activeSessions: 0 });

      await memberPage.goto("/team/contacts");
      await expect(memberPage).toHaveURL(/\/team\/login/);
      expect(
        await getVerifiedTeamSessionSnapshot(primarySession.token),
      ).toMatchObject({ status: 401, ok: false, memberId: null });
      await expectSuccessfulAuditActions(
        startedAt,
        [
          "role.created",
          "team_member.created",
          "team_member.updated",
          "team.session.revoked",
        ],
        owner,
      );
      for (const expected of [
        { key: roleCreateKey, action: "role.created", responseStatus: 201 },
        {
          key: memberCreateKey,
          action: "team_member.created",
          responseStatus: 201,
        },
        {
          key: overrideKey,
          action: "team_member.updated",
          responseStatus: 200,
        },
        {
          key: sessionRevokeKey,
          action: "team.session.revoked",
          responseStatus: 200,
        },
        {
          key: deactivateKey,
          action: "team_member.updated",
          responseStatus: 200,
        },
      ]) {
        const evidence = await expect
          .poll(() => getMutationEvidence(expected.key, expected.action))
          .not.toBeNull()
          .then(() => getMutationEvidence(expected.key, expected.action));
        if (!evidence) throw new Error(`Missing ${expected.action} receipt.`);
        expect(evidence).toMatchObject({
          status: "succeeded",
          attemptCount: 1,
          responseStatus: expected.responseStatus,
          actorId: owner.memberId,
          outcome: "succeeded",
          authMethod: "team_session",
        });
        expect(evidence.requiredPermissions).toContain("access.manage");
        expect(evidence.idempotencyKeyHash).toMatch(/^[0-9a-f]{64}$/u);
        expect(evidence.responseBody).toMatchObject({
          ok: true,
          receipt: {
            operationId: evidence.operationId,
            correlationId: evidence.correlationId,
            actorId: owner.memberId,
            auditEventId: evidence.auditEventId,
          },
        });
      }
    } finally {
      await memberContext?.close();
      await cleanupAccessFixture(roleId, memberId);
    }
  });
});
