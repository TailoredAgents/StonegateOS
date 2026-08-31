import {
  addQuoteChangeBusinessHours,
  buildQuoteV2PublicEnvelope,
  canRequestQuoteV2Refresh,
  prepareQuoteV2AcceptanceEvidence,
  quoteV2PublicAllowedActions,
  resolveQuoteV2PublicAppointment,
  QuoteV2PublicStateError,
  type QuoteV2AppointmentBinding,
  type QuoteV2PublicCapabilitySnapshot,
} from "@/lib/quote-v2-public";

const NOW = new Date("2026-08-28T19:00:00.000Z"); // Friday 3 PM ET.
const VERSION_ID = "55555555-5555-4555-8555-555555555555";
const RESPONSE_ID = "66666666-6666-4666-8666-666666666666";
const APPOINTMENT_ID = "77777777-7777-4777-8777-777777777777";

const documentSnapshot = {
  schemaVersion: 1 as const,
  documentType: "fixed_quote" as const,
  audience: "commercial" as const,
  schedulingMode: "staff_followup" as const,
  parties: {
    customerName: "Alex Client",
    companyName: "Example Commercial",
    attentionName: "Alex Client",
    attentionTitle: "Facilities Director",
    email: "alex@example.test",
    phoneE164: "+15555550123",
    billingAddress: "100 Billing Ave, Atlanta, GA 30303",
    serviceAddress: "200 Service Ave, Atlanta, GA 30303",
    projectName: "Warehouse cleanout",
    purchaseOrder: "PO-42",
    reference: "SITE-A",
    preparerName: "Jordan Sales",
  },
  issuer: {
    legalName: "Stonegate Services LLC",
    displayName: "Stonegate",
    address: "1 Main Street, Atlanta, GA 30303",
    email: "support@example.test",
    phoneE164: "+15555550100",
    website: "https://example.test",
    supportMessage: "Call us with questions.",
  },
  scope: "Remove and haul the listed materials.",
  inclusions: ["Labor", "Hauling"],
  exclusions: ["Hazardous materials"],
  assumptions: ["Clear site access"],
  pricing: {
    documentType: "fixed_quote" as const,
    currency: "USD" as const,
    lineItems: [
      {
        id: "base",
        name: "Cleanout service",
        quantity: 1,
        unit: "project",
        unitPriceMinCents: 100_000,
        displayOrder: 0,
        selectedByDefault: false,
      },
      {
        id: "appliance",
        name: "Appliance removal",
        quantity: 1,
        unit: "item",
        unitPriceMinCents: 10_000,
        optionGroupId: "extras",
        displayOrder: 1,
        selectedByDefault: false,
      },
    ],
    optionGroups: [
      {
        id: "extras",
        label: "Optional additions",
        mode: "multiple" as const,
        minimumSelections: 0,
        maximumSelections: 1,
      },
    ],
    adjustments: [],
    deposit: { mode: "percentage" as const, basisPoints: 2_500 },
  },
  terms: {
    templateVersion: "commercial-v1",
    terms: "The proposal terms apply.",
    paymentTerms: "Deposit due on approval.",
    changeOrderRules: "Changes require written approval.",
    validityDays: 30,
    consentVersion: "consent-v1",
  },
  estimatedDurationMinutes: 240,
  serviceZoneId: "atlanta",
  serviceZoneConfirmed: true,
};

function publicRow(
  overrides: Partial<QuoteV2PublicCapabilitySnapshot> = {},
): QuoteV2PublicCapabilitySnapshot {
  return {
    capabilityId: "11111111-1111-4111-8111-111111111111",
    capabilityStatus: "active",
    recipientRole: "signer",
    allowedActions: ["view", "pdf", "change", "accept", "decline"],
    readExpiresAt: new Date("2027-08-28T19:00:00.000Z"),
    actionExpiresAt: new Date("2026-09-27T19:00:00.000Z"),
    revokedAt: null,
    quoteId: "22222222-2222-4222-8222-222222222222",
    quoteNumber: "Q-2026-ABC123",
    aggregateState: "open",
    aggregateRevision: 3,
    currentVersionId: VERSION_ID,
    publishedVersionId: VERSION_ID,
    acceptedAppointmentId: null,
    opportunityId: "33333333-3333-4333-8333-333333333333",
    opportunityStatus: "open",
    contactId: "44444444-4444-4444-8444-444444444444",
    contactDeletedAt: null,
    versionId: VERSION_ID,
    versionNumber: 2,
    versionState: "issued",
    documentSnapshot,
    selectedOptionIds: [],
    subtotalMinCents: 100_000,
    subtotalMaxCents: 100_000,
    discountMinCents: 0,
    discountMaxCents: 0,
    feeMinCents: 0,
    feeMaxCents: 0,
    totalMinCents: 100_000,
    totalMaxCents: 100_000,
    depositCents: 25_000,
    balanceMinCents: 75_000,
    balanceMaxCents: 75_000,
    contentHash: "a".repeat(64),
    issuedAt: new Date("2026-08-28T18:00:00.000Z"),
    expiresAt: new Date("2026-09-27T18:00:00.000Z"),
    proposalPdfHash: "b".repeat(64),
    hasOpenChangeRequest: false,
    hasTerminalResponse: false,
    depositCaptured: false,
    depositRequiresStaffScheduling: false,
    acceptedResponseId: null,
    appointment: null,
    attachments: [],
    ...overrides,
  };
}

function appointmentBinding(
  overrides: Partial<QuoteV2AppointmentBinding> = {},
): QuoteV2AppointmentBinding {
  return {
    id: APPOINTMENT_ID,
    quoteVersionId: VERSION_ID,
    quoteResponseId: RESPONSE_ID,
    status: "confirmed",
    startAt: new Date("2026-11-01T05:30:00.000Z"),
    durationMinutes: 120,
    schedulingTimezone: "America/New_York",
    promisedArrivalStartAt: new Date("2026-11-01T05:30:00.000Z"),
    promisedArrivalEndAt: new Date("2026-11-01T06:30:00.000Z"),
    ...overrides,
  };
}

function projectAppointment(
  overrides: Partial<QuoteV2AppointmentBinding> = {},
) {
  return resolveQuoteV2PublicAppointment({
    acceptedAppointmentId: APPOINTMENT_ID,
    acceptedResponseId: RESPONSE_ID,
    acceptedResponseAppointmentId: APPOINTMENT_ID,
    expectedVersionId: VERSION_ID,
    appointment: appointmentBinding(overrides),
  });
}

describe("Quote V2 public capability domain", () => {
  it("renders the exact immutable version with scoped actions and no internal fields", () => {
    const envelope = buildQuoteV2PublicEnvelope(publicRow(), NOW);

    expect(envelope).toMatchObject({
      quoteNumber: "Q-2026-ABC123",
      versionNumber: 2,
      lifecycleState: "issued",
      allowedActions: ["view", "pdf", "change", "accept", "decline"],
      totals: { totalMinCents: 100_000, depositCents: 25_000 },
    });
    expect(JSON.stringify(envelope)).not.toMatch(
      /internalNotes|shareToken|tokenHash/u,
    );
  });

  it("keeps superseded and changes-requested versions read-only while offering an expired signer an update request", () => {
    expect(
      quoteV2PublicAllowedActions(
        publicRow({ versionState: "superseded" }),
        NOW,
      ),
    ).toEqual(["view", "pdf"]);
    expect(
      quoteV2PublicAllowedActions(
        publicRow({ expiresAt: new Date("2026-08-28T18:59:59.000Z") }),
        NOW,
      ),
    ).toEqual(["view", "pdf", "refresh"]);
    expect(
      quoteV2PublicAllowedActions(
        publicRow({ hasOpenChangeRequest: true }),
        NOW,
      ),
    ).toEqual(["view", "pdf"]);
  });

  it("derives refresh for legacy signers only on the exact expired current published version", () => {
    const expired = publicRow({
      expiresAt: new Date("2026-08-28T18:59:59.000Z"),
    });
    expect(canRequestQuoteV2Refresh(expired, NOW)).toBe(true);
    expect(
      canRequestQuoteV2Refresh({ ...expired, versionState: "expired" }, NOW),
    ).toBe(true);
    expect(
      canRequestQuoteV2Refresh(
        { ...expired, allowedActions: ["view", "pdf", "refresh"] },
        NOW,
      ),
    ).toBe(true);
    for (const blocked of [
      { recipientRole: "viewer" },
      { allowedActions: ["view", "pdf"] },
      { currentVersionId: "66666666-6666-4666-8666-666666666666" },
      { publishedVersionId: "66666666-6666-4666-8666-666666666666" },
      { versionState: "superseded" },
      { versionState: "declined" },
      { versionState: "voided" },
      { aggregateState: "accepted" },
      { opportunityStatus: "lost" },
      { hasOpenChangeRequest: true },
      { hasTerminalResponse: true },
      { contactDeletedAt: NOW },
      { capabilityStatus: "superseded" },
    ] satisfies Array<Partial<QuoteV2PublicCapabilitySnapshot>>) {
      expect(canRequestQuoteV2Refresh({ ...expired, ...blocked }, NOW)).toBe(
        false,
      );
    }
  });

  it("switches an accepted deposit flow from checkout to booking only after capture", () => {
    const accepted = publicRow({
      aggregateState: "accepted",
      versionState: "accepted",
      allowedActions: [
        "view",
        "pdf",
        "availability",
        "hold",
        "checkout",
        "book",
      ],
      documentSnapshot: {
        ...documentSnapshot,
        schedulingMode: "self_schedule",
      },
      expiresAt: new Date(NOW.getTime() - 1),
      actionExpiresAt: new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1_000),
    });
    expect(quoteV2PublicAllowedActions(accepted, NOW)).toEqual([
      "view",
      "pdf",
      "availability",
      "hold",
      "checkout",
    ]);
    expect(
      quoteV2PublicAllowedActions({ ...accepted, depositCaptured: true }, NOW),
    ).toEqual(["view", "pdf", "availability", "hold", "book"]);
    expect(buildQuoteV2PublicEnvelope(accepted, NOW).displayState).toBe(
      "Approved · Deposit due",
    );
    const lateCapture = {
      ...accepted,
      depositCaptured: true,
      depositRequiresStaffScheduling: true,
    };
    expect(quoteV2PublicAllowedActions(lateCapture, NOW)).toEqual([
      "view",
      "pdf",
      "availability",
      "hold",
    ]);
    expect(buildQuoteV2PublicEnvelope(lateCapture, NOW).displayState).toBe(
      "Deposit received · Scheduling confirmation needed",
    );
    const booked = {
      ...accepted,
      depositCaptured: true,
      acceptedResponseId: RESPONSE_ID,
      acceptedAppointmentId: APPOINTMENT_ID,
      appointment: projectAppointment(),
    };
    expect(quoteV2PublicAllowedActions(booked, NOW)).toEqual(["view", "pdf"]);
    expect(buildQuoteV2PublicEnvelope(booked, NOW).displayState).toBe("Booked");
  });

  it("projects only an appointment bound through quote, version, and accepted response pointers", () => {
    const appointment = projectAppointment();
    expect(appointment).toEqual({
      id: APPOINTMENT_ID,
      status: "confirmed",
      startAt: "2026-11-01T05:30:00.000Z",
      endAt: "2026-11-01T07:30:00.000Z",
      timezone: "America/New_York",
      durationMinutes: 120,
      promisedArrivalWindow: {
        startAt: "2026-11-01T05:30:00.000Z",
        endAt: "2026-11-01T06:30:00.000Z",
      },
    });

    const envelope = buildQuoteV2PublicEnvelope(
      publicRow({
        aggregateState: "accepted",
        versionState: "accepted",
        acceptedResponseId: RESPONSE_ID,
        acceptedAppointmentId: APPOINTMENT_ID,
        appointment,
      }),
      NOW,
    );
    expect(envelope.appointment).toEqual(appointment);
    expect(JSON.stringify(envelope)).not.toMatch(
      /quoteResponseId|quoteVersionId|schedulingTimezone|rescheduleToken|crew/u,
    );
  });

  it("fails closed for missing or mismatched appointment evidence", () => {
    const exact = {
      acceptedAppointmentId: APPOINTMENT_ID,
      acceptedResponseId: RESPONSE_ID,
      acceptedResponseAppointmentId: APPOINTMENT_ID,
      expectedVersionId: VERSION_ID,
      appointment: appointmentBinding(),
    };
    const cases = [
      { ...exact, appointment: null },
      { ...exact, acceptedResponseId: null },
      { ...exact, acceptedResponseAppointmentId: null },
      {
        ...exact,
        acceptedResponseAppointmentId: "88888888-8888-4888-8888-888888888888",
      },
      {
        ...exact,
        appointment: appointmentBinding({
          id: "88888888-8888-4888-8888-888888888888",
        }),
      },
      {
        ...exact,
        appointment: appointmentBinding({
          quoteVersionId: "88888888-8888-4888-8888-888888888888",
        }),
      },
      {
        ...exact,
        appointment: appointmentBinding({
          quoteResponseId: "88888888-8888-4888-8888-888888888888",
        }),
      },
      { ...exact, appointment: appointmentBinding({ startAt: null }) },
      {
        ...exact,
        appointment: appointmentBinding({ durationMinutes: 0 }),
      },
      {
        ...exact,
        appointment: appointmentBinding({ schedulingTimezone: "Mars/Base" }),
      },
      {
        ...exact,
        appointment: appointmentBinding({ promisedArrivalEndAt: null }),
      },
      {
        ...exact,
        appointment: appointmentBinding({
          promisedArrivalStartAt: new Date("2026-11-01T07:00:00.000Z"),
          promisedArrivalEndAt: new Date("2026-11-01T06:00:00.000Z"),
        }),
      },
    ];
    for (const candidate of cases) {
      try {
        resolveQuoteV2PublicAppointment(candidate);
        throw new Error("expected appointment projection to fail closed");
      } catch (error) {
        expect(error).toBeInstanceOf(QuoteV2PublicStateError);
        expect((error as QuoteV2PublicStateError).code).toBe(
          "provider_unavailable",
        );
      }
    }
    expect(() =>
      resolveQuoteV2PublicAppointment({
        ...exact,
        acceptedAppointmentId: null,
        acceptedResponseAppointmentId: APPOINTMENT_ID,
        appointment: null,
      }),
    ).toThrow(QuoteV2PublicStateError);
  });

  it("sanitizes every known status, maps no-show safely, and rejects future statuses", () => {
    for (const [stored, visible, display] of [
      ["requested", "requested", "Appointment requested"],
      ["confirmed", "confirmed", "Booked"],
      ["canceled", "canceled", "Appointment canceled"],
      ["completed", "completed", "Service completed"],
      ["no_show", "canceled", "Appointment canceled"],
    ] as const) {
      const appointment = projectAppointment({ status: stored });
      expect(appointment?.status).toBe(visible);
      expect(
        buildQuoteV2PublicEnvelope(
          publicRow({
            aggregateState: "accepted",
            versionState: "accepted",
            acceptedResponseId: RESPONSE_ID,
            acceptedAppointmentId: APPOINTMENT_ID,
            appointment,
          }),
          NOW,
        ).displayState,
      ).toBe(display);
    }
    expect(() => projectAppointment({ status: "future_state" })).toThrow(
      QuoteV2PublicStateError,
    );
  });

  it("uses persisted instants across DST and reflects a rescheduled start", () => {
    const before = projectAppointment({
      promisedArrivalStartAt: null,
      promisedArrivalEndAt: null,
    });
    expect(before).toMatchObject({
      startAt: "2026-11-01T05:30:00.000Z",
      endAt: "2026-11-01T07:30:00.000Z",
      timezone: "America/New_York",
      promisedArrivalWindow: null,
    });
    const after = projectAppointment({
      startAt: new Date("2026-11-02T15:15:00.000Z"),
      durationMinutes: 90,
      promisedArrivalStartAt: null,
      promisedArrivalEndAt: null,
    });
    expect(after).toMatchObject({
      startAt: "2026-11-02T15:15:00.000Z",
      endAt: "2026-11-02T16:45:00.000Z",
      durationMinutes: 90,
    });
  });

  it("keeps a retained superseded version readable without a later version appointment", () => {
    const retainedV1 = publicRow({
      versionNumber: 1,
      versionState: "superseded",
      aggregateState: "accepted",
      currentVersionId: "88888888-8888-4888-8888-888888888888",
      publishedVersionId: "88888888-8888-4888-8888-888888888888",
      acceptedResponseId: null,
      acceptedAppointmentId: null,
      appointment: null,
    });
    const envelope = buildQuoteV2PublicEnvelope(retainedV1, NOW);
    expect(envelope).toMatchObject({
      versionNumber: 1,
      displayState: "Superseded · View only",
      acceptedResponseId: null,
      acceptedAppointmentId: null,
      appointment: null,
      allowedActions: ["view", "pdf"],
    });
  });

  it("ends access for revoked or retention-expired capabilities", () => {
    expect(() =>
      buildQuoteV2PublicEnvelope(
        publicRow({ capabilityStatus: "revoked", revokedAt: NOW }),
        NOW,
      ),
    ).toThrow(QuoteV2PublicStateError);
    expect(() =>
      buildQuoteV2PublicEnvelope(
        publicRow({ readExpiresAt: new Date(NOW.getTime() - 1) }),
        NOW,
      ),
    ).toThrow("no longer available");
  });

  it("binds acceptance to signer, options, canonical totals, consent, content, and PDF", () => {
    const evidence = prepareQuoteV2AcceptanceEvidence({
      row: publicRow(),
      selectedOptionIds: ["appliance"],
      signer: {
        name: "Alex Client",
        title: "Facilities Director",
        company: "Example Commercial",
        authorityAffirmed: true,
      },
      consentVersion: "consent-v1",
      consentAffirmed: true,
    });

    expect(evidence.selectedOptionIds).toEqual(["appliance"]);
    expect(evidence.totals).toMatchObject({
      totalMinCents: 110_000,
      totalMaxCents: 110_000,
      depositCents: 27_500,
      balanceMinCents: 82_500,
    });
    expect(evidence.signerSnapshot).toMatchObject({
      name: "Alex Client",
      authorityAffirmed: true,
    });
    expect(evidence.contentHash).toBe("a".repeat(64));
    expect(evidence.issuedPdfHash).toBe("b".repeat(64));
    expect(evidence.configurationHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(evidence.consentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(evidence.consentText).toContain("firm scoped total");
  });

  it("rejects stale consent and missing issued PDF evidence", () => {
    const acceptance = {
      row: publicRow(),
      selectedOptionIds: [] as string[],
      signer: {
        name: "Alex Client",
        title: "Facilities Director",
        authorityAffirmed: true as const,
      },
      consentVersion: "old-consent",
      consentAffirmed: true as const,
    };
    expect(() => prepareQuoteV2AcceptanceEvidence(acceptance)).toThrow(
      "consent language changed",
    );
    expect(() =>
      prepareQuoteV2AcceptanceEvidence({
        ...acceptance,
        consentVersion: "consent-v1",
        row: publicRow({ proposalPdfHash: null }),
      }),
    ).toThrow("evidence is unavailable");
  });

  it("calculates the four-business-hour SLA across local work windows", () => {
    const dueAt = addQuoteChangeBusinessHours({
      at: NOW,
      hours: 4,
      policy: {
        timezone: "America/New_York",
        weekly: {
          monday: [{ start: "09:00", end: "17:00" }],
          tuesday: [{ start: "09:00", end: "17:00" }],
          wednesday: [{ start: "09:00", end: "17:00" }],
          thursday: [{ start: "09:00", end: "17:00" }],
          friday: [{ start: "09:00", end: "17:00" }],
          saturday: [],
          sunday: [],
        },
      },
    });

    expect(dueAt.toISOString()).toBe("2026-08-31T15:00:00.000Z");
  });
});
