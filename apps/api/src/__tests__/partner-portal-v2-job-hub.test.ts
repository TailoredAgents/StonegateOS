import {
  createPartnerJobNotificationDeliveryDto,
  createPartnerJobOperationsSummary,
  partnerJobIssueCategoryLabel,
  readPartnerJobIssueMetadata,
} from "@/lib/partner-portal-v2-job-hub";

describe("Partner Portal V2 job hub projections", () => {
  test("publishes only an explicitly sent bounded operational ETA", () => {
    expect(
      createPartnerJobOperationsSummary({
        jobStatus: "en_route",
        assignedMemberCount: 2,
        publishedEta: {
          etaStartAt: new Date("2026-09-03T14:00:00.000Z"),
          etaEndAt: new Date("2026-09-03T14:15:00.000Z"),
          sentAt: new Date("2026-09-03T13:30:00.000Z"),
        },
        now: new Date("2026-09-03T13:45:00.000Z"),
      }),
    ).toEqual({
      eta: {
        state: "operational_estimate",
        startAt: "2026-09-03T14:00:00.000Z",
        endAt: "2026-09-03T14:15:00.000Z",
        publishedAt: "2026-09-03T13:30:00.000Z",
      },
      assignedTeam: {
        state: "assigned",
        displayLabel: "Stonegate service crew",
        memberCount: 2,
      },
    });

    expect(
      createPartnerJobOperationsSummary({
        jobStatus: "confirmed",
        assignedMemberCount: 0,
        publishedEta: {
          etaStartAt: new Date("2026-09-03T14:00:00.000Z"),
          etaEndAt: new Date("2026-09-03T20:00:00.000Z"),
          sentAt: new Date("2026-09-03T13:30:00.000Z"),
        },
        now: new Date("2026-09-03T13:45:00.000Z"),
      }),
    ).toEqual({
      eta: {
        state: "not_published",
        startAt: null,
        endAt: null,
        publishedAt: null,
      },
      assignedTeam: {
        state: "pending",
        displayLabel: "Stonegate service crew",
        memberCount: null,
      },
    });
  });

  test("completed and canceled jobs never retain a stale ETA", () => {
    for (const [jobStatus, etaState, teamState] of [
      ["completed", "complete", "complete"],
      ["canceled", "not_applicable", "not_applicable"],
    ] as const) {
      const summary = createPartnerJobOperationsSummary({
        jobStatus,
        assignedMemberCount: 1,
        publishedEta: {
          etaStartAt: new Date("2026-09-03T14:00:00.000Z"),
          etaEndAt: new Date("2026-09-03T14:15:00.000Z"),
          sentAt: new Date("2026-09-03T13:30:00.000Z"),
        },
        now: new Date("2026-09-03T13:45:00.000Z"),
      });
      expect(summary.eta.state).toBe(etaState);
      expect(summary.eta.startAt).toBeNull();
      expect(summary.assignedTeam.state).toBe(teamState);
    }
  });

  test("expires old, distant, and future-dated ETA publications", () => {
    const project = (input: {
      etaStartAt: string;
      etaEndAt: string;
      sentAt: string;
    }) =>
      createPartnerJobOperationsSummary({
        jobStatus: "en_route",
        assignedMemberCount: 1,
        publishedEta: {
          etaStartAt: new Date(input.etaStartAt),
          etaEndAt: new Date(input.etaEndAt),
          sentAt: new Date(input.sentAt),
        },
        now: new Date("2026-09-03T14:00:00.000Z"),
      }).eta.state;

    expect(
      project({
        etaStartAt: "2026-09-03T12:00:00.000Z",
        etaEndAt: "2026-09-03T12:15:00.000Z",
        sentAt: "2026-09-03T11:30:00.000Z",
      }),
    ).toBe("not_published");
    expect(
      project({
        etaStartAt: "2026-09-05T14:00:00.000Z",
        etaEndAt: "2026-09-05T14:15:00.000Z",
        sentAt: "2026-09-03T13:30:00.000Z",
      }),
    ).toBe("not_published");
    expect(
      project({
        etaStartAt: "2026-09-03T14:30:00.000Z",
        etaEndAt: "2026-09-03T14:45:00.000Z",
        sentAt: "2026-09-03T14:30:00.000Z",
      }),
    ).toBe("not_published");
  });

  test("issue metadata is an exact allowlist without free-form content", () => {
    expect(partnerJobIssueCategoryLabel("property_damage")).toBe(
      "Property damage",
    );
    expect(
      readPartnerJobIssueMetadata({
        messageKind: "issue",
        issueCategory: "safety",
        issuePriority: "urgent",
        body: "must never be projected from metadata",
        staffId: "private",
      }),
    ).toEqual({
      category: "safety",
      categoryLabel: "Safety concern",
      priority: "urgent",
    });
    expect(
      readPartnerJobIssueMetadata({
        messageKind: "issue",
        issueCategory: "internal_category",
        issuePriority: "urgent",
      }),
    ).toBeNull();
  });

  test("notification history maps provider state without provider evidence", () => {
    expect(
      createPartnerJobNotificationDeliveryDto({
        id: "11111111-1111-4111-8111-111111111111",
        eventType: "booking.rescheduled",
        channel: "email",
        state: "accepted",
        createdAt: new Date("2026-09-03T12:00:00.000Z"),
        acceptedAt: new Date("2026-09-03T12:00:01.000Z"),
        updatedAt: new Date("2026-09-03T12:00:01.000Z"),
      }),
    ).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      event: { key: "booking.rescheduled", label: "Schedule updated" },
      channel: { key: "email", label: "Email" },
      status: { key: "sent", label: "Accepted for delivery" },
      createdAt: "2026-09-03T12:00:00.000Z",
      acceptedAt: "2026-09-03T12:00:01.000Z",
      updatedAt: "2026-09-03T12:00:01.000Z",
    });
    expect(
      createPartnerJobNotificationDeliveryDto({
        id: "11111111-1111-4111-8111-111111111111",
        eventType: "provider.internal",
        channel: "email",
        state: "accepted",
        createdAt: new Date(),
        acceptedAt: null,
        updatedAt: new Date(),
      }),
    ).toBeNull();
  });
});
