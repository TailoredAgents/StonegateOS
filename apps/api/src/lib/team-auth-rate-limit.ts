import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { getDb, teamAuthRateLimits } from "@/db";

export type TeamAuthRateLimitAction =
  | "request_link"
  | "password_login"
  | "break_glass_exchange"
  | "partner_request_link"
  | "partner_password_login"
  | "partner_magic_link_exchange"
  | "partner_access_application"
  | "partner_application_mutation"
  | "partner_join_request"
  | "partner_session_revoke"
  | "partner_notification_preferences"
  | "partner_notification_endpoint_request"
  | "partner_notification_endpoint_verify"
  | "partner_notification_endpoint_revoke"
  | "partner_approval_decision"
  | "partner_quote_decision"
  | "partner_document_download"
  | "partner_payment_checkout"
  | "partner_member_management"
  | "partner_invitation_management"
  | "partner_invitation_accept"
  | "partner_join_decision"
  | "partner_password_change"
  | "partner_email_change_request"
  | "partner_email_change_confirm"
  | "partner_email_verification_request"
  | "partner_email_verification_consume"
  | "partner_activation"
  | "partner_password_reset";
export type TeamAuthRateLimitIdentity = {
  kind:
    | "email"
    | "phone"
    | "break_glass"
    | "token"
    | "team_member"
    | "partner_user";
  value: string;
};

type RateLimitRule = {
  limit: number;
  windowMs: number;
};

type RateLimitPolicy = {
  ip: RateLimitRule;
  identity: RateLimitRule;
};

export const TEAM_AUTH_RATE_LIMIT_POLICIES: Record<
  TeamAuthRateLimitAction,
  RateLimitPolicy
> = {
  request_link: {
    ip: { limit: 10, windowMs: 15 * 60 * 1_000 },
    identity: { limit: 3, windowMs: 15 * 60 * 1_000 },
  },
  password_login: {
    ip: { limit: 30, windowMs: 15 * 60 * 1_000 },
    identity: { limit: 5, windowMs: 15 * 60 * 1_000 },
  },
  break_glass_exchange: {
    ip: { limit: 5, windowMs: 15 * 60 * 1_000 },
    identity: { limit: 3, windowMs: 15 * 60 * 1_000 },
  },
  partner_request_link: {
    ip: { limit: 10, windowMs: 15 * 60 * 1_000 },
    identity: { limit: 3, windowMs: 15 * 60 * 1_000 },
  },
  partner_password_login: {
    ip: { limit: 30, windowMs: 15 * 60 * 1_000 },
    identity: { limit: 5, windowMs: 15 * 60 * 1_000 },
  },
  partner_magic_link_exchange: {
    ip: { limit: 30, windowMs: 15 * 60 * 1_000 },
    identity: { limit: 8, windowMs: 15 * 60 * 1_000 },
  },
  partner_access_application: {
    ip: { limit: 10, windowMs: 60 * 60 * 1_000 },
    identity: { limit: 3, windowMs: 24 * 60 * 60 * 1_000 },
  },
  partner_application_mutation: {
    ip: { limit: 60, windowMs: 60 * 60 * 1_000 },
    identity: { limit: 20, windowMs: 60 * 60 * 1_000 },
  },
  partner_join_request: {
    ip: { limit: 30, windowMs: 60 * 60 * 1_000 },
    identity: { limit: 10, windowMs: 60 * 60 * 1_000 },
  },
  partner_session_revoke: {
    ip: { limit: 60, windowMs: 15 * 60 * 1_000 },
    identity: { limit: 20, windowMs: 15 * 60 * 1_000 },
  },
  partner_notification_preferences: {
    ip: { limit: 120, windowMs: 15 * 60 * 1_000 },
    identity: { limit: 60, windowMs: 15 * 60 * 1_000 },
  },
  partner_notification_endpoint_request: {
    ip: { limit: 10, windowMs: 60 * 60 * 1_000 },
    identity: { limit: 5, windowMs: 60 * 60 * 1_000 },
  },
  partner_notification_endpoint_verify: {
    ip: { limit: 30, windowMs: 15 * 60 * 1_000 },
    identity: { limit: 10, windowMs: 15 * 60 * 1_000 },
  },
  partner_notification_endpoint_revoke: {
    ip: { limit: 30, windowMs: 60 * 60 * 1_000 },
    identity: { limit: 15, windowMs: 60 * 60 * 1_000 },
  },
  partner_approval_decision: {
    ip: { limit: 60, windowMs: 60 * 60 * 1_000 },
    identity: { limit: 30, windowMs: 60 * 60 * 1_000 },
  },
  partner_quote_decision: {
    ip: { limit: 60, windowMs: 60 * 60 * 1_000 },
    identity: { limit: 30, windowMs: 60 * 60 * 1_000 },
  },
  partner_document_download: {
    ip: { limit: 240, windowMs: 60 * 60 * 1_000 },
    identity: { limit: 120, windowMs: 60 * 60 * 1_000 },
  },
  partner_payment_checkout: {
    ip: { limit: 60, windowMs: 60 * 60 * 1_000 },
    identity: { limit: 12, windowMs: 60 * 60 * 1_000 },
  },
  partner_member_management: {
    ip: { limit: 120, windowMs: 60 * 60 * 1_000 },
    identity: { limit: 40, windowMs: 60 * 60 * 1_000 },
  },
  partner_invitation_management: {
    ip: { limit: 60, windowMs: 60 * 60 * 1_000 },
    identity: { limit: 20, windowMs: 60 * 60 * 1_000 },
  },
  partner_invitation_accept: {
    ip: { limit: 30, windowMs: 15 * 60 * 1_000 },
    identity: { limit: 8, windowMs: 15 * 60 * 1_000 },
  },
  partner_join_decision: {
    ip: { limit: 60, windowMs: 60 * 60 * 1_000 },
    identity: { limit: 30, windowMs: 60 * 60 * 1_000 },
  },
  partner_password_change: {
    ip: { limit: 15, windowMs: 15 * 60 * 1_000 },
    identity: { limit: 5, windowMs: 15 * 60 * 1_000 },
  },
  partner_email_change_request: {
    ip: { limit: 10, windowMs: 60 * 60 * 1_000 },
    identity: { limit: 5, windowMs: 60 * 60 * 1_000 },
  },
  partner_email_change_confirm: {
    ip: { limit: 20, windowMs: 60 * 60 * 1_000 },
    identity: { limit: 8, windowMs: 60 * 60 * 1_000 },
  },
  partner_email_verification_request: {
    ip: { limit: 10, windowMs: 60 * 60 * 1_000 },
    identity: { limit: 3, windowMs: 60 * 60 * 1_000 },
  },
  partner_email_verification_consume: {
    ip: { limit: 30, windowMs: 15 * 60 * 1_000 },
    identity: { limit: 8, windowMs: 15 * 60 * 1_000 },
  },
  partner_activation: {
    ip: { limit: 20, windowMs: 60 * 60 * 1_000 },
    identity: { limit: 8, windowMs: 60 * 60 * 1_000 },
  },
  partner_password_reset: {
    ip: { limit: 15, windowMs: 60 * 60 * 1_000 },
    identity: { limit: 5, windowMs: 60 * 60 * 1_000 },
  },
};

const RATE_LIMIT_BYPASS_HEADER = "x-team-auth-rate-limit-bypass";
const DEVELOPMENT_HMAC_SECRET =
  "stonegate-team-auth-rate-limit-development-only-secret";

function readSecret(): string {
  const configured =
    process.env["TEAM_AUTH_RATE_LIMIT_SECRET"]?.trim() ||
    process.env["ADMIN_API_KEY"]?.trim();
  if (configured) {
    if (
      process.env["NODE_ENV"] === "production" &&
      Buffer.byteLength(configured, "utf8") < 32
    ) {
      throw new Error(
        "TEAM_AUTH_RATE_LIMIT_SECRET or ADMIN_API_KEY must contain at least 32 bytes",
      );
    }
    return configured;
  }
  if (process.env["NODE_ENV"] === "production") {
    throw new Error(
      "TEAM_AUTH_RATE_LIMIT_SECRET or ADMIN_API_KEY must be configured",
    );
  }
  return DEVELOPMENT_HMAC_SECRET;
}

function equalSecrets(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function isTeamAuthRateLimitBypassed(request: NextRequest): boolean {
  if (process.env["NODE_ENV"] !== "test" && !process.env["E2E_RUN_ID"]) {
    return false;
  }
  const configured = process.env["TEAM_AUTH_RATE_LIMIT_BYPASS_TOKEN"]?.trim();
  const provided = request.headers.get(RATE_LIMIT_BYPASS_HEADER)?.trim();
  return Boolean(configured && provided && equalSecrets(configured, provided));
}

function resolveClientIp(request: NextRequest): string {
  const forwarded = request.headers
    .get("x-forwarded-for")
    ?.split(",")[0]
    ?.trim();
  const value =
    request.headers.get("cf-connecting-ip")?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    forwarded ||
    "unknown";
  return value.toLowerCase().slice(0, 128);
}

export function hashTeamAuthRateLimitKey(
  scope: string,
  normalizedValue: string,
): string {
  return crypto
    .createHmac("sha256", readSecret())
    .update(scope)
    .update("\0")
    .update(normalizedValue)
    .digest("base64url");
}

export function buildTeamAuthRateLimitConflictUpdate(input: {
  now: Date;
  windowStartedAt: Date;
  resetAt: Date;
}) {
  // Values passed through a schema field are encoded by Drizzle, but values
  // interpolated directly into an SQL fragment use the no-op encoder. Bind
  // every date in the conflict expression to its timestamp column so the
  // postgres-js driver always receives the same ISO timestamp representation
  // on both the insert and update paths.
  const comparisonNow = sql.param(input.now, teamAuthRateLimits.resetAt);
  const nextWindowStartedAt = sql.param(
    input.windowStartedAt,
    teamAuthRateLimits.windowStartedAt,
  );
  const nextResetAt = sql.param(input.resetAt, teamAuthRateLimits.resetAt);

  return {
    count: sql<number>`CASE
      WHEN ${teamAuthRateLimits.resetAt} <= ${comparisonNow} THEN 1
      ELSE ${teamAuthRateLimits.count} + 1
    END`,
    windowStartedAt: sql<Date>`CASE
      WHEN ${teamAuthRateLimits.resetAt} <= ${comparisonNow} THEN ${nextWindowStartedAt}
      ELSE ${teamAuthRateLimits.windowStartedAt}
    END`,
    resetAt: sql<Date>`CASE
      WHEN ${teamAuthRateLimits.resetAt} <= ${comparisonNow} THEN ${nextResetAt}
      ELSE ${teamAuthRateLimits.resetAt}
    END`,
    updatedAt: input.now,
  };
}

async function consumeBucket(input: {
  bucket: string;
  normalizedValue: string;
  rule: RateLimitRule;
  now: Date;
}): Promise<{ limited: boolean; retryAfterSeconds: number }> {
  const db = getDb();
  const nowMs = input.now.getTime();
  const windowStartedAt = new Date(
    Math.floor(nowMs / input.rule.windowMs) * input.rule.windowMs,
  );
  const resetAt = new Date(windowStartedAt.getTime() + input.rule.windowMs);
  const keyHash = hashTeamAuthRateLimitKey(input.bucket, input.normalizedValue);

  const [row] = await db
    .insert(teamAuthRateLimits)
    .values({
      bucket: input.bucket,
      keyHash,
      count: 1,
      windowStartedAt,
      resetAt,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: [teamAuthRateLimits.bucket, teamAuthRateLimits.keyHash],
      set: buildTeamAuthRateLimitConflictUpdate({
        now: input.now,
        windowStartedAt,
        resetAt,
      }),
    })
    .returning({
      count: teamAuthRateLimits.count,
      resetAt: teamAuthRateLimits.resetAt,
    });

  if (!row) {
    throw new Error("Team authentication rate limiter returned no row");
  }
  return {
    limited: row.count > input.rule.limit,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((row.resetAt.getTime() - nowMs) / 1_000),
    ),
  };
}

export async function consumeTeamAuthRateLimit(input: {
  action: TeamAuthRateLimitAction;
  request: NextRequest;
  identity: TeamAuthRateLimitIdentity;
  now?: Date;
}): Promise<{ limited: boolean; retryAfterSeconds: number }> {
  if (isTeamAuthRateLimitBypassed(input.request)) {
    return { limited: false, retryAfterSeconds: 0 };
  }

  const now = input.now ?? new Date();
  const policy = TEAM_AUTH_RATE_LIMIT_POLICIES[input.action];
  const ip = resolveClientIp(input.request);
  const normalizedIdentity = `${input.identity.kind}:${input.identity.value}`;
  const ipResult = await consumeBucket({
    bucket: `${input.action}:ip`,
    normalizedValue: ip,
    rule: policy.ip,
    now,
  });
  if (ipResult.limited) return ipResult;

  const identityResult = await consumeBucket({
    bucket: `${input.action}:identity`,
    normalizedValue: normalizedIdentity,
    rule: policy.identity,
    now,
  });

  return {
    limited: identityResult.limited,
    retryAfterSeconds: identityResult.limited
      ? identityResult.retryAfterSeconds
      : 0,
  };
}
