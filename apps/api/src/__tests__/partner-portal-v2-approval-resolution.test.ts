import {
  buildPartnerApprovalRequestInsert,
  parsePartnerApprovalRuleConditions,
  planPartnerApprovalLifecycle,
  resolvePartnerApprovalRequirement,
  resolvePartnerApprovalRequirementFromRules,
  type PartnerApprovalLifecycleHold,
  type PartnerApprovalLifecycleTarget,
  type PartnerApprovalRuleCandidate,
  type PartnerApprovalRuleResolutionError,
  type PartnerApprovalTransaction,
} from "@/lib/partner-portal-v2-approvals";

const jest = import.meta.jest;

const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_ACCOUNT_ID = "10000000-0000-4000-8000-000000000002";
const REQUESTER_ID = "20000000-0000-4000-8000-000000000001";
const LOCATION_ID = "30000000-0000-4000-8000-000000000001";
const BOOKING_ID = "40000000-0000-4000-8000-000000000001";
const HOLD_ID = "50000000-0000-4000-8000-000000000001";
const DRAFT_ID = "70000000-0000-4000-8000-000000000001";
const APPOINTMENT_ID = "80000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-09-01T14:00:00.000Z");

function approvalRule(
  idSuffix: number,
  overrides: Partial<PartnerApprovalRuleCandidate> = {},
): PartnerApprovalRuleCandidate {
  return {
    id: `60000000-0000-4000-8000-${idSuffix.toString().padStart(12, "0")}`,
    partnerAccountId: ACCOUNT_ID,
    name: `Rule ${idSuffix}`,
    conditions: {},
    requiredApproverCapabilities: ["approvals.decide"],
    requiredApproverRoleKeys: ["approver"],
    requiredDecisionCount: 1,
    active: true,
    version: 1,
    ...overrides,
  };
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    partnerAccountId: ACCOUNT_ID,
    requestedByMembershipId: REQUESTER_ID,
    requesterRoleKey: "requester",
    serviceKey: "junk_removal_primary",
    locationId: LOCATION_ID,
    amountMinor: 27_500,
    currency: "USD",
    poNumber: "PO-4821",
    costCenter: null,
    ...overrides,
  };
}

function capturedErrorCode(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    return (error as PartnerApprovalRuleResolutionError).code;
  }
  throw new Error("Expected approval resolution to fail.");
}

describe("partner approval request rule resolution", () => {
  it("evaluates every active selector, ignores inactive rules, and snapshots matches", () => {
    const mutableConditions = {
      serviceKeys: ["junk_removal_primary"],
      locationId: LOCATION_ID,
      minimumAmountCents: 25_000,
      maximumAmountMinor: 30_000,
      requesterRoleKey: "requester",
      poRequired: true,
      costCenterState: "missing",
    };
    const mutableRoles = ["approver", "owner"];
    const resolution = resolvePartnerApprovalRequirementFromRules({
      context: context(),
      rules: [
        approvalRule(1, {
          name: "Scoped commercial review",
          conditions: mutableConditions,
          requiredApproverRoleKeys: mutableRoles,
          requiredDecisionCount: 2,
          version: 4,
        }),
        approvalRule(2, {
          name: "Amount review",
          conditions: { minimumAmountMinor: 10_000 },
        }),
        approvalRule(3, {
          conditions: {
            locationId: "30000000-0000-4000-8000-000000000099",
          },
        }),
        approvalRule(4, {
          active: false,
          conditions: { unsupportedSelector: true },
        }),
      ],
    });

    expect(resolution.required).toBe(true);
    if (!resolution.required) throw new Error("Expected approval requirement.");
    expect(resolution.requiredDecisionCount).toBe(2);
    expect(resolution.matchedRules.map((rule) => rule.name)).toEqual([
      "Amount review",
      "Scoped commercial review",
    ]);
    expect(resolution.matchedRules[1]?.conditions).toEqual({
      serviceKeys: ["junk_removal_primary"],
      locationIds: [LOCATION_ID],
      minimumAmountMinor: 25_000,
      maximumAmountMinor: 30_000,
      requesterRoleKeys: ["requester"],
      poNumberState: "present",
      costCenterState: "missing",
    });

    mutableConditions.serviceKeys[0] = "commercial_hauling";
    mutableRoles[0] = "billing";
    expect(resolution.matchedRules[1]?.conditions?.serviceKeys).toEqual([
      "junk_removal_primary",
    ]);
    expect(resolution.matchedRules[1]?.requiredApproverRoleKeys).toEqual([
      "approver",
      "owner",
    ]);
    expect(Object.isFrozen(resolution)).toBe(true);
    expect(Object.isFrozen(resolution.context)).toBe(true);
    expect(Object.isFrozen(resolution.matchedRules)).toBe(true);
    expect(
      Object.isFrozen(resolution.matchedRules[1]?.conditions?.serviceKeys),
    ).toBe(true);
  });

  it("uses max rather than sum for the request-wide distinct decision count", () => {
    const resolution = resolvePartnerApprovalRequirementFromRules({
      context: context(),
      rules: [
        approvalRule(1, { requiredDecisionCount: 3 }),
        approvalRule(2, { requiredDecisionCount: 2 }),
      ],
    });
    expect(resolution).toMatchObject({
      required: true,
      requiredDecisionCount: 3,
    });
  });

  it("returns a frozen no-approval result when no valid active rule matches", () => {
    const resolution = resolvePartnerApprovalRequirementFromRules({
      context: context({ poNumber: null }),
      rules: [
        approvalRule(1, {
          conditions: {
            serviceKey: "commercial_hauling",
            poNumberState: "present",
          },
        }),
      ],
    });
    expect(resolution).toMatchObject({
      required: false,
      requiredDecisionCount: 0,
      matchedRules: [],
    });
    expect(Object.isFrozen(resolution)).toBe(true);
  });

  it("requires amount-bounded rules conservatively when an unpriced request has no amount", () => {
    const resolution = resolvePartnerApprovalRequirementFromRules({
      context: context({ amountMinor: null }),
      rules: [
        approvalRule(1, {
          name: "Amount review while pricing is pending",
          conditions: { minimumAmountMinor: 25_000 },
        }),
        approvalRule(2, {
          name: "Location review",
          conditions: { locationId: LOCATION_ID },
        }),
        approvalRule(3, {
          name: "Different service",
          conditions: {
            serviceKey: "commercial_hauling",
            maximumAmountMinor: 50_000,
          },
        }),
      ],
    });

    expect(resolution.required).toBe(true);
    if (!resolution.required) throw new Error("Expected approval requirement.");
    expect(resolution.context.amountMinor).toBeNull();
    expect(resolution.matchedRules.map((rule) => rule.name)).toEqual([
      "Amount review while pricing is pending",
      "Location review",
    ]);
  });

  it.each([
    [{ unsupportedSelector: true }],
    [
      {
        minimumAmountMinor: 20_000,
        minimumAmountCents: 20_000,
      },
    ],
    [
      {
        minimumAmountMinor: 30_000,
        maximumAmountMinor: 20_000,
      },
    ],
    [{ serviceKeys: [] }],
    [{ requesterRoleKeys: ["OWNER"] }],
    [{ poNumberState: "sometimes" }],
  ])("fails closed for malformed active conditions: %p", (conditions) => {
    expect(
      capturedErrorCode(() =>
        resolvePartnerApprovalRequirementFromRules({
          context: context(),
          rules: [approvalRule(1, { conditions })],
        }),
      ),
    ).toBe("malformed_active_rule");
  });

  it("rejects malformed active rule columns and duplicate rule IDs", () => {
    expect(
      capturedErrorCode(() =>
        resolvePartnerApprovalRequirementFromRules({
          context: context(),
          rules: [approvalRule(1, { requiredApproverCapabilities: [] })],
        }),
      ),
    ).toBe("malformed_active_rule");
    expect(
      capturedErrorCode(() =>
        resolvePartnerApprovalRequirementFromRules({
          context: context(),
          rules: [approvalRule(1), approvalRule(1, { name: "Duplicate" })],
        }),
      ),
    ).toBe("malformed_active_rule");
  });

  it("normalizes documented aliases without accepting ambiguous combinations", () => {
    expect(
      parsePartnerApprovalRuleConditions({
        serviceKey: "junk_removal_primary",
        locationId: LOCATION_ID,
        minimumAmountCents: 10_000,
        maximumAmountCents: 40_000,
        requesterRoleKey: "requester",
        requiresPoNumber: true,
        requiresCostCenter: false,
      }),
    ).toEqual({
      serviceKeys: ["junk_removal_primary"],
      locationIds: [LOCATION_ID],
      minimumAmountMinor: 10_000,
      maximumAmountMinor: 40_000,
      requesterRoleKeys: ["requester"],
      poNumberState: "present",
      costCenterState: "missing",
    });
    expect(
      parsePartnerApprovalRuleConditions({
        poNumberState: "present",
        poRequired: true,
      }),
    ).toBeNull();
  });
});

describe("partner approval request insertion", () => {
  function requiredResolution() {
    const resolution = resolvePartnerApprovalRequirementFromRules({
      context: context(),
      rules: [
        approvalRule(1, {
          name: "Manager approval",
          conditions: { minimumAmountCents: 25_000 },
          requiredApproverRoleKeys: ["approver", "owner"],
          requiredDecisionCount: 2,
          version: 3,
        }),
      ],
    });
    if (!resolution.required) throw new Error("Expected approval requirement.");
    return resolution;
  }

  it("builds an immutable, allowlisted booking-target snapshot with an optional hold", () => {
    const now = new Date("2026-09-01T14:00:00.000Z");
    const holdExpiry = new Date("2026-09-01T14:30:00.000Z");
    const windowStart = new Date("2026-09-02T12:00:00.000Z");
    const windowEnd = new Date("2026-09-02T14:00:00.000Z");
    const insert = buildPartnerApprovalRequestInsert({
      resolution: requiredResolution(),
      target: {
        kind: "booking",
        id: BOOKING_ID,
        partnerAccountId: ACCOUNT_ID,
      },
      request: {
        description: "Remove office furniture",
        notes: "Use the loading dock",
        arrivalWindow: { startAt: windowStart, endAt: windowEnd },
        address: {
          line1: "100 Main Street",
          line2: "Suite 400",
          city: "Raleigh",
          state: "NC",
          postalCode: "27601",
          country: "US",
        },
      },
      approvalHold: {
        id: HOLD_ID,
        partnerAccountId: ACCOUNT_ID,
        expiresAt: holdExpiry,
      },
      now,
    });

    expect(insert).toMatchObject({
      partnerAccountId: ACCOUNT_ID,
      partnerBookingId: BOOKING_ID,
      bookingDraftId: null,
      requestedByMembershipId: REQUESTER_ID,
      state: "pending",
      requiredDecisionCount: 2,
      approvalHoldId: HOLD_ID,
      expiresAt: new Date("2026-09-01T14:30:00.000Z"),
      resolvedAt: null,
      revision: 1,
      requestSnapshot: {
        serviceKey: "junk_removal_primary",
        locationId: LOCATION_ID,
        amountMinor: 27_500,
        currency: "USD",
        requesterRoleKey: "requester",
        poNumber: "PO-4821",
        description: "Remove office furniture",
        notes: "Use the loading dock",
        scheduledStartAt: "2026-09-02T12:00:00.000Z",
        scheduledEndAt: "2026-09-02T14:00:00.000Z",
        address: {
          line1: "100 Main Street",
          line2: "Suite 400",
          city: "Raleigh",
          state: "NC",
          postalCode: "27601",
          country: "US",
        },
      },
      ruleSnapshot: [
        {
          name: "Manager approval",
          version: 3,
          requiredApproverRoleKeys: ["approver", "owner"],
          requiredDecisionCount: 2,
          conditions: { minimumAmountMinor: 25_000 },
        },
      ],
    });
    expect(insert.requestSnapshot).not.toHaveProperty("appointmentId");
    expect(insert.requestSnapshot).not.toHaveProperty("internalStartAt");
    expect(insert.requestSnapshot).not.toHaveProperty("accessDetails");
    expect(Object.isFrozen(insert)).toBe(true);
    expect(Object.isFrozen(insert.requestSnapshot)).toBe(true);
    expect(Object.isFrozen(insert.ruleSnapshot)).toBe(true);
    expect(Object.isFrozen(insert.ruleSnapshot[0]?.["conditions"])).toBe(true);

    holdExpiry.setUTCFullYear(2030);
    windowStart.setUTCFullYear(2030);
    expect(insert.expiresAt).toEqual(new Date("2026-09-01T14:30:00.000Z"));
    expect(insert.requestSnapshot["scheduledStartAt"]).toBe(
      "2026-09-02T12:00:00.000Z",
    );
  });

  it("supports a draft target and an approval request without a hold", () => {
    const insert = buildPartnerApprovalRequestInsert({
      resolution: requiredResolution(),
      target: {
        kind: "booking_draft",
        id: BOOKING_ID,
        partnerAccountId: ACCOUNT_ID,
      },
      now: new Date("2026-09-01T14:00:00.000Z"),
    });
    expect(insert).toMatchObject({
      partnerBookingId: null,
      bookingDraftId: BOOKING_ID,
      approvalHoldId: null,
      expiresAt: null,
    });
  });

  it("preserves an unknown amount in the immutable request snapshot", () => {
    const resolution = resolvePartnerApprovalRequirementFromRules({
      context: context({ amountMinor: null }),
      rules: [
        approvalRule(1, {
          conditions: { minimumAmountMinor: 1 },
        }),
      ],
    });
    if (!resolution.required) throw new Error("Expected approval requirement.");
    const insert = buildPartnerApprovalRequestInsert({
      resolution,
      target: {
        kind: "booking_draft",
        id: DRAFT_ID,
        partnerAccountId: ACCOUNT_ID,
      },
      now: NOW,
    });

    expect(insert.requestSnapshot).toHaveProperty("amountMinor", null);
    expect(Object.isFrozen(insert.requestSnapshot)).toBe(true);
  });

  it("rejects expired approval holds and invalid public arrival windows", () => {
    expect(
      capturedErrorCode(() =>
        buildPartnerApprovalRequestInsert({
          resolution: requiredResolution(),
          target: {
            kind: "booking",
            id: BOOKING_ID,
            partnerAccountId: ACCOUNT_ID,
          },
          approvalHold: {
            id: HOLD_ID,
            partnerAccountId: ACCOUNT_ID,
            expiresAt: new Date("2026-09-01T13:59:59.000Z"),
          },
          now: new Date("2026-09-01T14:00:00.000Z"),
        }),
      ),
    ).toBe("invalid_approval_hold");
    expect(
      capturedErrorCode(() =>
        buildPartnerApprovalRequestInsert({
          resolution: requiredResolution(),
          target: {
            kind: "booking",
            id: BOOKING_ID,
            partnerAccountId: ACCOUNT_ID,
          },
          request: {
            arrivalWindow: {
              startAt: new Date("2026-09-02T14:00:00.000Z"),
              endAt: new Date("2026-09-02T12:00:00.000Z"),
            },
          },
        }),
      ),
    ).toBe("invalid_request_snapshot");
  });

  it("rejects cross-account target and hold references", () => {
    expect(
      capturedErrorCode(() =>
        buildPartnerApprovalRequestInsert({
          resolution: requiredResolution(),
          target: {
            kind: "booking",
            id: BOOKING_ID,
            partnerAccountId: OTHER_ACCOUNT_ID,
          },
        }),
      ),
    ).toBe("invalid_target");
    expect(
      capturedErrorCode(() =>
        buildPartnerApprovalRequestInsert({
          resolution: requiredResolution(),
          target: {
            kind: "booking",
            id: BOOKING_ID,
            partnerAccountId: ACCOUNT_ID,
          },
          approvalHold: {
            id: HOLD_ID,
            partnerAccountId: OTHER_ACCOUNT_ID,
            expiresAt: new Date("2026-09-01T14:30:00.000Z"),
          },
          now: new Date("2026-09-01T14:00:00.000Z"),
        }),
      ),
    ).toBe("invalid_approval_hold");
  });
});

function lifecycleTarget(
  overrides: Partial<PartnerApprovalLifecycleTarget> = {},
): PartnerApprovalLifecycleTarget {
  return {
    bookingId: BOOKING_ID,
    bookingAccountId: ACCOUNT_ID,
    bookingDraftId: DRAFT_ID,
    bookingRequestedByMembershipId: REQUESTER_ID,
    bookingPropertyId: LOCATION_ID,
    bookingVersion: 3,
    bookingPublicStatus: "approval_needed",
    bookingConfirmationMode: "approval",
    bookingArrivalWindowStartAt: new Date("2026-09-02T12:00:00.000Z"),
    bookingArrivalWindowEndAt: new Date("2026-09-02T14:00:00.000Z"),
    appointmentId: APPOINTMENT_ID,
    appointmentAccountId: ACCOUNT_ID,
    appointmentStatus: "requested",
    appointmentStartAt: null,
    appointmentPromisedArrivalStartAt: null,
    appointmentPromisedArrivalEndAt: null,
    appointmentSchedulePolicyRevision: null,
    appointmentCalendarEventId: null,
    ...overrides,
  };
}

function lifecycleHold(
  overrides: Partial<PartnerApprovalLifecycleHold> = {},
): PartnerApprovalLifecycleHold {
  return {
    id: HOLD_ID,
    partnerAccountId: ACCOUNT_ID,
    partnerBookingDraftId: DRAFT_ID,
    requestedByMembershipId: REQUESTER_ID,
    propertyId: LOCATION_ID,
    startAt: new Date("2026-09-02T12:30:00.000Z"),
    durationMinutes: 120,
    travelBufferMinutes: 30,
    capacityPoolKey: "field_service",
    capacityUnits: 1,
    arrivalWindowStartAt: new Date("2026-09-02T12:00:00.000Z"),
    arrivalWindowEndAt: new Date("2026-09-02T14:00:00.000Z"),
    policyRevision: "policy-7",
    serviceProfileRevision: 4,
    status: "active",
    expiresAt: new Date("2026-09-01T14:30:00.000Z"),
    ...overrides,
  };
}

function lifecycleInput(
  overrides: Partial<Parameters<typeof planPartnerApprovalLifecycle>[0]> = {},
): Parameters<typeof planPartnerApprovalLifecycle>[0] {
  return {
    accountId: ACCOUNT_ID,
    requestedByMembershipId: REQUESTER_ID,
    partnerBookingId: BOOKING_ID,
    bookingDraftId: null,
    approvalHoldId: HOLD_ID,
    approved: true,
    declined: false,
    target: lifecycleTarget(),
    hold: lifecycleHold(),
    now: NOW,
    ...overrides,
  };
}

describe("partner approval final-decision lifecycle planning", () => {
  it("confirms only a valid active account-bound hold", () => {
    const plan = planPartnerApprovalLifecycle(lifecycleInput());
    expect(plan).toEqual({
      kind: "confirm",
      approvalState: "approved",
      releaseApprovalHold: false,
    });
    expect(Object.isFrozen(plan)).toBe(true);
  });

  it.each([
    ["expired", { hold: lifecycleHold({ expiresAt: NOW }) }],
    ["missing", { hold: null }],
    ["released", { hold: lifecycleHold({ status: "released" }) }],
    [
      "cross-account",
      { hold: lifecycleHold({ partnerAccountId: OTHER_ACCOUNT_ID }) },
    ],
    [
      "different public window",
      {
        hold: lifecycleHold({
          arrivalWindowStartAt: new Date("2026-09-02T13:00:00.000Z"),
          arrivalWindowEndAt: new Date("2026-09-02T15:00:00.000Z"),
        }),
      },
    ],
    [
      "non-two-hour public window",
      {
        target: lifecycleTarget({
          bookingArrivalWindowEndAt: new Date("2026-09-02T15:00:00.000Z"),
        }),
        hold: lifecycleHold({
          arrivalWindowEndAt: new Date("2026-09-02T15:00:00.000Z"),
        }),
      },
    ],
    [
      "internal start outside its public window",
      {
        hold: lifecycleHold({ startAt: new Date("2026-09-02T15:00:00.000Z") }),
      },
    ],
  ])(
    "records approval without a schedule promise for a %s hold",
    (_case, overrides) => {
      expect(planPartnerApprovalLifecycle(lifecycleInput(overrides))).toEqual({
        kind: "approved_needs_reschedule",
        approvalState: "approved_needs_reschedule",
        releaseApprovalHold: false,
      });
    },
  );

  it("keeps a manual or draft-only approval unscheduled when it has no hold", () => {
    expect(
      planPartnerApprovalLifecycle(
        lifecycleInput({
          partnerBookingId: null,
          bookingDraftId: DRAFT_ID,
          approvalHoldId: null,
          target: null,
          hold: null,
        }),
      ),
    ).toEqual({
      kind: "approved_needs_reschedule",
      approvalState: "approved_needs_reschedule",
      releaseApprovalHold: false,
    });
  });

  it("declines the linked request and releases only its active bound hold", () => {
    expect(
      planPartnerApprovalLifecycle(
        lifecycleInput({ approved: false, declined: true }),
      ),
    ).toEqual({
      kind: "decline",
      approvalState: "declined",
      releaseApprovalHold: true,
    });
    expect(
      planPartnerApprovalLifecycle(
        lifecycleInput({
          approved: false,
          declined: true,
          hold: lifecycleHold({ status: "released" }),
        }),
      ),
    ).toEqual({
      kind: "decline",
      approvalState: "declined",
      releaseApprovalHold: false,
    });
  });

  it("leaves an intermediate decision pending", () => {
    expect(
      planPartnerApprovalLifecycle(
        lifecycleInput({ approved: false, declined: false }),
      ),
    ).toEqual({
      kind: "pending",
      approvalState: "pending",
      releaseApprovalHold: false,
    });
  });

  it.each([
    [
      "cross-account target",
      { target: lifecycleTarget({ bookingAccountId: OTHER_ACCOUNT_ID }) },
    ],
    [
      "already scheduled target",
      {
        target: lifecycleTarget({
          appointmentStartAt: new Date("2026-09-02T12:30:00.000Z"),
        }),
      },
    ],
  ])("fails closed for a %s", (_case, overrides) => {
    expect(planPartnerApprovalLifecycle(lifecycleInput(overrides))).toEqual({
      kind: "conflict",
      approvalState: "pending",
      releaseApprovalHold: false,
    });
  });
});

describe("transaction-bound partner approval resolution", () => {
  it("loads the account-scoped active membership and rules without opening a transaction", async () => {
    const membershipLimit = jest
      .fn()
      .mockResolvedValue([{ roleKey: "requester" }]);
    const locationLimit = jest.fn().mockResolvedValue([{ id: LOCATION_ID }]);
    const ruleLimit = jest.fn().mockResolvedValue([
      approvalRule(1, {
        conditions: { minimumAmountMinor: 25_000 },
      }),
    ]);
    const transaction = jest.fn();
    const tx = {
      transaction,
      select: jest
        .fn()
        .mockReturnValueOnce({
          from: () => ({
            where: () => ({ limit: membershipLimit }),
          }),
        })
        .mockReturnValueOnce({
          from: () => ({
            where: () => ({ limit: locationLimit }),
          }),
        })
        .mockReturnValueOnce({
          from: () => ({
            where: () => ({
              orderBy: () => ({ limit: ruleLimit }),
            }),
          }),
        }),
    } as unknown as PartnerApprovalTransaction;

    const resolution = await resolvePartnerApprovalRequirement({
      tx,
      partnerAccountId: ACCOUNT_ID,
      requestedByMembershipId: REQUESTER_ID,
      serviceKey: "junk_removal_primary",
      locationId: LOCATION_ID,
      amountMinor: 27_500,
      currency: "USD",
      poNumber: "PO-4821",
      costCenter: null,
    });

    expect(resolution).toMatchObject({
      required: true,
      requiredDecisionCount: 1,
      context: { requesterRoleKey: "requester" },
    });
    expect(membershipLimit).toHaveBeenCalledWith(1);
    expect(locationLimit).toHaveBeenCalledWith(1);
    expect(ruleLimit).toHaveBeenCalledWith(51);
    expect(transaction).not.toHaveBeenCalled();
  });
});
