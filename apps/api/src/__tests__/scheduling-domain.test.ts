import {
  DEFAULT_PARTNER_WINDOW_MINUTES,
  DEFAULT_SCHEDULE_HOLD_TTL_MINUTES,
  DEFAULT_SCHEDULE_SLOT_INTERVAL_MINUTES,
  SchedulingDomainError,
  assertInstantConfirmationEligible,
  canonicalizeSchedulingServiceKey,
  createScheduleDemand,
  createScheduleInterval,
  createScheduleOccupancy,
  createSchedulePolicySnapshot,
  createSchedulePolicySnapshotFromLegacy,
  evaluateInstantConfirmEligibility,
  evaluateWeightedScheduleCapacity,
  groupThirtyMinutePartnerWindows,
  normalizeSchedulingReviewReasons,
  requireSchedulingServiceKey,
  scheduleIntervalsOverlap,
  toSafeSchedulingError,
  type ScheduleCandidateSlot,
  type SchedulePolicySnapshot,
} from "@/lib/scheduling";

function interval(startAt: string, endAt: string) {
  return createScheduleInterval(new Date(startAt), new Date(endAt));
}

function policyFixture(): SchedulePolicySnapshot {
  const weekdays = {
    monday: [{ startMinute: 8 * 60, endMinute: 17 * 60 + 30 }],
    tuesday: [{ startMinute: 8 * 60, endMinute: 17 * 60 + 30 }],
    wednesday: [{ startMinute: 8 * 60, endMinute: 17 * 60 + 30 }],
    thursday: [{ startMinute: 8 * 60, endMinute: 17 * 60 + 30 }],
    friday: [{ startMinute: 8 * 60, endMinute: 17 * 60 + 30 }],
    saturday: [{ startMinute: 9 * 60, endMinute: 14 * 60 }],
    sunday: [],
  } as const;
  const channels = {
    partner_portal: {
      minimumNoticeMinutes: 0,
      minimumCalendarLeadDays: 1,
      allowsInstantConfirmation: true,
    },
    public_quote: {
      minimumNoticeMinutes: 120,
      minimumCalendarLeadDays: 0,
      allowsInstantConfirmation: true,
    },
    instant_quote: {
      minimumNoticeMinutes: 120,
      minimumCalendarLeadDays: 0,
      allowsInstantConfirmation: true,
    },
    staff: {
      minimumNoticeMinutes: 0,
      minimumCalendarLeadDays: 0,
      allowsInstantConfirmation: true,
    },
    autonomous: {
      minimumNoticeMinutes: 120,
      minimumCalendarLeadDays: 0,
      allowsInstantConfirmation: true,
    },
  } as const;
  return {
    revision: "policy-2026-08-30",
    timezone: "America/New_York",
    slotIntervalMinutes: 30,
    partnerWindowMinutes: 120,
    holdTtlMinutes: 15,
    bookingWindowDays: 30,
    defaultTravelBufferMinutes: 30,
    maxJobsPerDay: 6,
    weeklyHours: weekdays,
    dateOverrides: [],
    capacityPools: {
      field_service: { key: "field_service", capacityUnits: 2 },
    },
    channels,
  };
}

describe("canonical scheduling services and demand", () => {
  it("maps known cross-system aliases without guessing unsupported services", () => {
    expect(canonicalizeSchedulingServiceKey(" junk_removal ")).toBe(
      "junk-removal",
    );
    expect(canonicalizeSchedulingServiceKey("junk_removal_primary")).toBe(
      "junk-removal",
    );
    expect(canonicalizeSchedulingServiceKey("Demo + Haul-Off")).toBe(
      "demo-hauloff",
    );
    expect(canonicalizeSchedulingServiceKey("demolition")).toBe("demo-hauloff");
    expect(canonicalizeSchedulingServiceKey("land clearing")).toBe(
      "land-clearing",
    );
    expect(canonicalizeSchedulingServiceKey("rental dumpster")).toBeNull();
  });

  it("builds a normalized, server-derived capacity demand", () => {
    expect(
      createScheduleDemand({
        serviceKey: "junk_removal",
        durationMinutes: 90,
        travelBufferMinutes: 30,
        capacityPoolKey: "FIELD_SERVICE",
        capacityUnits: 2,
        allowsInstantConfirmation: false,
      }),
    ).toEqual({
      serviceKey: "junk-removal",
      durationMinutes: 90,
      travelBufferMinutes: 30,
      capacityPoolKey: "field_service",
      capacityUnits: 2,
      allowsInstantConfirmation: false,
    });
  });

  it("raises a typed, caller-safe error for an unsupported service", () => {
    let failure: unknown;
    try {
      requireSchedulingServiceKey("mystery service");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SchedulingDomainError);
    expect((failure as SchedulingDomainError).toPayload()).toEqual({
      ok: false,
      error: "invalid_service_key",
      message: "Choose a supported service before scheduling.",
      retryable: false,
    });
  });
});

describe("canonical half-open schedule occupancy", () => {
  const demand = createScheduleDemand({
    serviceKey: "junk-removal",
    durationMinutes: 60,
    travelBufferMinutes: 30,
    capacityPoolKey: "field_service",
    capacityUnits: 1,
  });

  it("keeps work duration separate from the post-service buffer", () => {
    const occupancy = createScheduleOccupancy(
      new Date("2026-09-01T13:00:00.000Z"),
      demand,
    );
    expect(occupancy.work.endAt.toISOString()).toBe("2026-09-01T14:00:00.000Z");
    expect(occupancy.occupancy.endAt.toISOString()).toBe(
      "2026-09-01T14:30:00.000Z",
    );
  });

  it("treats exact occupancy boundaries as available", () => {
    const first = createScheduleOccupancy(
      new Date("2026-09-01T13:00:00.000Z"),
      demand,
    );
    const duringTravel = createScheduleOccupancy(
      new Date("2026-09-01T14:00:00.000Z"),
      demand,
    );
    const afterTravel = createScheduleOccupancy(
      new Date("2026-09-01T14:30:00.000Z"),
      demand,
    );
    expect(
      scheduleIntervalsOverlap(first.occupancy, duringTravel.occupancy),
    ).toBe(true);
    expect(
      scheduleIntervalsOverlap(first.occupancy, afterTravel.occupancy),
    ).toBe(false);
  });
});

describe("weighted peak schedule capacity", () => {
  it("does not add sequential overlaps that never coexist", () => {
    const result = evaluateWeightedScheduleCapacity({
      candidate: {
        capacityPoolKey: "field_service",
        capacityUnits: 1,
        occupancy: interval(
          "2026-09-01T13:00:00.000Z",
          "2026-09-01T15:00:00.000Z",
        ),
      },
      poolCapacityUnits: 2,
      blocks: [
        {
          id: "first",
          kind: "appointment",
          capacityPoolKey: "field_service",
          capacityUnits: 1,
          occupancy: interval(
            "2026-09-01T13:00:00.000Z",
            "2026-09-01T14:00:00.000Z",
          ),
        },
        {
          id: "second",
          kind: "appointment",
          capacityPoolKey: "field_service",
          capacityUnits: 1,
          occupancy: interval(
            "2026-09-01T14:00:00.000Z",
            "2026-09-01T15:00:00.000Z",
          ),
        },
      ],
    });
    expect(result).toMatchObject({
      available: true,
      reason: "available",
      peakExistingUnits: 1,
      peakTotalUnits: 2,
      remainingCapacityUnits: 0,
    });
    expect(result.overlappingBlockIds).toEqual(["first", "second"]);
    expect(result.blockingBlockIds).toEqual([]);
  });

  it("rejects a weighted request when concurrent units exceed the pool", () => {
    const result = evaluateWeightedScheduleCapacity({
      candidate: {
        capacityPoolKey: "field_service",
        capacityUnits: 2,
        occupancy: interval(
          "2026-09-01T13:00:00.000Z",
          "2026-09-01T14:00:00.000Z",
        ),
      },
      poolCapacityUnits: 3,
      blocks: [
        {
          id: "two-unit-job",
          kind: "appointment",
          capacityPoolKey: "field_service",
          capacityUnits: 2,
          occupancy: interval(
            "2026-09-01T13:30:00.000Z",
            "2026-09-01T14:30:00.000Z",
          ),
        },
        {
          id: "other-pool",
          kind: "hold",
          capacityPoolKey: "dumpsters",
          capacityUnits: 10,
          occupancy: interval(
            "2026-09-01T13:00:00.000Z",
            "2026-09-01T14:00:00.000Z",
          ),
        },
      ],
    });
    expect(result).toMatchObject({
      available: false,
      reason: "capacity_exceeded",
      peakExistingUnits: 2,
      peakTotalUnits: 4,
    });
    expect(result.blockingBlockIds).toEqual(["two-unit-job"]);
  });

  it("supports explicit source/owner exclusions", () => {
    const result = evaluateWeightedScheduleCapacity({
      candidate: {
        capacityPoolKey: "field_service",
        capacityUnits: 1,
        occupancy: interval(
          "2026-09-01T13:00:00.000Z",
          "2026-09-01T14:00:00.000Z",
        ),
      },
      poolCapacityUnits: 1,
      excludeBlockIds: ["source-appointment"],
      blocks: [
        {
          id: "source-appointment",
          kind: "appointment",
          capacityPoolKey: "field_service",
          capacityUnits: 1,
          occupancy: interval(
            "2026-09-01T13:00:00.000Z",
            "2026-09-01T14:00:00.000Z",
          ),
        },
      ],
    });
    expect(result.available).toBe(true);
    expect(result.overlappingBlockIds).toEqual([]);
  });

  it("treats a zero-unit date override as a closed capacity pool", () => {
    const result = evaluateWeightedScheduleCapacity({
      candidate: {
        capacityPoolKey: "field_service",
        capacityUnits: 1,
        occupancy: interval(
          "2026-12-25T13:00:00.000Z",
          "2026-12-25T14:00:00.000Z",
        ),
      },
      poolCapacityUnits: 0,
      blocks: [],
    });
    expect(result).toMatchObject({
      available: false,
      reason: "request_exceeds_pool_capacity",
      peakExistingUnits: 0,
      peakTotalUnits: 1,
    });
  });
});

describe("partner two-hour availability windows", () => {
  function candidate(
    localTime: string,
    available = true,
  ): ScheduleCandidateSlot {
    const startAt = new Date(`2026-09-01T${localTime}:00-04:00`);
    return {
      id: localTime,
      startAt,
      workEndAt: new Date(startAt.getTime() + 60 * 60_000),
      occupancyEndAt: new Date(startAt.getTime() + 90 * 60_000),
      available,
    };
  }

  it("groups four 30-minute candidates without turning the window into duration", () => {
    const candidates = [
      candidate("08:00"),
      candidate("08:30"),
      candidate("09:00"),
      candidate("09:30"),
      candidate("10:00"),
      candidate("10:30", false),
      candidate("11:00"),
      candidate("11:30"),
    ];
    const windows = groupThirtyMinutePartnerWindows(candidates, {
      timezone: "America/New_York",
      anchorMinuteByLocalDate: { "2026-09-01": 8 * 60 },
    });

    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({
      id: "2026-09-01:0800",
      label: "8:00 AM–10:00 AM",
      availability: "full",
      available: true,
      completeGrid: true,
    });
    expect(windows[0]?.candidates.map((slot) => slot.id)).toEqual([
      "08:00",
      "08:30",
      "09:00",
      "09:30",
    ]);
    expect(windows[0]?.candidates[0]?.workEndAt.toISOString()).toBe(
      "2026-09-01T13:00:00.000Z",
    );
    expect(windows[1]).toMatchObject({
      id: "2026-09-01:1000",
      availability: "partial",
      completeGrid: true,
    });
    expect(windows[1]?.availableCandidates).toHaveLength(3);
  });

  it("rejects a candidate that is not aligned to the declared grid", () => {
    expect(() =>
      groupThirtyMinutePartnerWindows([candidate("08:15")], {
        timezone: "America/New_York",
        anchorMinuteByLocalDate: { "2026-09-01": 8 * 60 },
      }),
    ).toThrow(SchedulingDomainError);
  });
});

describe("review reasons and instant-confirm eligibility", () => {
  const now = new Date("2026-09-01T12:00:00.000Z");

  it("confirms only with policy, service, and durable capacity evidence", () => {
    const result = evaluateInstantConfirmEligibility({
      policyAllowsInstantConfirmation: true,
      demandAllowsInstantConfirmation: true,
      capacityReservation: {
        kind: "active_hold",
        expiresAt: new Date("2026-09-01T12:15:00.000Z"),
      },
      now,
    });
    expect(result).toEqual({
      eligible: true,
      appointmentStatus: "confirmed",
      reviewReasons: [],
      blockers: [],
    });
    expect(() => assertInstantConfirmationEligible(result)).not.toThrow();
  });

  it("deduplicates review reasons and routes the booking to requested", () => {
    const result = evaluateInstantConfirmEligibility({
      policyAllowsInstantConfirmation: true,
      demandAllowsInstantConfirmation: true,
      capacityReservation: { kind: "atomic_capacity_check" },
      reviewReasons: [
        "media_requires_review",
        "non_standard_job",
        "media_requires_review",
      ],
      now,
    });
    expect(result.eligible).toBe(false);
    expect(result.appointmentStatus).toBe("requested");
    expect(result.reviewReasons).toEqual([
      "non_standard_job",
      "media_requires_review",
    ]);
    expect(result.blockers).toEqual([
      { kind: "review_reason", reason: "non_standard_job" },
      { kind: "review_reason", reason: "media_requires_review" },
    ]);
    expect(() => assertInstantConfirmationEligible(result)).toThrow(
      SchedulingDomainError,
    );
  });

  it("rejects an expired hold and unknown review codes safely", () => {
    expect(
      evaluateInstantConfirmEligibility({
        policyAllowsInstantConfirmation: true,
        demandAllowsInstantConfirmation: true,
        capacityReservation: {
          kind: "active_hold",
          expiresAt: now,
        },
        now,
      }),
    ).toMatchObject({
      eligible: false,
      blockers: [{ kind: "capacity_hold_expired" }],
    });
    expect(() => normalizeSchedulingReviewReasons(["unknown_reason"])).toThrow(
      SchedulingDomainError,
    );
    expect(() =>
      evaluateInstantConfirmEligibility({
        policyAllowsInstantConfirmation: true,
        demandAllowsInstantConfirmation: true,
        capacityReservation: { kind: "forged_evidence" } as never,
        now,
      }),
    ).toThrow(SchedulingDomainError);
  });
});

describe("schedule policy snapshots and safe failures", () => {
  it("validates and deeply freezes the transactional policy model", () => {
    const policy = createSchedulePolicySnapshot({
      ...policyFixture(),
      dateOverrides: [
        {
          localDate: "2026-12-25",
          closed: true,
          capacityByPool: { field_service: 0 },
        },
      ],
    });
    expect(policy.slotIntervalMinutes).toBe(
      DEFAULT_SCHEDULE_SLOT_INTERVAL_MINUTES,
    );
    expect(policy.partnerWindowMinutes).toBe(DEFAULT_PARTNER_WINDOW_MINUTES);
    expect(policy.holdTtlMinutes).toBe(DEFAULT_SCHEDULE_HOLD_TTL_MINUTES);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.weeklyHours.monday)).toBe(true);
    expect(Object.isFrozen(policy.capacityPools)).toBe(true);
    expect(policy.dateOverrides[0]?.capacityByPool?.["field_service"]).toBe(0);
  });

  it("adapts the existing policy-center primitives without route-local parsing", () => {
    const channels = policyFixture().channels;
    const policy = createSchedulePolicySnapshotFromLegacy({
      revision: "legacy-policy-v1",
      businessHours: {
        timezone: "America/New_York",
        weekly: {
          monday: [{ start: "08:00", end: "17:30" }],
          tuesday: [{ start: "08:00", end: "17:30" }],
          wednesday: [{ start: "08:00", end: "17:30" }],
          thursday: [{ start: "08:00", end: "17:30" }],
          friday: [{ start: "08:00", end: "17:30" }],
          saturday: [{ start: "09:00", end: "14:00" }],
          sunday: [],
        },
      },
      bookingRules: {
        bookingWindowDays: 30,
        bufferMinutes: 30,
        maxJobsPerDay: 6,
        maxJobsPerCrew: 3,
      },
      capacityUnits: 2,
      channels,
    });

    expect(policy.weeklyHours.saturday).toEqual([
      { startMinute: 9 * 60, endMinute: 14 * 60 },
    ]);
    expect(policy.bookingWindowDays).toBe(30);
    expect(policy.defaultTravelBufferMinutes).toBe(30);
    expect(policy.capacityPools["field_service"]?.capacityUnits).toBe(2);
  });

  it("rejects overlapping business windows", () => {
    const fixture = policyFixture();
    expect(() =>
      createSchedulePolicySnapshot({
        ...fixture,
        weeklyHours: {
          ...fixture.weeklyHours,
          monday: [
            { startMinute: 8 * 60, endMinute: 12 * 60 },
            { startMinute: 11 * 60, endMinute: 13 * 60 },
          ],
        },
      }),
    ).toThrow(SchedulingDomainError);
  });

  it("never reflects an unknown exception message in the public payload", () => {
    const error = toSafeSchedulingError(
      new Error("postgres password and private diagnostic"),
    );
    expect(error.toPayload()).toEqual({
      ok: false,
      error: "invalid_policy",
      message: "Scheduling is temporarily unavailable. Please try again.",
      retryable: true,
    });
    expect(JSON.stringify(error.toPayload())).not.toContain(
      "postgres password",
    );
  });
});
