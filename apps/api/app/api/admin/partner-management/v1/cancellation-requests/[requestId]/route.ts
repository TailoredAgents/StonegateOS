import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import {
  appointments,
  getDb,
  partnerAccounts,
  partnerAccountMemberships,
  partnerBookings,
  partnerCancellationRequests,
  partnerUsers,
  teamMembers,
} from "@/db";
import { requirePermission } from "@/lib/permissions";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
} as const;

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ requestId?: string }> },
): Promise<Response> {
  const permissionError = await requirePermission(
    request,
    "partners.cancellation_requests.read",
  );
  if (permissionError) return permissionError;
  const requestId =
    (await context.params).requestId?.trim().toLowerCase() ?? "";
  if (!UUID_PATTERN.test(requestId)) {
    return NextResponse.json(
      { ok: false, error: "not_found" },
      { status: 404, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const db = getDb();
    const [row] = await db
      .select({
        id: partnerCancellationRequests.id,
        partnerAccountId: partnerCancellationRequests.partnerAccountId,
        accountName: partnerAccounts.name,
        partnerBookingId: partnerCancellationRequests.partnerBookingId,
        publicStatus: partnerBookings.publicStatus,
        appointmentStatus: appointments.status,
        reason: partnerCancellationRequests.reason,
        requestSnapshot: partnerCancellationRequests.requestSnapshot,
        state: partnerCancellationRequests.state,
        revision: partnerCancellationRequests.revision,
        requesterName: partnerUsers.name,
        requesterEmail: partnerUsers.email,
        resolvedByName: teamMembers.name,
        resolutionReason: partnerCancellationRequests.resolutionReason,
        resolvedAt: partnerCancellationRequests.resolvedAt,
        createdAt: partnerCancellationRequests.createdAt,
        updatedAt: partnerCancellationRequests.updatedAt,
      })
      .from(partnerCancellationRequests)
      .innerJoin(
        partnerAccounts,
        eq(partnerAccounts.id, partnerCancellationRequests.partnerAccountId),
      )
      .innerJoin(
        partnerBookings,
        and(
          eq(
            partnerBookings.partnerAccountId,
            partnerCancellationRequests.partnerAccountId,
          ),
          eq(partnerBookings.id, partnerCancellationRequests.partnerBookingId),
        ),
      )
      .innerJoin(
        appointments,
        eq(appointments.id, partnerBookings.appointmentId),
      )
      .innerJoin(
        partnerAccountMemberships,
        and(
          eq(
            partnerAccountMemberships.id,
            partnerCancellationRequests.requestedByMembershipId,
          ),
          eq(
            partnerAccountMemberships.partnerAccountId,
            partnerCancellationRequests.partnerAccountId,
          ),
        ),
      )
      .innerJoin(
        partnerUsers,
        eq(partnerUsers.id, partnerAccountMemberships.partnerUserId),
      )
      .leftJoin(
        teamMembers,
        eq(teamMembers.id, partnerCancellationRequests.resolvedByTeamMemberId),
      )
      .where(eq(partnerCancellationRequests.id, requestId))
      .limit(1);
    if (!row) {
      return NextResponse.json(
        { ok: false, error: "not_found" },
        { status: 404, headers: NO_STORE_HEADERS },
      );
    }
    return NextResponse.json(
      {
        ok: true,
        cancellationRequest: {
          ...row,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          resolvedAt: row.resolvedAt?.toISOString() ?? null,
          version: String(row.revision),
        },
      },
      {
        headers: {
          ...NO_STORE_HEADERS,
          ETag: `"${row.revision}"`,
        },
      },
    );
  } catch (error) {
    console.error("[partner-management] cancellation_request_detail_failed", {
      requestId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      {
        ok: false,
        error: "partner_management_unavailable",
        message: "The cancellation request could not be loaded. Try again.",
      },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
