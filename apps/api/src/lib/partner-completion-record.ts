import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import {
  appointments,
  auditLogs,
  getDb,
  mediaAssets,
  outboxEvents,
  partnerAccountLocations,
  partnerBookings,
  partnerDocuments,
  partnerEvidenceRequirements,
  partnerJobEvidence,
  partnerProofPackages,
} from "@/db";
import type { TeamMutationTransaction } from "@/lib/team-mutation";
import { createPartnerJobLocationJoinCondition } from "@/lib/partner-portal-v2-resource-authorization";
import {
  getMediaObject,
  getMediaStorageBucket,
  putImmutableMediaObject,
  putImmutableMediaFile,
} from "@/lib/media-storage";
import { renderPartnerProofPackageToFile } from "@/lib/partner-proof-package-renderer";
import { readPartnerJobLocationSnapshot } from "@/lib/partner-job-location";
import { evaluatePartnerProofCompletion } from "@/lib/partner-proof-completion";
import { partnerMediaCountsAllowed } from "@/lib/partner-media-limits";

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function readCompletionSnapshot(
  tx: TeamMutationTransaction,
  accountId: string,
  jobId: string,
) {
  const [job] = await tx
    .select({
      id: partnerBookings.id,
      serviceKey: partnerBookings.serviceKey,
      tierKey: partnerBookings.tierKey,
      appointmentId: partnerBookings.appointmentId,
      scopeSnapshot: partnerBookings.scopeSnapshot,
      proofSnapshot: partnerBookings.proofRequirementsSnapshot,
      projectReference: partnerBookings.projectReference,
      arrivalStartAt: partnerBookings.arrivalWindowStartAt,
      arrivalEndAt: partnerBookings.arrivalWindowEndAt,
      siteName: partnerAccountLocations.siteName,
      city: partnerAccountLocations.city,
      state: partnerAccountLocations.state,
      timezone: partnerAccountLocations.timezone,
      completedAt: appointments.completedAt,
      status: appointments.status,
    })
    .from(partnerBookings)
    .innerJoin(appointments, eq(appointments.id, partnerBookings.appointmentId))
    .leftJoin(partnerAccountLocations, createPartnerJobLocationJoinCondition())
    .where(
      and(
        eq(partnerBookings.id, jobId),
        eq(partnerBookings.partnerAccountId, accountId),
      ),
    )
    .for("update", { of: partnerBookings })
    .limit(1);
  if (!job || job.status !== "completed" || !job.completedAt) return null;
  if (
    (await evaluatePartnerProofCompletion(tx, job.appointmentId)).kind !==
    "satisfied"
  )
    return null;
  const site = readPartnerJobLocationSnapshot(job.scopeSnapshot);
  if (site) {
    job.siteName = site.name;
    job.city = site.address.city;
    job.state = site.address.state;
    job.timezone = site.timezone;
  }
  const rows = await tx
    .select()
    .from(partnerEvidenceRequirements)
    .where(
      and(
        eq(partnerEvidenceRequirements.partnerAccountId, accountId),
        or(
          isNull(partnerEvidenceRequirements.partnerBookingId),
          eq(partnerEvidenceRequirements.partnerBookingId, jobId),
        ),
      ),
    )
    .orderBy(asc(partnerEvidenceRequirements.category));
  const evidence = await tx
    .select({
      reference: partnerJobEvidence.id,
      category: partnerJobEvidence.category,
      caption: partnerJobEvidence.caption,
      sortOrder: partnerJobEvidence.sortOrder,
      createdAt: partnerJobEvidence.createdAt,
      contentType: mediaAssets.contentType,
      filename: mediaAssets.originalFilename,
      byteSize: mediaAssets.byteSize,
      width: mediaAssets.width,
      height: mediaAssets.height,
      sha256: mediaAssets.sha256,
      storageBucket: mediaAssets.storageBucket,
      objectKey: mediaAssets.originalObjectKey,
    })
    .from(partnerJobEvidence)
    .innerJoin(mediaAssets, eq(mediaAssets.id, partnerJobEvidence.mediaAssetId))
    .where(
      and(
        eq(partnerJobEvidence.partnerAccountId, accountId),
        eq(partnerJobEvidence.partnerBookingId, jobId),
        eq(mediaAssets.partnerAccountId, accountId),
        eq(mediaAssets.status, "ready"),
        isNull(partnerJobEvidence.deletedAt),
        isNull(mediaAssets.deletedAt),
        sql`(${partnerJobEvidence.category} <> 'document' OR ${mediaAssets.sourceMetadata}->>'scanStatus' = 'clean')`,
      ),
    )
    .orderBy(
      asc(partnerJobEvidence.category),
      asc(partnerJobEvidence.sortOrder),
      asc(partnerJobEvidence.id),
    );
  const effective = new Map<
    string,
    {
      category: string;
      required: boolean;
      minimumCount: number;
      partnerBookingId: string | null;
    }
  >();
  for (const row of rows)
    if (!effective.has(row.category) || row.partnerBookingId === jobId)
      effective.set(row.category, row);
  for (const category of [
    "intake",
    "before",
    "after",
    "completion",
    "issue",
    "document",
  ]) {
    if (effective.has(category)) continue;
    const value = job.proofSnapshot?.[category];
    const minimumCount =
      value === true
        ? 1
        : value === false
          ? 0
          : typeof value === "number" &&
              Number.isSafeInteger(value) &&
              value >= 0 &&
              value <= 40
            ? value
            : null;
    if (minimumCount !== null)
      effective.set(category, {
        category,
        required: minimumCount > 0,
        minimumCount,
        partnerBookingId: jobId,
      });
  }
  const requirements = [...effective.values()].map((row) => {
    const readyCount = evidence.filter(
      (item) => item.category === row.category,
    ).length;
    return {
      category: row.category,
      required: row.required,
      minimumCount: row.minimumCount,
      readyCount,
      satisfied: !row.required || readyCount >= row.minimumCount,
    };
  });
  if (requirements.some((row) => !row.satisfied)) return null;
  if (
    !partnerMediaCountsAllowed(
      evidence.filter((row) => row.category !== "document").length,
      evidence.filter((row) => row.category === "document").length,
    ) ||
    evidence.some(
      (row) =>
        !row.sha256 ||
        !row.contentType ||
        !row.byteSize ||
        row.byteSize > 10 * 1024 * 1024,
    )
  )
    throw new Error("partner_completion_media_invalid");
  const publicJob = {
    id: job.id,
    status: "completed",
    service: { key: job.serviceKey, tierKey: job.tierKey },
    projectReference: job.projectReference,
    location: { name: job.siteName, city: job.city, state: job.state },
    promisedArrivalWindow:
      job.arrivalStartAt && job.arrivalEndAt
        ? {
            startAt: job.arrivalStartAt.toISOString(),
            endAt: job.arrivalEndAt.toISOString(),
            timezone: job.timezone ?? "America/New_York",
          }
        : null,
    completedAt: job.completedAt.toISOString(),
  };
  const proof = {
    requirements,
    evidence: evidence.map(
      ({ storageBucket: _bucket, objectKey: _key, createdAt, ...item }) => ({
        ...item,
        capturedAt: createdAt.toISOString(),
      }),
    ),
  };
  const contentChecksum = hash({ schemaVersion: 1, job: publicJob, proof });
  const [latest] = await tx
    .select()
    .from(partnerProofPackages)
    .where(
      and(
        eq(partnerProofPackages.partnerAccountId, accountId),
        eq(partnerProofPackages.partnerBookingId, jobId),
      ),
    )
    .orderBy(desc(partnerProofPackages.version))
    .limit(1);
  return { job, publicJob, proof, evidence, contentChecksum, latest };
}

/** No HTTP request or impersonated session: the committed outbox job is the worker's authority. */
export async function preparePartnerCompletionRecord(
  accountId: string,
  jobId: string,
): Promise<void> {
  const db = getDb();
  const snapshot = await db.transaction((tx) =>
    readCompletionSnapshot(tx, accountId, jobId),
  );
  if (
    !snapshot ||
    snapshot.latest?.manifest["contentChecksum"] === snapshot.contentChecksum
  )
    return;
  const version = (snapshot.latest?.version ?? 0) + 1;
  const generatedAt = new Date();
  const manifest = {
    schemaVersion: 1,
    job: snapshot.publicJob,
    proof: snapshot.proof,
    contentChecksum: snapshot.contentChecksum,
    generatedAt: generatedAt.toISOString(),
  };
  const manifestSha256 = hash(manifest);
  const bucket = getMediaStorageBucket();
  if (snapshot.evidence.some((row) => row.storageBucket !== bucket))
    throw new Error("partner_completion_bucket_mismatch");
  // Store only metadata; each original is released before loading the next one.
  const evidence = snapshot.evidence.map((row) => ({
    ...row,
    filename: row.filename ?? `${row.category}-file`,
    contentType: row.contentType!,
    byteSize: row.byteSize!,
    sha256: row.sha256!,
    capturedAt: row.createdAt.toISOString(),
  }));
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "stonegate-proof-"));
  try {
    const artifacts = await renderPartnerProofPackageToFile(
      {
        version,
        generatedAt: generatedAt.toISOString(),
        manifestChecksumSha256: manifestSha256,
        job: {
          status: "completed",
          serviceKey: snapshot.job.serviceKey,
          tierKey: snapshot.job.tierKey,
          projectReference: snapshot.job.projectReference,
          locationName: snapshot.job.siteName,
          city: snapshot.job.city,
          state: snapshot.job.state,
          promisedArrivalStartAt:
            snapshot.publicJob.promisedArrivalWindow?.startAt ?? null,
          promisedArrivalEndAt:
            snapshot.publicJob.promisedArrivalWindow?.endAt ?? null,
          timezone: snapshot.job.timezone ?? "America/New_York",
          completedAt: snapshot.publicJob.completedAt,
        },
        requirements: snapshot.proof.requirements,
        evidence,
      },
      join(temporaryDirectory, "originals.zip"),
      (_item, index) => {
        const row = snapshot.evidence[index]!;
        return getMediaObject(row.objectKey, row.byteSize!);
      },
    );
    const prefix = `partner-documents/proof/${accountId}/${manifestSha256}`;
    const pdfKey = `${prefix}/${artifacts.pdf.sha256}.pdf`,
      zipKey = `${prefix}/${artifacts.zip.sha256}.zip`;
    await putImmutableMediaObject({
      key: pdfKey,
      body: artifacts.pdf.body,
      contentType: "application/pdf",
    });
    await putImmutableMediaFile({
      key: zipKey,
      path: artifacts.zip.path,
      byteSize: artifacts.zip.byteSize,
      sha256: artifacts.zip.sha256,
      contentType: "application/zip",
    });
    await db.transaction(async (tx) => {
      const current = await readCompletionSnapshot(tx, accountId, jobId);
      if (
        current?.latest?.manifest["contentChecksum"] ===
        snapshot.contentChecksum
      )
        return;
      if (
        !current ||
        current.contentChecksum !== snapshot.contentChecksum ||
        (current.latest?.version ?? 0) !== version - 1
      )
        throw new Error("partner_completion_snapshot_changed");
      const documents = await tx
        .insert(partnerDocuments)
        .values([
          {
            partnerAccountId: accountId,
            partnerBookingId: jobId,
            documentType: "proof_package_pdf",
            version,
            filename: artifacts.pdf.filename,
            contentType: "application/pdf",
            byteSize: artifacts.pdf.body.length,
            storageBucket: bucket,
            storageObjectKey: pdfKey,
            sha256: artifacts.pdf.sha256,
            generatedAt,
            metadata: { immutable: true, manifestSha256 },
          },
          {
            partnerAccountId: accountId,
            partnerBookingId: jobId,
            documentType: "proof_package_original_media_zip",
            version,
            filename: artifacts.zip.filename,
            contentType: "application/zip",
            byteSize: artifacts.zip.byteSize,
            storageBucket: bucket,
            storageObjectKey: zipKey,
            sha256: artifacts.zip.sha256,
            generatedAt,
            metadata: { immutable: true, manifestSha256 },
          },
        ])
        .returning({
          id: partnerDocuments.id,
          type: partnerDocuments.documentType,
        });
      const [record] = await tx
        .insert(partnerProofPackages)
        .values({
          partnerAccountId: accountId,
          partnerBookingId: jobId,
          version,
          manifest,
          manifestSha256,
          pdfDocumentId: documents.find(
            (row) => row.type === "proof_package_pdf",
          )!.id,
          zipDocumentId: documents.find(
            (row) => row.type === "proof_package_original_media_zip",
          )!.id,
          generatedAt,
        })
        .returning({ id: partnerProofPackages.id });
      await tx.insert(auditLogs).values({
        actorType: "system",
        actorLabel: "partner-completion-worker",
        action: "partner.proof_package.created",
        entityType: "partner_proof_package",
        entityId: record!.id,
        meta: {
          partnerAccountId: accountId,
          partnerBookingId: jobId,
          version,
          manifestSha256,
        },
      });
      await tx.insert(outboxEvents).values({
        type: "partner.proof.ready",
        payload: {
          partnerAccountId: accountId,
          partnerBookingId: jobId,
          proofPackageId: record!.id,
        },
      });
    });
  } finally {
    // Only the random private directory created by this invocation is removed.
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
