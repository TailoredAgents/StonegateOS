"use client";

import React, { useRef, useState } from "react";
import {
  CheckCircle2,
  ExternalLink,
  LoaderCircle,
  Mail,
  MessageSquare,
  Phone,
} from "lucide-react";
import {
  isManualCallMutationSuccess,
  readManualCallAttemptResponseMetadata,
} from "../lib/manual-call-result";
import type { OutboundCommunicationChannel } from "../outbound-navigation";
import { TEAM_FOCUS_RING, teamStatePanelClass } from "./team-ui";

type BrowserCallAttempt = {
  key: string;
  state: "pending" | "ambiguous" | "confirmed_not_sent";
};

type Props = {
  contactId: string;
  contactName: string;
  phone: string | null;
  taskId?: string;
  initialChannel: OutboundCommunicationChannel | null;
  channelHrefs: Partial<Record<OutboundCommunicationChannel, string>>;
  fullInboxHrefs: Partial<Record<OutboundCommunicationChannel, string>>;
  emailPanel?: React.ReactNode;
  smsPanel?: React.ReactNode;
  canCall: boolean;
  canReadMessages: boolean;
  outreachBlocked: boolean;
};

const CONTROL_BASE = `inline-flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold transition ${TEAM_FOCUS_RING}`;

function browserCallAttemptStorageKey(scope: string): string {
  return `team.call-attempt.v1:${scope}`;
}

function readBrowserCallAttempt(scope: string): BrowserCallAttempt | null {
  try {
    const raw = globalThis.sessionStorage.getItem(
      browserCallAttemptStorageKey(scope),
    );
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const row = value as Record<string, unknown>;
    return typeof row["key"] === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u.test(row["key"]) &&
      ["pending", "ambiguous", "confirmed_not_sent"].includes(
        typeof row["state"] === "string" ? row["state"] : "",
      )
      ? (row as BrowserCallAttempt)
      : null;
  } catch {
    return null;
  }
}

function writeBrowserCallAttempt(
  scope: string,
  attempt: BrowserCallAttempt | null,
): void {
  try {
    const key = browserCallAttemptStorageKey(scope);
    if (attempt)
      globalThis.sessionStorage.setItem(key, JSON.stringify(attempt));
    else globalThis.sessionStorage.removeItem(key);
  } catch {
    // The in-memory attempt remains authoritative when storage is unavailable.
  }
}

async function readJsonErrorMessage(response: Response): Promise<string> {
  const payload = (await response
    .clone()
    .json()
    .catch(() => null)) as {
    message?: string;
  } | null;
  if (payload?.message?.trim()) return payload.message.trim();
  const text = await response.text().catch(() => "");
  return text.trim() || `Request failed (HTTP ${response.status}).`;
}

export function OutboundCommunicationClient({
  contactId,
  contactName,
  phone,
  taskId,
  initialChannel,
  channelHrefs,
  fullInboxHrefs,
  emailPanel,
  smsPanel,
  canCall,
  canReadMessages,
  outreachBlocked,
}: Props) {
  const [channel, setChannel] = useState<OutboundCommunicationChannel | null>(
    initialChannel,
  );
  const [callBusy, setCallBusy] = useState(false);
  const [callNotice, setCallNotice] = useState<{
    tone: "success" | "danger" | "warning";
    message: string;
  } | null>(null);
  const callAttempts = useRef<Map<string, BrowserCallAttempt>>(new Map());

  const selectChannel = (nextChannel: OutboundCommunicationChannel) => {
    if (outreachBlocked || !channelHrefs[nextChannel]) return;
    setChannel(nextChannel);
    setCallNotice(null);
    const href = channelHrefs[nextChannel];
    if (href) window.history.replaceState(window.history.state, "", href);
  };

  const startCall = async () => {
    if (callBusy || outreachBlocked || !canCall || !phone?.trim()) return;
    const scope = `${contactId}:${taskId ?? "none"}`;
    const previous =
      callAttempts.current.get(scope) ?? readBrowserCallAttempt(scope);
    const idempotencyKey =
      previous?.state === "pending" || previous?.state === "ambiguous"
        ? previous.key
        : `team-call:${contactId}:${globalThis.crypto.randomUUID()}`;
    const pending: BrowserCallAttempt = {
      key: idempotencyKey,
      state: "pending",
    };
    callAttempts.current.set(scope, pending);
    writeBrowserCallAttempt(scope, pending);
    setCallBusy(true);
    setCallNotice(null);
    try {
      const response = await fetch("/api/team/calls/start", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({ contactId, taskId: taskId ?? null }),
      });
      if (!response.ok) {
        const metadata = readManualCallAttemptResponseMetadata(response);
        const failed: BrowserCallAttempt = {
          key: idempotencyKey,
          state:
            metadata?.state === "confirmed_not_sent" &&
            metadata.newAttempt === "explicit"
              ? "confirmed_not_sent"
              : "ambiguous",
        };
        callAttempts.current.set(scope, failed);
        writeBrowserCallAttempt(scope, failed);
        setCallNotice({
          tone: failed.state === "confirmed_not_sent" ? "warning" : "danger",
          message: await readJsonErrorMessage(response),
        });
        return;
      }
      const payload = (await response.json().catch(() => null)) as unknown;
      if (!isManualCallMutationSuccess(payload, contactId)) {
        const ambiguous: BrowserCallAttempt = {
          key: idempotencyKey,
          state: "ambiguous",
        };
        callAttempts.current.set(scope, ambiguous);
        writeBrowserCallAttempt(scope, ambiguous);
        setCallNotice({
          tone: "danger",
          message:
            "The call service returned an unreadable receipt. No success is being claimed; check call activity before retrying.",
        });
        return;
      }
      callAttempts.current.delete(scope);
      writeBrowserCallAttempt(scope, null);
      setCallNotice({
        tone: payload.data.state === "failed" ? "warning" : "success",
        message:
          payload.data.state === "succeeded"
            ? `Call with ${contactName} connected and was recorded.`
            : payload.data.state === "failed"
              ? `${contactName} did not connect. The follow-up remains open.`
              : `Calling ${contactName}. You can keep working here while it connects.`,
      });
    } catch {
      const ambiguous: BrowserCallAttempt = {
        key: idempotencyKey,
        state: "ambiguous",
      };
      callAttempts.current.set(scope, ambiguous);
      writeBrowserCallAttempt(scope, ambiguous);
      setCallNotice({
        tone: "danger",
        message:
          "The call result could not be confirmed. Check call activity before retrying; this attempt will be reused safely.",
      });
    } finally {
      setCallBusy(false);
    }
  };

  const fullInboxHref = channel ? fullInboxHrefs[channel] : undefined;
  const callDisabled =
    callBusy || outreachBlocked || !canCall || !phone?.trim();

  return (
    <div className="p-3 sm:p-4">
      <div className="grid grid-cols-3 gap-2" aria-label="Outreach controls">
        <button
          type="button"
          onClick={() => void startCall()}
          disabled={callDisabled}
          className={`${CONTROL_BASE} border-[color:var(--team-border)] bg-[color:var(--team-surface)] text-[color:var(--team-text)] shadow-sm hover:border-[color:var(--team-brand-green)] hover:bg-[color:var(--team-selection)] disabled:cursor-not-allowed disabled:opacity-55`}
          title={
            outreachBlocked
              ? "Outreach is blocked for this contact"
              : !canCall
                ? "You do not have permission to place calls"
                : !phone?.trim()
                  ? "No phone number saved"
                  : `Call ${contactName}`
          }
        >
          {callBusy ? (
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Phone className="h-4 w-4" aria-hidden="true" />
          )}
          <span>{callBusy ? "Calling…" : "Call"}</span>
        </button>
        <ChannelButton
          label="Text"
          icon={<MessageSquare className="h-4 w-4" aria-hidden="true" />}
          channel="sms"
          active={channel === "sms"}
          disabled={outreachBlocked || !channelHrefs.sms}
          onSelect={selectChannel}
        />
        <ChannelButton
          label="Email"
          icon={<Mail className="h-4 w-4" aria-hidden="true" />}
          channel="email"
          active={channel === "email"}
          disabled={outreachBlocked || !channelHrefs.email}
          onSelect={selectChannel}
        />
      </div>

      {callNotice ? (
        <div
          role="status"
          className={`mt-3 flex items-start gap-2 ${teamStatePanelClass(callNotice.tone)}`}
        >
          {callNotice.tone === "success" ? (
            <CheckCircle2
              className="mt-0.5 h-4 w-4 shrink-0"
              aria-hidden="true"
            />
          ) : null}
          <p>{callNotice.message}</p>
        </div>
      ) : null}

      {outreachBlocked ? (
        <div role="status" className={`mt-3 ${teamStatePanelClass("danger")}`}>
          <p className="font-semibold">Do Not Contact — outreach is blocked</p>
          <p className="mt-1">
            Calling and messaging are unavailable for {contactName}.
          </p>
        </div>
      ) : !channel ? (
        <div className="mt-3 rounded-xl border border-dashed border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] px-4 py-8 text-center">
          <p className="text-sm font-semibold text-[color:var(--team-text)]">
            No messaging channel available
          </p>
          <p className="mt-1 text-xs text-[color:var(--team-text-muted)]">
            Add a phone number or email address to start a conversation.
          </p>
        </div>
      ) : !canReadMessages ? (
        <p className="mt-3 text-sm text-[color:var(--team-text-muted)]">
          Inbox access is required to read or send messages.
        </p>
      ) : (
        <div className="mt-3">
          <div className="mb-2 flex min-h-8 items-center justify-between gap-3 px-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--team-text-muted)]">
              {channel === "email" ? "Email conversation" : "Text conversation"}
            </p>
            {fullInboxHref ? (
              <a
                href={fullInboxHref}
                className={`inline-flex items-center gap-1 text-xs font-semibold text-[color:var(--team-link)] hover:underline ${TEAM_FOCUS_RING}`}
              >
                Full Prospect Inbox
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            ) : null}
          </div>
          <div
            role="region"
            aria-live="polite"
            aria-label="Email conversation"
            hidden={channel !== "email"}
          >
            {emailPanel}
          </div>
          <div
            role="region"
            aria-live="polite"
            aria-label="Text conversation"
            hidden={channel !== "sms"}
          >
            {smsPanel}
          </div>
        </div>
      )}
    </div>
  );
}

function ChannelButton({
  label,
  icon,
  channel,
  active,
  disabled,
  onSelect,
}: {
  label: string;
  icon: React.ReactNode;
  channel: OutboundCommunicationChannel;
  active: boolean;
  disabled: boolean;
  onSelect: (channel: OutboundCommunicationChannel) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={() => onSelect(channel)}
      className={`${CONTROL_BASE} ${
        active
          ? "border-[color:var(--team-brand-green)] bg-[color:var(--team-action-primary)] text-[color:var(--team-action-primary-text)] shadow-[0_8px_20px_var(--team-action-shadow)]"
          : "border-[color:var(--team-border)] bg-[color:var(--team-surface)] text-[color:var(--team-text-muted)] shadow-sm hover:border-[color:var(--team-brand-green)] hover:bg-[color:var(--team-selection)] hover:text-[color:var(--team-link)]"
      } disabled:cursor-not-allowed disabled:opacity-55`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
