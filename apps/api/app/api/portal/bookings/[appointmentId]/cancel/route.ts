import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { DateTime } from "luxon";
import { and, eq, sql } from "drizzle-orm";
import { queueSystemOutboundMessage } from "@/lib/system-outbound";
import {
  appointmentNotes,
  appointments,
  auditLogs,
  contacts,
  getDb,
  outboxEvents,
  partnerBookings,
  partnerUsers,
  properties,
} from "@/db";
import {
  requirePartnerSession,
  resolvePublicSiteBaseUrl,
} from "@/lib/partner-portal-auth";
import { APPOINTMENT_TIME_ZONE } from "../../../../web/scheduling";
import {
  hashPartnerOperationKey,
  normalizePartnerOperationKey,
  queuePartnerBookingStaffAlert,
  resolvePartnerBookingStaffRecipient,
} from "@/lib/staff-notification-operations";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseExpectedVersion(value: string | null): number | null {
  if (!value) return null;
  const match = /^(?:W\/)?"?(\d{1,9})"?$/u.exec(value.trim());
  if (!match?.[1]) return null;
  const version = Number(match[1]);
  return Number.isSafeInteger(version) && version > 0 ? version : null;
}

function formatLocalDateTime(date: Date): string {
  return DateTime.fromJSDate(date, { zone: "utc" })
    .setZone(APPOINTMENT_TIME_ZONE)
    .toLocaleString(DateTime.DATETIME_MED);
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ appointmentId: string }> },
): Promise<Response> {
  const auth = await requirePartnerSession(request);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: auth.status },
    );
  }

  const { appointmentId: rawAppointmentId } = await context.params;
  const appointmentId =
    typeof rawAppointmentId === "string" ? rawAppointmentId.trim() : "";
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      appointmentId,
    )
  ) {
    return NextResponse.json(
      { ok: false, error: "appointment_id_invalid" },
      { status: 422 },
    );
  }

  const operationKey = normalizePartnerOperationKey(
    request.headers.get("idempotency-key"),
  );
  if (!operationKey) {
    return NextResponse.json(
      { ok: false, error: "idempotency_key_required" },
      { status: 422 },
    );
  }
  const expectedVersion = parseExpectedVersion(request.headers.get("if-match"));
  if (!expectedVersion) {
    return NextResponse.json(
      { ok: false, error: "expected_version_required" },
      { status: 428 },
    );
  }

  let rawPayload: unknown;
  try {
    rawPayload = await readBoundedJsonRequest(request, {
      maximumBytes: 1_024,
      deadlineMs: 10_000,
      rejectDuplicateObjectKeys: true,
    });
  } catch (error) {
    if (error instanceof BoundedJsonRequestError) {
      return NextResponse.json(
        { ok: false, error: error.code },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { ok: false, error: "invalid_body" },
      { status: 400 },
    );
  }
  if (!isRecord(rawPayload) || Object.keys(rawPayload).length !== 0) {
    return NextResponse.json(
      { ok: false, error: "unexpected_field" },
      { status: 422 },
    );
  }

  const operationKeyHash = hashPartnerOperationKey(
    auth.partnerUser.id,
    `${appointmentId}:${operationKey}`,
  );
  const correlationId = randomUUID();
  const cancelOperationId = randomUUID();
  const now = new Date();
  const db = getDb();
  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`partner-booking-cancel:${appointmentId}`}, 0))`,
    );
    const [row] = await tx
      .select({
        bookingId: partnerBookings.id,
        bookingVersion: partnerBookings.version,
        cancelOperationKeyHash: partnerBookings.cancelOperationKeyHash,
        appointmentId: appointments.id,
        status: appointments.status,
        startAt: appointments.startAt,
        contactId: appointments.contactId,
        calendarEventId: appointments.calendarEventId,
        propertyAddress: properties.addressLine1,
        propertyCity: properties.city,
        propertyState: properties.state,
        propertyPostal: properties.postalCode,
        partnerUserId: partnerBookings.partnerUserId,
        serviceKey: partnerBookings.serviceKey,
        tierKey: partnerBookings.tierKey,
        orgCompany: contacts.company,
        orgFirstName: contacts.firstName,
        orgLastName: contacts.lastName,
      })
      .from(partnerBookings)
      .innerJoin(
        appointments,
        eq(partnerBookings.appointmentId, appointments.id),
      )
      .leftJoin(properties, eq(appointments.propertyId, properties.id))
      .leftJoin(contacts, eq(partnerBookings.orgContactId, contacts.id))
      .where(
        and(
          eq(partnerBookings.orgContactId, auth.partnerUser.orgContactId),
          eq(partnerBookings.appointmentId, appointmentId),
        ),
      )
      .limit(1);

    if (!row?.appointmentId) return { kind: "not_found" as const };
    if (row.status === "canceled") {
      if (row.cancelOperationKeyHash !== operationKeyHash) {
        return {
          kind: "already_canceled" as const,
          currentVersion: row.bookingVersion,
        };
      }
      const [existingAudit] = await tx
        .select({
          id: auditLogs.id,
          correlationId: auditLogs.correlationId,
          createdAt: auditLogs.createdAt,
          meta: auditLogs.meta,
        })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.action, "partner.booking.canceled"),
            eq(auditLogs.entityType, "appointment"),
            eq(auditLogs.entityId, appointmentId),
            eq(auditLogs.idempotencyKeyHash, operationKeyHash),
          ),
        )
        .limit(1);
      const existingMeta = isRecord(existingAudit?.meta)
        ? existingAudit.meta
        : null;
      const existingOperationId =
        typeof existingMeta?.["operationId"] === "string"
          ? existingMeta["operationId"]
          : null;
      if (
        !existingAudit?.id ||
        !existingAudit.correlationId ||
        !existingOperationId
      ) {
        throw new Error("partner_booking_cancel_replay_audit_missing");
      }
      return {
        kind: "canceled" as const,
        status: "canceled" as const,
        version: row.bookingVersion,
        operationId: existingOperationId,
        auditEventId: existingAudit.id,
        correlationId: existingAudit.correlationId,
        replay: true,
        committedAt: existingAudit.createdAt,
      };
    }
    if (row.bookingVersion !== expectedVersion) {
      return {
        kind: "version_conflict" as const,
        currentVersion: row.bookingVersion,
      };
    }
    if (row.status !== "requested" && row.status !== "confirmed") {
      return {
        kind: "status_conflict" as const,
        status: row.status,
        currentVersion: row.bookingVersion,
      };
    }

    const [updatedAppointment] = await tx
      .update(appointments)
      .set({ status: "canceled", updatedAt: now })
      .where(
        and(
          eq(appointments.id, appointmentId),
          eq(appointments.status, row.status),
        ),
      )
      .returning({
        id: appointments.id,
        status: appointments.status,
        updatedAt: appointments.updatedAt,
      });
    if (!updatedAppointment?.id) {
      return {
        kind: "version_conflict" as const,
        currentVersion: row.bookingVersion,
      };
    }

    const [updatedBooking] = await tx
      .update(partnerBookings)
      .set({
        cancelOperationKeyHash: operationKeyHash,
        version: row.bookingVersion + 1,
        canceledAt: now,
      })
      .where(
        and(
          eq(partnerBookings.id, row.bookingId),
          eq(partnerBookings.version, row.bookingVersion),
        ),
      )
      .returning({
        id: partnerBookings.id,
        version: partnerBookings.version,
      });
    if (!updatedBooking?.id) {
      throw new Error("partner_booking_version_changed_after_status_lock");
    }

    await tx.insert(appointmentNotes).values({
      appointmentId,
      body: [
        "[partner-booking-canceled]",
        `Canceled by portal user: ${auth.partnerUser.email}`,
      ].join("\n"),
      createdAt: now,
    });

    const address =
      row.propertyAddress &&
      row.propertyCity &&
      row.propertyState &&
      row.propertyPostal
        ? `${row.propertyAddress}, ${row.propertyCity}, ${row.propertyState} ${row.propertyPostal}`
        : "Address unavailable";
    const when = row.startAt ? formatLocalDateTime(row.startAt) : "TBD";
    const orgLabel = row.orgCompany?.trim().length
      ? row.orgCompany.trim()
      : `${row.orgFirstName ?? ""} ${row.orgLastName ?? ""}`.trim() ||
        "Partner";

    const staffMessage = [
      `Partner booking canceled: ${orgLabel}`,
      address,
      when,
      row.serviceKey
        ? `Service: ${row.serviceKey}${row.tierKey ? ` (${row.tierKey})` : ""}`
        : null,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
    const staffRecipient = await resolvePartnerBookingStaffRecipient(tx);
    const staffAlert = staffRecipient
      ? await queuePartnerBookingStaffAlert(tx, {
          appointmentId,
          contactId: row.contactId,
          recipient: staffRecipient,
          kind: "partner_booking_canceled",
          body: staffMessage,
          actor: {
            partnerUserId: auth.partnerUser.id,
            sessionId: auth.partnerUser.sessionId,
            label: auth.partnerUser.email,
          },
          correlationId,
          now,
        })
      : null;

    const [partnerUser] = row.partnerUserId
      ? await tx
          .select({
            id: partnerUsers.id,
            name: partnerUsers.name,
            email: partnerUsers.email,
            phoneE164: partnerUsers.phoneE164,
          })
          .from(partnerUsers)
          .where(eq(partnerUsers.id, row.partnerUserId))
          .limit(1)
      : [];
    const portalLink = (() => {
      const base = resolvePublicSiteBaseUrl();
      if (!base) return null;
      return new URL("/partners/bookings", base).toString();
    })();
    const partnerName = partnerUser?.name?.trim().length
      ? partnerUser.name.trim()
      : "there";
    const smsBody = `Stonegate: booking canceled for ${when} at ${address}. Reply here if you want to rebook.`;
    const emailBody = [
      `Hi ${partnerName},`,
      "",
      "Your booking was canceled:",
      when,
      address,
      portalLink ? "" : null,
      portalLink ? `View bookings: ${portalLink}` : null,
      "",
      "Reply to this message if you want to rebook.",
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");

    const emailMessageId = partnerUser?.email
      ? await queueSystemOutboundMessage({
          db: tx,
          contactId: auth.partnerUser.orgContactId,
          channel: "email",
          toAddress: partnerUser.email,
          subject: "Stonegate Partner booking canceled",
          body: emailBody,
          metadata: {
            confirmationLoop: true,
            partnerPortal: true,
            kind: "partner.booking.canceled",
            appointmentId,
            partnerUserId: partnerUser.id,
          },
          dedupeKey: `partner.booking.canceled:${appointmentId}:${partnerUser.id}:email`,
        })
      : null;
    const smsMessageId = partnerUser?.phoneE164
      ? await queueSystemOutboundMessage({
          db: tx,
          contactId: auth.partnerUser.orgContactId,
          channel: "sms",
          toAddress: partnerUser.phoneE164,
          body: smsBody,
          metadata: {
            confirmationLoop: true,
            partnerPortal: true,
            kind: "partner.booking.canceled",
            appointmentId,
            partnerUserId: partnerUser.id,
          },
          dedupeKey: `partner.booking.canceled:${appointmentId}:${partnerUser.id}:sms`,
        })
      : null;

    const auditEventId = randomUUID();
    const statusOutboxEventId = randomUUID();
    const calendarOutboxEventId = row.calendarEventId ? randomUUID() : null;
    const version = updatedAppointment.updatedAt.toISOString();
    await tx.insert(auditLogs).values({
      id: auditEventId,
      actorType: "human",
      actorId: auth.partnerUser.id,
      actorRole: "partner",
      actorLabel: auth.partnerUser.email,
      sessionId: auth.partnerUser.sessionId,
      authMethod: "partner_session",
      correlationId,
      requiredPermissions: ["partner.bookings.cancel"],
      outcome: "succeeded",
      surface: "/partners/bookings",
      idempotencyKeyHash: operationKeyHash,
      action: "partner.booking.canceled",
      entityType: "appointment",
      entityId: appointmentId,
      meta: sanitizeAuditMetadata({
        operationId: cancelOperationId,
        bookingId: row.bookingId,
        staffAlertOperationId: staffAlert?.operationId ?? null,
        staffAlertState: staffAlert ? "requested" : "recipient_unavailable",
        customerEmailMessageId: emailMessageId,
        customerSmsMessageId: smsMessageId,
        statusOutboxEventId,
        calendarOutboxEventId,
        calendarSync: row.calendarEventId ? "requested" : "not_required",
        before: {
          status: row.status,
          version: row.bookingVersion,
          calendarEventId: row.calendarEventId,
        },
        after: {
          status: "canceled",
          version,
          bookingVersion: updatedBooking.version,
        },
      }),
      createdAt: now,
    });

    await tx.insert(outboxEvents).values({
      id: statusOutboxEventId,
      type: "estimate.status_changed",
      payload: {
        appointmentId,
        status: "canceled",
        statusChanged: true,
        customerNotificationRequested: false,
        version,
      },
      createdAt: now,
    });
    if (calendarOutboxEventId && row.calendarEventId) {
      await tx.insert(outboxEvents).values({
        id: calendarOutboxEventId,
        type: "appointment.calendar_sync_requested",
        payload: {
          appointmentId,
          version,
          reason: "appointment.canceled",
          requestedCalendarEventId: row.calendarEventId,
          sourceAuditEventId: auditEventId,
          actorId: auth.partnerUser.id,
          sessionId: auth.partnerUser.sessionId,
          authMethod: "partner_session",
          correlationId,
          operationId: cancelOperationId,
          requiredPermission: "partner.bookings.cancel",
        },
        createdAt: now,
      });
    }

    return {
      kind: "canceled" as const,
      status: "canceled" as const,
      version: updatedBooking.version,
      operationId: cancelOperationId,
      auditEventId,
      correlationId,
      replay: false,
      committedAt: now,
    };
  });

  if (result.kind === "not_found") {
    return NextResponse.json(
      { ok: false, error: "booking_not_found" },
      { status: 404 },
    );
  }
  if (result.kind === "already_canceled") {
    return NextResponse.json(
      {
        ok: false,
        error: "already_canceled",
        currentVersion: result.currentVersion,
      },
      { status: 409 },
    );
  }
  if (result.kind === "version_conflict") {
    return NextResponse.json(
      {
        ok: false,
        error: "version_conflict",
        currentVersion: result.currentVersion,
      },
      { status: 409 },
    );
  }
  if (result.kind === "status_conflict") {
    return NextResponse.json(
      {
        ok: false,
        error: "status_conflict",
        currentStatus: result.status,
        currentVersion: result.currentVersion,
      },
      { status: 409 },
    );
  }

  return NextResponse.json({
    ok: true,
    status: result.status,
    version: result.version,
    receipt: {
      operationId: result.operationId,
      auditEventId: result.auditEventId,
      correlationId: result.correlationId,
      replay: result.replay,
      committedAt: result.committedAt.toISOString(),
    },
  });
}
