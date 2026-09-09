import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import {
  PartnerAllocationReconciliationCommand,
  readPartnerAllocationReconciliation,
  reconcilePartnerPaymentAllocations,
} from "@/lib/partner-allocation-reconciliation";
import { readBoundedJsonRequest } from "@/lib/bounded-json-request";
import { requirePermission } from "@/lib/permissions";
import {
  beginTeamMutation,
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  teamMutationIdempotencyReplayResponse,
  type TeamMutationIdempotencyClaim,
} from "@/lib/team-mutation-idempotency";
const Params = z.object({
  accountId: z.string().uuid(),
  jobId: z.string().uuid(),
});
const headers = { "Cache-Control": "private, no-store", Pragma: "no-cache" };
type Context = { params: Promise<{ accountId: string; jobId: string }> };
export async function GET(request: NextRequest, context: Context) {
  const denied = await requirePermission(request, "partners.commercial.read");
  if (denied) return denied;
  const params = Params.safeParse(await context.params);
  if (!params.success)
    return NextResponse.json(
      { ok: false, error: "not_found" },
      { status: 404, headers },
    );
  try {
    const data = await getDb().transaction(
      (tx) =>
        readPartnerAllocationReconciliation(
          tx,
          params.data.accountId,
          params.data.jobId,
        ),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    const { appointmentId: _appointmentId, ...job } = data.job;
    return NextResponse.json(
      {
        ok: true,
        data: {
          ...data,
          job,
          invoices: data.invoices.map(
            ({
              providerInvoiceId,
              providerOrderId,
              hostedPaymentUrl,
              ...invoice
            }) => ({
              ...invoice,
              legacyCollection: Boolean(
                providerInvoiceId || providerOrderId || hostedPaymentUrl,
              ),
            }),
          ),
        },
      },
      { headers: { ...headers, ETag: `"${data.revision}"` } },
    );
  } catch (error) {
    return teamMutationExceptionResponse(error);
  }
}
export async function POST(request: NextRequest, context: Context) {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["partners.commercial.manage"],
    risk: "financial",
    requiresIdempotency: true,
    maxAuthenticationAgeSeconds: 15 * 60,
    auditAction: "partner_billing.allocations_reconciled",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const params = Params.safeParse(await context.params);
    if (!params.success)
      return teamMutationErrorResponse(
        "invalid",
        "Choose a valid company job.",
        { correlationId: mutation.correlationId },
      );
    const parsed = PartnerAllocationReconciliationCommand.safeParse(
      await readBoundedJsonRequest(request, {
        maximumBytes: 256 * 1024,
        deadlineMs: 10_000,
        rejectDuplicateObjectKeys: true,
      }),
    );
    if (!parsed.success)
      return teamMutationErrorResponse(
        "invalid",
        "Check every payment, invoice, refund allocation, and supporting evidence.",
        { correlationId: mutation.correlationId },
      );
    const claimed = await claimTeamMutationIdempotency(getDb(), mutation, {
      route:
        "POST /api/admin/partner-management/v1/accounts/:accountId/billing/reconciliation/:jobId",
      entityType: "partner_billing_reconciliation",
      entityId: params.data.jobId,
      payload: { accountId: params.data.accountId, command: parsed.data },
    });
    if (claimed.kind === "replay")
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    claim = claimed.claim;
    const result = await getDb().transaction(async (tx) => {
      const changed = await reconcilePartnerPaymentAllocations(tx, {
        ...params.data,
        actorId: mutation.actor.id!,
        correlationId: mutation.correlationId,
        expectedVersion: mutation.expectedVersion ?? null,
        command: parsed.data,
      });
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "partner_billing_reconciliation",
        entityId: changed.reconciliationId,
        after: changed,
        metadata: {
          accountId: params.data.accountId,
          jobId: params.data.jobId,
          reason: parsed.data.reason,
          monetaryProviderActionPerformed: false,
        },
      });
      const receipt = teamMutationSuccessResult(mutation, changed, {
        auditEventId: audit.auditEventId,
        committedAt: audit.committedAt,
        entityType: "partner_billing_reconciliation",
        entityId: changed.reconciliationId,
        version: changed.revision,
      });
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        receipt,
        200,
      );
      return receipt;
    });
    return teamMutationResultResponse(
      result,
      200,
      mutation.correlationId,
      headers,
    );
  } catch (error) {
    if (claim)
      await settleTeamMutationIdempotencyFailure(
        getDb(),
        mutation,
        claim,
        error,
      ).catch(() => undefined);
    return teamMutationExceptionResponse(error, mutation);
  }
}
