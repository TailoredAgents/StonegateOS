import { DateTime } from "luxon";
import { and, gte, lte, ne, sql } from "drizzle-orm";
import { appointments, getDb } from "@/db";
import {
  getBusinessHoursPolicy,
  getBusinessHourWindowsForDate,
  getBookingRulesPolicy,
} from "./policy";
import { getAppointmentCapacity } from "./appointment-capacity";
import { filterScheduleReadCandidates } from "./appointment-schedule-conflicts";
import type { TeamMutationTransaction } from "./team-mutation";

/** A real schedule check, not a promise that overlapping candidate starts are separate jobs. */
export async function readCampaignCapacity(
  serviceThrough: string | null,
  now = new Date(),
  tx?: TeamMutationTransaction,
) {
  if (!serviceThrough)
    return {
      checkedAt: now.toISOString(),
      availableDates: [] as string[],
      through: null,
      hasOpening: false,
    };
  const db = tx ?? getDb();
  const hours = await getBusinessHoursPolicy(db);
  const rules = await getBookingRulesPolicy(db);
  const start = DateTime.fromJSDate(now, { zone: hours.timezone })
    .plus({ days: 1 })
    .startOf("day");
  const cutoff = DateTime.fromISO(serviceThrough, {
    zone: hours.timezone,
  }).endOf("day");
  const end = DateTime.min(cutoff, start.plus({ days: 27 }).endOf("day"));
  if (!end.isValid || end < start)
    return {
      checkedAt: now.toISOString(),
      availableDates: [] as string[],
      through: serviceThrough,
      hasOpening: false,
    };
  const booked = await db
    .select({
      date: sql<string>`to_char(${appointments.startAt} at time zone ${hours.timezone}, 'YYYY-MM-DD')`,
      count: sql<number>`count(*)::int`,
    })
    .from(appointments)
    .where(
      and(
        gte(appointments.startAt, start.toJSDate()),
        lte(appointments.startAt, end.toJSDate()),
        ne(appointments.status, "canceled"),
      ),
    )
    .groupBy(sql`1`);
  const daily = new Map(booked.map((row) => [row.date, row.count]));
  const candidates: { startAt: string; date: string }[] = [];
  for (let day = start; day <= end; day = day.plus({ days: 1 })) {
    const date = day.toISODate()!;
    if (
      rules.maxJobsPerDay > 0 &&
      (daily.get(date) ?? 0) >= rules.maxJobsPerDay
    )
      continue;
    for (const window of getBusinessHourWindowsForDate(day, hours)) {
      for (
        let time = window.start;
        time.plus({ minutes: 150 }) <= window.end;
        time = time.plus({ minutes: 60 })
      )
        candidates.push({ startAt: time.toUTC().toISO()!, date });
    }
  }
  const available = await filterScheduleReadCandidates({
    db: tx,
    candidates,
    durationMinutes: 120,
    travelBufferMinutes: 30,
    capacity: getAppointmentCapacity(),
    timezone: hours.timezone,
    now,
  });
  const availableDates = [...new Set(available.map((row) => row.date))];
  return {
    checkedAt: now.toISOString(),
    availableDates,
    through: end.toISODate(),
    hasOpening: availableDates.length > 0,
  };
}
