import type { AppointmentMediaError } from "@/lib/appointment-media";
import {
  AUTOMATIC_BOOKING_MEDIA_STATUSES,
  appointmentStatusRequiresQuotedScope,
  assertAppointmentStatusTransitionAllowed,
  canAutoAttachMediaToNearestAppointment,
  evaluateAutomaticMediaScopePolicy,
  getConversationMediaImportSource,
  isWithinMediaRestoreWindow,
  MEDIA_RESTORE_WINDOW_MS,
  moveMediaIdToIndex,
  resolveAutomaticBookingStatusForQuotedWork,
  sortAppointmentIdsForMediaLock,
} from "@/lib/appointment-media";

function mockScopeGuardDatabase(input: {
  quotedScopeText: string | null;
  mediaRows: Array<{
    appointmentId: string;
    mediaId: string;
    status: string;
    isCover: boolean;
    purpose: string;
  }>;
}) {
  const results = [
    [
      {
        id: "appointment-1",
        contactId: "contact-1",
        status: "requested",
        quotedScopeText: input.quotedScopeText,
      },
    ],
    input.mediaRows,
  ];
  const select = jest.fn(() => {
    const rows = results.shift() ?? [];
    const query = {
      from: jest.fn(),
      innerJoin: jest.fn(),
      where: jest.fn(),
      limit: jest.fn(),
      for: jest.fn(() => Promise.resolve(rows)),
      then: (
        resolve: (value: typeof rows) => unknown,
        reject: (reason: unknown) => unknown,
      ) => Promise.resolve(rows).then(resolve, reject),
    };
    query.from.mockReturnValue(query);
    query.innerJoin.mockReturnValue(query);
    query.where.mockReturnValue(query);
    query.limit.mockReturnValue(query);
    return query;
  });
  return { select };
}

describe("quoted-work status transition policy", () => {
  it.each(["confirmed", "completed"])(
    "requires scope before entering %s",
    (status) => {
      expect(appointmentStatusRequiresQuotedScope(status)).toBe(true);
    },
  );

  it.each(["requested", "canceled", "no_show"])(
    "does not gate the %s status",
    (status) => {
      expect(appointmentStatusRequiresQuotedScope(status)).toBe(false);
    },
  );

  it("keeps an automatic booking Requested when carried media has no scope", () => {
    expect(
      resolveAutomaticBookingStatusForQuotedWork({
        proposedStatus: "confirmed",
        quotedScopeText: "   ",
        hasQuotedWorkMedia: true,
      }),
    ).toBe("requested");
  });

  it("treats pending, failed, and ready imports as media an automatic booking will carry", () => {
    expect(AUTOMATIC_BOOKING_MEDIA_STATUSES).toEqual([
      "staging",
      "processing",
      "failed",
      "ready",
    ]);
  });

  it("allows an automatic booking through when scope exists or no media will attach", () => {
    expect(
      resolveAutomaticBookingStatusForQuotedWork({
        proposedStatus: "confirmed",
        quotedScopeText: "Remove the shed and contents",
        hasQuotedWorkMedia: true,
      }),
    ).toBe("confirmed");
    expect(
      resolveAutomaticBookingStatusForQuotedWork({
        proposedStatus: "confirmed",
        quotedScopeText: null,
        hasQuotedWorkMedia: false,
      }),
    ).toBe("confirmed");
  });

  it("rejects a guarded transition when quoted-work media has no scope", async () => {
    const database = mockScopeGuardDatabase({
      quotedScopeText: null,
      mediaRows: [
        {
          appointmentId: "appointment-1",
          mediaId: "media-1",
          status: "ready",
          isCover: true,
          purpose: "quoted_work",
        },
      ],
    });

    await expect(
      assertAppointmentStatusTransitionAllowed({
        appointmentId: "appointment-1",
        nextStatus: "completed",
        database: database as never,
      }),
    ).rejects.toMatchObject<Partial<AppointmentMediaError>>({
      code: "quoted_scope_required",
      status: 409,
    });
  });

  it("allows the guarded transition once the appointment scope is present", async () => {
    const database = mockScopeGuardDatabase({
      quotedScopeText: "Remove the items shown in the photos",
      mediaRows: [
        {
          appointmentId: "appointment-1",
          mediaId: "media-1",
          status: "processing",
          isCover: false,
          purpose: "quoted_work",
        },
      ],
    });

    await expect(
      assertAppointmentStatusTransitionAllowed({
        appointmentId: "appointment-1",
        nextStatus: "confirmed",
        database: database as never,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("automatic media scope policy", () => {
  it("keeps a confirmed appointment confirmed and records a scope warning", () => {
    expect(
      evaluateAutomaticMediaScopePolicy({
        currentStatus: "confirmed",
        needsScope: true,
      }),
    ).toEqual({
      nextStatus: "confirmed",
      shouldRecordWarning: true,
    });
  });

  it("does not interfere with new bookings already created as requested", () => {
    expect(
      evaluateAutomaticMediaScopePolicy({
        currentStatus: "requested",
        needsScope: true,
      }),
    ).toEqual({
      nextStatus: "requested",
      shouldRecordWarning: true,
    });
  });
});

describe("conversation media import channels", () => {
  it("accepts only Twilio SMS/MMS and Facebook Messenger DM", () => {
    expect(getConversationMediaImportSource("sms", "twilio")).toBe(
      "twilio_mms",
    );
    expect(getConversationMediaImportSource("dm", "facebook")).toBe(
      "facebook_messenger",
    );
    expect(getConversationMediaImportSource("email", "twilio")).toBeNull();
    expect(getConversationMediaImportSource("web", "facebook")).toBeNull();
    expect(getConversationMediaImportSource("call", "twilio")).toBeNull();
    expect(getConversationMediaImportSource("dm", "instagram")).toBeNull();
    expect(getConversationMediaImportSource("sms", "facebook")).toBeNull();
  });
});

describe("historical media matching", () => {
  const now = new Date("2026-07-24T16:00:00.000Z");

  it("keeps exact/live media eligible but does not nearest-match old backfill media", () => {
    expect(canAutoAttachMediaToNearestAppointment(undefined, now)).toBe(true);
    expect(
      canAutoAttachMediaToNearestAppointment(
        new Date("2026-07-01T16:00:00.000Z"),
        now,
      ),
    ).toBe(true);
    expect(
      canAutoAttachMediaToNearestAppointment(
        new Date("2026-06-01T16:00:00.000Z"),
        now,
      ),
    ).toBe(false);
  });
});

describe("appointment media ordering", () => {
  it("uses one deterministic lock order for multi-appointment mutations", () => {
    expect(sortAppointmentIdsForMediaLock(["z", "a", "m", "a"])).toEqual([
      "a",
      "m",
      "z",
    ]);
  });

  it("treats sortOrder as a destination index when moving forward", () => {
    expect(moveMediaIdToIndex(["a", "b", "c", "d"], "b", 3)).toEqual([
      "a",
      "c",
      "d",
      "b",
    ]);
  });

  it("moves backward and produces a gap-free order", () => {
    expect(moveMediaIdToIndex(["a", "b", "c", "d"], "d", 1)).toEqual([
      "a",
      "d",
      "b",
      "c",
    ]);
  });

  it("clamps indices and never duplicates the moved media", () => {
    expect(moveMediaIdToIndex(["a", "b", "b", "c"], "b", 99)).toEqual([
      "a",
      "c",
      "b",
    ]);
    expect(moveMediaIdToIndex(["a", "c"], "b", -4)).toEqual([
      "b",
      "a",
      "c",
    ]);
  });
});

describe("appointment media restore window", () => {
  const now = new Date("2026-07-24T16:00:00.000Z");

  it("allows a restore during the 30-day recovery period", () => {
    expect(
      isWithinMediaRestoreWindow(
        new Date(now.getTime() - MEDIA_RESTORE_WINDOW_MS + 1),
        now,
      ),
    ).toBe(true);
  });

  it("expires at the same boundary used by orphan cleanup", () => {
    expect(
      isWithinMediaRestoreWindow(
        new Date(now.getTime() - MEDIA_RESTORE_WINDOW_MS),
        now,
      ),
    ).toBe(false);
  });
});
