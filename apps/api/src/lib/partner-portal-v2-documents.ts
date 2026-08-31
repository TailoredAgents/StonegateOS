import { randomUUID } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import {
  auditLogs,
  getDb,
  partnerAccountLocations,
  partnerBookings,
  partnerDocumentAccessLogs,
  partnerDocuments,
} from "@/db";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import type { PartnerPrincipal } from "@/lib/partner-account-authorization";
import { createMediaReadUrl, getMediaStorageBucket } from "@/lib/media-storage";
import {
  createPartnerJobAccessCondition,
  createPartnerJobLocationJoinCondition,
} from "@/lib/partner-portal-v2-resource-authorization";

function safeText(value: string, maximum: number): string | null {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const safe = [...normalized]
    .filter((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point >= 32 && point !== 127;
    })
    .join("");
  return safe.slice(0, maximum) || null;
}

function safeFilename(value: string): string {
  const basename = value.normalize("NFKC").split(/[\\/]/u).pop() ?? "document";
  return safeText(basename, 240) ?? "document";
}

export type PartnerDocumentDownloadIntentResult =
  | {
      ok: true;
      download: {
        documentId: string;
        url: string;
        filename: string;
        contentType: string;
        byteSize: number;
        expiresAt: string;
      };
    }
  | {
      ok: false;
      error: "not_found" | "service_unavailable";
      status: 404 | 503;
    };

export async function createPartnerDocumentDownloadIntent(input: {
  accountId: string;
  documentId: string;
  membershipId: string;
  partnerUserId: string;
  email: string;
  roleKey: string;
  accessLevel: PartnerPrincipal["accessLevel"];
  accessScope: PartnerPrincipal["accessScope"];
  sessionId: string;
  correlationId: string;
}): Promise<PartnerDocumentDownloadIntentResult> {
  const [document] = await getDb()
    .select({
      id: partnerDocuments.id,
      filename: partnerDocuments.filename,
      contentType: partnerDocuments.contentType,
      byteSize: partnerDocuments.byteSize,
      storageBucket: partnerDocuments.storageBucket,
      storageObjectKey: partnerDocuments.storageObjectKey,
    })
    .from(partnerDocuments)
    .leftJoin(
      partnerBookings,
      and(
        eq(partnerDocuments.partnerBookingId, partnerBookings.id),
        eq(partnerDocuments.partnerAccountId, partnerBookings.partnerAccountId),
      ),
    )
    .leftJoin(partnerAccountLocations, createPartnerJobLocationJoinCondition())
    .where(
      and(
        eq(partnerDocuments.id, input.documentId),
        eq(partnerDocuments.partnerAccountId, input.accountId),
        input.accessLevel === "account"
          ? eq(partnerDocuments.partnerAccountId, input.accountId)
          : and(
              isNotNull(partnerDocuments.partnerBookingId),
              createPartnerJobAccessCondition({
                accountId: input.accountId,
                accessLevel: input.accessLevel,
                accessScope: input.accessScope,
              }),
            ),
      ),
    )
    .limit(1);
  if (!document) {
    return { ok: false, error: "not_found", status: 404 };
  }

  let configuredBucket: string;
  let url: string;
  const expiresAt = new Date(Date.now() + 5 * 60 * 1_000);
  try {
    configuredBucket = getMediaStorageBucket();
    if (document.storageBucket !== configuredBucket) {
      return { ok: false, error: "service_unavailable", status: 503 };
    }
    url = await createMediaReadUrl(document.storageObjectKey, 300);
  } catch {
    return { ok: false, error: "service_unavailable", status: 503 };
  }

  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.insert(partnerDocumentAccessLogs).values({
      partnerAccountId: input.accountId,
      partnerDocumentId: document.id,
      actorType: "partner",
      actorMembershipId: input.membershipId,
      action: "download_intent",
      correlationId: input.correlationId,
    });
    const auditId = randomUUID();
    await tx.insert(auditLogs).values({
      id: auditId,
      actorType: "human",
      actorId: input.partnerUserId,
      actorLabel: input.email,
      actorRole: input.roleKey,
      sessionId: input.sessionId,
      authMethod: "partner_session",
      correlationId: input.correlationId,
      requiredPermissions: ["documents.read"],
      outcome: "succeeded",
      surface: "/partners/documents",
      action: "partner.document.download_intent_created",
      entityType: "partner_document",
      entityId: document.id,
      meta: sanitizeAuditMetadata({
        eventId: auditId,
        correlationId: input.correlationId,
        partnerAccountId: input.accountId,
        partnerMembershipId: input.membershipId,
        expiresAt,
      }),
    });
  });

  return {
    ok: true,
    download: {
      documentId: document.id,
      url,
      filename: safeFilename(document.filename),
      contentType:
        safeText(document.contentType, 100) ?? "application/octet-stream",
      byteSize: document.byteSize,
      expiresAt: expiresAt.toISOString(),
    },
  };
}
