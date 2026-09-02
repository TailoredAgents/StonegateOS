import type { NextRequest } from "next/server";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import {
  auditLogs,
  getDb,
  partnerAccountLocations,
  partnerAccountMemberships,
  partnerEvidenceRequirements,
} from "@/db";
import type { PartnerMembershipPreferences } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import {
  arePartnerPortalV2ReadsEnabled,
  arePartnerPortalV2WritesEnabled,
} from "@/lib/partner-portal-feature-flags";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";
import {
  createPortalV2StrongEtag,
  evaluatePortalV2RevisionPrecondition,
  readPortalV2CorrelationId,
} from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2DescriptorResponse,
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";

const ChecklistStepSchema = z.enum([
  "first_location",
  "communication_preferences",
  "proof_defaults",
  "billing_details",
  "teammates",
]);
type ChecklistStep = z.infer<typeof ChecklistStepSchema>;

const UpdateSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("complete_step"),
      step: ChecklistStepSchema,
    })
    .strict(),
  z.object({ action: z.literal("dismiss") }).strict(),
  z.object({ action: z.literal("restore") }).strict(),
]);

const STEP_DEFINITIONS: ReadonlyArray<{
  id: ChecklistStep;
  title: string;
  description: string;
  href: string;
}> = [
  {
    id: "first_location",
    title: "Add your first service location",
    description:
      "Save access, parking, site contact, and service-area details.",
    href: "/partners/properties",
  },
  {
    id: "communication_preferences",
    title: "Review communication preferences",
    description: "Choose email, in-app, quiet-hour, and verified SMS options.",
    href: "/partners/settings",
  },
  {
    id: "proof_defaults",
    title: "Review photo and proof defaults",
    description:
      "Confirm what before, after, and completion evidence is required.",
    href: "/partners/settings",
  },
  {
    id: "billing_details",
    title: "Confirm billing details",
    description:
      "Review the billing contact, purchasing references, and documents.",
    href: "/partners/settings",
  },
  {
    id: "teammates",
    title: "Invite a teammate",
    description:
      "Add Operations, Billing/Approver, or Viewer access when needed.",
    href: "/partners/settings/team",
  },
];

type ChecklistFacts = {
  hasLocation: boolean;
  hasTeammate: boolean;
  hasProofDefaults: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checklistPreferenceState(preferences: unknown): {
  completedSteps: ChecklistStep[];
  dismissedAt: string | null;
} {
  if (!isRecord(preferences) || !isRecord(preferences["onboardingChecklist"])) {
    return { completedSteps: [], dismissedAt: null };
  }
  const raw = preferences["onboardingChecklist"];
  const completedSteps = Array.isArray(raw["completedSteps"])
    ? raw["completedSteps"].filter(
        (step): step is ChecklistStep =>
          typeof step === "string" &&
          ChecklistStepSchema.safeParse(step).success,
      )
    : [];
  const dismissedAt =
    typeof raw["dismissedAt"] === "string" &&
    Number.isFinite(new Date(raw["dismissedAt"]).getTime())
      ? raw["dismissedAt"]
      : null;
  return { completedSteps: [...new Set(completedSteps)], dismissedAt };
}

function effectiveCompletedSteps(
  preferences: unknown,
  facts: ChecklistFacts,
): Set<ChecklistStep> {
  const state = checklistPreferenceState(preferences);
  const completed = new Set(state.completedSteps);
  if (facts.hasLocation) completed.add("first_location");
  if (facts.hasTeammate) completed.add("teammates");
  return completed;
}

function checklistRevision(input: {
  accountId: string;
  membershipId: string;
  preferences: unknown;
  updatedAt: Date;
  facts: ChecklistFacts;
}): string {
  return JSON.stringify({
    accountId: input.accountId,
    membershipId: input.membershipId,
    preferences: checklistPreferenceState(input.preferences),
    updatedAt: input.updatedAt.toISOString(),
    facts: input.facts,
  });
}

function checklistDto(preferences: unknown, facts: ChecklistFacts) {
  const state = checklistPreferenceState(preferences);
  const completed = effectiveCompletedSteps(preferences, facts);
  const steps = STEP_DEFINITIONS.map((step) => ({
    ...step,
    completed: completed.has(step.id),
    completion:
      step.id === "first_location" || step.id === "teammates"
        ? ("automatic" as const)
        : ("acknowledged" as const),
  }));
  return {
    version: 1 as const,
    dismissed: state.dismissedAt !== null,
    dismissedAt: state.dismissedAt,
    completedCount: steps.filter((step) => step.completed).length,
    totalCount: steps.length,
    steps,
  };
}

async function loadChecklistFacts(input: {
  accountId: string;
  membershipId: string;
}): Promise<ChecklistFacts> {
  const db = getDb();
  const [locations, teammates, proofDefaults] = await Promise.all([
    db
      .select({ id: partnerAccountLocations.id })
      .from(partnerAccountLocations)
      .where(
        and(
          eq(partnerAccountLocations.partnerAccountId, input.accountId),
          eq(partnerAccountLocations.active, true),
        ),
      )
      .limit(1),
    db
      .select({ id: partnerAccountMemberships.id })
      .from(partnerAccountMemberships)
      .where(
        and(
          eq(partnerAccountMemberships.partnerAccountId, input.accountId),
          ne(partnerAccountMemberships.id, input.membershipId),
          inArray(partnerAccountMemberships.status, ["active", "invited"]),
        ),
      )
      .limit(1),
    db
      .select({ id: partnerEvidenceRequirements.id })
      .from(partnerEvidenceRequirements)
      .where(
        and(
          eq(partnerEvidenceRequirements.partnerAccountId, input.accountId),
          isNull(partnerEvidenceRequirements.partnerBookingId),
        ),
      )
      .limit(1),
  ]);
  return {
    hasLocation: locations.length > 0,
    hasTeammate: teammates.length > 0,
    hasProofDefaults: proofDefaults.length > 0,
  };
}

function withChecklistState(
  preferences: PartnerMembershipPreferences,
  state: { completedSteps: ChecklistStep[]; dismissedAt: string | null },
): PartnerMembershipPreferences {
  return {
    ...preferences,
    onboardingChecklist: {
      version: 1,
      completedSteps: [...new Set(state.completedSteps)],
      dismissedAt: state.dismissedAt,
    },
  };
}

export async function GET(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  try {
    const authorization = await requirePartnerCapability(
      request,
      "account.read",
    );
    if (!authorization.ok) {
      return createPartnerPortalV2ErrorResponse(
        authorization.error,
        authorization.status,
        correlationId,
      );
    }
    const { principal } = authorization;
    if (principal.roleKey !== "administrator") {
      return createPartnerPortalV2SuccessResponse(
        { ok: true, checklist: null, applicable: false },
        correlationId,
      );
    }
    if (!principal.accountId || !principal.membershipId) {
      return createPartnerPortalV2ErrorResponse(
        "legacy_scope_unavailable",
        409,
        correlationId,
      );
    }
    if (!arePartnerPortalV2ReadsEnabled(principal.accountId)) {
      return createPartnerPortalV2ErrorResponse(
        "service_unavailable",
        503,
        correlationId,
      );
    }
    const [membership] = await getDb()
      .select({
        id: partnerAccountMemberships.id,
        preferences: partnerAccountMemberships.preferences,
        updatedAt: partnerAccountMemberships.updatedAt,
      })
      .from(partnerAccountMemberships)
      .where(
        and(
          eq(partnerAccountMemberships.id, principal.membershipId),
          eq(partnerAccountMemberships.partnerAccountId, principal.accountId),
          eq(partnerAccountMemberships.partnerUserId, principal.partnerUserId),
          eq(partnerAccountMemberships.status, "active"),
        ),
      )
      .limit(1);
    if (!membership) {
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
        correlationId,
      );
    }
    const facts = await loadChecklistFacts({
      accountId: principal.accountId,
      membershipId: principal.membershipId,
    });
    const etag = createPortalV2StrongEtag(
      checklistRevision({
        accountId: principal.accountId,
        membershipId: principal.membershipId,
        preferences: membership.preferences,
        updatedAt: membership.updatedAt,
        facts,
      }),
    );
    return createPartnerPortalV2SuccessResponse(
      { ok: true, checklist: checklistDto(membership.preferences, facts) },
      correlationId,
      200,
      { ETag: etag },
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}

export async function PATCH(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (!isAllowedPartnerPortalMutationOrigin(request)) {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  const authorization = await requirePartnerCapability(request, "account.read");
  if (!authorization.ok) {
    return createPartnerPortalV2ErrorResponse(
      authorization.error,
      authorization.status,
      correlationId,
    );
  }
  const { principal } = authorization;
  if (principal.roleKey !== "administrator") {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  if (!principal.accountId || !principal.membershipId) {
    return createPartnerPortalV2ErrorResponse(
      "legacy_scope_unavailable",
      409,
      correlationId,
    );
  }
  if (!arePartnerPortalV2WritesEnabled(principal.accountId)) {
    return createPartnerPortalV2ErrorResponse(
      "service_unavailable",
      503,
      correlationId,
    );
  }
  let raw: unknown;
  try {
    raw = await readBoundedJsonRequest(request, {
      maximumBytes: 1_024,
      deadlineMs: 10_000,
      rejectDuplicateObjectKeys: true,
    });
  } catch (error) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_body",
      error instanceof BoundedJsonRequestError ? error.status : 400,
      correlationId,
    );
  }
  const parsed = UpdateSchema.safeParse(raw);
  if (!parsed.success) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_fields",
      422,
      correlationId,
    );
  }
  try {
    const db = getDb();
    const result = await db.transaction(async (tx) => {
      const [membership] = await tx
        .select({
          id: partnerAccountMemberships.id,
          preferences: partnerAccountMemberships.preferences,
          updatedAt: partnerAccountMemberships.updatedAt,
        })
        .from(partnerAccountMemberships)
        .where(
          and(
            eq(partnerAccountMemberships.id, principal.membershipId!),
            eq(
              partnerAccountMemberships.partnerAccountId,
              principal.accountId!,
            ),
            eq(
              partnerAccountMemberships.partnerUserId,
              principal.partnerUserId,
            ),
            eq(partnerAccountMemberships.status, "active"),
          ),
        )
        .for("update")
        .limit(1);
      if (!membership) return { kind: "not_found" as const };

      const [locations, teammates, proofDefaults] = await Promise.all([
        tx
          .select({ id: partnerAccountLocations.id })
          .from(partnerAccountLocations)
          .where(
            and(
              eq(
                partnerAccountLocations.partnerAccountId,
                principal.accountId!,
              ),
              eq(partnerAccountLocations.active, true),
            ),
          )
          .limit(1),
        tx
          .select({ id: partnerAccountMemberships.id })
          .from(partnerAccountMemberships)
          .where(
            and(
              eq(
                partnerAccountMemberships.partnerAccountId,
                principal.accountId!,
              ),
              ne(partnerAccountMemberships.id, principal.membershipId!),
              inArray(partnerAccountMemberships.status, ["active", "invited"]),
            ),
          )
          .limit(1),
        tx
          .select({ id: partnerEvidenceRequirements.id })
          .from(partnerEvidenceRequirements)
          .where(
            and(
              eq(
                partnerEvidenceRequirements.partnerAccountId,
                principal.accountId!,
              ),
              isNull(partnerEvidenceRequirements.partnerBookingId),
            ),
          )
          .limit(1),
      ]);
      const facts: ChecklistFacts = {
        hasLocation: locations.length > 0,
        hasTeammate: teammates.length > 0,
        hasProofDefaults: proofDefaults.length > 0,
      };
      const precondition = evaluatePortalV2RevisionPrecondition({
        ifMatch: request.headers.get("if-match"),
        currentRevision: checklistRevision({
          accountId: principal.accountId!,
          membershipId: principal.membershipId!,
          preferences: membership.preferences,
          updatedAt: membership.updatedAt,
          facts,
        }),
        correlationId,
      });
      if (!precondition.ok) {
        return {
          kind: "precondition" as const,
          response: precondition.response,
        };
      }

      const current = checklistPreferenceState(membership.preferences);
      const completed = effectiveCompletedSteps(membership.preferences, facts);
      let dismissedAt = current.dismissedAt;
      if (parsed.data.action === "complete_step") {
        if (
          (parsed.data.step === "first_location" && !facts.hasLocation) ||
          (parsed.data.step === "teammates" && !facts.hasTeammate) ||
          (parsed.data.step === "proof_defaults" && !facts.hasProofDefaults)
        ) {
          return { kind: "not_ready" as const };
        }
        completed.add(parsed.data.step);
      } else if (parsed.data.action === "dismiss") {
        dismissedAt = new Date().toISOString();
      } else {
        dismissedAt = null;
      }
      const now = new Date();
      const nextPreferences = withChecklistState(membership.preferences, {
        completedSteps: [...completed],
        dismissedAt,
      });
      await tx
        .update(partnerAccountMemberships)
        .set({ preferences: nextPreferences, updatedAt: now })
        .where(eq(partnerAccountMemberships.id, membership.id));
      await tx.insert(auditLogs).values({
        actorType: "human",
        actorId: principal.partnerUserId,
        actorLabel: principal.email,
        actorRole: principal.roleKey,
        sessionId: principal.session.id,
        authMethod: "partner_session",
        correlationId,
        requiredPermissions: ["account.read"],
        surface: "partner_portal_v2",
        action: "partner.onboarding_checklist.updated",
        entityType: "partner_account_membership",
        entityId: principal.membershipId,
        meta: {
          partnerAccountId: principal.accountId,
          action: parsed.data.action,
          ...(parsed.data.action === "complete_step"
            ? { step: parsed.data.step }
            : {}),
        },
      });
      return {
        kind: "success" as const,
        preferences: nextPreferences,
        updatedAt: now,
        facts,
      };
    });
    if (result.kind === "not_found") {
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
        correlationId,
      );
    }
    if (result.kind === "not_ready") {
      return createPartnerPortalV2ErrorResponse(
        "checklist_step_incomplete",
        422,
        correlationId,
      );
    }
    if (result.kind === "precondition") {
      return createPartnerPortalV2DescriptorResponse(result.response);
    }
    const etag = createPortalV2StrongEtag(
      checklistRevision({
        accountId: principal.accountId,
        membershipId: principal.membershipId,
        preferences: result.preferences,
        updatedAt: result.updatedAt,
        facts: result.facts,
      }),
    );
    return createPartnerPortalV2SuccessResponse(
      { ok: true, checklist: checklistDto(result.preferences, result.facts) },
      correlationId,
      200,
      { ETag: etag },
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
