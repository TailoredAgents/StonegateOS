import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { DateTime } from "luxon";
import {
  getDb,
  appointmentCrewMembers,
  appointments,
  leads,
  outboxEvents,
} from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import {
  AppointmentMediaError,
  assertAppointmentStatusTransitionAllowed,
} from "@/lib/appointment-media";
import { resolveLockedCrewPayout } from "@/lib/locked-crew-payout";
import {
  expireStalePaymentAttemptsForAppointment,
  getBlockingSquareAttempt,
  getFinalTotalPaymentLock,
  requiresSquareAttemptReconciliation,
  validateFinalTotalChange,
} from "@/lib/payment-ledger";
import { isPaymentLedgerSchemaAvailable } from "@/lib/payment-schema";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";
import { deleteCalendarEvent } from "@/lib/calendar";
import {
  getOrCreateCommissionSettings,
  recalculateAppointmentCommissionsAndRefreshDraftPayouts,
} from "@/lib/commissions";

const StatusSchema = z.object({
  status: z.enum([
    "requested",
    "confirmed",
    "completed",
    "no_show",
    "canceled",
  ]),
  crew: z.string().optional().nullable(),
  owner: z.string().optional().nullable(),
  marketingMemberId: z.string().uuid().optional().nullable(),
  finalTotalCents: z.number().int().nonnegative().optional(),
  finalTotalChangeReason: z.string().trim().min(1).max(500).optional(),
  cardTipCents: z.number().int().nonnegative().optional(),
  finalTotalSameAsQuoted: z.boolean().optional(),
  completedAt: z.string().min(1).optional(),
  crewMembers: z
    .array(
      z.object({
        memberId: z.string().uuid(),
        splitBps: z.number().int().min(0).max(10000),
      }),
    )
    .optional(),
});

function parseLocalOrIsoDateTime(value: string, timezone: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const hasTimezone = /[zZ]$/.test(trimmed) || /[+-]\d{2}:\d{2}$/.test(trimmed);
  const dt = hasTimezone
    ? DateTime.fromISO(trimmed, { setZone: true })
    : DateTime.fromISO(trimmed, { zone: timezone });
  if (!dt.isValid) return null;
  return dt.toUTC().toJSDate();
}

function isQuoteOnlyAppointmentType(
  value: string | null | undefined,
): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return (
    normalized === "in_person_quote" || normalized === "in_person_estimate"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractPgCode(error: unknown): string | null {
  const direct = isRecord(error) ? error : null;
  const directCode =
    direct && typeof direct["code"] === "string" ? direct["code"] : null;
  if (directCode) return directCode;
  const cause =
    direct && isRecord(direct["cause"]) ? direct["cause"] : null;
  const causeCode =
    cause && typeof cause["code"] === "string" ? cause["code"] : null;
  return causeCode;
}

async function getExistingCrewMembers(
  db: ReturnType<typeof getDb>,
  appointmentId: string,
): Promise<Array<{ memberId: string; splitBps: number }>> {
  return db
    .select({
      memberId: appointmentCrewMembers.memberId,
      splitBps: appointmentCrewMembers.splitBps,
    })
    .from(appointmentCrewMembers)
    .where(eq(appointmentCrewMembers.appointmentId, appointmentId));
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(
    request,
    "appointments.update",
  );
  if (permissionError) return permissionError;

  const { id: appointmentId } = await context.params;
  if (!appointmentId) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  const payload = (await request.json().catch(() => null)) as unknown;
  const parsed = StatusSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", message: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const includesPaymentFields =
    parsed.data.finalTotalCents !== undefined ||
    parsed.data.finalTotalSameAsQuoted !== undefined ||
    parsed.data.cardTipCents !== undefined;
  const db = getDb();
  const paymentLedgerAvailable =
    includesPaymentFields && (await isPaymentLedgerSchemaAvailable(db));
  if (includesPaymentFields && paymentLedgerAvailable) {
    const paymentPermissionError = await requirePermission(
      request,
      "payments.collect",
    );
    if (paymentPermissionError) return paymentPermissionError;
  }

  const actor = getAuditActorFromRequest(request);
  const actorRole = actor.role?.trim().toLowerCase() ?? null;
  const status = parsed.data.status;
  const crew = parsed.data.crew;
  const owner = parsed.data.owner;
  const marketingMemberId = parsed.data.marketingMemberId;
  const finalTotalCentsInput = parsed.data.finalTotalCents;
  const cardTipCentsInput = parsed.data.cardTipCents;
  const finalTotalSameAsQuoted = parsed.data.finalTotalSameAsQuoted === true;
  let completedAtOverride: Date | undefined;
  if (parsed.data.completedAt !== undefined) {
    if (actorRole !== "owner") {
      return NextResponse.json(
        { error: "completed_at_owner_required" },
        { status: 403 },
      );
    }
    if (status !== "completed") {
      return NextResponse.json(
        { error: "completed_at_only_for_completed_status" },
        { status: 400 },
      );
    }
    completedAtOverride =
      parseLocalOrIsoDateTime(
        parsed.data.completedAt,
        process.env["APPOINTMENT_TIMEZONE"] ?? "America/New_York",
      ) ?? undefined;
    if (!completedAtOverride) {
      return NextResponse.json(
        { error: "invalid_completed_at" },
        { status: 400 },
      );
    }
  }
  let crewMembers = parsed.data.crewMembers;
  if (crewMembers !== undefined && crewMembers.length > 0) {
    const resolvedCrewPayout = resolveLockedCrewPayout(
      crewMembers.map((entry) => entry.memberId),
    );
    if (!resolvedCrewPayout.ok) {
      return NextResponse.json(
        {
          error: "invalid_crew_combo",
          message:
            "Invalid crew payout split for that crew combination.",
        },
        { status: 400 },
      );
    }
    crewMembers = resolvedCrewPayout.splits;
  }

  const [existing] = await db
    .select({
      id: appointments.id,
      leadId: appointments.leadId,
      type: appointments.type,
      calendarEventId: appointments.calendarEventId,
      quotedTotalCents: appointments.quotedTotalCents,
      finalTotalCents: appointments.finalTotalCents,
      status: appointments.status,
    })
    .from(appointments)
    .where(eq(appointments.id, appointmentId))
    .limit(1);

  if (!existing) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const isQuoteOnly = isQuoteOnlyAppointmentType(existing.type);

  if (status === "completed") {
    const existingCrewMembers =
      crewMembers === undefined
        ? await getExistingCrewMembers(db, appointmentId)
        : [];
    const effectiveCrewMembers =
      crewMembers !== undefined ? crewMembers : existingCrewMembers;

    if (!isQuoteOnly && effectiveCrewMembers.length === 0) {
      return NextResponse.json(
        {
          error: "crew_required",
          message: "Select at least one crew member before marking complete.",
        },
        { status: 400 },
      );
    }
  }

  let finalTotalCentsToSet: number | null | undefined = undefined;
  if (status === "completed" && !isQuoteOnly) {
    if (typeof finalTotalCentsInput === "number") {
      finalTotalCentsToSet = finalTotalCentsInput;
    } else if (finalTotalSameAsQuoted) {
      finalTotalCentsToSet = existing.quotedTotalCents ?? null;
    }
  }

  if (
    paymentLedgerAvailable &&
    typeof finalTotalCentsToSet === "number"
  ) {
    if (existing.finalTotalCents !== finalTotalCentsToSet) {
      await expireStalePaymentAttemptsForAppointment(db, appointmentId);
      const blockingAttempt = await getBlockingSquareAttempt(db, appointmentId);
      if (blockingAttempt) {
        const reconciliationRequired = requiresSquareAttemptReconciliation(
          blockingAttempt.status,
        );
        return NextResponse.json(
          {
            error: reconciliationRequired
              ? "square_reconciliation_required"
              : "square_verification_in_progress",
            attemptId: blockingAttempt.id,
            message: reconciliationRequired
              ? "An unresolved Square attempt must be reviewed by an owner before changing the final total."
              : "Finish or reconcile the active Square attempt before changing the final total.",
          },
          { status: 409 },
        );
      }
    }
    const lock = await getFinalTotalPaymentLock(db, appointmentId, {
      schemaAvailable: true,
    });
    const decision = validateFinalTotalChange({
      currentFinalTotalCents: existing.finalTotalCents,
      nextFinalTotalCents: finalTotalCentsToSet,
      paidTowardJobCents: lock.paidTowardJobCents,
      hasSuccessfulPayment: lock.hasSuccessfulPayment,
      actorRole,
      changeReason: parsed.data.finalTotalChangeReason,
    });
    if (!decision.ok) {
      return NextResponse.json(
        { error: decision.code, message: decision.message },
        {
          status:
            decision.code === "owner_required_after_payment" ? 403 : 409,
        },
      );
    }
  }

  const becameCompleted =
    existing.status !== "completed" && status === "completed";
  const leavingCompleted =
    existing.status === "completed" && status !== "completed";
  const becameFinalTotalKnown =
    status === "completed" &&
    finalTotalCentsToSet !== undefined &&
    existing.finalTotalCents == null &&
    finalTotalCentsToSet != null;

  const completedAtToSet = leavingCompleted
    ? null
    : completedAtOverride !== undefined
      ? completedAtOverride
      : becameCompleted
        ? new Date()
      : undefined;

  let marketingToSet: string | null | undefined = undefined;
  if (becameCompleted && marketingMemberId === undefined) {
    try {
      const settings = await getOrCreateCommissionSettings(db);
      if (settings.marketingMemberId) {
        marketingToSet = settings.marketingMemberId;
      }
    } catch (error) {
      const code = extractPgCode(error);
      if (code !== "42P01" && code !== "42703") throw error;
    }
  }

  const needsRecalc =
    !isQuoteOnly &&
    status === "completed" &&
    (becameCompleted ||
      finalTotalCentsToSet !== undefined ||
      marketingMemberId !== undefined ||
      marketingToSet !== undefined ||
      completedAtToSet !== undefined ||
      crewMembers !== undefined);

  const updated = await db.transaction(async (tx) => {
    // Payment attempts lock the same appointment row before calculating the
    // balance. Lock and revalidate here too so completion cannot race a Square
    // launch and leave the attempt charging an obsolete total.
    const [lockedAppointment] = await tx
      .select({ finalTotalCents: appointments.finalTotalCents })
      .from(appointments)
      .where(eq(appointments.id, appointmentId))
      .limit(1)
      .for("update");
    if (!lockedAppointment) {
      return { kind: "not_found" as const };
    }
    try {
      await assertAppointmentStatusTransitionAllowed({
        appointmentId,
        nextStatus: status,
        database: tx,
      });
    } catch (error) {
      if (
        error instanceof AppointmentMediaError &&
        error.code === "quoted_scope_required"
      ) {
        return { kind: "scope_required" as const };
      }
      throw error;
    }
    const isChangingFinalTotal =
      typeof finalTotalCentsToSet === "number" &&
      lockedAppointment.finalTotalCents !== finalTotalCentsToSet;
    if (
      paymentLedgerAvailable &&
      (isChangingFinalTotal || cardTipCentsInput !== undefined)
    ) {
      await expireStalePaymentAttemptsForAppointment(tx, appointmentId);
      const blockingAttempt = await getBlockingSquareAttempt(tx, appointmentId);
      if (blockingAttempt) {
        return {
          kind: "attempt_blocked" as const,
          attemptId: blockingAttempt.id,
          attemptStatus: blockingAttempt.status,
        };
      }
      const paymentLock = await getFinalTotalPaymentLock(
        tx,
        appointmentId,
        { schemaAvailable: true },
      );
      if (cardTipCentsInput !== undefined && paymentLock.hasSuccessfulPayment) {
        return { kind: "tip_managed_by_payments" as const };
      }
      if (isChangingFinalTotal) {
        const decision = validateFinalTotalChange({
          currentFinalTotalCents: lockedAppointment.finalTotalCents,
          nextFinalTotalCents: finalTotalCentsToSet!,
          paidTowardJobCents: paymentLock.paidTowardJobCents,
          hasSuccessfulPayment: paymentLock.hasSuccessfulPayment,
          actorRole,
          changeReason: parsed.data.finalTotalChangeReason,
        });
        if (!decision.ok) {
          return { kind: "total_rejected" as const, decision };
        }
      }
    }

    const baseSet: Record<string, unknown> = {
      status,
      updatedAt: new Date(),
    };
    if (crew !== undefined) baseSet["crew"] = crew ?? null;
    if (owner !== undefined) baseSet["owner"] = owner ?? null;
    if (marketingMemberId !== undefined)
      baseSet["marketingMemberId"] = marketingMemberId ?? null;
    if (marketingToSet !== undefined)
      baseSet["marketingMemberId"] = marketingToSet;
    if (finalTotalCentsToSet !== undefined)
      baseSet["finalTotalCents"] = finalTotalCentsToSet;
    if (cardTipCentsInput !== undefined)
      baseSet["cardTipCents"] = cardTipCentsInput;
    if (completedAtToSet !== undefined)
      baseSet["completedAt"] = completedAtToSet;

    let row:
      | {
          id: string;
          leadId: string | null;
          calendarEventId: string | null;
        }
      | undefined;

    try {
      const [updatedRow] = await tx
        .update(appointments)
        .set(baseSet)
        .where(eq(appointments.id, appointmentId))
        .returning({
          id: appointments.id,
          leadId: appointments.leadId,
          calendarEventId: appointments.calendarEventId,
        });
      row = updatedRow;
    } catch (error) {
      const code = extractPgCode(error);
      if (code !== "42703") throw error;

      const fallbackSet: Record<string, unknown> = {
        status,
        updatedAt: baseSet["updatedAt"],
      };
      if (crew !== undefined) fallbackSet["crew"] = crew ?? null;
      if (owner !== undefined) fallbackSet["owner"] = owner ?? null;
      if (finalTotalCentsToSet !== undefined)
        fallbackSet["finalTotalCents"] = finalTotalCentsToSet;

      const [updatedRow] = await tx
        .update(appointments)
        .set(fallbackSet)
        .where(eq(appointments.id, appointmentId))
        .returning({
          id: appointments.id,
          leadId: appointments.leadId,
          calendarEventId: appointments.calendarEventId,
        });
      row = updatedRow;
    }

    if (!row) {
      return { kind: "not_found" as const };
    }

    if (crewMembers !== undefined) {
      await tx
        .delete(appointmentCrewMembers)
        .where(eq(appointmentCrewMembers.appointmentId, appointmentId));
      if (crewMembers.length > 0) {
        await tx.insert(appointmentCrewMembers).values(
          crewMembers.map((entry) => ({
            appointmentId,
            memberId: entry.memberId,
            splitBps: entry.splitBps,
            createdAt: new Date(),
          })),
        );
      }
    }

    return { kind: "updated" as const, row };
  });

  if (updated.kind === "not_found") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (updated.kind === "attempt_blocked") {
    const reconciliationRequired = requiresSquareAttemptReconciliation(
      updated.attemptStatus,
    );
    return NextResponse.json(
      {
        error: reconciliationRequired
          ? "square_reconciliation_required"
          : "square_verification_in_progress",
        attemptId: updated.attemptId,
        message: reconciliationRequired
          ? "An unresolved Square attempt must be reviewed by an owner before changing the final total."
          : "Finish or reconcile the active Square attempt before changing the final total.",
      },
      { status: 409 },
    );
  }
  if (updated.kind === "scope_required") {
    return NextResponse.json(
      {
        error: "quoted_scope_required",
        message:
          "Add the quoted-to-remove summary before confirming or completing this appointment.",
      },
      { status: 409 },
    );
  }
  if (updated.kind === "total_rejected") {
    return NextResponse.json(
      {
        error: updated.decision.code,
        message: updated.decision.message,
      },
      {
        status:
          updated.decision.code === "owner_required_after_payment"
            ? 403
            : 409,
      },
    );
  }
  if (updated.kind === "tip_managed_by_payments") {
    return NextResponse.json(
      {
        error: "card_tip_managed_by_payments",
        message:
          "Card tips are synchronized from verified payment records and cannot be edited during completion.",
      },
      { status: 409 },
    );
  }
  const updatedRow = updated.row;

  if (needsRecalc || (!isQuoteOnly && leavingCompleted)) {
    await recalculateAppointmentCommissionsAndRefreshDraftPayouts(
      db,
      appointmentId,
    );
  }

  if (updatedRow.calendarEventId && status === "canceled") {
    await deleteCalendarEvent(updatedRow.calendarEventId);
    await db
      .update(appointments)
      .set({ calendarEventId: null })
      .where(eq(appointments.id, updatedRow.id));
  }

  if (updatedRow.leadId && status === "confirmed") {
    await db
      .update(leads)
      .set({ status: "scheduled" })
      .where(eq(leads.id, updatedRow.leadId));
  }

  await db.insert(outboxEvents).values({
    type: "estimate.status_changed",
    payload: {
      appointmentId: updatedRow.id,
      leadId: updatedRow.leadId,
      status,
    },
  });

  if (
    (becameCompleted || becameFinalTotalKnown) &&
    finalTotalCentsToSet != null
  ) {
    await db.insert(outboxEvents).values({
      type: "review.request",
      payload: {
        appointmentId: updatedRow.id,
      },
    });
  }

  await recordAuditEvent({
    actor,
    action: "appointment.status.updated",
    entityType: "appointment",
    entityId: updatedRow.id,
    meta: {
      status,
      leadId: updatedRow.leadId ?? null,
      ...(finalTotalCentsToSet !== undefined
        ? { finalTotalCents: finalTotalCentsToSet }
        : {}),
      ...(parsed.data.finalTotalChangeReason
        ? { finalTotalChangeReason: parsed.data.finalTotalChangeReason }
        : {}),
      ...(cardTipCentsInput !== undefined
        ? { cardTipCents: cardTipCentsInput }
        : {}),
      ...(completedAtOverride !== undefined
        ? { completedAt: completedAtOverride.toISOString() }
        : {}),
      ...(marketingMemberId !== undefined ? { marketingMemberId } : {}),
      ...(crewMembers !== undefined
        ? { crewMembersCount: crewMembers.length }
        : {}),
    },
  });

  return NextResponse.json({
    ok: true,
    appointmentId: updatedRow.id,
    status,
  });
}
