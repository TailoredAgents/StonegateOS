import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  partnerAccounts,
  partnerAccountMemberships,
  partnerEvidenceRequirements,
  partnerServiceCatalog,
  partnerRecurringSeries,
  partnerRecurringOccurrences,
  appointmentHolds,
} from "@/db";
import {
  createPartnerAccountInvitation,
  mutatePartnerAccountInvitation,
  PartnerInvitationCreateSchema,
  type PartnerStaffInvitationActor,
} from "./partner-account-invitations";
import { loadPartnerPublishedServiceRateCard } from "./partner-structured-rates";
import { loadPartnerStaffInvitationAuthority } from "./partner-invitation-authority";
import { acquirePartnerRecurringHorizonClaimLock } from "./partner-recurring-coordination";
import { acquireScheduleConflictLock } from "./appointment-schedule-conflicts";
import {
  normalizePartnerAccountWorkflow,
  PARTNER_TOOL_KEYS,
} from "./partner-account-workflows";
import {
  assertTeamMutationExpectedVersion,
  TeamMutationFailure,
  type TeamMutationContext,
  type TeamMutationTransaction,
} from "./team-mutation";

export const PartnerRelationshipCreateSchema = z
  .object({
    companyName: z.string().trim().min(2).max(160),
    contactName: z.string().trim().min(2).max(120),
    contactEmail: z.string().trim().email().max(254),
    persona: z.enum([
      "contractor",
      "real_estate_agent",
      "property_manager",
      "commercial_client",
      "other",
    ]),
    reason: z.string().trim().min(10).max(1_000),
  })
  .strict();
export const PartnerStaffInvitationCreateSchema = z
  .object({
    accountId: z.string().uuid(),
    invitation: PartnerInvitationCreateSchema,
  })
  .strict();
export const PartnerStaffInvitationActionSchema = z
  .object({
    accountId: z.string().uuid(),
    invitationId: z.string().uuid(),
    action: z.enum(["resend", "revoke"]),
  })
  .strict();
export const PartnerRelationshipEnableSchema = z
  .object({ reason: z.string().trim().min(10).max(1_000) })
  .strict();
const KeysSchema = z
  .array(z.string().regex(/^[a-z][a-z0-9_-]{1,79}$/u))
  .max(100)
  .refine((keys) => new Set(keys).size === keys.length);
export const PartnerWorkflowUpdateSchema = z
  .object({
    tools: z
      .object({
        templates: z.boolean(),
        recurring: z.boolean(),
        bulk: z.boolean(),
        reports: z.boolean(),
        portfolio: z.boolean(),
        approvals: z.boolean(),
      })
      .strict(),
    requestableServiceKeys: KeysSchema,
    disabledServiceKeys: KeysSchema,
    partialPayments: z.boolean(),
    confirmPauseRecurring: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) =>
      !value.requestableServiceKeys.some((key) =>
        value.disabledServiceKeys.includes(key),
      ),
    { message: "A service cannot be both requestable and disabled." },
  )
  .refine((value) => !value.tools.recurring || value.tools.templates, {
    path: ["tools", "templates"],
    message:
      "Recurring service requires saved service templates. Enable both or leave recurring service off.",
  });

function staffActor(
  mutation: TeamMutationContext,
  accountId: string,
): PartnerStaffInvitationActor {
  if (
    mutation.actor.type !== "human" ||
    mutation.actor.authMethod !== "team_session" ||
    !mutation.actor.id ||
    !mutation.actor.sessionId
  )
    throw new TeamMutationFailure(
      "forbidden",
      "A signed-in Stonegate staff member is required.",
    );
  return {
    staffIssuer: true,
    accountId,
    teamMemberId: mutation.actor.id,
    membershipId: null,
    partnerUserId: null,
    email: mutation.actor.label ?? "",
    roleKey: "stonegate",
    session: { id: mutation.actor.sessionId },
  };
}

export async function createPartnerRelationship(
  tx: TeamMutationTransaction,
  mutation: TeamMutationContext,
  input: z.infer<typeof PartnerRelationshipCreateSchema>,
) {
  if (
    !mutation.actor.id ||
    !(await loadPartnerStaffInvitationAuthority(tx, mutation.actor.id, [
      "partners.accounts.manage",
      "partners.invitations.send",
    ]))
  )
    throw new TeamMutationFailure(
      "forbidden",
      "Your partner setup permission is no longer available.",
    );
  const normalizedName = input.companyName
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLowerCase();
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${"partner-relationship:" + normalizedName}))`,
  );
  const [existing] = await tx
    .select({ id: partnerAccounts.id })
    .from(partnerAccounts)
    .where(eq(partnerAccounts.normalizedName, normalizedName))
    .limit(1);
  if (existing)
    throw new TeamMutationFailure(
      "conflict",
      "A company with this name already exists. Open that company and invite its contact instead.",
    );
  const [account] = await tx
    .insert(partnerAccounts)
    .values({
      name: input.companyName,
      normalizedName,
      status: "portal_partner",
      segment: input.persona,
      source: "stonegate_relationship_setup",
      portalFit: "staff_relationship_confirmed",
      portalAccessEnabled: false,
      portalSetupStatus: "rates_required",
      portalLifecycleStatus: "active",
      serviceContactName: input.contactName,
      serviceContactEmail: input.contactEmail.toLowerCase(),
      ownerMemberId: mutation.actor.id,
    })
    .returning({ id: partnerAccounts.id });
  if (!account)
    throw new TeamMutationFailure(
      "internal",
      "The company could not be created.",
    );
  await tx.insert(partnerEvidenceRequirements).values(
    ["before", "after"].map((category) => ({
      partnerAccountId: account.id,
      category: category as "before" | "after",
      required: true,
      minimumCount: 1,
      source: "account_default" as const,
    })),
  );
  return {
    accountId: account.id,
    invitation: null,
    deliveryStatus: "not_sent",
    setupStatus: "rates_required",
    version: "1",
    recordType: "partner_account",
  };
}

export async function invitePartnerAsStaff(
  tx: TeamMutationTransaction,
  mutation: TeamMutationContext,
  input: z.infer<typeof PartnerStaffInvitationCreateSchema>,
) {
  const [account] = await tx
    .select({
      id: partnerAccounts.id,
      setupStatus: partnerAccounts.portalSetupStatus,
    })
    .from(partnerAccounts)
    .where(eq(partnerAccounts.id, input.accountId))
    .for("update")
    .limit(1);
  if (!account)
    throw new TeamMutationFailure("invalid", "Choose an existing company.");
  if (account.setupStatus !== "complete")
    throw new TeamMutationFailure(
      "conflict",
      "Publish all required service rates and activate this company before inviting people.",
    );
  const [anyMember] = await tx
    .select({ id: partnerAccountMemberships.id })
    .from(partnerAccountMemberships)
    .where(eq(partnerAccountMemberships.partnerAccountId, input.accountId))
    .limit(1);
  if (!anyMember && input.invitation.roleKey !== "administrator")
    throw new TeamMutationFailure(
      "invalid",
      "The first company contact must be explicitly invited as Administrator.",
    );
  const result = await createPartnerAccountInvitation({
    transaction: tx,
    principal: staffActor(mutation, input.accountId),
    payload: input.invitation,
    correlationId: mutation.correlationId,
    idempotencyKeyHash: mutation.idempotencyKeyHash!,
  });
  if (result.status >= 500)
    throw new TeamMutationFailure(
      "internal",
      "Invitation setup is temporarily unavailable. No invitation was created. Check the public invitation-link configuration, then retry.",
      { status: 503, retryable: true },
    );
  if (result.status !== 202)
    throw new TeamMutationFailure(
      result.status === 403
        ? "forbidden"
        : result.status === 422
          ? "invalid"
          : "conflict",
      "The invitation could not be created. Check the company, role and selected locations.",
    );
  return {
    accountId: input.accountId,
    invitation: result.body["invitation"] ?? null,
    deliveryStatus: result.body["invitation"] ? "queued" : "unchanged",
    recordType: "partner_account_invitation",
  };
}

export async function enablePartnerRelationshipAsStaff(
  tx: TeamMutationTransaction,
  mutation: TeamMutationContext,
  accountId: string,
) {
  if (
    !mutation.actor.id ||
    !(await loadPartnerStaffInvitationAuthority(tx, mutation.actor.id, [
      "partners.accounts.manage",
    ]))
  )
    throw new TeamMutationFailure(
      "forbidden",
      "Your company configuration permission is no longer available.",
    );
  const [account] = await tx
    .select()
    .from(partnerAccounts)
    .where(eq(partnerAccounts.id, accountId))
    .for("update")
    .limit(1);
  if (!account)
    throw new TeamMutationFailure("invalid", "Choose an existing company.");
  if (!mutation.expectedVersion || mutation.expectedVersion === "*")
    throw new TeamMutationFailure(
      "invalid",
      "Refresh this company before approving access.",
    );
  assertTeamMutationExpectedVersion(mutation, account.portalWorkflowRevision);
  if (account.portalLifecycleStatus !== "active")
    throw new TeamMutationFailure(
      "conflict",
      "Suspended or closed accounts must use the existing lifecycle recovery process.",
    );
  if (account.portalAccessEnabled)
    throw new TeamMutationFailure(
      "conflict",
      "This company already has approved portal access.",
    );
  const stagedSetup = account.portalSetupStatus === "rates_required";
  if (stagedSetup) {
    if (
      !(await loadPartnerStaffInvitationAuthority(tx, mutation.actor.id, [
        "partners.accounts.manage",
        "partners.rates",
        "partners.invitations.send",
      ]))
    )
      throw new TeamMutationFailure(
        "forbidden",
        "Activating a new partner requires company, rate and invitation permissions.",
      );
    const published = await loadPartnerPublishedServiceRateCard(tx, {
      accountId,
    });
    if (!published || published.source !== "structured" || !published.complete)
      throw new TeamMutationFailure(
        "conflict",
        "Publish current rates for all eight services and their required variants before activating this company.",
      );
    if (!account.serviceContactName || !account.serviceContactEmail)
      throw new TeamMutationFailure(
        "invalid",
        "Add the Administrator's name and email before activating this company.",
      );
  }
  await tx
    .update(partnerAccounts)
    .set({
      portalAccessEnabled: true,
      ...(stagedSetup ? { portalSetupStatus: "complete" as const } : {}),
      portalWorkflowRevision: account.portalWorkflowRevision + 1,
      updatedAt: new Date(),
    })
    .where(eq(partnerAccounts.id, accountId));
  const defaults = await tx
    .select({ category: partnerEvidenceRequirements.category })
    .from(partnerEvidenceRequirements)
    .where(
      and(
        eq(partnerEvidenceRequirements.partnerAccountId, accountId),
        eq(partnerEvidenceRequirements.source, "account_default"),
      ),
    );
  for (const category of ["before", "after"] as const)
    if (!defaults.some((row) => row.category === category))
      await tx.insert(partnerEvidenceRequirements).values({
        partnerAccountId: accountId,
        category,
        required: true,
        minimumCount: 1,
        source: "account_default",
      });
  let invitation: unknown = null;
  if (stagedSetup) {
    const result = await createPartnerAccountInvitation({
      transaction: tx,
      principal: staffActor(mutation, accountId),
      payload: {
        email: account.serviceContactEmail!,
        name: account.serviceContactName!,
        persona: PartnerRelationshipCreateSchema.shape.persona
          .catch("other")
          .parse(account.segment),
        roleKey: "administrator",
        accessLevel: "account",
        locationIds: [],
        costCenterIds: [],
      },
      correlationId: mutation.correlationId,
      idempotencyKeyHash: mutation.idempotencyKeyHash!,
    });
    if (result.status !== 202 || !result.body["invitation"])
      throw new TeamMutationFailure(
        result.status >= 500 ? "internal" : "conflict",
        "The invitation could not be prepared. The company remains inactive; its saved rates are unchanged.",
        {
          status: result.status >= 500 ? 503 : 409,
          retryable: result.status >= 500,
        },
      );
    invitation = result.body["invitation"];
  }
  return {
    accountId,
    invitation,
    deliveryStatus: stagedSetup ? "queued" : "not_sent",
    setupStatus: stagedSetup ? "complete" : account.portalSetupStatus,
    version: String(account.portalWorkflowRevision + 1),
    recordType: "partner_account",
  };
}

export async function managePartnerInvitationAsStaff(
  tx: TeamMutationTransaction,
  mutation: TeamMutationContext,
  input: z.infer<typeof PartnerStaffInvitationActionSchema>,
  ifMatch: string | null,
) {
  const result = await mutatePartnerAccountInvitation({
    transaction: tx,
    principal: staffActor(mutation, input.accountId),
    invitationId: input.invitationId,
    action: input.action,
    ifMatch,
    correlationId: mutation.correlationId,
    idempotencyKeyHash: mutation.idempotencyKeyHash!,
  });
  if (result.status !== 200 && result.status !== 202)
    throw new TeamMutationFailure(
      result.status === 403 ? "forbidden" : "conflict",
      result.status === 412
        ? "This invitation changed. Refresh before trying again."
        : "The invitation could not be changed. Activated members must be managed from People.",
      { status: result.status },
    );
  return {
    accountId: input.accountId,
    invitationId: input.invitationId,
    invitation: result.body["invitation"],
    deliveryStatus: input.action === "resend" ? "queued" : "revoked",
    recordType: "partner_account_invitation",
  };
}

export async function updatePartnerWorkflowAsStaff(
  tx: TeamMutationTransaction,
  mutation: TeamMutationContext,
  accountId: string,
  input: z.infer<typeof PartnerWorkflowUpdateSchema>,
) {
  // The same lock order as horizon claims, occurrence submissions and partner
  // pause/cancel prevents an in-flight worker from racing tool containment.
  await acquirePartnerRecurringHorizonClaimLock(tx);
  await acquireScheduleConflictLock(tx);
  if (
    !mutation.actor.id ||
    !(await loadPartnerStaffInvitationAuthority(tx, mutation.actor.id, [
      "partners.accounts.manage",
    ]))
  )
    throw new TeamMutationFailure(
      "forbidden",
      "Your company configuration permission is no longer available.",
    );
  const [account] = await tx
    .select()
    .from(partnerAccounts)
    .where(eq(partnerAccounts.id, accountId))
    .for("update")
    .limit(1);
  if (!account)
    throw new TeamMutationFailure("invalid", "Choose an existing company.");
  if (!mutation.expectedVersion || mutation.expectedVersion === "*")
    throw new TeamMutationFailure(
      "invalid",
      "Refresh the company tools before saving.",
    );
  assertTeamMutationExpectedVersion(mutation, account.portalWorkflowRevision);
  if (account.portalLifecycleStatus !== "active")
    throw new TeamMutationFailure(
      "conflict",
      "Company tools cannot change while this account is inactive.",
    );
  if (
    input.partialPayments !==
      normalizePartnerAccountWorkflow(account.portalWorkflowConfig)
        .partialPayments &&
    !(await loadPartnerStaffInvitationAuthority(tx, mutation.actor.id, [
      "partners.commercial.manage",
    ]))
  )
    throw new TeamMutationFailure(
      "forbidden",
      "Commercial permission is required to change partial payments.",
    );
  const serviceKeys = [
    ...new Set([...input.requestableServiceKeys, ...input.disabledServiceKeys]),
  ];
  const services = serviceKeys.length
    ? await tx
        .select({ key: partnerServiceCatalog.key })
        .from(partnerServiceCatalog)
        .where(
          and(
            inArray(partnerServiceCatalog.key, serviceKeys),
            eq(partnerServiceCatalog.active, true),
          ),
        )
    : [];
  if (services.length !== serviceKeys.length)
    throw new TeamMutationFailure(
      "invalid",
      "One or more selected services are not active.",
    );
  const config = normalizePartnerAccountWorkflow(input);
  const disablesRecurring =
    normalizePartnerAccountWorkflow(account.portalWorkflowConfig).tools
      .recurring && !config.tools.recurring;
  if (disablesRecurring && input.confirmPauseRecurring !== true) {
    throw new TeamMutationFailure(
      "invalid",
      "Confirm that disabling recurring service pauses future tentative work. Confirmed jobs will not change.",
    );
  }
  if (disablesRecurring) {
    const paused = await tx
      .update(partnerRecurringSeries)
      .set({
        state: "paused",
        revision: sql`${partnerRecurringSeries.revision} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(partnerRecurringSeries.partnerAccountId, accountId),
          eq(partnerRecurringSeries.state, "active"),
        ),
      )
      .returning({ id: partnerRecurringSeries.id });
    if (paused.length) {
      const skipped = await tx
        .update(partnerRecurringOccurrences)
        .set({
          state: "skipped",
          failureCode: "series_paused",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(partnerRecurringOccurrences.partnerAccountId, accountId),
            isNull(partnerRecurringOccurrences.partnerBookingId),
            inArray(
              partnerRecurringOccurrences.recurringSeriesId,
              paused.map((row) => row.id),
            ),
            inArray(partnerRecurringOccurrences.state, [
              "tentative",
              "evaluating",
            ]),
            // Containment affects only still-upcoming work in each series' service
            // timezone. Keep historical outcomes intact for staff reconciliation.
            sql`exists (select 1 from ${partnerRecurringSeries}
          where ${partnerRecurringSeries.id} = ${partnerRecurringOccurrences.recurringSeriesId}
            and ${partnerRecurringSeries.partnerAccountId} = ${accountId}
            and ${partnerRecurringOccurrences.localDate} >= (now() at time zone ${partnerRecurringSeries.timezone})::date)`,
          ),
        )
        .returning({ draftId: partnerRecurringOccurrences.bookingDraftId });
      const draftIds = skipped.flatMap((row) =>
        row.draftId ? [row.draftId] : [],
      );
      if (draftIds.length)
        await tx
          .update(appointmentHolds)
          .set({ status: "released", updatedAt: new Date() })
          .where(
            and(
              eq(appointmentHolds.partnerAccountId, accountId),
              inArray(appointmentHolds.partnerBookingDraftId, draftIds),
              eq(appointmentHolds.status, "active"),
            ),
          );
    }
  }
  const [saved] = await tx
    .update(partnerAccounts)
    .set({
      portalWorkflowConfig: config,
      portalWorkflowRevision: account.portalWorkflowRevision + 1,
      updatedAt: new Date(),
    })
    .where(eq(partnerAccounts.id, accountId))
    .returning({ version: partnerAccounts.portalWorkflowRevision });
  if (!saved)
    throw new TeamMutationFailure(
      "internal",
      "Company tools could not be saved.",
    );
  return {
    accountId,
    config,
    version: String(saved.version),
    changedTools: PARTNER_TOOL_KEYS.filter(
      (key) =>
        normalizePartnerAccountWorkflow(account.portalWorkflowConfig).tools[
          key
        ] !== config.tools[key],
    ),
    recordType: "partner_account",
  };
}
