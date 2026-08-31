import { createHash, randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  appointments,
  auditLogs,
  getDb,
  outboxEvents,
  partnerAccountMemberships,
  partnerAccountLocations,
  partnerBookings,
  partnerJobEvents,
  partnerNotifications,
} from "@/db";
import { acquireScheduleConflictLock } from "@/lib/appointment-schedule-conflicts";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { arePartnerPortalV2WritesEnabled } from "@/lib/partner-portal-feature-flags";
import {
  evaluatePartnerCancellation,
  resolvePartnerCancellationPolicy,
} from "@/lib/partner-portal-v2-cancellation";
import {
  createPartnerJobAccessCondition,
  createPartnerJobLocationJoinCondition,
  hasPartnerJobAccess,
} from "@/lib/partner-portal-v2-resource-authorization";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";
import {
  createPortalV2StrongEtag,
  evaluatePortalV2RevisionPrecondition,
  readPortalV2CorrelationId,
  readPortalV2IdempotencyKey,
} from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CancelBodySchema = z
  .object({ reason: z.string().trim().min(5).max(1_000) })
  .strict();

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (!isAllowedPartnerPortalMutationOrigin(request)) {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  const authorization = await requirePartnerCapability(
    request,
    "bookings.cancel",
  );
  if (!authorization.ok) {
    return createPartnerPortalV2ErrorResponse(
      authorization.error,
      authorization.status,
      correlationId,
    );
  }
  const { principal } = authorization;
  const { jobId } = await context.params;
  if (
    !principal.accountId ||
    !principal.membershipId ||
    !UUID_PATTERN.test(jobId)
  ) {
    return createPartnerPortalV2ErrorResponse("not_found", 404, correlationId);
  }
  if (!arePartnerPortalV2WritesEnabled(principal.accountId)) {
    return createPartnerPortalV2ErrorResponse(
      "service_unavailable",
      503,
      correlationId,
    );
  }
  try {
    if (!(await hasPartnerJobAccess(principal, jobId))) {
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
        correlationId,
      );
    }
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
  const idempotency = readPortalV2IdempotencyKey(request.headers);
  if (!idempotency.ok) {
    return createPartnerPortalV2ErrorResponse(
      idempotency.reason === "required"
        ? "idempotency_key_required"
        : "invalid_idempotency_key",
      400,
      correlationId,
    );
  }
  if (!idempotency.keyHash) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_idempotency_key",
      400,
      correlationId,
    );
  }

  let payload: unknown;
  try {
    payload = await readBoundedJsonRequest(request, {
      maximumBytes: 2_048,
      deadlineMs: 10_000,
      rejectDuplicateObjectKeys: true,
    });
  } catch (error) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_body",
      error instanceof BoundedJsonRequestError ? error.status : 400,
      correlationId,
    );
  }
  const parsed = CancelBodySchema.safeParse(payload);
  if (!parsed.success) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_fields",
      422,
      correlationId,
    );
  }
  const requestHash = createHash("sha256")
    .update(JSON.stringify({ jobId, reason: parsed.data.reason }), "utf8")
    .digest("hex");

  try {
    const db = getDb();
    const result = await db.transaction(async (tx) => {
      await acquireScheduleConflictLock(tx);
      const [row] = await tx
        .select({
          bookingId: partnerBookings.id,
          bookingVersion: partnerBookings.version,
          bookingUpdatedAt: partnerBookings.updatedAt,
          publicStatus: partnerBookings.publicStatus,
          arrivalWindowStartAt: partnerBookings.arrivalWindowStartAt,
          requestedReviewReasons: partnerBookings.requestedReviewReasons,
          cancelOperationKeyHash: partnerBookings.cancelOperationKeyHash,
          cancelRequestHash: partnerBookings.cancelRequestHash,
          notificationMembershipId: partnerAccountMemberships.id,
          appointmentId: appointments.id,
          appointmentStatus: appointments.status,
          calendarEventId: appointments.calendarEventId,
          timezone: partnerAccountLocations.timezone,
        })
        .from(partnerBookings)
        .innerJoin(
          appointments,
          eq(partnerBookings.appointmentId, appointments.id),
        )
        .leftJoin(
          partnerAccountLocations,
          createPartnerJobLocationJoinCondition(),
        )
        .leftJoin(
          partnerAccountMemberships,
          and(
            eq(
              partnerAccountMemberships.id,
              partnerBookings.requestedByMembershipId,
            ),
            eq(
              partnerAccountMemberships.partnerAccountId,
              partnerBookings.partnerAccountId,
            ),
          ),
        )
        .where(createPartnerJobAccessCondition(principal, jobId))
        .for("update", { of: partnerBookings })
        .limit(1);
      if (!row) return { kind: "not_found" as const };

      if (
        row.cancelOperationKeyHash === idempotency.keyHash &&
        row.cancelRequestHash === requestHash
      ) {
        if (row.publicStatus === "canceled") {
          return {
            kind: "success" as const,
            replayed: true,
            outcome: "canceled" as const,
            status: "canceled",
            version: row.bookingVersion,
            updatedAt: row.bookingUpdatedAt,
          };
        }
        return {
          kind: "success" as const,
          replayed: true,
          outcome: "review_requested" as const,
          status: row.publicStatus,
          version: row.bookingVersion,
          updatedAt: row.bookingUpdatedAt,
        };
      }
      if (row.publicStatus === "canceled") {
        return { kind: "already_canceled" as const };
      }
      if (row.cancelOperationKeyHash || row.cancelRequestHash) {
        return { kind: "review_pending" as const };
      }
      const etagRevision = `${row.bookingId}:${row.bookingVersion}:${row.bookingUpdatedAt.toISOString()}`;
      const precondition = evaluatePortalV2RevisionPrecondition({
        ifMatch: request.headers.get("if-match"),
        currentRevision: etagRevision,
        correlationId,
      });
      if (!precondition.ok) {
        return {
          kind: "precondition" as const,
          response: precondition.response,
        };
      }
      const now = new Date();
      const cancellation = evaluatePartnerCancellation({
        status: row.publicStatus,
        promisedArrivalStartAt: row.arrivalWindowStartAt,
        now,
        canCancel: true,
        reviewPending: false,
        policy: resolvePartnerCancellationPolicy({ timezone: row.timezone }),
      });
      if (!cancellation.action) {
        return { kind: "status_conflict" as const };
      }

      if (cancellation.action === "request_cancellation_review") {
        const reviewReasons = Array.from(
          new Set([
            ...row.requestedReviewReasons,
            "cancellation_review_requested",
          ]),
        );
        const [updatedBooking] = await tx
          .update(partnerBookings)
          .set({
            cancelOperationKeyHash: idempotency.keyHash,
            cancelRequestHash: requestHash,
            requestedReviewReasons: reviewReasons,
            version: row.bookingVersion + 1,
            updatedAt: now,
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
            updatedAt: partnerBookings.updatedAt,
          });
        if (!updatedBooking) throw new Error("partner_cancel_revision_race");

        const [reviewEvent] = await tx
          .insert(partnerJobEvents)
          .values({
            partnerAccountId: principal.accountId!,
            partnerBookingId: row.bookingId,
            eventType: "job.cancellation_review_requested",
            publicLabel: "Cancellation review requested",
            publicDetail: parsed.data.reason,
            effectiveAt: now,
            actorType: "partner",
            actorMembershipId: principal.membershipId,
            metadata: {
              reasonCode: cancellation.reason.code,
              deadlineAt: cancellation.deadlineAt,
              automaticFeeMinor: null,
            },
          })
          .returning({ id: partnerJobEvents.id });
        if (!reviewEvent) {
          throw new Error("partner_cancel_review_event_missing");
        }
        await tx.insert(partnerNotifications).values({
          partnerAccountId: principal.accountId!,
          membershipId: row.notificationMembershipId ?? principal.membershipId!,
          partnerBookingId: row.bookingId,
          eventKey: "job.cancellation_review_requested",
          title: "Cancellation request received",
          body: "Stonegate staff will review the request. The job remains scheduled until they respond.",
          actionPath: `/partners/bookings/${row.bookingId}`,
        });
        const auditId = randomUUID();
        await tx.insert(auditLogs).values({
          id: auditId,
          actorType: "human",
          actorId: principal.partnerUserId,
          actorLabel: principal.email,
          actorRole: principal.roleKey,
          sessionId: principal.session.id,
          authMethod: "partner_session",
          correlationId,
          requiredPermissions: ["bookings.cancel"],
          outcome: "succeeded",
          surface: "/partners/jobs",
          idempotencyKeyHash: idempotency.keyHash,
          action: "partner.booking.cancellation_review_requested",
          entityType: "partner_booking",
          entityId: row.bookingId,
          meta: sanitizeAuditMetadata({
            eventId: auditId,
            correlationId,
            partnerAccountId: principal.accountId,
            partnerMembershipId: principal.membershipId,
            before: { publicStatus: row.publicStatus },
            after: {
              publicStatus: row.publicStatus,
              version: updatedBooking.version,
              cancellationReviewPending: true,
            },
            cancellation: {
              reasonCode: cancellation.reason.code,
              deadlineAt: cancellation.deadlineAt,
              cutoffMinutes: cancellation.cutoffMinutes,
              automaticFeeMinor: null,
            },
            reason: parsed.data.reason,
          }),
        });
        await tx.insert(outboxEvents).values({
          type: "partner.cancellation_review_requested",
          payload: {
            partnerAccountId: principal.accountId,
            partnerBookingId: row.bookingId,
            appointmentId: row.appointmentId,
            partnerJobEventId: reviewEvent.id,
            sourceAuditEventId: auditId,
            correlationId,
          },
        });
        return {
          kind: "success" as const,
          replayed: false,
          outcome: "review_requested" as const,
          status: row.publicStatus,
          version: updatedBooking.version,
          updatedAt: updatedBooking.updatedAt,
        };
      }

      const directStatusIsCompatible =
        (["requested", "approval_needed", "under_review"].includes(
          row.publicStatus,
        ) &&
          row.appointmentStatus === "requested") ||
        (row.publicStatus === "confirmed" &&
          row.appointmentStatus === "confirmed");
      if (!directStatusIsCompatible) {
        return { kind: "status_conflict" as const };
      }

      const [updatedAppointment] = await tx
        .update(appointments)
        .set({ status: "canceled", updatedAt: now })
        .where(
          and(
            eq(appointments.id, row.appointmentId),
            eq(appointments.status, row.appointmentStatus),
          ),
        )
        .returning({ id: appointments.id, updatedAt: appointments.updatedAt });
      if (!updatedAppointment) return { kind: "status_conflict" as const };
      const [updatedBooking] = await tx
        .update(partnerBookings)
        .set({
          publicStatus: "canceled",
          cancelOperationKeyHash: idempotency.keyHash,
          cancelRequestHash: requestHash,
          canceledAt: now,
          version: row.bookingVersion + 1,
          updatedAt: now,
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
          updatedAt: partnerBookings.updatedAt,
        });
      if (!updatedBooking) throw new Error("partner_cancel_revision_race");

      await tx.insert(partnerJobEvents).values({
        partnerAccountId: principal.accountId!,
        partnerBookingId: row.bookingId,
        eventType: "job.canceled",
        publicLabel: "Canceled",
        publicDetail: parsed.data.reason,
        effectiveAt: now,
        actorType: "partner",
        actorMembershipId: principal.membershipId,
      });
      await tx.insert(partnerNotifications).values({
        partnerAccountId: principal.accountId!,
        membershipId: row.notificationMembershipId ?? principal.membershipId!,
        partnerBookingId: row.bookingId,
        eventKey: "job.canceled",
        title: "Job canceled",
        body: "The service request was canceled.",
        actionPath: `/partners/bookings/${row.bookingId}`,
      });
      const auditId = randomUUID();
      await tx.insert(auditLogs).values({
        id: auditId,
        actorType: "human",
        actorId: principal.partnerUserId,
        actorLabel: principal.email,
        actorRole: principal.roleKey,
        sessionId: principal.session.id,
        authMethod: "partner_session",
        correlationId,
        requiredPermissions: ["bookings.cancel"],
        outcome: "succeeded",
        surface: "/partners/jobs",
        idempotencyKeyHash: idempotency.keyHash,
        action: "partner.booking.canceled",
        entityType: "partner_booking",
        entityId: row.bookingId,
        meta: sanitizeAuditMetadata({
          eventId: auditId,
          correlationId,
          partnerAccountId: principal.accountId,
          partnerMembershipId: principal.membershipId,
          before: { publicStatus: row.publicStatus },
          after: { publicStatus: "canceled", version: updatedBooking.version },
          cancellation: {
            reasonCode: cancellation.reason.code,
            deadlineAt: cancellation.deadlineAt,
            cutoffMinutes: cancellation.cutoffMinutes,
            automaticFeeMinor: null,
          },
          reason: parsed.data.reason,
        }),
      });
      await tx.insert(outboxEvents).values({
        type: "estimate.status_changed",
        payload: {
          appointmentId: row.appointmentId,
          status: "canceled",
          statusChanged: true,
          customerNotificationRequested: false,
          version: updatedAppointment.updatedAt.toISOString(),
        },
      });
      if (row.calendarEventId) {
        await tx.insert(outboxEvents).values({
          type: "appointment.calendar_sync_requested",
          payload: {
            appointmentId: row.appointmentId,
            version: updatedAppointment.updatedAt.toISOString(),
            reason: "appointment.canceled",
            requestedCalendarEventId: row.calendarEventId,
            sourceAuditEventId: auditId,
            actorId: principal.partnerUserId,
            sessionId: principal.session.id,
            authMethod: "partner_session",
            correlationId,
            operationId: randomUUID(),
            requiredPermission: "bookings.cancel",
          },
        });
      }
      return {
        kind: "success" as const,
        replayed: false,
        outcome: "canceled" as const,
        status: "canceled",
        version: updatedBooking.version,
        updatedAt: updatedBooking.updatedAt,
      };
    });

    if (result.kind === "not_found") {
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
        correlationId,
      );
    }
    if (result.kind === "precondition") {
      return NextResponse.json(result.response.body, {
        status: result.response.status,
        headers: { ...result.response.headers, Vary: "Authorization" },
      });
    }
    if (result.kind === "already_canceled") {
      return createPartnerPortalV2ErrorResponse("conflict", 409, correlationId);
    }
    if (result.kind === "review_pending") {
      return createPartnerPortalV2ErrorResponse("conflict", 409, correlationId);
    }
    if (result.kind === "status_conflict") {
      return createPartnerPortalV2ErrorResponse("conflict", 409, correlationId);
    }
    const etag = createPortalV2StrongEtag(
      `${jobId}:${result.version}:${result.updatedAt.toISOString()}`,
    );
    return NextResponse.json(
      {
        ok: true,
        correlationId,
        job: {
          id: jobId,
          status: result.status,
          revision: result.version,
          updatedAt: result.updatedAt.toISOString(),
        },
        cancellation: {
          outcome: result.outcome,
          automaticFeeMinor: null,
        },
      },
      {
        headers: {
          "Cache-Control": "no-store",
          "x-correlation-id": correlationId,
          ETag: etag,
          ...(result.replayed ? { "idempotency-replayed": "true" } : {}),
          Vary: "Authorization",
        },
      },
    );
  } catch (error) {
    console.error("[partner-portal-v2] cancellation failed", {
      correlationId,
      accountId: principal.accountId,
      jobId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
