import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { DateTime } from "luxon";
import { and, eq } from "drizzle-orm";
import { queueSystemOutboundMessage } from "@/lib/system-outbound";
import { sendSmsMessage } from "@/lib/messaging";
import {
  appointmentNotes,
  appointments,
  contacts,
  getDb,
  partnerBookings,
  partnerUsers,
  policySettings,
  properties
} from "@/db";
import { requirePartnerSession, resolvePublicSiteBaseUrl } from "@/lib/partner-portal-auth";
import { APPOINTMENT_TIME_ZONE } from "../../../../web/scheduling";
import { getSalesScorecardConfig } from "@/lib/sales-scorecard";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function resolveDevonPhone(db: ReturnType<typeof getDb>): Promise<string | null> {
  const config = await getSalesScorecardConfig(db);
  const memberId = config.defaultAssigneeMemberId?.trim().length ? config.defaultAssigneeMemberId.trim() : null;
  if (!memberId) return null;

  const [row] = await db
    .select({ value: policySettings.value })
    .from(policySettings)
    .where(eq(policySettings.key, "team_member_phones"))
    .limit(1);

  const value = row?.value;
  if (!isRecord(value)) return null;
  const phones = value["phones"];
  if (!isRecord(phones)) return null;
  const phone = phones[memberId];
  return typeof phone === "string" && phone.trim().length > 0 ? phone.trim() : null;
}

function formatLocalDateTime(date: Date): string {
  return DateTime.fromJSDate(date, { zone: "utc" }).setZone(APPOINTMENT_TIME_ZONE).toLocaleString(DateTime.DATETIME_MED);
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ appointmentId: string }> }
): Promise<Response> {
  const auth = await requirePartnerSession(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const { appointmentId: rawAppointmentId } = await context.params;
  const appointmentId = typeof rawAppointmentId === "string" ? rawAppointmentId.trim() : "";
  if (!appointmentId) {
    return NextResponse.json({ ok: false, error: "appointmentId_required" }, { status: 400 });
  }

  const db = getDb();
  const [row] = await db
    .select({
      appointmentId: appointments.id,
      status: appointments.status,
      startAt: appointments.startAt,
      contactId: appointments.contactId,
      propertyId: appointments.propertyId,
      propertyAddress: properties.addressLine1,
      propertyCity: properties.city,
      propertyState: properties.state,
      propertyPostal: properties.postalCode,
      partnerUserId: partnerBookings.partnerUserId,
      serviceKey: partnerBookings.serviceKey,
      tierKey: partnerBookings.tierKey,
      orgCompany: contacts.company,
      orgFirstName: contacts.firstName,
      orgLastName: contacts.lastName
    })
    .from(partnerBookings)
    .innerJoin(appointments, eq(partnerBookings.appointmentId, appointments.id))
    .leftJoin(properties, eq(appointments.propertyId, properties.id))
    .leftJoin(contacts, eq(partnerBookings.orgContactId, contacts.id))
    .where(and(eq(partnerBookings.orgContactId, auth.partnerUser.orgContactId), eq(partnerBookings.appointmentId, appointmentId)))
    .limit(1);

  if (!row?.appointmentId) {
    return NextResponse.json({ ok: false, error: "booking_not_found" }, { status: 404 });
  }

  if (row.status === "canceled") {
    return NextResponse.json({ ok: true, status: "canceled" });
  }

  const now = new Date();
  await db
    .update(appointments)
    .set({ status: "canceled", updatedAt: now })
    .where(eq(appointments.id, appointmentId));

  await db.insert(appointmentNotes).values({
    appointmentId,
    body: ["[partner-booking-canceled]", `Canceled by portal user: ${auth.partnerUser.email}`].join("\n"),
    createdAt: now
  });

  const address =
    row.propertyAddress && row.propertyCity && row.propertyState && row.propertyPostal
      ? `${row.propertyAddress}, ${row.propertyCity}, ${row.propertyState} ${row.propertyPostal}`
      : "Address unavailable";
  const when = row.startAt ? formatLocalDateTime(row.startAt) : "TBD";

  const orgLabel =
    row.orgCompany?.trim().length
      ? row.orgCompany.trim()
      : `${row.orgFirstName ?? ""} ${row.orgLastName ?? ""}`.trim() || "Partner";

  const devonPhone = await resolveDevonPhone(db);
  if (devonPhone) {
    const message = [
      `Partner booking canceled: ${orgLabel}`,
      address,
      when,
      row.serviceKey ? `Service: ${row.serviceKey}${row.tierKey ? ` (${row.tierKey})` : ""}` : null
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
    await sendSmsMessage(devonPhone, message).catch(() => null);
  }

  // Partner-facing confirmation (logged in Inbox under the org contact).
  try {
    const [partnerUser] = row.partnerUserId
      ? await db
          .select({
            id: partnerUsers.id,
            name: partnerUsers.name,
            email: partnerUsers.email,
            phoneE164: partnerUsers.phoneE164
          })
          .from(partnerUsers)
          .where(eq(partnerUsers.id, row.partnerUserId))
          .limit(1)
      : [];

    const portalLink = (() => {
      const base = resolvePublicSiteBaseUrl();
      if (!base) return null;
      const url = new URL("/partners/bookings", base);
      return url.toString();
    })();

    const partnerName = partnerUser?.name?.trim().length ? partnerUser.name.trim() : "there";
    const smsBody = `Stonegate: booking canceled for ${when} at ${address}. Reply here if you want to rebook.`;
    const emailSubject = "Stonegate Partner booking canceled";
    const emailBody = [
      `Hi ${partnerName},`,
      "",
      "Your booking was canceled:",
      when,
      address,
      portalLink ? "" : null,
      portalLink ? `View bookings: ${portalLink}` : null,
      "",
      "Reply to this message if you want to rebook."
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");

    if (partnerUser?.email) {
      await queueSystemOutboundMessage({
        contactId: auth.partnerUser.orgContactId,
        channel: "email",
        toAddress: partnerUser.email,
        subject: emailSubject,
        body: emailBody,
        metadata: {
          confirmationLoop: true,
          partnerPortal: true,
          kind: "partner.booking.canceled",
          appointmentId,
          partnerUserId: partnerUser.id
        },
        dedupeKey: `partner.booking.canceled:${appointmentId}:${partnerUser.id}:email`
      });
    }

    if (partnerUser?.phoneE164) {
      await queueSystemOutboundMessage({
        contactId: auth.partnerUser.orgContactId,
        channel: "sms",
        toAddress: partnerUser.phoneE164,
        body: smsBody,
        metadata: {
          confirmationLoop: true,
          partnerPortal: true,
          kind: "partner.booking.canceled",
          appointmentId,
          partnerUserId: partnerUser.id
        },
        dedupeKey: `partner.booking.canceled:${appointmentId}:${partnerUser.id}:sms`
      });
    }
  } catch {
    // Best-effort.
  }

  return NextResponse.json({ ok: true, status: "canceled" });
}
