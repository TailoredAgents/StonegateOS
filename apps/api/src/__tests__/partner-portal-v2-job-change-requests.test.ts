import {
  applyApprovedPartnerJobPublicChanges,
  createPartnerJobChangeRequestSnapshot,
  PartnerJobChangeRequestBodySchema,
  PartnerJobReferencesBodySchema,
  partnerJobChangeRequiresChangeOrder,
  partnerJobChangeSnapshotStillMatches,
} from "@/lib/partner-job-change-requests";

const materiality = {
  price: false,
  schedule: false,
  service: false,
  quantity: false,
  hazards: false,
  proof: false,
};

describe("Partner job change request contracts", () => {
  it("accepts only bounded fixed-shape public changes", () => {
    const parsed = PartnerJobChangeRequestBodySchema.parse({
      reason: "The crew should use the rear loading entrance.",
      proposedChanges: {
        accessDetails: "Use the rear loading entrance after checking in.",
        onSiteContact: {
          name: "Morgan Lee",
          phone: "+1 (212) 555-0134",
        },
        materiality,
      },
    });
    expect(parsed.proposedChanges.accessDetails).toContain("rear");
    expect(
      PartnerJobChangeRequestBodySchema.safeParse({
        reason: "Change it",
        proposedChanges: {
          price: 100,
          materiality,
        },
      }).success,
    ).toBe(false);
    expect(
      PartnerJobChangeRequestBodySchema.safeParse({
        reason: "Change it",
        proposedChanges: { materiality },
      }).success,
    ).toBe(false);
  });

  it("classifies all price, schedule, service, quantity, hazard, and proof impacts as change-order work", () => {
    for (const key of Object.keys(materiality) as Array<
      keyof typeof materiality
    >) {
      const proposed = {
        description: "Requested adjustment",
        materiality: { ...materiality, [key]: true },
      };
      expect(partnerJobChangeRequiresChangeOrder(proposed)).toBe(true);
      expect(() =>
        applyApprovedPartnerJobPublicChanges({
          scopeSnapshot: {},
          proposed,
        }),
      ).toThrow(/cannot be applied directly/u);
    }
  });

  it("snapshots the prior public values and applies only approved job-local fields", () => {
    const current = {
      scope: { rooms: 3 },
      description: "Original scope",
      accessDetails: "Front desk",
      onSiteContact: { name: "Sam", phone: "2125550100" },
    };
    const snapshot = createPartnerJobChangeRequestSnapshot({
      requestedAt: new Date("2026-09-01T12:00:00.000Z"),
      publicStatus: "confirmed",
      appointmentStatus: "confirmed",
      bookingRevision: 4,
      scopeSnapshot: current,
      proposedChanges: {
        description: "Updated public scope note",
        accessDetails: null,
        materiality,
      },
    });
    expect(snapshot.current.description).toBe("Original scope");
    expect(partnerJobChangeSnapshotStillMatches(snapshot, current)).toBe(true);
    expect(
      partnerJobChangeSnapshotStillMatches(snapshot, {
        ...current,
        description: "Changed elsewhere",
      }),
    ).toBe(false);

    expect(
      applyApprovedPartnerJobPublicChanges({
        scopeSnapshot: current,
        proposed: snapshot.proposed,
      }),
    ).toEqual({
      ...current,
      description: "Updated public scope note",
      accessDetails: null,
    });
  });

  it("limits direct editing to PO, cost center, and project reference", () => {
    expect(
      PartnerJobReferencesBodySchema.parse({
        poNumber: "PO-2044",
        costCenter: null,
        projectReference: "PROP-88",
      }),
    ).toEqual({
      poNumber: "PO-2044",
      costCenter: null,
      projectReference: "PROP-88",
    });
    expect(
      PartnerJobReferencesBodySchema.safeParse({ price: 100 }).success,
    ).toBe(false);
    expect(PartnerJobReferencesBodySchema.safeParse({}).success).toBe(false);
  });
});
