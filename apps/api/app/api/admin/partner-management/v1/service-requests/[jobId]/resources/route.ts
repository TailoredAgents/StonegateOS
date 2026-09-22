import { NextResponse, type NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, partnerBookings, scheduleResources } from "@/db";
import { requirePermission } from "@/lib/permissions";
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ jobId: string }> },
) {
  const denied = await requirePermission(
    request,
    ["partners.accounts.read", "appointments.read"],
    { mode: "all" },
  );
  if (denied) return denied;
  const { jobId } = await context.params,
    accountId = request.nextUrl.searchParams.get("accountId");
  if (
    !z.string().uuid().safeParse(jobId).success ||
    !z.string().uuid().safeParse(accountId).success
  )
    return NextResponse.json(
      { ok: false, error: "not_found" },
      { status: 404 },
    );
  const db = getDb();
  const [parent] = await db
    .select({ id: partnerBookings.id })
    .from(partnerBookings)
    .where(
      and(
        eq(partnerBookings.id, jobId),
        eq(partnerBookings.partnerAccountId, accountId!),
      ),
    )
    .limit(1);
  if (!parent)
    return NextResponse.json(
      { ok: false, error: "not_found" },
      { status: 404 },
    );
  const resources = await db
    .select({
      id: scheduleResources.id,
      label: scheduleResources.label,
      kind: scheduleResources.kind,
    })
    .from(scheduleResources)
    .where(
      and(
        eq(scheduleResources.active, true),
        eq(scheduleResources.source, "staff"),
      ),
    )
    .orderBy(scheduleResources.kind, scheduleResources.label);
  return NextResponse.json(
    { ok: true, resources },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
