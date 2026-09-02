import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  auditLogs,
  getDb,
  partnerAccountMemberships,
  partnerAccounts,
  partnerUsers,
} from "@/db";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { resolvePartnerPrincipal } from "@/lib/partner-account-authorization";
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

const PersonalProfilePatchSchema = z
  .object({
    displayName: z
      .string()
      .trim()
      .min(2)
      .max(120)
      .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), {
        message: "Display name cannot contain control characters.",
      })
      .transform((value) => value.replace(/\s+/gu, " ")),
  })
  .strict();

const personalProfileSelection = {
  id: partnerUsers.id,
  name: partnerUsers.name,
  updatedAt: partnerUsers.updatedAt,
};

type PersonalProfileRow = Pick<
  typeof partnerUsers.$inferSelect,
  keyof typeof personalProfileSelection
>;

export function partnerPersonalProfileRevision(input: {
  row: PersonalProfileRow;
  accountId: string;
  membershipId: string;
}): string {
  return JSON.stringify({
    partnerUserId: input.row.id,
    accountId: input.accountId,
    membershipId: input.membershipId,
    displayName: input.row.name,
    updatedAt: input.row.updatedAt.toISOString(),
  });
}

function dto(row: PersonalProfileRow) {
  return {
    displayName: row.name,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadPersonalProfile(
  partnerUserId: string,
): Promise<PersonalProfileRow | null> {
  const [row] = await getDb()
    .select(personalProfileSelection)
    .from(partnerUsers)
    .where(
      and(
        eq(partnerUsers.id, partnerUserId),
        eq(partnerUsers.active, true),
        eq(partnerUsers.identityStatus, "active"),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function GET(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  const authentication = await resolvePartnerPrincipal(request);
  if (!authentication.ok) {
    return createPartnerPortalV2ErrorResponse(
      authentication.error,
      authentication.status,
      correlationId,
    );
  }
  const { principal } = authentication;
  if (!principal.accountId || !principal.membershipId) {
    return createPartnerPortalV2ErrorResponse("not_found", 404, correlationId);
  }
  if (!arePartnerPortalV2ReadsEnabled(principal.accountId)) {
    return createPartnerPortalV2ErrorResponse(
      "service_unavailable",
      503,
      correlationId,
    );
  }

  try {
    const row = await loadPersonalProfile(principal.partnerUserId);
    if (!row) {
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
        correlationId,
      );
    }
    return createPartnerPortalV2SuccessResponse(
      { ok: true, profile: dto(row) },
      correlationId,
      200,
      {
        ETag: createPortalV2StrongEtag(
          partnerPersonalProfileRevision({
            row,
            accountId: principal.accountId,
            membershipId: principal.membershipId,
          }),
        ),
      },
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
  const authentication = await resolvePartnerPrincipal(request);
  if (!authentication.ok) {
    return createPartnerPortalV2ErrorResponse(
      authentication.error,
      authentication.status,
      correlationId,
    );
  }
  const { principal } = authentication;
  if (!principal.accountId || !principal.membershipId) {
    return createPartnerPortalV2ErrorResponse("not_found", 404, correlationId);
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
      error instanceof BoundedJsonRequestError && error.code === "invalid_body"
        ? "invalid_body"
        : "invalid_request",
      error instanceof BoundedJsonRequestError ? error.status : 400,
      correlationId,
    );
  }
  const parsed = PersonalProfilePatchSchema.safeParse(raw);
  if (!parsed.success) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_fields",
      422,
      correlationId,
    );
  }

  try {
    const result = await getDb().transaction(async (tx) => {
      // Revalidate and lock the exact selected account membership alongside
      // the identity. A session resolved before a concurrent suspension may
      // not use this self-service writer after that suspension commits.
      const [current] = await tx
        .select(personalProfileSelection)
        .from(partnerAccountMemberships)
        .innerJoin(
          partnerAccounts,
          eq(partnerAccounts.id, partnerAccountMemberships.partnerAccountId),
        )
        .innerJoin(
          partnerUsers,
          eq(partnerUsers.id, partnerAccountMemberships.partnerUserId),
        )
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
            eq(partnerAccounts.portalAccessEnabled, true),
            eq(partnerUsers.active, true),
            eq(partnerUsers.identityStatus, "active"),
          ),
        )
        .for("update")
        .limit(1);
      if (!current) return { kind: "not_found" as const };

      const precondition = evaluatePortalV2RevisionPrecondition({
        ifMatch: request.headers.get("if-match"),
        currentRevision: partnerPersonalProfileRevision({
          row: current,
          accountId: principal.accountId!,
          membershipId: principal.membershipId!,
        }),
        correlationId,
      });
      if (!precondition.ok) {
        return {
          kind: "precondition" as const,
          response: precondition.response,
        };
      }

      const now = new Date();
      const [updated] = await tx
        .update(partnerUsers)
        .set({ name: parsed.data.displayName, updatedAt: now })
        .where(eq(partnerUsers.id, principal.partnerUserId))
        .returning(personalProfileSelection);
      if (!updated) return { kind: "not_found" as const };

      await tx.insert(auditLogs).values({
        actorType: "human",
        actorId: principal.partnerUserId,
        actorLabel: principal.email,
        actorRole: principal.roleKey,
        sessionId: principal.session.id,
        authMethod: "partner_session",
        correlationId,
        requiredPermissions: ["portal.session.read"],
        outcome: "succeeded",
        surface: "/partners/settings",
        action: "partner.personal_profile.updated",
        entityType: "partner_user",
        entityId: principal.partnerUserId,
        meta: sanitizeAuditMetadata({
          partnerAccountId: principal.accountId,
          partnerMembershipId: principal.membershipId,
          changedFields: ["display_name"],
        }),
      });

      return { kind: "success" as const, row: updated };
    });

    if (result.kind === "not_found") {
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
        correlationId,
      );
    }
    if (result.kind === "precondition") {
      return createPartnerPortalV2DescriptorResponse(result.response);
    }
    return createPartnerPortalV2SuccessResponse(
      { ok: true, profile: dto(result.row) },
      correlationId,
      200,
      {
        ETag: createPortalV2StrongEtag(
          partnerPersonalProfileRevision({
            row: result.row,
            accountId: principal.accountId,
            membershipId: principal.membershipId,
          }),
        ),
      },
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
