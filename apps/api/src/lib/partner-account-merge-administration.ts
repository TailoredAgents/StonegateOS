import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  partnerAccountMergeCases,
  partnerAccounts,
  type DatabaseClient,
} from "@/db";
import {
  assertTeamMutationExpectedVersion,
  TeamMutationFailure,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";

type Account = typeof partnerAccounts.$inferSelect;
type MergeCase = typeof partnerAccountMergeCases.$inferSelect;
type BindingCounts = Readonly<Record<string, number>>;

function lifecycleSnapshot(account: Account): Record<string, unknown> {
  return {
    id: account.id,
    portalAccessEnabled: account.portalAccessEnabled,
    portalLifecycleStatus: account.portalLifecycleStatus,
    portalLifecycleRevision: account.portalLifecycleRevision,
    mergedIntoPartnerAccountId: account.mergedIntoPartnerAccountId,
  };
}

function mergeCaseSnapshot(mergeCase: MergeCase): Record<string, unknown> {
  return {
    id: mergeCase.id,
    sourcePartnerAccountId: mergeCase.sourcePartnerAccountId,
    targetPartnerAccountId: mergeCase.targetPartnerAccountId,
    state: mergeCase.state,
    conflictSummary: mergeCase.conflictSummary,
    preflightHash: mergeCase.preflightHash,
    version: mergeCase.version,
  };
}

function normalizeCounts(value: unknown): BindingCounts {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("partner_account_merge_preflight_invalid");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 32) {
    throw new TeamMutationFailure(
      "conflict",
      "This account has too many binding categories for automatic merge. Use the reconciliation queue.",
    );
  }
  const normalized: Record<string, number> = {};
  for (const [key, count] of entries) {
    if (
      !/^[a-z][a-z0-9_]{0,62}$/u.test(key) ||
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count < 1
    ) {
      throw new Error("partner_account_merge_preflight_invalid");
    }
    normalized[key] = count;
  }
  return Object.freeze(normalized);
}

async function accountBindingCounts(
  tx: TeamMutationTransaction,
  accountId: string,
): Promise<BindingCounts> {
  const result = await tx.execute(
    sql<{ counts: Record<string, number> }>`SELECT partner_account_binding_counts(${accountId}::uuid) AS counts`,
  );
  return normalizeCounts(result[0]?.["counts"]);
}

function preflightHash(input: {
  sourcePartnerAccountId: string;
  targetPartnerAccountId: string;
  sourceLifecycleRevision: number;
  targetLifecycleRevision: number;
  counts: BindingCounts;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        ...input,
        counts: Object.fromEntries(
          Object.entries(input.counts).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        ),
      }),
      "utf8",
    )
    .digest("hex");
}

async function lockMergeAccounts(
  tx: TeamMutationTransaction,
  sourcePartnerAccountId: string,
  targetPartnerAccountId: string,
): Promise<{ source: Account; target: Account }> {
  if (sourcePartnerAccountId === targetPartnerAccountId) {
    throw new TeamMutationFailure(
      "invalid",
      "Choose two different partner accounts.",
    );
  }
  const accounts = await tx
    .select()
    .from(partnerAccounts)
    .where(
      inArray(partnerAccounts.id, [
        sourcePartnerAccountId,
        targetPartnerAccountId,
      ]),
    )
    .orderBy(partnerAccounts.id)
    .for("update");
  const source = accounts.find(
    (account) => account.id === sourcePartnerAccountId,
  );
  const target = accounts.find(
    (account) => account.id === targetPartnerAccountId,
  );
  if (!source || !target) {
    throw new TeamMutationFailure(
      "invalid",
      "One of the partner accounts was not found.",
      { status: 404 },
    );
  }
  if (source.portalLifecycleStatus === "merged") {
    throw new TeamMutationFailure(
      "conflict",
      "The source account is already merged.",
    );
  }
  if (
    target.portalLifecycleStatus !== "active" ||
    !target.portalAccessEnabled
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "The destination must be an active, portal-enabled partner account.",
    );
  }
  return { source, target };
}

export async function initiatePartnerAccountMergeCase(
  tx: TeamMutationTransaction,
  input: Readonly<{
    sourcePartnerAccountId: string;
    targetPartnerAccountId: string;
    sourceExpectedVersion: string;
    reason: string;
    teamMemberId: string;
    now?: Date;
  }>,
) {
  const reason = input.reason.normalize("NFKC").trim();
  if (reason.length < 20 || reason.length > 1_000) {
    throw new TeamMutationFailure(
      "invalid",
      "Explain the account relationship in 20 to 1,000 characters.",
    );
  }
  const { source, target } = await lockMergeAccounts(
    tx,
    input.sourcePartnerAccountId,
    input.targetPartnerAccountId,
  );
  assertTeamMutationExpectedVersion(
    { expectedVersion: input.sourceExpectedVersion },
    source.portalLifecycleRevision,
  );
  const counts = await accountBindingCounts(tx, source.id);
  const hash = preflightHash({
    sourcePartnerAccountId: source.id,
    targetPartnerAccountId: target.id,
    sourceLifecycleRevision: source.portalLifecycleRevision,
    targetLifecycleRevision: target.portalLifecycleRevision,
    counts,
  });
  const state =
    Object.keys(counts).length === 0
      ? ("ready" as const)
      : ("needs_reconciliation" as const);
  const now = input.now ?? new Date();
  const [existing] = await tx
    .select()
    .from(partnerAccountMergeCases)
    .where(
      and(
        eq(partnerAccountMergeCases.sourcePartnerAccountId, source.id),
        inArray(partnerAccountMergeCases.state, [
          "needs_reconciliation",
          "ready",
        ]),
      ),
    )
    .for("update")
    .limit(1);
  const [mergeCase] = existing
    ? await tx
        .update(partnerAccountMergeCases)
        .set({
          targetPartnerAccountId: target.id,
          state,
          reason,
          conflictSummary: { ...counts },
          preflightHash: hash,
          sourceLifecycleRevision: source.portalLifecycleRevision,
          targetLifecycleRevision: target.portalLifecycleRevision,
          requestedByTeamMemberId: input.teamMemberId,
          version: existing.version + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(partnerAccountMergeCases.id, existing.id),
            eq(partnerAccountMergeCases.version, existing.version),
          ),
        )
        .returning()
    : await tx
        .insert(partnerAccountMergeCases)
        .values({
          sourcePartnerAccountId: source.id,
          targetPartnerAccountId: target.id,
          state,
          reason,
          conflictSummary: { ...counts },
          preflightHash: hash,
          sourceLifecycleRevision: source.portalLifecycleRevision,
          targetLifecycleRevision: target.portalLifecycleRevision,
          requestedByTeamMemberId: input.teamMemberId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
  if (!mergeCase) throw new Error("partner_account_merge_case_write_failed");
  return {
    mergeCase,
    counts,
    before: existing ? mergeCaseSnapshot(existing) : null,
    after: mergeCaseSnapshot(mergeCase),
    source: lifecycleSnapshot(source),
    target: lifecycleSnapshot(target),
  };
}

export async function completePartnerAccountMergeCase(
  tx: TeamMutationTransaction,
  input: Readonly<{
    mergeCaseId: string;
    expectedVersion: string;
    resolutionNote: string;
    teamMemberId: string;
    now?: Date;
  }>,
) {
  const note = input.resolutionNote.normalize("NFKC").trim();
  if (note.length < 20 || note.length > 1_000) {
    throw new TeamMutationFailure(
      "invalid",
      "Record the completed reconciliation in 20 to 1,000 characters.",
    );
  }
  const [mergeCase] = await tx
    .select()
    .from(partnerAccountMergeCases)
    .where(eq(partnerAccountMergeCases.id, input.mergeCaseId))
    .for("update")
    .limit(1);
  if (!mergeCase) {
    throw new TeamMutationFailure("invalid", "Merge case not found.", {
      status: 404,
    });
  }
  assertTeamMutationExpectedVersion(
    { expectedVersion: input.expectedVersion },
    mergeCase.version,
  );
  if (mergeCase.state !== "ready") {
    throw new TeamMutationFailure(
      "conflict",
      "Resolve every reported account binding and refresh the preflight before completing the merge.",
    );
  }
  const { source, target } = await lockMergeAccounts(
    tx,
    mergeCase.sourcePartnerAccountId,
    mergeCase.targetPartnerAccountId,
  );
  if (
    source.portalLifecycleRevision !== mergeCase.sourceLifecycleRevision ||
    target.portalLifecycleRevision !== mergeCase.targetLifecycleRevision
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "An account changed after preflight. Refresh the merge case.",
    );
  }
  const counts = await accountBindingCounts(tx, source.id);
  const currentHash = preflightHash({
    sourcePartnerAccountId: source.id,
    targetPartnerAccountId: target.id,
    sourceLifecycleRevision: source.portalLifecycleRevision,
    targetLifecycleRevision: target.portalLifecycleRevision,
    counts,
  });
  if (
    Object.keys(counts).length > 0 ||
    currentHash !== mergeCase.preflightHash
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "New source-account bindings appeared after preflight. Reconcile and refresh before merging.",
    );
  }
  const now = input.now ?? new Date();
  const [mergedAccount] = await tx
    .update(partnerAccounts)
    .set({
      portalLifecycleStatus: "merged",
      portalAccessEnabled: false,
      portalLifecyclePriorAccessEnabled: source.portalAccessEnabled,
      portalLifecycleRevision: source.portalLifecycleRevision + 1,
      portalLifecycleChangedAt: now,
      portalLifecycleChangedByTeamMemberId: input.teamMemberId,
      portalLifecycleReason: note,
      mergedIntoPartnerAccountId: target.id,
      updatedAt: now,
    })
    .where(
      and(
        eq(partnerAccounts.id, source.id),
        eq(
          partnerAccounts.portalLifecycleRevision,
          source.portalLifecycleRevision,
        ),
      ),
    )
    .returning();
  if (!mergedAccount) {
    throw new TeamMutationFailure(
      "conflict",
      "The source account changed while the merge was completing.",
    );
  }
  const [completed] = await tx
    .update(partnerAccountMergeCases)
    .set({
      state: "completed",
      completedByTeamMemberId: input.teamMemberId,
      completedAt: now,
      resolutionNote: note,
      version: mergeCase.version + 1,
      updatedAt: now,
    })
    .where(
      and(
        eq(partnerAccountMergeCases.id, mergeCase.id),
        eq(partnerAccountMergeCases.state, "ready"),
        eq(partnerAccountMergeCases.version, mergeCase.version),
      ),
    )
    .returning();
  if (!completed) throw new Error("partner_account_merge_complete_failed");
  return {
    mergeCase: completed,
    sourceAccount: mergedAccount,
    targetAccount: target,
    before: {
      mergeCase: mergeCaseSnapshot(mergeCase),
      source: lifecycleSnapshot(source),
    },
    after: {
      mergeCase: mergeCaseSnapshot(completed),
      source: lifecycleSnapshot(mergedAccount),
    },
  };
}

export type PartnerAccountMergeTransaction = Parameters<
  Parameters<DatabaseClient["transaction"]>[0]
>[0];
