import type { ActionPolicy, MutationResult } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { desc, eq, inArray, sql } from "drizzle-orm";
import {
  automationSettings,
  facebookSalesAutopilotActions,
  getDb,
  policySettings,
} from "@/db";
import { getSalesAutopilotPolicy } from "@/lib/policy";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";
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

const POLICY_KEY = "sales_autopilot" as const;
const ABSENT_VERSION = "absent";
const COMPATIBILITY_CHANNELS = ["sms", "email", "dm"] as const;
const AUTOSEND_CHANNELS = new Set(["sms", "email", "dm"]);
const AUTOSEND_ACTIONS = new Set([
  "missed_call_recovery",
  "appointment_checkin",
  "post_job_checkin",
  "appointment_support",
  "dm_sms_handoff",
  "reply_now",
  "follow_up_quote",
  "collect_missing_info",
  "handle_price_objection",
]);
const FACEBOOK_CLOSER_MODES = new Set(["off", "shadow", "assist", "auto"]);
const FACEBOOK_CLOSER_SERVICES = new Set(["junk_removal"]);
const FACEBOOK_COACHING_TONES = new Set([
  "friendly",
  "professional",
  "concise",
]);
const TOP_LEVEL_KEYS = new Set([
  "enabled",
  "mode",
  "channelModes",
  "emergencyStop",
  "dailyAutomaticSendCap",
  "autoSendAfterMinutes",
  "activityWindowMinutes",
  "retryDelayMinutes",
  "dmSmsFallbackAfterMinutes",
  "dmMinSilenceBeforeSmsMinutes",
  "dmMissingInfoFollowupDelayMinutes",
  "dmQuoteFollowupDelayMinutes",
  "dmObjectionFollowupDelayMinutes",
  "agentDisplayName",
  "plannerAutoSendEnabled",
  "plannerAutoSendMinDraftAgeMinutes",
  "plannerAutoSendChannels",
  "plannerAutoSendActions",
  "liveReplyAutonomyEnabled",
  "liveReplyAutonomyChannels",
  "liveReplyAutonomyActions",
  "facebookCloser",
  "facebookCoaching",
]);

type ValidationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; fieldErrors: Record<string, string> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalSettingsVersion(value: string): boolean {
  if (value === ABSENT_VERSION) return true;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function invalidVersionResponse(message: string): Response {
  return NextResponse.json(
    {
      ok: false,
      code: "invalid",
      message,
      retryable: false,
      fieldErrors: {
        version: "Use the exact version loaded with these settings.",
      },
    } satisfies MutationResult<never>,
    { status: 422 },
  );
}

function publicPolicy(
  policy: Awaited<ReturnType<typeof getSalesAutopilotPolicy>>,
) {
  return {
    ...policy,
    mode: normalizeMessagingAutomationMode(policy.mode) ?? "off",
    channelModes: {
      sms: normalizeMessagingAutomationMode(policy.channelModes.sms) ?? "off",
      email:
        normalizeMessagingAutomationMode(policy.channelModes.email) ?? "off",
      dm: normalizeMessagingAutomationMode(policy.channelModes.dm) ?? "off",
    },
  };
}

function readStringArray(value: unknown): string[] | null {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : null;
  if (!values) return null;
  if (values.some((entry) => typeof entry !== "string")) return null;
  return [
    ...new Set(
      values
        .map((entry) => (entry as string).trim())
        .filter((entry) => entry.length > 0),
    ),
  ];
}

function validatePatch(
  payload: Record<string, unknown>,
  currentPolicy: Awaited<ReturnType<typeof getSalesAutopilotPolicy>>,
): ValidationResult {
  const next: Record<string, unknown> = {};
  const fieldErrors: Record<string, string> = {};

  for (const key of Object.keys(payload)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      fieldErrors[key] = "This setting is not supported.";
    }
  }

  const readBoolean = (key: string): void => {
    if (!(key in payload)) return;
    if (typeof payload[key] !== "boolean") {
      fieldErrors[key] = "Use true or false.";
      return;
    }
    next[key] = payload[key];
  };
  const readInt = (key: string, min: number, max: number): void => {
    if (!(key in payload)) return;
    const value = payload[key];
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < min ||
      value > max
    ) {
      fieldErrors[key] = `Use a whole number from ${min} to ${max}.`;
      return;
    }
    next[key] = value;
  };
  const readAllowedArray = (
    key: string,
    allowed: ReadonlySet<string>,
  ): void => {
    if (!(key in payload)) return;
    const values = readStringArray(payload[key]);
    if (!values || values.some((value) => !allowed.has(value))) {
      fieldErrors[key] = "One or more selected values are not supported.";
      return;
    }
    next[key] = values;
  };

  if ("mode" in payload) {
    const mode = normalizeMessagingAutomationMode(payload["mode"]);
    if (!mode) {
      fieldErrors["mode"] = "Choose Off, Assist, or Automatic.";
    } else {
      next["mode"] = toStoredSalesAutopilotMode(mode);
      next["enabled"] = mode !== "off";
    }
  }

  if ("enabled" in payload && !("mode" in payload)) {
    if (typeof payload["enabled"] !== "boolean") {
      fieldErrors["enabled"] = "Use true or false.";
    } else {
      next["enabled"] = payload["enabled"];
      if (payload["enabled"] === false) next["mode"] = "off";
    }
  }

  if ("channelModes" in payload) {
    const raw = payload["channelModes"];
    if (!isRecord(raw)) {
      fieldErrors["channelModes"] = "Choose a mode for each channel.";
    } else {
      const unexpected = Object.keys(raw).filter(
        (key) => !["sms", "email", "dm"].includes(key),
      );
      if (unexpected.length > 0) {
        fieldErrors["channelModes"] = "An unsupported channel was included.";
      }
      const channelModes: Record<string, string> = {};
      for (const channel of ["sms", "email", "dm"] as const) {
        if (!(channel in raw)) continue;
        const mode = normalizeMessagingAutomationMode(raw[channel]);
        if (!mode) {
          fieldErrors[`channelModes.${channel}`] =
            "Choose Off, Assist, or Automatic.";
        } else {
          channelModes[channel] = toStoredSalesAutopilotMode(mode);
        }
      }
      if (Object.keys(channelModes).length > 0) {
        next["channelModes"] = {
          ...currentPolicy.channelModes,
          ...channelModes,
        };
      }
    }
  }

  readBoolean("emergencyStop");
  readInt("dailyAutomaticSendCap", 1, 1000);
  readInt("autoSendAfterMinutes", 15, 120);
  readInt("activityWindowMinutes", 1, 120);
  readInt("retryDelayMinutes", 1, 60);
  readInt("dmSmsFallbackAfterMinutes", 15, 24 * 60);
  readInt("dmMinSilenceBeforeSmsMinutes", 5, 12 * 60);
  readInt("dmMissingInfoFollowupDelayMinutes", 5, 24 * 60);
  readInt("dmQuoteFollowupDelayMinutes", 15, 3 * 24 * 60);
  readInt("dmObjectionFollowupDelayMinutes", 15, 5 * 24 * 60);
  readBoolean("plannerAutoSendEnabled");
  readInt("plannerAutoSendMinDraftAgeMinutes", 1, 24 * 60);
  readBoolean("liveReplyAutonomyEnabled");
  readAllowedArray("plannerAutoSendChannels", AUTOSEND_CHANNELS);
  readAllowedArray("plannerAutoSendActions", AUTOSEND_ACTIONS);
  readAllowedArray("liveReplyAutonomyChannels", AUTOSEND_CHANNELS);
  readAllowedArray("liveReplyAutonomyActions", AUTOSEND_ACTIONS);

  if ("agentDisplayName" in payload) {
    const value = payload["agentDisplayName"];
    if (
      typeof value !== "string" ||
      value.trim().length < 1 ||
      value.trim().length > 80
    ) {
      fieldErrors["agentDisplayName"] = "Use a name from 1 to 80 characters.";
    } else {
      next["agentDisplayName"] = value.trim();
    }
  }

  if ("facebookCloser" in payload) {
    const raw = payload["facebookCloser"];
    if (!isRecord(raw)) {
      fieldErrors["facebookCloser"] = "Facebook closer settings are invalid.";
    } else {
      const allowedKeys = new Set([
        "mode",
        "allowedServices",
        "maxAutoBookTotalCents",
        "minConfidence",
        "requireCustomerConfirmation",
        "requirePhotosAboveCents",
        "allowDmSmsFallback",
        "emergencyStop",
        "messengerResponseWindowHours",
      ]);
      for (const key of Object.keys(raw)) {
        if (!allowedKeys.has(key)) {
          fieldErrors[`facebookCloser.${key}`] =
            "This setting is not supported.";
        }
      }
      const result: Record<string, unknown> = {};
      if ("mode" in raw) {
        if (
          typeof raw["mode"] !== "string" ||
          !FACEBOOK_CLOSER_MODES.has(raw["mode"].trim())
        ) {
          fieldErrors["facebookCloser.mode"] = "Choose a supported mode.";
        } else result["mode"] = raw["mode"].trim();
      }
      if ("allowedServices" in raw) {
        const values = readStringArray(raw["allowedServices"]);
        if (
          !values ||
          values.some((value) => !FACEBOOK_CLOSER_SERVICES.has(value))
        ) {
          fieldErrors["facebookCloser.allowedServices"] =
            "Choose a supported service.";
        } else result["allowedServices"] = values;
      }
      for (const [key, min, max] of [
        ["maxAutoBookTotalCents", 15_000, 500_000],
        ["requirePhotosAboveCents", 0, 500_000],
        ["messengerResponseWindowHours", 1, 24],
      ] as const) {
        if (!(key in raw)) continue;
        const value = raw[key];
        if (
          typeof value !== "number" ||
          !Number.isInteger(value) ||
          value < min ||
          value > max
        ) {
          fieldErrors[`facebookCloser.${key}`] =
            `Use a whole number from ${min} to ${max}.`;
        } else result[key] = value;
      }
      if ("minConfidence" in raw) {
        if (
          raw["minConfidence"] !== "medium" &&
          raw["minConfidence"] !== "high"
        ) {
          fieldErrors["facebookCloser.minConfidence"] =
            "Choose Medium or High.";
        } else result["minConfidence"] = raw["minConfidence"];
      }
      for (const key of [
        "requireCustomerConfirmation",
        "allowDmSmsFallback",
        "emergencyStop",
      ] as const) {
        if (!(key in raw)) continue;
        if (typeof raw[key] !== "boolean") {
          fieldErrors[`facebookCloser.${key}`] = "Use true or false.";
        } else result[key] = raw[key];
      }
      next["facebookCloser"] = {
        ...currentPolicy.facebookCloser,
        ...result,
      };
    }
  }

  if ("facebookCoaching" in payload) {
    const raw = payload["facebookCoaching"];
    if (!isRecord(raw)) {
      fieldErrors["facebookCoaching"] =
        "Facebook coaching settings are invalid.";
    } else {
      const allowedKeys = new Set([
        "enabled",
        "tone",
        "playbook",
        "requirePhotosBeforeQuote",
        "requireHumanReviewBeforeBooking",
        "humanReviewKeywords",
        "blockedAutoReplyKeywords",
      ]);
      for (const key of Object.keys(raw)) {
        if (!allowedKeys.has(key)) {
          fieldErrors[`facebookCoaching.${key}`] =
            "This setting is not supported.";
        }
      }
      const result: Record<string, unknown> = {};
      for (const key of [
        "enabled",
        "requirePhotosBeforeQuote",
        "requireHumanReviewBeforeBooking",
      ] as const) {
        if (!(key in raw)) continue;
        if (typeof raw[key] !== "boolean") {
          fieldErrors[`facebookCoaching.${key}`] = "Use true or false.";
        } else result[key] = raw[key];
      }
      if ("tone" in raw) {
        if (
          typeof raw["tone"] !== "string" ||
          !FACEBOOK_COACHING_TONES.has(raw["tone"].trim())
        ) {
          fieldErrors["facebookCoaching.tone"] = "Choose a supported tone.";
        } else result["tone"] = raw["tone"].trim();
      }
      if ("playbook" in raw) {
        if (
          typeof raw["playbook"] !== "string" ||
          raw["playbook"].trim().length > 3000
        ) {
          fieldErrors["facebookCoaching.playbook"] =
            "Keep the playbook under 3,000 characters.";
        } else result["playbook"] = raw["playbook"].trim();
      }
      for (const key of [
        "humanReviewKeywords",
        "blockedAutoReplyKeywords",
      ] as const) {
        if (!(key in raw)) continue;
        const values = readStringArray(raw[key]);
        if (
          !values ||
          values.length > 30 ||
          values.some((value) => value.length < 2 || value.length > 60)
        ) {
          fieldErrors[`facebookCoaching.${key}`] =
            "Use up to 30 keywords, each 2 to 60 characters.";
        } else result[key] = values.map((value) => value.toLowerCase());
      }
      next["facebookCoaching"] = {
        ...currentPolicy.facebookCoaching,
        ...result,
      };
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }
  if (Object.keys(next).length === 0) {
    return {
      ok: false,
      fieldErrors: { form: "No supported changes were provided." },
    };
  }
  return { ok: true, value: next };
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, [
    "automation.read",
    "policy.read",
  ]);
  if (permissionError) return permissionError;

  const db = getDb();
  const [policySnapshot, recentFacebookActions] = await Promise.all([
    db.transaction(async (tx) => {
      // A shared advisory lock gives the rendered policy and its version one
      // consistent snapshot, including while the default-backed row is absent.
      await tx.execute(
        sql`select pg_advisory_xact_lock_shared(hashtext('team_policy:sales_autopilot'))`,
      );
      const [policy, metadata] = await Promise.all([
        getSalesAutopilotPolicy(tx),
        tx
          .select({
            updatedAt: policySettings.updatedAt,
            updatedBy: policySettings.updatedBy,
          })
          .from(policySettings)
          .where(eq(policySettings.key, POLICY_KEY))
          .limit(1),
      ]);
      return { policy, metadata };
    }),
    db
      .select({
        id: facebookSalesAutopilotActions.id,
        contactId: facebookSalesAutopilotActions.contactId,
        leadId: facebookSalesAutopilotActions.leadId,
        threadId: facebookSalesAutopilotActions.threadId,
        stage: facebookSalesAutopilotActions.stage,
        proposedAction: facebookSalesAutopilotActions.proposedAction,
        executedAction: facebookSalesAutopilotActions.executedAction,
        autonomyMode: facebookSalesAutopilotActions.autonomyMode,
        decisionReason: facebookSalesAutopilotActions.decisionReason,
        humanReviewReason: facebookSalesAutopilotActions.humanReviewReason,
        error: facebookSalesAutopilotActions.error,
        createdAt: facebookSalesAutopilotActions.createdAt,
      })
      .from(facebookSalesAutopilotActions)
      .orderBy(desc(facebookSalesAutopilotActions.createdAt))
      .limit(10),
  ]);
  const { policy, metadata } = policySnapshot;

  const readiness = {
    facebookWebhookConfigured: Boolean(
      process.env["FB_VERIFY_TOKEN"] ??
        process.env["META_WEBHOOK_VERIFY_TOKEN"],
    ),
    messengerTokenConfigured: Boolean(
      process.env["FB_PAGE_ACCESS_TOKEN"] ??
        process.env["FB_MESSENGER_ACCESS_TOKEN"],
    ),
    outboxWorkerConfigured: process.env["OUTBOX_WORKER_ENABLED"] !== "0",
    openAiKeyConfigured: Boolean(process.env["OPENAI_API_KEY"]),
    bookingEndpointReachable: Boolean(
      (process.env["API_BASE_URL"] ??
        process.env["NEXT_PUBLIC_API_BASE_URL"]) &&
        process.env["ADMIN_API_KEY"],
    ),
    calendarConfigured: Boolean(
      process.env["GOOGLE_CALENDAR_ID"] ?? process.env["GOOGLE_CALENDAR_IDS"],
    ),
    serviceAreaPolicyConfigured: true,
  };

  return NextResponse.json({
    ok: true,
    policy,
    publicPolicy: publicPolicy(policy),
    facebookReadiness: readiness,
    recentFacebookActions,
    metadata: {
      version: metadata[0]?.updatedAt?.toISOString() ?? ABSENT_VERSION,
      updatedAt: metadata[0]?.updatedAt?.toISOString() ?? null,
      updatedBy: metadata[0]?.updatedBy ?? null,
      concurrencyControl: "if-match",
      idempotencyReceipts: "durable",
    },
  });
}

export async function PATCH(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["automation.write"],
    risk: "external",
    requiresIdempotency: true,
    auditAction: "sales.autopilot.policy.updated",
  } satisfies ActionPolicy);
  if (!boundary.ok) return boundary.response;
  const mutation = boundary.mutation;

  const expectedVersion = mutation.expectedVersion;
  if (
    expectedVersion === null ||
    expectedVersion === "*" ||
    !isCanonicalSettingsVersion(expectedVersion)
  ) {
    return invalidVersionResponse(
      "The loaded Sales Autopilot version is required. Refresh Messaging Automation and try again.",
    );
  }

  const payload = (await request.json().catch(() => null)) as unknown;
  if (!isRecord(payload)) {
    return NextResponse.json(
      {
        ok: false,
        code: "invalid",
        message: "The Sales Autopilot settings payload is invalid.",
        retryable: false,
      } satisfies MutationResult<never>,
      { status: 422 },
    );
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "PATCH /api/admin/sales/autopilot",
      entityType: "policy_setting",
      entityId: POLICY_KEY,
      payload,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      // The policy lock also serializes the first write while the row is
      // absent. Channel locks use the same order as the legacy compatibility
      // endpoint, preventing cross-route deadlocks.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('team_policy:sales_autopilot'))`,
      );
      for (const channel of COMPATIBILITY_CHANNELS) {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`team_automation:${channel}`}))`,
        );
      }

      const [existing] = await tx
        .select({
          value: policySettings.value,
          updatedAt: policySettings.updatedAt,
        })
        .from(policySettings)
        .where(eq(policySettings.key, POLICY_KEY))
        .for("update")
        .limit(1);
      const actualVersion = existing?.updatedAt.toISOString() ?? ABSENT_VERSION;
      if (actualVersion !== expectedVersion) {
        throw new TeamMutationFailure(
          "conflict",
          "Another teammate saved Messaging Automation after you loaded it. Your settings were not applied.",
          {
            fieldErrors: {
              version: "Refresh, review the newer settings, and retry.",
            },
          },
        );
      }

      const currentPolicy = await getSalesAutopilotPolicy(tx);
      const validation = validatePatch(payload, currentPolicy);
      if (!validation.ok) {
        throw new TeamMutationFailure(
          "invalid",
          "Review the highlighted automation settings.",
          { fieldErrors: validation.fieldErrors },
        );
      }

      const changedChannelModes = validation.value["channelModes"];
      const compatibilityRows = isRecord(changedChannelModes)
        ? await tx
            .select({
              channel: automationSettings.channel,
              updatedAt: automationSettings.updatedAt,
            })
            .from(automationSettings)
            .where(
              inArray(automationSettings.channel, [...COMPATIBILITY_CHANNELS]),
            )
            .for("update")
        : [];
      const latestStoredTime = Math.max(
        existing?.updatedAt.getTime() ?? -1,
        ...compatibilityRows.map((row) => row.updatedAt.getTime()),
      );
      const now = new Date(Math.max(Date.now(), latestStoredTime + 1));
      const merged: Record<string, unknown> = isRecord(existing?.value)
        ? { ...existing.value }
        : {};
      for (const [key, value] of Object.entries(validation.value)) {
        merged[key] = value;
      }

      const [saved] = existing
        ? await tx
            .update(policySettings)
            .set({
              value: merged,
              updatedBy: mutation.actor.id,
              updatedAt: now,
            })
            .where(eq(policySettings.key, POLICY_KEY))
            .returning({
              updatedAt: policySettings.updatedAt,
              updatedBy: policySettings.updatedBy,
            })
        : await tx
            .insert(policySettings)
            .values({
              key: POLICY_KEY,
              value: merged,
              updatedBy: mutation.actor.id,
              createdAt: now,
              updatedAt: now,
            })
            .returning({
              updatedAt: policySettings.updatedAt,
              updatedBy: policySettings.updatedBy,
            });
      if (!saved) {
        throw new TeamMutationFailure(
          "internal",
          "The Sales Autopilot change could not be confirmed.",
          { retryable: true },
        );
      }

      const synchronizedChannels: string[] = [];
      if (isRecord(changedChannelModes)) {
        for (const channel of COMPATIBILITY_CHANNELS) {
          const channelMode = normalizeMessagingAutomationMode(
            changedChannelModes[channel],
          );
          if (!channelMode) {
            throw new TeamMutationFailure(
              "internal",
              "A compatibility channel could not be synchronized.",
              { retryable: true },
            );
          }
          const [savedChannel] = await tx
            .insert(automationSettings)
            .values({
              channel,
              mode: toStoredLegacyAutomationMode(channelMode),
              updatedBy: mutation.actor.id,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: automationSettings.channel,
              set: {
                mode: toStoredLegacyAutomationMode(channelMode),
                updatedBy: mutation.actor.id,
                updatedAt: now,
              },
            })
            .returning({ channel: automationSettings.channel });
          if (!savedChannel) {
            throw new TeamMutationFailure(
              "internal",
              "A compatibility channel could not be confirmed.",
              { retryable: true },
            );
          }
          synchronizedChannels.push(savedChannel.channel);
        }
      }

      const policy = await getSalesAutopilotPolicy(tx);
      const safeBefore = publicPolicy(currentPolicy);
      const safeAfter = publicPolicy(policy);
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "policy_setting",
        entityId: POLICY_KEY,
        before: {
          version: actualVersion,
          mode: safeBefore.mode,
          channelModes: safeBefore.channelModes,
          emergencyStop: safeBefore.emergencyStop,
          dailyAutomaticSendCap: safeBefore.dailyAutomaticSendCap,
        },
        after: {
          version: saved.updatedAt.toISOString(),
          mode: safeAfter.mode,
          channelModes: safeAfter.channelModes,
          emergencyStop: safeAfter.emergencyStop,
          dailyAutomaticSendCap: safeAfter.dailyAutomaticSendCap,
        },
        metadata: {
          changedFields: Object.keys(validation.value).sort(),
          synchronizedChannels,
        },
        committedAt: now,
      });
      const version = saved.updatedAt.toISOString();
      const mutationResult = teamMutationSuccessResult(
        mutation,
        {
          policy,
          publicPolicy: safeAfter,
          metadata: {
            version,
            updatedAt: version,
            updatedBy: saved.updatedBy,
            concurrencyControl: "if-match" as const,
            idempotencyReceipts: "durable" as const,
          },
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "policy_setting",
          entityId: POLICY_KEY,
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
        console.error("[sales-autopilot] idempotency_settlement_failed", {
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
