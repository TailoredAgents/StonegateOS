import {
  buildPartnerApprovalRequestInsert,
  resolvePartnerApprovalRequirementFromRules,
  type PartnerApprovalRuleCandidate,
  type PartnerApprovalRuleMatchContext,
} from "@/lib/partner-portal-v2-approvals";
import { partnerQuoteApprovalEvidenceMatches } from "@/lib/partner-quote-v2-approval";

const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const REQUESTER_ID = "20000000-0000-4000-8000-000000000001";
const LOCATION_ID = "30000000-0000-4000-8000-000000000001";
const OTHER_LOCATION_ID = "30000000-0000-4000-8000-000000000002";
const BOOKING_ID = "40000000-0000-4000-8000-000000000001";
const RULE_ID = "50000000-0000-4000-8000-000000000001";

function context(
  overrides: Partial<PartnerApprovalRuleMatchContext> = {},
): PartnerApprovalRuleMatchContext {
  return {
    partnerAccountId: ACCOUNT_ID,
    requestedByMembershipId: REQUESTER_ID,
    requesterRoleKey: "operations",
    serviceKey: "junk_removal_primary",
    locationId: LOCATION_ID,
    amountMinor: 25_000,
    currency: "USD",
    poNumber: "PO-100",
    costCenter: "FACILITIES",
    ...overrides,
  };
}

function rule(
  overrides: Partial<PartnerApprovalRuleCandidate> = {},
): PartnerApprovalRuleCandidate {
  return {
    id: RULE_ID,
    partnerAccountId: ACCOUNT_ID,
    name: "Commercial approval",
    conditions: {
      serviceKey: "junk_removal_primary",
      locationId: LOCATION_ID,
      requesterRoleKey: "operations",
      minimumAmountMinor: 20_000,
      maximumAmountMinor: 30_000,
      poNumberState: "present",
      costCenterState: "present",
    },
    requiredApproverCapabilities: ["approvals.decide"],
    requiredApproverRoleKeys: [],
    requiredDecisionCount: 1,
    active: true,
    version: 3,
    ...overrides,
  };
}

function requiredResolution() {
  const resolution = resolvePartnerApprovalRequirementFromRules({
    context: context(),
    rules: [rule()],
  });
  if (!resolution.required) throw new Error("Expected matching approval rule.");
  return resolution;
}

function approvedEvidence() {
  const resolution = requiredResolution();
  const insert = buildPartnerApprovalRequestInsert({
    resolution,
    target: {
      kind: "booking",
      id: BOOKING_ID,
      partnerAccountId: ACCOUNT_ID,
    },
    now: new Date("2026-09-01T12:00:00.000Z"),
  });
  return {
    resolution,
    target: {
      kind: "booking" as const,
      id: BOOKING_ID,
      partnerAccountId: ACCOUNT_ID,
    },
    evidence: {
      requestedByMembershipId: REQUESTER_ID,
      requestSnapshot: insert.requestSnapshot,
      ruleSnapshot: insert.ruleSnapshot,
      requiredDecisionCount: insert.requiredDecisionCount,
    },
  };
}

describe("Quote V2 canonical Partner approval evidence", () => {
  it.each([
    ["service", { serviceKey: "moving_labor" }],
    ["location", { locationId: OTHER_LOCATION_ID }],
    ["requester role", { requesterRoleKey: "viewer" }],
    ["PO state", { poNumber: null }],
    ["cost-center state", { costCenter: null }],
    ["minimum amount", { amountMinor: 19_999 }],
    ["maximum amount", { amountMinor: 30_001 }],
  ])(
    "does not block when the active rule's %s condition does not match",
    (_, overrides) => {
      const resolution = resolvePartnerApprovalRequirementFromRules({
        context: context(overrides),
        rules: [rule()],
      });
      expect(resolution.required).toBe(false);
      expect(resolution.matchedRules).toEqual([]);
    },
  );

  it("accepts an exact target, request-context, and rule-version snapshot", () => {
    expect(partnerQuoteApprovalEvidenceMatches(approvedEvidence())).toBe(true);
  });

  it.each([
    ["serviceKey", "moving_labor"],
    ["locationId", OTHER_LOCATION_ID],
    ["requesterRoleKey", "viewer"],
    ["poNumber", "PO-OTHER"],
    ["costCenter", "OTHER"],
    ["amountMinor", 25_001],
    ["currency", "CAD"],
  ])("rejects unrelated same-target evidence with stale %s", (key, value) => {
    const input = approvedEvidence();
    const requestSnapshot = {
      ...input.evidence.requestSnapshot,
      [key]: value,
    };
    expect(
      partnerQuoteApprovalEvidenceMatches({
        ...input,
        evidence: { ...input.evidence, requestSnapshot },
      }),
    ).toBe(false);
  });

  it("rejects unrelated requester evidence even when amount and target match", () => {
    const input = approvedEvidence();
    expect(
      partnerQuoteApprovalEvidenceMatches({
        ...input,
        evidence: {
          ...input.evidence,
          requestedByMembershipId: "20000000-0000-4000-8000-000000000099",
        },
      }),
    ).toBe(false);
  });

  it("rejects a stale rule version and an incomplete matched-rule set", () => {
    const input = approvedEvidence();
    const staleRules = structuredClone(input.evidence.ruleSnapshot);
    staleRules[0]!["version"] = 2;
    expect(
      partnerQuoteApprovalEvidenceMatches({
        ...input,
        evidence: { ...input.evidence, ruleSnapshot: staleRules },
      }),
    ).toBe(false);
    expect(
      partnerQuoteApprovalEvidenceMatches({
        ...input,
        evidence: { ...input.evidence, ruleSnapshot: [] },
      }),
    ).toBe(false);
  });

  it("rejects a stale request-wide decision threshold", () => {
    const input = approvedEvidence();
    expect(
      partnerQuoteApprovalEvidenceMatches({
        ...input,
        evidence: { ...input.evidence, requiredDecisionCount: 2 },
      }),
    ).toBe(false);
  });
});
