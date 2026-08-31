import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  quoteActivityEvents,
  quoteCapabilities,
  quoteVersions,
  quotes,
} from "@/db";
import { generateQuoteCapability } from "@/lib/quote-v2-capability";
import { requireActiveQuoteV2ContactForCapabilityMint } from "@/lib/quote-v2-contact-access";
import type { TeamMutationTransaction } from "@/lib/team-mutation";
import { TeamMutationFailure } from "@/lib/team-mutation";

type CapabilityRow = {
  capabilityId: string;
  quoteId: string;
  versionId: string;
  recipientRole: string;
  recipientAddressHash: string;
  allowedActions: string[];
  status: string;
  readExpiresAt: Date;
  actionExpiresAt: Date | null;
  engineVersion: string;
  quoteRevision: number | null;
  versionState: string;
};

async function lockCapability(
  tx: TeamMutationTransaction,
  input: { quoteId: string; capabilityId: string },
): Promise<CapabilityRow> {
  const [row] = await tx
    .select({
      capabilityId: quoteCapabilities.id,
      quoteId: quoteCapabilities.quoteId,
      versionId: quoteCapabilities.quoteVersionId,
      recipientRole: quoteCapabilities.recipientRole,
      recipientAddressHash: quoteCapabilities.recipientAddressHash,
      allowedActions: quoteCapabilities.allowedActions,
      status: quoteCapabilities.status,
      readExpiresAt: quoteCapabilities.readExpiresAt,
      actionExpiresAt: quoteCapabilities.actionExpiresAt,
      engineVersion: quotes.engineVersion,
      quoteRevision: quotes.aggregateRevision,
      versionState: quoteVersions.state,
    })
    .from(quoteCapabilities)
    .innerJoin(quotes, eq(quotes.id, quoteCapabilities.quoteId))
    .innerJoin(
      quoteVersions,
      eq(quoteVersions.id, quoteCapabilities.quoteVersionId),
    )
    .where(
      and(
        eq(quoteCapabilities.id, input.capabilityId),
        eq(quoteCapabilities.quoteId, input.quoteId),
      ),
    )
    .for("update")
    .limit(1);
  if (!row || row.engineVersion !== "v2" || !row.quoteRevision) {
    throw new TeamMutationFailure(
      "invalid",
      "The proposal access record was not found.",
    );
  }
  return row;
}

async function advanceQuoteRevision(
  tx: TeamMutationTransaction,
  input: {
    quoteId: string;
    expectedQuoteRevision: number;
    now: Date;
  },
): Promise<number> {
  const nextRevision = input.expectedQuoteRevision + 1;
  const [updated] = await tx
    .update(quotes)
    .set({
      aggregateRevision: nextRevision,
      revision: nextRevision,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(quotes.id, input.quoteId),
        eq(quotes.engineVersion, "v2"),
        eq(quotes.aggregateRevision, input.expectedQuoteRevision),
      ),
    )
    .returning({ id: quotes.id });
  if (!updated) {
    throw new TeamMutationFailure(
      "conflict",
      "The quote changed before access could be updated. Refresh and retry.",
      { retryable: true },
    );
  }
  return nextRevision;
}

export async function replaceQuoteV2SignerCapability(
  tx: TeamMutationTransaction,
  input: {
    quoteId: string;
    capabilityId: string;
    expectedQuoteRevision: number;
    actorTeamMemberId: string;
    correlationId: string;
    reason: string;
    now?: Date;
  },
): Promise<{
  receipt: {
    quoteId: string;
    versionId: string;
    replacedCapabilityId: string;
    capabilityId: string;
    quoteRevision: number;
    recipientRole: "signer";
    issuedAt: string;
    readExpiresAt: string;
  };
  rawToken: string;
}> {
  const now = input.now ?? new Date();
  await requireActiveQuoteV2ContactForCapabilityMint(tx, {
    quoteId: input.quoteId,
  });
  const row = await lockCapability(tx, input);
  if (
    row.quoteRevision !== input.expectedQuoteRevision ||
    row.status !== "active" ||
    row.recipientRole !== "signer" ||
    row.readExpiresAt <= now
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "This signer link is no longer replaceable. Refresh the quote history.",
    );
  }
  if (!input.reason.trim()) {
    throw new TeamMutationFailure(
      "invalid",
      "Explain why the link is replaced.",
      {
        fieldErrors: { reason: "Enter a replacement reason." },
      },
    );
  }
  const nextCapabilityId = randomUUID();
  const capability = generateQuoteCapability();
  const actionExpiresAt =
    row.actionExpiresAt && row.actionExpiresAt > now
      ? row.actionExpiresAt
      : null;

  const [superseded] = await tx
    .update(quoteCapabilities)
    .set({
      status: "superseded",
      allowedActions: ["view", "pdf"],
      actionExpiresAt: null,
      supersededAt: now,
      supersededByCapabilityId: nextCapabilityId,
      updatedAt: now,
    })
    .where(
      and(
        eq(quoteCapabilities.id, row.capabilityId),
        eq(quoteCapabilities.status, "active"),
      ),
    )
    .returning({ id: quoteCapabilities.id });
  if (!superseded) {
    throw new TeamMutationFailure(
      "conflict",
      "The signer link changed before it could be replaced.",
      { retryable: true },
    );
  }
  await tx.insert(quoteCapabilities).values({
    id: nextCapabilityId,
    quoteId: row.quoteId,
    quoteVersionId: row.versionId,
    recipientRole: "signer",
    recipientAddressHash: row.recipientAddressHash,
    allowedActions: row.allowedActions,
    tokenHash: capability.tokenHash,
    status: "active",
    readExpiresAt: row.readExpiresAt,
    actionExpiresAt,
    issuedAt: now,
    issuedByTeamMemberId: input.actorTeamMemberId,
    createdAt: now,
    updatedAt: now,
  });
  const quoteRevision = await advanceQuoteRevision(tx, {
    quoteId: row.quoteId,
    expectedQuoteRevision: input.expectedQuoteRevision,
    now,
  });
  await tx.insert(quoteActivityEvents).values({
    quoteId: row.quoteId,
    quoteVersionId: row.versionId,
    eventType: "quote.capability_replaced",
    actorType: "staff",
    actorTeamMemberId: input.actorTeamMemberId,
    correlationId: input.correlationId,
    metadata: {
      replacedCapabilityId: row.capabilityId,
      capabilityId: nextCapabilityId,
      reason: input.reason.trim().slice(0, 1_000),
      previousLinkReadOnly: true,
    },
    occurredAt: now,
    createdAt: now,
  });
  return {
    receipt: {
      quoteId: row.quoteId,
      versionId: row.versionId,
      replacedCapabilityId: row.capabilityId,
      capabilityId: nextCapabilityId,
      quoteRevision,
      recipientRole: "signer",
      issuedAt: now.toISOString(),
      readExpiresAt: row.readExpiresAt.toISOString(),
    },
    rawToken: capability.token,
  };
}

export async function revokeQuoteV2Capability(
  tx: TeamMutationTransaction,
  input: {
    quoteId: string;
    capabilityId: string;
    expectedQuoteRevision: number;
    actorTeamMemberId: string;
    correlationId: string;
    reason: string;
    now?: Date;
  },
): Promise<{
  quoteId: string;
  versionId: string;
  capabilityId: string;
  quoteRevision: number;
  revokedAt: string;
}> {
  const now = input.now ?? new Date();
  const row = await lockCapability(tx, input);
  if (
    row.quoteRevision !== input.expectedQuoteRevision ||
    row.status !== "active"
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "This customer link is no longer active. Refresh the quote history.",
    );
  }
  if (!input.reason.trim()) {
    throw new TeamMutationFailure("invalid", "Explain why access is revoked.", {
      fieldErrors: { reason: "Enter a revocation reason." },
    });
  }
  const [revoked] = await tx
    .update(quoteCapabilities)
    .set({
      status: "revoked",
      allowedActions: ["view"],
      actionExpiresAt: null,
      readExpiresAt: sql`greatest(${quoteCapabilities.issuedAt} + interval '1 millisecond', ${now.toISOString()}::timestamptz)`,
      revokedAt: now,
      revokedByTeamMemberId: input.actorTeamMemberId,
      revocationReason: input.reason.trim().slice(0, 1_000),
      updatedAt: now,
    })
    .where(
      and(
        eq(quoteCapabilities.id, row.capabilityId),
        eq(quoteCapabilities.status, "active"),
      ),
    )
    .returning({ id: quoteCapabilities.id });
  if (!revoked) {
    throw new TeamMutationFailure(
      "conflict",
      "The customer link changed before it could be revoked.",
      { retryable: true },
    );
  }
  const quoteRevision = await advanceQuoteRevision(tx, {
    quoteId: row.quoteId,
    expectedQuoteRevision: input.expectedQuoteRevision,
    now,
  });
  await tx.insert(quoteActivityEvents).values({
    quoteId: row.quoteId,
    quoteVersionId: row.versionId,
    eventType: "quote.capability_revoked",
    actorType: "staff",
    actorTeamMemberId: input.actorTeamMemberId,
    correlationId: input.correlationId,
    metadata: {
      capabilityId: row.capabilityId,
      reason: input.reason.trim().slice(0, 1_000),
    },
    occurredAt: now,
    createdAt: now,
  });
  return {
    quoteId: row.quoteId,
    versionId: row.versionId,
    capabilityId: row.capabilityId,
    quoteRevision,
    revokedAt: now.toISOString(),
  };
}
