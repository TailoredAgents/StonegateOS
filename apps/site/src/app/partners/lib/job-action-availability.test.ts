import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  findPartnerJobAction,
  parsePartnerJobActionAvailability,
  partnerJobActionBlockers,
  PARTNER_JOB_ACTION_KEYS,
} from "./job-action-availability";

function payload() {
  return PARTNER_JOB_ACTION_KEYS.map((action) => ({
    action,
    allowed: action === "message",
    reason: {
      code: action === "message" ? "available" : "permission_required",
      label:
        action === "message"
          ? "Available now."
          : "Your role does not allow this action.",
    },
  }));
}

void test("accepts exactly one bounded descriptor for every public action", () => {
  const parsed = parsePartnerJobActionAvailability(payload());
  assert.ok(parsed);
  assert.deepEqual(findPartnerJobAction(parsed, "message"), {
    action: "message",
    allowed: true,
    reason: { code: "available", label: "Available now." },
  });
});

void test("rejects duplicate, incomplete, unknown, and unbounded descriptors", () => {
  const duplicate = payload();
  const first = duplicate[0];
  assert.ok(first);
  duplicate[1] = first;
  assert.equal(parsePartnerJobActionAvailability(duplicate), null);
  assert.equal(parsePartnerJobActionAvailability(payload().slice(1)), null);
  assert.equal(
    parsePartnerJobActionAvailability([
      ...payload().slice(0, -1),
      {
        action: "internal_override",
        allowed: true,
        reason: { code: "x", label: "x" },
      },
    ]),
    null,
  );
  const longLabel = payload();
  const original = longLabel[0];
  assert.ok(original);
  longLabel[0] = {
    ...original,
    reason: { code: "blocked", label: "x".repeat(241) },
  };
  assert.equal(parsePartnerJobActionAvailability(longLabel), null);
});

void test("returns only unavailable actions selected for local explanation", () => {
  const parsed = parsePartnerJobActionAvailability(payload()) ?? [];
  assert.deepEqual(
    partnerJobActionBlockers(parsed, [
      "reschedule",
      "message",
      "duplicate",
    ]).map((entry) => entry.action),
    ["reschedule", "duplicate"],
  );
});

void test("exposes bounded Partner change-request and commercial-reference forms", () => {
  const actions = fs.readFileSync(
    path.join(
      process.cwd(),
      "src/app/partners/components/PartnerJobActions.tsx",
    ),
    "utf8",
  );
  assert.match(actions, /Request a job change/u);
  assert.match(actions, /Submitting it does not change or/u);
  assert.match(actions, /Sensitive changes require a separate/u);
  assert.match(actions, /impactPrice/u);
  assert.match(actions, /impactSchedule/u);
  assert.match(actions, /impactProof/u);
  assert.match(actions, /Edit commercial references/u);
  assert.match(actions, /does not alter price, invoices, scope, or schedule/u);
  assert.match(actions, /"If-Match": etag/u);
  assert.match(actions, /createPortalOperationKey\("job-change-request"\)/u);
  assert.match(actions, /createPortalOperationKey\("job-references"\)/u);
});
