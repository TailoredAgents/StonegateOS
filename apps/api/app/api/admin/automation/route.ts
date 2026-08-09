import type { ActionPolicy, MutationResult } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { automationSettings, getDb, policySettings } from "@/db";
import { getSalesAutopilotPolicy } from "@/lib/policy";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../web/admin";
import {
  normalizeMessagingAutomationMode,
  toStoredLegacyAutomationMode,
  toStoredSalesAutopilotMode,
} from "@/lib/messaging-automation";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
  teamMutationIdempotencyReplayResponse,
} from "@/lib/team-mutation-idempotency";
import {
  beginTeamMutation,
  TeamMutationFailure,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";

const CHANNELS = ["sms", "email", "dm", "call", "web"] as const;
const POLICY_KEY = "sales_autopilot" as const;
const ABSENT_VERSION = "absent";
type AutomationChannel = (typeof CHANNELS)[number];

function isChannel(value: string): value is AutomationChannel {
  return (CHANNELS as readonly string[]).includes(value);
}

function isSalesAutopilotChannel(
  channel: AutomationChannel,
): channel is "sms" | "email" | "dm" {
  return channel === "sms" || channel === "email" || channel === "dm";
}

function isCanonicalSettingsVersion(value: string): boolean {
  if (value === ABSENT_VERSION) return true;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "automation.read");
  if (permissionError) return permissionError;

  const db = getDb();
  const rows = await db
    .select({
      channel: automationSettings.channel,
      mode: automationSettings.mode,
      updatedAt: automationSettings.updatedAt,
    })
    .from(automationSettings);

  const map = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    map.set(row.channel, row);
  }

  const channels = CHANNELS.map((channel) => {
    const row = map.get(channel);
    return {
      channel,
      mode: row?.mode ?? "draft",
      publicMode:
        normalizeMessagingAutomationMode(row?.mode ?? "draft") ?? "off",
      version: row?.updatedAt?.toISOString() ?? ABSENT_VERSION,
      updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
    };
  });

  return NextResponse.json({
    ok: true,
    channels,
    metadata: {
      concurrencyControl: "if-match",
      idempotencyReceipts: "durable",
    },
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["automation.write"],
    risk: "external",
    requiresIdempotency: true,
    auditAction: "automation.mode.update",
  } satisfies ActionPolicy);
  if (!boundary.ok) return boundary.response;
  const mutation = boundary.mutation;

  const expectedVersion = mutation.expectedVersion;
  if (
    expectedVersion === null ||
    expectedVersion === "*" ||
    !isCanonicalSettingsVersion(expectedVersion)
  ) {
    return NextResponse.json(
      {
        ok: false,
        code: "invalid",
        message:
          "The loaded channel version is required. Refresh Messaging Automation and try again.",
        retryable: false,
        fieldErrors: {
          version: "Use the exact version loaded with this channel.",
        },
      } satisfies MutationResult<never>,
      { status: 422 },
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    channel?: string;
    mode?: string;
  } | null;

  if (!payload || typeof payload !== "object") {
    return NextResponse.json(
      {
        ok: false,
        code: "invalid",
        message: "The channel settings payload is invalid.",
        retryable: false,
      } satisfies MutationResult<never>,
      { status: 422 },
    );
  }

  if (typeof payload.channel !== "string" || !isChannel(payload.channel)) {
    return NextResponse.json(
      {
        ok: false,
        code: "invalid",
        message: "Choose a supported automation channel.",
        retryable: false,
        fieldErrors: { channel: "Choose SMS, email, DM, call, or web." },
      } satisfies MutationResult<never>,
      { status: 422 },
    );
  }

  const publicMode = normalizeMessagingAutomationMode(payload.mode);
  if (!publicMode) {
    return NextResponse.json(
      {
        ok: false,
        code: "invalid",
        message: "Choose Off, Assist, or Automatic.",
        retryable: false,
        fieldErrors: {
          mode: "Choose Off, Assist, or Automatic.",
        },
      } satisfies MutationResult<never>,
      { status: 422 },
    );
  }

  const channel = payload.channel;
  const mode = toStoredLegacyAutomationMode(publicMode);
  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/automation",
      entityType: "automation_setting",
      entityId: channel,
      payload: { channel, publicMode },
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      const syncPolicy = isSalesAutopilotChannel(channel);
      if (syncPolicy) {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext('team_policy:sales_autopilot'))`,
        );
      }
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`team_automation:${channel}`}))`,
      );

      const [existing] = await tx
        .select({
          mode: automationSettings.mode,
          updatedAt: automationSettings.updatedAt,
        })
        .from(automationSettings)
        .where(eq(automationSettings.channel, channel))
        .for("update")
        .limit(1);
      const actualVersion = existing?.updatedAt.toISOString() ?? ABSENT_VERSION;
      if (actualVersion !== expectedVersion) {
        throw new TeamMutationFailure(
          "conflict",
          "Another teammate saved this channel after you loaded it. Your setting was not applied.",
          {
            fieldErrors: {
              version: "Refresh, review the newer channel mode, and retry.",
            },
          },
        );
      }

      const [existingPolicy] = syncPolicy
        ? await tx
            .select({
              value: policySettings.value,
              updatedAt: policySettings.updatedAt,
            })
            .from(policySettings)
            .where(eq(policySettings.key, POLICY_KEY))
            .for("update")
            .limit(1)
        : [];
      const latestStoredTime = Math.max(
        existing?.updatedAt.getTime() ?? -1,
        existingPolicy?.updatedAt.getTime() ?? -1,
      );
      const now = new Date(Math.max(Date.now(), latestStoredTime + 1));
      const [savedChannel] = await tx
        .insert(automationSettings)
        .values({
          channel,
          mode,
          updatedBy: mutation.actor.id,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: automationSettings.channel,
          set: {
            mode,
            updatedBy: mutation.actor.id,
            updatedAt: now,
          },
        })
        .returning({
          channel: automationSettings.channel,
          updatedAt: automationSettings.updatedAt,
          updatedBy: automationSettings.updatedBy,
        });
      if (!savedChannel) {
        throw new TeamMutationFailure(
          "internal",
          "The channel change could not be confirmed.",
          { retryable: true },
        );
      }

      let policyVersion: string | null = null;
      if (syncPolicy) {
        const currentPolicy = await getSalesAutopilotPolicy(tx);
        const nextChannelModes = {
          ...currentPolicy.channelModes,
          [channel]: toStoredSalesAutopilotMode(publicMode),
        };
        const nextPolicyValue = {
          ...(isRecord(existingPolicy?.value) ? existingPolicy.value : {}),
          channelModes: nextChannelModes,
        };
        const [savedPolicy] = existingPolicy
          ? await tx
              .update(policySettings)
              .set({
                value: nextPolicyValue,
                updatedBy: mutation.actor.id,
                updatedAt: now,
              })
              .where(eq(policySettings.key, POLICY_KEY))
              .returning({ updatedAt: policySettings.updatedAt })
          : await tx
              .insert(policySettings)
              .values({
                key: POLICY_KEY,
                value: nextPolicyValue,
                updatedBy: mutation.actor.id,
                createdAt: now,
                updatedAt: now,
              })
              .returning({ updatedAt: policySettings.updatedAt });
        if (!savedPolicy) {
          throw new TeamMutationFailure(
            "internal",
            "The Sales Autopilot compatibility change could not be confirmed.",
            { retryable: true },
          );
        }
        policyVersion = savedPolicy.updatedAt.toISOString();
      }

      const version = savedChannel.updatedAt.toISOString();
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "automation_setting",
        entityId: channel,
        before: {
          version: actualVersion,
          publicMode:
            normalizeMessagingAutomationMode(existing?.mode ?? "draft") ??
            "off",
        },
        after: { version, publicMode },
        metadata: {
          compatibilityPolicySynchronized: syncPolicy,
          policyVersion,
        },
        committedAt: now,
      });
      const mutationResult = teamMutationSuccessResult(
        mutation,
        {
          channel: savedChannel.channel,
          mode,
          publicMode,
          version,
          updatedAt: version,
          updatedBy: savedChannel.updatedBy,
          policyVersion,
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "automation_setting",
          entityId: channel,
          version,
        },
      );
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        mutationResult,
        200,
        now,
      );
      return mutationResult;
    });

    return teamMutationResultResponse(result, 200, mutation.correlationId);
  } catch (error) {
    if (db && claim) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch (settlementError) {
        console.error("[automation] idempotency_settlement_failed", {
          operationId: mutation.operationId,
          correlationId: mutation.correlationId,
          errorName:
            settlementError instanceof Error
              ? settlementError.name
              : "UnknownError",
        });
      }
    }
    return teamMutationExceptionResponse(error, mutation);
  }
}
