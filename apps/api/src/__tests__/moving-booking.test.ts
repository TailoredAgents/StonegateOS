import {
  appointmentBookingDetailsSchema,
  validateQuotedTotalForBookingDetails,
} from "@/lib/appointment-booking-details";
import { resolveAppointmentCalendarContent } from "@/lib/calendar";
import {
  APPOINTMENT_BOOKING_SELECTION_OPTIONS,
  formatAppointmentJobDetails,
  formatAppointmentServiceType,
  parseAppointmentBookingFormData,
  resolveBookingSelection,
} from "../../../site/src/app/team/lib/booking-details";

function movingForm(overrides: Record<string, string> = {}): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries({
    sourceType: "google",
    serviceType: "moving",
    priceInputMode: "exact",
    quotedTotal: "650.50",
    movingDestinationAddress: "  125 Oak Street, Atlanta, GA 30301  ",
    ...overrides,
  }))
    form.set(key, value);
  return form;
}

describe("moving job booking", () => {
  it("creates a Moving Job without unrelated load or dumpster fields", () => {
    expect(resolveBookingSelection("moving")).toBe("moving");
    expect(APPOINTMENT_BOOKING_SELECTION_OPTIONS).toContainEqual({
      value: "moving",
      label: "Moving Job",
    });
    const result = parseAppointmentBookingFormData(movingForm());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.quotedTotalCents).toBe(65_050);
    expect(
      appointmentBookingDetailsSchema.parse(result.bookingDetails),
    ).toEqual(result.bookingDetails);
    expect(result.bookingDetails).toEqual({
      serviceType: "moving",
      source: { type: "google" },
      pricing: { mode: "exact", rangeMinCents: null, rangeMaxCents: null },
      moving: { destinationAddress: "125 Oak Street, Atlanta, GA 30301" },
    });
    expect(formatAppointmentServiceType(result.bookingDetails)).toBe(
      "Moving Job",
    );
    expect(formatAppointmentJobDetails(result.bookingDetails)).toBe(
      "Destination: 125 Oak Street, Atlanta, GA 30301",
    );
    expect(
      validateQuotedTotalForBookingDetails(result.bookingDetails, null),
    ).toBe("exact_quote_required");
  });

  it("supports same-property moving labor and a quoted price range", () => {
    const result = parseAppointmentBookingFormData(
      movingForm({
        movingDestinationAddress: "",
        priceInputMode: "range",
        priceRangeMin: "500",
        priceRangeMax: "750",
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.quotedTotalCents).toBeNull();
    expect(result.bookingDetails.pricing).toEqual({
      mode: "range",
      rangeMinCents: 50_000,
      rangeMaxCents: 75_000,
    });
    expect(result.bookingDetails.moving?.destinationAddress).toBeNull();
    expect(
      appointmentBookingDetailsSchema.safeParse(result.bookingDetails).success,
    ).toBe(true);
  });

  it("rejects unrelated job details and overlong destinations", () => {
    const base = {
      serviceType: "moving",
      source: { type: "google" },
      pricing: { mode: "exact" },
    };
    expect(appointmentBookingDetailsSchema.safeParse(base).success).toBe(true);
    expect(
      appointmentBookingDetailsSchema.safeParse({
        ...base,
        loadSize: { kind: "quarter_to_half" },
      }).success,
    ).toBe(false);
    expect(
      appointmentBookingDetailsSchema.safeParse({
        ...base,
        moving: { destinationAddress: "x".repeat(241) },
      }).success,
    ).toBe(false);
    expect(
      parseAppointmentBookingFormData(
        movingForm({ movingDestinationAddress: "x".repeat(241) }),
      ).ok,
    ).toBe(false);
    expect(
      parseAppointmentBookingFormData(movingForm({ quotedTotal: "" })).ok,
    ).toBe(false);
    expect(
      parseAppointmentBookingFormData(
        movingForm({
          priceInputMode: "range",
          priceRangeMin: "750",
          priceRangeMax: "500",
        }),
      ).ok,
    ).toBe(false);
  });

  it("carries moving service and destination to calendar content without payroll information", () => {
    const content = resolveAppointmentCalendarContent({
      leadServices: ["Junk removal"],
      leadNotes: "Move the sofa and boxes.",
      partnerServiceKey: null,
      quotedScopeText: null,
      bookingDetails: {
        serviceType: "moving",
        source: { type: "google" },
        pricing: { mode: "exact" },
        moving: { destinationAddress: "125 Oak Street" },
      },
    });
    expect(content).toEqual({
      services: ["Moving Job"],
      notes: "Destination: 125 Oak Street\n\nMove the sofa and boxes.",
    });
  });
});
