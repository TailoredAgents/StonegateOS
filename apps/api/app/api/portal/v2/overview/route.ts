import {
  partnerRequestNextArrivalStartSql as nextStart,
  partnerRequestNextArrivalEndSql as nextEnd,
} from "@/lib/partner-request-schedule";
import type { NextRequest } from "next/server";
import { and, asc, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import {
  appointments,
  getDb,
  partnerAccountCostCenters,
  partnerAccountLocations,
  partnerBookingDrafts,
  partnerBookings,
  partnerInvoices,
} from "@/db";
import {
  hasPartnerCapability,
  requirePartnerCapability,
} from "@/lib/partner-account-authorization";
import { arePartnerPortalV2ReadsEnabled } from "@/lib/partner-portal-feature-flags";
import {
  createPartnerDraftAccessCondition,
  createPartnerDraftLocationJoinCondition,
  createPartnerJobAccessCondition,
  createPartnerJobLocationJoinCondition,
} from "@/lib/partner-portal-v2-resource-authorization";
import { createPartnerInvoiceAccessCondition } from "@/lib/partner-portal-v2-commercial";
import { readPortalV2CorrelationId } from "@/lib/portal-v2-contract";
import { readPartnerJobLocationSnapshot } from "@/lib/partner-job-location";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";

export async function GET(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  try {
    const access = await requirePartnerCapability(
      request,
      "portal.session.read",
    );
    if (!access.ok)
      return createPartnerPortalV2ErrorResponse(
        access.error,
        access.status,
        correlationId,
      );
    const { principal } = access;
    if (!principal.accountId)
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
        correlationId,
      );
    if (!arePartnerPortalV2ReadsEnabled(principal.accountId))
      return createPartnerPortalV2ErrorResponse(
        "service_unavailable",
        503,
        correlationId,
      );
    const db = getDb();
    const now = new Date();
    const [nextRows, draftRows, balanceRows] = await Promise.all([
      hasPartnerCapability(principal, "jobs.read")
        ? db
            .select({
              id: partnerBookings.id,
              status: partnerBookings.publicStatus,
              locationName: partnerAccountLocations.siteName,
              startAt: nextStart,
              endAt: nextEnd,
              timezone: partnerAccountLocations.timezone,
              scopeSnapshot: partnerBookings.scopeSnapshot,
            })
            .from(partnerBookings)
            .leftJoin(
              appointments,
              eq(appointments.id, partnerBookings.appointmentId),
            )
            .leftJoin(
              partnerAccountLocations,
              createPartnerJobLocationJoinCondition(),
            )
            .where(
              and(
                createPartnerJobAccessCondition(principal),
                inArray(partnerBookings.publicStatus, [
                  "confirmed",
                  "partially_scheduled",
                  "en_route",
                  "in_progress",
                  "requested",
                  "under_review",
                  "approval_needed",
                ]),
                or(
                  eq(partnerBookings.modelVersion, 2),
                  inArray(appointments.status, ["requested", "confirmed"]),
                ),
                or(
                  sql`${nextEnd} >= ${now.toISOString()}::timestamptz`,
                  inArray(partnerBookings.publicStatus, [
                    "en_route",
                    "in_progress",
                    "requested",
                    "under_review",
                    "approval_needed",
                    "partially_scheduled",
                  ]),
                ),
              ),
            )
            .orderBy(
              sql`CASE WHEN ${partnerBookings.publicStatus} IN ('en_route', 'in_progress', 'confirmed','partially_scheduled') THEN 0 ELSE 1 END`,
              asc(nextStart),
              desc(partnerBookings.createdAt),
              asc(partnerBookings.id),
            )
            .limit(1)
        : [],
      hasPartnerCapability(principal, "bookings.create")
        ? db
            .select({
              id: partnerBookingDrafts.id,
              updatedAt: partnerBookingDrafts.updatedAt,
              locationName: partnerAccountLocations.siteName,
            })
            .from(partnerBookingDrafts)
            .leftJoin(
              partnerAccountLocations,
              createPartnerDraftLocationJoinCondition(),
            )
            .where(
              and(
                createPartnerDraftAccessCondition(principal),
                eq(
                  partnerBookingDrafts.createdByMembershipId,
                  principal.membershipId!,
                ),
                inArray(partnerBookingDrafts.state, ["draft", "ready"]),
                gte(partnerBookingDrafts.expiresAt, now),
              ),
            )
            .orderBy(
              desc(partnerBookingDrafts.updatedAt),
              desc(partnerBookingDrafts.id),
            )
            .limit(1)
        : [],
      hasPartnerCapability(principal, "invoices.read")
        ? db
            .select({
              currency: partnerInvoices.currency,
              amountMinor: sql<string>`coalesce(sum(${partnerInvoices.balanceCents}), 0)`,
            })
            .from(partnerInvoices)
            .leftJoin(
              partnerBookings,
              and(
                eq(partnerBookings.id, partnerInvoices.partnerBookingId),
                eq(
                  partnerBookings.partnerAccountId,
                  partnerInvoices.partnerAccountId,
                ),
              ),
            )
            .leftJoin(
              partnerAccountLocations,
              createPartnerJobLocationJoinCondition(),
            )
            .leftJoin(
              partnerAccountCostCenters,
              and(
                eq(
                  partnerAccountCostCenters.partnerAccountId,
                  partnerInvoices.partnerAccountId,
                ),
                eq(partnerAccountCostCenters.code, partnerInvoices.costCenter),
              ),
            )
            .where(
              and(
                eq(partnerInvoices.partnerAccountId, principal.accountId),
                createPartnerInvoiceAccessCondition(principal),
                inArray(partnerInvoices.status, [
                  "issued",
                  "partially_paid",
                  "overdue",
                ]),
              ),
            )
            .groupBy(partnerInvoices.currency)
        : [],
    ]);
    const next = nextRows[0];
    const nextLocation = readPartnerJobLocationSnapshot(next?.scopeSnapshot);
    const draft = draftRows[0];
    return createPartnerPortalV2SuccessResponse(
      {
        ok: true,
        nextJob: next
          ? {
              id: next.id,
              status: next.status,
              locationName: nextLocation?.name ?? next.locationName,
              startAt: next.startAt?.toISOString() ?? null,
              endAt: next.endAt?.toISOString() ?? null,
              timezone:
                nextLocation?.timezone ?? next.timezone ?? "America/New_York",
            }
          : null,
        savedRequest: draft
          ? { ...draft, updatedAt: draft.updatedAt.toISOString() }
          : null,
        outstandingBalances: hasPartnerCapability(principal, "invoices.read")
          ? balanceRows.map((row) => ({
              currency: row.currency,
              amountMinor: Number(row.amountMinor),
              minorUnit: 2,
            }))
          : null,
      },
      correlationId,
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(
      correlationId,
      error,
      "overview.read",
    );
  }
}
