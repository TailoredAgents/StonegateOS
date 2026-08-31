import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import {
  appointments,
  auditLogs,
  getDb,
  mediaAssets,
  partnerAccountLocations,
  partnerBookings,
  partnerEvidenceRequirements,
  partnerJobEvidence,
  partnerDocuments,
  partnerProofPackages,
} from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { arePartnerPortalV2WritesEnabled } from "@/lib/partner-portal-feature-flags";
import { runPortalV2IdempotentMutation } from "@/lib/partner-portal-v2-idempotency";
import {
  getMediaObject,
  getMediaStorageBucket,
  putImmutableMediaObject,
} from "@/lib/media-storage";
import { renderPartnerProofPackageArtifacts } from "@/lib/partner-proof-package-renderer";
import {
  createPartnerJobAccessCondition,
  createPartnerJobLocationJoinCondition,
  hasPartnerJobAccess,
} from "@/lib/partner-portal-v2-resource-authorization";
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
  createPartnerPortalV2StoredResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";

function canonical(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [
          key,
          canonical((value as Record<string, unknown>)[key]),
        ]),
    );
  }
  throw new TypeError("Proof manifest contains an unsupported value.");
}

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
  try {
    const raw = await readBoundedJsonRequest(request, {
      maximumBytes: 1_024,
      rejectDuplicateObjectKeys: true,
    });
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      Object.keys(raw).length !== 0
    ) {
      return createPartnerPortalV2ErrorResponse(
        "invalid_fields",
        422,
        correlationId,
      );
    }
  } catch (error) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_body",
      error instanceof BoundedJsonRequestError ? error.status : 400,
      correlationId,
    );
  }

  try {
    const mutation = await runPortalV2IdempotentMutation({
      principal: `${principal.partnerUserId}:${principal.accountId}`,
      action: "partner_proof_package.create",
      keyHash: idempotency.keyHash,
      scope: `${principal.accountId}:${jobId}`,
      payload: {},
      correlationId,
      execute: async () => {
        const db = getDb();
        return db.transaction(async (tx) => {
          const [job] = await tx
            .select({
              id: partnerBookings.id,
              status: partnerBookings.publicStatus,
              serviceKey: partnerBookings.serviceKey,
              tierKey: partnerBookings.tierKey,
              projectReference: partnerBookings.projectReference,
              arrivalStartAt: partnerBookings.arrivalWindowStartAt,
              arrivalEndAt: partnerBookings.arrivalWindowEndAt,
              siteName: partnerAccountLocations.siteName,
              city: partnerAccountLocations.city,
              state: partnerAccountLocations.state,
              timezone: partnerAccountLocations.timezone,
              completedAt: appointments.completedAt,
            })
            .from(partnerBookings)
            .innerJoin(
              appointments,
              eq(partnerBookings.appointmentId, appointments.id),
            )
            .leftJoin(
              partnerAccountLocations,
              createPartnerJobLocationJoinCondition(),
            )
            .where(createPartnerJobAccessCondition(principal, jobId))
            .for("update", { of: partnerBookings })
            .limit(1);
          if (!job) {
            return { status: 404, body: { ok: false, error: "not_found" } };
          }
          if (job.status !== "completed" || !job.completedAt) {
            return { status: 409, body: { ok: false, error: "conflict" } };
          }
          const [requirementRows, evidenceRows, versionRows] =
            await Promise.all([
              tx
                .select()
                .from(partnerEvidenceRequirements)
                .where(
                  and(
                    eq(
                      partnerEvidenceRequirements.partnerAccountId,
                      principal.accountId!,
                    ),
                    or(
                      isNull(partnerEvidenceRequirements.partnerBookingId),
                      eq(partnerEvidenceRequirements.partnerBookingId, jobId),
                    ),
                  ),
                )
                .orderBy(asc(partnerEvidenceRequirements.category)),
              tx
                .select({
                  id: partnerJobEvidence.id,
                  category: partnerJobEvidence.category,
                  caption: partnerJobEvidence.caption,
                  sortOrder: partnerJobEvidence.sortOrder,
                  createdAt: partnerJobEvidence.createdAt,
                  assetStatus: mediaAssets.status,
                  readyAt: mediaAssets.readyAt,
                  sha256: mediaAssets.sha256,
                  contentType: mediaAssets.contentType,
                  byteSize: mediaAssets.byteSize,
                  width: mediaAssets.width,
                  height: mediaAssets.height,
                  filename: mediaAssets.originalFilename,
                  storageBucket: mediaAssets.storageBucket,
                  originalObjectKey: mediaAssets.originalObjectKey,
                })
                .from(partnerJobEvidence)
                .innerJoin(
                  mediaAssets,
                  eq(partnerJobEvidence.mediaAssetId, mediaAssets.id),
                )
                .where(
                  and(
                    eq(
                      partnerJobEvidence.partnerAccountId,
                      principal.accountId!,
                    ),
                    eq(partnerJobEvidence.partnerBookingId, jobId),
                    isNull(partnerJobEvidence.deletedAt),
                    isNull(mediaAssets.deletedAt),
                  ),
                )
                .orderBy(
                  asc(partnerJobEvidence.category),
                  asc(partnerJobEvidence.sortOrder),
                  asc(partnerJobEvidence.id),
                ),
              tx
                .select({
                  nextVersion: sql<number>`coalesce(max(${partnerProofPackages.version}), 0)::int + 1`,
                })
                .from(partnerProofPackages)
                .where(
                  and(
                    eq(
                      partnerProofPackages.partnerAccountId,
                      principal.accountId!,
                    ),
                    eq(partnerProofPackages.partnerBookingId, jobId),
                  ),
                ),
            ]);
          const requirements = new Map<
            string,
            (typeof requirementRows)[number]
          >();
          for (const row of requirementRows) {
            const current = requirements.get(row.category);
            if (!current || row.partnerBookingId === jobId) {
              requirements.set(row.category, row);
            }
          }
          const readyEvidence = evidenceRows.filter(
            (row) =>
              row.assetStatus === "ready" &&
              row.readyAt &&
              row.sha256 &&
              row.contentType &&
              row.byteSize &&
              row.byteSize > 0,
          );
          const counts = new Map<string, number>();
          for (const row of readyEvidence) {
            counts.set(row.category, (counts.get(row.category) ?? 0) + 1);
          }
          const normalizedRequirements = [...requirements.values()].map(
            (row) => ({
              category: row.category,
              required: row.required,
              minimumCount: row.minimumCount,
              readyCount: counts.get(row.category) ?? 0,
              satisfied:
                !row.required ||
                (counts.get(row.category) ?? 0) >= row.minimumCount,
            }),
          );
          if (normalizedRequirements.some((row) => !row.satisfied)) {
            return { status: 409, body: { ok: false, error: "conflict" } };
          }
          const generatedAt = new Date();
          const manifest = canonical({
            schemaVersion: 1,
            job: {
              status: job.status,
              service: { key: job.serviceKey, tierKey: job.tierKey },
              projectReference: job.projectReference,
              location: {
                name: job.siteName,
                city: job.city,
                state: job.state,
              },
              promisedArrivalWindow:
                job.arrivalStartAt && job.arrivalEndAt
                  ? {
                    startAt: job.arrivalStartAt.toISOString(),
                    endAt: job.arrivalEndAt.toISOString(),
                    timezone: job.timezone ?? "America/New_York",
                    }
                  : null,
              completedAt: job.completedAt.toISOString(),
            },
            proof: {
              requirements: normalizedRequirements,
              evidence: readyEvidence.map((row) => ({
                reference: row.id,
                category: row.category,
                caption: row.caption,
                sortOrder: row.sortOrder,
                filename: row.filename,
                contentType: row.contentType,
                byteSize: row.byteSize,
                width: row.width,
                height: row.height,
                sha256: row.sha256,
                capturedAt: row.createdAt.toISOString(),
              })),
            },
            generatedAt: generatedAt.toISOString(),
          }) as Record<string, unknown>;
          const manifestJson = JSON.stringify(manifest);
          const manifestSha256 = createHash("sha256")
            .update(manifestJson, "utf8")
            .digest("hex");
          const version = versionRows[0]?.nextVersion ?? 1;
          const configuredBucket = getMediaStorageBucket();
          if (
            readyEvidence.some(
              (row) => row.storageBucket !== configuredBucket,
            )
          ) {
            throw new Error("proof_package_storage_bucket_mismatch");
          }
          const evidenceWithBytes = await Promise.all(
            readyEvidence.map(async (row) => ({
              reference: row.id,
              category: row.category,
              caption: row.caption,
              sortOrder: row.sortOrder,
              contentType: row.contentType!,
              filename: row.filename ?? `${row.category}-proof`,
              byteSize: row.byteSize!,
              width: row.width,
              height: row.height,
              sha256: row.sha256!,
              capturedAt: row.createdAt.toISOString(),
              originalBytes: await getMediaObject(
                row.originalObjectKey,
                row.byteSize! + 1,
              ),
            })),
          );
          const artifacts = await renderPartnerProofPackageArtifacts({
            version,
            generatedAt: generatedAt.toISOString(),
            manifestChecksumSha256: manifestSha256,
            job: {
              status: "completed",
              serviceKey: job.serviceKey,
              tierKey: job.tierKey,
              projectReference: job.projectReference,
              locationName: job.siteName,
              city: job.city,
              state: job.state,
              promisedArrivalStartAt: job.arrivalStartAt?.toISOString() ?? null,
              promisedArrivalEndAt: job.arrivalEndAt?.toISOString() ?? null,
              timezone: job.timezone ?? "America/New_York",
              completedAt: job.completedAt.toISOString(),
            },
            requirements: normalizedRequirements,
            evidence: evidenceWithBytes,
          });
          const objectPrefix = `partner-documents/proof/${manifestSha256}`;
          const pdfObjectKey = `${objectPrefix}/${artifacts.pdf.sha256}.pdf`;
          const zipObjectKey = `${objectPrefix}/${artifacts.zip.sha256}.zip`;
          await Promise.all([
            putImmutableMediaObject({
              key: pdfObjectKey,
              body: artifacts.pdf.body,
              contentType: "application/pdf",
            }),
            putImmutableMediaObject({
              key: zipObjectKey,
              body: artifacts.zip.body,
              contentType: "application/zip",
            }),
          ]);
          const documents = await tx
            .insert(partnerDocuments)
            .values([
              {
                partnerAccountId: principal.accountId!,
                partnerBookingId: jobId,
                documentType: "proof_package_pdf",
                version,
                filename: artifacts.pdf.filename,
                contentType: "application/pdf",
                byteSize: artifacts.pdf.body.byteLength,
                storageBucket: configuredBucket,
                storageObjectKey: pdfObjectKey,
                sha256: artifacts.pdf.sha256,
                metadata: {
                  immutable: true,
                  manifestSha256,
                  proofPackageVersion: version,
                },
                generatedAt,
                createdAt: generatedAt,
              },
              {
                partnerAccountId: principal.accountId!,
                partnerBookingId: jobId,
                documentType: "proof_package_original_media_zip",
                version,
                filename: artifacts.zip.filename,
                contentType: "application/zip",
                byteSize: artifacts.zip.body.byteLength,
                storageBucket: configuredBucket,
                storageObjectKey: zipObjectKey,
                sha256: artifacts.zip.sha256,
                metadata: {
                  immutable: true,
                  manifestSha256,
                  proofPackageVersion: version,
                },
                generatedAt,
                createdAt: generatedAt,
              },
            ])
            .returning({
              id: partnerDocuments.id,
              type: partnerDocuments.documentType,
            });
          const pdfDocumentId = documents.find(
            (document) => document.type === "proof_package_pdf",
          )?.id;
          const zipDocumentId = documents.find(
            (document) =>
              document.type === "proof_package_original_media_zip",
          )?.id;
          if (!pdfDocumentId || !zipDocumentId) {
            throw new Error("proof_package_documents_create_failed");
          }
          const [created] = await tx
            .insert(partnerProofPackages)
            .values({
              partnerAccountId: principal.accountId!,
              partnerBookingId: jobId,
              version,
              manifest,
              manifestSha256,
              pdfDocumentId,
              zipDocumentId,
              generatedAt,
              createdAt: generatedAt,
            })
            .returning({
              id: partnerProofPackages.id,
              version: partnerProofPackages.version,
              generatedAt: partnerProofPackages.generatedAt,
            });
          if (!created) throw new Error("proof_package_create_failed");
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
            action: "partner.proof_package.created",
            entityType: "partner_proof_package",
            entityId: created.id,
            meta: {
              partnerAccountId: principal.accountId,
              partnerBookingId: jobId,
              version: created.version,
              manifestSha256,
            },
          });
          return {
            status: 201,
            body: {
              ok: true,
              package: {
                id: created.id,
                version: created.version,
                checksumSha256: manifestSha256,
                generatedAt: created.generatedAt.toISOString(),
                documents: { pdfId: pdfDocumentId, originalMediaZipId: zipDocumentId },
              },
            },
          };
        });
      },
    });
    if (mutation.kind === "conflict") {
      return createPartnerPortalV2ErrorResponse(
        "idempotency_conflict",
        409,
        correlationId,
      );
    }
    return createPartnerPortalV2StoredResponse(mutation.result, correlationId);
  } catch (error) {
    console.error("[partner-portal-v2] proof package create failed", {
      correlationId,
      accountId: principal.accountId,
      jobId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
