import { NextResponse, type NextRequest } from "next/server";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { getDb, partnerRescheduleRequests } from "@/db";
import { requirePermission } from "@/lib/permissions";
import {
  encodePortalV2Cursor,
  parsePortalV2Pagination,
} from "@/lib/portal-v2-contract";

export async function GET(request: NextRequest) {
  const denied = await requirePermission(request, "partners.accounts.read");
  if (denied) return denied;
  const scheduleDenied = await requirePermission(request, "appointments.read");
  if (scheduleDenied) return scheduleDenied;
  const headers = { "Cache-Control": "private, no-store" };
  const accountId = request.nextUrl.searchParams.get("accountId") ?? "";
  if (accountId && !/^[0-9a-f-]{36}$/iu.test(accountId))
    return NextResponse.json(
      { ok: false, error: "invalid_fields" },
      { status: 422, headers },
    );
  type Cursor = { accountId: string; id: string; createdAt: string };
  const page = parsePortalV2Pagination(request.nextUrl.searchParams, {
    cursorKind: "staff_reschedule_requests",
    allowedQueryKeys: new Set(["accountId"]),
    validateCursorPayload: (value: unknown): value is Cursor => {
      const cursor = value as Partial<Cursor> | null;
      return Boolean(
        cursor &&
          cursor.accountId === accountId &&
          typeof cursor.id === "string" &&
          /^[0-9a-f-]{36}$/iu.test(cursor.id) &&
          typeof cursor.createdAt === "string" &&
          Number.isFinite(Date.parse(cursor.createdAt)),
      );
    },
  });
  if (!page.ok)
    return NextResponse.json(
      { ok: false, error: "invalid_cursor" },
      { status: 422, headers },
    );
  const cursor = page.cursor?.payload;
  const rows = await getDb()
    .select({
      id: partnerRescheduleRequests.id,
      accountId: partnerRescheduleRequests.partnerAccountId,
      jobId: partnerRescheduleRequests.partnerBookingId,
      requestKind: partnerRescheduleRequests.requestKind,
      state: partnerRescheduleRequests.state,
      preferredWindows: partnerRescheduleRequests.preferredWindows,
      requestedArrivalStartAt:
        partnerRescheduleRequests.requestedArrivalStartAt,
      requestedArrivalEndAt: partnerRescheduleRequests.requestedArrivalEndAt,
      createdAt: partnerRescheduleRequests.createdAt,
      updatedAt: partnerRescheduleRequests.updatedAt,
    })
    .from(partnerRescheduleRequests)
    .where(
      and(
        eq(partnerRescheduleRequests.state, "pending"),
        accountId
          ? eq(partnerRescheduleRequests.partnerAccountId, accountId)
          : undefined,
        cursor
          ? or(
              lt(
                partnerRescheduleRequests.createdAt,
                new Date(cursor.createdAt),
              ),
              and(
                eq(
                  partnerRescheduleRequests.createdAt,
                  new Date(cursor.createdAt),
                ),
                lt(partnerRescheduleRequests.id, cursor.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(
      desc(partnerRescheduleRequests.createdAt),
      desc(partnerRescheduleRequests.id),
    )
    .limit(page.limit + 1);
  const items = rows.slice(0, page.limit);
  const last = items.at(-1);
  return NextResponse.json(
    {
      ok: true,
      requests: items,
      page: {
        nextCursor:
          rows.length > page.limit && last
            ? encodePortalV2Cursor({
                kind: "staff_reschedule_requests",
                limit: page.limit,
                payload: {
                  accountId,
                  id: last.id,
                  createdAt: last.createdAt.toISOString(),
                },
              })
            : null,
      },
    },
    { headers },
  );
}
