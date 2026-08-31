import type { NextRequest } from "next/server";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import {
  getDb,
  partnerDocuments,
  partnerEvidenceRequirements,
  partnerProofPackages,
  partnerProofShareLinks,
} from "@/db";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { arePartnerPortalV2ReadsEnabled } from "@/lib/partner-portal-feature-flags";
import { hasPartnerJobAccess } from "@/lib/partner-portal-v2-resource-authorization";
import {
  listPartnerMedia,
  PartnerPortalMediaError,
} from "@/lib/partner-portal-v2-media";
import { isPortalV2Uuid } from "@/lib/partner-portal-v2-security";
import { readPortalV2CorrelationId } from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  const authorization = await requirePartnerCapability(request, "proof.read");
  if (!authorization.ok) {
    return createPartnerPortalV2ErrorResponse(
      authorization.error,
      authorization.status,
      correlationId,
    );
  }
  const { principal } = authorization;
  const { jobId } = await context.params;
  if (!principal.accountId || !isPortalV2Uuid(jobId)) {
    return createPartnerPortalV2ErrorResponse("not_found", 404, correlationId);
  }
  if (!arePartnerPortalV2ReadsEnabled(principal.accountId)) {
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
    const media = await listPartnerMedia({
      parentKind: "job",
      parentId: jobId,
      principal,
    });
    const db = getDb();
    const [requirementRows, packageRows, shareRows, documentRows] =
      await Promise.all([
        db
          .select()
          .from(partnerEvidenceRequirements)
          .where(
            and(
              eq(
                partnerEvidenceRequirements.partnerAccountId,
                principal.accountId,
              ),
              or(
                isNull(partnerEvidenceRequirements.partnerBookingId),
                eq(partnerEvidenceRequirements.partnerBookingId, jobId),
              ),
            ),
          )
          .orderBy(
            asc(partnerEvidenceRequirements.category),
            asc(partnerEvidenceRequirements.createdAt),
          ),
        db
          .select({
            id: partnerProofPackages.id,
            version: partnerProofPackages.version,
            manifestSha256: partnerProofPackages.manifestSha256,
            pdfDocumentId: partnerProofPackages.pdfDocumentId,
            zipDocumentId: partnerProofPackages.zipDocumentId,
            generatedAt: partnerProofPackages.generatedAt,
          })
          .from(partnerProofPackages)
          .where(
            and(
              eq(partnerProofPackages.partnerAccountId, principal.accountId),
              eq(partnerProofPackages.partnerBookingId, jobId),
            ),
          )
          .orderBy(asc(partnerProofPackages.version)),
        db
          .select({
            id: partnerProofShareLinks.id,
            proofPackageId: partnerProofShareLinks.proofPackageId,
            expiresAt: partnerProofShareLinks.expiresAt,
            revokedAt: partnerProofShareLinks.revokedAt,
            accessCount: partnerProofShareLinks.accessCount,
            createdAt: partnerProofShareLinks.createdAt,
          })
          .from(partnerProofShareLinks)
          .innerJoin(
            partnerProofPackages,
            eq(partnerProofShareLinks.proofPackageId, partnerProofPackages.id),
          )
          .where(
            and(
              eq(partnerProofShareLinks.partnerAccountId, principal.accountId),
              eq(partnerProofPackages.partnerAccountId, principal.accountId),
              eq(
                partnerProofShareLinks.partnerAccountId,
                partnerProofPackages.partnerAccountId,
              ),
              eq(partnerProofPackages.partnerBookingId, jobId),
            ),
          )
          .orderBy(asc(partnerProofShareLinks.createdAt)),
        db
          .select({ id: partnerDocuments.id })
          .from(partnerDocuments)
          .where(
            and(
              eq(partnerDocuments.partnerAccountId, principal.accountId),
              eq(partnerDocuments.partnerBookingId, jobId),
            ),
          ),
      ]);
    const authorizedDocumentIds = new Set(documentRows.map((row) => row.id));
    const requirementByCategory = new Map<
      string,
      (typeof requirementRows)[number]
    >();
    for (const row of requirementRows) {
      const current = requirementByCategory.get(row.category);
      if (!current || row.partnerBookingId === jobId) {
        requirementByCategory.set(row.category, row);
      }
    }
    const readyCounts = new Map<string, number>();
    for (const item of media) {
      if (item.status !== "ready") continue;
      readyCounts.set(item.category, (readyCounts.get(item.category) ?? 0) + 1);
    }
    const requirements = [...requirementByCategory.values()].map((row) => {
      const readyCount = readyCounts.get(row.category) ?? 0;
      return {
        category: row.category,
        required: row.required,
        minimumCount: row.minimumCount,
        readyCount,
        satisfied: !row.required || readyCount >= row.minimumCount,
        source: row.partnerBookingId ? "job_override" : row.source,
      };
    });
    const outstanding = requirements.filter((row) => !row.satisfied);
    return createPartnerPortalV2SuccessResponse(
      {
        ok: true,
        proof: {
          status: outstanding.length === 0 ? "complete" : "incomplete",
          requirements,
          outstanding: outstanding.map((row) => row.category),
          media,
          packages: packageRows.map((row) => ({
            id: row.id,
            version: row.version,
            checksumSha256: row.manifestSha256,
            documents: {
              pdfId:
                row.pdfDocumentId &&
                authorizedDocumentIds.has(row.pdfDocumentId)
                  ? row.pdfDocumentId
                  : null,
              originalMediaZipId:
                row.zipDocumentId &&
                authorizedDocumentIds.has(row.zipDocumentId)
                  ? row.zipDocumentId
                  : null,
            },
            generatedAt: row.generatedAt.toISOString(),
          })),
          shareLinks: shareRows.map((row) => ({
            id: row.id,
            proofPackageId: row.proofPackageId,
            expiresAt: row.expiresAt.toISOString(),
            revokedAt: row.revokedAt?.toISOString() ?? null,
            accessCount: row.accessCount,
            createdAt: row.createdAt.toISOString(),
          })),
        },
      },
      correlationId,
    );
  } catch (error) {
    if (error instanceof PartnerPortalMediaError) {
      return createPartnerPortalV2ErrorResponse(
        error.code,
        error.status,
        correlationId,
      );
    }
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
