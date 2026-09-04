import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  hasVerifiedPartnerSmsEndpoint,
  parsePartnerSmsEndpoint,
  parsePartnerSmsEndpoints,
  PARTNER_SMS_CONSENT_VERSION,
  withPartnerSmsChallenge,
} from "./notification-endpoints";

const ENDPOINT_ID = "11111111-1111-4111-8111-111111111111";

function endpoint() {
  return {
    id: ENDPOINT_ID,
    channel: "sms",
    maskedDestination: "•••• 0123",
    status: "pending",
    verifiedAt: null,
    consentSource: null,
    consentVersion: null,
    createdAt: "2026-09-01T12:00:00.000Z",
    updatedAt: "2026-09-01T12:00:00.000Z",
    activeChallenge: {
      expiresAt: "2026-09-01T12:10:00.000Z",
      deliveryStatus: "queued",
    },
  };
}

void test("accepts only masked, bounded SMS endpoint DTOs", () => {
  assert.deepEqual(parsePartnerSmsEndpoint(endpoint()), endpoint());
  assert.equal(
    parsePartnerSmsEndpoint({
      ...endpoint(),
      maskedDestination: "+1 555 555 0123",
    }),
    null,
  );
  assert.equal(
    parsePartnerSmsEndpoint({
      ...endpoint(),
      phone: "+15555550123",
    }),
    null,
  );
  assert.equal(
    parsePartnerSmsEndpoint({
      ...endpoint(),
      activeChallenge: {
        ...endpoint().activeChallenge,
        deliveryStatus: "unknown",
      },
    }),
    null,
  );
  assert.equal(parsePartnerSmsEndpoints([endpoint()])?.length, 1);
});

void test("derives SMS preference availability only from a verified endpoint", () => {
  const pending = parsePartnerSmsEndpoint(endpoint());
  const verified = parsePartnerSmsEndpoint({
    ...endpoint(),
    status: "verified",
    verifiedAt: "2026-09-01T12:02:00.000Z",
    consentSource: "partner_portal_notification_settings",
    consentVersion: PARTNER_SMS_CONSENT_VERSION,
    activeChallenge: null,
  });
  assert.equal(
    hasVerifiedPartnerSmsEndpoint(pending ? [pending] : null),
    false,
  );
  assert.equal(
    hasVerifiedPartnerSmsEndpoint(verified ? [verified] : null),
    true,
  );
  assert.equal(hasVerifiedPartnerSmsEndpoint(null), false);
});

void test("requires a validated delivery challenge for a pending request", () => {
  const pending = parsePartnerSmsEndpoint({
    ...endpoint(),
    activeChallenge: null,
  });
  assert.ok(pending);
  assert.deepEqual(
    withPartnerSmsChallenge(pending, {
      expiresAt: "2026-09-01T12:10:00.000Z",
      deliveryStatus: "queued",
    })?.activeChallenge,
    {
      expiresAt: "2026-09-01T12:10:00.000Z",
      deliveryStatus: "queued",
    },
  );
  assert.equal(withPartnerSmsChallenge(pending, undefined), null);

  const verified = parsePartnerSmsEndpoint({
    ...endpoint(),
    status: "verified",
    verifiedAt: "2026-09-01T12:02:00.000Z",
    consentSource: "partner_portal_notification_settings",
    consentVersion: PARTNER_SMS_CONSENT_VERSION,
    activeChallenge: null,
  });
  assert.ok(verified);
  assert.equal(withPartnerSmsChallenge(verified, undefined), verified);
  assert.equal(withPartnerSmsChallenge(verified, null), null);
});

void test("settings UI keeps SMS verification private, explicit, and idempotent", () => {
  assert.equal(PARTNER_SMS_CONSENT_VERSION, "partner-sms-consent-v1");
  const component = readFileSync(
    new URL("../components/PartnerSmsEndpointManager.tsx", import.meta.url),
    "utf8",
  );
  assert.match(component, /"notification-endpoints"/u);
  assert.match(component, /\/verify/u);
  assert.match(component, /method: "DELETE"/u);
  assert.match(component, /"Idempotency-Key": createPortalOperationKey/u);
  assert.match(component, /consentVersion: PARTNER_SMS_CONSENT_VERSION/u);
  assert.match(component, /pattern="\[0-9\]\{6\}"/u);
  assert.match(component, /name="consentAccepted"/u);
  assert.match(
    component,
    /name="consentAccepted"[\s\S]{0,100}type="checkbox"[\s\S]{0,100}required/u,
  );
  assert.doesNotMatch(
    component,
    /name="consentAccepted"[\s\S]{0,180}(?:defaultChecked|checked=)/u,
  );
  assert.match(component, /confirmation: "STOP SMS"/u);
  assert.match(component, /Yes, remove SMS number/u);
  assert.match(component, /canManage/u);
  assert.doesNotMatch(component, /mfa_step_up_required|mfa\/step-up/iu);
  assert.match(component, /form\.reset\(\)/u);
  assert.doesNotMatch(component, /localStorage|sessionStorage/u);
  assert.doesNotMatch(component, /useState[^\n]*phone/iu);
});

void test("settings route loads masked endpoints and preferences fail closed", () => {
  const page = readFileSync(
    new URL("../(portal)/settings/page.tsx", import.meta.url),
    "utf8",
  );
  const security = readFileSync(
    new URL("../components/PartnerAccountSecurityManager.tsx", import.meta.url),
    "utf8",
  );
  assert.match(page, /\/api\/portal\/v2\/notification-endpoints/u);
  assert.match(page, /parsePartnerSmsEndpoints/u);
  assert.match(page, /smsEndpoints=\{smsEndpoints\}/u);
  assert.match(page, /"account\.security\.manage"/u);
  assert.match(page, /canManageSmsEndpoints=/u);
  assert.match(security, /PartnerSmsEndpointManager/u);
  assert.match(security, /channel === "smsEnabled" && !smsEndpointVerified/u);
  assert.match(security, /endpointRevision/u);
});
