import { domainToASCII } from "node:url";
import { and, eq, ne, sql } from "drizzle-orm";
import { partnerAccountDomains, partnerAccounts } from "@/db";
import {
  assertTeamMutationExpectedVersion,
  TeamMutationFailure,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";

const DOMAIN_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const CONSUMER_MAIL_DOMAINS = new Set([
  "aol.com",
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "mail.com",
  "outlook.com",
  "proton.me",
  "protonmail.com",
  "yahoo.com",
]);

type AccountDomainStatus = "pending" | "verified" | "revoked";

export type StaffPartnerAccountDomainResult = {
  domainId: string;
  partnerAccountId: string;
  normalizedDomain: string;
  status: AccountDomainStatus;
  verificationMethod: string | null;
  verifiedAt: string | null;
  revokedAt: string | null;
  conflictingDomainsRevoked: string[];
  previousVersion: string | null;
  version: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
};

export function normalizePartnerAccountDomain(rawDomain: string): string {
  const candidate = rawDomain.normalize("NFKC").trim().toLowerCase();
  if (
    candidate.length < 3 ||
    candidate.length > 253 ||
    candidate.includes("://") ||
    /[@/:\\\s]/u.test(candidate)
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "Enter a company-owned domain without a protocol, path, email, or port.",
      { fieldErrors: { domain: "Use a domain such as example.com." } },
    );
  }
  const withoutTrailingDot = candidate.endsWith(".")
    ? candidate.slice(0, -1)
    : candidate;
  const normalized = domainToASCII(withoutTrailingDot).toLowerCase();
  if (
    normalized.length < 3 ||
    normalized.length > 253 ||
    !DOMAIN_PATTERN.test(normalized)
  ) {
    throw new TeamMutationFailure("invalid", "Enter a valid company domain.", {
      fieldErrors: { domain: "Use a registrable domain such as example.com." },
    });
  }
  if (CONSUMER_MAIL_DOMAINS.has(normalized)) {
    throw new TeamMutationFailure(
      "invalid",
      "Consumer email domains cannot establish a company account boundary.",
      { fieldErrors: { domain: "Use the company's own domain." } },
    );
  }
  return normalized;
}

async function lockAccount(
  tx: TeamMutationTransaction,
  partnerAccountId: string,
): Promise<{ id: string; updatedAt: Date }> {
  const [account] = await tx
    .select({ id: partnerAccounts.id, updatedAt: partnerAccounts.updatedAt })
    .from(partnerAccounts)
    .where(eq(partnerAccounts.id, partnerAccountId))
    .for("update")
    .limit(1);
  if (!account) {
    throw new TeamMutationFailure(
      "invalid",
      "The partner account was not found.",
      {
        status: 404,
      },
    );
  }
  return account;
}

async function lockDomainAuthority(
  tx: TeamMutationTransaction,
  normalizedDomain: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`partner-account-domain:${normalizedDomain}`}, 0))`,
  );
}

function safeDomainState(row: {
  status: AccountDomainStatus;
  verificationMethod: string | null;
  verifiedAt: Date | null;
  revokedAt: Date | null;
  updatedAt: Date;
}): Record<string, unknown> {
  return {
    status: row.status,
    verificationMethod: row.verificationMethod,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    verificationEvidencePresent: row.verificationMethod !== null,
    version: row.updatedAt.toISOString(),
  };
}

export async function createPartnerAccountDomainAsStaff(
  tx: TeamMutationTransaction,
  input: {
    partnerAccountId: string;
    rawDomain: string;
    expectedVersion: string;
    allowRestore: boolean;
    now?: Date;
  },
): Promise<StaffPartnerAccountDomainResult> {
  const normalizedDomain = normalizePartnerAccountDomain(input.rawDomain);
  const account = await lockAccount(tx, input.partnerAccountId);
  await lockDomainAuthority(tx, normalizedDomain);
  const [existing] = await tx
    .select({
      id: partnerAccountDomains.id,
      partnerAccountId: partnerAccountDomains.partnerAccountId,
      status: partnerAccountDomains.status,
      verificationMethod: partnerAccountDomains.verificationMethod,
      verifiedAt: partnerAccountDomains.verifiedAt,
      revokedAt: partnerAccountDomains.revokedAt,
      updatedAt: partnerAccountDomains.updatedAt,
    })
    .from(partnerAccountDomains)
    .where(
      and(
        eq(partnerAccountDomains.partnerAccountId, input.partnerAccountId),
        eq(partnerAccountDomains.normalizedDomain, normalizedDomain),
      ),
    )
    .for("update")
    .limit(1);
  const now = input.now ?? new Date();
  if (existing) {
    assertTeamMutationExpectedVersion(
      { expectedVersion: input.expectedVersion },
      existing.updatedAt,
    );
    if (existing.status !== "revoked") {
      throw new TeamMutationFailure(
        "conflict",
        "That domain is already registered to this partner account.",
      );
    }
    if (!input.allowRestore) {
      throw new TeamMutationFailure(
        "forbidden",
        "Restoring a revoked company domain requires Team Owner override.",
      );
    }
    const [restored] = await tx
      .update(partnerAccountDomains)
      .set({
        status: "pending",
        verificationMethod: null,
        verificationEvidence: null,
        verifiedByTeamMemberId: null,
        verifiedAt: null,
        revokedByTeamMemberId: null,
        revokedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(partnerAccountDomains.id, existing.id),
          eq(partnerAccountDomains.partnerAccountId, input.partnerAccountId),
          eq(partnerAccountDomains.status, "revoked"),
          eq(partnerAccountDomains.updatedAt, existing.updatedAt),
        ),
      )
      .returning({ updatedAt: partnerAccountDomains.updatedAt });
    if (!restored) {
      throw new TeamMutationFailure(
        "conflict",
        "The domain changed while it was being restored. Refresh and try again.",
        { retryable: true },
      );
    }
    const version = restored.updatedAt.toISOString();
    return {
      domainId: existing.id,
      partnerAccountId: input.partnerAccountId,
      normalizedDomain,
      status: "pending",
      verificationMethod: null,
      verifiedAt: null,
      revokedAt: null,
      conflictingDomainsRevoked: [],
      previousVersion: existing.updatedAt.toISOString(),
      version,
      before: safeDomainState(existing),
      after: {
        status: "pending",
        verificationMethod: null,
        verifiedAt: null,
        revokedAt: null,
        verificationEvidencePresent: false,
        version,
      },
    };
  }

  assertTeamMutationExpectedVersion(
    { expectedVersion: input.expectedVersion },
    account.updatedAt,
  );
  const [created] = await tx
    .insert(partnerAccountDomains)
    .values({
      partnerAccountId: input.partnerAccountId,
      normalizedDomain,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    })
    .returning({
      id: partnerAccountDomains.id,
      updatedAt: partnerAccountDomains.updatedAt,
    });
  if (!created)
    throw new TeamMutationFailure(
      "internal",
      "The domain could not be created.",
    );
  const version = created.updatedAt.toISOString();
  return {
    domainId: created.id,
    partnerAccountId: input.partnerAccountId,
    normalizedDomain,
    status: "pending",
    verificationMethod: null,
    verifiedAt: null,
    revokedAt: null,
    conflictingDomainsRevoked: [],
    previousVersion: null,
    version,
    before: null,
    after: {
      status: "pending",
      verificationMethod: null,
      verifiedAt: null,
      revokedAt: null,
      verificationEvidencePresent: false,
      version,
    },
  };
}

export async function verifyPartnerAccountDomainAsStaff(
  tx: TeamMutationTransaction,
  input: {
    partnerAccountId: string;
    domainId: string;
    verificationMethod: "dns_txt" | "email_challenge" | "manual_document";
    verificationEvidence: string;
    verifiedByTeamMemberId: string;
    expectedVersion: string;
    allowConflictingVerificationOverride: boolean;
    now?: Date;
  },
): Promise<StaffPartnerAccountDomainResult> {
  await lockAccount(tx, input.partnerAccountId);
  const [targetBase] = await tx
    .select({ normalizedDomain: partnerAccountDomains.normalizedDomain })
    .from(partnerAccountDomains)
    .where(
      and(
        eq(partnerAccountDomains.id, input.domainId),
        eq(partnerAccountDomains.partnerAccountId, input.partnerAccountId),
      ),
    )
    .limit(1);
  if (!targetBase) {
    throw new TeamMutationFailure(
      "invalid",
      "The account domain was not found.",
      {
        status: 404,
      },
    );
  }
  await lockDomainAuthority(tx, targetBase.normalizedDomain);
  const [target] = await tx
    .select({
      id: partnerAccountDomains.id,
      partnerAccountId: partnerAccountDomains.partnerAccountId,
      normalizedDomain: partnerAccountDomains.normalizedDomain,
      status: partnerAccountDomains.status,
      verificationMethod: partnerAccountDomains.verificationMethod,
      verifiedAt: partnerAccountDomains.verifiedAt,
      revokedAt: partnerAccountDomains.revokedAt,
      updatedAt: partnerAccountDomains.updatedAt,
    })
    .from(partnerAccountDomains)
    .where(
      and(
        eq(partnerAccountDomains.id, input.domainId),
        eq(partnerAccountDomains.partnerAccountId, input.partnerAccountId),
      ),
    )
    .for("update")
    .limit(1);
  if (!target) {
    throw new TeamMutationFailure(
      "invalid",
      "The account domain was not found.",
      {
        status: 404,
      },
    );
  }
  assertTeamMutationExpectedVersion(
    { expectedVersion: input.expectedVersion },
    target.updatedAt,
  );
  if (target.status !== "pending") {
    throw new TeamMutationFailure(
      "conflict",
      "Only a pending company domain can be verified.",
    );
  }
  const conflicts = await tx
    .select({ id: partnerAccountDomains.id })
    .from(partnerAccountDomains)
    .where(
      and(
        eq(partnerAccountDomains.normalizedDomain, target.normalizedDomain),
        eq(partnerAccountDomains.status, "verified"),
        ne(partnerAccountDomains.partnerAccountId, input.partnerAccountId),
      ),
    )
    .for("update");
  if (conflicts.length > 0 && !input.allowConflictingVerificationOverride) {
    throw new TeamMutationFailure(
      "conflict",
      "That domain is already verified for another partner account. A Team Owner must resolve the tenant conflict.",
      {
        fieldErrors: {
          domain: "Do not verify the same company boundary twice.",
        },
      },
    );
  }
  const now = input.now ?? new Date();
  const conflictIds = conflicts.map((row) => row.id);
  if (conflictIds.length > 0) {
    await tx
      .update(partnerAccountDomains)
      .set({
        status: "revoked",
        revokedByTeamMemberId: input.verifiedByTeamMemberId,
        revokedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(partnerAccountDomains.normalizedDomain, target.normalizedDomain),
          eq(partnerAccountDomains.status, "verified"),
          ne(partnerAccountDomains.partnerAccountId, input.partnerAccountId),
        ),
      );
  }
  const [verified] = await tx
    .update(partnerAccountDomains)
    .set({
      status: "verified",
      verificationMethod: input.verificationMethod,
      verificationEvidence: input.verificationEvidence,
      verifiedByTeamMemberId: input.verifiedByTeamMemberId,
      verifiedAt: now,
      revokedByTeamMemberId: null,
      revokedAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(partnerAccountDomains.id, target.id),
        eq(partnerAccountDomains.partnerAccountId, input.partnerAccountId),
        eq(partnerAccountDomains.status, "pending"),
        eq(partnerAccountDomains.updatedAt, target.updatedAt),
      ),
    )
    .returning({ updatedAt: partnerAccountDomains.updatedAt });
  if (!verified) {
    throw new TeamMutationFailure(
      "conflict",
      "The domain changed while it was being verified. Refresh and try again.",
      { retryable: true },
    );
  }
  const version = verified.updatedAt.toISOString();
  return {
    domainId: target.id,
    partnerAccountId: target.partnerAccountId,
    normalizedDomain: target.normalizedDomain,
    status: "verified",
    verificationMethod: input.verificationMethod,
    verifiedAt: now.toISOString(),
    revokedAt: null,
    conflictingDomainsRevoked: conflictIds,
    previousVersion: target.updatedAt.toISOString(),
    version,
    before: safeDomainState(target),
    after: {
      status: "verified",
      verificationMethod: input.verificationMethod,
      verifiedAt: now.toISOString(),
      revokedAt: null,
      verificationEvidencePresent: true,
      version,
    },
  };
}

export async function revokePartnerAccountDomainAsStaff(
  tx: TeamMutationTransaction,
  input: {
    partnerAccountId: string;
    domainId: string;
    revokedByTeamMemberId: string;
    expectedVersion: string;
    now?: Date;
  },
): Promise<StaffPartnerAccountDomainResult> {
  await lockAccount(tx, input.partnerAccountId);
  const [targetBase] = await tx
    .select({ normalizedDomain: partnerAccountDomains.normalizedDomain })
    .from(partnerAccountDomains)
    .where(
      and(
        eq(partnerAccountDomains.id, input.domainId),
        eq(partnerAccountDomains.partnerAccountId, input.partnerAccountId),
      ),
    )
    .limit(1);
  if (!targetBase) {
    throw new TeamMutationFailure(
      "invalid",
      "The account domain was not found.",
      {
        status: 404,
      },
    );
  }
  await lockDomainAuthority(tx, targetBase.normalizedDomain);
  const [target] = await tx
    .select({
      id: partnerAccountDomains.id,
      partnerAccountId: partnerAccountDomains.partnerAccountId,
      normalizedDomain: partnerAccountDomains.normalizedDomain,
      status: partnerAccountDomains.status,
      verificationMethod: partnerAccountDomains.verificationMethod,
      verifiedAt: partnerAccountDomains.verifiedAt,
      revokedAt: partnerAccountDomains.revokedAt,
      updatedAt: partnerAccountDomains.updatedAt,
    })
    .from(partnerAccountDomains)
    .where(
      and(
        eq(partnerAccountDomains.id, input.domainId),
        eq(partnerAccountDomains.partnerAccountId, input.partnerAccountId),
      ),
    )
    .for("update")
    .limit(1);
  if (!target) {
    throw new TeamMutationFailure(
      "invalid",
      "The account domain was not found.",
      {
        status: 404,
      },
    );
  }
  assertTeamMutationExpectedVersion(
    { expectedVersion: input.expectedVersion },
    target.updatedAt,
  );
  if (target.status === "revoked") {
    throw new TeamMutationFailure(
      "conflict",
      "That company domain is already revoked.",
    );
  }
  const now = input.now ?? new Date();
  const [revoked] = await tx
    .update(partnerAccountDomains)
    .set({
      status: "revoked",
      revokedByTeamMemberId: input.revokedByTeamMemberId,
      revokedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(partnerAccountDomains.id, target.id),
        eq(partnerAccountDomains.partnerAccountId, input.partnerAccountId),
        ne(partnerAccountDomains.status, "revoked"),
        eq(partnerAccountDomains.updatedAt, target.updatedAt),
      ),
    )
    .returning({ updatedAt: partnerAccountDomains.updatedAt });
  if (!revoked) {
    throw new TeamMutationFailure(
      "conflict",
      "The domain changed while it was being revoked. Refresh and try again.",
      { retryable: true },
    );
  }
  const version = revoked.updatedAt.toISOString();
  return {
    domainId: target.id,
    partnerAccountId: target.partnerAccountId,
    normalizedDomain: target.normalizedDomain,
    status: "revoked",
    verificationMethod: target.verificationMethod,
    verifiedAt: target.verifiedAt?.toISOString() ?? null,
    revokedAt: now.toISOString(),
    conflictingDomainsRevoked: [],
    previousVersion: target.updatedAt.toISOString(),
    version,
    before: safeDomainState(target),
    after: {
      status: "revoked",
      verificationMethod: target.verificationMethod,
      verifiedAt: target.verifiedAt?.toISOString() ?? null,
      revokedAt: now.toISOString(),
      verificationEvidencePresent: target.verificationMethod !== null,
      version,
    },
  };
}
