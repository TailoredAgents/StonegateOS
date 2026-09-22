import { queuePartnerVisitCalendarCancellations } from "./partner-visit-calendar-cancellation";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { readBoundedJsonRequest } from "./bounded-json-request";
import {
  beginTeamMutation,
  TeamMutationFailure,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "./team-mutation";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  teamMutationIdempotencyReplayResponse,
  type TeamMutationIdempotencyClaim,
} from "./team-mutation-idempotency";
import {
  PartnerMultiServicePriceSchema,
  PartnerMultiServiceVisitSchema,
  PartnerMultiServiceVisitStatusSchema,
} from "./partner-multi-service-domain";
import {
  createPartnerMultiServiceVisit,
  pricePartnerMultiServiceRequest,
  updatePartnerMultiServiceVisit,
} from "./partner-multi-service";

export async function partnerMultiServiceMutationRoute(
  request: NextRequest,
  context: { params: Promise<{ jobId?: string; visitId?: string }> },
  operation: "price" | "visit" | "visit_status" | "visit_reschedule",
) {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions:
      operation === "price"
        ? [
            "partners.accounts.read",
            "appointments.read",
            "partners.commercial.manage",
          ]
        : [
            "partners.accounts.read",
            "appointments.read",
            "appointments.update",
          ],
    risk: operation === "price" ? "financial" : "external",
    requiresIdempotency: true,
    maxAuthenticationAgeSeconds: 15 * 60,
    auditAction: `partner.multi_service.${operation}`,
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;
  const db = getDb();
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const { jobId, visitId } = await context.params;
    if (
      !z.string().uuid().safeParse(jobId).success ||
      ((operation === "visit_status" || operation === "visit_reschedule") &&
        !z.string().uuid().safeParse(visitId).success)
    )
      throw new TeamMutationFailure(
        "invalid",
        "Choose an existing request or visit.",
        { status: 404 },
      );
    if (!mutation.expectedVersion || mutation.expectedVersion === "*")
      throw new TeamMutationFailure(
        "invalid",
        "The latest request version is required.",
      );
    const raw = await readBoundedJsonRequest(request, {
      maximumBytes: 64 * 1024,
      deadlineMs: 10000,
      rejectDuplicateObjectKeys: true,
    });
    const schema =
      operation === "price"
        ? PartnerMultiServicePriceSchema
        : operation === "visit" || operation === "visit_reschedule"
          ? PartnerMultiServiceVisitSchema
          : PartnerMultiServiceVisitStatusSchema;
    const parsed = schema.safeParse(raw);
    if (!parsed.success)
      throw new TeamMutationFailure("invalid", "Review the request details.", {
        fieldErrors: Object.fromEntries(
          parsed.error.issues.map((issue) => [
            issue.path.join("."),
            issue.message,
          ]),
        ),
      });
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: `${request.method} /api/admin/partner-management/v1/service-requests/:jobId/${operation}`,
      entityType: "partner_booking",
      entityId: jobId!,
      payload: { ...parsed.data, visitId: visitId ?? null },
    });
    if (claimed.kind === "replay")
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    claim = claimed.claim;
    const result = await db.transaction(async (tx) => {
      const changedAt = new Date();
      const data =
        operation === "price"
          ? await pricePartnerMultiServiceRequest(
              tx,
              mutation,
              jobId!,
              PartnerMultiServicePriceSchema.parse(parsed.data),
            )
          : operation === "visit" || operation === "visit_reschedule"
            ? await createPartnerMultiServiceVisit(
                tx,
                mutation,
                jobId!,
                PartnerMultiServiceVisitSchema.parse(parsed.data),
                new Date(),
                operation === "visit_reschedule" ? visitId : undefined,
              )
            : await updatePartnerMultiServiceVisit(
                tx,
                mutation,
                jobId!,
                visitId!,
                PartnerMultiServiceVisitStatusSchema.parse(parsed.data),
                changedAt,
              );
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "partner_booking",
        entityId: jobId,
        after: data,
        metadata: { operation, accountId: parsed.data.accountId },
      });
      if (
        operation === "visit_status" &&
        PartnerMultiServiceVisitStatusSchema.parse(parsed.data).status ===
          "canceled"
      )
        await queuePartnerVisitCalendarCancellations(tx, {
          accountId: parsed.data.accountId,
          bookingId: jobId!,
          visitId: visitId!,
          changedAt,
          sourceAuditEventId: audit.auditEventId,
        });
      const response = teamMutationSuccessResult(mutation, data, {
        auditEventId: audit.auditEventId,
        committedAt: audit.committedAt,
        entityType: "partner_booking",
        entityId: jobId!,
        version: String(data.version),
      });
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        response,
        200,
      );
      return response;
    });
    return teamMutationResultResponse(result, 200, mutation.correlationId, {
      "Cache-Control": "private, no-store, max-age=0",
    });
  } catch (error) {
    if (claim)
      await settleTeamMutationIdempotencyFailure(
        db,
        mutation,
        claim,
        error,
      ).catch(() => undefined);
    return teamMutationExceptionResponse(error, mutation);
  }
}
