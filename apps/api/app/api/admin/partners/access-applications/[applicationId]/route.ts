import { createHash } from "node:crypto";
import type { MutationResult } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import {
  contacts,
  getDb,
  partnerAccessApplications,
  partnerAccountMemberships,
  partnerAccounts,
  partnerNotificationPreferences,
  partnerNotifications,
  partnerRoleTemplates,
  partnerSessions,
  partnerUsers,
} from "@/db";
import { isAdminRequest } from "../../../../web/admin";
import { requirePermission } from "@/lib/permissions";
import {
  findStaffAccessApplication,
  isActiveStaffAccessApplicationStatus,
  isStaffAccessApplicationId,
  parseStaffAccessApplicationDecision,
  type StaffAccessApplicationDecision,
} from "@/lib/partner-access-application-administration";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
  teamMutationIdempotencyReplayResponse,
} from "@/lib/team-mutation-idempotency";
import {
  assertTeamMutationExpectedVersion,
  beginTeamMutation,
  recordTeamMutationFailure,
  TeamMutationFailure,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
  type TeamMutationContext,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";
import { resolvePublicSiteBaseUrl } from "@/lib/partner-portal-auth";
import {
  arePartnerPortalApplicantNotificationsEnabled,
  arePartnerPortalOutboundNotificationsEnabled,
} from "@/lib/partner-portal-feature-flags";
import { queuePartnerAccessApplicationDecisionEmail } from "@/lib/partner-access-application-email-delivery";
import { provisionVerificationFirstPartnerApplication } from "@/lib/partner-verification-onboarding";
import { nextQuietHoursEnd } from "@/lib/policy";
import { queueSystemOutboundMessage } from "@/lib/system-outbound";
import type { PartnerLaunchRoleKey } from "@/lib/partner-account-authorization";

const BODY_MAXIMUM_BYTES = 8 * 1024;
const BODY_DEADLINE_MS = 5_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" } as const;

type ApplicationDecisionData = {
  application: {
    id: string;
    status: "needs_information" | "approved" | "declined";
    version: string;
    reviewedAt: string;
  };
  access: {
    state: "limited" | "activation_required" | "disabled";
    roleKey: "applicant" | "admin" | PartnerLaunchRoleKey | null;
  };
};

type AccessDecisionStatus = "needs_information" | "approved" | "declined";
type AccessNotificationTarget = {
  accountId: string | null;
  accountName: string;
  membershipId: string | null;
  userName: string;
  userEmail: string;
  userContactId: string | null;
  inAppAccessible: boolean;
};
type AccessNotificationOutcome = {
  inApp: "queued" | "preference_suppressed" | "membership_unavailable";
  email:
    | "queued"
    | "preference_suppressed"
    | "feature_disabled"
    | "recipient_suppressed";
  outboxEventId?: string;
};

function safeDisplayText(
  value: string,
  fallback: string,
  maximum: number,
): string {
  const normalized = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127 ? " " : character;
  })
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  return (normalized || fallback).slice(0, maximum);
}

function accessNotificationId(input: {
  applicationId: string;
  status: AccessDecisionStatus;
  version: number;
}): { id: string; operationHash: string } {
  const operationHash = createHash("sha256")
    .update(
      `partner-access-application-decision\0${input.applicationId}\0${input.status}\0${input.version}`,
    )
    .digest("hex");
  const chars = operationHash.slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16] ?? "0", 16) & 0x3) | 0x8).toString(
    16,
  );
  const hex = chars.join("");
  return {
    id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    operationHash,
  };
}

async function loadAccessNotificationTarget(
  tx: TeamMutationTransaction,
  application: {
    applicantPartnerUserId: string | null;
    bootstrapPartnerAccountId: string | null;
    normalizedEmail: string;
    companyName: string;
  },
): Promise<AccessNotificationTarget | null> {
  if (!application.applicantPartnerUserId) return null;
  const [user] = await tx
    .select({
      id: partnerUsers.id,
      name: partnerUsers.name,
      email: partnerUsers.email,
      orgContactId: partnerUsers.orgContactId,
      active: partnerUsers.active,
    })
    .from(partnerUsers)
    .where(eq(partnerUsers.id, application.applicantPartnerUserId))
    .limit(1);
  if (
    !user?.active ||
    user.email.normalize("NFKC").trim().toLowerCase() !==
      application.normalizedEmail.normalize("NFKC").trim().toLowerCase()
  ) {
    return null;
  }
  if (!application.bootstrapPartnerAccountId) {
    return {
      accountId: null,
      accountName: application.companyName,
      membershipId: null,
      userName: user.name,
      userEmail: user.email,
      userContactId: user.orgContactId,
      inAppAccessible: false,
    };
  }
  const [account] = await tx
    .select({
      id: partnerAccounts.id,
      name: partnerAccounts.name,
      portalAccessEnabled: partnerAccounts.portalAccessEnabled,
    })
    .from(partnerAccounts)
    .where(eq(partnerAccounts.id, application.bootstrapPartnerAccountId))
    .limit(1);
  if (!account) return null;
  const [membership] = await tx
    .select({
      id: partnerAccountMemberships.id,
      status: partnerAccountMemberships.status,
    })
    .from(partnerAccountMemberships)
    .where(
      and(
        eq(partnerAccountMemberships.partnerAccountId, account.id),
        eq(partnerAccountMemberships.partnerUserId, user.id),
      ),
    )
    .limit(1);
  return {
    accountId: account.id,
    accountName: account.name,
    membershipId: membership?.id ?? null,
    userName: user.name,
    userEmail: user.email,
    userContactId: user.orgContactId,
    inAppAccessible:
      account.portalAccessEnabled && membership?.status === "active",
  };
}

async function queueAccessDecisionNotifications(input: {
  tx: TeamMutationTransaction;
  applicationId: string;
  status: AccessDecisionStatus;
  version: number;
  target: AccessNotificationTarget | null;
  informationRequest: string | null;
  now: Date;
}): Promise<AccessNotificationOutcome> {
  const target = input.target;
  const [storedPreference] =
    target?.accountId && target.membershipId
      ? await input.tx
          .select({
            inAppEnabled: partnerNotificationPreferences.inAppEnabled,
            emailEnabled: partnerNotificationPreferences.emailEnabled,
            quietHoursStart: partnerNotificationPreferences.quietHoursStart,
            quietHoursEnd: partnerNotificationPreferences.quietHoursEnd,
            timezone: partnerNotificationPreferences.timezone,
          })
          .from(partnerNotificationPreferences)
          .where(
            and(
              eq(
                partnerNotificationPreferences.partnerAccountId,
                target.accountId,
              ),
              eq(
                partnerNotificationPreferences.membershipId,
                target.membershipId,
              ),
              eq(partnerNotificationPreferences.eventKey, "account_access"),
            ),
          )
          .limit(1)
      : [];
  const preference = storedPreference ?? {
    inAppEnabled: true,
    emailEnabled: true,
    quietHoursStart: null,
    quietHoursEnd: null,
    timezone: "America/New_York",
  };
  const companyName = safeDisplayText(
    target?.accountName ?? "your company",
    "your company",
    120,
  );
  const userName = safeDisplayText(target?.userName ?? "there", "there", 80);
  const informationRequest = input.informationRequest
    ? safeDisplayText(input.informationRequest, "", 2_000)
    : null;
  const copy =
    input.status === "approved"
      ? {
          title: "Partner access approved",
          body: `Your partner access for ${companyName} is approved. Finish setup before signing in.`,
          subject: "Your Stonegate partner access is approved",
        }
      : input.status === "declined"
        ? {
            title: "Partner access request declined",
            body: `Stonegate could not approve the partner access request for ${companyName}.`,
            subject: "Update on your Stonegate partner access request",
          }
        : {
            title: "More information needed",
            body: `Stonegate needs more information to continue the partner access request for ${companyName}.${informationRequest ? ` Requested: ${informationRequest}` : ""}`,
            subject:
              "More information is needed for your partner access request",
          };
  const { id, operationHash } = accessNotificationId(input);
  const inAppAccessible =
    input.status !== "declined" && target?.inAppAccessible === true;
  let inApp: AccessNotificationOutcome["inApp"] = inAppAccessible
    ? "preference_suppressed"
    : "membership_unavailable";
  if (
    preference.inAppEnabled &&
    inAppAccessible &&
    target?.accountId &&
    target.membershipId
  ) {
    await input.tx
      .insert(partnerNotifications)
      .values({
        id,
        partnerAccountId: target.accountId,
        membershipId: target.membershipId,
        eventKey: "account_access",
        title: copy.title,
        body: copy.body,
        actionPath: "/partners",
        createdAt: input.now,
      })
      .onConflictDoNothing({ target: partnerNotifications.id });
    inApp = "queued";
  }
  if (!preference.emailEnabled) {
    return { inApp, email: "preference_suppressed" };
  }
  if (
    !target?.accountId ||
    !arePartnerPortalOutboundNotificationsEnabled(target.accountId)
  ) {
    return { inApp, email: "feature_disabled" };
  }
  if (!target.userEmail || !target.userContactId) {
    return { inApp, email: "recipient_suppressed" };
  }
  const base = resolvePublicSiteBaseUrl();
  const portalUrl = base ? new URL("/partners", base).toString() : null;
  const body = [
    `Hi ${userName},`,
    "",
    copy.body,
    ...(portalUrl && input.status !== "declined"
      ? ["", "Open the Partner Portal:", portalUrl]
      : []),
    "",
    "This is a transactional account-access update.",
  ].join("\n");
  const nextAttemptAt =
    preference.quietHoursStart && preference.quietHoursEnd
      ? nextQuietHoursEnd(
          input.now,
          "email",
          {
            channels: {
              email: {
                start: preference.quietHoursStart,
                end: preference.quietHoursEnd,
              },
            },
          },
          preference.timezone,
        )
      : null;
  const messageId = await queueSystemOutboundMessage({
    db: input.tx,
    contactId: target.userContactId,
    channel: "email",
    toAddress: target.userEmail,
    subject: copy.subject,
    body,
    metadata: {
      partnerPortal: true,
      kind: "partner.access_application_decision",
      decision: input.status,
    },
    dedupeKey: `partner.access.decision:${operationHash}`,
    nextAttemptAt,
  });
  return { inApp, email: messageId ? "queued" : "recipient_suppressed" };
}

function translatedInputFailure(error: unknown): TeamMutationFailure {
  if (error instanceof TeamMutationFailure) return error;
  if (error instanceof BoundedJsonRequestError) {
    return new TeamMutationFailure(
      error.code === "body_timeout" ? "timeout" : "invalid",
      error.message,
      {
        status: error.status,
        retryable: error.code === "body_timeout",
        fieldErrors: { request: error.message },
      },
    );
  }
  return new TeamMutationFailure("invalid", "Send one complete decision.", {
    fieldErrors: { request: "The decision body is invalid." },
  });
}

async function failureResponse(
  mutation: TeamMutationContext,
  error: unknown,
  applicationId: string,
  boundary: "input" | "mutation",
): Promise<Response> {
  const failure =
    error instanceof TeamMutationFailure
      ? error
      : new TeamMutationFailure(
          "internal",
          "The access-application decision could not be saved. Try again.",
          { retryable: true },
        );
  await recordTeamMutationFailure(mutation, {
    outcome:
      failure.code === "invalid" ||
      failure.code === "conflict" ||
      failure.code === "forbidden"
        ? "denied"
        : "failed",
    entityType: "partner_access_application",
    entityId: isStaffAccessApplicationId(applicationId) ? applicationId : null,
    code: failure.code,
    metadata: { boundary },
  });
  const response = teamMutationExceptionResponse(failure, mutation);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

async function loadGeneratedTenantContext(
  tx: TeamMutationTransaction,
  application: {
    id: string;
    applicantPartnerUserId: string | null;
    bootstrapPartnerAccountId: string | null;
    normalizedEmail: string;
  },
) {
  if (
    !application.applicantPartnerUserId ||
    !application.bootstrapPartnerAccountId
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "This historical application does not have a verified generated-account binding. Reconcile it before approval or decline.",
    );
  }
  const [account] = await tx
    .select({
      id: partnerAccounts.id,
      status: partnerAccounts.status,
      source: partnerAccounts.source,
      portalFit: partnerAccounts.portalFit,
      portalAccessEnabled: partnerAccounts.portalAccessEnabled,
      portalContactId: partnerAccounts.portalContactId,
    })
    .from(partnerAccounts)
    .where(eq(partnerAccounts.id, application.bootstrapPartnerAccountId))
    .for("update")
    .limit(1);
  if (
    !account ||
    account.source !== "partner_portal_access_application" ||
    account.status !== "trial_partner" ||
    account.portalFit !== "application_pending" ||
    !account.portalAccessEnabled ||
    !account.portalContactId
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "The generated account changed after submission. Review the account before deciding this application.",
    );
  }

  const [portalContact] = await tx
    .select({
      id: contacts.id,
      partnerAccountId: contacts.partnerAccountId,
      partnerStatus: contacts.partnerStatus,
      deletedAt: contacts.deletedAt,
    })
    .from(contacts)
    .where(eq(contacts.id, account.portalContactId))
    .for("update")
    .limit(1);
  if (
    !portalContact ||
    portalContact.deletedAt ||
    portalContact.partnerAccountId !== account.id ||
    portalContact.partnerStatus !== "partner"
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "The generated account contact no longer passes tenant validation.",
    );
  }

  const [user] = await tx
    .select({
      id: partnerUsers.id,
      email: partnerUsers.email,
      active: partnerUsers.active,
      orgContactId: partnerUsers.orgContactId,
    })
    .from(partnerUsers)
    .where(eq(partnerUsers.id, application.applicantPartnerUserId))
    .for("update")
    .limit(1);
  if (
    !user ||
    !user.active ||
    user.orgContactId !== portalContact.id ||
    user.email.normalize("NFKC").trim().toLowerCase() !==
      application.normalizedEmail.normalize("NFKC").trim().toLowerCase()
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "The applicant identity changed after submission. Review it before deciding this application.",
    );
  }

  const [membership] = await tx
    .select({
      id: partnerAccountMemberships.id,
      roleTemplateId: partnerAccountMemberships.roleTemplateId,
      roleKey: partnerAccountMemberships.roleKey,
      status: partnerAccountMemberships.status,
      accessLevel: partnerAccountMemberships.accessLevel,
    })
    .from(partnerAccountMemberships)
    .where(
      and(
        eq(partnerAccountMemberships.partnerAccountId, account.id),
        eq(partnerAccountMemberships.partnerUserId, user.id),
      ),
    )
    .for("update")
    .limit(1);
  if (
    !membership ||
    !membership.roleTemplateId ||
    membership.roleKey !== "applicant" ||
    membership.status !== "active" ||
    membership.accessLevel !== "account"
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "The generated applicant membership changed after submission. Review it before deciding this application.",
    );
  }

  const [applicantRole] = await tx
    .select({
      id: partnerRoleTemplates.id,
      key: partnerRoleTemplates.key,
      partnerAccountId: partnerRoleTemplates.partnerAccountId,
      active: partnerRoleTemplates.active,
      isSystem: partnerRoleTemplates.isSystem,
    })
    .from(partnerRoleTemplates)
    .where(eq(partnerRoleTemplates.id, membership.roleTemplateId))
    .for("update")
    .limit(1);
  if (
    !applicantRole ||
    applicantRole.key !== "applicant" ||
    applicantRole.partnerAccountId !== account.id ||
    applicantRole.isSystem ||
    !applicantRole.active
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "The limited applicant role changed after submission. Review it before deciding this application.",
    );
  }
  return { account, membership, user };
}

async function applyDecision(
  tx: TeamMutationTransaction,
  mutation: TeamMutationContext,
  applicationId: string,
  decision: StaffAccessApplicationDecision,
): Promise<{
  data: ApplicationDecisionData;
  auditEventId: string;
  committedAt: string;
}> {
  const [application] = await tx
    .select({
      id: partnerAccessApplications.id,
      status: partnerAccessApplications.status,
      version: partnerAccessApplications.version,
      applicantPartnerUserId: partnerAccessApplications.applicantPartnerUserId,
      bootstrapPartnerAccountId:
        partnerAccessApplications.bootstrapPartnerAccountId,
      normalizedEmail: partnerAccessApplications.normalizedEmail,
      companyName: partnerAccessApplications.companyName,
      emailVerifiedAt: partnerAccessApplications.emailVerifiedAt,
      flowVersion: partnerAccessApplications.flowVersion,
      name: partnerAccessApplications.name,
      phone: partnerAccessApplications.phone,
      phoneE164: partnerAccessApplications.phoneE164,
      website: partnerAccessApplications.website,
      partnerType: partnerAccessApplications.partnerType,
      companyResolutionChoice:
        partnerAccessApplications.companyResolutionChoice,
      requestedPartnerAccountId:
        partnerAccessApplications.requestedPartnerAccountId,
    })
    .from(partnerAccessApplications)
    .where(eq(partnerAccessApplications.id, applicationId))
    .for("update")
    .limit(1);
  if (!application) {
    throw new TeamMutationFailure(
      "conflict",
      "The application was not found.",
      {
        status: 404,
      },
    );
  }
  assertTeamMutationExpectedVersion(mutation, application.version);
  if (!isActiveStaffAccessApplicationStatus(application.status)) {
    throw new TeamMutationFailure(
      "conflict",
      "This application already has a final decision and cannot be changed.",
    );
  }
  if (
    decision.action === "needs_information" &&
    application.status === "needs_information"
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "Information has already been requested. Wait for the applicant or make a final decision.",
    );
  }
  if (!mutation.actor.id || !UUID_PATTERN.test(mutation.actor.id)) {
    throw new TeamMutationFailure(
      "internal",
      "The verified staff identity is incomplete.",
    );
  }

  const now = new Date();
  const notificationTarget = await loadAccessNotificationTarget(
    tx,
    application,
  );
  const nextVersion = application.version + 1;
  let access: ApplicationDecisionData["access"] = {
    state: "limited",
    roleKey: "applicant",
  };
  let accountId: string | null = application.bootstrapPartnerAccountId;
  let membershipId: string | null = null;

  if (decision.action === "needs_information") {
    const [updated] = await tx
      .update(partnerAccessApplications)
      .set({
        status: "needs_information",
        reviewNote: decision.note,
        reviewedByMemberId: mutation.actor.id,
        reviewedAt: now,
        version: nextVersion,
        updatedAt: now,
      })
      .where(
        and(
          eq(partnerAccessApplications.id, application.id),
          eq(partnerAccessApplications.status, application.status),
          eq(partnerAccessApplications.version, application.version),
        ),
      )
      .returning({ id: partnerAccessApplications.id });
    if (!updated) {
      throw new TeamMutationFailure(
        "conflict",
        "The application changed while the decision was being saved.",
        { retryable: true },
      );
    }
  } else if (application.flowVersion === 2) {
    if (decision.action === "approve") {
      if (!application.emailVerifiedAt) {
        throw new TeamMutationFailure(
          "conflict",
          "The applicant must verify their email before approval.",
        );
      }
      let provisioned: Awaited<
        ReturnType<typeof provisionVerificationFirstPartnerApplication>
      >;
      if (
        application.companyResolutionChoice !== "join_existing" &&
        (decision.roleKey !== "administrator" ||
          decision.accessLevel !== "account" ||
          decision.locationIds.length > 0 ||
          decision.costCenterIds.length > 0)
      ) {
        throw new TeamMutationFailure(
          "invalid",
          "A newly created company must begin with one account-wide Administrator.",
          {
            fieldErrors: {
              roleKey: "Choose Administrator for a new company.",
              accessLevel: "Choose account-wide access for a new company.",
            },
          },
        );
      }
      try {
        provisioned = await provisionVerificationFirstPartnerApplication(tx, {
          application,
          correlationId: mutation.correlationId,
          now,
          access: {
            roleKey: decision.roleKey,
            accessLevel: decision.accessLevel,
            locationIds: decision.locationIds,
            costCenterIds: decision.costCenterIds,
          },
        });
      } catch (error) {
        const code = error instanceof Error ? error.message : "unknown";
        if (code === "partner_role_unavailable") {
          throw new TeamMutationFailure(
            "internal",
            "The selected partner role is unavailable. No approval was saved.",
          );
        }
        throw new TeamMutationFailure(
          "conflict",
          "The verified application could not be provisioned safely. Review its company and identity match before approving it.",
        );
      }
      accountId = provisioned.accountId;
      membershipId = provisioned.membershipId;
      const [applicationUpdated] = await tx
        .update(partnerAccessApplications)
        .set({
          status: "approved",
          approvedPartnerAccountId: provisioned.accountId,
          applicantPartnerUserId: provisioned.userId,
          reviewNote: decision.note,
          reviewedByMemberId: mutation.actor.id,
          reviewedAt: now,
          version: nextVersion,
          updatedAt: now,
        })
        .where(
          and(
            eq(partnerAccessApplications.id, application.id),
            eq(partnerAccessApplications.flowVersion, 2),
            eq(partnerAccessApplications.status, application.status),
            eq(partnerAccessApplications.version, application.version),
          ),
        )
        .returning({ id: partnerAccessApplications.id });
      if (!applicationUpdated) {
        throw new TeamMutationFailure(
          "conflict",
          "The application changed while approval was being saved.",
          { retryable: true },
        );
      }
      access = {
        state: "activation_required",
        roleKey: provisioned.roleKey,
      };
    } else {
      const [applicationUpdated] = await tx
        .update(partnerAccessApplications)
        .set({
          status: "declined",
          approvedPartnerAccountId: null,
          reviewNote: decision.note,
          reviewedByMemberId: mutation.actor.id,
          reviewedAt: now,
          version: nextVersion,
          updatedAt: now,
        })
        .where(
          and(
            eq(partnerAccessApplications.id, application.id),
            eq(partnerAccessApplications.flowVersion, 2),
            eq(partnerAccessApplications.status, application.status),
            eq(partnerAccessApplications.version, application.version),
          ),
        )
        .returning({ id: partnerAccessApplications.id });
      if (!applicationUpdated) {
        throw new TeamMutationFailure(
          "conflict",
          "The application changed while the decision was being saved.",
          { retryable: true },
        );
      }
      access = { state: "disabled", roleKey: null };
      accountId = null;
      membershipId = null;
    }
  } else {
    const tenant = await loadGeneratedTenantContext(tx, application);
    accountId = tenant.account.id;
    membershipId = tenant.membership.id;
    if (decision.action === "approve") {
      if (!application.emailVerifiedAt) {
        throw new TeamMutationFailure(
          "conflict",
          "The applicant must verify their email before approval.",
        );
      }
      const [administratorRole] = await tx
        .select({
          id: partnerRoleTemplates.id,
          key: partnerRoleTemplates.key,
          active: partnerRoleTemplates.active,
          isSystem: partnerRoleTemplates.isSystem,
        })
        .from(partnerRoleTemplates)
        .where(
          and(
            eq(partnerRoleTemplates.key, "admin"),
            isNull(partnerRoleTemplates.partnerAccountId),
            eq(partnerRoleTemplates.active, true),
            eq(partnerRoleTemplates.isSystem, true),
          ),
        )
        .for("update")
        .limit(1);
      if (!administratorRole) {
        throw new TeamMutationFailure(
          "internal",
          "The account-administrator role is unavailable. No approval was saved.",
        );
      }
      const [accountUpdated] = await tx
        .update(partnerAccounts)
        .set({
          status: "portal_partner",
          portalFit: "application_approved",
          portalAccessEnabled: true,
          updatedAt: now,
        })
        .where(
          and(
            eq(partnerAccounts.id, tenant.account.id),
            eq(partnerAccounts.status, "trial_partner"),
            eq(partnerAccounts.source, "partner_portal_access_application"),
            eq(partnerAccounts.portalFit, "application_pending"),
          ),
        )
        .returning({ id: partnerAccounts.id });
      const [membershipUpdated] = await tx
        .update(partnerAccountMemberships)
        .set({
          roleTemplateId: administratorRole.id,
          roleKey: "admin",
          capabilityGrants: [],
          capabilityDenies: [],
          accessLevel: "account",
          accessScope: {},
          updatedAt: now,
        })
        .where(
          and(
            eq(partnerAccountMemberships.id, tenant.membership.id),
            eq(partnerAccountMemberships.partnerAccountId, tenant.account.id),
            eq(partnerAccountMemberships.partnerUserId, tenant.user.id),
            eq(partnerAccountMemberships.roleKey, "applicant"),
            eq(partnerAccountMemberships.status, "active"),
          ),
        )
        .returning({ id: partnerAccountMemberships.id });
      const [userUpdated] = await tx
        .update(partnerUsers)
        .set({ updatedAt: now })
        .where(
          and(
            eq(partnerUsers.id, tenant.user.id),
            eq(partnerUsers.active, true),
          ),
        )
        .returning({ id: partnerUsers.id });
      if (!accountUpdated || !membershipUpdated || !userUpdated) {
        throw new TeamMutationFailure(
          "conflict",
          "The generated account changed while approval was being saved.",
          { retryable: true },
        );
      }
      const [applicationUpdated] = await tx
        .update(partnerAccessApplications)
        .set({
          status: "approved",
          approvedPartnerAccountId: tenant.account.id,
          reviewNote: decision.note,
          reviewedByMemberId: mutation.actor.id,
          reviewedAt: now,
          version: nextVersion,
          updatedAt: now,
        })
        .where(
          and(
            eq(partnerAccessApplications.id, application.id),
            eq(
              partnerAccessApplications.bootstrapPartnerAccountId,
              tenant.account.id,
            ),
            eq(partnerAccessApplications.status, application.status),
            eq(partnerAccessApplications.version, application.version),
          ),
        )
        .returning({ id: partnerAccessApplications.id });
      if (!applicationUpdated) {
        throw new TeamMutationFailure(
          "conflict",
          "The application changed while approval was being saved.",
          { retryable: true },
        );
      }
      access = { state: "activation_required", roleKey: "admin" };
    } else {
      const [accountUpdated] = await tx
        .update(partnerAccounts)
        .set({
          status: "not_a_fit",
          portalFit: "application_declined",
          portalAccessEnabled: false,
          updatedAt: now,
        })
        .where(
          and(
            eq(partnerAccounts.id, tenant.account.id),
            eq(partnerAccounts.status, "trial_partner"),
            eq(partnerAccounts.source, "partner_portal_access_application"),
            eq(partnerAccounts.portalFit, "application_pending"),
          ),
        )
        .returning({ id: partnerAccounts.id });
      const [membershipUpdated] = await tx
        .update(partnerAccountMemberships)
        .set({
          status: "suspended",
          isDefault: false,
          suspendedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(partnerAccountMemberships.id, tenant.membership.id),
            eq(partnerAccountMemberships.partnerAccountId, tenant.account.id),
            eq(partnerAccountMemberships.partnerUserId, tenant.user.id),
            eq(partnerAccountMemberships.roleKey, "applicant"),
            eq(partnerAccountMemberships.status, "active"),
          ),
        )
        .returning({ id: partnerAccountMemberships.id });
      if (!accountUpdated || !membershipUpdated) {
        throw new TeamMutationFailure(
          "conflict",
          "The generated account changed while the decline was being saved.",
          { retryable: true },
        );
      }
      const [applicationUpdated] = await tx
        .update(partnerAccessApplications)
        .set({
          status: "declined",
          approvedPartnerAccountId: null,
          reviewNote: decision.note,
          reviewedByMemberId: mutation.actor.id,
          reviewedAt: now,
          version: nextVersion,
          updatedAt: now,
        })
        .where(
          and(
            eq(partnerAccessApplications.id, application.id),
            eq(
              partnerAccessApplications.bootstrapPartnerAccountId,
              tenant.account.id,
            ),
            eq(partnerAccessApplications.status, application.status),
            eq(partnerAccessApplications.version, application.version),
          ),
        )
        .returning({ id: partnerAccessApplications.id });
      if (!applicationUpdated) {
        throw new TeamMutationFailure(
          "conflict",
          "The application changed while the decline was being saved.",
          { retryable: true },
        );
      }
      await tx
        .update(partnerSessions)
        .set({ activePartnerAccountId: null, activeMembershipId: null })
        .where(
          and(
            eq(partnerSessions.partnerUserId, tenant.user.id),
            eq(partnerSessions.activePartnerAccountId, tenant.account.id),
            isNull(partnerSessions.revokedAt),
          ),
        );
      access = { state: "disabled", roleKey: null };
    }
  }

  const status =
    decision.action === "approve"
      ? "approved"
      : decision.action === "decline"
        ? "declined"
        : "needs_information";
  const notification =
    application.flowVersion === 2 &&
    (status === "needs_information" || status === "declined")
      ? arePartnerPortalApplicantNotificationsEnabled()
        ? await queuePartnerAccessApplicationDecisionEmail(tx, {
            applicationId: application.id,
            status,
            version: nextVersion,
            correlationId: mutation.correlationId,
            now,
          }).then(
            ({ outboxEventId }): AccessNotificationOutcome => ({
              inApp: "membership_unavailable",
              email: "queued",
              outboxEventId,
            }),
          )
        : {
            inApp: "membership_unavailable",
            email: "feature_disabled",
          }
      : await queueAccessDecisionNotifications({
          tx,
          applicationId: application.id,
          status,
          version: nextVersion,
          target: notificationTarget,
          informationRequest:
            decision.action === "needs_information" ? decision.note : null,
          now,
        });
  const audit = await mutation.audit.insertSuccess(tx, {
    entityType: "partner_access_application",
    entityId: application.id,
    before: {
      status: application.status,
      version: String(application.version),
      accountStatus:
        decision.action === "needs_information" ? null : "trial_partner",
      roleKey: decision.action === "needs_information" ? null : "applicant",
    },
    after: {
      status,
      version: String(nextVersion),
      accountStatus:
        decision.action === "approve"
          ? "portal_partner"
          : decision.action === "decline"
            ? "not_a_fit"
            : null,
      roleKey: access.roleKey,
      accessLevel:
        decision.action === "approve" && application.flowVersion === 2
          ? decision.accessLevel
          : null,
      locationScopeCount:
        decision.action === "approve" && application.flowVersion === 2
          ? decision.locationIds.length
          : 0,
      costCenterScopeCount:
        decision.action === "approve" && application.flowVersion === 2
          ? decision.costCenterIds.length
          : 0,
    },
    metadata: {
      decision: decision.action,
      flowVersion: application.flowVersion,
      partnerAccountId: accountId,
      membershipId,
      tenantProvisionedAtApproval:
        application.flowVersion === 2 && decision.action === "approve",
      activationRequired:
        application.flowVersion === 2 && decision.action === "approve",
      commercialConfigurationChanged: false,
      rateCardCreated: false,
      instantConfirmationGrantedDirectly: false,
      notification,
    },
    committedAt: now,
  });
  return {
    data: {
      application: {
        id: application.id,
        status,
        version: String(nextVersion),
        reviewedAt: now.toISOString(),
      },
      access,
    },
    auditEventId: audit.auditEventId,
    committedAt: audit.committedAt,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ applicationId: string }> },
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401, headers: NO_STORE_HEADERS },
    );
  }
  const permissionError = await requirePermission(
    request,
    "partners.applications.read",
  );
  if (permissionError) return permissionError;
  const { applicationId } = await params;
  if (
    !isStaffAccessApplicationId(applicationId) ||
    [...request.nextUrl.searchParams.keys()].length > 0
  ) {
    return NextResponse.json(
      { ok: false, error: "invalid_request" },
      { status: 422, headers: NO_STORE_HEADERS },
    );
  }
  try {
    const application = await findStaffAccessApplication(applicationId);
    if (!application) {
      return NextResponse.json(
        { ok: false, error: "not_found" },
        { status: 404, headers: NO_STORE_HEADERS },
      );
    }
    return NextResponse.json(
      { ok: true, application },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error("[partner-access-applications] detail_failed", {
      applicationId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    const response = teamMutationExceptionResponse(
      new TeamMutationFailure(
        "internal",
        "The access application could not be loaded. Try again.",
        { retryable: true },
      ),
    );
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ applicationId: string }> },
): Promise<Response> {
  const boundary = await beginTeamMutation(
    request,
    {
      principalTypes: ["human"],
      requiredPermissions: ["partners.applications.read"],
      risk: "destructive",
      requiresIdempotency: true,
      auditAction: "partner.access_application.decision",
    },
    {
      // Access review must remain available during an outbound incident. Any
      // optional email is only written to the transactional outbox; portal and
      // global dispatcher flags still govern external delivery.
      ignoredPermissionKillSwitches: ["external_sends"],
    },
  );
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;
  const { applicationId } = await params;
  if (
    !isStaffAccessApplicationId(applicationId) ||
    [...request.nextUrl.searchParams.keys()].length > 0
  ) {
    return failureResponse(
      mutation,
      new TeamMutationFailure("invalid", "Choose a valid application.", {
        fieldErrors: !isStaffAccessApplicationId(applicationId)
          ? { applicationId: "The application ID is invalid." }
          : {
              request:
                "Use the application URL without additional query fields.",
            },
      }),
      applicationId,
      "input",
    );
  }
  if (mutation.expectedVersion === null || mutation.expectedVersion === "*") {
    return failureResponse(
      mutation,
      new TeamMutationFailure(
        "invalid",
        "The exact current application version is required.",
        { fieldErrors: { version: "Refresh the application and try again." } },
      ),
      applicationId,
      "input",
    );
  }

  let decision: StaffAccessApplicationDecision;
  try {
    decision = parseStaffAccessApplicationDecision(
      await readBoundedJsonRequest(request, {
        maximumBytes: BODY_MAXIMUM_BYTES,
        deadlineMs: BODY_DEADLINE_MS,
      }),
    );
  } catch (error) {
    return failureResponse(
      mutation,
      translatedInputFailure(error),
      applicationId,
      "input",
    );
  }

  const decisionPermission =
    decision.action === "approve"
      ? "partners.applications.approve"
      : decision.action === "decline"
        ? "partners.applications.decline"
        : "partners.applications.review";
  const decisionPermissionError = await requirePermission(
    request,
    decisionPermission,
    { ignoredKillSwitches: ["external_sends"] },
  );
  if (decisionPermissionError) {
    decisionPermissionError.headers.set("Cache-Control", "private, no-store");
    return decisionPermissionError;
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "PATCH /api/admin/partners/access-applications/:applicationId",
      entityType: "partner_access_application",
      entityId: applicationId,
      payload: decision,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(
      async (
        tx,
      ): Promise<
        Extract<MutationResult<ApplicationDecisionData>, { ok: true }>
      > => {
        const applied = await applyDecision(
          tx,
          mutation,
          applicationId,
          decision,
        );
        const success = teamMutationSuccessResult(mutation, applied.data, {
          auditEventId: applied.auditEventId,
          committedAt: applied.committedAt,
          entityType: "partner_access_application",
          entityId: applicationId,
          version: applied.data.application.version,
        });
        await completeTeamMutationIdempotency(
          tx,
          mutation,
          claimed.claim,
          success,
          200,
        );
        return success;
      },
    );
    const response = teamMutationResultResponse(
      result,
      200,
      mutation.correlationId,
    );
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    if (db && claim) {
      await settleTeamMutationIdempotencyFailure(
        db,
        mutation,
        claim,
        error,
      ).catch(() => undefined);
    }
    return failureResponse(mutation, error, applicationId, "mutation");
  }
}
