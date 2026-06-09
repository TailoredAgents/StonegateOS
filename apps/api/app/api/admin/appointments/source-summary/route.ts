import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import {
  appointments,
  contacts,
  conversationThreads,
  getDb,
  leads,
  properties,
} from "@/db";
import { parseAppointmentBookingDetails } from "@/lib/appointment-booking-details";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";

const DEFAULT_RANGE_DAYS = 7;
const MAX_RANGE_DAYS = 90;
const MAX_JOBS = 25;

type SourceKey = "facebook" | "google" | "referral" | "team_member" | "other" | "unknown";

type SourceAttribution = {
  source: SourceKey;
  label: string;
  reason: string;
};

function parseRangeDays(value: string | null): number {
  if (!value) return DEFAULT_RANGE_DAYS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RANGE_DAYS;
  return Math.min(Math.floor(parsed), MAX_RANGE_DAYS);
}

function sourceLabel(source: SourceKey): string {
  switch (source) {
    case "facebook":
      return "Facebook";
    case "google":
      return "Google";
    case "referral":
      return "Referral";
    case "team_member":
      return "Team member";
    case "other":
      return "Other";
    default:
      return "Unknown";
  }
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function inferSource(input: {
  bookingDetails: unknown;
  contactSource: string | null;
  leadSource: string | null;
  leadUtmSource: string | null;
  leadGclid: string | null;
  leadFbclid: string | null;
  hasDmThread: boolean;
}): SourceAttribution {
  const bookingDetails = parseAppointmentBookingDetails(input.bookingDetails);
  const bookingSource = bookingDetails?.source?.type ?? null;
  if (bookingSource === "facebook" || bookingSource === "google") {
    return {
      source: bookingSource,
      label: sourceLabel(bookingSource),
      reason: "appointment booking source",
    };
  }
  if (bookingSource === "referral" || bookingSource === "team_member") {
    return {
      source: bookingSource,
      label: sourceLabel(bookingSource),
      reason: "appointment booking source",
    };
  }

  const contactSource = normalizeText(input.contactSource);
  if (contactSource === "facebook" || contactSource.includes("facebook") || contactSource.includes("meta")) {
    return { source: "facebook", label: "Facebook", reason: "contact source" };
  }
  if (contactSource === "google" || contactSource.includes("google") || contactSource.includes("gclid")) {
    return { source: "google", label: "Google", reason: "contact source" };
  }
  if (contactSource.startsWith("referral:") || contactSource === "referral") {
    return { source: "referral", label: "Referral", reason: "contact source" };
  }
  if (contactSource.startsWith("team_member:") || contactSource === "team_member") {
    return { source: "team_member", label: "Team member", reason: "contact source" };
  }
  if (contactSource) {
    return { source: "other", label: "Other", reason: "contact source" };
  }

  const leadSource = normalizeText(input.leadSource);
  const leadUtmSource = normalizeText(input.leadUtmSource);
  if (input.leadGclid || leadSource.includes("google") || leadUtmSource.includes("google")) {
    return { source: "google", label: "Google", reason: input.leadGclid ? "lead gclid" : "lead source" };
  }
  if (
    input.leadFbclid ||
    leadSource.includes("facebook") ||
    leadSource.includes("meta") ||
    leadUtmSource.includes("facebook") ||
    leadUtmSource.includes("meta")
  ) {
    return { source: "facebook", label: "Facebook", reason: input.leadFbclid ? "lead fbclid" : "lead source" };
  }

  if (input.hasDmThread) {
    return { source: "facebook", label: "Facebook", reason: "Messenger conversation" };
  }

  if (leadSource || leadUtmSource) {
    return { source: "other", label: "Other", reason: "lead source" };
  }

  return { source: "unknown", label: "Unknown", reason: "no source recorded" };
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "appointments.read");
  if (permissionError) return permissionError;

  const rangeDays = parseRangeDays(request.nextUrl.searchParams.get("rangeDays"));
  const now = new Date();
  const since = new Date(now.getTime() - rangeDays * 24 * 60 * 60 * 1000);

  const db = getDb();
  const rows = await db
    .select({
      id: appointments.id,
      contactId: appointments.contactId,
      appointmentType: appointments.type,
      status: appointments.status,
      startAt: appointments.startAt,
      createdAt: appointments.createdAt,
      quotedTotalCents: appointments.quotedTotalCents,
      finalTotalCents: appointments.finalTotalCents,
      bookingDetails: appointments.bookingDetails,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      contactSource: contacts.source,
      leadSource: leads.source,
      leadUtmSource: leads.utmSource,
      leadGclid: leads.gclid,
      leadFbclid: leads.fbclid,
      propertyAddressLine1: properties.addressLine1,
      propertyCity: properties.city,
      propertyState: properties.state,
      hasDmThread: sql<boolean>`exists (
        select 1
        from ${conversationThreads}
        where ${conversationThreads.contactId} = ${appointments.contactId}
          and ${conversationThreads.channel} = 'dm'
          and ${conversationThreads.createdAt} <= ${appointments.createdAt}
      )`,
    })
    .from(appointments)
    .innerJoin(contacts, eq(appointments.contactId, contacts.id))
    .leftJoin(leads, eq(appointments.leadId, leads.id))
    .leftJoin(properties, eq(appointments.propertyId, properties.id))
    .where(
      and(
        gte(appointments.createdAt, since),
        inArray(appointments.status, ["confirmed", "completed"]),
        ne(appointments.type, "in_person_quote"),
      ),
    )
    .orderBy(desc(appointments.createdAt))
    .limit(500);

  const buckets = new Map<SourceKey, { source: SourceKey; label: string; count: number; estimatedRevenueCents: number }>();
  for (const key of ["facebook", "google", "referral", "team_member", "other", "unknown"] as SourceKey[]) {
    buckets.set(key, {
      source: key,
      label: sourceLabel(key),
      count: 0,
      estimatedRevenueCents: 0,
    });
  }

  const jobs = rows.map((row) => {
    const attribution = inferSource({
      bookingDetails: row.bookingDetails,
      contactSource: row.contactSource,
      leadSource: row.leadSource,
      leadUtmSource: row.leadUtmSource,
      leadGclid: row.leadGclid,
      leadFbclid: row.leadFbclid,
      hasDmThread: row.hasDmThread === true,
    });
    const amountCents = row.finalTotalCents ?? row.quotedTotalCents ?? 0;
    const bucket = buckets.get(attribution.source) ?? buckets.get("unknown")!;
    bucket.count += 1;
    bucket.estimatedRevenueCents += amountCents;

    const contactName = [row.contactFirstName, row.contactLastName].filter(Boolean).join(" ").trim() || "Customer";
    const address = [row.propertyAddressLine1, row.propertyCity, row.propertyState]
      .map((part) => (part ?? "").trim())
      .filter(Boolean)
      .join(", ");

    return {
      id: row.id,
      contactId: row.contactId,
      source: attribution.source,
      sourceLabel: attribution.label,
      attributionReason: attribution.reason,
      status: row.status,
      appointmentType: row.appointmentType,
      createdAt: row.createdAt.toISOString(),
      startAt: row.startAt ? row.startAt.toISOString() : null,
      contactName,
      address: address || null,
      estimatedRevenueCents: amountCents,
    };
  });

  const totals = [...buckets.values()];
  const highlightedSources = ["facebook", "google"] as const;

  return NextResponse.json({
    ok: true,
    rangeDays,
    since: since.toISOString(),
    through: now.toISOString(),
    countedStatuses: ["confirmed", "completed"],
    excludedAppointmentTypes: ["in_person_quote"],
    totalBookedJobs: rows.length,
    sources: totals,
    facebook: buckets.get("facebook"),
    google: buckets.get("google"),
    highlightedJobs: jobs.filter((job) => highlightedSources.includes(job.source as "facebook" | "google")).slice(0, MAX_JOBS),
    recentJobs: jobs.slice(0, MAX_JOBS),
  });
}
