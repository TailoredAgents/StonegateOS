import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import {
  appointments,
  contacts,
  getDb,
  paymentRefunds,
  payments,
  properties,
} from "@/db";
import { parseAppointmentBookingDetails } from "@/lib/appointment-booking-details";
import { requirePermission } from "@/lib/permissions";
import { buildPaymentLedgerReportingSummary } from "@/lib/revenue-payment-ledger";
import { isPaymentLedgerSchemaAvailable } from "@/lib/payment-schema";
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
  bookingDetails: unknown;
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

async function computeAllTimeWindow(
  db: ReturnType<typeof getDb>,
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
        isNotNull(appointments.finalTotalCents),
      ),
    );

  return {
    totalCents: row?.totalCents ?? 0,
    count: row?.count ?? 0,
  };
}

async function computePaymentLedgerSummary(db: ReturnType<typeof getDb>) {
  const [appointmentRows, paymentRows, reviewRefundRows] = await Promise.all([
    db
      .select({
        id: appointments.id,
        status: appointments.status,
        appointmentType: appointments.type,
        finalTotalCents: appointments.finalTotalCents,
      })
      .from(appointments)
      .where(isNotNull(appointments.finalTotalCents)),
    db
      .select({
        id: payments.id,
        appointmentId: payments.appointmentId,
        amountCents: payments.amount,
        jobAmountCents: payments.jobAmountCents,
        tipCents: payments.tipCents,
        totalAmountCents: payments.totalAmountCents,
        refundedAmountCents: payments.refundedAmountCents,
        status: payments.status,
        canonicalStatus: payments.canonicalStatus,
        providerStatus: payments.providerStatus,
      })
      .from(payments),
    db
      .select({
        id: paymentRefunds.id,
        paymentId: paymentRefunds.paymentId,
        amountCents: paymentRefunds.amountCents,
      })
      .from(paymentRefunds)
      .where(eq(paymentRefunds.canonicalStatus, "needs_review")),
  ]);

  return buildPaymentLedgerReportingSummary({
    appointments: appointmentRows,
    payments: paymentRows,
    reviewRefunds: reviewRefundRows,
  });
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
      bookingDetails: parseAppointmentBookingDetails(row.bookingDetails),
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
  const canReadPayments =
    (await requirePermission(request, "payments.read")) === null;

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
    fullLastWeek,
    weekToDateJobs,
    last30Days,
    monthToDate,
    yearToDate,
    allTime,
  ] = await Promise.all([
    computeWindow(db, weekStart, now),
    computeWindow(db, previousWeekStart, previousWeekEnd),
    computeWindow(db, previousWeekStart, weekStart),
    computeWeekToDateJobs(db, weekStart, now),
    computeWindow(db, last30Start, now),
    computeWindow(db, monthStart, now),
    computeWindow(db, yearStart, now),
    computeAllTimeWindow(db),
  ]);

  let paymentLedger = null;
  if (canReadPayments && (await isPaymentLedgerSchemaAvailable(db))) {
    try {
      paymentLedger = {
        scope: "all_time" as const,
        ...(await computePaymentLedgerSummary(db)),
      };
    } catch (error) {
      console.warn("[revenue] payment_ledger_summary_failed", error);
    }
  }

  return NextResponse.json({
    ok: true,
    currency: "USD",
    timezone: REVENUE_TIME_ZONE,
    reportingBasis: {
      completedJobRevenue:
        "Final job totals for completed appointments, grouped by scheduled date.",
      paymentsCollected:
        "Provider-neutral completed payments including tips, net of refunds.",
    },
    paymentLedger,
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
      fullLastWeek: {
        ...fullLastWeek,
        startsAt: previousWeekStart.toISOString(),
        endsAt: weekStart.toISOString(),
      },
      last30Days,
      monthToDate,
      yearToDate,
      allTime,
    },
  });
}
