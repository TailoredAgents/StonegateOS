import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  approvalDecisionAvailability,
  approvalDecisionErrorMessage,
  approvalStateLabel,
  formatApprovalMoney,
  isApprovalHoldExpired,
  isPartnerApprovalDetail,
  isPartnerApprovalSummary,
} from "./portal-approvals";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const DECISION_ID = "33333333-3333-4333-8333-333333333333";

function summary() {
  return {
    id: REQUEST_ID,
    state: "pending",
    target: { kind: "booking_draft", id: TARGET_ID },
    requestedByCurrentMember: false,
    requester: {
      displayName: "Jordan Lee",
      roleKey: "requester",
      byCurrentMember: false,
    },
    requiredDecisionCount: 2,
    decisionCounts: { approved: 1, declined: 0 },
    currentMemberDecision: null,
    expiresAt: "2026-09-01T16:00:00.000Z",
    resolvedAt: null,
    revision: 4,
    createdAt: "2026-08-31T12:00:00.000Z",
    updatedAt: "2026-08-31T12:30:00.000Z",
    etag: '"approval-revision"',
  } as const;
}

void test("accepts the sanitized approval summary and detail contracts", () => {
  assert.equal(isPartnerApprovalSummary(summary()), true);
  assert.equal(
    isPartnerApprovalDetail({
      ...summary(),
      rulesValid: true,
      rules: [
        {
          id: "amount-threshold",
          name: "Large work approval",
          version: 3,
          requiredApproverRoleKeys: ["approver", "account_administrator"],
          requiredDecisionCount: 1,
        },
      ],
      request: {
        serviceKey: "commercial_pickup",
        poNumber: "PO-1042",
        amount: { amountMinor: 125_00, currency: "USD", minorUnit: 2 },
        address: { line1: "100 Main St", city: "Raleigh", state: "NC" },
      },
      decisions: [
        {
          id: DECISION_ID,
          decision: "approved",
          reason: "Budget confirmed.",
          roleKey: "approver",
          byCurrentMember: false,
          createdAt: "2026-08-31T12:20:00.000Z",
        },
      ],
    }),
    true,
  );
});

void test("rejects malformed identifiers, unsafe currencies, and invalid roles", () => {
  assert.equal(
    isPartnerApprovalSummary({ ...summary(), id: "internal-42" }),
    false,
  );
  assert.equal(
    isPartnerApprovalDetail({
      ...summary(),
      rulesValid: true,
      rules: [
        {
          id: "rule",
          name: "Rule",
          version: 1,
          requiredApproverRoleKeys: ["../../staff"],
          requiredDecisionCount: 1,
        },
      ],
      request: {
        amount: { amountMinor: 100, currency: "usd", minorUnit: 2 },
      },
      decisions: [],
    }),
    false,
  );
  assert.equal(
    isPartnerApprovalDetail({
      ...summary(),
      rulesValid: true,
      rules: [],
      request: { propertyId: TARGET_ID },
      decisions: [],
    }),
    false,
  );
});

void test("prevents self-approval and duplicate decisions without blocking an expired hold", () => {
  const now = new Date("2026-08-31T13:00:00.000Z");
  assert.deepEqual(approvalDecisionAvailability(summary()), {
    allowed: true,
    reason: "ready",
  });
  assert.deepEqual(
    approvalDecisionAvailability({
      ...summary(),
      requestedByCurrentMember: true,
    }),
    { allowed: false, reason: "self_approval" },
  );
  assert.deepEqual(
    approvalDecisionAvailability({
      ...summary(),
      currentMemberDecision: "approved",
    }),
    { allowed: false, reason: "already_decided" },
  );
  assert.deepEqual(
    approvalDecisionAvailability({
      ...summary(),
      expiresAt: "2026-08-31T12:59:59.000Z",
    }),
    { allowed: true, reason: "ready" },
  );
  assert.equal(isApprovalHoldExpired(summary().expiresAt, now), false);
  assert.equal(isApprovalHoldExpired("2026-08-31T12:59:59.000Z", now), true);
});

void test("gives explicit safe recovery copy for protected approval failures", () => {
  assert.match(
    approvalDecisionErrorMessage("mfa_step_up_required", 403),
    /Verify with MFA/u,
  );
  assert.match(
    approvalDecisionErrorMessage("hold_expired", 410),
    /needs a new arrival window/u,
  );
  assert.match(
    approvalDecisionErrorMessage("revision_mismatch", 412),
    /changed after you opened it/u,
  );
  assert.match(
    approvalDecisionErrorMessage("conflict", 409),
    /already changed or its hold expired/u,
  );
});

void test("formats public states and integer-minor-unit money", () => {
  assert.equal(
    approvalStateLabel("approved_needs_reschedule"),
    "Approved · reschedule needed",
  );
  assert.equal(
    formatApprovalMoney({ amountMinor: 12_500, currency: "USD", minorUnit: 2 }),
    "$125.00",
  );
});

void test("approval decision UI sends revision and idempotency guards", () => {
  const component = readFileSync(
    new URL("../components/PartnerApprovalWorkspace.tsx", import.meta.url),
    "utf8",
  );
  assert.match(component, /"If-Match": etag/u);
  assert.match(component, /"Idempotency-Key": operationRef\.current\.key/u);
  assert.match(component, /approved_needs_reschedule/u);
  assert.match(component, /You may still approve or decline/u);
  assert.match(component, /mfa_step_up_required/u);
  assert.match(component, /requestedByCurrentMember/u);
});
