import { and, eq, inArray } from "drizzle-orm";
import {
  partnerAccountLocations,
  partnerAccounts,
  type DatabaseClient,
} from "@/db";
import type { PartnerPrincipal } from "@/lib/partner-account-authorization";
import {
  auditPartnerLocationPortfolio,
  getPartnerLocationArchiveImpact,
  incrementPartnerLocationDirectory,
  lockPartnerLocationDirectory,
  partnerLocationDuplicateConfidence,
} from "@/lib/partner-location-portfolio";

type Transaction = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0];
type Location = typeof partnerAccountLocations.$inferSelect;

export type PartnerLocationMergeResult =
  | Readonly<{
      kind: "success";
      row: Location;
      directoryVersion: number;
      defaultLocationId: string | null;
      duplicateConfidence: number;
    }>
  | Readonly<{
      kind:
        | "not_found"
        | "revision_mismatch"
        | "not_duplicate"
        | "references_require_resolution"
        | "invalid_state";
      current?: Location;
      impact?: Awaited<ReturnType<typeof getPartnerLocationArchiveImpact>>;
    }>;

function samePhysicalAddress(left: Location, right: Location): boolean {
  const normalize = (value: string | null) =>
    (value ?? "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "");
  return (
    normalize(left.addressLine1) === normalize(right.addressLine1) &&
    normalize(left.addressLine2) === normalize(right.addressLine2) &&
    normalize(left.city) === normalize(right.city) &&
    normalize(left.state) === normalize(right.state) &&
    normalize(left.postalCode).slice(0, 5) ===
      normalize(right.postalCode).slice(0, 5)
  );
}

function mergeConfidence(source: Location, target: Location): number {
  if (
    source.externalPropertyId &&
    target.externalPropertyId &&
    source.externalPropertyId.toLowerCase() ===
      target.externalPropertyId.toLowerCase()
  ) {
    return 100;
  }
  if (samePhysicalAddress(source, target)) return 100;
  return partnerLocationDuplicateConfidence(
    {
      addressLine1: source.addressLine1,
      addressLine2: source.addressLine2,
      city: source.city,
      state: source.state,
      postalCode: source.postalCode,
    },
    {
      addressLine1: target.addressLine1,
      addressLine2: target.addressLine2,
      city: target.city,
      state: target.state,
      postalCode: target.postalCode,
    },
  ).confidence;
}

export async function mergeDuplicatePartnerLocation(
  tx: Transaction,
  input: Readonly<{
    principal: PartnerPrincipal;
    sourceLocationId: string;
    targetLocationId: string;
    expectedVersion: number;
    reason: string;
    correlationId: string;
    idempotencyKeyHash: string;
  }>,
): Promise<PartnerLocationMergeResult> {
  if (!input.principal.accountId || !input.principal.membershipId) {
    return { kind: "not_found" };
  }
  if (input.sourceLocationId === input.targetLocationId) {
    return { kind: "invalid_state" };
  }
  const account = await lockPartnerLocationDirectory(
    tx,
    input.principal.accountId,
  );
  if (!account) return { kind: "not_found" };
  const rows = await tx
    .select()
    .from(partnerAccountLocations)
    .where(
      and(
        eq(
          partnerAccountLocations.partnerAccountId,
          input.principal.accountId,
        ),
        inArray(partnerAccountLocations.id, [
          input.sourceLocationId,
          input.targetLocationId,
        ]),
      ),
    )
    .for("update");
  const source = rows.find((row) => row.id === input.sourceLocationId);
  const target = rows.find((row) => row.id === input.targetLocationId);
  if (!source || !target) return { kind: "not_found" };
  if (source.version !== input.expectedVersion) {
    return { kind: "revision_mismatch", current: source };
  }
  if (
    !source.active ||
    source.mergedIntoLocationId ||
    !target.active ||
    target.mergedIntoLocationId
  ) {
    return { kind: "invalid_state" };
  }
  const duplicateConfidence = mergeConfidence(source, target);
  if (duplicateConfidence < 75) return { kind: "not_duplicate" };
  const impact = await getPartnerLocationArchiveImpact(tx, {
    accountId: input.principal.accountId,
    location: source,
    defaultLocationId: account.defaultLocationId,
  });
  if (
    impact.activeChildCount > 0 ||
    impact.openDraftCount > 0 ||
    impact.activeTemplateCount > 0 ||
    impact.issuedActionableQuoteV2Count > 0
  ) {
    return { kind: "references_require_resolution", impact };
  }
  const now = new Date();
  if (account.defaultLocationId === source.id) {
    await tx
      .update(partnerAccounts)
      .set({ defaultPartnerLocationId: target.id, updatedAt: now })
      .where(eq(partnerAccounts.id, input.principal.accountId));
  }
  const [merged] = await tx
    .update(partnerAccountLocations)
    .set({
      active: false,
      mergedIntoLocationId: target.id,
      mergedAt: now,
      mergedByMembershipId: input.principal.membershipId,
      mergeReason: input.reason,
      version: source.version + 1,
      updatedAt: now,
    })
    .where(
      and(
        eq(partnerAccountLocations.partnerAccountId, input.principal.accountId),
        eq(partnerAccountLocations.id, source.id),
        eq(partnerAccountLocations.version, source.version),
      ),
    )
    .returning();
  if (!merged) return { kind: "revision_mismatch", current: source };
  const updatedAccount = await incrementPartnerLocationDirectory(
    tx,
    input.principal.accountId,
    account.version,
  );
  await auditPartnerLocationPortfolio(tx, {
    principal: input.principal,
    correlationId: input.correlationId,
    action: "partner.location.merged",
    entityType: "partner_account_location",
    entityId: source.id,
    idempotencyKeyHash: input.idempotencyKeyHash,
    meta: {
      partnerAccountId: input.principal.accountId,
      targetLocationId: target.id,
      duplicateConfidence,
      reason: input.reason,
      historyRewritten: false,
      directoryVersion: updatedAccount.version,
    },
  });
  return {
    kind: "success",
    row: merged,
    directoryVersion: updatedAccount.version,
    defaultLocationId: updatedAccount.defaultLocationId,
    duplicateConfidence,
  };
}

export async function restoreMergedPartnerLocation(
  tx: Transaction,
  input: Readonly<{
    principal: PartnerPrincipal;
    locationId: string;
    expectedVersion: number;
    reason: string;
    correlationId: string;
    idempotencyKeyHash: string;
  }>,
): Promise<PartnerLocationMergeResult> {
  if (!input.principal.accountId || !input.principal.membershipId) {
    return { kind: "not_found" };
  }
  const account = await lockPartnerLocationDirectory(
    tx,
    input.principal.accountId,
  );
  if (!account) return { kind: "not_found" };
  const [source] = await tx
    .select()
    .from(partnerAccountLocations)
    .where(
      and(
        eq(partnerAccountLocations.partnerAccountId, input.principal.accountId),
        eq(partnerAccountLocations.id, input.locationId),
      ),
    )
    .for("update")
    .limit(1);
  if (!source) return { kind: "not_found" };
  if (source.version !== input.expectedVersion) {
    return { kind: "revision_mismatch", current: source };
  }
  if (source.active || !source.mergedIntoLocationId) {
    return { kind: "invalid_state" };
  }
  const [target] = await tx
    .select({ id: partnerAccountLocations.id })
    .from(partnerAccountLocations)
    .where(
      and(
        eq(partnerAccountLocations.partnerAccountId, input.principal.accountId),
        eq(partnerAccountLocations.id, source.mergedIntoLocationId),
        eq(partnerAccountLocations.active, true),
      ),
    )
    .for("update")
    .limit(1);
  if (!target) return { kind: "invalid_state" };
  const now = new Date();
  const [restored] = await tx
    .update(partnerAccountLocations)
    .set({
      active: true,
      mergedIntoLocationId: null,
      mergedAt: null,
      mergedByMembershipId: null,
      mergeReason: null,
      version: source.version + 1,
      updatedAt: now,
    })
    .where(
      and(
        eq(partnerAccountLocations.partnerAccountId, input.principal.accountId),
        eq(partnerAccountLocations.id, source.id),
        eq(partnerAccountLocations.version, source.version),
      ),
    )
    .returning();
  if (!restored) return { kind: "revision_mismatch", current: source };
  const updatedAccount = await incrementPartnerLocationDirectory(
    tx,
    input.principal.accountId,
    account.version,
  );
  await auditPartnerLocationPortfolio(tx, {
    principal: input.principal,
    correlationId: input.correlationId,
    action: "partner.location.merge_restored",
    entityType: "partner_account_location",
    entityId: source.id,
    idempotencyKeyHash: input.idempotencyKeyHash,
    meta: {
      partnerAccountId: input.principal.accountId,
      priorTargetLocationId: source.mergedIntoLocationId,
      reason: input.reason,
      directoryVersion: updatedAccount.version,
    },
  });
  return {
    kind: "success",
    row: restored,
    directoryVersion: updatedAccount.version,
    defaultLocationId: updatedAccount.defaultLocationId,
    duplicateConfidence: 0,
  };
}
