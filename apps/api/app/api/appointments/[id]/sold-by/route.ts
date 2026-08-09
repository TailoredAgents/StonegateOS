import type { ActionPolicy, MutationResult } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { appointments, getDb, teamMembers } from "@/db";
import {
  lockCompletedAppointmentPayoutPeriodInTransaction,
  recalculateAppointmentCommissionsAndRefreshDraftPayoutsInTransaction,
} from "@/lib/commissions";
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

const SOLD_BY_REQUEST_MAXIMUM_BYTES = 1_024;
const APPOINTMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const UpdateSoldBySchema = z
  .object({ soldByMemberId: z.string().uuid() })
  .strict();

type RouteContext = { params: Promise<{ id?: string }> };
type SoldByData = {
  appointmentId: string;
  appointmentStatus:
    | "requested"
    | "confirmed"
    | "completed"
    | "no_show"
    | "canceled";
  soldByMemberId: string;
  previousSoldByMemberId: string | null;
  changed: boolean;
  commissionsRefreshed: boolean;
  payoutRunIds: string[];
  version: string;
};
type SoldByFailure = Extract<MutationResult<never>, { ok: false }> & {
  current?: {
    soldByMemberId: string | null;
    status: string;
    version: string;
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
      "The current appointment version is required before changing seller attribution.",
      {
        fieldErrors: {
          version: "Refresh the appointment and submit the seller again.",
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

function soldByFailure(
  code: SoldByFailure["code"],
  message: string,
  options: {
    retryable?: boolean;
    fieldErrors?: Record<string, string>;
    current?: SoldByFailure["current"];
  } = {},
): SoldByFailure {
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
  result: SoldByFailure,
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

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  // Commission attribution is a financial mutation. Both capabilities and
  // the financial kill switch are checked before params, body, or database.
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["appointments.update", "commissions.manage"],
    risk: "financial",
    requiresIdempotency: true,
    auditAction: "appointment.sold_by.updated",
  } satisfies ActionPolicy);
  if (!boundary.ok) return boundary.response;
  const mutation = boundary.mutation;

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    if (request.nextUrl.search.length > 0) {
      throw new TeamMutationFailure(
        "invalid",
        "Seller-attribution requests do not accept query parameters.",
      );
    }

    const { id: rawAppointmentId } = await context.params;
    const appointmentId = rawAppointmentId?.normalize("NFKC").trim() ?? "";
    if (!APPOINTMENT_ID_PATTERN.test(appointmentId)) {
      throw new TeamMutationFailure(
        "invalid",
        "Choose a valid appointment before changing seller attribution.",
        { fieldErrors: { appointmentId: "Select a valid appointment." } },
      );
    }
    const expectedVersion = requireAppointmentVersion(mutation.expectedVersion);

    let body: unknown;
    try {
      body = await readBoundedJsonRequest(request, {
        maximumBytes: SOLD_BY_REQUEST_MAXIMUM_BYTES,
        deadlineMs: 8_000,
      });
    } catch (error) {
      if (error instanceof BoundedJsonRequestError) {
        throw boundedRequestFailure(error);
      }
      throw error;
    }
    const parsed = UpdateSoldBySchema.safeParse(body);
    if (!parsed.success) {
      throw new TeamMutationFailure(
        "invalid",
        "Choose one active team member as the seller.",
        {
          fieldErrors: {
            soldByMemberId: "Select one active seller from the team directory.",
          },
        },
      );
    }

    const database = getDb();
    db = database;
    const claimed = await claimTeamMutationIdempotency(database, mutation, {
      route: "POST /api/appointments/:appointmentId/sold-by",
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
          status: appointments.status,
          soldByMemberId: appointments.soldByMemberId,
          completedAt: appointments.completedAt,
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
          soldByFailure("invalid", "The appointment no longer exists.", {
            fieldErrors: { appointmentId: "Refresh the appointment list." },
          }),
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
          soldByFailure(
            "conflict",
            "This appointment changed on another screen. Refresh it before changing the seller.",
            {
              fieldErrors: { version: "The submitted version is stale." },
              current: {
                soldByMemberId: appointment.soldByMemberId,
                status: appointment.status,
                version: currentVersion,
              },
            },
          ),
          409,
        );
      }

      const [activeSeller] = await tx
        .select({ id: teamMembers.id })
        .from(teamMembers)
        .where(
          and(
            eq(teamMembers.id, parsed.data.soldByMemberId),
            eq(teamMembers.active, true),
          ),
        )
        // Prevent deactivation or deletion until the attribution commits.
        .for("share")
        .limit(1);
      if (!activeSeller) {
        return storeTerminalFailure(
          tx,
          mutation,
          claimed.claim,
          appointmentId,
          soldByFailure(
            "invalid",
            "The selected seller is inactive or no longer exists.",
            {
              fieldErrors: {
                soldByMemberId: "Choose an active team member.",
              },
            },
          ),
          422,
        );
      }

      const previousSoldByMemberId = appointment.soldByMemberId ?? null;
      const changed = previousSoldByMemberId !== activeSeller.id;
      let payoutRunIds: string[] = [];

      if (changed && appointment.status === "completed") {
        const payoutPeriod =
          await lockCompletedAppointmentPayoutPeriodInTransaction(
            tx,
            appointment.completedAt,
          );
        if (!payoutPeriod.ok) {
          const completionTimeMissing =
            payoutPeriod.reason === "completion_time_missing";
          return storeTerminalFailure(
            tx,
            mutation,
            claimed.claim,
            appointmentId,
            soldByFailure(
              "conflict",
              completionTimeMissing
                ? "This completed job has no completion timestamp. Repair the job record before changing its seller."
                : "That payout period is locked or paid. Record a later adjustment instead of rewriting seller attribution.",
              {
                ...(completionTimeMissing
                  ? {}
                  : {
                      fieldErrors: {
                        soldByMemberId:
                          "The completed job belongs to a finalized payout period.",
                      },
                    }),
                current: {
                  soldByMemberId: previousSoldByMemberId,
                  status: appointment.status,
                  version: currentVersion,
                },
              },
            ),
            409,
          );
        }
        payoutRunIds = payoutPeriod.payoutRunIds;
      }

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
            soldByMemberId: activeSeller.id,
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
            "The appointment changed while seller attribution was being saved. Retry with the latest version.",
            { retryable: true },
          );
        }

        if (appointment.status === "completed") {
          await recalculateAppointmentCommissionsAndRefreshDraftPayoutsInTransaction(
            tx,
            appointmentId,
            { payoutRunIds },
          );
        }
      }

      const version = appointmentVersionAt.toISOString();
      const commissionsRefreshed =
        changed && appointment.status === "completed";
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "appointment",
        entityId: appointmentId,
        before: {
          soldByMemberId: previousSoldByMemberId,
          version: currentVersion,
        },
        after: { soldByMemberId: activeSeller.id, version },
        metadata: {
          changed,
          appointmentStatus: appointment.status,
          commissionsRefreshed,
          payoutRunIds,
        },
        committedAt,
      });
      const result = teamMutationSuccessResult<SoldByData>(
        mutation,
        {
          appointmentId,
          appointmentStatus: appointment.status,
          soldByMemberId: activeSeller.id,
          previousSoldByMemberId,
          changed,
          commissionsRefreshed,
          payoutRunIds,
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
        console.error("[appointment-sold-by] idempotency_settlement_failed", {
          operationId: mutation.operationId,
          correlationId: mutation.correlationId,
          errorName:
            settlementError instanceof Error
              ? settlementError.name
              : "UnknownError",
        });
      }
    }
    return teamMutationExceptionResponse(error, mutation);
  }
}
