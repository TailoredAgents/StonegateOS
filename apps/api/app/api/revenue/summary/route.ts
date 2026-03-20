import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { contacts, getDb, appointments, properties } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../web/admin";

type WindowSummary = {
  totalCents: number;
  count: number;
};

type WeekToDateJob = {
  appointmentId: string;
  startAt: string;
  completedAt: string | null;
  contactName: string;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  quotedTotalCents: number | null;
  finalTotalCents: number;
  bookingDetails: unknown | null;
};

const REVENUE_TIME_ZONE =
  process.env["APPOINTMENT_TIMEZONE"] ?? "America/New_York";

async function computeWindow(
  db: ReturnType<typeof getDb>,
  start: Date,
  end: Date,
): Promise<WindowSummary> {
  const [row] = await db
    .select({
      totalCents: sql<number>`
        coalesce(
          sum(${appointments.finalTotalCents}),
          0
        )::int
      `.as("total_cents"),
      count: sql<number>`
        count(*) filter (where ${appointments.finalTotalCents} is not null)::int
      `.as("count"),
    })
    .from(appointments)
    .where(
      and(
        eq(appointments.status, "completed"),
        isNotNull(appointments.startAt),
        isNotNull(appointments.finalTotalCents),
        gte(appointments.startAt, start),
        lt(appointments.startAt, end),
      ),
    );

  return {
    totalCents: row?.totalCents ?? 0,
    count: row?.count ?? 0,
  };
}

async function computeWeekToDateJobs(
  db: ReturnType<typeof getDb>,
  start: Date,
  end: Date,
): Promise<WeekToDateJob[]> {
  const rows = await db
    .select({
      appointmentId: appointments.id,
      startAt: appointments.startAt,
      completedAt: appointments.completedAt,
      finalTotalCents: appointments.finalTotalCents,
      quotedTotalCents: appointments.quotedTotalCents,
      bookingDetails: appointments.bookingDetails,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      addressLine1: properties.addressLine1,
      city: properties.city,
      state: properties.state,
      postalCode: properties.postalCode,
    })
    .from(appointments)
    .leftJoin(contacts, eq(appointments.contactId, contacts.id))
    .leftJoin(properties, eq(appointments.propertyId, properties.id))
    .where(
      and(
        eq(appointments.status, "completed"),
        isNotNull(appointments.startAt),
        isNotNull(appointments.finalTotalCents),
        gte(appointments.startAt, start),
        lt(appointments.startAt, end),
      ),
    )
    .orderBy(sql`${appointments.startAt} desc`);

  return rows.map((row) => {
    const contactName = [row.contactFirstName, row.contactLastName]
      .map((part) => (part ?? "").trim())
      .filter((part) => part.length > 0)
      .join(" ");

    return {
      appointmentId: row.appointmentId,
      startAt: row.startAt!.toISOString(),
      completedAt: row.completedAt ? row.completedAt.toISOString() : null,
      contactName: contactName || "Unknown customer",
      addressLine1: row.addressLine1 ?? null,
      city: row.city ?? null,
      state: row.state ?? null,
      postalCode: row.postalCode ?? null,
      quotedTotalCents: row.quotedTotalCents ?? null,
      finalTotalCents: row.finalTotalCents ?? 0,
      bookingDetails: row.bookingDetails ?? null,
    };
  });
}

function startOfLocalWeek(d: Date, timezone: string): Date {
  return DateTime.fromJSDate(d, { zone: timezone }).startOf("week").toJSDate();
}

function startOfLocalMonth(d: Date, timezone: string): Date {
  return DateTime.fromJSDate(d, { zone: timezone }).startOf("month").toJSDate();
}

function startOfLocalYear(d: Date, timezone: string): Date {
  return DateTime.fromJSDate(d, { zone: timezone }).startOf("year").toJSDate();
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "appointments.read");
  if (permissionError) return permissionError;

  const db = getDb();
  const now = new Date();

  const last30Start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const weekStart = startOfLocalWeek(now, REVENUE_TIME_ZONE);
  const monthStart = startOfLocalMonth(now, REVENUE_TIME_ZONE);
  const yearStart = startOfLocalYear(now, REVENUE_TIME_ZONE);
  const elapsedWeekMs = now.getTime() - weekStart.getTime();
  const previousWeekStart = new Date(
    weekStart.getTime() - 7 * 24 * 60 * 60 * 1000,
  );
  const previousWeekEnd = new Date(previousWeekStart.getTime() + elapsedWeekMs);

  const [
    weekToDate,
    samePaceLastWeek,
    weekToDateJobs,
    last30Days,
    monthToDate,
    yearToDate,
  ] = await Promise.all([
    computeWindow(db, weekStart, now),
    computeWindow(db, previousWeekStart, previousWeekEnd),
    computeWeekToDateJobs(db, weekStart, now),
    computeWindow(db, last30Start, now),
    computeWindow(db, monthStart, now),
    computeWindow(db, yearStart, now),
  ]);

  return NextResponse.json({
    ok: true,
    currency: "USD",
    timezone: REVENUE_TIME_ZONE,
    windows: {
      weekToDate: {
        ...weekToDate,
        startsAt: weekStart.toISOString(),
        jobs: weekToDateJobs,
      },
      samePaceLastWeek: {
        ...samePaceLastWeek,
        startsAt: previousWeekStart.toISOString(),
        endsAt: previousWeekEnd.toISOString(),
      },
      last30Days,
      monthToDate,
      yearToDate,
    },
  });
}
