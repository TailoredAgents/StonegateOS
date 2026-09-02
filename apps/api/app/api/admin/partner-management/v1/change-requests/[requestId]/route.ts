import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import {
  appointments,
  getDb,
  partnerAccountMemberships,
  partnerAccounts,
  partnerBookings,
  partnerJobChangeRequests,
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
    "partners.change_requests.read",
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
    const [row] = await getDb()
      .select({
        id: partnerJobChangeRequests.id,
        partnerAccountId: partnerJobChangeRequests.partnerAccountId,
        accountName: partnerAccounts.name,
        partnerBookingId: partnerJobChangeRequests.partnerBookingId,
        publicStatus: partnerBookings.publicStatus,
        appointmentStatus: appointments.status,
        reason: partnerJobChangeRequests.reason,
        proposedChanges: partnerJobChangeRequests.proposedChanges,
        requestSnapshot: partnerJobChangeRequests.requestSnapshot,
        baseBookingRevision: partnerJobChangeRequests.baseBookingRevision,
        state: partnerJobChangeRequests.state,
        revision: partnerJobChangeRequests.revision,
        requesterName: partnerUsers.name,
        requesterEmail: partnerUsers.email,
        resolvedByName: teamMembers.name,
        resolutionReason: partnerJobChangeRequests.resolutionReason,
        resolutionSnapshot: partnerJobChangeRequests.resolutionSnapshot,
        resolvedAt: partnerJobChangeRequests.resolvedAt,
        createdAt: partnerJobChangeRequests.createdAt,
        updatedAt: partnerJobChangeRequests.updatedAt,
      })
      .from(partnerJobChangeRequests)
      .innerJoin(
        partnerAccounts,
        eq(partnerAccounts.id, partnerJobChangeRequests.partnerAccountId),
      )
      .innerJoin(
        partnerBookings,
        and(
          eq(
            partnerBookings.partnerAccountId,
            partnerJobChangeRequests.partnerAccountId,
          ),
          eq(partnerBookings.id, partnerJobChangeRequests.partnerBookingId),
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
            partnerJobChangeRequests.requestedByMembershipId,
          ),
          eq(
            partnerAccountMemberships.partnerAccountId,
            partnerJobChangeRequests.partnerAccountId,
          ),
        ),
      )
      .innerJoin(
        partnerUsers,
        eq(partnerUsers.id, partnerAccountMemberships.partnerUserId),
      )
      .leftJoin(
        teamMembers,
        eq(teamMembers.id, partnerJobChangeRequests.resolvedByTeamMemberId),
      )
      .where(eq(partnerJobChangeRequests.id, requestId))
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
        changeRequest: {
          ...row,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          resolvedAt: row.resolvedAt?.toISOString() ?? null,
          version: String(row.revision),
        },
      },
      {
        headers: { ...NO_STORE_HEADERS, ETag: `"${row.revision}"` },
      },
    );
  } catch (error) {
    console.error("[partner-management] change_request_detail_failed", {
      requestId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      {
        ok: false,
        error: "partner_management_unavailable",
        message: "The job change request could not be loaded. Try again.",
      },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
