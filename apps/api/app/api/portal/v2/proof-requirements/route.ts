import type { NextRequest } from "next/server";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  auditLogs,
  getDb,
  partnerAccounts,
  partnerEvidenceRequirements,
} from "@/db";
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

const CategorySchema = z.enum([
  "intake",
  "before",
  "after",
  "completion",
  "issue",
  "document",
]);
const UpdateSchema = z
  .object({
    requirements: z
      .array(
        z
          .object({
            category: CategorySchema,
            required: z.boolean(),
            minimumCount: z.number().int().min(0).max(40),
          })
          .strict(),
      )
      .min(1)
      .max(6),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const [index, requirement] of value.requirements.entries()) {
      if (seen.has(requirement.category)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requirements", index, "category"],
          message: "Each proof category can appear only once.",
        });
      }
      seen.add(requirement.category);
    }
  });

type RequirementRow = typeof partnerEvidenceRequirements.$inferSelect;

function revision(accountId: string, rows: readonly RequirementRow[]): string {
  return JSON.stringify({
    accountId,
    requirements: rows.map((row) => [
      row.id,
      row.category,
      row.required,
      row.minimumCount,
      row.updatedAt.toISOString(),
    ]),
  });
}

function dto(row: RequirementRow) {
  return {
    id: row.id,
    category: row.category,
    required: row.required,
    minimumCount: row.minimumCount,
    source: row.source,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadDefaults(accountId: string): Promise<RequirementRow[]> {
  return getDb()
    .select()
    .from(partnerEvidenceRequirements)
    .where(
      and(
        eq(partnerEvidenceRequirements.partnerAccountId, accountId),
        isNull(partnerEvidenceRequirements.partnerBookingId),
      ),
    )
    .orderBy(asc(partnerEvidenceRequirements.category));
}

export async function GET(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  const authorization = await requirePartnerCapability(request, "proof.read");
  if (!authorization.ok) {
    return createPartnerPortalV2ErrorResponse(
      authorization.error,
      authorization.status,
      correlationId,
    );
  }
  const { principal } = authorization;
  if (!principal.accountId) {
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
  try {
    const rows = await loadDefaults(principal.accountId);
    const etag = createPortalV2StrongEtag(revision(principal.accountId, rows));
    return createPartnerPortalV2SuccessResponse(
      { ok: true, requirements: rows.map(dto) },
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
  const authorization = await requirePartnerCapability(
    request,
    "account.update",
  );
  if (!authorization.ok) {
    return createPartnerPortalV2ErrorResponse(
      authorization.error,
      authorization.status,
      correlationId,
    );
  }
  const { principal } = authorization;
  if (!principal.accountId || !principal.membershipId) {
    return createPartnerPortalV2ErrorResponse(
      "legacy_scope_unavailable",
      409,
      correlationId,
    );
  }
  if (principal.accessLevel !== "account") {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
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
      maximumBytes: 8 * 1024,
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
      const [account] = await tx
        .select({ id: partnerAccounts.id })
        .from(partnerAccounts)
        .where(
          and(
            eq(partnerAccounts.id, principal.accountId!),
            eq(partnerAccounts.portalAccessEnabled, true),
          ),
        )
        .for("update")
        .limit(1);
      if (!account) return { kind: "not_found" as const };
      const current = await tx
        .select()
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
        .orderBy(asc(partnerEvidenceRequirements.category));
      const precondition = evaluatePortalV2RevisionPrecondition({
        ifMatch: request.headers.get("if-match"),
        currentRevision: revision(principal.accountId!, current),
        correlationId,
      });
      if (!precondition.ok) {
        return {
          kind: "precondition" as const,
          response: precondition.response,
        };
      }
      const currentByCategory = new Map(
        current.map((row) => [row.category, row]),
      );
      const now = new Date();
      for (const requirement of parsed.data.requirements) {
        const existing = currentByCategory.get(requirement.category);
        if (existing) {
          await tx
            .update(partnerEvidenceRequirements)
            .set({
              required: requirement.required,
              minimumCount: requirement.minimumCount,
              source: "account_default",
              updatedAt: now,
            })
            .where(eq(partnerEvidenceRequirements.id, existing.id));
        } else {
          await tx.insert(partnerEvidenceRequirements).values({
            partnerAccountId: principal.accountId!,
            category: requirement.category,
            required: requirement.required,
            minimumCount: requirement.minimumCount,
            source: "account_default",
            createdAt: now,
            updatedAt: now,
          });
        }
      }
      await tx.insert(auditLogs).values({
        actorType: "human",
        actorId: principal.partnerUserId,
        actorLabel: principal.email,
        actorRole: principal.roleKey,
        sessionId: principal.session.id,
        authMethod: "partner_session",
        correlationId,
        requiredPermissions: ["account.update"],
        surface: "partner_portal_v2",
        action: "partner.proof_requirements.updated",
        entityType: "partner_account",
        entityId: principal.accountId,
        meta: {
          partnerAccountId: principal.accountId,
          categories: parsed.data.requirements.map((row) => row.category),
        },
      });
      const updated = await tx
        .select()
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
        .orderBy(asc(partnerEvidenceRequirements.category));
      return { kind: "success" as const, rows: updated };
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
    const etag = createPortalV2StrongEtag(
      revision(principal.accountId, result.rows),
    );
    return createPartnerPortalV2SuccessResponse(
      { ok: true, requirements: result.rows.map(dto) },
      correlationId,
      200,
      { ETag: etag },
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
