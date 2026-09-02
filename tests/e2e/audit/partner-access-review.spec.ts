import { createHmac, randomUUID } from "node:crypto";
import { expect, test, type BrowserContext } from "@playwright/test";
import {
  PARTNER_ACTIVATION_TOKEN_COOKIE,
  PARTNER_APPLICATION_SESSION_COOKIE,
} from "../../../apps/site/src/lib/partner-application-session";
import { PARTNER_SESSION_COOKIE } from "../../../apps/site/src/lib/partner-session";
import {
  cleanupPartnerAccessReviewFixture,
  closePartnerAccessReviewFixtures,
  findPartnerAccessReviewSnapshot,
  markAuditOwnerSessionMfaVerifiedForPartnerReview,
  resetPartnerAccessReviewRateLimits,
} from "./partner-access-review-fixtures";
import { waitForMailhogMessage } from "../support/mailhog";

test.use({ storageState: "tests/e2e/storage/visitor.json" });

test.afterAll(async () => {
  await closePartnerAccessReviewFixtures();
});

function purposeLinkFromBody(
  body: string,
  path: "/partners/verify" | "/partners/activate",
): string {
  const decoded = body.replace(/=\r?\n/gu, "").replace(/=3D/gu, "=");
  const escapedPath = path.replaceAll("/", "\\/");
  const link = decoded.match(
    new RegExp(
      `https?:\\/\\/[^\\s<>]+${escapedPath}\\?token=[A-Za-z0-9_-]{32,256}`,
      "u",
    ),
  )?.[0];
  if (!link) throw new Error(`The applicant email omitted its ${path} link.`);
  return link;
}

function localPurposeUrl(mailedUrl: string, baseURL: string): URL {
  const parsed = new URL(mailedUrl);
  return new URL(`${parsed.pathname}${parsed.search}`, baseURL);
}

function decodeBase32(secret: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const normalized = secret.trim().toUpperCase().replace(/=+$/u, "");
  if (!/^[A-Z2-7]{16,128}$/u.test(normalized)) {
    throw new Error("The activation page returned an invalid TOTP secret.");
  }
  let accumulator = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const character of normalized) {
    const value = alphabet.indexOf(character);
    if (value < 0) throw new Error("The TOTP secret is not base32.");
    accumulator = (accumulator << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bytes.push((accumulator >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function currentTotp(secret: string): string {
  const counter = Math.floor(Date.now() / 1_000 / 30);
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", decodeBase32(secret))
    .update(counterBytes)
    .digest();
  const offset = (digest.at(-1) ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    ((digest[offset + 1] ?? 0) << 16) |
    ((digest[offset + 2] ?? 0) << 8) |
    (digest[offset + 3] ?? 0);
  return String(binary % 1_000_000).padStart(6, "0");
}

async function assertApplicantOnlyCookies(
  context: BrowserContext,
): Promise<void> {
  const cookies = await context.cookies();
  expect(
    cookies.some(
      (cookie) =>
        cookie.name === PARTNER_APPLICATION_SESSION_COOKIE &&
        cookie.value.length > 0,
    ),
  ).toBe(true);
  expect(
    cookies.some(
      (cookie) => cookie.name === PARTNER_SESSION_COOKIE && cookie.value.length,
    ),
  ).toBe(false);
}

test("verification-first applicant becomes an active MFA administrator only after approval and activation", async ({
  browser,
  page,
  baseURL,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium-1440-light",
    "This state-changing review journey runs once in desktop Chromium.",
  );
  test.setTimeout(120_000);
  if (!baseURL) throw new Error("The audit Site base URL is required.");

  const marker = randomUUID().slice(0, 12);
  const email = `partner-e2e-access-${marker}@mystos.test`;
  const company = `Access Review ${marker}`;
  const password = `E2E-${marker}-Glass-River-Cobalt!`;
  let staffContext: BrowserContext | null = null;

  try {
    await resetPartnerAccessReviewRateLimits();
    await page.goto("/partners/request-access");
    await expect(page.getByLabel("Work email")).toBeVisible();
    await expect(page.getByLabel("Full name")).toHaveCount(0);
    await expect(page.getByLabel("Company name")).toHaveCount(0);
    await page.getByLabel("Work email").fill(email);
    await page
      .getByRole("button", { name: "Email me a verification link" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Check your work email" }),
    ).toBeVisible();

    const verificationMessage = await waitForMailhogMessage(
      (candidate) =>
        Object.values(candidate.Content.Headers)
          .flat()
          .some((value) => value.toLowerCase().includes(email.toLowerCase())) &&
        candidate.Content.Body.includes("/partners/verify"),
      { timeoutMs: 20_000 },
    );
    const verificationUrl = purposeLinkFromBody(
      verificationMessage.Content.Body,
      "/partners/verify",
    );
    const verificationToken = new URL(verificationUrl).searchParams.get(
      "token",
    );
    if (!verificationToken) {
      throw new Error("The email-verification URL omitted its token.");
    }
    await page.goto(localPurposeUrl(verificationUrl, baseURL).toString());
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
    await assertApplicantOnlyCookies(page.context());

    await page.getByLabel("Full name").fill("Portal Access Reviewer");
    await page.getByLabel("Company name").fill(company);
    await page.getByLabel("Partner type").selectOption("property_manager");
    await page.getByLabel("Primary service areas").fill("Atlanta, GA");
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
        applicationVersion: 1,
        applicationFlowVersion: 2,
        emailVerified: true,
        applicantSessionActive: true,
        verificationChallengeStatus: "consumed",
        bootstrapAccountId: null,
        requestedAccountId: null,
        approvedAccountId: null,
        authorityAccountCount: 0,
        accountStatus: null,
        portalAccessEnabled: null,
        partnerUserId: null,
        canonicalIdentityCount: 0,
        identityActive: null,
        identityStatus: null,
        passwordSet: false,
        membershipId: null,
        membershipCount: 0,
        crmContactCount: 0,
        portalSessionCount: 0,
        activationChallengeCount: 0,
        decisionAuditCount: 0,
      });
    await assertApplicantOnlyCookies(page.context());

    const apiBase = (
      process.env["API_BASE_URL"] ??
      process.env["NEXT_PUBLIC_API_BASE_URL"] ??
      "http://localhost:3001"
    ).replace(/\/+$/u, "");
    const replay = await page.request.post(
      `${apiBase}/api/portal/v2/onboarding/email-challenges/consume`,
      {
        headers: { Origin: new URL(baseURL).origin },
        data: { token: verificationToken },
      },
    );
    expect(replay.status()).toBe(401);

    await markAuditOwnerSessionMfaVerifiedForPartnerReview();
    staffContext = await browser.newContext({
      baseURL,
      storageState: "tests/e2e/storage/audit-owner.json",
    });
    const staffPage = await staffContext.newPage();
    await staffPage.goto("/team/partners?p_admin=applications");
    await expect(
      staffPage.getByRole("heading", {
        name: "Partner Portal access applications",
      }),
    ).toBeVisible();
    const applicationHeading = staffPage.getByRole("heading", {
      name: company,
      exact: true,
    });
    await expect(applicationHeading).toHaveCount(1);
    const applicationCard = applicationHeading.locator("xpath=ancestor::li[1]");
    await expect(applicationCard).toContainText(email);
    await applicationCard
      .getByText("Approve new company workspace", { exact: true })
      .click();
    await expect(applicationCard.locator('input[name="roleKey"]')).toHaveValue(
      "administrator",
    );
    await expect(
      applicationCard.locator('input[name="accessLevel"]'),
    ).toHaveValue("account");
    await applicationCard.getByLabel("Type APPROVE").fill("APPROVE");
    await applicationCard
      .getByRole("button", { name: "Approve access" })
      .click();

    const feedback = staffPage.locator("[data-team-flash]").first();
    await expect(feedback).toHaveAttribute("data-team-flash", "success");
    await expect(feedback).toContainText(
      "applicant must complete activation before signing in",
    );
    await expect(applicationHeading).toHaveCount(0);

    await expect
      .poll(() => findPartnerAccessReviewSnapshot(email))
      .toMatchObject({
        applicationStatus: "approved",
        applicationVersion: 2,
        applicationFlowVersion: 2,
        bootstrapAccountId: null,
        requestedAccountId: null,
        authorityAccountCount: 1,
        accountStatus: "portal_partner",
        accountPortalFit: "application_approved",
        portalAccessEnabled: true,
        accountPortalContactId: null,
        canonicalIdentityCount: 1,
        identityActive: false,
        identityStatus: "pending_activation",
        identityOrgContactId: null,
        passwordSet: false,
        mfaRequired: true,
        mfaEnrolled: false,
        membershipCount: 1,
        membershipStatus: "invited",
        membershipAccepted: false,
        membershipRoleKey: "administrator",
        membershipAccessLevel: "account",
        membershipIsDefault: true,
        roleTemplateKey: "administrator",
        roleTemplateAccountId: null,
        roleTemplateIsSystem: true,
        crmContactCount: 0,
        portalSessionCount: 0,
        activationChallengeCount: 1,
        activationChallengeStatus: "pending",
        activationDeliveryQueued: true,
        rateCardCount: 0,
        rateItemCount: 0,
        decisionAuditCount: 1,
        instantConfirmationGrantedDirectly: false,
        commercialConfigurationChanged: false,
      });
    const approved = await findPartnerAccessReviewSnapshot(email);
    expect(approved?.approvedAccountId).toBeTruthy();
    expect(approved?.activationDeliveryStatus).toMatch(
      /^(queued|dispatching|accepted)$/u,
    );
    await assertApplicantOnlyCookies(page.context());

    const activationMessage = await waitForMailhogMessage(
      (candidate) =>
        Object.values(candidate.Content.Headers)
          .flat()
          .some((value) => value.toLowerCase().includes(email.toLowerCase())) &&
        candidate.Content.Body.includes("/partners/activate"),
      { timeoutMs: 20_000 },
    );
    const activationUrl = purposeLinkFromBody(
      activationMessage.Content.Body,
      "/partners/activate",
    );
    const activationToken = new URL(activationUrl).searchParams.get("token");
    if (!activationToken) {
      throw new Error("The account-activation URL omitted its token.");
    }
    const activationNavigation = await page.goto(
      localPurposeUrl(activationUrl, baseURL).toString(),
    );
    await expect(page).toHaveURL(/\/partners\/activate$/u);
    expect(page.url()).not.toContain("token=");
    expect(activationNavigation?.headers()["cache-control"]).toContain(
      "no-store",
    );
    const activationRedirectRequest = activationNavigation
      ?.request()
      .redirectedFrom();
    const activationRedirectResponse =
      await activationRedirectRequest?.response();
    expect(activationRedirectResponse?.status()).toBe(303);
    expect(activationRedirectResponse?.headers()["cache-control"]).toContain(
      "no-store",
    );
    expect(activationRedirectResponse?.headers()["referrer-policy"]).toBe(
      "no-referrer",
    );
    const activationCookie = (await page.context().cookies()).find(
      (cookie) => cookie.name === PARTNER_ACTIVATION_TOKEN_COOKIE,
    );
    expect(activationCookie).toMatchObject({
      value: activationToken,
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
    });
    await expect(
      page.getByRole("heading", {
        name: "Activate your partner access",
        level: 1,
      }),
    ).toBeVisible();
    await page.locator("#activation-password").fill(password);
    await page.locator("#activation-confirm-password").fill(password);
    await page.getByRole("button", { name: "Activate account" }).click();

    await expect(page).toHaveURL(/\/partners\/activate\/mfa$/u);
    await expect(
      page.getByRole("heading", {
        name: "Secure your partner access",
        level: 1,
      }),
    ).toBeVisible();
    const secretLocator = page.locator("code").first();
    await expect(secretLocator).toBeVisible();
    const secret = (await secretLocator.textContent())?.trim();
    if (!secret) throw new Error("The MFA setup page omitted its secret.");
    if (Date.now() % 30_000 > 27_000) await page.waitForTimeout(3_100);
    await page
      .getByLabel("Six-digit authenticator code")
      .fill(currentTotp(secret));
    await page
      .getByRole("button", { name: "Verify and activate access" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Save your recovery codes" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "I saved these codes" }).click();
    await expect(page).toHaveURL(/\/partners\/overview$/u);
    await expect(
      page.getByRole("heading", { name: /Welcome back,/u, level: 1 }),
    ).toBeVisible();

    await expect
      .poll(() => findPartnerAccessReviewSnapshot(email))
      .toMatchObject({
        applicationStatus: "approved",
        identityActive: true,
        identityStatus: "active",
        passwordSet: true,
        mfaRequired: true,
        mfaEnrolled: true,
        membershipStatus: "active",
        membershipAccepted: true,
        membershipRoleKey: "administrator",
        membershipAccessLevel: "account",
        portalSessionCount: 1,
        activationChallengeStatus: "consumed",
      });
    const cookies = await page.context().cookies();
    expect(
      cookies.some(
        (cookie) =>
          cookie.name === PARTNER_SESSION_COOKIE && cookie.value.length > 0,
      ),
    ).toBe(true);
    expect(
      cookies.some(
        (cookie) => cookie.name === PARTNER_APPLICATION_SESSION_COOKIE,
      ),
    ).toBe(false);

    const meResponse = await page.request.get("/api/partners/portal/me");
    expect(meResponse.status()).toBe(200);
    expect(await meResponse.json()).toMatchObject({
      membership: { roleKey: "administrator", accessLevel: "account" },
      security: {
        mfaRequired: true,
        mfaEnrolled: true,
        mfaSatisfied: true,
      },
    });
  } finally {
    await staffContext?.close();
    await cleanupPartnerAccessReviewFixture(email);
  }
});
