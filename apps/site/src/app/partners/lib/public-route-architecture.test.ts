import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

void test("public and authenticated route groups use different shells", () => {
  const publicLayout = source("../(public)/layout.tsx");
  const protectedLayout = source("../(portal)/layout.tsx");
  const landing = source("../(public)/page.tsx");

  assert.match(publicLayout, /PartnerPublicShell/u);
  assert.doesNotMatch(publicLayout, /PartnerAppShell/u);
  assert.doesNotMatch(publicLayout, /getPartnerPortalContext/u);

  assert.match(protectedLayout, /getPartnerPortalContext/u);
  assert.match(protectedLayout, /context\.status === "unauthenticated"/u);
  assert.match(protectedLayout, /partnerLoginHref\(returnTo\)/u);
  assert.match(protectedLayout, /PartnerAppShell/u);
  assert.doesNotMatch(protectedLayout, /PartnerPublicLayout/u);

  assert.match(landing, /partnerLandingDestination/u);
  assert.match(landing, /redirect\(destination/u);
  assert.ok(
    existsSync(new URL("../(portal)/overview/page.tsx", import.meta.url)),
  );
  assert.equal(
    existsSync(new URL("../(portal)/page.tsx", import.meta.url)),
    false,
    "the public /partners route must not collide with a protected route-group page",
  );
});

void test("the public landing explains access, security, service review, FAQ, and support", () => {
  const landing = source("../(public)/page.tsx");

  assert.match(landing, /Verify, get approved, then operate securely/u);
  assert.match(landing, /Company review/u);
  assert.match(landing, /Security that follows the account/u);
  assert.match(landing, /Honest scheduling promises/u);
  assert.match(landing, /partner-faq-heading/u);
  assert.match(landing, /Questions before you apply/u);
  assert.match(landing, /company\.phoneE164/u);
  assert.match(landing, /company\.email/u);
});

void test("the shared marketing menu is a conditional, inert, focus-managed dialog", () => {
  const header = source("../../../components/Header.tsx");

  assert.match(header, /!isBookingLanding && isMenuOpen/u);
  assert.match(header, /role="dialog"/u);
  assert.match(header, /aria-modal="true"/u);
  assert.match(header, /inert=\{isMenuOpen \? true : undefined\}/u);
  assert.match(header, /element\.inert = true/u);
  assert.match(header, /event\.key === "Escape"/u);
  assert.match(header, /event\.key !== "Tab"/u);
  assert.match(header, /closeButtonRef\.current\?\.focus\(\)/u);
  assert.match(header, /restoreTarget\?\.isConnected/u);
  assert.match(header, /min-h-11/u);
});

void test("the marketing navigation has one clear partner entry point", () => {
  const header = source("../../../components/Header.tsx");
  const footer = source("../../../components/Footer.tsx");
  const landing = source("../(public)/page.tsx");

  assert.match(header, /\{ href: "\/partners", label: "For Partners" \}/u);
  assert.doesNotMatch(
    header,
    /\{ href: "\/(?:contact|blog|contractors|partners\/request-access)"/u,
  );
  assert.doesNotMatch(header, /if \(href === "\/partners"\) return false/u);

  for (const destination of [
    "/contact",
    "/blog",
    "/contractors",
    "/partners/login",
    "/partners/request-access",
  ]) {
    assert.match(
      footer,
      new RegExp(`href="${destination.replaceAll("/", "\\/")}"`, "u"),
      `${destination} should remain discoverable in the footer`,
    );
  }

  assert.match(landing, /aria-label="Partner access options"/u);
  assert.match(landing, /Already approved\? Sign in/u);
  assert.match(landing, /New company or teammate\? Request access/u);
});

void test("marketing actions do not duplicate or cover the navigation", () => {
  const header = source("../../../components/Header.tsx");
  const siteLayout = source("../../(site)/layout.tsx");
  const homePage = source("../../(site)/page.tsx");
  const stickyActions = source("../../../components/StickyCtaBar.tsx");

  assert.match(header, /sticky top-0 z-\[60\]/u);
  assert.match(siteLayout, /<StickyCtaBar \/>/u);
  assert.doesNotMatch(homePage, /StickyCtaBar/u);
  assert.doesNotMatch(stickyActions, /hidden md:block/u);
  assert.doesNotMatch(stickyActions, /href=\{`sms:/u);
  assert.match(stickyActions, />Call<\/a>/u);
  assert.match(stickyActions, /<StickyGetQuoteButton/u);
});

void test("query errors become only locally controlled partner copy", () => {
  const portalUi = source("../components/PartnerPortalUi.tsx");
  const actions = source("../actions.ts");

  assert.match(portalUi, /Query strings are untrusted/u);
  assert.doesNotMatch(portalUi, /return normalized;/u);
  assert.match(actions, /newPassword\.length < 15/u);
  assert.doesNotMatch(actions, /newPassword\.length < 12/u);
});

void test("public proof shares reject malformed tokens, payloads, and unsafe URLs", () => {
  const proofPage = source("../(public)/proof/[token]/page.tsx");

  assert.match(proofPage, /PROOF_SHARE_TOKEN_PATTERN\.test\(token\)/u);
  assert.match(proofPage, /function isSharedEvidence/u);
  assert.match(proofPage, /evidence\.every\(isSharedEvidence\)/u);
  assert.match(proofPage, /function isSharedDownload/u);
  assert.match(proofPage, /function safeSignedWebUrl/u);
  assert.match(proofPage, /parsed\.protocol === "https:"/u);
  assert.doesNotMatch(proofPage, /if \(!token \|\| token\.length > 512\)/u);
});

void test("only the public landing is indexable within partner account routes", () => {
  const landing = source("../(public)/page.tsx");
  const rootLayout = source("../layout.tsx");
  const protectedLayout = source("../(portal)/layout.tsx");

  assert.match(landing, /robots:\s*\{\s*index:\s*true,\s*follow:\s*true\s*\}/u);
  assert.match(landing, /alternates:\s*\{\s*canonical:/u);
  assert.doesNotMatch(rootLayout, /robots:/u);
  assert.match(
    protectedLayout,
    /robots:\s*\{\s*index:\s*false,\s*follow:\s*false,\s*nocache:\s*true\s*\}/u,
  );

  for (const path of [
    "../(public)/activate/page.tsx",
    "../(public)/activate/mfa/page.tsx",
    "../(public)/application/page.tsx",
    "../(public)/confirm-email/page.tsx",
    "../(public)/forgot-password/page.tsx",
    "../(public)/invitations/accept/page.tsx",
    "../(public)/login/page.tsx",
    "../(public)/proof/[token]/page.tsx",
    "../(public)/request-access/page.tsx",
    "../(public)/reset-password/page.tsx",
  ]) {
    assert.match(
      source(path),
      /robots:\s*\{\s*index:\s*false,\s*follow:\s*false,\s*nocache:\s*true\s*\}/u,
      `${path} must remain out of indexes and caches`,
    );
  }
});

void test("auth responses are explicitly private and non-storable", () => {
  for (const path of [
    "../../api/partners/onboarding/[...segments]/route.ts",
    "../application/expired/route.ts",
    "../invitations/accept/complete/route.ts",
    "../verify/route.ts",
  ]) {
    const route = source(path);
    assert.match(route, /Cache-Control/u, `${path} must set cache policy`);
    assert.match(
      route,
      /(?:private, )?no-store/u,
      `${path} must forbid storage`,
    );
  }
});

void test("raw purpose tokens never enter client props or HTML", () => {
  const middleware = source("../../../middleware.ts");
  const loginPage = source("../(public)/login/page.tsx");
  const activationPage = source("../(public)/activate/page.tsx");
  const activationMfaPage = source("../(public)/activate/mfa/page.tsx");
  const resetPage = source("../(public)/reset-password/page.tsx");
  const confirmEmailPage = source("../(public)/confirm-email/page.tsx");
  const invitationPage = source("../(public)/invitations/accept/page.tsx");
  const credentialForm = source("../components/PartnerCredentialSetupForm.tsx");
  const passwordForm = source("../components/PartnerPasswordForm.tsx");
  const portalUi = source("../components/PartnerPortalUi.tsx");
  const onboardingProxy = source(
    "../../api/partners/onboarding/[...segments]/route.ts",
  );

  assert.match(middleware, /partnerPurposeTokenPolicy\(pathname\)/u);
  assert.match(middleware, /destination\.searchParams\.delete\("token"\)/u);
  assert.match(middleware, /httpOnly:\s*true/u);
  assert.match(middleware, /Referrer-Policy/u);
  assert.ok(
    middleware.indexOf('pathname.startsWith("/partners")') <
      middleware.indexOf("hasTrackingParams"),
    "partner routes must exit before public-site UTM capture",
  );

  assert.match(activationPage, /hasToken=\{Boolean\(token\)\}/u);
  assert.match(resetPage, /hasToken=\{Boolean\(token\)\}/u);
  assert.doesNotMatch(activationPage, /\btoken=\{/u);
  assert.doesNotMatch(activationMfaPage, /\btoken=\{/u);
  assert.doesNotMatch(activationMfaPage, /"use client"/u);
  assert.match(activationMfaPage, /PARTNER_ACTIVATION_MFA_TRANSACTION_COOKIE/u);
  assert.doesNotMatch(resetPage, /\btoken=\{/u);
  assert.match(confirmEmailPage, /PARTNER_EMAIL_CHANGE_TOKEN_COOKIE/u);
  assert.doesNotMatch(confirmEmailPage, /\btoken=\{/u);
  assert.doesNotMatch(invitationPage, /name="token"/u);
  assert.doesNotMatch(invitationPage, /searchParams[^\n]*token/u);
  assert.doesNotMatch(credentialForm, /JSON\.stringify\(\{\s*token/u);
  assert.match(credentialForm, /passwordAlreadySet/u);
  assert.match(credentialForm, /current-password/u);
  for (const passwordSource of [
    loginPage,
    credentialForm,
    passwordForm,
    portalUi,
  ]) {
    assert.doesNotMatch(passwordSource, /(?:minLength=\{12\}|Use 12)/u);
  }
  assert.match(
    credentialForm,
    /minLength=\{confirmsExistingPassword \? 1 : 15\}/u,
  );
  assert.match(loginPage, /minLength=\{1\}/u);
  assert.doesNotMatch(loginPage, /requestPartnerMagicLinkAction/u);
  assert.doesNotMatch(loginPage, /verified mobile phone/u);
  assert.doesNotMatch(loginPage, /magic_link_request/u);
  assert.doesNotMatch(
    source("../actions.ts"),
    /requestPartnerMagicLinkAction/u,
  );
  assert.match(passwordForm, /Use 15–128 characters/u);

  assert.match(onboardingProxy, /bodyWithPurposeToken/u);
  assert.match(onboardingProxy, /sessionToken:\s*undefined/u);
  assert.match(onboardingProxy, /mfa_setup_required/u);
  assert.match(onboardingProxy, /pre_authentication_only/u);
  assert.match(onboardingProxy, /PARTNER_ACTIVATION_MFA_TRANSACTION_COOKIE/u);
  assert.match(onboardingProxy, /headers\.set\("Authorization"/u);
  assert.match(onboardingProxy, /deletePurposeTokenCookie/u);
  assert.equal(
    existsSync(new URL("../../../../middleware.ts", import.meta.url)),
    false,
    "a root duplicate must not shadow the one middleware beside src/app",
  );
});

void test("every partner logout entry point uses confirmed server revocation", () => {
  const shell = source("../components/PartnerAppShell.tsx");
  const logoutRoute = source("../logout/route.ts");
  const actions = source("../actions.ts");

  assert.equal(
    shell.match(/<form action="\/partners\/logout" method="post">/gu)?.length,
    2,
    "desktop and mobile logout must use the authoritative bridge",
  );
  assert.match(logoutRoute, /callPartnerPublicApi\("\/api\/portal\/logout"/u);
  assert.match(logoutRoute, /if \(!revoked\?\.ok\)/u);
  assert.match(logoutRoute, /logout_failed/u);
  assert.ok(
    logoutRoute.indexOf("if (!revoked?.ok)") <
      logoutRoute.indexOf("response.cookies.set"),
    "the browser cookie must not be cleared before revocation is confirmed",
  );
  assert.doesNotMatch(actions, /partnerLogoutAction/u);
});
