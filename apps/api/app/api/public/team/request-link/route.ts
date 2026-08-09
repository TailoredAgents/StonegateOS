import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sendEmailMessage, sendSmsMessage } from "@/lib/messaging";
import { consumeTeamAuthRateLimit } from "@/lib/team-auth-rate-limit";
import { describeTeamAuthInfrastructureError } from "@/lib/team-auth-error-observability";
import {
  createTeamLoginToken,
  findActiveTeamMemberByEmail,
  findActiveTeamMemberByPhone,
  normalizeEmail,
  normalizePhoneE164,
  resolvePublicSiteBaseUrl,
} from "@/lib/team-auth";
import {
  getTeamAuthCorrelationId,
  recordTeamAuthAuditEventSafely,
} from "@/lib/team-auth-audit";

export async function POST(request: NextRequest): Promise<Response> {
  const correlationId = getTeamAuthCorrelationId(request);
  const payload = (await request.json().catch(() => null)) as {
    email?: unknown;
    phone?: unknown;
    identifier?: unknown;
    redirectPath?: unknown;
  } | null;

  const explicitEmail = normalizeEmail(payload?.email);
  const explicitPhone = normalizePhoneE164(payload?.phone);
  const rawIdentifier = payload?.identifier;
  const identifierLooksLikeEmail =
    typeof rawIdentifier === "string" && rawIdentifier.includes("@");
  const identifierPhone = identifierLooksLikeEmail
    ? null
    : normalizePhoneE164(rawIdentifier);
  const email =
    explicitEmail ??
    (explicitPhone
      ? null
      : identifierLooksLikeEmail || !identifierPhone
        ? normalizeEmail(rawIdentifier)
        : null);
  const phoneE164 =
    explicitPhone ??
    (explicitEmail || identifierLooksLikeEmail ? null : identifierPhone);
  const redirectPath =
    payload?.redirectPath === "/mobile/auth" ||
    payload?.redirectPath === "/team/auth"
      ? payload.redirectPath
      : "/team/auth";
  const identityKind = email ? "email" : phoneE164 ? "phone" : "unknown";
  await recordTeamAuthAuditEventSafely({
    action: "team.auth.magic_link.request",
    outcome: "attempted",
    correlationId,
    surface: "/team/login",
    metadata: { identityKind, redirectTarget: redirectPath },
  });
  if (!email && !phoneE164) {
    await recordTeamAuthAuditEventSafely({
      action: "team.auth.magic_link.request",
      outcome: "denied",
      correlationId,
      surface: "/team/login",
      metadata: {
        identityKind,
        redirectTarget: redirectPath,
        reasonCode: "invalid_identifier",
      },
    });
    return NextResponse.json(
      { ok: false, error: "email_or_phone_required" },
      { status: 400 },
    );
  }

  let rateLimit: { limited: boolean; retryAfterSeconds: number };
  try {
    rateLimit = await consumeTeamAuthRateLimit({
      action: "request_link",
      request,
      identity: email
        ? { kind: "email", value: email }
        : { kind: "phone", value: phoneE164! },
    });
  } catch (error) {
    console.error(
      "[team.auth] request_link_rate_limit_unavailable",
      describeTeamAuthInfrastructureError(error),
    );
    await recordTeamAuthAuditEventSafely({
      action: "team.auth.magic_link.request",
      outcome: "failed",
      correlationId,
      surface: "/team/login",
      metadata: {
        identityKind,
        redirectTarget: redirectPath,
        reasonCode: "rate_limit_unavailable",
      },
    });
    return NextResponse.json(
      { ok: false, error: "temporarily_unavailable" },
      { status: 503, headers: { "Retry-After": "60" } },
    );
  }
  if (rateLimit.limited) {
    await recordTeamAuthAuditEventSafely({
      action: "team.auth.magic_link.request",
      outcome: "denied",
      correlationId,
      surface: "/team/login",
      metadata: {
        identityKind,
        redirectTarget: redirectPath,
        reasonCode: "rate_limited",
      },
    });
    return NextResponse.json(
      { ok: false, error: "rate_limited" },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      },
    );
  }

  let siteBaseUrl: ReturnType<typeof resolvePublicSiteBaseUrl>;
  let member: Awaited<ReturnType<typeof findActiveTeamMemberByEmail>>;
  try {
    siteBaseUrl = resolvePublicSiteBaseUrl();
    member = email
      ? await findActiveTeamMemberByEmail(email)
      : phoneE164
        ? await findActiveTeamMemberByPhone(phoneE164)
        : null;
  } catch {
    await recordTeamAuthAuditEventSafely({
      action: "team.auth.magic_link.request",
      outcome: "failed",
      correlationId,
      surface: "/team/login",
      metadata: {
        identityKind,
        redirectTarget: redirectPath,
        reasonCode: "request_processing_failed",
      },
    });
    // Preserve the public non-enumerating contract even during account lookup
    // failures. Operators receive the correlated failed audit event.
    return NextResponse.json({ ok: true });
  }
  let terminalOutcome: "succeeded" | "failed" = "succeeded";
  let terminalReason = "accepted";
  let deliveryChannels: Array<"email" | "sms"> = [];

  if (member?.id && siteBaseUrl) {
    try {
      const { rawToken, expiresAt } = await createTeamLoginToken(
        member.id,
        request,
        30,
      );
      const url = new URL(redirectPath, siteBaseUrl);
      url.searchParams.set("token", rawToken);

      const subject = "Your Stonegate Team Console login link";
      const body = [
        `Hi ${member.name},`,
        "",
        "Here's your secure login link for the Stonegate Team Console:",
        url.toString(),
        "",
        `This link expires at ${expiresAt.toISOString()}.`,
        "",
        "If you didn't request this, you can ignore this email.",
      ].join("\n");

      const smsBody = `Stonegate Team Console login link: ${url.toString()} (expires ${expiresAt.toISOString()})`;

      deliveryChannels = [
        ...(member.email ? (["email"] as const) : []),
        ...(member.phoneE164 ? (["sms"] as const) : []),
      ];

      const results = await Promise.allSettled([
        member.email
          ? sendEmailMessage(member.email, subject, body)
          : Promise.resolve({ ok: true }),
        member.phoneE164
          ? sendSmsMessage(member.phoneE164, smsBody)
          : Promise.resolve({ ok: true }),
      ]);

      const emailResult =
        results[0]?.status === "fulfilled" ? results[0].value : null;
      const smsResult =
        results[1]?.status === "fulfilled" ? results[1].value : null;

      const emailSucceeded = Boolean(
        member.email && emailResult && "ok" in emailResult && emailResult.ok,
      );
      const smsSucceeded = Boolean(
        member.phoneE164 && smsResult && "ok" in smsResult && smsResult.ok,
      );
      const delivered = emailSucceeded || smsSucceeded;

      if (emailResult && "ok" in emailResult && !emailResult.ok) {
        console.warn("[team.auth] login_link_email_failed", {
          channel: "email",
          reason: "provider_rejected",
        });
      }
      if (smsResult && "ok" in smsResult && !smsResult.ok) {
        console.warn("[team.auth] login_link_sms_failed", {
          channel: "sms",
          reason: "provider_rejected",
        });
      }
      if (deliveryChannels.length > 0 && !delivered) {
        terminalOutcome = "failed";
        terminalReason = "delivery_failed";
      } else if (
        (member.email && !emailSucceeded) ||
        (member.phoneE164 && !smsSucceeded)
      ) {
        terminalReason = "partial_delivery";
      }
    } catch {
      // Avoid leaking whether an account exists / email deliverability.
      terminalOutcome = "failed";
      terminalReason = "request_processing_failed";
    }
  } else if (member?.id && !siteBaseUrl) {
    terminalOutcome = "failed";
    terminalReason = "link_configuration_unavailable";
  }

  await recordTeamAuthAuditEventSafely({
    action: "team.auth.magic_link.request",
    outcome: terminalOutcome,
    correlationId,
    surface: "/team/login",
    metadata: {
      identityKind,
      redirectTarget: redirectPath,
      deliveryChannels,
      reasonCode: terminalReason,
    },
  });

  // Always return ok to avoid account enumeration.
  return NextResponse.json({ ok: true });
}
