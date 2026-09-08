import { PgDialect, pgTable, text } from "drizzle-orm/pg-core";
import {
  QUOTE_ONLY_APPOINTMENT_TYPES,
  isQuoteOnlyAppointmentType,
  isServiceWorkAppointmentType,
  normalizeAppointmentType,
  serviceWorkAppointmentTypePredicate,
} from "@/lib/appointment-kind";

const appointmentKinds = pgTable("appointment_kind_test", {
  type: text("type"),
});

describe("appointment kind classification", () => {
  it("normalizes type labels and excludes only explicit quote-only visits", () => {
    expect(normalizeAppointmentType("  ESTIMATE  ")).toBe("estimate");
    expect(normalizeAppointmentType(null)).toBe("");

    expect(isServiceWorkAppointmentType("job")).toBe(true);
    expect(isServiceWorkAppointmentType(" estimate ")).toBe(true);
    expect(isServiceWorkAppointmentType("recurring_service")).toBe(true);
    expect(isServiceWorkAppointmentType("")).toBe(false);
    expect(isServiceWorkAppointmentType("   ")).toBe(false);
    expect(isServiceWorkAppointmentType(null)).toBe(false);

    for (const type of QUOTE_ONLY_APPOINTMENT_TYPES) {
      expect(isQuoteOnlyAppointmentType(type)).toBe(true);
      expect(isQuoteOnlyAppointmentType(` ${type.toUpperCase()} `)).toBe(true);
      expect(isServiceWorkAppointmentType(type)).toBe(false);
    }
  });

  it("uses the same normalized quote-only exclusion in database queries", () => {
    const query = new PgDialect().sqlToQuery(
      serviceWorkAppointmentTypePredicate(appointmentKinds.type),
    );

    expect(query.sql).toContain("regexp_replace");
    expect(query.sql).toContain("[[:space:]]");
    expect(query.sql).toContain("lower");
    expect(query.sql).toContain("not in");
    expect(query.params).toEqual([...QUOTE_ONLY_APPOINTMENT_TYPES]);
  });
});
