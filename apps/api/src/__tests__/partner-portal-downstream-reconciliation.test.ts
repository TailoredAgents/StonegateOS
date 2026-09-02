import fs from "node:fs";
import path from "node:path";
import { resolveAppointmentCalendarContent } from "@/lib/calendar";

const ROOT = path.resolve(process.cwd(), "../..");

function source(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

describe("partner job downstream reconciliation", () => {
  it("projects canonical partner service and quoted scope when no lead exists", () => {
    expect(
      resolveAppointmentCalendarContent({
        leadServices: null,
        leadNotes: null,
        partnerServiceKey: "junk_removal_primary",
        quotedScopeText: " Remove the contents of suite 400. ",
      }),
    ).toEqual({
      services: ["junk_removal_primary"],
      notes: "Remove the contents of suite 400.",
    });
  });

  it("preserves the lead projection for legacy appointments", () => {
    expect(
      resolveAppointmentCalendarContent({
        leadServices: ["Junk removal", "Junk removal", "Demolition"],
        leadNotes: "Legacy lead instructions",
        partnerServiceKey: "partner_service",
        quotedScopeText: "Partner scope",
      }),
    ).toEqual({
      services: ["Junk removal", "Demolition"],
      notes: "Legacy lead instructions",
    });
  });

  it("binds booking price and scope to the operational appointment and its consumers", () => {
    const scheduling = source(
      "apps/api/src/lib/partner-portal-v2-scheduling/service.ts",
    );
    const outbox = source("apps/api/src/lib/outbox-processor.ts");
    const appointmentsRoute = source("apps/api/app/api/appointments/route.ts");
    const revenue = source("apps/api/app/api/revenue/summary/route.ts");
    const payments = source("apps/api/src/lib/partner-portal-v2-payments.ts");

    expect(scheduling).toContain("quotedTotalCents: amountMinor");
    expect(scheduling).toContain("quotedScopeText: draft.description");
    expect(scheduling).toContain("amountCents: amountMinor");
    expect(scheduling).toContain("scopeSnapshot:");

    expect(outbox).toContain("partnerServiceKey: partnerBookings.serviceKey");
    expect(outbox).toContain("quotedScopeText: appointments.quotedScopeText");
    expect(outbox).toContain("resolveAppointmentCalendarContent({");
    expect(appointmentsRoute).toContain("partnerBookingId: partnerBookings.id");
    expect(appointmentsRoute).toContain(
      "services: [...operationalContent.services]",
    );

    expect(revenue).toContain("appointments.finalTotalCents");
    expect(revenue).toContain("appointments.quotedTotalCents");
    expect(payments).toContain(
      "eq(partnerBookings.id, invoice.partnerBookingId)",
    );
    expect(payments).toContain(
      "eq(appointments.id, partnerBookings.appointmentId)",
    );
  });
});
