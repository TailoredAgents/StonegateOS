import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

void test("job detail keeps the promised window authoritative over published ETA", () => {
  const page = source("../(portal)/bookings/[jobId]/page.tsx");
  assert.match(page, /Latest arrival estimate/u);
  assert.match(page, /promised two-hour arrival window remains authoritative/u);
  assert.match(page, /No narrower estimate available/u);
  assert.match(page, /Stonegate service crew/u);
  assert.match(page, /Individual names and live location are not shared/u);
  assert.doesNotMatch(
    page,
    /crewLocation|latitude|longitude|providerMessageId/u,
  );
});

void test("job delivery history is member-specific and truthfully labels acceptance", () => {
  const page = source("../(portal)/bookings/[jobId]/page.tsx");
  assert.match(page, /Delivery status for you/u);
  assert.match(page, /without exposing destinations or provider details/u);
  assert.match(page, /confirms provider acceptance, not that/u);
  assert.match(page, /isJobNotificationDeliveryHistory/u);
  assert.match(page, /DELIVERY_EVENT_LABELS\[eventKey\]/u);
  assert.match(page, /DELIVERY_STATUS_LABELS\[statusKey\]/u);
});

void test("issue reporting is accessible, bounded, and uses the shared thread", () => {
  const messages = source("../components/PartnerJobMessages.tsx");
  assert.match(messages, /Report a job issue/u);
  assert.match(messages, /call 911/u);
  assert.match(messages, /does not guarantee an immediate response/u);
  assert.match(messages, /<fieldset disabled=\{sending\}>/u);
  assert.match(messages, /minLength=\{10\}/u);
  assert.match(messages, /maxLength=\{2_000\}/u);
  assert.match(messages, /createPortalOperationKey\("job-issue"\)/u);
  assert.match(messages, /kind: "issue"/u);
  assert.match(messages, /issueCategory: operation\.category/u);
  assert.match(messages, /issuePriority: operation\.priority/u);
  assert.match(messages, /report stays with this job for follow-up/u);
  assert.match(messages, /aria-live="assertive"/u);
});
