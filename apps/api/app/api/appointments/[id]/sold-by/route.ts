import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { DateTime } from "luxon";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { appointments, contacts, getDb, payoutRuns } from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import {
  getOrCreateCommissionSettings,
  recalculateAppointmentCommissionsAndRefreshDraftPayouts,
} from "@/lib/commissions";
import { requirePermission } from "@/lib/permissions";
import {
  normalizeSoldByMemberId,
  resolveSoldByBaseline,
  soldByChangeRequiresOverride,
  isValidSoldByOverrideCode,
} from "@/lib/sold-by-override";
import { isAdminRequest } from "../../../web/admin";

const UpdateSoldBySchema = z.object({
  soldByMemberId: z.string().uuid(),
  soldByOverrideCode: z.string().optional(),
});

async function ensureCompletedAppointmentPayoutIsEditable(input: {
  completedAt: Date | null;
}): Promise<boolean> {
  if (!input.completedAt) return true;

  const db = getDb();
  const settings = await getOrCreateCommissionSettings(db);
  const completedAt = DateTime.fromJSDate(input.completedAt, {
    zone: settings.timezone,
  });
  if (!completedAt.isValid) return true;

  const periodStart = completedAt.startOf("week");
  const periodEnd = periodStart.plus({ weeks: 1 });
  const [run] = await db
    .select({ status: payoutRuns.status })
    .from(payoutRuns)
    .where(
      and(
        eq(payoutRuns.periodStart, periodStart.toJSDate()),
        eq(payoutRuns.periodEnd, periodEnd.toJSDate()),
      ),
    )
    .limit(1);

  return !run || run.status === "draft";
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
  const parsed = UpdateSoldBySchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", message: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const db = getDb();
  const [existing] = await db
    .select({
      id: appointments.id,
      status: appointments.status,
      soldByMemberId: appointments.soldByMemberId,
      completedAt: appointments.completedAt,
      contactSalespersonMemberId: contacts.salespersonMemberId,
    })
    .from(appointments)
    .leftJoin(contacts, eq(appointments.contactId, contacts.id))
    .where(eq(appointments.id, appointmentId))
    .limit(1);

  if (!existing) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const nextSoldByMemberId = normalizeSoldByMemberId(parsed.data.soldByMemberId);
  if (!nextSoldByMemberId) {
    return NextResponse.json({ error: "invalid_seller" }, { status: 400 });
  }

  const baselineSoldByMemberId = resolveSoldByBaseline({
    currentSoldByMemberId: existing.soldByMemberId,
    assignedSalespersonMemberId: existing.contactSalespersonMemberId,
  });
  const previousSoldByMemberId = normalizeSoldByMemberId(existing.soldByMemberId);
  const sellerChanged = nextSoldByMemberId !== previousSoldByMemberId;
  const overrideRequired = soldByChangeRequiresOverride({
    nextSoldByMemberId,
    currentSoldByMemberId: existing.soldByMemberId,
    assignedSalespersonMemberId: existing.contactSalespersonMemberId,
  });

  if (overrideRequired) {
    if (!process.env["SOLD_BY_OVERRIDE_CODE"]?.trim()) {
      return NextResponse.json(
        { error: "sold_by_override_unconfigured" },
        { status: 500 },
      );
    }
    if (!isValidSoldByOverrideCode(parsed.data.soldByOverrideCode)) {
      return NextResponse.json(
        { error: "sold_by_override_code_required" },
        { status: 403 },
      );
    }
  }

  if (
    sellerChanged &&
    !(await ensureCompletedAppointmentPayoutIsEditable({
      completedAt: existing.completedAt ?? null,
    }))
  ) {
    return NextResponse.json(
      {
        error: "payout_period_locked",
        message:
          "That payout period is already locked or paid. Unlock payroll before changing who sold the job.",
      },
      { status: 409 },
    );
  }

  if (!sellerChanged) {
    return NextResponse.json({
      ok: true,
      appointment: {
        id: existing.id,
        soldByMemberId: previousSoldByMemberId,
      },
    });
  }

  const [updated] = await db
    .update(appointments)
    .set({
      soldByMemberId: nextSoldByMemberId,
      updatedAt: new Date(),
    })
    .where(eq(appointments.id, appointmentId))
    .returning({
      id: appointments.id,
      soldByMemberId: appointments.soldByMemberId,
    });

  if (!updated) {
    return NextResponse.json({ error: "update_failed" }, { status: 500 });
  }

  await recalculateAppointmentCommissionsAndRefreshDraftPayouts(
    db,
    appointmentId,
  );

  await recordAuditEvent({
    actor: getAuditActorFromRequest(request),
    action: "appointment.sold_by.updated",
    entityType: "appointment",
    entityId: appointmentId,
    meta: {
      previousSoldByMemberId,
      nextSoldByMemberId,
      baselineSoldByMemberId,
      overrideRequired,
      appointmentStatus: existing.status ?? null,
      payoutRecalculated: true,
    },
  });

  return NextResponse.json({
    ok: true,
    appointment: {
      id: updated.id,
      soldByMemberId: updated.soldByMemberId ?? null,
    },
  });
}
