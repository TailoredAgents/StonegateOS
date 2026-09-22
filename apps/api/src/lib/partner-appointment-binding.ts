import { and, eq, or, sql } from "drizzle-orm";
import { appointments, partnerBookings } from "@/db";

/** One account-bound parent for either a historical appointment or an actual visit. */
export function partnerAppointmentBindingSql() {
  return and(
    eq(partnerBookings.partnerAccountId, appointments.partnerAccountId),
    or(
      eq(partnerBookings.appointmentId, appointments.id),
      sql`exists(select 1 from partner_booking_visits v where v.partner_booking_id=${partnerBookings.id} and v.partner_account_id=${partnerBookings.partnerAccountId} and v.appointment_id=${appointments.id})`,
    ),
  );
}
export const partnerVisitServiceLabelSql = sql<
  string | null
>`coalesce((select string_agg(line.service_label, ', ' order by line.position) from partner_booking_visits v join partner_booking_visit_lines mapping on mapping.visit_id=v.id and mapping.partner_account_id=v.partner_account_id and mapping.partner_booking_id=v.partner_booking_id join partner_booking_service_lines line on line.id=mapping.service_line_id and line.partner_booking_id=mapping.partner_booking_id and line.partner_account_id=mapping.partner_account_id where v.appointment_id=${appointments.id} and v.partner_account_id=${partnerBookings.partnerAccountId} and v.partner_booking_id=${partnerBookings.id}),nullif(${partnerBookings.scopeSnapshot}->>'serviceLabel',''))`;
