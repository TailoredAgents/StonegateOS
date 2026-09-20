import { NextResponse, type NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb, partnerBookings } from "@/db";
import { resolvePermissionContext } from "@/lib/permissions";
import { INBOX_UUID, partnerInboxCanAct } from "@/lib/partner-request-inbox";
import { getBusinessHoursPolicy } from "@/lib/policy";
import { partnerStaffArrivalPreview } from "@/lib/partner-staff-schedule";
import { PartnerPortalSchedulingError } from "@/lib/partner-portal-v2-scheduling/errors";

const headers = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
};
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  const context = await resolvePermissionContext(request);
  if (!context.authenticated)
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401, headers },
    );
  if (!partnerInboxCanAct(context, "service"))
    return NextResponse.json(
      { ok: false, error: "forbidden" },
      { status: 403, headers },
    );
  const query = request.nextUrl.searchParams,
    { jobId } = await params;
  const accountId = query.get("accountId") ?? "",
    day = query.get("preferredDate") ?? "",
    time = query.get("startTime") ?? "";
  if (
    [...query.keys()].some(
      (key) =>
        !["accountId", "preferredDate", "startTime"].includes(key) ||
        query.getAll(key).length !== 1,
    ) ||
    !INBOX_UUID.test(accountId) ||
    !INBOX_UUID.test(jobId) ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(day) ||
    !/^\d{2}:\d{2}$/u.test(time)
  )
    return NextResponse.json(
      { ok: false, error: "invalid_fields" },
      { status: 422, headers },
    );
  try {
    const [job] = await getDb()
      .select({ id: partnerBookings.id })
      .from(partnerBookings)
      .where(
        and(
          eq(partnerBookings.id, jobId),
          eq(partnerBookings.partnerAccountId, accountId),
        ),
      )
      .limit(1);
    if (!job)
      return NextResponse.json(
        { ok: false, error: "not_found" },
        { status: 404, headers },
      );
    const policy = await getBusinessHoursPolicy();
    return NextResponse.json(
      { ok: true, ...partnerStaffArrivalPreview(day, time, policy) },
      { headers },
    );
  } catch (error) {
    if (error instanceof PartnerPortalSchedulingError)
      return NextResponse.json(
        { ok: false, error: error.code, message: error.message },
        { status: 422, headers },
      );
    const correlationId = crypto.randomUUID();
    console.error("[partner.arrival_preview] failed", {
      correlationId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { ok: false, error: "temporarily_unavailable", correlationId },
      { status: 503, headers },
    );
  }
}
