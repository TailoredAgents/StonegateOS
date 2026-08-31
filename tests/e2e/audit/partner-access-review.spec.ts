import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext } from "@playwright/test";
import {
  cleanupPartnerAccessReviewFixture,
  closePartnerAccessReviewFixtures,
  findPartnerAccessReviewSnapshot,
  partnerAccessNotificationDeliveryState,
} from "./partner-access-review-fixtures";
import { waitForMailhogMessage } from "../support/mailhog";

test.use({ storageState: "tests/e2e/storage/visitor.json" });

test.afterAll(async () => {
  await closePartnerAccessReviewFixtures();
});

function magicLinkFromBody(body: string): string {
  const decoded = body.replace(/=\r?\n/gu, "").replace(/=3D/gu, "=");
  const link = decoded.match(
    /https?:\/\/[^\s<>]+\/partners\/auth\?token=[A-Za-z0-9_-]{32,256}/u,
  )?.[0];
  if (!link) throw new Error("The applicant email omitted its magic link.");
  return link;
}

test("applicant limited access becomes MFA-required administrator only after authorized staff approval", async ({
  browser,
  page,
  baseURL,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium-1440-light",
    "This state-changing review journey runs once in desktop Chromium.",
  );
  if (!baseURL) throw new Error("The audit Site base URL is required.");

  const marker = randomUUID().slice(0, 12);
  const email = `partner-e2e-access-${marker}@mystos.test`;
  const company = `Access Review ${marker}`;
  let staffContext: BrowserContext | null = null;

  try {
    await page.goto("/partners/request-access");
    await page.getByLabel("Full name").fill("Portal Access Reviewer");
    await page.getByLabel("Work email").fill(email);
    await page.getByLabel("Company name").fill(company);
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
      .getByRole("checkbox", { name: /I acknowledge the Privacy Policy/u })
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
    const mailedLoginUrl = new URL(magicLinkFromBody(message.Content.Body));
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
      page.getByRole("link", { name: "Billing & documents" }),
    ).toHaveCount(0);

    await expect
      .poll(() => findPartnerAccessReviewSnapshot(email))
      .toMatchObject({
        applicationStatus: "submitted",
        applicationVersion: 1,
        emailVerified: true,
        approvedAccountId: null,
        accountStatus: "trial_partner",
        accountPortalFit: "application_pending",
        portalAccessEnabled: true,
        mfaRequired: false,
        mfaEnrolled: false,
        membershipStatus: "active",
        membershipRoleKey: "applicant",
        membershipAccessLevel: "account",
        roleTemplateKey: "applicant",
        roleTemplateIsSystem: false,
        rateCardCount: 0,
        rateItemCount: 0,
        decisionAuditCount: 0,
      });
    const limited = await findPartnerAccessReviewSnapshot(email);
    expect(limited?.roleTemplateAccountId).toBe(limited?.bootstrapAccountId);

    staffContext = await browser.newContext({
      baseURL,
      storageState: "tests/e2e/storage/audit-owner.json",
    });
    const staffPage = await staffContext.newPage();
    await staffPage.goto("/team/sales/outbound/partners");
    await expect(
      staffPage.getByRole("heading", {
        name: "Partner Portal access applications",
      }),
    ).toBeVisible();
    const applicationCard = staffPage
      .getByRole("listitem")
      .filter({ hasText: email });
    await expect(applicationCard).toHaveCount(1);
    await expect(
      applicationCard.getByRole("heading", { name: company, exact: true }),
    ).toBeVisible();
    await applicationCard
      .getByText("Approve administrator access", { exact: true })
      .click();
    await applicationCard.getByLabel("Type APPROVE").fill("APPROVE");
    await applicationCard
      .getByRole("button", { name: "Approve access" })
      .click();

    const feedback = staffPage.locator("[data-team-flash]").first();
    await expect(feedback).toHaveAttribute("data-team-flash", "success");
    await expect(feedback).toContainText("Partner access approved");
    await expect(
      staffPage.getByRole("listitem").filter({ hasText: email }),
    ).toHaveCount(0);

    await expect
      .poll(() => findPartnerAccessReviewSnapshot(email))
      .toMatchObject({
        applicationStatus: "approved",
        applicationVersion: 2,
        emailVerified: true,
        accountStatus: "portal_partner",
        accountPortalFit: "application_approved",
        portalAccessEnabled: true,
        mfaRequired: true,
        mfaEnrolled: false,
        membershipStatus: "active",
        membershipRoleKey: "admin",
        membershipAccessLevel: "account",
        roleTemplateKey: "admin",
        roleTemplateAccountId: null,
        roleTemplateIsSystem: true,
        rateCardCount: 0,
        rateItemCount: 0,
        decisionAuditCount: 1,
        instantConfirmationGrantedDirectly: false,
        commercialConfigurationChanged: false,
      });
    const approved = await findPartnerAccessReviewSnapshot(email);
    expect(approved?.approvedAccountId).toBe(approved?.bootstrapAccountId);

    // Exercise the same authenticated Site boundary used by the browser. The
    // API intentionally accepts a bearer session from this trusted proxy, not
    // a portal cookie sent directly to the API origin.
    const meResponse = await page.request.get("/api/partners/portal/me");
    expect(meResponse.status()).toBe(200);
    const me = (await meResponse.json()) as {
      membership?: { roleKey?: unknown };
      security?: {
        mfaRequired?: unknown;
        mfaEnrolled?: unknown;
        mfaSatisfied?: unknown;
      };
    };
    expect(me.membership?.roleKey).toBe("admin");
    expect(me.security).toMatchObject({
      mfaRequired: true,
      mfaEnrolled: false,
      mfaSatisfied: false,
    });

    const privilegedResponse = await page.request.get(
      "/api/partners/portal/members?limit=1",
    );
    expect(privilegedResponse.status()).toBe(403);
    expect(await privilegedResponse.json()).toMatchObject({
      ok: false,
      error: "mfa_step_up_required",
    });

    // Account-access email is transactional but not an urgent same-day
    // schedule change. It must either reach the provider or remain durably
    // deferred when the account-local quiet-hours policy is active.
    await expect
      .poll(() => partnerAccessNotificationDeliveryState(email))
      .toMatch(/^(delivered|quiet_hours_deferred)$/u);
  } finally {
    await staffContext?.close();
    await cleanupPartnerAccessReviewFixture(email);
  }
});
