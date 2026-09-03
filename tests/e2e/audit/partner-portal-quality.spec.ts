import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { PARTNER_APPLICATION_SESSION_COOKIE } from "../../../apps/site/src/lib/partner-application-session";
import { PARTNER_SESSION_COOKIE } from "../../../apps/site/src/lib/partner-session";
import { waitForMailhogMessage } from "../support/mailhog";
import { expectTeamStateToPassAutomatedWcag } from "./accessibility";
import {
  cleanupPartnerBookingFixture,
  closePartnerBookingFixtures,
  createPartnerBookingFixture,
  getNoLeadPartnerBookingSnapshot,
} from "./partner-booking-fixtures";
import {
  cleanupPartnerApplicantFixture,
  closePartnerAccessReviewFixtures,
  findPartnerAccessReviewSnapshot,
  resetPartnerAccessReviewRateLimits,
} from "./partner-access-review-fixtures";

test.use({ storageState: "tests/e2e/storage/visitor.json" });

const BOOKING_SCOPE_LABEL =
  /What (?:needs to be done|should be completed at the facility)\?/u;

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

test(
  "Partner Portal landing prioritizes sign-in and presents an accessible product record",
  {
    tag: "@partner-landing-public",
  },
  async ({ page }, testInfo) => {
    const navigationResponse = await page.goto("/partners");
    expect(navigationResponse?.status()).toBe(200);
    const serverHtml = await navigationResponse?.text();
    expect(serverHtml).toContain(
      "Schedule, track, and document every Stonegate job.",
    );
    expect(serverHtml).toContain('rel="canonical"');
    expect(serverHtml).toContain('property="og:image"');

    await expect(page).toHaveTitle("For Partners | Stonegate Partner Portal");
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      "content",
      /junk removal[\s\S]*locations[\s\S]*photos[\s\S]*proof[\s\S]*billing/u,
    );
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      /\/partners$/u,
    );
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      /index/u,
    );
    const socialImageUrl = await page
      .locator('meta[property="og:image"]')
      .getAttribute("content");
    expect(socialImageUrl).toMatch(/\/partners\/social-image$/u);

    if (testInfo.project.name === "chromium-1440-light") {
      if (!socialImageUrl) {
        throw new Error("Partner social image URL is missing");
      }
      const socialImageResponse = await page.request.get(socialImageUrl);
      expect(socialImageResponse.status()).toBe(200);
      expect(socialImageResponse.headers()["content-type"]).toMatch(
        /^image\/png/u,
      );
    }

    await expect(
      page.getByRole("heading", {
        name: "Schedule, track, and document every Stonegate job.",
        level: 1,
      }),
    ).toBeVisible();

    const accessOptions = page.getByRole("navigation", {
      name: "Partner access options",
    });
    const signIn = accessOptions.getByRole("link", { name: "Sign in" });
    const requestAccess = accessOptions.getByRole("link", {
      name: "Request access",
    });
    await expect(signIn).toHaveAttribute("href", "/partners/login");
    await expect(signIn).toHaveClass(/bg-primary-900/u);
    await expect(requestAccess).toHaveAttribute(
      "href",
      "/partners/request-access",
    );

    const preview = page.getByRole("figure");
    await expect(
      preview.getByText("Property cleanout", { exact: true }),
    ).toBeVisible();
    await expect(
      preview.getByText("Sample property", { exact: true }),
    ).toBeVisible();
    await expect(preview.getByText("Completion report ready")).toBeVisible();
    const proofImage = preview.getByRole("img", {
      name: "Before and after view of a completed garage cleanout",
    });
    await expect(proofImage).toBeVisible();
    await expect
      .poll(() =>
        proofImage.evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBe(720);

    const brandHeader = page.locator("header").first();
    await expect(brandHeader.locator('a[href="/"]')).toHaveCount(1);
    await expect(
      brandHeader.getByRole("link", { name: "Partner Portal", exact: true }),
    ).toHaveAttribute("href", "/partners");

    const firstQuestion = page.locator("details").first();
    const firstSummary = firstQuestion.locator("summary");
    await firstSummary.focus();
    await firstSummary.press("Enter");
    await expect(firstQuestion).toHaveAttribute("open", "");

    await expectNoHorizontalOverflow(page);
    await expectTeamStateToPassAutomatedWcag({
      page,
      testInfo,
      surface: "partner-landing",
      state: "normal",
    });

    if (testInfo.project.name === "chromium-1440-light") {
      for (const [name, locator] of [
        [
          "partner-landing-hero",
          page.locator('section[aria-labelledby="partner-landing-title"]'),
        ],
        ["partner-landing-example-workspace", preview],
        [
          "partner-landing-access-and-faq",
          page.locator('section[aria-labelledby="partner-access-heading"]'),
        ],
      ] as const) {
        await testInfo.attach(name, {
          body: await locator.screenshot({ animations: "disabled" }),
          contentType: "image/png",
        });
      }
      await testInfo.attach("partner-landing-full-page", {
        body: await page.screenshot({
          animations: "disabled",
          fullPage: true,
        }),
        contentType: "image/png",
      });
    }

    if (testInfo.project.name === "chromium-375-light") {
      await testInfo.attach("partner-landing-mobile-header", {
        body: await brandHeader.screenshot({ animations: "disabled" }),
        contentType: "image/png",
      });
    }
  },
);

test(
  "Partner Portal landing remains complete without client JavaScript",
  { tag: "@partner-landing-public" },
  async ({ browser, baseURL }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-1440-light",
      "One representative no-JavaScript pass is sufficient.",
    );
    if (!baseURL) throw new Error("The audit Site base URL is required.");

    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    try {
      const response = await page.goto(
        new URL("/partners", baseURL).toString(),
      );
      expect(response?.status()).toBe(200);
      await expect(
        page.getByRole("heading", {
          name: "Schedule, track, and document every Stonegate job.",
          level: 1,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Sign in", exact: true }),
      ).toHaveCount(3);
      await expect(
        page.getByRole("link", { name: "Request access", exact: true }),
      ).toHaveCount(2);
      await expectNoHorizontalOverflow(page);
    } finally {
      await context.close();
    }
  },
);

test(
  "Partner Portal landing reflows at 200 and 400 percent effective zoom",
  { tag: "@partner-zoom" },
  async ({ page }) => {
    await page.goto("/partners");
    await expect(
      page.getByRole("heading", {
        name: "Schedule, track, and document every Stonegate job.",
        level: 1,
      }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);

    const accessOptions = page.getByRole("navigation", {
      name: "Partner access options",
    });
    for (const action of await accessOptions.getByRole("link").all()) {
      const box = await action.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  },
);

test("Partner Portal public entry points are responsive and pass the automated WCAG gate", async ({
  page,
}, testInfo) => {
  for (const [path, heading, surface] of [
    ["/partners/login", "Sign in to your portal", "partner-login"],
    [
      "/partners/request-access",
      "Start with your verified work email.",
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

test("a new applicant verifies email, submits an authority-free application, and cannot replay the link", async ({
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
    await resetPartnerAccessReviewRateLimits();
    await page.goto("/partners/request-access");
    await expect(page.getByLabel("Full name")).toHaveCount(0);
    await expect(page.getByLabel("Company name")).toHaveCount(0);
    await page.getByLabel("Work email").fill(email);
    await page
      .getByRole("button", { name: "Email me a verification link" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Check your work email" }),
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
    const verificationUrl = decodedBody.match(
      /https?:\/\/[^\s<>]+\/partners\/verify\?token=[A-Za-z0-9_-]{32,256}/u,
    )?.[0];
    if (!verificationUrl) {
      throw new Error("The applicant email omitted its verification URL.");
    }
    const token = new URL(verificationUrl).searchParams.get("token");
    if (!token) {
      throw new Error("The applicant verification URL omitted its token.");
    }

    // Transactional email uses the configured public production-shaped host.
    // Keep the exact signed path/token while routing the browser through the
    // local Site origin used by this isolated E2E environment.
    const mailedVerificationUrl = new URL(verificationUrl);
    const localVerificationUrl = new URL(
      `${mailedVerificationUrl.pathname}${mailedVerificationUrl.search}`,
      baseURL,
    );
    await page.goto(localVerificationUrl.toString());
    await expect(page).toHaveURL(/\/partners\/application\?verified=1$/u);
    await expect(
      page.getByRole("heading", {
        name: "Complete your partner application",
        level: 1,
      }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Email verified. Complete the application below; no company workspace or membership exists until approval.",
      ),
    ).toBeVisible();
    const applicantCookies = await page.context().cookies();
    expect(
      applicantCookies.some(
        (cookie) =>
          cookie.name === PARTNER_APPLICATION_SESSION_COOKIE &&
          cookie.value.length > 0,
      ),
    ).toBe(true);
    expect(
      applicantCookies.some((cookie) => cookie.name === PARTNER_SESSION_COOKIE),
    ).toBe(false);

    await page.getByLabel("Full name").fill("Limited Portal Applicant");
    await page.getByLabel("Company name").fill(`Applicant Company ${marker}`);
    await page.getByLabel("Partner type").selectOption("property_manager");
    await page
      .getByRole("checkbox", { name: "Schedule pickups and jobs" })
      .check();
    await page
      .getByRole("radio", {
        name: /Create a company workspace if approved/u,
      })
      .check();
    await page.locator("#application-termsAccepted").check();
    await page.locator("#application-privacyAccepted").check();
    await page.getByRole("button", { name: "Submit for review" }).click();
    await expect(
      page.getByRole("heading", { name: "Application submitted", level: 1 }),
    ).toBeVisible();

    await expect
      .poll(() => findPartnerAccessReviewSnapshot(email))
      .toMatchObject({
        applicationStatus: "submitted",
        applicationFlowVersion: 2,
        emailVerified: true,
        applicantSessionActive: true,
        verificationChallengeStatus: "consumed",
        bootstrapAccountId: null,
        requestedAccountId: null,
        approvedAccountId: null,
        authorityAccountCount: 0,
        canonicalIdentityCount: 0,
        partnerUserId: null,
        membershipCount: 0,
        membershipId: null,
        crmContactCount: 0,
        portalSessionCount: 0,
        activationChallengeCount: 0,
      });

    const apiBase = (
      process.env["API_BASE_URL"] ??
      process.env["NEXT_PUBLIC_API_BASE_URL"] ??
      "http://localhost:3001"
    ).replace(/\/+$/u, "");
    const replay = await page.request.post(
      `${apiBase}/api/portal/v2/onboarding/email-challenges/consume`,
      {
        headers: { Origin: new URL(baseURL).origin },
        data: { token },
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
  if (testInfo.project.name === "chromium-1440-light") {
    testInfo.setTimeout(180_000);
  }
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
      page.getByRole("heading", {
        name: "Schedule facility service",
        level: 1,
      }),
    ).toBeVisible();
    await expect(page.getByText("All changes saved")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectTeamStateToPassAutomatedWcag({
      page,
      testInfo,
      surface: "partner-schedule-job",
      state: "normal",
    });

    if (testInfo.project.name === "chromium-1440-light") {
      const scopeText = `Remove staged furniture and boxed material. Quality ${fixture.marker}`;
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(
        page.getByRole("heading", { name: "Service & scope" }),
      ).toBeVisible();
      await page
        .getByRole("textbox", { name: BOOKING_SCOPE_LABEL })
        .fill(scopeText);
      await page.getByRole("button", { name: "Continue" }).click();

      await expect(
        page.getByRole("heading", { name: "Contact & access" }),
      ).toBeVisible();
      await page.getByLabel("On-site contact name").fill("Quality Site Lead");
      await page.getByLabel("Mobile phone").fill(fixture.partnerPhoneE164);
      await page.getByRole("button", { name: "Continue" }).click();

      await expect(
        page.getByRole("heading", { name: "Photos & proof" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Continue" }).click();

      await expect(
        page.getByRole("heading", { name: "Choose an arrival window" }),
      ).toBeVisible();
      const arrivalWindows = page.locator("fieldset button[aria-pressed]");
      await expect(arrivalWindows.first()).toBeVisible();
      await arrivalWindows.last().click();
      await expect(page.getByText(/Arrival window held:/u)).toBeVisible();
      await page.getByRole("button", { name: "Continue" }).click();

      await expect(
        page.getByRole("heading", { name: "Review & send" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Send service request" }).click();
      await expect(page).toHaveURL(
        /\/partners\/bookings\/[0-9a-f-]+\?created=1$/iu,
      );
      const bookingId = new URL(page.url()).pathname.split("/").at(-1);
      if (!bookingId) throw new Error("Partner booking ID was not returned.");

      await expect
        .poll(() => getNoLeadPartnerBookingSnapshot(fixture, bookingId), {
          timeout: 20_000,
        })
        .not.toBeNull();
      const snapshot = await getNoLeadPartnerBookingSnapshot(
        fixture,
        bookingId,
      );
      if (!snapshot) throw new Error("Partner booking snapshot was not found.");
      expect(snapshot).toMatchObject({
        appointmentLeadId: null,
        appointmentPartnerAccountId: fixture.partnerAccountId,
        appointmentQuotedTotalCents: 25_000,
        appointmentQuotedScopeText: scopeText,
        bookingPartnerAccountId: fixture.partnerAccountId,
        bookingServiceKey: "junk-removal",
        bookingAmountCents: 25_000,
        bookingScopeDescription: scopeText,
      });
      expect(snapshot.appointmentPartnerAccountId).toBe(
        snapshot.bookingPartnerAccountId,
      );
      expect(snapshot.appointmentQuotedTotalCents).toBe(
        snapshot.bookingAmountCents,
      );
      expect(snapshot.appointmentQuotedScopeText).toBe(
        snapshot.bookingScopeDescription,
      );
    }
  } finally {
    await cleanupPartnerBookingFixture(fixture);
  }
});
