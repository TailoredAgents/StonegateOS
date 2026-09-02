import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, partnerAccountCancellationPolicies } from "@/db";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { arePartnerPortalV2ReadsEnabled } from "@/lib/partner-portal-feature-flags";
import {
  resolvePartnerCancellationPolicy,
  resolvePersistedPartnerAccountCancellationPolicy,
} from "@/lib/partner-portal-v2-cancellation";
import {
  createPortalV2StrongEtag,
  readPortalV2CorrelationId,
} from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";

export async function GET(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  const authorization = await requirePartnerCapability(
    request,
    "bookings.create",
  );
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
    const [row] = await getDb()
      .select()
      .from(partnerAccountCancellationPolicies)
      .where(
        eq(
          partnerAccountCancellationPolicies.partnerAccountId,
          principal.accountId,
        ),
      )
      .limit(1);
    const policy = resolvePartnerCancellationPolicy({
      accountPolicy: resolvePersistedPartnerAccountCancellationPolicy(
        row ?? null,
      ),
    });
    const etag = createPortalV2StrongEtag(
      [
        principal.accountId,
        policy.source,
        policy.revision ?? 0,
        policy.cutoffMinutes,
        policy.directCancellationEnabled,
        policy.lateCancellationDisposition,
        policy.automaticFeeMinor ?? "none",
      ].join(":"),
    );
    return createPartnerPortalV2SuccessResponse(
      {
        ok: true,
        policy: {
          minimumNoticeMinutes: policy.cutoffMinutes,
          directCancellationEnabled: policy.directCancellationEnabled,
          lateCancellationDisposition: policy.lateCancellationDisposition,
          automaticFeeMinor: policy.automaticFeeMinor,
          source: policy.source,
          revision: policy.revision,
        },
      },
      correlationId,
      200,
      { ETag: etag },
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
