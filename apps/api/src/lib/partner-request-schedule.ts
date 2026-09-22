import { sql } from "drizzle-orm";
import { appointments, partnerBookings } from "@/db";

/** Summary dates describe the next actual visit; the parent never owns a reservation. */
export const partnerRequestNextArrivalStartSql =
  sql<Date | null>`case when ${partnerBookings.modelVersion}=2 then (select ap.promised_arrival_start_at from partner_booking_visits visit join appointments ap on ap.id=visit.appointment_id and ap.partner_account_id=visit.partner_account_id where visit.partner_booking_id=${partnerBookings.id} and visit.partner_account_id=${partnerBookings.partnerAccountId} and visit.status in ('scheduled','in_progress') order by ap.start_at,visit.id limit 1) else ${partnerBookings.arrivalWindowStartAt} end`.mapWith(
    partnerBookings.arrivalWindowStartAt,
  );
export const partnerRequestNextArrivalEndSql =
  sql<Date | null>`case when ${partnerBookings.modelVersion}=2 then (select ap.promised_arrival_end_at from partner_booking_visits visit join appointments ap on ap.id=visit.appointment_id and ap.partner_account_id=visit.partner_account_id where visit.partner_booking_id=${partnerBookings.id} and visit.partner_account_id=${partnerBookings.partnerAccountId} and visit.status in ('scheduled','in_progress') order by ap.start_at,visit.id limit 1) else ${partnerBookings.arrivalWindowEndAt} end`.mapWith(
    partnerBookings.arrivalWindowEndAt,
  );
export const partnerRequestCompletedAtSql =
  sql<Date | null>`case when ${partnerBookings.modelVersion}=2 then (select max(completed_at) from partner_booking_service_lines where partner_booking_id=${partnerBookings.id} and partner_account_id=${partnerBookings.partnerAccountId} and ${partnerBookings.publicStatus}='completed') else ${appointments.completedAt} end`.mapWith(
    appointments.completedAt,
  );
