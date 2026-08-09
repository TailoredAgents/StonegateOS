import type { MutationResult } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { requireTeamPrincipal } from "@/app/api/team/auth";
import {
  isSameOriginPipelinePresetRequest,
  pipelinePresetIdempotencyKey,
  pipelinePresetProxyError,
  pipelinePresetProxyResult,
} from "../proxy";
import {
  parsePipelinePresetDeleteResult,
  readBoundedPipelinePresetMutationPayload,
  type PipelinePresetDeleteResult,
} from "@/app/team/pipeline-presets";
import { callAdminApiAs } from "@/app/team/lib/api";

export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAXIMUM_UPSTREAM_ATTEMPTS = 2;

function expectedVersion(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  const keys = Object.keys(payload);
  const version = payload["expectedVersion"];
  return keys.length === 1 &&
    keys[0] === "expectedVersion" &&
    Number.isSafeInteger(version) &&
    Number(version) >= 1 &&
    Number(version) <= 2_147_483_647
    ? Number(version)
    : null;
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ presetId?: string }> },
): Promise<Response> {
  if (!isSameOriginPipelinePresetRequest(request)) {
    return pipelinePresetProxyError(
      403,
      "forbidden",
      "The saved-filter request origin could not be verified. Nothing was changed.",
    );
  }
  const auth = await requireTeamPrincipal(request, {
    permissions: "pipeline.read",
    returnJson: true,
  });
  if (!auth.ok) {
    return pipelinePresetProxyError(
      auth.response.status === 403 ? 403 : 401,
      auth.response.status === 403 ? "forbidden" : "unauthorized",
      auth.response.status === 403
        ? "You do not have permission to delete pipeline filters."
        : "Sign in again before deleting a pipeline filter.",
    );
  }

  const { presetId: rawPresetId } = await context.params;
  const presetId = rawPresetId?.trim() ?? "";
  if (!UUID_PATTERN.test(presetId)) {
    return pipelinePresetProxyError(
      422,
      "invalid",
      "Choose a valid saved pipeline filter to delete.",
      { fieldErrors: { presetId: "Refresh saved filters." } },
    );
  }
  const idempotencyKey = pipelinePresetIdempotencyKey(request);
  if (!idempotencyKey) {
    return pipelinePresetProxyError(
      422,
      "invalid",
      "The delete operation cannot be retried safely.",
      { fieldErrors: { idempotencyKey: "Refresh and try again." } },
    );
  }

  const payload = await readBoundedPipelinePresetMutationPayload(
    new Response(request.body, { headers: request.headers }),
  );
  const version = expectedVersion(payload);
  const ifMatch = request.headers.get("if-match")?.trim() ?? "";
  if (version === null || ifMatch !== String(version)) {
    return pipelinePresetProxyError(
      422,
      "invalid",
      "The exact saved-filter version is required before deletion.",
      { fieldErrors: { version: "Refresh saved filters." } },
    );
  }

  const body = JSON.stringify({ expectedVersion: version });
  const headers = {
    "Idempotency-Key": idempotencyKey,
    "If-Match": String(version),
  } as const;
  let parsed: PipelinePresetDeleteResult | null = null;
  let responseStatus = 502;
  let correlationId: string | null = null;
  for (let attempt = 0; attempt < MAXIMUM_UPSTREAM_ATTEMPTS; attempt += 1) {
    try {
      const upstream = await callAdminApiAs(
        auth.principal,
        `/api/admin/crm/pipeline/presets/${encodeURIComponent(presetId)}`,
        { method: "DELETE", headers, body },
      );
      const upstreamPayload =
        await readBoundedPipelinePresetMutationPayload(upstream);
      const candidate = parsePipelinePresetDeleteResult(
        upstreamPayload,
        upstream.headers,
        {
          actorId: auth.principal.memberId,
          presetId,
          version,
        },
      );
      if (
        !candidate ||
        (candidate.ok && upstream.status !== 200) ||
        (!candidate.ok && upstream.ok)
      ) {
        continue;
      }
      parsed = candidate;
      responseStatus = upstream.status;
      correlationId = upstream.headers.get("x-correlation-id");
      break;
    } catch {
      // One identical replay recovers an acknowledgement lost after commit.
    }
  }

  if (!parsed) {
    return pipelinePresetProxyError(
      502,
      "internal",
      "The pipeline service returned no valid, correlated delete receipt. The deletion was not confirmed. Refresh before retrying.",
      { retryable: true },
    );
  }
  return pipelinePresetProxyResult(
    parsed as MutationResult<unknown>,
    responseStatus,
    correlationId,
  );
}
