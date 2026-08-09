import type { MutationResult } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { requireTeamPrincipal } from "@/app/api/team/auth";
import {
  isSameOriginPipelinePresetRequest,
  pipelinePresetIdempotencyKey,
  pipelinePresetProxyError,
  pipelinePresetProxyResult,
} from "./proxy";
import {
  parsePipelinePresetCreateResult,
  readBoundedPipelinePresetMutationPayload,
  type PipelinePresetCreateResult,
} from "@/app/team/pipeline-presets";
import { callAdminApiAs } from "@/app/team/lib/api";
import {
  PIPELINE_STAGES,
  type PipelineStage,
} from "@/app/team/components/pipeline.stages";

export const dynamic = "force-dynamic";

const STAGES = new Set<string>(PIPELINE_STAGES);
const SAFE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 &'(),./_-]{0,59}$/u;
const MAXIMUM_UPSTREAM_ATTEMPTS = 2;

type CreateInput = {
  name: string;
  q: string;
  stage: PipelineStage | null;
  excludeOutbound: boolean;
  view: "board" | "list";
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeSpaces(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function hasUnsafeTextCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 31 ||
      codePoint === 127 ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    );
  });
}

function parseCreateInput(value: unknown): CreateInput | null {
  const payload = record(value);
  if (!payload) return null;
  const keys = Object.keys(payload).sort();
  const expected = ["excludeOutbound", "name", "q", "stage", "view"];
  if (
    keys.length !== expected.length ||
    expected.some((key, index) => keys[index] !== key)
  ) {
    return null;
  }
  const name =
    typeof payload["name"] === "string" ? normalizeSpaces(payload["name"]) : "";
  const q =
    typeof payload["q"] === "string" ? normalizeSpaces(payload["q"]) : "";
  const rawStage = payload["stage"];
  const stage =
    rawStage === null
      ? null
      : typeof rawStage === "string" && STAGES.has(rawStage)
        ? (rawStage as PipelineStage)
        : undefined;
  if (
    !SAFE_NAME_PATTERN.test(name) ||
    hasUnsafeTextCharacter(name) ||
    q.length > 120 ||
    hasUnsafeTextCharacter(q) ||
    stage === undefined ||
    typeof payload["excludeOutbound"] !== "boolean" ||
    (payload["view"] !== "board" && payload["view"] !== "list")
  ) {
    return null;
  }
  return {
    name,
    q,
    stage,
    excludeOutbound: payload["excludeOutbound"],
    view: payload["view"],
  };
}

export async function POST(request: NextRequest): Promise<Response> {
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
        ? "You do not have permission to save pipeline filters."
        : "Sign in again before saving a pipeline filter.",
    );
  }

  const idempotencyKey = pipelinePresetIdempotencyKey(request);
  if (!idempotencyKey) {
    return pipelinePresetProxyError(
      422,
      "invalid",
      "The saved-filter operation cannot be retried safely.",
      { fieldErrors: { idempotencyKey: "Refresh and try again." } },
    );
  }
  const payload = await readBoundedPipelinePresetMutationPayload(
    new Response(request.body, { headers: request.headers }),
  );
  const input = parseCreateInput(payload);
  if (!input) {
    return pipelinePresetProxyError(
      422,
      "invalid",
      "Enter a safe name and valid pipeline filter settings.",
      {
        fieldErrors: {
          body: "Only name, search, stage, outbound visibility, and view are accepted.",
        },
      },
    );
  }

  const body = JSON.stringify(input);
  const headers = { "Idempotency-Key": idempotencyKey } as const;
  let parsed: PipelinePresetCreateResult | null = null;
  let responseStatus = 502;
  let correlationId: string | null = null;
  for (let attempt = 0; attempt < MAXIMUM_UPSTREAM_ATTEMPTS; attempt += 1) {
    try {
      const upstream = await callAdminApiAs(
        auth.principal,
        "/api/admin/crm/pipeline/presets",
        { method: "POST", headers, body },
      );
      const upstreamPayload =
        await readBoundedPipelinePresetMutationPayload(upstream);
      const candidate = parsePipelinePresetCreateResult(
        upstreamPayload,
        upstream.headers,
        { actorId: auth.principal.memberId, ...input },
      );
      if (
        !candidate ||
        (candidate.ok && upstream.status !== 201) ||
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
      "The pipeline service returned no valid, correlated save receipt. The preset was not confirmed. Refresh before retrying.",
      { retryable: true },
    );
  }
  return pipelinePresetProxyResult(
    parsed as MutationResult<unknown>,
    responseStatus,
    correlationId,
  );
}
