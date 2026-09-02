import { createPartnerCommercialCsv } from "@/lib/partner-portal-v2-commercial";
import {
  evaluateAllMatchingApprovalRules,
  parseApprovalRuleSnapshots,
} from "@/lib/partner-portal-v2-approvals";

const REQUESTER = "00000000-0000-4000-8000-000000000001";
const APPROVER_ONE = "00000000-0000-4000-8000-000000000002";
const APPROVER_TWO = "00000000-0000-4000-8000-000000000003";

describe("partner portal V2 commercial safety", () => {
  it("quotes CSV cells and neutralizes spreadsheet formula prefixes", () => {
    expect(
      createPartnerCommercialCsv(
        ["name", "amount"],
        [['=HYPERLINK("https://bad.invalid")', 1200]],
      ),
    ).toBe('"name","amount"\r\n"\'=HYPERLINK(""https://bad.invalid"")","1200"');
  });

  it("rejects non-scalar CSV values rather than stringifying objects", () => {
    expect(() => createPartnerCommercialCsv(["value"], [[{}]])).toThrow(
      "partner_commercial_csv_value_invalid",
    );
  });
});

describe("partner approval all-matching-rule semantics", () => {
  const rules = [
    {
      id: "amount-threshold",
      name: "Amount threshold",
      version: 2,
      requiredApproverCapabilities: ["approvals.decide"],
      requiredApproverRoleKeys: ["approver", "owner"],
      requiredDecisionCount: 2,
    },
    {
      id: "billing-review",
      name: "Billing review",
      version: 1,
      requiredApproverCapabilities: ["approvals.decide"],
      requiredApproverRoleKeys: ["billing", "owner"],
      requiredDecisionCount: 1,
    },
  ];

  it("requires every matching rule and the request-wide distinct count", () => {
    const result = evaluateAllMatchingApprovalRules({
      ruleSnapshot: rules,
      requiredDecisionCount: 2,
      decisions: [
        {
          membershipId: APPROVER_ONE,
          roleKey: "approver",
          capabilities: ["approvals.decide"],
          decision: "approved",
        },
        {
          membershipId: APPROVER_TWO,
          roleKey: "billing",
          capabilities: ["approvals.decide"],
          decision: "approved",
        },
      ],
    });
    expect(result).toMatchObject({
      ok: true,
      approved: true,
      declined: false,
      approvedDecisionCount: 2,
      rules: [
        { id: "amount-threshold", satisfied: true },
        { id: "billing-review", satisfied: true },
      ],
    });
  });

  it("allows one immutable role snapshot to satisfy multiple rules", () => {
    const result = evaluateAllMatchingApprovalRules({
      ruleSnapshot: rules,
      requiredDecisionCount: 2,
      decisions: [
        {
          membershipId: APPROVER_ONE,
          roleKey: "approver",
          decision: "approved",
        },
        {
          membershipId: APPROVER_TWO,
          roleKey: "owner",
          decision: "approved",
        },
      ],
      actorCapabilities: ["approvals.decide"],
    });
    expect(result).toMatchObject({
      ok: true,
      actorEligible: true,
      approved: true,
      declined: false,
      eligibleRuleIds: ["amount-threshold", "billing-review"],
    });
  });

  it("treats any immutable decline as terminal", () => {
    const result = evaluateAllMatchingApprovalRules({
      ruleSnapshot: rules,
      requiredDecisionCount: 2,
      decisions: [
        {
          membershipId: APPROVER_ONE,
          roleKey: "approver",
          decision: "approved",
        },
        {
          membershipId: APPROVER_TWO,
          roleKey: "owner",
          decision: "declined",
        },
      ],
    });
    expect(result).toMatchObject({
      ok: true,
      approved: false,
      declined: true,
    });
  });

  it("fails closed for duplicate decision makers and malformed rules", () => {
    expect(
      evaluateAllMatchingApprovalRules({
        ruleSnapshot: rules,
        requiredDecisionCount: 1,
        decisions: [
          {
            membershipId: REQUESTER,
            roleKey: "owner",
            decision: "approved",
          },
          {
            membershipId: REQUESTER,
            roleKey: "owner",
            decision: "approved",
          },
        ],
      }),
    ).toEqual({ ok: false, reason: "invalid_rules" });
    expect(
      parseApprovalRuleSnapshots([
        {
          id: "invalid",
          requiredApproverRoleKeys: ["OWNER"],
          requiredDecisionCount: 1,
        },
      ]),
    ).toBeNull();
  });
});
