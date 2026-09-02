import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(
  new URL("../components/PartnerPersonalProfileManager.tsx", import.meta.url),
  "utf8",
);
const settingsPage = readFileSync(
  new URL("../(portal)/settings/page.tsx", import.meta.url),
  "utf8",
);

void test("settings loads the canonical personal profile and preserves its strong ETag", () => {
  assert.match(settingsPage, /\/api\/portal\/v2\/personal-profile/u);
  assert.match(
    settingsPage,
    /personalProfileResponse\?\.headers\.get\("etag"\)/u,
  );
  assert.match(settingsPage, /<PartnerPersonalProfileManager/u);
  assert.match(
    settingsPage,
    /initialProfile=\{personalProfilePayload\?\.profile \?\? null\}/u,
  );
});

void test("display-name mutations are revision-safe and protect unsaved work", () => {
  assert.match(component, /partnerPortalFetch<PersonalProfileResponse>\(/u);
  assert.match(component, /"personal-profile"/u);
  assert.match(component, /method: "PATCH"/u);
  assert.match(component, /"If-Match": etag/u);
  assert.match(
    component,
    /data-partner-unsaved=\{dirty \? "true" : undefined\}/u,
  );
  assert.match(component, /window\.addEventListener\("beforeunload", warn\)/u);
  assert.match(component, /result\?\.response\.status === 412/u);
  assert.match(component, /if \(changedElsewhere\) await refreshProfile\(\)/u);
});

void test("the editor is accessible, bounded, and explicit about global identity scope", () => {
  assert.match(component, /name="displayName"/u);
  assert.match(component, /autoComplete="name"/u);
  assert.match(component, /minLength=\{2\}/u);
  assert.match(component, /maxLength=\{120\}/u);
  assert.match(component, /aria-describedby="partner-display-name-help"/u);
  assert.match(component, /aria-busy=\{busy\}/u);
  assert.match(component, /across every Stonegate partner account/u);
  assert.match(
    component,
    /does not change your sign-in email, permissions, or\s+CRM contacts/u,
  );
  assert.doesNotMatch(
    component,
    /orgContactId|contactId|localStorage|sessionStorage/u,
  );
});
