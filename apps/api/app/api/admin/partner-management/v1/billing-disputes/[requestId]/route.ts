import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  partnerAccounts,
  partnerAccountMemberships,
  partnerBillingDisputeRequests,
  partnerInvoices,
  partnerUsers,
  teamMembers,
} from "@/db";
import {
  PARTNER_BILLING_NO_STORE_HEADERS,
  withPartnerBillingNoStore,
} from "@/lib/partner-billing-route-response";
import { requirePermission } from "@/lib/permissions";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ requestId?: string }> },
): Promise<Response> {
  const permissionError = await requirePermission(
    request,
    "partners.billing_disputes.read",
  );
  if (permissionError) return withPartnerBillingNoStore(permissionError);
  const requestId =
    (await context.params).requestId?.trim().toLowerCase() ?? "";
  if (!UUID_PATTERN.test(requestId)) {
    return NextResponse.json(
      { ok: false, error: "not_found" },
      { status: 404, headers: PARTNER_BILLING_NO_STORE_HEADERS },
    );
  }

  try {
    const [row] = await getDb()
      .select({
        id: partnerBillingDisputeRequests.id,
        partnerAccountId: partnerBillingDisputeRequests.partnerAccountId,
        accountName: partnerAccounts.name,
        partnerInvoiceId: partnerBillingDisputeRequests.partnerInvoiceId,
        relatedJobId: partnerBillingDisputeRequests.partnerBookingId,
        invoiceNumber: partnerInvoices.invoiceNumber,
        invoiceStatus: partnerInvoices.status,
        currency: partnerInvoices.currency,
        category: partnerBillingDisputeRequests.category,
        reason: partnerBillingDisputeRequests.reason,
        requestSnapshot: partnerBillingDisputeRequests.requestSnapshot,
        state: partnerBillingDisputeRequests.state,
        revision: partnerBillingDisputeRequests.revision,
        threadId: partnerBillingDisputeRequests.conversationThreadId,
        threadScope: partnerBillingDisputeRequests.threadScope,
        requesterName: partnerUsers.name,
        requesterEmail: partnerUsers.email,
        resolverName: teamMembers.name,
        resolutionReason: partnerBillingDisputeRequests.resolutionReason,
        resolutionSnapshot: partnerBillingDisputeRequests.resolutionSnapshot,
        resolvedAt: partnerBillingDisputeRequests.resolvedAt,
        createdAt: partnerBillingDisputeRequests.createdAt,
        updatedAt: partnerBillingDisputeRequests.updatedAt,
      })
      .from(partnerBillingDisputeRequests)
      .innerJoin(
        partnerAccounts,
        eq(partnerAccounts.id, partnerBillingDisputeRequests.partnerAccountId),
      )
      .innerJoin(
        partnerInvoices,
        and(
          eq(
            partnerInvoices.partnerAccountId,
            partnerBillingDisputeRequests.partnerAccountId,
          ),
          eq(
            partnerInvoices.id,
            partnerBillingDisputeRequests.partnerInvoiceId,
          ),
        ),
      )
      .innerJoin(
        partnerAccountMemberships,
        and(
          eq(
            partnerAccountMemberships.id,
            partnerBillingDisputeRequests.requestedByMembershipId,
          ),
          eq(
            partnerAccountMemberships.partnerAccountId,
            partnerBillingDisputeRequests.partnerAccountId,
          ),
        ),
      )
      .innerJoin(
        partnerUsers,
        eq(partnerUsers.id, partnerAccountMemberships.partnerUserId),
      )
      .leftJoin(
        teamMembers,
        eq(
          teamMembers.id,
          partnerBillingDisputeRequests.resolvedByTeamMemberId,
        ),
      )
      .where(eq(partnerBillingDisputeRequests.id, requestId))
      .limit(1);
    if (!row) {
      return NextResponse.json(
        { ok: false, error: "not_found" },
        { status: 404, headers: PARTNER_BILLING_NO_STORE_HEADERS },
      );
    }
    return NextResponse.json(
      {
        ok: true,
        billingDispute: {
          ...row,
          resolvedAt: row.resolvedAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          version: String(row.revision),
        },
      },
      {
        headers: {
          ...PARTNER_BILLING_NO_STORE_HEADERS,
          ETag: `"${row.revision}"`,
        },
      },
    );
  } catch (error) {
    console.error("[partner-management] billing_dispute_detail_failed", {
      requestId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      {
        ok: false,
        error: "partner_management_unavailable",
        message: "The billing request could not be loaded. Try again.",
      },
      { status: 500, headers: PARTNER_BILLING_NO_STORE_HEADERS },
    );
  }
}
