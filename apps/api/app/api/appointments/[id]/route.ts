import type { ActionPolicy, MutationResult } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { appointments, getDb, teamMembers } from "@/db";
import {
  appointmentBookingDetailsSchema,
  validateQuotedTotalForBookingDetails,
} from "@/lib/appointment-booking-details";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
  teamMutationIdempotencyReplayResponse,
} from "@/lib/team-mutation-idempotency";
import {
  beginTeamMutation,
  TeamMutationFailure,
  type TeamMutationContext,
  type TeamMutationTransaction,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";

const BOOKING_DETAILS_REQUEST_MAXIMUM_BYTES = 8_192;
const MAXIMUM_CENTS = 2_147_483_647;
const APPOINTMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const PatchSchema = z
  .object({
    quotedTotalCents: z.number().int().min(0).max(MAXIMUM_CENTS).nullable(),
    bookingDetails: appointmentBookingDetailsSchema,
  })
  .strict();

type RouteContext = { params: Promise<{ id?: string }> };
type BookingDetails = z.infer<typeof appointmentBookingDetailsSchema>;
type BookingDetailsData = {
  appointmentId: string;
  quotedTotalCents: number | null;
  bookingDetails: BookingDetails;
  changed: boolean;
  version: string;
};
type BookingDetailsFailure = Extract<MutationResult<never>, { ok: false }> & {
  current?: {
    status: string;
    version: string;
    quotedTotalCents: number | null;
  };
};

type StoredOutcome<T = unknown> = {
  result: MutationResult<T> & Record<string, unknown>;
  status: number;
};

function requireAppointmentVersion(value: string | null): string {
  if (
    value === null ||
    value === "*" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "The current appointment version is required before changing booking details.",
      {
        fieldErrors: {
          version: "Refresh the appointment and submit the details again.",
        },
      },
    );
  }
  return value;
}

function boundedRequestFailure(
  error: BoundedJsonRequestError,
): TeamMutationFailure {
  if (error.code === "body_timeout") {
    return new TeamMutationFailure("timeout", error.message, {
      status: error.status,
      retryable: true,
      fieldErrors: { request: "Retry with the same request key." },
    });
  }
  return new TeamMutationFailure("invalid", error.message, {
    status: error.status,
    fieldErrors: { request: "Send one bounded application/json object." },
  });
}

function bookingDetailsFailure(
  code: BookingDetailsFailure["code"],
  message: string,
  options: {
    retryable?: boolean;
    fieldErrors?: Record<string, string>;
    current?: BookingDetailsFailure["current"];
  } = {},
): BookingDetailsFailure {
  return {
    ok: false,
    code,
    message,
    retryable: options.retryable ?? false,
    ...(options.fieldErrors ? { fieldErrors: options.fieldErrors } : {}),
    ...(options.current ? { current: options.current } : {}),
  };
}

async function storeTerminalFailure(
  tx: TeamMutationTransaction,
  mutation: TeamMutationContext,
  claim: TeamMutationIdempotencyClaim,
  appointmentId: string,
  result: BookingDetailsFailure,
  status: number,
): Promise<StoredOutcome<never>> {
  if (!mutation.audit.insertFailure) {
    throw new TeamMutationFailure(
      "internal",
      "The financial failure audit boundary is unavailable. No changes were saved.",
      { retryable: true },
    );
  }
  await mutation.audit.insertFailure(tx, {
    outcome: result.code === "forbidden" ? "denied" : "failed",
    entityType: "appointment",
    entityId: appointmentId,
    code: result.code,
    metadata: { responseStatus: status },
  });
  await completeTeamMutationIdempotency(tx, mutation, claim, result, status);
  return { result, status };
}

function isQuoteOnlyAppointmentType(value: string | null): boolean {
  const type = (value ?? "").trim().toLowerCase();
  return type === "in_person_quote" || type === "in_person_estimate";
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function safeBookingSummary(
  value: unknown,
  quotedTotalCents: number | null,
): Record<string, unknown> {
  const parsed = appointmentBookingDetailsSchema.safeParse(value);
  if (!parsed.success) {
    return { valid: false, quotedTotalCents };
  }
  return {
    valid: true,
    serviceType: parsed.data.serviceType,
    sourceType: parsed.data.source.type,
    pricingMode: parsed.data.pricing.mode,
    quotedTotalCents,
  };
}

export async function PATCH(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  // The financial permission and kill-switch boundary deliberately runs
  // before route params, URL state, body parsing, or business-database access.
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["appointments.update", "payments.collect"],
    risk: "financial",
    requiresIdempotency: true,
    auditAction: "appointment.booking_details.updated",
  } satisfies ActionPolicy);
  if (!boundary.ok) return boundary.response;
  const mutation = boundary.mutation;

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    if (request.nextUrl.search.length > 0) {
      throw new TeamMutationFailure(
        "invalid",
        "Booking-details requests do not accept query parameters.",
      );
    }

    const { id: rawAppointmentId } = await context.params;
    const appointmentId = rawAppointmentId?.normalize("NFKC").trim() ?? "";
    if (!APPOINTMENT_ID_PATTERN.test(appointmentId)) {
      throw new TeamMutationFailure(
        "invalid",
        "Choose a valid appointment before changing booking details.",
        { fieldErrors: { appointmentId: "Select a valid appointment." } },
      );
    }
    const expectedVersion = requireAppointmentVersion(mutation.expectedVersion);

    let body: unknown;
    try {
      body = await readBoundedJsonRequest(request, {
        maximumBytes: BOOKING_DETAILS_REQUEST_MAXIMUM_BYTES,
        deadlineMs: 8_000,
      });
    } catch (error) {
      if (error instanceof BoundedJsonRequestError) {
        throw boundedRequestFailure(error);
      }
      throw error;
    }
    const parsed = PatchSchema.safeParse(body);
    if (!parsed.success) {
      throw new TeamMutationFailure(
        "invalid",
        "The booking-details request is invalid.",
        {
          fieldErrors: {
            request: "Review the booking and pricing fields, then try again.",
          },
        },
      );
    }
    const quotedTotalError = validateQuotedTotalForBookingDetails(
      parsed.data.bookingDetails,
      parsed.data.quotedTotalCents,
    );
    if (quotedTotalError) {
      throw new TeamMutationFailure(
        "invalid",
        "The selected pricing mode requires a valid exact quote.",
        { fieldErrors: { quotedTotalCents: quotedTotalError } },
      );
    }

    const database = getDb();
    db = database;
    const claimed = await claimTeamMutationIdempotency(database, mutation, {
      route: "PATCH /api/appointments/:appointmentId",
      entityType: "appointment",
      entityId: appointmentId,
      payload: parsed.data,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const outcome = await database.transaction(async (tx) => {
      const [appointment] = await tx
        .select({
          id: appointments.id,
          type: appointments.type,
          status: appointments.status,
          quotedTotalCents: appointments.quotedTotalCents,
          bookingDetails: appointments.bookingDetails,
          updatedAt: appointments.updatedAt,
        })
        .from(appointments)
        .where(eq(appointments.id, appointmentId))
        .for("update")
        .limit(1);
      if (!appointment) {
        return storeTerminalFailure(
          tx,
          mutation,
          claimed.claim,
          appointmentId,
          bookingDetailsFailure(
            "invalid",
            "The appointment no longer exists.",
            {
              fieldErrors: {
                appointmentId: "Refresh the appointment list.",
              },
            },
          ),
          404,
        );
      }

      const currentVersion = appointment.updatedAt.toISOString();
      if (currentVersion !== expectedVersion) {
        return storeTerminalFailure(
          tx,
          mutation,
          claimed.claim,
          appointmentId,
          bookingDetailsFailure(
            "conflict",
            "This appointment changed on another screen. Refresh it before editing booking details.",
            {
              fieldErrors: { version: "The submitted version is stale." },
              current: {
                status: appointment.status,
                version: currentVersion,
                quotedTotalCents: appointment.quotedTotalCents,
              },
            },
          ),
          409,
        );
      }
      if (
        isQuoteOnlyAppointmentType(appointment.type) ||
        appointment.status === "completed" ||
        appointment.status === "canceled" ||
        appointment.status === "no_show"
      ) {
        return storeTerminalFailure(
          tx,
          mutation,
          claimed.claim,
          appointmentId,
          bookingDetailsFailure(
            "conflict",
            isQuoteOnlyAppointmentType(appointment.type)
              ? "Convert this quote to a job before using the standalone booking-details editor."
              : "Completed, canceled, and no-show jobs cannot be changed through the standalone booking-details editor.",
            {
              current: {
                status: appointment.status,
                version: currentVersion,
                quotedTotalCents: appointment.quotedTotalCents,
              },
            },
          ),
          409,
        );
      }

      if (parsed.data.bookingDetails.source.type === "team_member") {
        const sourceTeamMemberId =
          parsed.data.bookingDetails.source.teamMemberId;
        const [activeSourceMember] = sourceTeamMemberId
          ? await tx
              .select({ id: teamMembers.id })
              .from(teamMembers)
              .where(
                and(
                  eq(teamMembers.id, sourceTeamMemberId),
                  eq(teamMembers.active, true),
                ),
              )
              // The selected attribution target must remain active through
              // the booking-details commit.
              .for("share")
              .limit(1)
          : [];
        if (!activeSourceMember) {
          return storeTerminalFailure(
            tx,
            mutation,
            claimed.claim,
            appointmentId,
            bookingDetailsFailure(
              "invalid",
              "The selected lead-source team member is inactive or no longer exists.",
              {
                fieldErrors: {
                  bookingDetails: "Choose an active team member as the source.",
                },
              },
            ),
            422,
          );
        }
      }

      const existingBookingDetails = appointmentBookingDetailsSchema.safeParse(
        appointment.bookingDetails,
      );
      const changed =
        appointment.quotedTotalCents !== parsed.data.quotedTotalCents ||
        !existingBookingDetails.success ||
        !sameJson(existingBookingDetails.data, parsed.data.bookingDetails);
      const committedAt = new Date();
      const appointmentVersionAt = changed
        ? new Date(
            Math.max(
              committedAt.getTime(),
              appointment.updatedAt.getTime() + 1,
            ),
          )
        : appointment.updatedAt;

      if (changed) {
        const [updated] = await tx
          .update(appointments)
          .set({
            quotedTotalCents: parsed.data.quotedTotalCents,
            bookingDetails: parsed.data.bookingDetails,
            updatedAt: appointmentVersionAt,
          })
          .where(
            and(
              eq(appointments.id, appointmentId),
              eq(appointments.updatedAt, appointment.updatedAt),
            ),
          )
          .returning({ id: appointments.id });
        if (!updated) {
          throw new TeamMutationFailure(
            "conflict",
            "The appointment changed while booking details were being saved. Retry with the latest version.",
            { retryable: true },
          );
        }
      }

      const version = appointmentVersionAt.toISOString();
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "appointment",
        entityId: appointmentId,
        before: safeBookingSummary(
          appointment.bookingDetails,
          appointment.quotedTotalCents,
        ),
        after: safeBookingSummary(
          parsed.data.bookingDetails,
          parsed.data.quotedTotalCents,
        ),
        metadata: {
          changed,
          status: appointment.status,
          previousVersion: currentVersion,
          resultingVersion: version,
        },
        committedAt,
      });
      const result = teamMutationSuccessResult<BookingDetailsData>(
        mutation,
        {
          appointmentId,
          quotedTotalCents: parsed.data.quotedTotalCents,
          bookingDetails: parsed.data.bookingDetails,
          changed,
          version,
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "appointment",
          entityId: appointmentId,
          version,
        },
      );
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        result,
        200,
      );
      return { result, status: 200 };
    });

    return teamMutationResultResponse(
      outcome.result,
      outcome.status,
      mutation.correlationId,
    );
  } catch (error) {
    if (db && claim) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch (settlementError) {
        console.error(
          "[appointment-booking-details] idempotency_settlement_failed",
          {
            operationId: mutation.operationId,
            correlationId: mutation.correlationId,
            errorName:
              settlementError instanceof Error
                ? settlementError.name
                : "UnknownError",
          },
        );
      }
    }
    return teamMutationExceptionResponse(error, mutation);
  }
}
