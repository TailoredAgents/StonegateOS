import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sendEmailMessage } from "@/lib/messaging";
import {
  auditLogs,
  contacts,
  getDb,
  partnerInviteOperations,
  partnerUsers,
} from "@/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { consumeTeamAuthRateLimit } from "@/lib/team-auth-rate-limit";
import {
  findActivePartnerUserByEmail,
  getClientIp,
  getUserAgent,
  normalizeEmail,
  replacePartnerLoginTokenInTransaction,
  resolvePublicSiteBaseUrl,
} from "@/lib/partner-portal-auth";
import { isPartnerRoutineMagicLinkLoginEnabled } from "@/lib/partner-portal-feature-flags";
import {
  buildPartnerInviteOperationAuditRecord,
  capturePartnerInviteProviderResult,
  isPartnerInviteUnresolvedState,
  partnerInviteProviderEvidenceMetadata,
  partnerInviteProviderRequestKey,
  partnerInvitePublicRequestKeyHash,
  partnerInviteSemanticHash,
  planPartnerInviteTerminal,
  recordPartnerInviteLateProviderEvidence,
  transitionPartnerInviteOperationToDispatched,
  transitionPartnerInviteOperationToQuarantinedFailure,
  transitionPartnerInviteOperationToTerminal,
  type PartnerInviteAuditContext,
  type PartnerInviteAuditInput,
} from "@/lib/partner-invite-operations";
import type {
  PartnerInviteChannel,
  PartnerInviteDeliverySummary,
  PartnerInviteProviderEvidence,
} from "@/lib/partner-invite-delivery";
import { getTeamOperationKillSwitchForRisk } from "@/lib/team-operation-kill-switch";
import type { TeamMutationTransaction } from "@/lib/team-mutation";

const PUBLIC_LOGIN_SURFACE = "public.partners.login";
const PUBLIC_LOGIN_TTL_MINUTES = 30;

type PublicPartnerLoginUser = {
  id: string;
  orgContactId: string;
  name: string;
  email: string;
  phoneE164: string | null;
};

type PreparedPublicPartnerLoginLink = {
  user: PublicPartnerLoginUser;
  rawToken: string;
  expiresAt: Date;
  requestedAuditEventId: string;
};

async function insertPublicPartnerLoginAudit(
  tx: TeamMutationTransaction,
  context: PartnerInviteAuditContext,
  input: PartnerInviteAuditInput,
): Promise<{ auditEventId: string; committedAt: string }> {
  const record = buildPartnerInviteOperationAuditRecord(context, input);
  await tx.insert(auditLogs).values(record);
  return {
    auditEventId: record.id,
    committedAt: record.createdAt.toISOString(),
  };
}

async function preparePublicPartnerLoginLink(
  request: NextRequest,
  userId: string,
  context: PartnerInviteAuditContext,
  requestedChannels: PartnerInviteChannel[],
): Promise<PreparedPublicPartnerLoginLink | null> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({
        id: partnerUsers.id,
        orgContactId: partnerUsers.orgContactId,
        name: partnerUsers.name,
        email: partnerUsers.email,
        phoneE164: partnerUsers.phoneE164,
      })
      .from(partnerUsers)
      .innerJoin(contacts, eq(partnerUsers.orgContactId, contacts.id))
      .where(
        and(
          eq(partnerUsers.id, userId),
          eq(partnerUsers.active, true),
          eq(contacts.partnerStatus, "partner"),
          isNull(contacts.deletedAt),
        ),
      )
      .for("update")
      .limit(1);
    // This retired compatibility path persists contact-scoped invite/outbox
    // records. A canonical identity without a CRM projection is ineligible;
    // never invent or infer a contact to make the legacy path work.
    if (!user?.id || !user.orgContactId) return null;

    const [unresolved] = await tx
      .select({
        id: partnerInviteOperations.id,
        state: partnerInviteOperations.state,
      })
      .from(partnerInviteOperations)
      .where(
        and(
          eq(partnerInviteOperations.partnerUserId, user.id),
          inArray(partnerInviteOperations.state, [
            "requested",
            "dispatched",
            "reconciliation_required",
          ]),
          isNull(partnerInviteOperations.resolvedAt),
        ),
      )
      .for("update")
      .limit(1);
    if (unresolved && isPartnerInviteUnresolvedState(unresolved.state)) {
      return null;
    }

    const now = new Date();
    const token = await replacePartnerLoginTokenInTransaction(tx, {
      partnerUserId: user.id,
      requestedIp: getClientIp(request),
      userAgent: getUserAgent(request),
      ttlMinutes: PUBLIC_LOGIN_TTL_MINUTES,
      now,
    });
    const requested = await insertPublicPartnerLoginAudit(tx, context, {
      action: "partner_user.login_link.attempted",
      outcome: "attempted",
      userId: user.id,
      metadata: {
        orgContactId: user.orgContactId,
        operationKind: "public_login_link",
        initiatorType: "public_request",
        requestedChannels,
        deliveryState: "requested",
        tokenExpiresAt: token.expiresAt.toISOString(),
        providerExactlyOnceClaimed: false,
      },
      createdAt: now,
    });
    await tx.insert(partnerInviteOperations).values({
      id: context.operationId,
      orgContactId: user.orgContactId,
      partnerUserId: user.id,
      operationKind: "public_login_link",
      initiatorType: "public_request",
      semanticHash: partnerInviteSemanticHash({
        operationKind: "public_login_link",
        orgContactId: user.orgContactId,
        partnerUserId: user.id,
        email: user.email,
        phoneE164: user.phoneE164,
        requestedChannels,
      }),
      requestedChannels,
      correlationId: context.correlationId,
      idempotencyKeyHash: context.idempotencyKeyHash!,
      actorMemberId: null,
      actorRole: null,
      actorLabel: null,
      sessionId: null,
      authMethod: null,
      state: "requested",
      version: 1,
      providerRequestKey: randomUUID(),
      requestedAuditEventId: requested.auditEventId,
      requestedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    return {
      user: { ...user, orgContactId: user.orgContactId },
      rawToken: token.rawToken,
      expiresAt: token.expiresAt,
      requestedAuditEventId: requested.auditEventId,
    };
  });
}

async function markPublicPartnerLoginLinkDispatched(
  context: PartnerInviteAuditContext,
  prepared: PreparedPublicPartnerLoginLink,
  requestedChannels: PartnerInviteChannel[],
): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    const now = new Date();
    const audit = await insertPublicPartnerLoginAudit(tx, context, {
      action: "partner_user.login_link.dispatched",
      outcome: "attempted",
      userId: prepared.user.id,
      metadata: {
        orgContactId: prepared.user.orgContactId,
        operationKind: "public_login_link",
        requestedChannels,
        deliveryState: "dispatched",
        providerExactlyOnceClaimed: false,
      },
      createdAt: now,
    });
    await transitionPartnerInviteOperationToDispatched(tx, {
      operationId: context.operationId,
      dispatchAuditEventId: audit.auditEventId,
      dispatchedAt: now,
    });
  });
}

async function finalizePublicPartnerLoginLink(
  context: PartnerInviteAuditContext,
  prepared: PreparedPublicPartnerLoginLink,
  requestedChannels: PartnerInviteChannel[],
  evidence: PartnerInviteProviderEvidence[],
  summary: PartnerInviteDeliverySummary,
  reason?: string,
): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    const now = new Date();
    for (const item of evidence) {
      await insertPublicPartnerLoginAudit(tx, context, {
        action:
          item.state === "succeeded"
            ? "partner_user.login_link.channel.succeeded"
            : item.state === "failed"
              ? "partner_user.login_link.channel.failed"
              : "partner_user.login_link.channel.reconciliation_required",
        outcome: item.state === "succeeded" ? "succeeded" : "failed",
        userId: prepared.user.id,
        providerOperationId: item.providerOperationId,
        metadata: {
          orgContactId: prepared.user.orgContactId,
          operationKind: "public_login_link",
          channel: item.channel,
          state: item.state,
          provider: item.provider,
          providerOperationIds: item.providerOperationIds,
          providerIdempotencySupported: item.providerIdempotencySupported,
          providerExactlyOnceClaimed: false,
          detail: item.detail,
        },
        createdAt: now,
      });
    }

    const reconciliationRequired = summary.state === "reconciliation_required";
    const terminal = await insertPublicPartnerLoginAudit(tx, context, {
      action:
        summary.state === "succeeded"
          ? "partner_user.login_link.succeeded"
          : reconciliationRequired
            ? "partner_user.login_link.reconciliation_required"
            : "partner_user.login_link.failed",
      outcome: summary.state === "succeeded" ? "succeeded" : "failed",
      userId: prepared.user.id,
      providerOperationId: summary.providerOperationIds[0] ?? null,
      metadata: {
        orgContactId: prepared.user.orgContactId,
        operationKind: "public_login_link",
        initiatorType: "public_request",
        deliveryState: summary.state,
        requestedChannels,
        acceptedChannels: summary.acceptedChannels,
        failedChannels: summary.failedChannels,
        uncertainChannels: summary.uncertainChannels,
        providerOperationIds: summary.providerOperationIds,
        providerEvidence: partnerInviteProviderEvidenceMetadata(evidence),
        providerExactlyOnceClaimed: false,
        requestedAuditEventId: prepared.requestedAuditEventId,
        redispatchPrevented: reconciliationRequired,
        reason: reason ?? null,
      },
      createdAt: now,
    });
    await transitionPartnerInviteOperationToTerminal(tx, {
      operationId: context.operationId,
      summary,
      evidence,
      terminalAuditEventId: terminal.auditEventId,
      completedAt: now,
      failureDetail: reason,
    });
  });
}

function providerInvocationNotStartedEvidence(
  requestedChannels: PartnerInviteChannel[],
): PartnerInviteProviderEvidence[] {
  return requestedChannels.map((channel) => ({
    channel,
    state: "failed",
    provider: channel === "email" ? "smtp" : "twilio",
    providerOperationId: null,
    providerOperationIds: [],
    providerIdempotencySupported: false,
    providerExactlyOnceClaimed: false,
    detail: "provider_invocation_not_started",
  }));
}

async function quarantinePreparedPublicPartnerLoginLink(
  context: PartnerInviteAuditContext,
  prepared: PreparedPublicPartnerLoginLink,
): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    const now = new Date();
    const terminal = await insertPublicPartnerLoginAudit(tx, context, {
      action: "partner_user.login_link.quarantined",
      outcome: "failed",
      userId: prepared.user.id,
      metadata: {
        orgContactId: prepared.user.orgContactId,
        operationKind: "public_login_link",
        deliveryState: "failed",
        providerInvocationStarted: false,
        quarantineReason: "public_login_link_dispatch_not_started",
      },
      createdAt: now,
    });
    await transitionPartnerInviteOperationToQuarantinedFailure(tx, {
      operationId: context.operationId,
      terminalAuditEventId: terminal.auditEventId,
      completedAt: now,
      failureCode: "dispatch_not_started",
      failureDetail:
        "The public login-link operation stopped before any provider was called.",
      quarantineReason: "public_login_link_dispatch_not_started",
    });
  });
}

function isPartnerInviteOperationCollision(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  if (error.code !== "23505") return false;
  if (!("constraint" in error) || typeof error.constraint !== "string") {
    return false;
  }
  return [
    "partner_invite_operations_unresolved_target_key",
    "partner_invite_operations_public_request_key",
  ].includes(error.constraint);
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isPartnerRoutineMagicLinkLoginEnabled()) {
    return NextResponse.json(
      { ok: false, error: "not_found" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  let payload: unknown;
  try {
    payload = await readBoundedJsonRequest(request, { maximumBytes: 2 * 1024 });
  } catch (error) {
    const failure =
      error instanceof BoundedJsonRequestError
        ? error
        : new BoundedJsonRequestError(
            "invalid_body",
            "The request could not be read.",
            400,
          );
    return NextResponse.json(
      { ok: false, error: failure.code },
      { status: failure.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.keys(payload).some(
      (key) => !["email", "rememberMe", "returnTo"].includes(key),
    )
  ) {
    return NextResponse.json(
      { ok: false, error: "invalid_request" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const record = payload as Record<string, unknown>;

  const rememberMe = record["rememberMe"] === true;
  const rawReturnTo =
    typeof record["returnTo"] === "string" ? record["returnTo"].trim() : "";
  const returnTo =
    rawReturnTo.length <= 1_024 &&
    /^\/partners(?:\/|$|\?)/u.test(rawReturnTo) &&
    !rawReturnTo.startsWith("//") &&
    !rawReturnTo.includes("\\") &&
    !/^\/partners\/(?:auth|logout|login)(?:\/|$|\?)/u.test(rawReturnTo)
      ? rawReturnTo
      : null;
  if (
    (record["rememberMe"] !== undefined &&
      typeof record["rememberMe"] !== "boolean") ||
    (record["returnTo"] !== undefined && !returnTo)
  ) {
    return NextResponse.json(
      { ok: false, error: "invalid_request" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const email = normalizeEmail(record["email"]);
  if (
    !email ||
    email.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)
  ) {
    return NextResponse.json(
      { ok: false, error: "email_required" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  let rateLimit: { limited: boolean; retryAfterSeconds: number };
  try {
    rateLimit = await consumeTeamAuthRateLimit({
      action: "partner_request_link",
      request,
      identity: { kind: "email", value: email },
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "temporarily_unavailable" },
      {
        status: 503,
        headers: { "Cache-Control": "no-store", "Retry-After": "60" },
      },
    );
  }
  if (rateLimit.limited) {
    return NextResponse.json(
      { ok: false, error: "rate_limited" },
      {
        status: 429,
        headers: {
          "Cache-Control": "no-store",
          "Retry-After": String(rateLimit.retryAfterSeconds),
        },
      },
    );
  }

  const siteBaseUrl = resolvePublicSiteBaseUrl();
  let user: PublicPartnerLoginUser | null = null;
  try {
    const candidate = await findActivePartnerUserByEmail(email);
    user = candidate?.orgContactId
      ? { ...candidate, orgContactId: candidate.orgContactId }
      : null;
  } catch {
    // A valid public request remains non-enumerating even when the identity
    // store is temporarily unavailable.
    return NextResponse.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  if (user?.id && siteBaseUrl) {
    if (!getTeamOperationKillSwitchForRisk("external")) {
      const operationId = randomUUID();
      const correlationId = randomUUID();
      const context: PartnerInviteAuditContext = {
        actorType: "system",
        actorId: null,
        actorRole: null,
        actorLabel: null,
        sessionId: null,
        authMethod: null,
        correlationId,
        requiredPermissions: null,
        surface: PUBLIC_LOGIN_SURFACE,
        idempotencyKeyHash: partnerInvitePublicRequestKeyHash(operationId),
        operationId,
        risk: "external",
      };
      const requestedChannels: PartnerInviteChannel[] = ["email"];
      let prepared: PreparedPublicPartnerLoginLink | null = null;
      let dispatchBoundaryCrossed = false;
      let evidence: PartnerInviteProviderEvidence[] = [];
      try {
        prepared = await preparePublicPartnerLoginLink(
          request,
          user.id,
          context,
          requestedChannels,
        );
        if (prepared) {
          await markPublicPartnerLoginLinkDispatched(
            context,
            prepared,
            requestedChannels,
          );
          dispatchBoundaryCrossed = true;

          const url = new URL("/partners/auth", siteBaseUrl);
          url.searchParams.set("token", prepared.rawToken);
          if (rememberMe) url.searchParams.set("remember", "1");
          if (returnTo) url.searchParams.set("returnTo", returnTo);
          const subject = "Your Stonegate Partner Portal login link";
          const body = [
            `Hi ${prepared.user.name},`,
            "",
            "Here's your secure login link for the Stonegate Partner Portal:",
            url.toString(),
            "",
            `This link expires at ${prepared.expiresAt.toISOString()}.`,
            "",
            "If you didn't request this, you can ignore this email.",
          ].join("\n");
          evidence = await Promise.all([
            capturePartnerInviteProviderResult("email", () =>
              sendEmailMessage(prepared!.user.email, subject, body, {
                idempotencyKey: partnerInviteProviderRequestKey(
                  operationId,
                  "email",
                ),
              }),
            ),
          ]);
          const summary = planPartnerInviteTerminal(
            requestedChannels,
            evidence,
          );
          await finalizePublicPartnerLoginLink(
            context,
            prepared,
            requestedChannels,
            evidence,
            summary,
            summary.state === "succeeded" && summary.failedChannels.length > 0
              ? "partial_known_channel_failure"
              : undefined,
          );
        }
      } catch (error) {
        if (prepared && !dispatchBoundaryCrossed) {
          const knownNotSent =
            providerInvocationNotStartedEvidence(requestedChannels);
          try {
            await finalizePublicPartnerLoginLink(
              context,
              prepared,
              requestedChannels,
              knownNotSent,
              planPartnerInviteTerminal(requestedChannels, knownNotSent),
              "provider_invocation_not_started",
            );
          } catch {
            await quarantinePreparedPublicPartnerLoginLink(
              context,
              prepared,
            ).catch(() => undefined);
          }
        } else if (prepared && dispatchBoundaryCrossed) {
          const knownSummary = planPartnerInviteTerminal(
            requestedChannels,
            evidence,
          );
          const allProvidersConfirmedNoSend =
            evidence.length === requestedChannels.length &&
            evidence.every((item) => item.state === "failed");
          const summary: PartnerInviteDeliverySummary =
            allProvidersConfirmedNoSend
              ? knownSummary
              : {
                  ...knownSummary,
                  state: "reconciliation_required",
                  uncertainChannels:
                    knownSummary.uncertainChannels.length > 0
                      ? knownSummary.uncertainChannels
                      : requestedChannels,
                };
          try {
            await finalizePublicPartnerLoginLink(
              context,
              prepared,
              requestedChannels,
              evidence,
              summary,
              allProvidersConfirmedNoSend
                ? "known_provider_non_send_finalization_retry"
                : "public_login_link_finalization_interrupted",
            );
          } catch {
            await recordPartnerInviteLateProviderEvidence(getDb(), context, {
              actionRoot: "partner_user.login_link",
              userId: prepared.user.id,
              orgContactId: prepared.user.orgContactId,
              evidence,
              reason: "public_login_link_terminal_already_settled",
            });
          }
        } else if (!isPartnerInviteOperationCollision(error)) {
          console.error("[partners] public_login_link_prepare_failed", {
            operationId,
            correlationId,
            errorName: error instanceof Error ? error.name : "UnknownError",
          });
        }
      }
    }
  }

  // Always return ok to avoid account enumeration.
  return NextResponse.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store" } },
  );
}
