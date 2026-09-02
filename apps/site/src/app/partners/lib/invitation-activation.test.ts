import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parsePartnerInvitationActivationQueued } from "./invitation-activation";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

void test("accepts only the queued activation handoff contract", () => {
  assert.deepEqual(
    parsePartnerInvitationActivationQueued({
      ok: true,
      activationRequired: true,
      deliveryStatus: "queued",
      correlationId: "corr_invitation_123",
    }),
    {
      ok: true,
      activationRequired: true,
      deliveryStatus: "queued",
    },
  );
  for (const payload of [
    null,
    { ok: true, activationRequired: false, deliveryStatus: "queued" },
    { ok: true, activationRequired: true, deliveryStatus: "sent" },
    { ok: true, sessionToken: "legacy-session", expiresAt: "2099-01-01" },
    {
      ok: true,
      activationRequired: true,
      deliveryStatus: "queued",
      sessionToken: "must-not-be-returned",
    },
  ]) {
    assert.equal(parsePartnerInvitationActivationQueued(payload), null);
  }
});

void test("invitation acceptance queues activation without creating a Site session", () => {
  const route = source("../invitations/accept/complete/route.ts");

  assert.match(
    route,
    /"Idempotency-Key": `partner-invitation-accept:\$\{randomUUID\(\)\}`/u,
  );
  assert.match(route, /body: JSON\.stringify\(\{ token \}\)/u);
  assert.match(route, /parsePartnerInvitationActivationQueued/u);
  assert.match(route, /invitations\/accept\?accepted=1/u);
  assert.doesNotMatch(route, /PARTNER_SESSION_COOKIE/u);
  assert.doesNotMatch(route, /sessionToken/u);
  assert.doesNotMatch(route, /rememberMe/u);
});

void test("the accepted page explains activation without claiming live access", () => {
  const page = source("../(public)/invitations/accept/page.tsx");

  assert.match(page, /Invitation accepted/u);
  assert.match(page, /separate activation link/u);
  assert.match(page, /portal access is not active/u);
  assert.match(page, /two-step/u);
  assert.match(page, /index: false, follow: false, nocache: true/u);
  assert.match(page, /referrer: "no-referrer"/u);
  assert.doesNotMatch(page, /rememberMe/u);
  assert.doesNotMatch(page, /Keep me signed in/u);
});
