import type { AppointmentBookingDetails } from "@/db/schema";
import { parseAppointmentBookingDetails } from "@/lib/appointment-booking-details";
import {
  loadCalendarCardIdentityRows,
  resolveCalendarCardIdentity,
  type CalendarCardIdentityRow,
} from "@/lib/calendar-card-identity";

const appointmentId = "appointment-1";
const partnerRow: CalendarCardIdentityRow = {
  appointmentId,
  bookingId: "booking-1",
  bookingAccountId: "account-1",
  appointmentAccountId: "account-1",
  accountName: "Oak Property Management",
  partnerServiceKey: "junk-removal",
};

function identity(enrichment?: CalendarCardIdentityRow) {
  return resolveCalendarCardIdentity({ bookingDetails: null, enrichment });
}

describe("calendar booking card identity", () => {
  it.each([
    ["junk_removal", "Junk Removal"],
    ["demolition", "Demo"],
    ["moving", "Moving"],
    ["land_clearing", "Land Clearing"],
    ["rental_dumpster", "Dumpster Rental"],
  ] as const)(
    "prefers saved %s over a different partner service",
    (serviceType, label) => {
      const bookingDetails: AppointmentBookingDetails = {
        serviceType,
        source: { type: "website" },
        pricing: { mode: "exact" },
      };
      expect(
        resolveCalendarCardIdentity({ bookingDetails, enrichment: partnerRow })
          .serviceCategoryLabel,
      ).toBe(label);
    },
  );

  it("preserves the existing legacy load-size category without requiring a crew edit", () => {
    const bookingDetails = parseAppointmentBookingDetails({
      source: { type: "website" },
      pricing: { mode: "exact" },
      loadSize: { kind: "quarter_to_half" },
    });
    expect(bookingDetails).not.toBeNull();
    expect(
      resolveCalendarCardIdentity({ bookingDetails }).serviceCategoryLabel,
    ).toBe("Junk Removal");
  });

  it("uses a linked partner service when the appointment has no booking details", () => {
    expect(identity(partnerRow)).toEqual({
      serviceCategoryLabel: "Junk Removal",
      partnerAffiliation: {
        bookingId: "booking-1",
        accountId: "account-1",
        displayName: "Oak Property Management",
        basis: "partner_booking",
      },
    });
  });

  it("retains an ambiguous service's catalog label instead of guessing demolition", () => {
    expect(
      identity({
        ...partnerRow,
        partnerServiceKey: "demo-hauloff",
        partnerServiceLabel: "Demolition debris pickup",
      }).serviceCategoryLabel,
    ).toBe("Demolition debris pickup");
    expect(
      identity({ ...partnerRow, partnerServiceKey: "demo-hauloff" })
        .serviceCategoryLabel,
    ).toBeNull();
  });

  it("does not use unrelated catalog data without a linked booking", () => {
    expect(
      identity({
        appointmentId,
        partnerServiceKey: "moving",
        partnerServiceLabel: "Moving",
      }).serviceCategoryLabel,
    ).toBeNull();
  });

  it("keeps unknown or malformed legacy booking data usable", () => {
    expect(
      resolveCalendarCardIdentity({
        bookingDetails: parseAppointmentBookingDetails({
          serviceType: "junk_removal",
        }),
      }),
    ).toEqual({ serviceCategoryLabel: null, partnerAffiliation: null });
    expect(identity()).toEqual({
      serviceCategoryLabel: null,
      partnerAffiliation: null,
    });
  });

  it("preserves a legacy booking banner without an account and uses its own organization", () => {
    expect(
      identity({
        ...partnerRow,
        bookingAccountId: null,
        appointmentAccountId: null,
        accountName: "Unrelated contact account",
        legacyPartnerCompany: "Legacy partner",
      }).partnerAffiliation,
    ).toEqual({
      accountId: null,
      bookingId: "booking-1",
      displayName: "Legacy partner",
      basis: "partner_booking",
    });
  });

  it("supports an appointment-bound partner account with no booking record", () => {
    expect(
      identity({
        appointmentId,
        appointmentAccountId: "account-1",
        accountName: "Oak",
      }).partnerAffiliation,
    ).toEqual({
      accountId: "account-1",
      bookingId: null,
      displayName: "Oak",
      basis: "appointment_account",
    });
  });

  it("keeps contact-only partnership distinct from a partner job", () => {
    expect(
      identity({
        appointmentId,
        contactPartnerStatus: "partner",
        contactCompany: "Oak",
        contactAccountId: null,
      }).partnerAffiliation,
    ).toEqual({
      accountId: null,
      bookingId: null,
      displayName: "Oak",
      basis: "contact_partner",
    });
  });

  it.each(["none", "prospect", "contacted", "inactive", null])(
    "does not infer a banner from contact status %s or mere account association",
    (contactPartnerStatus) => {
      expect(
        identity({
          appointmentId,
          contactPartnerStatus,
          contactAccountId: "account-1",
          accountName: "Oak",
        }).partnerAffiliation,
      ).toBeNull();
    },
  );

  it("uses a generic banner when booking and appointment accounts conflict", () => {
    expect(
      identity({ ...partnerRow, appointmentAccountId: "other-account" })
        .partnerAffiliation,
    ).toEqual({
      accountId: null,
      bookingId: "booking-1",
      displayName: null,
      basis: "partner_booking",
    });
  });
});

describe("optional calendar identity enrichment", () => {
  afterEach(() => jest.useRealTimers());

  it("loads one batch, ignores unrelated rows and never duplicates appointments", async () => {
    const read = jest
      .fn()
      .mockResolvedValue([
        partnerRow,
        { ...partnerRow, accountName: "Duplicate" },
        { ...partnerRow, appointmentId: "outside-window" },
      ]);
    const report = jest.fn();
    const result = await loadCalendarCardIdentityRows(
      [appointmentId],
      read,
      report,
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect([...result.values()]).toEqual([partnerRow]);
    expect(report).not.toHaveBeenCalled();
  });

  it("does not read optional tables for an empty calendar", async () => {
    const read = jest.fn();
    expect(await loadCalendarCardIdentityRows([], read, jest.fn())).toEqual(
      new Map(),
    );
    expect(read).not.toHaveBeenCalled();
  });

  it("degrades an unavailable optional table to no enrichment", async () => {
    const report = jest.fn();
    expect(
      await loadCalendarCardIdentityRows(
        [appointmentId],
        () => Promise.reject(new Error("optional table unavailable")),
        report,
      ),
    ).toEqual(new Map());
    expect(report).toHaveBeenCalledWith("unavailable");
  });

  it("returns after its one-second budget and observes a late rejection", async () => {
    jest.useFakeTimers();
    let rejectRead!: (reason: Error) => void;
    const report = jest.fn();
    const result = loadCalendarCardIdentityRows(
      [appointmentId],
      () =>
        new Promise((_resolve, reject) => {
          rejectRead = reject;
        }),
      report,
    );
    await jest.advanceTimersByTimeAsync(1_000);
    expect(await result).toEqual(new Map());
    expect(report).toHaveBeenCalledTimes(1);
    rejectRead(new Error("late database failure"));
    await Promise.resolve();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("reports conflicting identity links without losing the booking", async () => {
    const report = jest.fn();
    const result = await loadCalendarCardIdentityRows(
      [appointmentId],
      () =>
        Promise.resolve([
          { ...partnerRow, appointmentAccountId: "other-account" },
        ]),
      report,
    );
    expect(result.size).toBe(1);
    expect(report).toHaveBeenCalledWith("account_conflict");
  });
});
