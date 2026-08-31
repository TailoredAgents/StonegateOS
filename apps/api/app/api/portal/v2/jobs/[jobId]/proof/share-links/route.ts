import type { NextRequest } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  auditLogs,
  getDb,
  partnerAccountLocations,
  partnerBookings,
  partnerDocuments,
  partnerProofPackages,
  partnerProofShareLinks,
} from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { arePartnerPortalV2WritesEnabled } from "@/lib/partner-portal-feature-flags";
import { resolvePublicSiteBaseUrl } from "@/lib/partner-portal-auth";
import {
  createPartnerJobAccessCondition,
  createPartnerJobLocationJoinCondition,
  hasPartnerJobAccess,
} from "@/lib/partner-portal-v2-resource-authorization";
import {
  derivePartnerProofShareToken,
  PartnerProofShareTokenConfigurationError,
} from "@/lib/partner-proof-share-tokens";
import {
  isAllowedPartnerPortalMutationOrigin,
  isPortalV2Uuid,
} from "@/lib/partner-portal-v2-security";
import {
  createPortalV2IdempotencyErrorResponse,
  readPortalV2CorrelationId,
  readPortalV2IdempotencyKey,
} from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2DescriptorResponse,
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";

const ShareSchema = z
  .object({
    proofPackageId: z.string().uuid(),
    expiresIn: z.enum(["1h", "24h", "7d", "30d"]).default("7d"),
  })
  .strict();
const DURATION_MS = {
  "1h": 60 * 60 * 1_000,
  "24h": 24 * 60 * 60 * 1_000,
  "7d": 7 * 24 * 60 * 60 * 1_000,
  "30d": 30 * 24 * 60 * 60 * 1_000,
} as const;

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ jobId: string }> },
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
  const { jobId } = await context.params;
  if (
    !principal.accountId ||
    !principal.membershipId ||
    !isPortalV2Uuid(jobId)
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
    if (!(await hasPartnerJobAccess(principal, jobId))) {
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
        correlationId,
      );
    }
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
  const idempotency = readPortalV2IdempotencyKey(request.headers);
  if (!idempotency.ok) {
    return createPartnerPortalV2DescriptorResponse(
      createPortalV2IdempotencyErrorResponse(idempotency, correlationId),
    );
  }
  if (!idempotency.keyHash) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_idempotency_key",
      400,
      correlationId,
    );
  }
  let raw: unknown;
  try {
    raw = await readBoundedJsonRequest(request, {
      maximumBytes: 2_048,
      rejectDuplicateObjectKeys: true,
    });
  } catch (error) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_body",
      error instanceof BoundedJsonRequestError ? error.status : 400,
      correlationId,
    );
  }
  const parsed = ShareSchema.safeParse(raw);
  if (!parsed.success) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_fields",
      422,
      correlationId,
    );
  }

  try {
    const derived = derivePartnerProofShareToken({
      partnerAccountId: principal.accountId,
      idempotencyKeyHash: idempotency.keyHash,
    });
    const resolvedSiteBase = resolvePublicSiteBaseUrl();
    if (!resolvedSiteBase) {
      return createPartnerPortalV2ErrorResponse(
        "service_unavailable",
        503,
        correlationId,
      );
    }
    const durationMs = DURATION_MS[parsed.data.expiresIn];
    const db = getDb();
    const result = await db.transaction(async (tx) => {
      const [proofPackage] = await tx
        .select({
          id: partnerProofPackages.id,
          pdfDocumentId: partnerProofPackages.pdfDocumentId,
          zipDocumentId: partnerProofPackages.zipDocumentId,
        })
        .from(partnerProofPackages)
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
            eq(partnerProofPackages.id, parsed.data.proofPackageId),
            createPartnerJobAccessCondition(principal, jobId),
          ),
        )
        .limit(1);
      if (!proofPackage) return { kind: "not_found" as const };
      const documentIds = [
        ...new Set(
          [proofPackage.pdfDocumentId, proofPackage.zipDocumentId].filter(
            (id): id is string => Boolean(id),
          ),
        ),
      ];
      if (documentIds.length > 0) {
        const documents = await tx
          .select({ id: partnerDocuments.id })
          .from(partnerDocuments)
          .where(
            and(
              eq(partnerDocuments.partnerAccountId, principal.accountId!),
              eq(partnerDocuments.partnerBookingId, jobId),
              inArray(partnerDocuments.id, documentIds),
            ),
          );
        if (documents.length !== documentIds.length) {
          return { kind: "not_found" as const };
        }
      }
      const [existing] = await tx
        .select()
        .from(partnerProofShareLinks)
        .where(eq(partnerProofShareLinks.tokenHash, derived.tokenHash))
        .limit(1);
      if (existing) {
        const persistedDuration =
          existing.expiresAt.getTime() - existing.createdAt.getTime();
        if (
          existing.partnerAccountId !== principal.accountId ||
          existing.proofPackageId !== proofPackage.id ||
          Math.abs(persistedDuration - durationMs) > 1_000
        ) {
          return { kind: "idempotency_conflict" as const };
        }
        return { kind: "success" as const, row: existing, replayed: true };
      }
      const now = new Date();
      const [created] = await tx
        .insert(partnerProofShareLinks)
        .values({
          partnerAccountId: principal.accountId!,
          proofPackageId: proofPackage.id,
          tokenHash: derived.tokenHash,
          expiresAt: new Date(now.getTime() + durationMs),
          createdByMembershipId: principal.membershipId!,
          createdAt: now,
        })
        .returning();
      if (!created) throw new Error("proof_share_create_failed");
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
        idempotencyKeyHash: idempotency.keyHash,
        action: "partner.proof_share.created",
        entityType: "partner_proof_share_link",
        entityId: created.id,
        meta: {
          partnerAccountId: principal.accountId,
          partnerBookingId: jobId,
          proofPackageId: proofPackage.id,
          expiresIn: parsed.data.expiresIn,
        },
      });
      return { kind: "success" as const, row: created, replayed: false };
    });
    if (result.kind === "not_found") {
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
        correlationId,
      );
    }
    if (result.kind === "idempotency_conflict") {
      return createPartnerPortalV2ErrorResponse(
        "idempotency_conflict",
        409,
        correlationId,
      );
    }
    const siteBase = resolvedSiteBase.replace(/\/$/u, "");
    return createPartnerPortalV2SuccessResponse(
      {
        ok: true,
        shareLink: {
          id: result.row.id,
          url: `${siteBase}/partners/proof/${derived.token}`,
          expiresAt: result.row.expiresAt.toISOString(),
          replayed: result.replayed,
        },
      },
      correlationId,
      result.replayed ? 200 : 201,
    );
  } catch (error) {
    if (error instanceof PartnerProofShareTokenConfigurationError) {
      return createPartnerPortalV2ErrorResponse(
        "service_unavailable",
        503,
        correlationId,
      );
    }
    console.error("[partner-portal-v2] proof share create failed", {
      correlationId,
      accountId: principal.accountId,
      jobId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
