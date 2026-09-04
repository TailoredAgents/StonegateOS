import { createHmac } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  auditLogs,
  getDb,
  partnerAccessApplications,
  partnerAccountCostCenters,
  partnerAccountDomains,
  partnerAccountLocations,
  partnerAccountMemberships,
  partnerAccounts,
  partnerApplicantSessions,
  partnerAuthChallenges,
  partnerEvidenceRequirements,
  partnerMembershipCostCenterScopes,
  partnerMembershipLocationScopes,
  partnerRoleTemplates,
  partnerUsers,
} from "@/db";
import {
  isPartnerLaunchRoleKey,
  type PartnerLaunchRoleKey,
} from "@/lib/partner-account-authorization";
import {
  PARTNER_PRIVACY_VERSION,
  PARTNER_TERMS_VERSION,
  parsePartnerAccessApplication,
  partnerApplicationIdentityHash,
  type PartnerAccessApplicationInput,
} from "@/lib/partner-portal-onboarding";
import {
  createPartnerActivationChallengeInTransaction,
  type PartnerApplicantPrincipal,
} from "@/lib/partner-purpose-auth";
import {
  createPortalV2StrongEtag,
  evaluatePortalV2RevisionPrecondition,
  type PortalV2ErrorHttpResponse,
} from "@/lib/portal-v2-contract";
import { normalizedEmailDomain } from "@/lib/partner-portal-v2-security";
import type { TeamMutationTransaction } from "@/lib/team-mutation";

const PERSONAS = [
  "contractor",
  "real_estate_agent",
  "property_manager",
  "commercial_client",
  "other",
] as const;
const RESOLUTION_CHOICES = [
  "join_existing",
  "create_new",
  "manual_review",
] as const;
const PUBLIC_EMAIL_DOMAINS = new Set([
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

const nullablePhone = z.union([z.string().trim().min(7).max(32), z.null()]);
const nullableWebsite = z.union([z.string().trim().url().max(500), z.null()]);
const draftPatchSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    phone: nullablePhone.optional(),
    companyName: z.string().trim().min(2).max(160).optional(),
    website: nullableWebsite.optional(),
    partnerType: z.enum(PERSONAS).optional(),
    serviceAreas: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
    requestedNeeds: z
      .array(z.string().trim().min(1).max(100))
      .max(20)
      .optional(),
    companyResolutionChoice: z.enum(RESOLUTION_CHOICES).optional(),
    companyCandidateId: z
      .union([z.string().regex(/^[A-Za-z0-9_-]{43}$/u), z.null()])
      .optional(),
  })
  .strict();

const submitSchema = draftPatchSchema
  .required({
    name: true,
    phone: true,
    companyName: true,
    website: true,
    partnerType: true,
    serviceAreas: true,
    requestedNeeds: true,
    companyResolutionChoice: true,
  })
  .extend({
    termsAccepted: z.literal(true),
    termsVersion: z.literal(PARTNER_TERMS_VERSION),
    privacyAccepted: z.literal(true),
    privacyVersion: z.literal(PARTNER_PRIVACY_VERSION),
  })
  .strict();

const responseSchema = draftPatchSchema
  .extend({ response: z.string().trim().min(1).max(2_000) })
  .strict();

export type PartnerApplicationDraftPatch = z.infer<typeof draftPatchSchema>;
export type PartnerApplicationSubmitInput = z.infer<typeof submitSchema>;
export type PartnerApplicationResponseInput = z.infer<typeof responseSchema>;

type CompanyCandidate = {
  id: string;
  accountId: string;
  accountLabel: string;
};

type CompanyCandidateLookup =
  | { state: "match"; candidate: CompanyCandidate }
  | { state: "none" | "reconciliation_required" };

function candidateSecret(): string | null {
  const secret =
    process.env["PARTNER_APPLICATION_CANDIDATE_SECRET"]?.trim() ||
    process.env["TEAM_AUTH_RATE_LIMIT_SECRET"]?.trim() ||
    process.env["ADMIN_API_KEY"]?.trim();
  if (secret && Buffer.byteLength(secret, "utf8") >= 32) return secret;
  return process.env["NODE_ENV"] === "production"
    ? null
    : "stonegate-partner-candidate-development-only-secret";
}

function companyCandidateId(accountId: string, domain: string): string | null {
  const secret = candidateSecret();
  if (!secret) return null;
  return createHmac("sha256", secret)
    .update("partner-company-candidate\0", "utf8")
    .update(accountId, "utf8")
    .update("\0", "utf8")
    .update(domain, "utf8")
    .digest("base64url");
}

async function loadCompanyCandidate(
  normalizedEmail: string,
): Promise<CompanyCandidateLookup> {
  const domain = normalizedEmailDomain(normalizedEmail);
  if (!domain || PUBLIC_EMAIL_DOMAINS.has(domain)) return { state: "none" };
  const rows = await getDb()
    .select({ id: partnerAccounts.id, name: partnerAccounts.name })
    .from(partnerAccountDomains)
    .innerJoin(
      partnerAccounts,
      eq(partnerAccountDomains.partnerAccountId, partnerAccounts.id),
    )
    .where(
      and(
        eq(partnerAccountDomains.normalizedDomain, domain),
        eq(partnerAccountDomains.status, "verified"),
        eq(partnerAccounts.portalAccessEnabled, true),
      ),
    )
    .orderBy(desc(partnerAccounts.updatedAt), desc(partnerAccounts.id))
    .limit(2);
  if (rows.length > 1) return { state: "reconciliation_required" };
  if (rows.length !== 1 || !rows[0]) return { state: "none" };
  const id = companyCandidateId(rows[0].id, domain);
  return id
    ? {
        state: "match",
        candidate: {
          id,
          accountId: rows[0].id,
          accountLabel: rows[0].name,
        },
      }
    : { state: "reconciliation_required" };
}

function normalizeDraftPayload(value: Record<string, unknown>) {
  const parsed = draftPatchSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

function draftRevision(input: { sessionId: string; draftVersion: number }) {
  return `applicant-draft:${input.sessionId}:${input.draftVersion}`;
}

function applicationRevision(input: {
  id: string;
  version: number;
  updatedAt: Date;
}) {
  return `applicant-application:${input.id}:${input.version}:${input.updatedAt.toISOString()}`;
}

export function parsePartnerApplicationDraftPatch(
  value: unknown,
): PartnerApplicationDraftPatch | null {
  const parsed = draftPatchSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parsePartnerApplicationSubmission(
  value: unknown,
): PartnerApplicationSubmitInput | null {
  const parsed = submitSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parsePartnerApplicationResponse(
  value: unknown,
): PartnerApplicationResponseInput | null {
  const parsed = responseSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function completeApplicationInput(
  email: string,
  value: PartnerApplicationSubmitInput,
): PartnerAccessApplicationInput | null {
  return parsePartnerAccessApplication({
    email,
    name: value.name,
    phone: value.phone,
    companyName: value.companyName,
    website: value.website,
    partnerType: value.partnerType,
    serviceAreas: value.serviceAreas,
    requestedNeeds: value.requestedNeeds,
    termsAccepted: true,
    termsVersion: value.termsVersion,
    privacyAccepted: true,
    privacyVersion: value.privacyVersion,
  });
}

async function loadApplicationForApplicant(
  principal: PartnerApplicantPrincipal,
) {
  if (!principal.applicationId) return null;
  const [row] = await getDb()
    .select()
    .from(partnerAccessApplications)
    .where(
      and(
        eq(partnerAccessApplications.id, principal.applicationId),
        eq(
          partnerAccessApplications.normalizedEmail,
          principal.normalizedEmail,
        ),
        eq(partnerAccessApplications.flowVersion, 2),
      ),
    )
    .limit(1);
  return row ?? null;
}

function fieldsFromApplication(
  row: NonNullable<Awaited<ReturnType<typeof loadApplicationForApplicant>>>,
) {
  return {
    name: row.name,
    phone: row.phone ?? null,
    companyName: row.companyName,
    website: row.website ?? null,
    partnerType: row.partnerType as (typeof PERSONAS)[number],
    serviceAreas: row.serviceAreas,
    requestedNeeds: row.requestedNeeds,
    companyResolutionChoice:
      row.companyResolutionChoice ?? ("manual_review" as const),
    companyCandidateId: row.companyCandidateId ?? null,
  };
}

export async function getPartnerApplicantApplication(
  principal: PartnerApplicantPrincipal,
) {
  const row = await loadApplicationForApplicant(principal);
  const candidateLookup = await loadCompanyCandidate(principal.normalizedEmail);
  const candidate =
    candidateLookup.state === "match" ? candidateLookup.candidate : null;
  const draft = row
    ? fieldsFromApplication(row)
    : normalizeDraftPayload(principal.draftPayload);
  const choice = draft.companyResolutionChoice ?? ("manual_review" as const);
  const matchingCandidate =
    candidate &&
    (!draft.companyCandidateId || draft.companyCandidateId === candidate.id)
      ? candidate
      : null;
  const etag = row
    ? createPortalV2StrongEtag(applicationRevision(row))
    : createPortalV2StrongEtag(draftRevision(principal));
  return {
    application: {
      id: row?.id ?? principal.sessionId,
      status: row?.status ?? "draft",
      version: row?.version ?? principal.draftVersion,
      email: principal.normalizedEmail,
      emailVerified: true,
      name: draft.name ?? "",
      phone: draft.phone ?? null,
      companyName: draft.companyName ?? "",
      website: draft.website ?? null,
      partnerType: draft.partnerType ?? null,
      serviceAreas: draft.serviceAreas ?? [],
      requestedNeeds: draft.requestedNeeds ?? [],
      companyResolution: {
        choice,
        reconciliationRequired:
          candidateLookup.state === "reconciliation_required",
        ...(matchingCandidate
          ? {
              candidateId: matchingCandidate.id,
              accountLabel: matchingCandidate.accountLabel,
            }
          : {}),
      },
      informationRequest:
        row?.status === "needs_information" ? row.reviewNote : null,
      applicantResponse: row?.applicantResponse ?? null,
      submittedAt: row?.submittedAt.toISOString() ?? null,
      updatedAt: (row?.updatedAt ?? principal.updatedAt).toISOString(),
      etag,
    },
    requirements: {
      termsVersion: PARTNER_TERMS_VERSION,
      privacyVersion: PARTNER_PRIVACY_VERSION,
      partnerTypes: PERSONAS,
      companyMatchState: candidateLookup.state,
    },
    etag,
  };
}

export type PartnerApplicantMutationResult =
  | {
      kind: "success";
      view: Awaited<ReturnType<typeof getPartnerApplicantApplication>>;
    }
  | { kind: "precondition"; response: PortalV2ErrorHttpResponse }
  | { kind: "invalid_candidate" | "conflict" | "not_found" };

/**
 * Creates canonical tenant authority only inside the staff approval
 * transaction. Flow-V1 bootstrap records deliberately never call this path.
 */
export async function provisionVerificationFirstPartnerApplication(
  tx: TeamMutationTransaction,
  input: {
    application: {
      id: string;
      flowVersion: number;
      normalizedEmail: string;
      name: string;
      phone: string | null;
      phoneE164: string | null;
      companyName: string;
      website: string | null;
      partnerType: string;
      companyResolutionChoice: string | null;
      requestedPartnerAccountId: string | null;
      emailVerifiedAt: Date | null;
    };
    correlationId: string;
    now: Date;
    access: {
      roleKey: PartnerLaunchRoleKey;
      accessLevel: "account" | "scoped";
      locationIds: string[];
      costCenterIds: string[];
    };
  },
): Promise<{
  accountId: string;
  userId: string;
  membershipId: string;
  roleKey: PartnerLaunchRoleKey;
  existingIdentity: boolean;
}> {
  const application = input.application;
  if (application.flowVersion !== 2 || !application.emailVerifiedAt) {
    throw new Error("verification_first_application_invalid");
  }
  if (!isPartnerLaunchRoleKey(input.access.roleKey)) {
    throw new Error("partner_role_invalid");
  }
  const joiningExisting =
    application.companyResolutionChoice === "join_existing";
  if (
    !joiningExisting &&
    (input.access.roleKey !== "administrator" ||
      input.access.accessLevel !== "account" ||
      input.access.locationIds.length > 0 ||
      input.access.costCenterIds.length > 0)
  ) {
    throw new Error("new_company_administrator_required");
  }
  if (
    input.access.roleKey === "administrator" &&
    input.access.accessLevel !== "account"
  ) {
    throw new Error("administrator_scope_invalid");
  }
  const scopeCount =
    input.access.locationIds.length + input.access.costCenterIds.length;
  if (
    (input.access.accessLevel === "account" && scopeCount !== 0) ||
    (input.access.accessLevel === "scoped" && scopeCount === 0)
  ) {
    throw new Error("partner_scope_invalid");
  }

  const [selectedRole] = await tx
    .select({
      id: partnerRoleTemplates.id,
      key: partnerRoleTemplates.key,
      capabilities: partnerRoleTemplates.capabilities,
    })
    .from(partnerRoleTemplates)
    .where(
      and(
        eq(partnerRoleTemplates.key, input.access.roleKey),
        isNull(partnerRoleTemplates.partnerAccountId),
        eq(partnerRoleTemplates.active, true),
        eq(partnerRoleTemplates.isSystem, true),
      ),
    )
    .for("share")
    .limit(1);
  if (!selectedRole || !isPartnerLaunchRoleKey(selectedRole.key)) {
    throw new Error("partner_role_unavailable");
  }
  let accountId: string;
  if (application.companyResolutionChoice === "join_existing") {
    const verifiedDomain = normalizedEmailDomain(application.normalizedEmail);
    if (!application.requestedPartnerAccountId || !verifiedDomain) {
      throw new Error("requested_partner_account_missing");
    }
    const [account] = await tx
      .select({
        id: partnerAccounts.id,
        portalAccessEnabled: partnerAccounts.portalAccessEnabled,
      })
      .from(partnerAccounts)
      .innerJoin(
        partnerAccountDomains,
        and(
          eq(partnerAccountDomains.partnerAccountId, partnerAccounts.id),
          eq(partnerAccountDomains.normalizedDomain, verifiedDomain),
          eq(partnerAccountDomains.status, "verified"),
        ),
      )
      .where(eq(partnerAccounts.id, application.requestedPartnerAccountId))
      .for("update")
      .limit(1);
    if (!account?.portalAccessEnabled) {
      throw new Error("requested_partner_account_unavailable");
    }
    accountId = account.id;
  } else {
    const [account] = await tx
      .insert(partnerAccounts)
      .values({
        name: application.companyName,
        normalizedName: application.companyName.toLowerCase(),
        website: application.website,
        segment: application.partnerType,
        status: "portal_partner",
        source: "partner_portal_access_application",
        portalFit: "application_approved",
        portalAccessEnabled: true,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning({ id: partnerAccounts.id });
    if (!account) throw new Error("approved_partner_account_not_created");
    accountId = account.id;
    await tx.insert(partnerEvidenceRequirements).values([
      {
        partnerAccountId: accountId,
        category: "before",
        required: true,
        minimumCount: 1,
        source: "account_default",
        createdAt: input.now,
        updatedAt: input.now,
      },
      {
        partnerAccountId: accountId,
        category: "after",
        required: true,
        minimumCount: 1,
        source: "account_default",
        createdAt: input.now,
        updatedAt: input.now,
      },
    ]);
  }

  if (input.access.accessLevel === "scoped") {
    const [locations, costCenters] = await Promise.all([
      input.access.locationIds.length === 0
        ? Promise.resolve([])
        : tx
            .select({ id: partnerAccountLocations.id })
            .from(partnerAccountLocations)
            .where(
              and(
                eq(partnerAccountLocations.partnerAccountId, accountId),
                eq(partnerAccountLocations.active, true),
                inArray(partnerAccountLocations.id, input.access.locationIds),
              ),
            ),
      input.access.costCenterIds.length === 0
        ? Promise.resolve([])
        : tx
            .select({ id: partnerAccountCostCenters.id })
            .from(partnerAccountCostCenters)
            .where(
              and(
                eq(partnerAccountCostCenters.partnerAccountId, accountId),
                eq(partnerAccountCostCenters.active, true),
                inArray(
                  partnerAccountCostCenters.id,
                  input.access.costCenterIds,
                ),
              ),
            ),
    ]);
    if (
      locations.length !== input.access.locationIds.length ||
      costCenters.length !== input.access.costCenterIds.length
    ) {
      throw new Error("partner_scope_resource_invalid");
    }
  }

  const identities = await tx
    .select({
      id: partnerUsers.id,
      active: partnerUsers.active,
      identityStatus: partnerUsers.identityStatus,
      securityVersion: partnerUsers.securityVersion,
    })
    .from(partnerUsers)
    .where(eq(partnerUsers.normalizedEmail, application.normalizedEmail))
    .for("update")
    .limit(2);
  if (identities.length > 1) throw new Error("partner_identity_ambiguous");
  const existingIdentity = identities[0] ?? null;
  if (
    existingIdentity &&
    !["active", "pending_activation"].includes(existingIdentity.identityStatus)
  ) {
    throw new Error("partner_identity_restricted");
  }
  let userId: string;
  let securityVersion: number;
  if (existingIdentity) {
    userId = existingIdentity.id;
    securityVersion = existingIdentity.securityVersion;
    await tx
      .update(partnerUsers)
      .set({
        emailVerifiedAt: application.emailVerifiedAt,
        updatedAt: input.now,
      })
      .where(eq(partnerUsers.id, existingIdentity.id));
  } else {
    const [user] = await tx
      .insert(partnerUsers)
      .values({
        orgContactId: null,
        email: application.normalizedEmail,
        normalizedEmail: application.normalizedEmail,
        name: application.name,
        phone: application.phone,
        phoneE164: application.phoneE164,
        active: false,
        identityStatus: "pending_activation",
        emailVerifiedAt: application.emailVerifiedAt,
        mfaRequired: false,
        securityVersion: 1,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning({
        id: partnerUsers.id,
        securityVersion: partnerUsers.securityVersion,
      });
    if (!user) throw new Error("approved_partner_identity_not_created");
    userId = user.id;
    securityVersion = user.securityVersion;
  }

  const [existingMembership] = await tx
    .select({ id: partnerAccountMemberships.id })
    .from(partnerAccountMemberships)
    .where(
      and(
        eq(partnerAccountMemberships.partnerAccountId, accountId),
        eq(partnerAccountMemberships.partnerUserId, userId),
      ),
    )
    .limit(1);
  if (existingMembership) throw new Error("partner_membership_already_exists");
  const [defaultMembership] = await tx
    .select({ id: partnerAccountMemberships.id })
    .from(partnerAccountMemberships)
    .where(
      and(
        eq(partnerAccountMemberships.partnerUserId, userId),
        eq(partnerAccountMemberships.status, "active"),
        eq(partnerAccountMemberships.isDefault, true),
      ),
    )
    .limit(1);
  const [membership] = await tx
    .insert(partnerAccountMemberships)
    .values({
      partnerAccountId: accountId,
      partnerUserId: userId,
      roleTemplateId: selectedRole.id,
      roleKey: selectedRole.key,
      status: "invited",
      persona: application.partnerType as
        | "contractor"
        | "real_estate_agent"
        | "property_manager"
        | "commercial_client"
        | "other",
      accessLevel: input.access.accessLevel,
      accessScope:
        input.access.accessLevel === "account"
          ? {}
          : {
              locationIds: input.access.locationIds,
              costCenterIds: input.access.costCenterIds,
            },
      preferences: {
        timezone: "America/New_York",
        notificationChannels: ["email", "in_portal"],
      },
      isDefault: !defaultMembership,
      invitedAt: input.now,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning({ id: partnerAccountMemberships.id });
  if (!membership) throw new Error("approved_partner_membership_not_created");
  if (input.access.locationIds.length > 0) {
    await tx.insert(partnerMembershipLocationScopes).values(
      input.access.locationIds.map((locationId) => ({
        membershipId: membership.id,
        partnerAccountId: accountId,
        locationId,
        createdAt: input.now,
      })),
    );
  }
  if (input.access.costCenterIds.length > 0) {
    await tx.insert(partnerMembershipCostCenterScopes).values(
      input.access.costCenterIds.map((costCenterId) => ({
        membershipId: membership.id,
        partnerAccountId: accountId,
        costCenterId,
        createdAt: input.now,
      })),
    );
  }
  await createPartnerActivationChallengeInTransaction(tx, {
    partnerUserId: userId,
    partnerAccountId: accountId,
    partnerMembershipId: membership.id,
    applicationId: application.id,
    normalizedEmail: application.normalizedEmail,
    securityVersion,
    correlationId: input.correlationId,
    now: input.now,
  });
  return {
    accountId,
    userId,
    membershipId: membership.id,
    roleKey: selectedRole.key,
    existingIdentity: Boolean(existingIdentity),
  };
}

export async function savePartnerApplicantDraft(input: {
  principal: PartnerApplicantPrincipal;
  patch: PartnerApplicationDraftPatch;
  ifMatch: string | null;
  correlationId: string;
}): Promise<PartnerApplicantMutationResult> {
  const candidateLookup = await loadCompanyCandidate(
    input.principal.normalizedEmail,
  );
  const candidate =
    candidateLookup.state === "match" ? candidateLookup.candidate : null;
  if (
    input.patch.companyCandidateId &&
    (!candidate || input.patch.companyCandidateId !== candidate.id)
  ) {
    return { kind: "invalid_candidate" };
  }
  const db = getDb();
  const result = await db.transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(partnerApplicantSessions)
      .where(eq(partnerApplicantSessions.id, input.principal.sessionId))
      .for("update")
      .limit(1);
    const now = new Date();
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= now ||
      session.normalizedEmail !== input.principal.normalizedEmail
    ) {
      return { kind: "not_found" as const };
    }
    if (session.applicationId) return { kind: "conflict" as const };
    const precondition = evaluatePortalV2RevisionPrecondition({
      ifMatch: input.ifMatch,
      currentRevision: draftRevision({
        sessionId: session.id,
        draftVersion: session.draftVersion,
      }),
      correlationId: input.correlationId,
    });
    if (!precondition.ok) {
      return { kind: "precondition" as const, response: precondition.response };
    }
    const merged = draftPatchSchema.safeParse({
      ...normalizeDraftPayload(session.draftPayload),
      ...input.patch,
      ...(input.patch.companyResolutionChoice &&
      input.patch.companyResolutionChoice !== "join_existing"
        ? { companyCandidateId: null }
        : {}),
    });
    if (!merged.success) return { kind: "conflict" as const };
    const [updated] = await tx
      .update(partnerApplicantSessions)
      .set({
        draftPayload: merged.data,
        draftVersion: sql`${partnerApplicantSessions.draftVersion} + 1`,
        updatedAt: now,
        lastSeenAt: now,
      })
      .where(
        and(
          eq(partnerApplicantSessions.id, session.id),
          eq(partnerApplicantSessions.draftVersion, session.draftVersion),
          isNull(partnerApplicantSessions.applicationId),
          isNull(partnerApplicantSessions.revokedAt),
          gt(partnerApplicantSessions.expiresAt, now),
        ),
      )
      .returning({ draftVersion: partnerApplicantSessions.draftVersion });
    return updated
      ? { kind: "updated" as const }
      : { kind: "conflict" as const };
  });
  if (result.kind !== "updated") return result;
  const refreshed = {
    ...input.principal,
    draftPayload: {
      ...normalizeDraftPayload(input.principal.draftPayload),
      ...input.patch,
      ...(input.patch.companyResolutionChoice &&
      input.patch.companyResolutionChoice !== "join_existing"
        ? { companyCandidateId: null }
        : {}),
    },
    draftVersion: input.principal.draftVersion + 1,
    updatedAt: new Date(),
  };
  return {
    kind: "success",
    view: await getPartnerApplicantApplication(refreshed),
  };
}

export async function submitPartnerApplicantApplication(input: {
  principal: PartnerApplicantPrincipal;
  payload: PartnerApplicationSubmitInput;
  correlationId: string;
  idempotencyKeyHash: string;
}): Promise<PartnerApplicantMutationResult> {
  const parsed = completeApplicationInput(
    input.principal.normalizedEmail,
    input.payload,
  );
  if (!parsed) return { kind: "conflict" };
  const candidateLookup = await loadCompanyCandidate(
    input.principal.normalizedEmail,
  );
  const candidate =
    candidateLookup.state === "match" ? candidateLookup.candidate : null;
  let requestedPartnerAccountId: string | null = null;
  let storedCandidateId: string | null = null;
  if (input.payload.companyResolutionChoice === "join_existing") {
    if (
      !candidate ||
      !input.payload.companyCandidateId ||
      input.payload.companyCandidateId !== candidate.id
    ) {
      return { kind: "invalid_candidate" };
    }
    requestedPartnerAccountId = candidate.accountId;
    storedCandidateId = candidate.id;
  }
  const now = new Date();
  const db = getDb();
  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`partner-application:${partnerApplicationIdentityHash(parsed.email)}`}))`,
    );
    const [session] = await tx
      .select()
      .from(partnerApplicantSessions)
      .where(eq(partnerApplicantSessions.id, input.principal.sessionId))
      .for("update")
      .limit(1);
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= now ||
      session.applicationId ||
      session.normalizedEmail !== parsed.email
    ) {
      return { kind: "conflict" as const };
    }
    const [verification] = await tx
      .select({
        id: partnerAuthChallenges.id,
        normalizedEmail: partnerAuthChallenges.normalizedEmail,
        purpose: partnerAuthChallenges.purpose,
        status: partnerAuthChallenges.status,
        consumedAt: partnerAuthChallenges.consumedAt,
      })
      .from(partnerAuthChallenges)
      .where(
        and(
          eq(partnerAuthChallenges.id, session.verificationChallengeId),
          eq(partnerAuthChallenges.purpose, "email_verification"),
          eq(partnerAuthChallenges.status, "consumed"),
        ),
      )
      .for("share")
      .limit(1);
    if (
      !verification?.consumedAt ||
      verification.normalizedEmail !== parsed.email
    ) {
      return { kind: "conflict" as const };
    }
    const [existing] = await tx
      .select({ id: partnerAccessApplications.id })
      .from(partnerAccessApplications)
      .where(
        and(
          eq(
            partnerAccessApplications.identityHash,
            partnerApplicationIdentityHash(parsed.email),
          ),
          or(
            eq(partnerAccessApplications.status, "submitted"),
            eq(partnerAccessApplications.status, "under_review"),
            eq(partnerAccessApplications.status, "needs_information"),
          ),
        ),
      )
      .limit(1);
    if (existing) return { kind: "conflict" as const };
    const [application] = await tx
      .insert(partnerAccessApplications)
      .values({
        identityHash: partnerApplicationIdentityHash(parsed.email),
        email: parsed.email,
        normalizedEmail: parsed.email,
        name: parsed.name,
        phone: parsed.phone,
        phoneE164: parsed.phoneE164,
        companyName: parsed.companyName,
        website: parsed.website,
        partnerType: parsed.partnerType,
        serviceAreas: parsed.serviceAreas,
        requestedNeeds: parsed.requestedNeeds,
        flowVersion: 2,
        emailVerificationChallengeId: verification.id,
        applicantSessionId: session.id,
        companyResolutionChoice: input.payload.companyResolutionChoice,
        companyCandidateId: storedCandidateId,
        requestedPartnerAccountId,
        status: "submitted",
        applicantPartnerUserId: null,
        bootstrapPartnerAccountId: null,
        emailVerifiedAt: verification.consumedAt,
        termsAcceptedAt: now,
        privacyAcceptedAt: now,
        submittedAt: now,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: partnerAccessApplications.id });
    if (!application) throw new Error("partner_application_not_created");
    const [sessionUpdated] = await tx
      .update(partnerApplicantSessions)
      .set({
        applicationId: application.id,
        draftPayload: input.payload,
        draftVersion: sql`${partnerApplicantSessions.draftVersion} + 1`,
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(partnerApplicantSessions.id, session.id),
          isNull(partnerApplicantSessions.applicationId),
          isNull(partnerApplicantSessions.revokedAt),
        ),
      )
      .returning({ id: partnerApplicantSessions.id });
    if (!sessionUpdated)
      throw new Error("partner_application_session_not_linked");
    await tx
      .update(partnerAuthChallenges)
      .set({ applicationId: application.id, updatedAt: now })
      .where(eq(partnerAuthChallenges.id, verification.id));
    await tx.insert(auditLogs).values({
      actorType: "system",
      actorLabel: "verified_partner_applicant",
      authMethod: "verified_email_session",
      correlationId: input.correlationId,
      idempotencyKeyHash: input.idempotencyKeyHash,
      outcome: "succeeded",
      surface: "partner_portal_v2",
      action: "partner.access_application.submitted",
      entityType: "partner_access_application",
      entityId: application.id,
      meta: {
        flowVersion: 2,
        applicantSessionId: session.id,
        emailVerificationChallengeId: verification.id,
        companyResolutionChoice: input.payload.companyResolutionChoice,
        requestedPartnerAccountId,
        tenantProvisioned: false,
      },
      createdAt: now,
    });
    return { kind: "created" as const, applicationId: application.id };
  });
  if (result.kind !== "created") return result;
  return {
    kind: "success",
    view: await getPartnerApplicantApplication({
      ...input.principal,
      applicationId: result.applicationId,
    }),
  };
}

export async function respondToPartnerApplication(input: {
  principal: PartnerApplicantPrincipal;
  payload: PartnerApplicationResponseInput;
  ifMatch: string | null;
  correlationId: string;
}): Promise<PartnerApplicantMutationResult> {
  const db = getDb();
  const current = await loadApplicationForApplicant(input.principal);
  if (!current) return { kind: "not_found" };
  const precondition = evaluatePortalV2RevisionPrecondition({
    ifMatch: input.ifMatch,
    currentRevision: applicationRevision(current),
    correlationId: input.correlationId,
  });
  if (!precondition.ok) {
    return { kind: "precondition", response: precondition.response };
  }
  if (current.status !== "needs_information") return { kind: "conflict" };
  const candidateLookup = await loadCompanyCandidate(
    input.principal.normalizedEmail,
  );
  const candidate =
    candidateLookup.state === "match" ? candidateLookup.candidate : null;
  const mergedDraft = {
    ...fieldsFromApplication(current),
    ...input.payload,
  };
  const complete = completeApplicationInput(input.principal.normalizedEmail, {
    ...mergedDraft,
    termsAccepted: true,
    termsVersion: PARTNER_TERMS_VERSION,
    privacyAccepted: true,
    privacyVersion: PARTNER_PRIVACY_VERSION,
  });
  if (!complete) return { kind: "conflict" };
  let requestedPartnerAccountId: string | null = null;
  let storedCandidateId: string | null = null;
  if (mergedDraft.companyResolutionChoice === "join_existing") {
    if (!candidate || mergedDraft.companyCandidateId !== candidate.id) {
      return { kind: "invalid_candidate" };
    }
    requestedPartnerAccountId = candidate.accountId;
    storedCandidateId = candidate.id;
  }
  const now = new Date();
  const [updated] = await db
    .update(partnerAccessApplications)
    .set({
      name: complete.name,
      phone: complete.phone,
      phoneE164: complete.phoneE164,
      companyName: complete.companyName,
      website: complete.website,
      partnerType: complete.partnerType,
      serviceAreas: complete.serviceAreas,
      requestedNeeds: complete.requestedNeeds,
      companyResolutionChoice: mergedDraft.companyResolutionChoice,
      companyCandidateId: storedCandidateId,
      requestedPartnerAccountId,
      applicantResponse: input.payload.response,
      status: "submitted",
      version: sql`${partnerAccessApplications.version} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(partnerAccessApplications.id, current.id),
        eq(
          partnerAccessApplications.normalizedEmail,
          input.principal.normalizedEmail,
        ),
        eq(partnerAccessApplications.status, "needs_information"),
        eq(partnerAccessApplications.version, current.version),
      ),
    )
    .returning({ id: partnerAccessApplications.id });
  if (!updated) return { kind: "conflict" };
  await db.insert(auditLogs).values({
    actorType: "system",
    actorLabel: "verified_partner_applicant",
    authMethod: "verified_email_session",
    correlationId: input.correlationId,
    outcome: "succeeded",
    surface: "partner_portal_v2",
    action: "partner.access_application.information_provided",
    entityType: "partner_access_application",
    entityId: current.id,
    meta: { applicantSessionId: input.principal.sessionId },
    createdAt: now,
  });
  return {
    kind: "success",
    view: await getPartnerApplicantApplication(input.principal),
  };
}

export async function withdrawPartnerApplicantApplication(input: {
  principal: PartnerApplicantPrincipal;
  ifMatch: string | null;
  correlationId: string;
}): Promise<PartnerApplicantMutationResult> {
  const current = await loadApplicationForApplicant(input.principal);
  if (!current) return { kind: "not_found" };
  const precondition = evaluatePortalV2RevisionPrecondition({
    ifMatch: input.ifMatch,
    currentRevision: applicationRevision(current),
    correlationId: input.correlationId,
  });
  if (!precondition.ok) {
    return { kind: "precondition", response: precondition.response };
  }
  if (
    !["submitted", "under_review", "needs_information"].includes(current.status)
  ) {
    return { kind: "conflict" };
  }
  const now = new Date();
  const [updated] = await getDb()
    .update(partnerAccessApplications)
    .set({
      status: "withdrawn",
      version: sql`${partnerAccessApplications.version} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(partnerAccessApplications.id, current.id),
        eq(
          partnerAccessApplications.normalizedEmail,
          input.principal.normalizedEmail,
        ),
        eq(partnerAccessApplications.version, current.version),
        or(
          eq(partnerAccessApplications.status, "submitted"),
          eq(partnerAccessApplications.status, "under_review"),
          eq(partnerAccessApplications.status, "needs_information"),
        ),
      ),
    )
    .returning({ id: partnerAccessApplications.id });
  if (!updated) return { kind: "conflict" };
  await getDb()
    .insert(auditLogs)
    .values({
      actorType: "system",
      actorLabel: "verified_partner_applicant",
      authMethod: "verified_email_session",
      correlationId: input.correlationId,
      outcome: "succeeded",
      surface: "partner_portal_v2",
      action: "partner.access_application.withdrawn",
      entityType: "partner_access_application",
      entityId: current.id,
      meta: { applicantSessionId: input.principal.sessionId },
      createdAt: now,
    });
  return {
    kind: "success",
    view: await getPartnerApplicantApplication(input.principal),
  };
}
