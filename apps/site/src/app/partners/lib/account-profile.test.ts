import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(
  new URL("../components/PartnerAccountProfileManager.tsx", import.meta.url),
  "utf8",
);
const settingsPage = readFileSync(
  new URL("../(portal)/settings/page.tsx", import.meta.url),
  "utf8",
);

void test("settings loads the account-native profile and preserves its strong ETag", () => {
  assert.match(settingsPage, /\/api\/portal\/v2\/account-profile/u);
  assert.match(
    settingsPage,
    /accountProfileResponse\?\.headers\.get\("etag"\)/u,
  );
  assert.match(settingsPage, /<PartnerAccountProfileManager/u);
  assert.match(
    settingsPage,
    /initialProfile=\{accountProfilePayload\?\.profile \?\? null\}/u,
  );
});

void test("profile mutations are revision-safe and retain unsaved-change guards", () => {
  assert.match(component, /"If-Match": etag/u);
  assert.match(
    component,
    /data-partner-unsaved=\{dirty \? "true" : undefined\}/u,
  );
  assert.match(component, /window\.addEventListener\("beforeunload", warn\)/u);
  assert.match(component, /result\?\.response\.status === 412/u);
  assert.doesNotMatch(component, /mfa_step_up_required|mfa\/step-up/iu);
  assert.match(component, /organizationFormKey\(profile\)/u);
  assert.match(component, /billingFormKey\(profile\)/u);
  assert.doesNotMatch(
    component,
    /key=\{`(?:organization|billing)-\$\{profile\.revision\}`\}/u,
  );
});

void test("organization and billing controls remain capability-separated", () => {
  assert.match(component, /profile\.permissions\.canEditOrganization/u);
  assert.match(component, /profile\.permissions\.canEditBilling/u);
  assert.match(component, /profile\.permissions\.canViewBilling/u);
  assert.match(component, /save\("organization"/u);
  assert.match(component, /save\("billing"/u);
  assert.match(component, /account\s+administrator must edit them/u);
  assert.match(component, /administrator\s+or Billing\/Approver/u);
  assert.match(component, /No financial contact or address data is\s+shown/u);
});

void test("profile fields are bounded, validated, and not CRM or provider authority", () => {
  assert.match(
    component,
    /name="organizationName"[\s\S]{0,120}maxLength=\{160\}/u,
  );
  assert.match(component, /name="organizationWebsite"[\s\S]{0,120}type="url"/u);
  assert.match(
    component,
    /name="costCenterGuidance"[\s\S]{0,120}maxLength=\{500\}/u,
  );
  assert.match(
    component,
    /const addressEmpty =\s*!line1 && !line2 && !city && !state && !postalCode/u,
  );
  assert.doesNotMatch(
    component,
    /orgContactId|providerCustomerId|rateCardId|staffNotes/u,
  );
  assert.doesNotMatch(component, /localStorage|sessionStorage/u);
});
