import type { ActionPolicy, MutationResult } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { appointmentNotes, appointments, crmTasks, getDb } from "@/db";
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
  type TeamMutationTransaction,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";

const NOTE_REQUEST_MAXIMUM_BYTES = 4_096;
const APPOINTMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const NoteSchema = z
  .object({
    body: z.string().trim().min(1).max(2_000),
  })
  .strict();

type RouteContext = { params: Promise<{ id?: string }> };

function requireAppointmentVersion(value: string | null): string {
  if (
    value === null ||
    value === "*" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "The current appointment version is required before adding a note.",
      {
        fieldErrors: {
          version: "Refresh the appointment and submit the note again.",
        },
      },
    );
  }
  return value;
}

function boundedRequestFailure(
  error: BoundedJsonRequestError,
): TeamMutationFailure {
  return new TeamMutationFailure("invalid", error.message, {
    status: error.status,
    fieldErrors: { request: "Send one bounded application/json object." },
  });
}

function conflictResult(currentVersion: string): MutationResult<never> & {
  current: { version: string };
} {
  return {
    ok: false,
    code: "conflict",
    message:
      "This appointment changed on another screen. Refresh it before adding the note so it is attached to the latest record.",
    retryable: false,
    fieldErrors: { version: "The submitted appointment version is stale." },
    current: { version: currentVersion },
  };
}

async function lockAppointment(
  tx: TeamMutationTransaction,
  appointmentId: string,
): Promise<{ contactId: string; updatedAt: Date } | null> {
  const [appointment] = await tx
    .select({
      contactId: appointments.contactId,
      updatedAt: appointments.updatedAt,
    })
    .from(appointments)
    .where(eq(appointments.id, appointmentId))
    .for("update")
    .limit(1);
  return appointment?.contactId ? appointment : null;
}

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["appointments.update"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "appointment.note.created",
  } satisfies ActionPolicy);
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    if (request.nextUrl.search.length > 0) {
      throw new TeamMutationFailure(
        "invalid",
        "Appointment note requests do not accept query parameters.",
      );
    }

    const { id: rawAppointmentId } = await context.params;
    const appointmentId = rawAppointmentId?.normalize("NFKC").trim() ?? "";
    if (!APPOINTMENT_ID_PATTERN.test(appointmentId)) {
      throw new TeamMutationFailure(
        "invalid",
        "Choose a valid appointment before adding a note.",
        { fieldErrors: { appointmentId: "Select a valid appointment." } },
      );
    }
    const expectedVersion = requireAppointmentVersion(mutation.expectedVersion);

    let input: unknown;
    try {
      input = await readBoundedJsonRequest(request, {
        maximumBytes: NOTE_REQUEST_MAXIMUM_BYTES,
        deadlineMs: 8_000,
      });
    } catch (error) {
      if (error instanceof BoundedJsonRequestError) {
        throw boundedRequestFailure(error);
      }
      throw error;
    }
    const parsed = NoteSchema.safeParse(input);
    if (!parsed.success) {
      throw new TeamMutationFailure(
        "invalid",
        "Enter a note between 1 and 2,000 characters.",
        { fieldErrors: { body: "Enter a valid appointment note." } },
      );
    }

    const database = getDb();
    db = database;
    const claimed = await claimTeamMutationIdempotency(database, mutation, {
      route: "POST /api/appointments/:appointmentId/notes",
      entityType: "appointment",
      entityId: appointmentId,
      payload: parsed.data,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const outcome = await database.transaction(async (tx) => {
      const appointment = await lockAppointment(tx, appointmentId);
      if (!appointment) {
        throw new TeamMutationFailure(
          "invalid",
          "The appointment no longer exists.",
          { status: 404 },
        );
      }
      if (appointment.updatedAt.toISOString() !== expectedVersion) {
        const result = conflictResult(appointment.updatedAt.toISOString());
        await completeTeamMutationIdempotency(
          tx,
          mutation,
          claimed.claim,
          result,
          409,
        );
        return { kind: "conflict" as const, result };
      }

      const committedAt = new Date(
        Math.max(Date.now(), appointment.updatedAt.getTime() + 1),
      );
      const [note] = await tx
        .insert(appointmentNotes)
        .values({
          appointmentId,
          body: parsed.data.body,
          createdAt: committedAt,
        })
        .returning({
          id: appointmentNotes.id,
          appointmentId: appointmentNotes.appointmentId,
          body: appointmentNotes.body,
          createdAt: appointmentNotes.createdAt,
        });
      if (!note) {
        throw new TeamMutationFailure(
          "internal",
          "The note could not be saved. Try again.",
          { retryable: true },
        );
      }

      const [timelineNote] = await tx
        .insert(crmTasks)
        .values({
          contactId: appointment.contactId,
          title: "Note",
          status: "completed",
          notes: parsed.data.body,
          dueAt: null,
          assignedTo: null,
          createdAt: committedAt,
          updatedAt: committedAt,
        })
        .returning({ id: crmTasks.id });
      if (!timelineNote) {
        throw new TeamMutationFailure(
          "internal",
          "The note timeline entry could not be saved. Try again.",
          { retryable: true },
        );
      }

      const [updatedAppointment] = await tx
        .update(appointments)
        .set({ updatedAt: committedAt })
        .where(eq(appointments.id, appointmentId))
        .returning({ updatedAt: appointments.updatedAt });
      if (!updatedAppointment) {
        throw new TeamMutationFailure(
          "conflict",
          "The appointment changed while the note was being saved. Refresh and try again.",
          { retryable: true },
        );
      }

      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "appointment_note",
        entityId: note.id,
        before: null,
        after: {
          appointmentId,
          version: committedAt.toISOString(),
        },
        metadata: {
          appointmentId,
          timelineTaskId: timelineNote.id,
        },
        committedAt,
      });
      const data = {
        note: {
          id: note.id,
          appointmentId: note.appointmentId,
          body: note.body,
          createdAt: note.createdAt.toISOString(),
        },
        version: committedAt.toISOString(),
      };
      const result = teamMutationSuccessResult(mutation, data, {
        auditEventId: audit.auditEventId,
        committedAt: audit.committedAt,
        entityType: "appointment_note",
        entityId: note.id,
        version: committedAt.toISOString(),
      });
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        result,
        200,
      );
      return { kind: "success" as const, result };
    });

    return teamMutationResultResponse(
      outcome.result,
      outcome.kind === "success" ? 200 : 409,
      mutation.correlationId,
      { "Cache-Control": "private, no-store, max-age=0" },
    );
  } catch (error) {
    if (db && claim) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch (settlementError) {
        console.error("[appointment-note] idempotency_settlement_failed", {
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
