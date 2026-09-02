import { and, asc, eq, isNull, or } from "drizzle-orm";
import {
  mediaAssets,
  partnerBookings,
  partnerEvidenceRequirements,
  partnerJobEvidence,
  type DatabaseClient,
} from "@/db";
import type { TeamMutationTransaction } from "@/lib/team-mutation";

const PROOF_CATEGORIES = [
  "intake",
  "before",
  "after",
  "completion",
  "issue",
  "document",
] as const;

type ProofCategory = (typeof PROOF_CATEGORIES)[number];

export type MissingPartnerProof = {
  category: ProofCategory;
  minimumCount: number;
  availableCount: number;
};

export type PartnerProofCompletionDecision =
  | { kind: "not_partner_job" }
  | { kind: "invalid_binding" }
  | {
      kind: "satisfied";
      partnerAccountId: string;
      partnerBookingId: string;
    }
  | {
      kind: "missing";
      partnerAccountId: string;
      partnerBookingId: string;
      missing: MissingPartnerProof[];
    };

type ProofExecutor = Pick<DatabaseClient, "select" | "insert" | "update">;

function snapshotMinimum(
  snapshot: Record<string, unknown> | null,
  category: ProofCategory,
): number | null {
  const value = snapshot?.[category];
  if (value === true) return 1;
  if (value === false) return 0;
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 40
    ? value
    : null;
}

/**
 * Resolves job overrides over account defaults and then falls back to the
 * immutable booking snapshot. The booking row is locked by the caller's
 * completion transaction so a staff override and completion commit together.
 */
export async function evaluatePartnerProofCompletion(
  tx: TeamMutationTransaction,
  appointmentId: string,
): Promise<PartnerProofCompletionDecision> {
  const [booking] = await tx
    .select({
      id: partnerBookings.id,
      partnerAccountId: partnerBookings.partnerAccountId,
      proofRequirementsSnapshot: partnerBookings.proofRequirementsSnapshot,
    })
    .from(partnerBookings)
    .where(eq(partnerBookings.appointmentId, appointmentId))
    .for("update")
    .limit(1);

  if (!booking) return { kind: "not_partner_job" };
  if (!booking.partnerAccountId) return { kind: "invalid_binding" };

  const rows = await tx
    .select({
      partnerBookingId: partnerEvidenceRequirements.partnerBookingId,
      category: partnerEvidenceRequirements.category,
      required: partnerEvidenceRequirements.required,
      minimumCount: partnerEvidenceRequirements.minimumCount,
    })
    .from(partnerEvidenceRequirements)
    .where(
      and(
        eq(
          partnerEvidenceRequirements.partnerAccountId,
          booking.partnerAccountId,
        ),
        or(
          isNull(partnerEvidenceRequirements.partnerBookingId),
          eq(partnerEvidenceRequirements.partnerBookingId, booking.id),
        ),
      ),
    )
    .orderBy(
      asc(partnerEvidenceRequirements.category),
      asc(partnerEvidenceRequirements.partnerBookingId),
    );

  const effective = new Map<
    ProofCategory,
    { required: boolean; minimumCount: number }
  >();
  for (const row of rows) {
    if (!PROOF_CATEGORIES.includes(row.category as ProofCategory)) continue;
    const category = row.category as ProofCategory;
    const current = effective.get(category);
    if (!current || row.partnerBookingId === booking.id) {
      effective.set(category, {
        required: row.required,
        minimumCount: row.minimumCount,
      });
    }
  }

  for (const category of PROOF_CATEGORIES) {
    if (effective.has(category)) continue;
    const minimumCount = snapshotMinimum(
      booking.proofRequirementsSnapshot,
      category,
    );
    if (minimumCount !== null) {
      effective.set(category, {
        required: minimumCount > 0,
        minimumCount,
      });
    }
  }

  const evidence = await tx
    .select({ category: partnerJobEvidence.category })
    .from(partnerJobEvidence)
    .innerJoin(
      mediaAssets,
      eq(partnerJobEvidence.mediaAssetId, mediaAssets.id),
    )
    .where(
      and(
        eq(partnerJobEvidence.partnerAccountId, booking.partnerAccountId),
        eq(partnerJobEvidence.partnerBookingId, booking.id),
        isNull(partnerJobEvidence.deletedAt),
        eq(mediaAssets.status, "ready"),
        isNull(mediaAssets.deletedAt),
      ),
    );
  const counts = new Map<ProofCategory, number>();
  for (const row of evidence) {
    if (!PROOF_CATEGORIES.includes(row.category as ProofCategory)) continue;
    const category = row.category as ProofCategory;
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }

  const missing: MissingPartnerProof[] = [];
  for (const [category, requirement] of effective) {
    if (!requirement.required || requirement.minimumCount === 0) continue;
    const availableCount = counts.get(category) ?? 0;
    if (availableCount < requirement.minimumCount) {
      missing.push({
        category,
        minimumCount: requirement.minimumCount,
        availableCount,
      });
    }
  }
  missing.sort((left, right) => left.category.localeCompare(right.category));

  return missing.length > 0
    ? {
        kind: "missing",
        partnerAccountId: booking.partnerAccountId,
        partnerBookingId: booking.id,
        missing,
      }
    : {
        kind: "satisfied",
        partnerAccountId: booking.partnerAccountId,
        partnerBookingId: booking.id,
      };
}

/** Records a reasoned job-level exception without weakening account defaults. */
export async function recordPartnerProofCompletionOverride(
  tx: ProofExecutor,
  input: {
    decision: Extract<PartnerProofCompletionDecision, { kind: "missing" }>;
    reason: string;
    teamMemberId: string;
    now: Date;
  },
): Promise<void> {
  const categories = input.decision.missing.map((entry) => entry.category);
  const existing = await tx
    .select({
      id: partnerEvidenceRequirements.id,
      category: partnerEvidenceRequirements.category,
    })
    .from(partnerEvidenceRequirements)
    .where(
      and(
        eq(
          partnerEvidenceRequirements.partnerAccountId,
          input.decision.partnerAccountId,
        ),
        eq(
          partnerEvidenceRequirements.partnerBookingId,
          input.decision.partnerBookingId,
        ),
      ),
    );
  const existingByCategory = new Map(
    existing.map((row) => [row.category, row.id]),
  );

  for (const category of categories) {
    const existingId = existingByCategory.get(category);
    const values = {
      required: false,
      minimumCount: 0,
      source: "staff_override",
      overrideReason: input.reason,
      overriddenByTeamMemberId: input.teamMemberId,
      updatedAt: input.now,
    };
    if (existingId) {
      await tx
        .update(partnerEvidenceRequirements)
        .set(values)
        .where(eq(partnerEvidenceRequirements.id, existingId));
    } else {
      await tx.insert(partnerEvidenceRequirements).values({
        partnerAccountId: input.decision.partnerAccountId,
        partnerBookingId: input.decision.partnerBookingId,
        category,
        ...values,
        createdAt: input.now,
      });
    }
  }
}
