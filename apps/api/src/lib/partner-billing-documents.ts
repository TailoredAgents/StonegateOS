import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  getDb,
  outboxEvents,
  partnerBillingDocumentOperations,
  partnerDocuments,
  partnerInvoices,
  partnerStatements,
} from "@/db";
import {
  getMediaObject,
  getMediaStorageBucket,
  putImmutableMediaObject,
  tryHeadMediaObject,
} from "@/lib/media-storage";
import type { PartnerBillingDocumentSnapshot } from "@/lib/partner-billing-document-renderer";
import type { TeamMutationTransaction } from "@/lib/team-mutation";

export function partnerBillingSnapshotHash(snapshot: unknown): string {
  // PostgreSQL JSONB reorders object keys. Hash canonical JSON rather than the
  // caller's insertion order so durable operations verify after a DB round trip.
  const canonical = JSON.stringify(snapshot, (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : value,
  );
  if (canonical === undefined)
    throw new Error("partner_billing_snapshot_invalid");
  return createHash("sha256").update(canonical).digest("hex");
}

export async function queuePartnerBillingDocument(
  tx: TeamMutationTransaction,
  input: {
    accountId: string;
    bookingId: string | null;
    invoiceId: string | null;
    sourceKey: string;
    kind: "invoice" | "receipt" | "credit" | "void" | "statement" | "refund";
    snapshot: PartnerBillingDocumentSnapshot;
  },
): Promise<string> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('partner_billing_documents'), hashtext(${input.accountId}))`,
  );
  const snapshotHash = partnerBillingSnapshotHash(input.snapshot);
  const [existing] = await tx
    .select({ id: partnerBillingDocumentOperations.id })
    .from(partnerBillingDocumentOperations)
    .where(
      and(
        eq(partnerBillingDocumentOperations.partnerAccountId, input.accountId),
        eq(partnerBillingDocumentOperations.documentType, input.kind),
        eq(partnerBillingDocumentOperations.sourceKey, input.sourceKey),
        eq(partnerBillingDocumentOperations.snapshotHash, snapshotHash),
      ),
    )
    .limit(1);
  if (existing) return existing.id;
  const [operationCount] = await tx
    .select({
      maximum: sql<number>`coalesce(max(${partnerBillingDocumentOperations.version}), 0)::int`,
    })
    .from(partnerBillingDocumentOperations)
    .where(
      and(
        eq(partnerBillingDocumentOperations.partnerAccountId, input.accountId),
        eq(partnerBillingDocumentOperations.documentType, input.kind),
        input.bookingId
          ? eq(
              partnerBillingDocumentOperations.partnerBookingId,
              input.bookingId,
            )
          : isNull(partnerBillingDocumentOperations.partnerBookingId),
      ),
    );
  const [documentCount] = await tx
    .select({
      maximum: sql<number>`coalesce(max(${partnerDocuments.version}), 0)::int`,
    })
    .from(partnerDocuments)
    .where(
      and(
        eq(partnerDocuments.partnerAccountId, input.accountId),
        eq(partnerDocuments.documentType, input.kind),
        input.bookingId
          ? eq(partnerDocuments.partnerBookingId, input.bookingId)
          : isNull(partnerDocuments.partnerBookingId),
      ),
    );
  const id = randomUUID();
  await tx
    .insert(partnerBillingDocumentOperations)
    .values({
      id,
      partnerAccountId: input.accountId,
      partnerBookingId: input.bookingId,
      partnerInvoiceId: input.invoiceId,
      documentType: input.kind,
      sourceKey: input.sourceKey,
      snapshot: input.snapshot,
      snapshotHash,
      version:
        Math.max(operationCount?.maximum ?? 0, documentCount?.maximum ?? 0) + 1,
    });
  await tx
    .insert(outboxEvents)
    .values({
      type: "partner.billing.document.generate",
      payload: { operationId: id },
    });
  return id;
}

/** Provider/storage work is outside the database transaction and retries use a write-once object key. */
export async function processPartnerBillingDocumentOperation(
  operationId: string,
): Promise<void> {
  const db = getDb();
  const [operation] = await db
    .select()
    .from(partnerBillingDocumentOperations)
    .where(eq(partnerBillingDocumentOperations.id, operationId))
    .limit(1);
  if (!operation || operation.status === "ready") return;
  const { PartnerBillingDocumentSnapshotSchema, renderPartnerBillingDocument } =
    await import("@/lib/partner-billing-document-renderer");
  const snapshot = PartnerBillingDocumentSnapshotSchema.parse(
    operation.snapshot,
  );
  if (
    partnerBillingSnapshotHash(operation.snapshot) !== operation.snapshotHash
  ) {
    throw new Error("partner_billing_document_snapshot_mismatch");
  }
  const key = `partner/financial/${operation.partnerAccountId}/${operation.id}.pdf`;
  const existing = await tryHeadMediaObject(key);
  const body = existing
    ? await getMediaObject(key, 10 * 1024 * 1024)
    : await renderPartnerBillingDocument(snapshot);
  if (
    body.byteLength > 10 * 1024 * 1024 ||
    !body.subarray(0, 5).equals(Buffer.from("%PDF-"))
  ) {
    throw new Error("partner_billing_document_invalid");
  }
  if (!existing)
    await putImmutableMediaObject({
      key,
      body,
      contentType: "application/pdf",
    });
  const sha256 = createHash("sha256").update(body).digest("hex");
  const storageBucket = getMediaStorageBucket();
  await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(partnerBillingDocumentOperations)
      .where(eq(partnerBillingDocumentOperations.id, operationId))
      .for("update")
      .limit(1);
    if (!locked || locked.status === "ready") return;
    const documentId = randomUUID();
    await tx
      .insert(partnerDocuments)
      .values({
        id: documentId,
        partnerAccountId: operation.partnerAccountId,
        partnerBookingId: operation.partnerBookingId,
        documentType: operation.documentType,
        version: operation.version,
        filename: `${operation.documentType}-${snapshot.number.replace(/[^a-zA-Z0-9_-]/gu, "-").slice(0, 100)}.pdf`,
        contentType: "application/pdf",
        byteSize: body.byteLength,
        storageBucket,
        storageObjectKey: key,
        sha256,
        metadata: {
          billingOperationId: operationId,
          snapshotHash: operation.snapshotHash,
        },
        generatedAt: new Date(snapshot.issuedAt),
      });
    if (operation.documentType === "invoice" && operation.partnerInvoiceId) {
      await tx
        .update(partnerInvoices)
        .set({ documentId })
        .where(
          and(
            eq(partnerInvoices.id, operation.partnerInvoiceId),
            eq(partnerInvoices.partnerAccountId, operation.partnerAccountId),
          ),
        );
    }
    if (operation.documentType === "statement" && snapshot.statement) {
      await tx
        .insert(partnerStatements)
        .values({
          partnerAccountId: operation.partnerAccountId,
          currency: snapshot.currency,
          ...snapshot.statement,
          documentId,
          generatedAt: new Date(snapshot.issuedAt),
        })
        .onConflictDoNothing();
    }
    await tx
      .update(partnerBillingDocumentOperations)
      .set({ status: "ready", documentId, completedAt: new Date() })
      .where(eq(partnerBillingDocumentOperations.id, operationId));
    const eventType = (
      {
        invoice: "partner.invoice.issued",
        receipt: "partner.payment.settled",
        credit: "partner.invoice.credited",
        void: "partner.invoice.credited",
        refund: "partner.payment.refunded",
      } as Record<string, string>
    )[operation.documentType];
    if (eventType)
      await tx.insert(outboxEvents).values({
        type: eventType,
        payload: {
          partnerAccountId: operation.partnerAccountId,
          partnerBookingId: operation.partnerBookingId,
          invoiceId: operation.partnerInvoiceId,
          documentId,
          operationId,
          ...(operation.documentType === "receipt"
            ? { paymentId: operation.sourceKey }
            : {}),
        },
      });
  });
}
