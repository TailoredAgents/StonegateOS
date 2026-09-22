import { NextResponse, type NextRequest } from "next/server";
import { PartnerServiceRateWriteSchema } from "@myst-os/pricing";
import { getDb } from "@/db";
import { requirePermission } from "./permissions";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "./bounded-json-request";
import {
  readPartnerServiceRateEditor,
  savePartnerServiceRates,
} from "./partner-structured-rates";
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

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HEADERS = { "Cache-Control": "private, no-store" };
export async function getPartnerServiceRates(
  request: NextRequest,
  accountId: string,
): Promise<Response> {
  const denied = await requirePermission(
    request,
    ["partners.accounts.read", "partners.commercial.read"],
    { mode: "all" },
  );
  if (denied) return denied;
  if (!UUID.test(accountId))
    return NextResponse.json(
      { ok: false, error: "not_found" },
      { status: 404, headers: HEADERS },
    );
  try {
    const data = await readPartnerServiceRateEditor(getDb(), accountId);
    return NextResponse.json(
      { ok: true, ...data },
      { headers: { ...HEADERS, ETag: '"' + data.revision + '"' } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: "rates_unavailable",
        message: "The company's rates could not be loaded. Try again.",
      },
      {
        status: error instanceof TeamMutationFailure ? error.status : 503,
        headers: HEADERS,
      },
    );
  }
}

export async function mutatePartnerServiceRates(
  request: NextRequest,
  accountId: string,
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["partners.rates", "partners.accounts.manage"],
    risk: "financial",
    requiresIdempotency: true,
    auditAction: "partner.service_rates.saved",
  });
  if (!boundary.ok) return boundary.response;
  const mutation = boundary.mutation;
  const db = getDb();
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    if (!UUID.test(accountId))
      throw new TeamMutationFailure("invalid", "Choose an existing company.");
    const raw = await readBoundedJsonRequest(request, {
      maximumBytes: 131_072,
      deadlineMs: 10_000,
      rejectDuplicateObjectKeys: true,
    });
    const parsed = PartnerServiceRateWriteSchema.safeParse(raw);
    if (!parsed.success)
      throw new TeamMutationFailure(
        "invalid",
        "Check the service rates and try again.",
        {
          fieldErrors: Object.fromEntries(
            parsed.error.issues.map((issue) => [
              issue.path.join("."),
              issue.message,
            ]),
          ),
        },
      );
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route:
        "PATCH /api/admin/partner-management/v1/accounts/:accountId/service-rates",
      entityType: "partner_account",
      entityId: accountId,
      payload: parsed.data,
    });
    if (claimed.kind === "replay")
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    claim = claimed.claim;
    const result = await db.transaction(async (tx) => {
      const data = await savePartnerServiceRates(
        tx,
        mutation,
        accountId,
        parsed.data,
      );
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "partner_rate_card",
        entityId: data.publishedVersionId ?? accountId,
        metadata: {
          accountId,
          action: data.action,
          publishedVersionId: data.publishedVersionId,
          rateCount: parsed.data.card.rates.length,
        },
      });
      const success = teamMutationSuccessResult(mutation, data, {
        entityType: "partner_account",
        entityId: accountId,
        version: data.revision,
        auditEventId: audit.auditEventId,
        committedAt: audit.committedAt,
      });
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        success,
        200,
      );
      return success;
    });
    return teamMutationResultResponse(
      result,
      200,
      mutation.correlationId,
      HEADERS,
    );
  } catch (error) {
    const safe =
      error instanceof BoundedJsonRequestError
        ? new TeamMutationFailure("invalid", "The request body is invalid.", {
            status: error.status,
          })
        : error;
    if (claim)
      await settleTeamMutationIdempotencyFailure(
        db,
        mutation,
        claim,
        safe,
      ).catch(() => undefined);
    return teamMutationExceptionResponse(safe, mutation);
  }
}
