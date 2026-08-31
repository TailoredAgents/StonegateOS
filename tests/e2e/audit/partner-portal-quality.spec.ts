import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { PARTNER_SESSION_COOKIE } from "../../../apps/site/src/lib/partner-session";
import { waitForMailhogMessage } from "../support/mailhog";
import { expectTeamStateToPassAutomatedWcag } from "./accessibility";
import {
  cleanupPartnerBookingFixture,
  closePartnerBookingFixtures,
  createPartnerBookingFixture,
} from "./partner-booking-fixtures";
import {
  cleanupPartnerApplicantFixture,
  closePartnerAccessReviewFixtures,
} from "./partner-access-review-fixtures";

test.use({ storageState: "tests/e2e/storage/visitor.json" });

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test.afterAll(async () => {
  await closePartnerBookingFixtures();
  await closePartnerAccessReviewFixtures();
});

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1,
      ),
    )
    .toBe(true);
}

test("Partner Portal public entry points are responsive and pass the automated WCAG gate", async ({
  page,
}, testInfo) => {
  for (const [path, heading, surface] of [
    ["/partners/login", "Sign in to your portal", "partner-login"],
    [
      "/partners/request-access",
      "Request partner access",
      "partner-request-access",
    ],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectTeamStateToPassAutomatedWcag({
      page,
      testInfo,
      surface,
      state: "normal",
    });
  }
});

test("a new applicant verifies email, enters the limited workspace, and cannot reuse the magic link", async ({
  page,
  baseURL,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium-1440-light",
    "The acquisition journey creates one disposable applicant account.",
  );
  if (!baseURL) throw new Error("The audit Site base URL is required.");
  const marker = randomUUID().slice(0, 12);
  const email = `partner-applicant-${marker}@mystos.test`;

  try {
    await page.goto("/partners/request-access");
    await page.getByLabel("Full name").fill("Limited Portal Applicant");
    await page.getByLabel("Work email").fill(email);
    await page.getByLabel("Company name").fill(`Applicant Company ${marker}`);
    await page.getByLabel("Partner type").selectOption("property_manager");
    await page
      .getByRole("checkbox", { name: "Schedule pickups and jobs" })
      .check();
    await page
      .getByRole("checkbox", {
        name: /I agree to the Terms and Service Agreement/u,
      })
      .check();
    await page
      .getByRole("checkbox", {
        name: /I acknowledge the Privacy Policy/u,
      })
      .check();
    await page.getByRole("button", { name: "Request partner access" }).click();
    await expect(
      page.getByRole("heading", { name: "Check your email" }),
    ).toBeVisible();

    const message = await waitForMailhogMessage(
      (candidate) =>
        Object.values(candidate.Content.Headers)
          .flat()
          .some((value) => value.toLowerCase().includes(email.toLowerCase())),
      { timeoutMs: 20_000 },
    );
    const decodedBody = message.Content.Body.replace(/=\r?\n/gu, "").replace(
      /=3D/gu,
      "=",
    );
    const loginUrl = decodedBody.match(
      /https?:\/\/[^\s<>]+\/partners\/auth\?token=[A-Za-z0-9_-]{32,256}/u,
    )?.[0];
    if (!loginUrl)
      throw new Error("The applicant email omitted its sign-in URL.");
    const token = new URL(loginUrl).searchParams.get("token");
    if (!token) throw new Error("The applicant sign-in URL omitted its token.");

    // Transactional email uses the configured public production-shaped host.
    // Keep the exact signed path/token while routing the browser through the
    // local Site origin used by this isolated E2E environment.
    const mailedLoginUrl = new URL(loginUrl);
    const localLoginUrl = new URL(
      `${mailedLoginUrl.pathname}${mailedLoginUrl.search}`,
      baseURL,
    );
    await page.goto(localLoginUrl.toString());
    await expect(page).toHaveURL(/\/partners\?setup=1$/u);
    await expect(
      page.getByRole("heading", { name: /Welcome back,/u, level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Schedule job" }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Billing & documents" }),
    ).toHaveCount(0);

    const apiBase = (
      process.env["NEXT_PUBLIC_API_BASE_URL"] ?? "http://localhost:3001"
    ).replace(/\/+$/u, "");
    const replay = await page.request.post(
      `${apiBase}/api/portal/v2/auth/magic-link/consume`,
      {
        headers: { Origin: new URL(baseURL).origin },
        data: { token, rememberMe: false },
      },
    );
    expect(replay.status()).toBe(401);
  } finally {
    await cleanupPartnerApplicantFixture(email);
  }
});

test("Partner Portal authenticated shell, overview, and scheduler are responsive and accessible", async ({
  page,
  baseURL,
}, testInfo) => {
  if (!baseURL) throw new Error("The audit Site base URL is required.");
  const fixture = await createPartnerBookingFixture();
  const siteUrl = new URL(baseURL);

  try {
    await page.context().addCookies([
      {
        name: PARTNER_SESSION_COOKIE,
        value: fixture.sessionToken,
        domain: siteUrl.hostname,
        path: "/",
        httpOnly: true,
        secure: siteUrl.protocol === "https:",
        sameSite: "Lax",
      },
    ]);

    await page.goto("/partners");
    await expect(
      page.getByRole("heading", { name: /Welcome back,/u, level: 1 }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectTeamStateToPassAutomatedWcag({
      page,
      testInfo,
      surface: "partner-overview",
      state: "normal",
    });

    const viewport = page.viewportSize();
    if (viewport && viewport.width < 1024) {
      const openNavigation = page.getByRole("button", {
        name: "Open navigation",
      });
      await openNavigation.click();
      const drawer = page.getByRole("dialog", {
        name: "Partner portal navigation",
      });
      await expect(drawer).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Close navigation" }),
      ).toBeFocused();
      await expectTeamStateToPassAutomatedWcag({
        page,
        testInfo,
        surface: "partner-navigation",
        state: "drawer",
      });
      await page.keyboard.press("Escape");
      await expect(drawer).toBeHidden();
      await expect(openNavigation).toBeFocused();
    }

    await page.goto(
      `/partners/book?locationId=${fixture.locationId}&serviceKey=junk-removal`,
    );
    await expect(
      page.getByRole("heading", { name: "Schedule a job", level: 1 }),
    ).toBeVisible();
    await expect(page.getByText("All changes saved")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectTeamStateToPassAutomatedWcag({
      page,
      testInfo,
      surface: "partner-schedule-job",
      state: "normal",
    });
  } finally {
    await cleanupPartnerBookingFixture(fixture);
  }
});
