import type { NextRequest } from "next/server";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import {
  auditLogs,
  getDb,
  partnerAccountLocations,
  partnerAccounts,
  partnerBookings,
  partnerEvidenceRequirements,
} from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { arePartnerPortalV2WritesEnabled } from "@/lib/partner-portal-feature-flags";
import {
  createPartnerJobAccessCondition,
  createPartnerJobLocationJoinCondition,
  hasPartnerJobAccess,
} from "@/lib/partner-portal-v2-resource-authorization";
import {
  isAllowedPartnerPortalMutationOrigin,
  isPortalV2Uuid,
} from "@/lib/partner-portal-v2-security";
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

const UpdateSchema = z
  .object({
    requirements: z
      .array(
        z
          .object({
            category: z.enum([
              "intake",
              "before",
              "after",
              "completion",
              "issue",
              "document",
            ]),
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

function revision(
  accountId: string,
  jobId: string,
  rows: readonly RequirementRow[],
): string {
  return JSON.stringify({
    accountId,
    jobId,
    requirements: rows.map((row) => [
      row.id,
      row.partnerBookingId,
      row.category,
      row.required,
      row.minimumCount,
      row.updatedAt.toISOString(),
    ]),
  });
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (!isAllowedPartnerPortalMutationOrigin(request)) {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  const authorization = await requirePartnerCapability(
    request,
    "proof.request",
  );
  if (!authorization.ok) {
    return createPartnerPortalV2ErrorResponse(
      authorization.error,
      authorization.status,
      correlationId,
    );
  }
  const { principal } = authorization;
  const { jobId } = await context.params;
  if (
    !principal.accountId ||
    !principal.membershipId ||
    !isPortalV2Uuid(jobId)
  ) {
    return createPartnerPortalV2ErrorResponse("not_found", 404, correlationId);
  }
  if (!arePartnerPortalV2WritesEnabled(principal.accountId)) {
    return createPartnerPortalV2ErrorResponse(
      "service_unavailable",
      503,
      correlationId,
    );
  }
  try {
    if (!(await hasPartnerJobAccess(principal, jobId))) {
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
        correlationId,
      );
    }
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
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
        .where(eq(partnerAccounts.id, principal.accountId!))
        .for("update")
        .limit(1);
      if (!account) return { kind: "not_found" as const };
      const [job] = await tx
        .select({ id: partnerBookings.id })
        .from(partnerBookings)
        .leftJoin(
          partnerAccountLocations,
          createPartnerJobLocationJoinCondition(),
        )
        .where(createPartnerJobAccessCondition(principal, jobId))
        .for("update", { of: partnerBookings })
        .limit(1);
      if (!job) return { kind: "not_found" as const };
      const effectiveRows = await tx
        .select()
        .from(partnerEvidenceRequirements)
        .where(
          and(
            eq(
              partnerEvidenceRequirements.partnerAccountId,
              principal.accountId!,
            ),
            or(
              isNull(partnerEvidenceRequirements.partnerBookingId),
              eq(partnerEvidenceRequirements.partnerBookingId, jobId),
            ),
          ),
        )
        .orderBy(
          asc(partnerEvidenceRequirements.category),
          asc(partnerEvidenceRequirements.partnerBookingId),
        );
      const precondition = evaluatePortalV2RevisionPrecondition({
        ifMatch: request.headers.get("if-match"),
        currentRevision: revision(principal.accountId!, jobId, effectiveRows),
        correlationId,
      });
      if (!precondition.ok) {
        return {
          kind: "precondition" as const,
          response: precondition.response,
        };
      }
      const jobRows = effectiveRows.filter(
        (row) => row.partnerBookingId === jobId,
      );
      const byCategory = new Map(jobRows.map((row) => [row.category, row]));
      const now = new Date();
      for (const requirement of parsed.data.requirements) {
        const existing = byCategory.get(requirement.category);
        if (existing) {
          await tx
            .update(partnerEvidenceRequirements)
            .set({
              required: requirement.required,
              minimumCount: requirement.minimumCount,
              source: "job_override",
              updatedAt: now,
            })
            .where(eq(partnerEvidenceRequirements.id, existing.id));
        } else {
          await tx.insert(partnerEvidenceRequirements).values({
            partnerAccountId: principal.accountId!,
            partnerBookingId: jobId,
            category: requirement.category,
            required: requirement.required,
            minimumCount: requirement.minimumCount,
            source: "job_override",
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
        requiredPermissions: ["proof.request"],
        surface: "partner_portal_v2",
        action: "partner.job_proof_requirements.updated",
        entityType: "partner_booking",
        entityId: jobId,
        meta: {
          partnerAccountId: principal.accountId,
          categories: parsed.data.requirements.map((row) => row.category),
        },
      });
      const updatedRows = await tx
        .select()
        .from(partnerEvidenceRequirements)
        .where(
          and(
            eq(
              partnerEvidenceRequirements.partnerAccountId,
              principal.accountId!,
            ),
            or(
              isNull(partnerEvidenceRequirements.partnerBookingId),
              eq(partnerEvidenceRequirements.partnerBookingId, jobId),
            ),
          ),
        )
        .orderBy(
          asc(partnerEvidenceRequirements.category),
          asc(partnerEvidenceRequirements.partnerBookingId),
        );
      return { kind: "success" as const, rows: updatedRows };
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
      revision(principal.accountId, jobId, result.rows),
    );
    const effective = new Map<string, RequirementRow>();
    for (const row of result.rows) {
      const current = effective.get(row.category);
      if (!current || row.partnerBookingId === jobId) {
        effective.set(row.category, row);
      }
    }
    return createPartnerPortalV2SuccessResponse(
      {
        ok: true,
        requirements: [...effective.values()].map((row) => ({
          id: row.id,
          category: row.category,
          required: row.required,
          minimumCount: row.minimumCount,
          source: row.partnerBookingId ? "job_override" : row.source,
          updatedAt: row.updatedAt.toISOString(),
        })),
      },
      correlationId,
      200,
      { ETag: etag },
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
