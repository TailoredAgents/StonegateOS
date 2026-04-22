import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import {
  getDb,
  appointmentCrewMembers,
  appointments,
  leads,
  outboxEvents,
} from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { resolveLockedCrewPayout } from "@/lib/locked-crew-payout";
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
  cardTipCents: z.number().int().nonnegative().optional(),
  finalTotalSameAsQuoted: z.boolean().optional(),
  crewMembers: z
    .array(
      z.object({
        memberId: z.string().uuid(),
        splitBps: z.number().int().min(0).max(10000),
      }),
    )
    .optional(),
});

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

  const db = getDb();
  const status = parsed.data.status;
  const crew = parsed.data.crew;
  const owner = parsed.data.owner;
  const marketingMemberId = parsed.data.marketingMemberId;
  const finalTotalCentsInput = parsed.data.finalTotalCents;
  const cardTipCentsInput = parsed.data.cardTipCents;
  const finalTotalSameAsQuoted = parsed.data.finalTotalSameAsQuoted === true;
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
            "No locked crew payout rule exists for that crew combination yet.",
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
      crewMembers !== undefined);

  const updated = await db.transaction(async (tx) => {
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
      return null;
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

    return row;
  });

  if (!updated) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (needsRecalc || (!isQuoteOnly && leavingCompleted)) {
    await recalculateAppointmentCommissionsAndRefreshDraftPayouts(
      db,
      appointmentId,
    );
  }

  if (updated.calendarEventId && status === "canceled") {
    await deleteCalendarEvent(updated.calendarEventId);
    await db
      .update(appointments)
      .set({ calendarEventId: null })
      .where(eq(appointments.id, updated.id));
  }

  if (updated.leadId && status === "confirmed") {
    await db
      .update(leads)
      .set({ status: "scheduled" })
      .where(eq(leads.id, updated.leadId));
  }

  await db.insert(outboxEvents).values({
    type: "estimate.status_changed",
    payload: {
      appointmentId: updated.id,
      leadId: updated.leadId,
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
        appointmentId: updated.id,
      },
    });
  }

  await recordAuditEvent({
    actor: getAuditActorFromRequest(request),
    action: "appointment.status.updated",
    entityType: "appointment",
    entityId: updated.id,
    meta: {
      status,
      leadId: updated.leadId ?? null,
      ...(finalTotalCentsToSet !== undefined
        ? { finalTotalCents: finalTotalCentsToSet }
        : {}),
      ...(cardTipCentsInput !== undefined
        ? { cardTipCents: cardTipCentsInput }
        : {}),
      ...(marketingMemberId !== undefined ? { marketingMemberId } : {}),
      ...(crewMembers !== undefined
        ? { crewMembersCount: crewMembers.length }
        : {}),
    },
  });

  return NextResponse.json({ ok: true, appointmentId: updated.id, status });
}
