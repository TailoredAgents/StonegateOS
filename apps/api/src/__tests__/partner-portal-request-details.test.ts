import { parsePartnerRequestDetails } from "@myst-os/sdk";
import {
  buildPartnerRequestDetails,
  type PartnerRequestDetailsSource,
} from "@/lib/partner-request-details";

function source(
  overrides: Partial<PartnerRequestDetailsSource> = {},
): PartnerRequestDetailsSource {
  return {
    jobId: "job-one",
    accountId: "account-one",
    accountName: "Example company",
    serviceKey: "site_cleanout",
    serviceLabel: "Current catalog label",
    tierKey: "large",
    publicStatus: "under_review",
    confirmationMode: "review",
    originalJobId: "original-job",
    scopeSnapshot: {
      serviceLabel: "Booked site cleanout",
      description: "D".repeat(4_000),
      crewInstructions: "C".repeat(4_000),
      accessDetails: "A".repeat(4_000),
      onSiteContact: {
        name: "N".repeat(200),
        phone: "5550000100",
        email: "site@example.test",
      },
      locationSnapshot: {
        id: "location-one",
        name: "East site",
        externalPropertyId: "BUILDING-2",
        timezone: "America/New_York",
        address: {
          line1: "1 Test Street",
          line2: "Unit 2",
          city: "Atlanta",
          state: "GA",
          postalCode: "30301",
        },
        accessSecret: "DO-NOT-EXPOSE-LOCATION-SECRET",
      },
      scope: {
        itemCount: 0,
        volumeCubicYards: 2.5,
        restrictedItems: false,
        nonStandard: false,
        hazardCategories: ["paint"],
        equipmentNeeds: ["heavy_lift"],
        requiredCompletion: { localDate: "2026-10-01", localTime: "15:30" },
        multiStop: true,
        multiStopDetails: "M".repeat(1_000),
        alternateContact: {
          name: "Alternate person",
          email: "alternate@example.test",
        },
        billingEmail: "DO-NOT-EXPOSE-ARBITRARY-BILLING",
        accessCode: "DO-NOT-EXPOSE-ARBITRARY-CODE",
        internalNotes: "DO-NOT-EXPOSE-INTERNAL",
      },
      preferredWindows: [
        {
          localDate: "2026-09-30",
          timeOfDay: "morning",
          timezone: "America/New_York",
        },
      ],
      scheduleAssistancePreference: "callback",
    },
    rateSnapshot: {
      tierLabel: "Large site (at booking)",
      internalPrice: "DO-NOT-EXPOSE-INTERNAL-RATE",
    },
    addOnsSnapshot: [
      {
        key: "handling",
        label: "Extra handling",
        unitLabel: "item",
        quantity: 2,
        unitAmountMinor: 3_500,
        lineTotalMinor: 7_000,
        currency: "USD",
        requiresReview: true,
      },
    ],
    proofRequirementsSnapshot: { before: false, after: 3, package: true },
    poNumber: "PO-1",
    costCenter: "EAST",
    projectReference: "REF-2",
    billingContactSnapshot: {
      name: "Accounts payable",
      email: "finance@example.test",
      privateMemo: "DO-NOT-EXPOSE-BILLING-MEMO",
    },
    appointmentStatus: "requested",
    appointmentStartAt: null,
    schedulingTimezone: "America/New_York",
    promisedArrivalStartAt: null,
    promisedArrivalEndAt: null,
    arrivalWindowStartAt: null,
    arrivalWindowEndAt: null,
    ...overrides,
  };
}

describe("partner request staff handoff", () => {
  it("preserves every supported operational field, original names, zero/false values and complete valid text", () => {
    const result = buildPartnerRequestDetails(
      source(),
      { financials: true, photos: true },
      2,
    );
    expect(parsePartnerRequestDetails(result)).toEqual(result);
    expect(result.service).toEqual({
      key: "site_cleanout",
      label: "Booked site cleanout",
      tierKey: "large",
      tierLabel: "Large site (at booking)",
    });
    expect(result.description).toHaveLength(4_000);
    expect(result.crewInstructions).toHaveLength(4_000);
    expect(result.accessDetails).toHaveLength(4_000);
    expect(result.onSiteContact?.name).toHaveLength(200);
    expect(result.alternateContact).toEqual({
      name: "Alternate person",
      phone: null,
      email: "alternate@example.test",
    });
    expect(result.scope).toMatchObject({
      itemCount: 0,
      volumeCubicYards: 2.5,
      restrictedItems: true,
      nonStandard: true,
      hazardCategories: ["paint"],
      equipmentNeeds: ["heavy_lift"],
      multiStop: true,
      requiredCompletion: { localDate: "2026-10-01", localTime: "15:30" },
    });
    expect(result.scope.multiStopDetails).toHaveLength(1_000);
    expect(result.addOns[0]).toMatchObject({
      label: "Extra handling",
      quantity: 2,
      unitAmountMinor: 3_500,
      lineTotalMinor: 7_000,
      currency: "USD",
    });
    expect(result.commercial).toEqual({
      poNumber: "PO-1",
      costCenter: "EAST",
      projectReference: "REF-2",
      billingContact: {
        name: "Accounts payable",
        email: "finance@example.test",
      },
    });
    expect(result.proof).toEqual({ before: 0, after: 3, package: true });
    expect(result.scheduling).toMatchObject({
      timezone: "America/New_York",
      preferredWindows: [
        {
          localDate: "2026-09-30",
          timeOfDay: "morning",
          timezone: "America/New_York",
        },
      ],
      assistancePreference: "callback",
      confirmedStartAt: null,
      confirmedWindow: null,
    });
    expect(result.originalJob).toEqual({ jobId: "original-job" });
    expect(JSON.stringify(result)).not.toContain("DO-NOT-EXPOSE");
  });

  it("removes finance data and unavailable photo actions without hiding operational quantities and work references", () => {
    const result = buildPartnerRequestDetails(
      source(),
      { financials: false, photos: false },
      2,
    );
    expect(result.addOns[0]).toMatchObject({
      quantity: 2,
      unitAmountMinor: null,
      lineTotalMinor: null,
      currency: null,
    });
    expect(result.commercial).toEqual({
      poNumber: "PO-1",
      costCenter: "EAST",
      projectReference: "REF-2",
      billingContact: null,
    });
    expect(result.photos).toEqual({ count: 2, detailPath: null });
    expect(result.scope.additionalFields).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("finance@example.test");
    expect(JSON.stringify(result)).not.toContain("DO-NOT-EXPOSE");
  });

  it("keeps requested and confirmed windows distinct after staff chooses another time", () => {
    const input = source();
    const requested = {
      startAt: "2026-09-30T12:00:00.000Z",
      endAt: "2026-09-30T14:00:00.000Z",
    };
    input.scopeSnapshot = {
      ...(input.scopeSnapshot as Record<string, unknown>),
      requestedArrivalWindow: requested,
    };
    input.arrivalWindowStartAt = new Date(requested.startAt);
    input.arrivalWindowEndAt = new Date(requested.endAt);
    expect(
      buildPartnerRequestDetails(input, { financials: false, photos: false })
        .scheduling,
    ).toMatchObject({ requestedWindow: requested, confirmedWindow: null });
    input.appointmentStatus = "confirmed";
    input.publicStatus = "confirmed";
    input.appointmentStartAt = new Date("2026-10-02T14:30:00Z");
    input.arrivalWindowStartAt = new Date("2026-10-02T14:00:00Z");
    input.arrivalWindowEndAt = new Date("2026-10-02T16:00:00Z");
    const result = buildPartnerRequestDetails(input, {
      financials: false,
      photos: false,
    });
    expect(result.scheduling.requestedWindow).toEqual(requested);
    expect(result.scheduling.confirmedWindow).toEqual({
      startAt: "2026-10-02T14:00:00.000Z",
      endAt: "2026-10-02T16:00:00.000Z",
    });
    expect(result.scheduling.confirmedStartAt).toBe("2026-10-02T14:30:00.000Z");
  });

  it("recovers omitted held-request preferences from its account-bound draft without inventing historical proof requirements or requested times", () => {
    const result = buildPartnerRequestDetails(
      source({
        scopeSnapshot: null,
        rateSnapshot: null,
        proofRequirementsSnapshot: null,
        addOnsSnapshot: null,
        appointmentStatus: "confirmed",
        publicStatus: "confirmed",
        appointmentStartAt: new Date("2026-10-02T14:00:00Z"),
        arrivalWindowStartAt: new Date("2026-10-02T14:00:00Z"),
        arrivalWindowEndAt: new Date("2026-10-02T16:00:00Z"),
        draftPreferredWindows: [
          { localDate: "2026-09-30", timeOfDay: "afternoon" },
        ],
        draftAssistancePreference: "waitlist",
      }),
      { financials: false, photos: true },
    );
    expect(parsePartnerRequestDetails(result)).toEqual(result);
    expect(result.proof).toEqual({ before: null, after: null, package: false });
    expect(result.scheduling.requestedWindow).toBeNull();
    expect(result.scheduling.preferredWindows).toEqual([
      {
        localDate: "2026-09-30",
        timeOfDay: "afternoon",
        timezone: "America/New_York",
      },
    ]);
    expect(result.scheduling.assistancePreference).toBe("waitlist");
    expect(result.photos.count).toBe(0);
    expect(result.photos.detailPath).toContain(
      "/service-requests/job-one?accountId=account-one",
    );
  });

  it.each(["approval_needed", "under_review", "declined", "canceled"])(
    "never presents retained reservation dates as confirmed for %s",
    (publicStatus) => {
      const result = buildPartnerRequestDetails(
        source({
          publicStatus,
          appointmentStatus: "confirmed",
          appointmentStartAt: new Date("2026-10-02T14:00:00Z"),
          promisedArrivalStartAt: new Date("2026-10-02T14:00:00Z"),
          promisedArrivalEndAt: new Date("2026-10-02T16:00:00Z"),
          arrivalWindowStartAt: new Date("2026-10-02T14:00:00Z"),
          arrivalWindowEndAt: new Date("2026-10-02T16:00:00Z"),
        }),
        { financials: false, photos: false },
      );
      expect(result.scheduling.confirmedWindow).toBeNull();
      expect(result.scheduling.confirmedStartAt).toBeNull();
      if (publicStatus === "approval_needed" || publicStatus === "under_review")
        expect(result.scheduling.requestedWindow).not.toBeNull();
      else expect(result.scheduling.requestedWindow).toBeNull();
    },
  );
  it("preserves legacy restricted item names and treats multi-stop work as non-standard just like booking validation", () => {
    const result = buildPartnerRequestDetails(
      source({
        scopeSnapshot: {
          scope: {
            quantity: 2,
            restrictedItems: ["paint", "batteries"],
            multiStop: true,
          },
        },
      }),
      { financials: false, photos: false },
    );
    expect(result.scope).toMatchObject({
      restrictedItems: true,
      nonStandard: true,
      multiStop: true,
      additionalFields: [
        { key: "quantity", value: 2 },
        { key: "restrictedItems", value: "paint, batteries" },
      ],
    });
  });
});
