import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workspaceRoot = resolve(process.cwd(), "../..");

function source(relativePath: string): string {
  return readFileSync(resolve(workspaceRoot, relativePath), "utf8");
}

describe("canonical appointment writers", () => {
  it("stores priced service bookings as jobs and quote visits as quotes", () => {
    const pricedBooking = source("apps/api/app/api/junk-quote/book/route.ts");
    const intake = source("apps/api/app/api/web/lead-intake/route.ts");
    const bookingUpdate = pricedBooking.indexOf(".update(appointments)");
    const bookingInsert = pricedBooking.indexOf(
      ".insert(appointments)",
      bookingUpdate,
    );
    const quoteVisitInsert = intake.indexOf(".insert(appointments)");

    expect(bookingUpdate).toBeGreaterThan(-1);
    expect(bookingInsert).toBeGreaterThan(bookingUpdate);
    expect(pricedBooking.slice(bookingUpdate, bookingInsert)).toContain(
      'type: "job"',
    );
    expect(pricedBooking.slice(bookingInsert, bookingInsert + 700)).toContain(
      'type: "job"',
    );
    expect(quoteVisitInsert).toBeGreaterThan(-1);
    expect(intake.slice(quoteVisitInsert, quoteVisitInsert + 700)).toContain(
      'type: "in_person_quote"',
    );
  });

  it("recognizes legacy service bookings when preventing duplicate jobs", () => {
    const quoteScheduling = source("apps/api/src/lib/quote-scheduling.ts");
    const duplicateGuard = quoteScheduling.indexOf("const [existingJob]");
    const duplicateResult = quoteScheduling.indexOf(
      "if (existingJob)",
      duplicateGuard,
    );

    expect(duplicateGuard).toBeGreaterThan(-1);
    expect(duplicateResult).toBeGreaterThan(duplicateGuard);
    expect(
      quoteScheduling.slice(duplicateGuard, duplicateResult),
    ).toContain("serviceWorkAppointmentTypePredicate(appointments.type)");
  });
});
