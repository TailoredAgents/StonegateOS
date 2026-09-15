import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { LRUCache } from "lru-cache";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import {
  parseOpenAiAdsConsentId,
  recordOpenAiAdsConsentRevocation,
} from "@/lib/openai-ads-consent";

const limiter = new LRUCache<string, number>({ max: 2000, ttl: 60_000 });
const schema = z
  .object({
    consentId: z
      .string()
      .refine((value) => parseOpenAiAdsConsentId(value) !== null),
    consent: z.literal(false),
  })
  .strict();

function allowedOrigin(request: NextRequest): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  const configured = [
    process.env["CORS_ALLOW_ORIGINS"],
    process.env["NEXT_PUBLIC_SITE_URL"],
    process.env["SITE_URL"],
  ]
    .flatMap((value) => value?.split(",") ?? [])
    .map((value) => value.trim().replace(/\/+$/u, ""))
    .filter(Boolean);
  if (process.env["NODE_ENV"] !== "production")
    configured.push("http://localhost:3000", "http://127.0.0.1:3000");
  return configured.includes(origin) ? origin : null;
}

function response(
  body: unknown,
  status: number,
  origin: string | null,
): NextResponse {
  const result =
    status === 204
      ? new NextResponse(null, { status })
      : NextResponse.json(body, { status });
  result.headers.set("Cache-Control", "no-store");
  result.headers.set("Vary", "Origin");
  if (origin) {
    result.headers.set("Access-Control-Allow-Origin", origin);
    result.headers.set("Access-Control-Allow-Methods", "POST,OPTIONS");
    result.headers.set("Access-Control-Allow-Headers", "content-type");
    result.headers.set("Access-Control-Max-Age", "86400");
  }
  return result;
}

export function OPTIONS(request: NextRequest): Response {
  const origin = allowedOrigin(request);
  return response(null, origin ? 204 : 403, origin);
}

export async function POST(request: NextRequest): Promise<Response> {
  const origin = allowedOrigin(request);
  if (!origin)
    return response({ ok: false, error: "forbidden_origin" }, 403, null);
  // Render appends the peer address at the trusted right edge. Client-supplied
  // leftmost forwarding entries must not let a caller evade this limiter.
  const forwardedIp =
    request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() ?? "";
  const ip = isIP(forwardedIp) ? forwardedIp.toLowerCase() : "unknown";
  const key = createHash("sha256").update(ip).digest("hex");
  const count = limiter.get(key) ?? 0;
  if (count >= 120) {
    const result = response({ ok: false, error: "rate_limited" }, 429, origin);
    result.headers.set("Retry-After", "60");
    return result;
  }
  limiter.set(key, count + 1);
  try {
    const body = await readBoundedJsonRequest(request, {
      maximumBytes: 512,
      deadlineMs: 3000,
      rejectDuplicateObjectKeys: true,
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success)
      return response({ ok: false, error: "invalid_payload" }, 400, origin);
    await recordOpenAiAdsConsentRevocation(parsed.data.consentId);
    return response({ ok: true }, 200, origin);
  } catch (error) {
    if (error instanceof BoundedJsonRequestError)
      return response({ ok: false, error: error.code }, error.status, origin);
    return response(
      { ok: false, error: "consent_persistence_failed" },
      503,
      origin,
    );
  }
}
