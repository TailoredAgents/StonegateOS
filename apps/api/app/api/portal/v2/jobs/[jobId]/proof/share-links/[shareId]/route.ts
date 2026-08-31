import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import {
  auditLogs,
  getDb,
  partnerAccountLocations,
  partnerBookings,
  partnerProofPackages,
  partnerProofShareLinks,
} from "@/db";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { arePartnerPortalV2WritesEnabled } from "@/lib/partner-portal-feature-flags";
import {
  createPartnerJobAccessCondition,
  createPartnerJobLocationJoinCondition,
} from "@/lib/partner-portal-v2-resource-authorization";
import {
  isAllowedPartnerPortalMutationOrigin,
  isPortalV2Uuid,
} from "@/lib/partner-portal-v2-security";
import { readPortalV2CorrelationId } from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ jobId: string; shareId: string }> },
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (!isAllowedPartnerPortalMutationOrigin(request)) {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  const authorization = await requirePartnerCapability(
    request,
    "proof.request",
  );
  if (!authorization.ok) {
    return createPartnerPortalV2ErrorResponse(
      authorization.error,
      authorization.status,
      correlationId,
    );
  }
  const { principal } = authorization;
  const { jobId, shareId } = await context.params;
  if (
    !principal.accountId ||
    !principal.membershipId ||
    !isPortalV2Uuid(jobId) ||
    !isPortalV2Uuid(shareId)
  ) {
    return createPartnerPortalV2ErrorResponse("not_found", 404, correlationId);
  }
  if (!arePartnerPortalV2WritesEnabled(principal.accountId)) {
    return createPartnerPortalV2ErrorResponse(
      "service_unavailable",
      503,
      correlationId,
    );
  }
  try {
    const db = getDb();
    const result = await db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          id: partnerProofShareLinks.id,
          revokedAt: partnerProofShareLinks.revokedAt,
        })
        .from(partnerProofShareLinks)
        .innerJoin(
          partnerProofPackages,
          and(
            eq(partnerProofShareLinks.proofPackageId, partnerProofPackages.id),
            eq(
              partnerProofShareLinks.partnerAccountId,
              partnerProofPackages.partnerAccountId,
            ),
          ),
        )
        .innerJoin(
          partnerBookings,
          and(
            eq(
              partnerProofPackages.partnerAccountId,
              partnerBookings.partnerAccountId,
            ),
            eq(partnerProofPackages.partnerBookingId, partnerBookings.id),
          ),
        )
        .leftJoin(
          partnerAccountLocations,
          createPartnerJobLocationJoinCondition(),
        )
        .where(
          and(
            eq(partnerProofShareLinks.id, shareId),
            eq(partnerProofShareLinks.partnerAccountId, principal.accountId!),
            createPartnerJobAccessCondition(principal, jobId),
          ),
        )
        .for("update", { of: partnerProofShareLinks })
        .limit(1);
      if (!row) return null;
      const revokedAt = row.revokedAt ?? new Date();
      if (!row.revokedAt) {
        await tx
          .update(partnerProofShareLinks)
          .set({
            revokedAt,
            revokedByMembershipId: principal.membershipId,
          })
          .where(eq(partnerProofShareLinks.id, row.id));
        await tx.insert(auditLogs).values({
          actorType: "human",
          actorId: principal.partnerUserId,
          actorLabel: principal.email,
          actorRole: principal.roleKey,
          sessionId: principal.session.id,
          authMethod: "partner_session",
          correlationId,
          requiredPermissions: ["proof.request"],
          surface: "partner_portal_v2",
          action: "partner.proof_share.revoked",
          entityType: "partner_proof_share_link",
          entityId: row.id,
          meta: {
            partnerAccountId: principal.accountId,
            partnerBookingId: jobId,
          },
        });
      }
      return { id: row.id, revokedAt, replayed: Boolean(row.revokedAt) };
    });
    if (!result) {
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
        correlationId,
      );
    }
    return createPartnerPortalV2SuccessResponse(
      {
        ok: true,
        shareLink: {
          id: result.id,
          revokedAt: result.revokedAt.toISOString(),
          replayed: result.replayed,
        },
      },
      correlationId,
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
