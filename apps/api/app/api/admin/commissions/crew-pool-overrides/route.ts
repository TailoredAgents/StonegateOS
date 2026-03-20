import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { commissionCrewPoolOverrideDays, getDb } from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import {
  ensureCrewPoolOverrideDayEditable,
  getOrCreateCommissionSettings,
  recalculateCrewPoolOverrideDay,
} from "@/lib/commissions";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";

const LocalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const OverrideSchema = z.object({
  localDate: LocalDateSchema,
  crewPoolRateBps: z.number().int().min(0).max(10000),
  note: z.string().trim().max(500).nullable().optional(),
});

function extractPgCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  if (
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  if (
    "cause" in error &&
    (error as { cause?: unknown }).cause &&
    typeof (error as { cause?: unknown }).cause === "object"
  ) {
    const cause = (error as { cause: { code?: unknown } }).cause;
    if (typeof cause.code === "string") return cause.code;
  }
  return null;
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "access.manage");
  if (permissionError) return permissionError;

  const db = getDb();
  try {
    const settings = await getOrCreateCommissionSettings(db);
    const rows = await db
      .select({
        id: commissionCrewPoolOverrideDays.id,
        localDate: commissionCrewPoolOverrideDays.localDate,
        timezone: commissionCrewPoolOverrideDays.timezone,
        crewPoolRateBps: commissionCrewPoolOverrideDays.crewPoolRateBps,
        note: commissionCrewPoolOverrideDays.note,
        createdAt: commissionCrewPoolOverrideDays.createdAt,
        updatedAt: commissionCrewPoolOverrideDays.updatedAt,
      })
      .from(commissionCrewPoolOverrideDays)
      .orderBy(desc(commissionCrewPoolOverrideDays.localDate));

    return NextResponse.json({
      ok: true,
      timezone: settings.timezone,
      overrides: rows.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
    });
  } catch (error) {
    const code = extractPgCode(error);
    if (code === "42P01" || code === "42703") {
      return NextResponse.json({ error: "schema_not_ready" }, { status: 503 });
    }
    throw error;
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "access.manage");
  if (permissionError) return permissionError;

  const payload = (await request.json().catch(() => null)) as unknown;
  const parsed = OverrideSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", message: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const db = getDb();
  const actor = getAuditActorFromRequest(request);
  const override = parsed.data;

  try {
    const settings = await getOrCreateCommissionSettings(db);

    try {
      await ensureCrewPoolOverrideDayEditable(db, {
        localDate: override.localDate,
      });
    } catch (error) {
      if ((error as Error).message === "payout_period_locked") {
        return NextResponse.json(
          {
            error: "payout_period_locked",
            message:
              "That payout period is already locked or paid. Unlock or create changes before finalizing payroll.",
          },
          { status: 409 },
        );
      }
      throw error;
    }

    await db
      .insert(commissionCrewPoolOverrideDays)
      .values({
        localDate: override.localDate,
        timezone: settings.timezone,
        crewPoolRateBps: override.crewPoolRateBps,
        note: override.note?.trim() || null,
        createdBy: actor.id ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: commissionCrewPoolOverrideDays.localDate,
        set: {
          timezone: settings.timezone,
          crewPoolRateBps: override.crewPoolRateBps,
          note: override.note?.trim() || null,
          updatedAt: new Date(),
        },
      });

    await recalculateCrewPoolOverrideDay(db, {
      localDate: override.localDate,
    });

    await recordAuditEvent({
      actor,
      action: "commission.crew_pool_override_day.saved",
      entityType: "commission_crew_pool_override_day",
      entityId: override.localDate,
      meta: {
        localDate: override.localDate,
        crewPoolRateBps: override.crewPoolRateBps,
        note: override.note?.trim() || null,
      },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    const code = extractPgCode(error);
    if (code === "42P01" || code === "42703") {
      return NextResponse.json({ error: "schema_not_ready" }, { status: 503 });
    }
    throw error;
  }
}

export async function DELETE(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "access.manage");
  if (permissionError) return permissionError;

  const payload = (await request.json().catch(() => null)) as unknown;
  const parsed = z
    .object({
      localDate: LocalDateSchema,
    })
    .safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", message: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const db = getDb();
  const actor = getAuditActorFromRequest(request);
  const { localDate } = parsed.data;

  try {
    try {
      await ensureCrewPoolOverrideDayEditable(db, { localDate });
    } catch (error) {
      if ((error as Error).message === "payout_period_locked") {
        return NextResponse.json(
          {
            error: "payout_period_locked",
            message:
              "That payout period is already locked or paid. Unlock or create changes before finalizing payroll.",
          },
          { status: 409 },
        );
      }
      throw error;
    }

    await db
      .delete(commissionCrewPoolOverrideDays)
      .where(eq(commissionCrewPoolOverrideDays.localDate, localDate));

    await recalculateCrewPoolOverrideDay(db, { localDate });

    await recordAuditEvent({
      actor,
      action: "commission.crew_pool_override_day.deleted",
      entityType: "commission_crew_pool_override_day",
      entityId: localDate,
      meta: { localDate },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    const code = extractPgCode(error);
    if (code === "42P01" || code === "42703") {
      return NextResponse.json({ error: "schema_not_ready" }, { status: 503 });
    }
    throw error;
  }
}
