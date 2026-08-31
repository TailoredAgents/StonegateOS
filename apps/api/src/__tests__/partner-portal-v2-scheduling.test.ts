import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildPartnerJobEvidenceTransferValues,
  calendarAvailabilityReviewReasons,
  computePartnerAvailability,
  createPartnerArrivalWindowDto,
  createPartnerAvailabilityScheduleDto,
  createPartnerHoldDto,
  createPartnerPublicJobScheduleDto,
  createSubmittedPartnerBookingDto,
  evaluateCalendarCoverageState,
  evaluateDraftMediaReadiness,
  parsePartnerDraftMutation,
  partnerBookingSubmissionAppointmentSchedule,
  partnerBookingSubmissionScheduleDisposition,
  validatePartnerBookingDraft,
} from "@/lib/partner-portal-v2-scheduling/domain";
import {
  accountStatusAllowsInstantConfirmation,
  createPartnerRescheduleResultDto,
  partnerDraftMutationInvalidatesHold,
  pricingEligibilityAllowsInstantConfirmation,
} from "@/lib/partner-portal-v2-scheduling/service";
import {
  createScheduleDemand,
  createSchedulePolicySnapshot,
  type ScheduleCapacityBlock,
} from "@/lib/scheduling";

const schedulingServiceSource = readFileSync(
  resolve(process.cwd(), "src/lib/partner-portal-v2-scheduling/service.ts"),
  "utf8",
);

function policy() {
  const hours = [{ startMinute: 8 * 60, endMinute: 17 * 60 }];
  return createSchedulePolicySnapshot({
    revision: "policy-v1",
    timezone: "UTC",
    slotIntervalMinutes: 30,
    partnerWindowMinutes: 120,
    holdTtlMinutes: 10,
    bookingWindowDays: 30,
    defaultTravelBufferMinutes: 30,
    maxJobsPerDay: 6,
    weeklyHours: {
      monday: hours,
      tuesday: hours,
      wednesday: hours,
      thursday: hours,
      friday: hours,
      saturday: [],
      sunday: [],
    },
    dateOverrides: [],
    capacityPools: {
      field_service: { key: "field_service", capacityUnits: 2 },
    },
    channels: {
      partner_portal: {
        minimumNoticeMinutes: 0,
        minimumCalendarLeadDays: 0,
        allowsInstantConfirmation: true,
      },
      public_quote: {
        minimumNoticeMinutes: 0,
        minimumCalendarLeadDays: 0,
        allowsInstantConfirmation: false,
      },
      instant_quote: {
        minimumNoticeMinutes: 0,
        minimumCalendarLeadDays: 0,
        allowsInstantConfirmation: false,
      },
      staff: {
        minimumNoticeMinutes: 0,
        minimumCalendarLeadDays: 0,
        allowsInstantConfirmation: false,
      },
      autonomous: {
        minimumNoticeMinutes: 0,
        minimumCalendarLeadDays: 0,
        allowsInstantConfirmation: false,
      },
    },
  });
}

describe("partner portal V2 scheduling domain", () => {
  it("encodes overlap-boundary dates through their PostgreSQL timestamp columns", () => {
    expect(schedulingServiceSource).toContain(
      "sql.param(\n            input.rangeStartAt,\n            appointments.startAt,\n          )",
    );
    expect(schedulingServiceSource).toContain(
      "sql.param(\n            input.rangeStartAt,\n            appointmentHolds.startAt,\n          )",
    );
    expect(schedulingServiceSource).not.toContain("> ${input.rangeStartAt}`");
  });

  it("never instant-confirms an applicant or other unapproved account state", () => {
    expect(accountStatusAllowsInstantConfirmation("trial_partner")).toBe(false);
    expect(accountStatusAllowsInstantConfirmation("qualified_partner")).toBe(
      false,
    );
    expect(accountStatusAllowsInstantConfirmation("dormant")).toBe(false);
    expect(accountStatusAllowsInstantConfirmation("active_partner")).toBe(true);
    expect(accountStatusAllowsInstantConfirmation("portal_partner")).toBe(true);
    expect(accountStatusAllowsInstantConfirmation("managed_partner")).toBe(
      true,
    );
  });

  it("routes quote-required or explicitly uncertain pricing to review", () => {
    expect(pricingEligibilityAllowsInstantConfirmation({})).toBe(true);
    expect(
      pricingEligibilityAllowsInstantConfirmation({ requiresQuote: true }),
    ).toBe(false);
    expect(
      pricingEligibilityAllowsInstantConfirmation({ reviewRequired: true }),
    ).toBe(false);
    expect(
      pricingEligibilityAllowsInstantConfirmation({
        instantConfirmationEligible: false,
      }),
    ).toBe(false);
  });

  it("only consumes capacity for an eligible instant confirmation", () => {
    expect(
      partnerBookingSubmissionScheduleDisposition({
        approvalRequired: false,
        instantConfirmationEligible: true,
      }),
    ).toEqual({
      holdStatus: "consumed",
      reservesCapacity: true,
      retainsApprovalHold: false,
    });

    expect(
      partnerBookingSubmissionScheduleDisposition({
        approvalRequired: true,
        instantConfirmationEligible: true,
      }),
    ).toEqual({
      holdStatus: "active",
      reservesCapacity: false,
      retainsApprovalHold: true,
    });

    for (const input of [
      { approvalRequired: false, instantConfirmationEligible: false },
      { approvalRequired: true, instantConfirmationEligible: false },
    ]) {
      expect(partnerBookingSubmissionScheduleDisposition(input)).toEqual({
        holdStatus: "released",
        reservesCapacity: false,
        retainsApprovalHold: false,
      });
    }
  });

  it("derives approval routing only from server-loaded account rules", () => {
    expect(schedulingServiceSource).not.toContain(
      'commercial["approvalRequired"]',
    );
    expect(schedulingServiceSource).toContain(
      "resolvePartnerApprovalRequirement({",
    );
    expect(schedulingServiceSource).toContain(
      ".insert(partnerApprovalRequests)",
    );
    expect(schedulingServiceSource).toContain("APPROVAL_HOLD_TTL_MINUTES = 30");
  });

  it("can project downstream CRM records without making a legacy contact the tenant boundary", () => {
    expect(schedulingServiceSource).not.toContain(
      "!account?.portalAccessEnabled || !account.portalContactId",
    );
    expect(schedulingServiceSource).toContain(
      'source: "partner_portal_v2_projection"',
    );
    expect(schedulingServiceSource).toContain(
      'action: "partner.portal.v2.operational_contact_projected"',
    );
    expect(schedulingServiceSource).toContain(
      "eq(contacts.partnerAccountId, account.id)",
    );
  });

  it("uses tenant-safe not-found responses for every scoped draft or location miss", () => {
    expect(schedulingServiceSource).not.toContain(
      '"You do not have access to this service location."',
    );
    expect(schedulingServiceSource).not.toContain(
      '"You do not have access to this booking draft."',
    );
  });

  it("keeps an active hold when a full autosave repeats the selected location and service", () => {
    expect(
      partnerDraftMutationInvalidatesHold({
        currentLocationId: "11111111-1111-4111-8111-111111111111",
        currentServiceKey: "junk-removal",
        mutation: {
          locationId: "11111111-1111-4111-8111-111111111111",
          serviceKey: "junk-removal",
        },
      }),
    ).toBe(false);
    expect(
      partnerDraftMutationInvalidatesHold({
        currentLocationId: "11111111-1111-4111-8111-111111111111",
        currentServiceKey: "junk-removal",
        mutation: {
          locationId: "22222222-2222-4222-8222-222222222222",
          serviceKey: "junk-removal",
        },
      }),
    ).toBe(true);
    expect(
      partnerDraftMutationInvalidatesHold({
        currentLocationId: "11111111-1111-4111-8111-111111111111",
        currentServiceKey: "junk-removal",
        mutation: {
          serviceKey: "commercial-hauling",
        },
      }),
    ).toBe(true);
  });

  it("keeps review and approval appointments unscheduled while preserving only the preferred window on the job", () => {
    const internalStartAt = new Date("2026-09-01T12:30:00.000Z");
    const preferredArrivalStartAt = new Date("2026-09-01T12:00:00.000Z");
    const preferredArrivalEndAt = new Date("2026-09-01T14:00:00.000Z");
    const reviewSchedule = partnerBookingSubmissionAppointmentSchedule({
      disposition: partnerBookingSubmissionScheduleDisposition({
        approvalRequired: true,
        instantConfirmationEligible: false,
      }),
      internalStartAt,
      preferredArrivalStartAt,
      preferredArrivalEndAt,
      policyRevision: "policy-v1",
    });

    expect(reviewSchedule).toEqual({
      startAt: null,
      promisedArrivalStartAt: null,
      promisedArrivalEndAt: null,
      schedulePolicyRevision: null,
    });

    const instantSchedule = partnerBookingSubmissionAppointmentSchedule({
      disposition: partnerBookingSubmissionScheduleDisposition({
        approvalRequired: false,
        instantConfirmationEligible: true,
      }),
      internalStartAt,
      preferredArrivalStartAt,
      preferredArrivalEndAt,
      policyRevision: "policy-v1",
    });
    expect(instantSchedule).toEqual({
      startAt: internalStartAt,
      promisedArrivalStartAt: preferredArrivalStartAt,
      promisedArrivalEndAt: preferredArrivalEndAt,
      schedulePolicyRevision: "policy-v1",
    });
  });

  it("returns only the opaque job id and preferred public window after submission", () => {
    const dto = createSubmittedPartnerBookingDto({
      id: "job-opaque-id",
      draftId: "draft-opaque-id",
      publicStatus: "under_review",
      confirmationMode: "review",
      arrivalWindowStartAt: new Date("2026-09-01T12:00:00.000Z"),
      arrivalWindowEndAt: new Date("2026-09-01T14:00:00.000Z"),
      reviewReasons: ["calendar_stale"],
      version: 1,
      createdAt: new Date("2026-08-30T12:00:00.000Z"),
    });

    expect(dto).toEqual({
      id: "job-opaque-id",
      draftId: "draft-opaque-id",
      publicStatus: "under_review",
      confirmationMode: "review",
      arrivalWindowStartAt: "2026-09-01T12:00:00.000Z",
      arrivalWindowEndAt: "2026-09-01T14:00:00.000Z",
      reviewReasons: ["calendar_stale"],
      version: 1,
      createdAt: "2026-08-30T12:00:00.000Z",
    });
    expect(dto).not.toHaveProperty("appointmentId");
    expect(dto).not.toHaveProperty("startAt");
  });

  it("returns an unscheduled review receipt without implying an arrival promise", () => {
    const dto = createSubmittedPartnerBookingDto({
      id: "job-review-id",
      draftId: "draft-review-id",
      publicStatus: "under_review",
      confirmationMode: "review",
      arrivalWindowStartAt: null,
      arrivalWindowEndAt: null,
      reviewReasons: ["availability_unverified", "manual_review_required"],
      version: 1,
      createdAt: new Date("2026-08-30T12:00:00.000Z"),
    });

    expect(dto).toEqual(
      expect.objectContaining({
        id: "job-review-id",
        arrivalWindowStartAt: null,
        arrivalWindowEndAt: null,
        confirmationMode: "review",
      }),
    );
    expect(dto).not.toHaveProperty("appointmentId");
    expect(dto).not.toHaveProperty("startAt");
  });

  it("serializes availability and holds without planned candidates or appointment IDs", () => {
    const internalPlannedStart = "2026-09-01T12:30:00.000Z";
    const rawWindow = {
      id: "2026-09-01:0800",
      localDate: "2026-09-01",
      startAt: new Date("2026-09-01T12:00:00.000Z"),
      endAt: new Date("2026-09-01T14:00:00.000Z"),
      label: "8:00 AM–10:00 AM",
      available: true,
      candidates: [{ startAt: internalPlannedStart }],
      appointmentId: "internal-appointment-id",
    };
    const windowDto = createPartnerArrivalWindowDto(rawWindow);
    const availabilityDto = createPartnerAvailabilityScheduleDto({
      timezone: "America/New_York",
      calendarState: "current",
      reviewReasons: [],
      instantConfirmationEligible: true,
      windows: [rawWindow],
      candidates: [{ startAt: internalPlannedStart }],
      appointmentId: "internal-appointment-id",
    } as Parameters<typeof createPartnerAvailabilityScheduleDto>[0]);
    const holdDto = createPartnerHoldDto({
      id: "opaque-hold-id",
      draftId: "opaque-draft-id",
      status: "active",
      arrivalWindowStartAt: new Date("2026-09-01T12:00:00.000Z"),
      arrivalWindowEndAt: new Date("2026-09-01T14:00:00.000Z"),
      expiresAt: new Date("2026-08-30T12:10:00.000Z"),
      startAt: new Date(internalPlannedStart),
      workEndAt: new Date("2026-09-01T13:30:00.000Z"),
      occupancyEndAt: new Date("2026-09-01T14:00:00.000Z"),
      appointmentId: "internal-appointment-id",
    } as Parameters<typeof createPartnerHoldDto>[0]);

    for (const dto of [windowDto, availabilityDto, holdDto]) {
      const serialized = JSON.stringify(dto);
      expect(serialized).not.toContain(internalPlannedStart);
      expect(serialized).not.toContain("internal-appointment-id");
      expect(dto).not.toHaveProperty("appointmentId");
      expect(dto).not.toHaveProperty("candidates");
    }
    expect(holdDto).not.toHaveProperty("startAt");
    expect(holdDto).not.toHaveProperty("workEndAt");
    expect(holdDto).not.toHaveProperty("occupancyEndAt");
  });

  it("serializes job and reschedule results with only the promised arrival window", () => {
    const internalStartAt = new Date("2026-09-01T12:30:00.000Z");
    const schedule = createPartnerPublicJobScheduleDto({
      arrivalWindowStartAt: new Date("2026-09-01T12:00:00.000Z"),
      arrivalWindowEndAt: new Date("2026-09-01T14:00:00.000Z"),
      timezone: "America/New_York",
      completedAt: null,
      startAt: internalStartAt,
      appointmentId: "internal-appointment-id",
    } as Parameters<typeof createPartnerPublicJobScheduleDto>[0]);
    const reschedule = createPartnerRescheduleResultDto({
      mode: "instant",
      booking: {
        id: "opaque-job-id",
        publicStatus: "confirmed",
        requestedReviewReasons: [],
        version: 2,
        updatedAt: new Date("2026-08-30T12:00:00.000Z"),
        arrivalWindowStartAt: new Date("2026-09-01T12:00:00.000Z"),
        arrivalWindowEndAt: new Date("2026-09-01T14:00:00.000Z"),
      },
      appointment: {
        status: "confirmed",
        startAt: internalStartAt,
        id: "internal-appointment-id",
      },
    } as Parameters<typeof createPartnerRescheduleResultDto>[0]);

    for (const dto of [schedule, reschedule]) {
      const serialized = JSON.stringify(dto);
      expect(serialized).not.toContain(internalStartAt.toISOString());
      expect(serialized).not.toContain("internal-appointment-id");
      expect(dto).not.toHaveProperty("appointmentId");
      expect(dto).not.toHaveProperty("startAt");
    }
    expect(reschedule.jobId).toBe("opaque-job-id");
    expect(reschedule.arrivalWindowStartAt).toBe("2026-09-01T12:00:00.000Z");
    expect(reschedule.arrivalWindowEndAt).toBe("2026-09-01T14:00:00.000Z");
  });

  it("requires fresh external-busy coverage with no pending calendar notification", () => {
    const now = new Date("2026-08-30T12:15:00.000Z");
    const exactlyFifteenMinutesOld = new Date("2026-08-30T12:00:00.000Z");
    const base = {
      configured: true,
      now,
      staleMinutes: 15,
      lastSyncedAt: exactlyFifteenMinutesOld,
      externalBusyCoverageSyncedAt: exactlyFifteenMinutesOld,
      lastNotificationAt: null,
    };
    expect(evaluateCalendarCoverageState(base)).toBe("current");
    expect(
      evaluateCalendarCoverageState({
        ...base,
        externalBusyCoverageSyncedAt: new Date(
          exactlyFifteenMinutesOld.getTime() - 1,
        ),
      }),
    ).toBe("stale");
    expect(
      evaluateCalendarCoverageState({
        ...base,
        lastSyncedAt: now,
        externalBusyCoverageSyncedAt: now,
        lastNotificationAt: new Date(now.getTime() + 1),
      }),
    ).toBe("stale");
    expect(
      evaluateCalendarCoverageState({
        ...base,
        externalBusyCoverageSyncedAt: null,
      }),
    ).toBe("unconfigured");
  });

  it("fails calendar uncertainty to review instead of false confirmation", () => {
    expect(
      calendarAvailabilityReviewReasons({
        state: "unconfigured",
        externalBusyCoverageVerified: false,
      }),
    ).toEqual(["calendar_unconfigured"]);
    expect(
      calendarAvailabilityReviewReasons({
        state: "stale",
        externalBusyCoverageVerified: false,
      }),
    ).toEqual(["calendar_stale"]);
    expect(
      calendarAvailabilityReviewReasons({
        state: "current",
        externalBusyCoverageVerified: false,
      }),
    ).toEqual(["availability_unverified"]);
    expect(
      calendarAvailabilityReviewReasons({
        state: "current",
        externalBusyCoverageVerified: true,
      }),
    ).toEqual([]);
  });

  it("caps draft-media transfer at 40 and blocks instant confirmation for non-ready assets", () => {
    expect(
      evaluateDraftMediaReadiness([
        {
          status: "processing",
          readyAt: null,
          deletedAt: null,
        },
      ]),
    ).toEqual({ activeCount: 1, readyForInstantConfirmation: false });

    const readyAssets = Array.from({ length: 41 }, () => ({
      status: "ready",
      readyAt: new Date("2026-08-30T12:00:00.000Z"),
      deletedAt: null,
    }));
    expect(() => evaluateDraftMediaReadiness(readyAssets)).toThrow(
      "Review the highlighted fields",
    );
  });

  it("copies every active draft-media association into account-bound job evidence", () => {
    const createdAt = new Date("2026-08-30T12:00:00.000Z");
    expect(
      buildPartnerJobEvidenceTransferValues({
        partnerAccountId: "account-1",
        partnerBookingId: "booking-1",
        createdAt,
        associations: [
          {
            mediaAssetId: "asset-1",
            category: "before",
            caption: "Loading area",
            sortOrder: 7,
            uploadedByMembershipId: "membership-1",
          },
        ],
      }),
    ).toEqual([
      {
        partnerAccountId: "account-1",
        partnerBookingId: "booking-1",
        mediaAssetId: "asset-1",
        category: "before",
        caption: "Loading area",
        sortOrder: 7,
        uploadedByMembershipId: "membership-1",
        createdAt,
      },
    ]);
  });

  it("accepts bounded autosave fields and rejects unsupported input", () => {
    expect(
      parsePartnerDraftMutation({
        locationId: "11111111-1111-4111-8111-111111111111",
        description: "  Remove office furniture  ",
        scope: { itemCount: 12 },
      }),
    ).toEqual({
      locationId: "11111111-1111-4111-8111-111111111111",
      description: "Remove office furniture",
      scope: { itemCount: 12 },
    });

    expect(() =>
      parsePartnerDraftMutation({ partnerAccountId: "another-tenant" }),
    ).toThrow("Review the highlighted fields");
  });

  it("accepts only public commercial fields and rejects client approval flags", () => {
    expect(
      parsePartnerDraftMutation({
        commercial: {
          poNumber: "  PO-2048  ",
          costCenter: "  Mid-Atlantic  ",
          projectReference: "  Building C  ",
          billingContact: {
            name: "  Accounts Payable  ",
            email: "  ap@example.com  ",
          },
        },
      }),
    ).toEqual({
      commercial: {
        poNumber: "PO-2048",
        costCenter: "Mid-Atlantic",
        projectReference: "Building C",
        billingContact: {
          name: "Accounts Payable",
          email: "ap@example.com",
        },
      },
    });

    for (const approvalRequired of [true, false]) {
      expect(() =>
        parsePartnerDraftMutation({
          commercial: { approvalRequired },
        }),
      ).toThrow("Review the highlighted fields");
    }
    expect(() =>
      parsePartnerDraftMutation({
        commercial: {
          billingContact: {
            name: "Accounts Payable",
            email: "ap@example.com",
            internalBillingRole: "owner",
          },
        },
      }),
    ).toThrow("Review the highlighted fields");
  });

  it("normalizes bounded, distinct preferred review windows", () => {
    expect(
      parsePartnerDraftMutation({
        preferredWindows: [
          {
            localDate: "2026-09-08",
            timeOfDay: "morning",
            timezone: "America/New_York",
          },
          {
            localDate: "2026-09-09",
            timeOfDay: "anytime",
            timezone: "America/New_York",
          },
        ],
      }),
    ).toEqual({
      preferredWindows: [
        {
          localDate: "2026-09-08",
          timeOfDay: "morning",
          timezone: "America/New_York",
        },
        {
          localDate: "2026-09-09",
          timeOfDay: "anytime",
          timezone: "America/New_York",
        },
      ],
    });
    expect(() =>
      parsePartnerDraftMutation({
        preferredWindows: [
          {
            localDate: "2026-09-08",
            timeOfDay: "overnight",
            timezone: "America/New_York",
          },
        ],
      }),
    ).toThrow("Review the highlighted fields");
  });

  it("understands seeded base-field requirements without treating them as scope paths", () => {
    const result = validatePartnerBookingDraft({
      locationId: "11111111-1111-4111-8111-111111111111",
      serviceKey: "junk_removal_primary",
      scope: { itemCount: 3 },
      description: "Remove three desks",
      onSiteContact: { name: "Site lead", phone: "+14045550100" },
      proofRequirements: { before: 1, after: 1 },
      commercial: {},
      location: {
        id: "11111111-1111-4111-8111-111111111111",
        propertyId: "22222222-2222-4222-8222-222222222222",
        geocodeStatus: "verified",
        serviceAreaStatus: "eligible",
      },
      catalog: {
        active: true,
        instantBookable: false,
        requiredScopeFields: [],
        automaticReviewRules: {},
      },
      profile: {
        requiredScopeFields: ["description", "location", "onSiteContact"],
        automaticReviewRules: {},
      },
    });

    expect(result.valid).toBe(true);
    expect(result.fieldErrors).toEqual({});
    expect(result.reviewReasons).toEqual([]);
  });

  it("treats a null optional billing-contact snapshot as absent", () => {
    const result = validatePartnerBookingDraft({
      locationId: "11111111-1111-4111-8111-111111111111",
      serviceKey: "junk_removal_primary",
      scope: {},
      description: "Remove office furniture",
      onSiteContact: { name: "Site lead", phone: "+14045550100" },
      proofRequirements: { before: 1, after: 1 },
      commercial: { billingContact: null },
      location: {
        id: "11111111-1111-4111-8111-111111111111",
        propertyId: "22222222-2222-4222-8222-222222222222",
        geocodeStatus: "verified",
        serviceAreaStatus: "eligible",
      },
      catalog: {
        active: true,
        instantBookable: true,
        requiredScopeFields: [],
        automaticReviewRules: {},
      },
      profile: {
        requiredScopeFields: [],
        automaticReviewRules: {},
      },
    });

    expect(result.valid).toBe(true);
    expect(result.fieldErrors).toEqual({});
  });

  it("uses buffered half-open occupancy and weighted capacity", () => {
    const demand = createScheduleDemand({
      serviceKey: "junk-removal",
      durationMinutes: 60,
      travelBufferMinutes: 30,
      capacityPoolKey: "field_service",
      capacityUnits: 1,
      allowsInstantConfirmation: true,
    });
    const blocks: ScheduleCapacityBlock[] = [
      {
        id: "appointment:existing",
        kind: "appointment",
        capacityPoolKey: "field_service",
        capacityUnits: 2,
        occupancy: {
          startAt: new Date("2026-09-01T09:00:00.000Z"),
          endAt: new Date("2026-09-01T10:00:00.000Z"),
        },
      },
    ];
    const result = computePartnerAvailability({
      policy: policy(),
      demand,
      blocks,
      rangeStartAt: new Date("2026-09-01T08:00:00.000Z"),
      rangeEndAt: new Date("2026-09-01T12:00:00.000Z"),
      now: new Date("2026-08-31T08:00:00.000Z"),
    });

    const atEight = result.candidates.find(
      (candidate) => candidate.id === "2026-09-01T08:00:00.000Z",
    );
    const atTen = result.candidates.find(
      (candidate) => candidate.id === "2026-09-01T10:00:00.000Z",
    );
    expect(atEight).toEqual(
      expect.objectContaining({
        available: false,
        reason: "capacity",
      }),
    );
    expect(atTen).toEqual(expect.objectContaining({ available: true }));
  });

  it("groups four 30-minute starts into each two-hour partner window", () => {
    const result = computePartnerAvailability({
      policy: policy(),
      demand: createScheduleDemand({
        serviceKey: "junk-removal",
        durationMinutes: 60,
        travelBufferMinutes: 30,
        capacityPoolKey: "field_service",
        capacityUnits: 1,
      }),
      blocks: [],
      rangeStartAt: new Date("2026-09-01T08:00:00.000Z"),
      rangeEndAt: new Date("2026-09-01T12:00:00.000Z"),
      now: new Date("2026-08-31T08:00:00.000Z"),
    });

    expect(result.windows).toHaveLength(2);
    expect(result.windows[0]?.candidates).toHaveLength(4);
    expect(result.windows[0]).toEqual(
      expect.objectContaining({
        startAt: new Date("2026-09-01T08:00:00.000Z"),
        endAt: new Date("2026-09-01T10:00:00.000Z"),
        completeGrid: true,
      }),
    );
  });
});
