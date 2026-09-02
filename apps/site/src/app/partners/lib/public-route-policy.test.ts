import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { middleware } from "../../../middleware";
import {
  isValidPartnerPurposeToken,
  partnerLandingDestination,
  partnerPurposeTokenPolicy,
} from "./public-route-policy";

void test("the public landing adapts without treating cookie presence as authentication", () => {
  assert.equal(
    partnerLandingDestination({
      applicationSessionPresent: false,
      portalState: "absent",
    }),
    null,
  );
  assert.equal(
    partnerLandingDestination({
      applicationSessionPresent: false,
      portalState: "authenticated",
    }),
    "/partners/overview",
  );
  assert.equal(
    partnerLandingDestination({
      applicationSessionPresent: true,
      portalState: "unauthenticated",
    }),
    "/partners/application",
  );
  assert.equal(
    partnerLandingDestination({
      applicationSessionPresent: true,
      portalState: "unavailable",
    }),
    null,
    "an identity outage must render a recoverable warning instead of hiding it behind an applicant redirect",
  );
  assert.equal(
    partnerLandingDestination({
      applicationSessionPresent: true,
      portalState: "authenticated",
    }),
    "/partners/overview",
    "an authenticated account takes precedence over an old applicant cookie",
  );
});

void test("only exact purpose-token routes receive short-lived HttpOnly cookie policy", () => {
  assert.deepEqual(partnerPurposeTokenPolicy("/partners/activate"), {
    cookieName: "myst-partner-activation-token",
    maximumAgeSeconds: 24 * 60 * 60,
  });
  assert.deepEqual(partnerPurposeTokenPolicy("/partners/reset-password"), {
    cookieName: "myst-partner-password-reset-token",
    maximumAgeSeconds: 30 * 60,
  });
  assert.deepEqual(partnerPurposeTokenPolicy("/partners/invitations/accept"), {
    cookieName: "myst-partner-invitation-token",
    maximumAgeSeconds: 30 * 60,
  });
  assert.equal(partnerPurposeTokenPolicy("/partners/verify"), null);
  assert.equal(partnerPurposeTokenPolicy("/partners/activate/extra"), null);
  assert.equal(partnerPurposeTokenPolicy("/partners"), null);
});

void test("purpose tokens accept only bounded URL-safe entropy", () => {
  assert.equal(isValidPartnerPurposeToken("a".repeat(32)), true);
  assert.equal(
    isValidPartnerPurposeToken("Ab_9-".repeat(8).slice(0, 43)),
    true,
  );
  assert.equal(isValidPartnerPurposeToken("z".repeat(256)), true);
  assert.equal(isValidPartnerPurposeToken("a".repeat(31)), false);
  assert.equal(isValidPartnerPurposeToken("a".repeat(257)), false);
  assert.equal(isValidPartnerPurposeToken(`${"a".repeat(31)}/`), false);
  assert.equal(isValidPartnerPurposeToken(`${"a".repeat(31)} `), false);
});

void test("activation links move the token into an HttpOnly cookie and sanitize the URL", () => {
  const token = "A_9-".repeat(12);
  const response = middleware(
    new NextRequest(
      `https://stonegate.example/partners/activate?campaign=fall&token=${token}`,
    ),
  );

  assert.equal(response.status, 303);
  assert.equal(
    response.headers.get("location"),
    "https://stonegate.example/partners/activate?campaign=fall",
  );
  assert.equal(
    response.cookies.get("myst-partner-activation-token")?.value,
    token,
  );
  const setCookie = response.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /myst-partner-activation-token=/u);
  assert.match(setCookie, /HttpOnly/iu);
  assert.match(setCookie, /SameSite=lax/iu);
  assert.match(setCookie, /Path=\//u);
  assert.match(setCookie, /Max-Age=86400/iu);
  assert.equal(
    response.headers.get("cache-control"),
    "private, no-store, max-age=0",
  );
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
});

void test("sanitized activation responses remain private and non-cacheable", () => {
  const response = middleware(
    new NextRequest("https://stonegate.example/partners/activate"),
  );

  assert.equal(
    response.headers.get("cache-control"),
    "private, no-store, max-age=0",
  );
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
});

void test("the canonical middleware retains admin protection and attribution", () => {
  const adminResponse = middleware(
    new NextRequest("https://stonegate.example/admin/not-a-route?mode=audit"),
  );
  assert.equal(adminResponse.status, 307);
  assert.equal(
    adminResponse.headers.get("location"),
    "https://stonegate.example/admin/login?redirectTo=%2Fadmin%2Fnot-a-route%3Fmode%3Daudit",
  );

  const attributionResponse = middleware(
    new NextRequest(
      "https://stonegate.example/commercial?utm_source=partner&utm_campaign=fall",
    ),
  );
  const attributionCookie = attributionResponse.cookies.get("myst_utm");
  assert.ok(attributionCookie);
  assert.deepEqual(JSON.parse(attributionCookie.value), {
    source: "partner",
    campaign: "fall",
  });
});
