import { getDb } from "@/db";
import { recordAuditEvent } from "@/lib/audit";
import { evaluateSalesPlannerAutosendPolicy, getSalesAutopilotPolicy } from "@/lib/policy";

type TeamDirectoryPayload = {
  ok?: boolean;
  members?: Array<{ id?: string; name?: string | null }>;
};

type SalesQueuePayload = {
  ok?: boolean;
  items?: Array<{
    id?: string;
    contact?: { id?: string | null; name?: string | null } | null;
    draftPreparationEligible?: boolean;
    draft?: {
      ready?: boolean | null;
      messageId?: string | null;
      createdAt?: string | null;
    } | null;
    draftTarget?: { threadId?: string; channel?: string } | null;
    nextAction?: {
      actionType?: string | null;
      dueAt?: string | null;
      status?: string | null;
    } | null;
  }>;
};

type SuggestPayload = {
  ok?: boolean;
  created?: boolean;
  messageId?: string;
  skipped?: string;
  reused?: boolean;
};

type RetryPayload = {
  ok?: boolean;
};

function readEnvString(key: string): string | null {
  const value = process.env[key];
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildAdminHeaders(): HeadersInit | null {
  const apiKey = readEnvString("ADMIN_API_KEY");
  if (!apiKey) return null;
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "x-actor-type": "worker",
    "x-actor-label": "sales-draft-prep",
    "x-actor-role": "owner",
  };
}

function buildApiUrl(path: string): string | null {
  const base = readEnvString("API_BASE_URL") ?? readEnvString("NEXT_PUBLIC_API_BASE_URL");
  if (!base) return null;
  return `${base.replace(/\/$/, "")}${path}`;
}

function parseIsoDate(value: string | null | undefined): Date | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isPlannerActionDue(value: { dueAt?: string | null; status?: string | null } | null | undefined, now: Date): boolean {
  if (!value) return false;
  if (value.status === "dismissed" || value.status === "blocked") return false;
  const dueAt = parseIsoDate(value.dueAt ?? null);
  if (!dueAt) return true;
  return dueAt.getTime() <= now.getTime();
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; status?: number; error: string }> {
  const url = buildApiUrl(path);
  const headers = buildAdminHeaders();
  if (!url || !headers) {
    return { ok: false, error: "api_not_configured" };
  }

  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        ...headers,
        ...(init?.headers ?? {}),
      },
    });
    const data = (await response.json().catch(() => null)) as T | null;
    if (!response.ok || !data) {
      return { ok: false, status: response.status, error: "request_failed" };
    }
    return { ok: true, data };
  } catch {
    return { ok: false, error: "request_failed" };
  }
}

function mapAutosendPolicyReason(
  reason: ReturnType<typeof evaluateSalesPlannerAutosendPolicy>["reason"],
): string {
  switch (reason) {
    case "planner_autosend_disabled":
      return "autosend_disabled";
    case "channel_off":
      return "channel_off";
    case "channel_not_allowed":
      return "channel_not_allowed";
    case "action_requires_full_mode":
      return "action_requires_full_mode";
    case "action_not_allowed":
      return "action_not_allowed";
    default:
      return "autosend_not_allowed";
  }
}

export async function prepareDueSalesQueueDrafts(input?: {
  maxMembers?: number;
  maxDraftsPerMember?: number;
}): Promise<{
  prepared: number;
  reused: number;
  autosent: number;
  skipped: number;
  membersScanned: number;
  error?: string | null;
}> {
  const maxMembers = Number.isFinite(input?.maxMembers) ? Math.max(1, Math.floor(input!.maxMembers!)) : 5;
  const maxDraftsPerMember = Number.isFinite(input?.maxDraftsPerMember)
    ? Math.max(1, Math.floor(input!.maxDraftsPerMember!))
    : 3;
  const autopilotPolicy = await getSalesAutopilotPolicy(getDb());
  const autoSendOverride = readEnvString("SALES_AGENT_AUTOSEND_ENABLED");
  const overrideAutoSendEnabled = autoSendOverride === "1" ? true : autoSendOverride === "0" ? false : null;
  const autoSendMinDraftAgeMs = Math.max(
    60_000,
    Number.parseInt(readEnvString("SALES_AGENT_AUTOSEND_MIN_DRAFT_AGE_MS") ?? "", 10) ||
      autopilotPolicy.plannerAutoSendMinDraftAgeMinutes * 60_000,
  );

  const directoryResult = await fetchJson<TeamDirectoryPayload>("/api/admin/team/directory");
  if (!directoryResult.ok) {
    return { prepared: 0, reused: 0, autosent: 0, skipped: 0, membersScanned: 0, error: directoryResult.error };
  }

  const members = Array.isArray(directoryResult.data.members)
    ? directoryResult.data.members
        .map((member) => (typeof member?.id === "string" && member.id.trim().length > 0 ? member.id.trim() : null))
        .filter((value): value is string => Boolean(value))
        .slice(0, maxMembers)
    : [];

  let prepared = 0;
  let reused = 0;
  let autosent = 0;
  let skipped = 0;
  const now = new Date();

  for (const memberId of members) {
    const queueResult = await fetchJson<SalesQueuePayload>(
      `/api/admin/sales/queue?memberId=${encodeURIComponent(memberId)}`,
    );
    if (!queueResult.ok) continue;

    const candidates = (Array.isArray(queueResult.data.items) ? queueResult.data.items : [])
      .filter((item) => {
        const threadId = typeof item?.draftTarget?.threadId === "string" ? item.draftTarget.threadId.trim() : "";
        const channel = typeof item?.draftTarget?.channel === "string" ? item.draftTarget.channel.trim() : "";
        if (!threadId || !channel) return false;

        const draftCreatedAt = parseIsoDate(item?.draft?.createdAt ?? null);
        const draftIsOldEnough =
          draftCreatedAt instanceof Date &&
          now.getTime() - draftCreatedAt.getTime() >= autoSendMinDraftAgeMs;
        const autosendPolicy = evaluateSalesPlannerAutosendPolicy(autopilotPolicy, {
          channel,
          actionType: item?.nextAction?.actionType ?? null,
        });
        const autoSendEligible =
          (overrideAutoSendEnabled ?? autosendPolicy.allowed) &&
          item?.draft?.ready === true &&
          draftIsOldEnough &&
          isPlannerActionDue(item?.nextAction ?? null, now);

        const prepEligible =
          item?.draftPreparationEligible === true &&
          item.draft?.ready !== true;

        return prepEligible || autoSendEligible;
      })
      .slice(0, maxDraftsPerMember);

    for (const candidate of candidates) {
      const contactId =
        typeof candidate.contact?.id === "string" && candidate.contact.id.trim().length > 0
          ? candidate.contact.id.trim()
          : null;
      const actionType =
        typeof candidate.nextAction?.actionType === "string" && candidate.nextAction.actionType.trim().length > 0
          ? candidate.nextAction.actionType.trim()
          : null;
      const draftTarget = candidate.draftTarget;
      const threadId = typeof draftTarget?.threadId === "string" ? draftTarget.threadId.trim() : "";
      const channel = typeof draftTarget?.channel === "string" ? draftTarget.channel.trim() : "";
      if (!threadId || !channel) {
        skipped += 1;
        await recordAuditEvent({
          actor: { type: "worker", label: "sales-draft-prep" },
          action: "sales.agent.autosend.skipped",
          entityType: "conversation_thread",
          entityId: threadId || candidate.id || "unknown",
          meta: { contactId, channel: channel || null, actionType, reason: "missing_draft_target" },
        });
        continue;
      }
      const suggestResult = await fetchJson<SuggestPayload>(
        `/api/admin/inbox/threads/${encodeURIComponent(threadId)}/suggest`,
        {
          method: "POST",
          body: JSON.stringify({ auto: true, channel }),
        },
      );
      if (!suggestResult.ok) {
        skipped += 1;
        await recordAuditEvent({
          actor: { type: "worker", label: "sales-draft-prep" },
          action: "sales.agent.draft.skipped",
          entityType: "conversation_thread",
          entityId: threadId,
          meta: { contactId, channel, actionType, reason: suggestResult.error },
        });
        continue;
      }
      if (suggestResult.data.created === true) {
        prepared += 1;
        await recordAuditEvent({
          actor: { type: "worker", label: "sales-draft-prep" },
          action: "sales.agent.draft.prepared",
          entityType: "conversation_thread",
          entityId: threadId,
          meta: {
            contactId,
            channel,
            actionType,
            messageId: suggestResult.data.messageId ?? null,
            queueItemId: candidate.id ?? null,
          },
        });
        continue;
      }
      if (suggestResult.data.reused === true) {
        reused += 1;
        await recordAuditEvent({
          actor: { type: "worker", label: "sales-draft-prep" },
          action: "sales.agent.draft.reused",
          entityType: "conversation_thread",
          entityId: threadId,
          meta: {
            contactId,
            channel,
            actionType,
            messageId: suggestResult.data.messageId ?? candidate.draft?.messageId ?? null,
            queueItemId: candidate.id ?? null,
          },
        });
      } else {
        skipped += 1;
        await recordAuditEvent({
          actor: { type: "worker", label: "sales-draft-prep" },
          action: "sales.agent.draft.skipped",
          entityType: "conversation_thread",
          entityId: threadId,
          meta: { contactId, channel, actionType, reason: suggestResult.data.skipped ?? "no_draft_change" },
        });
        continue;
      }

      const messageId =
        typeof suggestResult.data.messageId === "string" && suggestResult.data.messageId.trim().length > 0
          ? suggestResult.data.messageId.trim()
          : "";
      const draftCreatedAt = parseIsoDate(candidate.draft?.createdAt ?? null);
      const draftIsOldEnough =
        draftCreatedAt instanceof Date && now.getTime() - draftCreatedAt.getTime() >= autoSendMinDraftAgeMs;
      const autosendPolicy = evaluateSalesPlannerAutosendPolicy(autopilotPolicy, {
        channel,
        actionType: candidate.nextAction?.actionType ?? null,
      });
      const canAutoSend =
        (overrideAutoSendEnabled ?? autosendPolicy.allowed) &&
        messageId.length > 0 &&
        draftIsOldEnough &&
        isPlannerActionDue(candidate.nextAction ?? null, now);

      if (!canAutoSend) {
        if ((overrideAutoSendEnabled ?? true) && candidate?.draft?.ready === true) {
          const reason = !autosendPolicy.allowed && overrideAutoSendEnabled !== true
            ? mapAutosendPolicyReason(autosendPolicy.reason)
                : !draftIsOldEnough
                ? "draft_too_fresh"
                : !isPlannerActionDue(candidate.nextAction ?? null, now)
                  ? "not_due"
                  : "autosend_not_allowed";
          await recordAuditEvent({
            actor: { type: "worker", label: "sales-draft-prep" },
            action: "sales.agent.autosend.skipped",
            entityType: "conversation_thread",
            entityId: threadId,
            meta: { contactId, channel, actionType, messageId: messageId || null, reason },
          });
        }
        continue;
      }

      const retryResult = await fetchJson<RetryPayload>(
        `/api/admin/inbox/messages/${encodeURIComponent(messageId)}/retry`,
        { method: "POST" },
      );
      if (retryResult.ok && retryResult.data.ok === true) {
        autosent += 1;
        await recordAuditEvent({
          actor: { type: "worker", label: "sales-draft-prep" },
          action: "sales.agent.autosend.queued",
          entityType: "conversation_message",
          entityId: messageId,
          meta: { contactId, threadId, channel, actionType },
        });
      } else {
        skipped += 1;
        const retryError = retryResult.ok ? "retry_not_acknowledged" : retryResult.error;
        await recordAuditEvent({
          actor: { type: "worker", label: "sales-draft-prep" },
          action: "sales.agent.autosend.skipped",
          entityType: "conversation_message",
          entityId: messageId || threadId,
          meta: { contactId, threadId, channel, actionType, reason: retryError },
        });
      }
    }
  }

  return {
    prepared,
    reused,
    autosent,
    skipped,
    membersScanned: members.length,
    error: null,
  };
}
