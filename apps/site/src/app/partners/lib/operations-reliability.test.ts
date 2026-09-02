import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const SITE_ROOT = path.resolve(process.cwd());

function source(relativePath: string): string {
  return fs.readFileSync(path.join(SITE_ROOT, relativePath), "utf8");
}

void test("booking emits stable availability, contention, completion, and abandonment signals", () => {
  const wizard = source("src/app/partners/components/PartnerBookingWizard.tsx");
  for (const stage of [
    "booking_started",
    "availability_requested",
    "availability_available",
    "availability_slot_full",
    "availability_review_only",
    "availability_degraded",
    "slot_contention",
    "booking_submitted",
    "booking_confirmed",
    "booking_review_requested",
    "booking_failed",
    "booking_abandoned",
  ]) {
    assert.match(wizard, new RegExp(`["']${stage}["']`, "u"));
  }
  assert.match(wizard, /withPortalSupportReference\(/u);
});

void test("upload failures retain a safe API support reference and a retryable file batch", () => {
  for (const componentPath of [
    "src/app/partners/components/PartnerDraftPhotoUpload.tsx",
    "src/app/partners/components/PartnerProofWorkspace.tsx",
  ]) {
    const component = source(componentPath);
    assert.match(component, /portalSupportReferenceFromResponse/u);
    assert.match(component, /storage_upload_interrupted/u);
    assert.match(
      component,
      /stage: interrupted \? "upload_interrupted" : "upload_failed"/u,
    );
    assert.match(component, /retry the unfinished files/u);
  }
});

void test("the Site proxy forwards and returns one bounded correlation reference", () => {
  const proxy = source("src/app/api/partners/portal/[...segments]/route.ts");
  assert.match(proxy, /SAFE_CORRELATION_ID/u);
  assert.match(
    proxy,
    /requestHeaders\.set\("x-correlation-id", correlationId\)/u,
  );
  assert.match(proxy, /"x-correlation-id": correlationId/u);
  assert.doesNotMatch(proxy, /console\.(?:warn|error)\([^\n]+joinedPath/u);
});

void test("account and notification errors surface canonical service messages", () => {
  const account = source(
    "src/app/partners/components/PartnerAccountProfileManager.tsx",
  );
  const accountShell = source(
    "src/app/partners/components/PartnerAppShell.tsx",
  );
  const preferences = source(
    "src/app/partners/components/PartnerAccountSecurityManager.tsx",
  );
  const notifications = source(
    "src/app/partners/components/PartnerNotificationList.tsx",
  );
  const smsEndpoints = source(
    "src/app/partners/components/PartnerSmsEndpointManager.tsx",
  );
  assert.match(account, /withPortalSupportReference\(/u);
  assert.match(accountShell, /portalSupportReferenceFromResponse/u);
  assert.match(accountShell, /withPortalSupportReference\(/u);
  assert.match(preferences, /withPortalSupportReference\(/u);
  assert.match(notifications, /result\?\.error\.message/u);
  assert.match(smsEndpoints, /portalSupportReferenceFromResponse/u);
  assert.match(smsEndpoints, /withPortalSupportReference\(/u);
});

void test("Staff operations visibility is aggregate, period-bounded, and accessible", () => {
  const panel = source(
    "src/app/team/components/PartnerPortalOperationsPanel.tsx",
  );
  const workspace = source(
    "src/app/team/components/PartnerAdministrationSection.tsx",
  );
  assert.match(panel, /Portal operations health/u);
  assert.match(panel, /aria-label="Portal telemetry period"/u);
  assert.match(panel, /<caption className="sr-only">/u);
  assert.match(panel, /No addresses, notes, filenames, contacts/u);
  assert.match(panel, /rangeDays=\$\{rangeDays\}/u);
  assert.match(panel, /"x-correlation-id": requestReference/u);
  assert.match(panel, /<time dateTime=\{report\.generatedAt\}>/u);
  assert.match(workspace, /id: "operations"/u);
  assert.match(workspace, /<PartnerPortalOperationsPanel/u);
});
