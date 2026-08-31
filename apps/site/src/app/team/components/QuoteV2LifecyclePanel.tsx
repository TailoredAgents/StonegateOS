"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  QuoteV2ClientError,
  QuoteV2StaffClient,
  type QuoteV2StaffDecisionSource,
} from "../lib/quote-v2-client";
import { quoteV2LifecycleUiState } from "../lib/quote-v2-management-model";
import {
  TEAM_FOCUS_RING,
  TEAM_INPUT,
  TEAM_SELECT,
  teamButtonClass,
  teamStatePanelClass,
} from "./team-ui";

type LifecycleFeedback = {
  tone: "success" | "danger" | "info";
  message: string;
};

export type QuoteV2LifecycleCommit = {
  quoteRevision: number;
  aggregateState: string;
  message: string;
};

type LifecyclePanelProps = {
  detail: Record<string, unknown>;
  canUpdate: boolean;
  canSend: boolean;
  onCommitted: (commit: QuoteV2LifecycleCommit) => Promise<void>;
};

const DECISION_SOURCES: Array<{
  value: QuoteV2StaffDecisionSource;
  label: string;
}> = [
  { value: "phone", label: "Phone" },
  { value: "email", label: "Email" },
  { value: "in_person", label: "In person" },
  { value: "written_confirmation", label: "Written confirmation" },
  { value: "other", label: "Other" },
];

const DECLINE_CATEGORIES = [
  ["price", "Price"],
  ["scope", "Scope"],
  ["timing", "Timing"],
  ["competitor", "Competitor"],
  ["other", "Other"],
] as const;

function lifecycleRequestId(scope: string): string {
  const suffix =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `quote-v2:${scope}:${suffix}`;
}

function valueText(value: unknown, fallback = "—"): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function humanize(value: unknown): string {
  return valueText(value)
    .replaceAll("_", " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function formatInstant(value: unknown): string {
  if (typeof value !== "string") return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function lifecycleError(error: unknown, fallback: string): string {
  if (error instanceof QuoteV2ClientError) {
    const fields = Object.values(error.detail.fieldErrors).filter(Boolean);
    return fields.length > 0
      ? `${error.detail.message} ${fields.join(" ")}`
      : error.detail.message;
  }
  return error instanceof Error ? error.message : fallback;
}

function NotificationOptIn({
  id,
  checked,
  disabled,
  canSend,
  onChange,
}: {
  id: string;
  checked: boolean;
  disabled: boolean;
  canSend: boolean;
  onChange: (checked: boolean) => void;
}) {
  if (!canSend) {
    return (
      <p className="text-xs text-[color:var(--team-text-soft)]">
        Customer notification is off. Quote-send permission is required to opt
        in.
      </p>
    );
  }
  return (
    <label
      htmlFor={id}
      className="flex min-h-11 items-start gap-3 rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-3 text-sm"
    >
      <input
        id={id}
        type="checkbox"
        className={`mt-0.5 h-5 w-5 shrink-0 ${TEAM_FOCUS_RING}`}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <span className="font-semibold">Notify the customer</span>
        <span className="mt-0.5 block text-xs text-[color:var(--team-text-muted)]">
          This is an explicit opt-in and will queue a lifecycle notification.
        </span>
      </span>
    </label>
  );
}

export default function QuoteV2LifecyclePanel({
  detail,
  canUpdate,
  canSend,
  onCommitted,
}: LifecyclePanelProps) {
  const client = useMemo(() => new QuoteV2StaffClient(), []);
  const lifecycle = useMemo(() => quoteV2LifecycleUiState(detail), [detail]);
  const lifecycleKey = lifecycle
    ? `${lifecycle.quoteId}:${lifecycle.publishedVersionId ?? "none"}`
    : "invalid";
  const defaultSelectionKey =
    lifecycle?.optionChoices
      .filter((option) => option.selectedByDefault)
      .map((option) => encodeURIComponent(option.id))
      .join("&") ?? "";
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<LifecycleFeedback | null>(null);
  const idempotencyKeys = useRef(
    new Map<string, { signature: string; key: string }>(),
  );

  const [decision, setDecision] = useState<"accepted" | "declined">("accepted");
  const [decisionSource, setDecisionSource] =
    useState<QuoteV2StaffDecisionSource>("phone");
  const [signerName, setSignerName] = useState("");
  const [signerTitle, setSignerTitle] = useState("");
  const [signerCompany, setSignerCompany] = useState("");
  const [decisionNotes, setDecisionNotes] = useState("");
  const [declineCategory, setDeclineCategory] = useState<
    "price" | "scope" | "timing" | "competitor" | "other"
  >("other");
  const [selectedOptionIds, setSelectedOptionIds] = useState<string[]>([]);
  const [decisionConfirmed, setDecisionConfirmed] = useState(false);
  const [decisionNotify, setDecisionNotify] = useState(false);

  const [resolutionNote, setResolutionNote] = useState("");
  const [resolutionConfirmed, setResolutionConfirmed] = useState(false);
  const [resolutionNotify, setResolutionNotify] = useState(false);

  const [voidReason, setVoidReason] = useState("");
  const [voidConfirmed, setVoidConfirmed] = useState(false);
  const [voidNotify, setVoidNotify] = useState(false);
  const [archiveReason, setArchiveReason] = useState("");
  const [archiveConfirmed, setArchiveConfirmed] = useState(false);
  const [archiveNotify, setArchiveNotify] = useState(false);

  useEffect(() => {
    idempotencyKeys.current.clear();
    setSelectedOptionIds(
      defaultSelectionKey
        ? defaultSelectionKey.split("&").map((id) => decodeURIComponent(id))
        : [],
    );
    setFeedback(null);
    setDecisionConfirmed(false);
    setDecisionNotify(false);
    setResolutionNote("");
    setResolutionConfirmed(false);
    setResolutionNotify(false);
  }, [defaultSelectionKey, lifecycleKey]);

  if (!lifecycle) {
    return (
      <section className={teamStatePanelClass("danger")} role="alert">
        Lifecycle controls are unavailable because the exact quote revision or
        current version could not be verified. Refresh the quote before taking
        action.
      </section>
    );
  }

  const lifecycleState = lifecycle;
  const disabled = busyAction !== null;
  const openChange = lifecycle.openChangeRequest;
  const changeResolution = lifecycle.changeResolution;
  const notificationAvailable =
    canSend && lifecycle.canNotifyCustomer && !disabled;

  function idempotencyKeyFor(scope: string, signature: string): string {
    const existing = idempotencyKeys.current.get(scope);
    if (existing?.signature === signature) return existing.key;
    const key = lifecycleRequestId(scope);
    idempotencyKeys.current.set(scope, { signature, key });
    return key;
  }

  async function recordDecision(): Promise<void> {
    if (!canUpdate || !lifecycleState.canRecordDecision) return;
    if (!signerName.trim() || !decisionNotes.trim()) {
      setFeedback({
        tone: "danger",
        message: "Enter the signer name and the decision evidence notes.",
      });
      return;
    }
    if (decision === "accepted" && !signerTitle.trim()) {
      setFeedback({
        tone: "danger",
        message: "Enter the signer title for an accepted commercial decision.",
      });
      return;
    }
    if (decision === "accepted" && !lifecycleState.consentVersion) {
      setFeedback({
        tone: "danger",
        message:
          "This issued proposal has no verifiable consent version. Create and issue a corrected revision.",
      });
      return;
    }
    if (!decisionConfirmed) {
      setFeedback({
        tone: "danger",
        message: "Confirm the exact client decision before recording it.",
      });
      return;
    }

    setBusyAction("decision");
    setFeedback(null);
    try {
      const signature = JSON.stringify({
        quoteId: lifecycleState.quoteId,
        versionId: lifecycleState.currentVersionId,
        quoteRevision: lifecycleState.quoteRevision,
        decision,
        decisionSource,
        signerName: signerName.trim(),
        signerTitle: signerTitle.trim(),
        signerCompany: signerCompany.trim(),
        decisionNotes: decisionNotes.trim(),
        declineCategory,
        selectedOptionIds: [...new Set(selectedOptionIds)],
        notifyCustomer: notificationAvailable && decisionNotify,
      });
      const base = {
        quoteId: lifecycleState.quoteId,
        versionId: lifecycleState.currentVersionId,
        quoteRevision: lifecycleState.quoteRevision,
        source: decisionSource,
        notes: decisionNotes,
        signer: {
          name: signerName,
          ...(signerCompany.trim() ? { company: signerCompany } : {}),
        },
        notifyCustomer: notificationAvailable && decisionNotify,
        idempotencyKey: idempotencyKeyFor("staff-decision", signature),
        correlationId: lifecycleRequestId("staff-decision-correlation"),
      } as const;
      const receipt =
        decision === "accepted"
          ? await client.recordStaffDecision({
              ...base,
              decision: "accepted",
              signer: {
                ...base.signer,
                title: signerTitle,
              },
              selectedOptionIds,
              consentVersion: lifecycleState.consentVersion!,
            })
          : await client.recordStaffDecision({
              ...base,
              decision: "declined",
              signer: {
                ...base.signer,
                ...(signerTitle.trim() ? { title: signerTitle } : {}),
              },
              category: declineCategory,
            });
      const message =
        receipt.decision === "accepted"
          ? "Client approval recorded against the exact issued version."
          : "Client decline recorded against the exact issued version.";
      await onCommitted({
        quoteRevision: receipt.quoteRevision,
        aggregateState: receipt.decision,
        message,
      });
      setFeedback({ tone: "success", message });
      idempotencyKeys.current.delete("staff-decision");
      setDecisionNotes("");
      setDecisionConfirmed(false);
      setDecisionNotify(false);
    } catch (error) {
      setFeedback({
        tone: "danger",
        message: lifecycleError(
          error,
          "The client decision could not be recorded.",
        ),
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function resolveChange(): Promise<void> {
    if (!canUpdate || !changeResolution || !resolutionNote.trim()) {
      setFeedback({
        tone: "danger",
        message: "Enter a resolution note before closing the change request.",
      });
      return;
    }
    if (!resolutionConfirmed) {
      setFeedback({
        tone: "danger",
        message: "Confirm the exact resolution before closing the request.",
      });
      return;
    }
    if (
      !changeResolution.replacementVersionId &&
      !changeResolution.canReopenUnchanged
    ) {
      setFeedback({
        tone: "danger",
        message:
          "Create, finalize, and issue the requested revision before resolving this request.",
      });
      return;
    }

    setBusyAction("change-resolution");
    setFeedback(null);
    try {
      const signature = JSON.stringify({
        quoteId: lifecycleState.quoteId,
        changeRequestId: changeResolution.requestId,
        sourceVersionId: changeResolution.sourceVersionId,
        replacementVersionId: changeResolution.replacementVersionId,
        quoteRevision: lifecycleState.quoteRevision,
        resolutionNote: resolutionNote.trim(),
        notifyCustomer: notificationAvailable && resolutionNotify,
      });
      const base = {
        quoteId: lifecycleState.quoteId,
        changeRequestId: changeResolution.requestId,
        quoteVersionId: changeResolution.sourceVersionId,
        quoteRevision: lifecycleState.quoteRevision,
        resolutionNote,
        notifyCustomer: notificationAvailable && resolutionNotify,
        idempotencyKey: idempotencyKeyFor("change-resolution", signature),
        correlationId: lifecycleRequestId("change-resolution-correlation"),
      } as const;
      const receipt = changeResolution.replacementVersionId
        ? await client.resolveChangeRequest({
            ...base,
            resolution: "revision",
            replacementVersionId: changeResolution.replacementVersionId,
          })
        : await client.resolveChangeRequest({
            ...base,
            resolution: "reopen_unchanged",
          });
      const message =
        receipt.resolution === "revision"
          ? "Change request resolved with the exact issued revision."
          : "Change request resolved and the unchanged proposal reopened.";
      await onCommitted({
        quoteRevision: receipt.quoteRevision,
        aggregateState: "open",
        message,
      });
      setFeedback({ tone: "success", message });
      idempotencyKeys.current.delete("change-resolution");
      setResolutionNote("");
      setResolutionConfirmed(false);
      setResolutionNotify(false);
    } catch (error) {
      setFeedback({
        tone: "danger",
        message: lifecycleError(
          error,
          "The change request could not be resolved.",
        ),
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function runTerminalAction(action: "void" | "archive") {
    if (!canUpdate) return;
    const isVoid = action === "void";
    const reason = isVoid ? voidReason : archiveReason;
    const confirmed = isVoid ? voidConfirmed : archiveConfirmed;
    const notify = isVoid ? voidNotify : archiveNotify;
    const permitted = isVoid
      ? lifecycleState.canVoid
      : lifecycleState.canArchive;
    if (!permitted) return;
    if (!reason.trim()) {
      setFeedback({
        tone: "danger",
        message: `Enter a reason before you ${action} this quote.`,
      });
      return;
    }
    if (!confirmed) {
      setFeedback({
        tone: "danger",
        message: `Confirm the consequences before you ${action} this quote.`,
      });
      return;
    }

    setBusyAction(action);
    setFeedback(null);
    try {
      const signature = JSON.stringify({
        quoteId: lifecycleState.quoteId,
        versionId: lifecycleState.currentVersionId,
        quoteRevision: lifecycleState.quoteRevision,
        action,
        reason: reason.trim(),
        notifyCustomer: notificationAvailable && notify,
      });
      const command = {
        quoteId: lifecycleState.quoteId,
        versionId: lifecycleState.currentVersionId,
        quoteRevision: lifecycleState.quoteRevision,
        reason,
        notifyCustomer: notificationAvailable && notify,
        idempotencyKey: idempotencyKeyFor(`${action}-quote`, signature),
        correlationId: lifecycleRequestId(`${action}-quote-correlation`),
      };
      const receipt = isVoid
        ? await client.voidQuote(command)
        : await client.archiveQuote(command);
      const message = isVoid
        ? "Quote voided. Customer actions and active holds are closed."
        : "Quote archived. Its immutable proposal and response evidence remain preserved.";
      await onCommitted({
        quoteRevision: receipt.quoteRevision,
        aggregateState: receipt.state,
        message,
      });
      setFeedback({ tone: "success", message });
      idempotencyKeys.current.delete(`${action}-quote`);
      if (isVoid) {
        setVoidReason("");
        setVoidConfirmed(false);
        setVoidNotify(false);
      } else {
        setArchiveReason("");
        setArchiveConfirmed(false);
        setArchiveNotify(false);
      }
    } catch (error) {
      setFeedback({
        tone: "danger",
        message: lifecycleError(
          error,
          `The quote could not be ${isVoid ? "voided" : "archived"}.`,
        ),
      });
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <section
      className="rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-card)] p-4 sm:p-5"
      aria-labelledby="quote-v2-lifecycle-actions-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 id="quote-v2-lifecycle-actions-title" className="font-semibold">
            Lifecycle actions
          </h4>
          <p className="mt-1 text-sm text-[color:var(--team-text-muted)]">
            Version {lifecycle.publishedVersionNumber ?? "—"} · Revision{" "}
            {lifecycle.quoteRevision} · {humanize(lifecycle.aggregateState)}
          </p>
        </div>
        {!canUpdate ? (
          <span className="rounded-full border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] px-3 py-2 text-xs font-semibold text-[color:var(--team-text-muted)]">
            Read only
          </span>
        ) : null}
      </div>

      {feedback ? (
        <div
          className={`mt-4 ${teamStatePanelClass(feedback.tone)}`}
          role={feedback.tone === "danger" ? "alert" : "status"}
          aria-live="polite"
        >
          {feedback.message}
        </div>
      ) : null}

      {openChange ? (
        <div className="mt-4 rounded-2xl border border-[color:var(--team-warning-border)] bg-[color:var(--team-warning-surface)] p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[color:var(--team-warning-text)]">
            Client change request · {humanize(openChange["status"])}
          </p>
          <p className="mt-2 whitespace-pre-wrap text-sm">
            {valueText(openChange["message"], "No message supplied")}
          </p>
          <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
            <div>
              <dt className="text-[color:var(--team-text-soft)]">Category</dt>
              <dd>{humanize(openChange["reason"])}</dd>
            </div>
            <div>
              <dt className="text-[color:var(--team-text-soft)]">Due</dt>
              <dd>{formatInstant(openChange["dueAt"])}</dd>
            </div>
            <div>
              <dt className="text-[color:var(--team-text-soft)]">Owner task</dt>
              <dd>{valueText(openChange["ownerTaskId"], "Not assigned")}</dd>
            </div>
          </dl>

          {canUpdate ? (
            <div className="mt-4 space-y-3 border-t border-[color:var(--team-warning-border)] pt-4">
              <div>
                <label
                  htmlFor="quote-v2-change-resolution-note"
                  className="text-sm font-semibold"
                >
                  Resolution note
                </label>
                <textarea
                  id="quote-v2-change-resolution-note"
                  className={`mt-2 min-h-28 w-full ${TEAM_INPUT}`}
                  maxLength={2_000}
                  value={resolutionNote}
                  disabled={disabled}
                  aria-invalid={
                    feedback?.tone === "danger" && !resolutionNote.trim()
                  }
                  onChange={(event) => setResolutionNote(event.target.value)}
                  placeholder="Explain what changed or why the existing proposal remains correct."
                />
              </div>
              {changeResolution?.replacementVersionId ? (
                <p className="text-sm">
                  The current issued revision is an exact replacement for this
                  request&apos;s version and is ready to resolve it.
                </p>
              ) : changeResolution?.canReopenUnchanged ? (
                <p className="text-sm">
                  The same issued version is still valid. Reopening it will
                  resume customer response actions without changing its expiry.
                </p>
              ) : (
                <div className={teamStatePanelClass("info")}>
                  Create, finalize, and issue the requested revision first. This
                  request remains open until that exact revision is ready.
                </div>
              )}
              <label className="flex min-h-11 items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  className={`mt-0.5 h-5 w-5 shrink-0 ${TEAM_FOCUS_RING}`}
                  checked={resolutionConfirmed}
                  disabled={disabled}
                  onChange={(event) =>
                    setResolutionConfirmed(event.target.checked)
                  }
                />
                <span>
                  I confirm this resolution applies to the exact requested
                  version and resulting proposal shown above.
                </span>
              </label>
              {lifecycle.canNotifyCustomer ? (
                <NotificationOptIn
                  id="quote-v2-change-notify"
                  checked={resolutionNotify}
                  disabled={disabled}
                  canSend={canSend}
                  onChange={setResolutionNotify}
                />
              ) : null}
              <button
                type="button"
                className={teamButtonClass("primary")}
                disabled={
                  disabled ||
                  !resolutionNote.trim() ||
                  !resolutionConfirmed ||
                  (!changeResolution?.replacementVersionId &&
                    !changeResolution?.canReopenUnchanged)
                }
                onClick={() => void resolveChange()}
              >
                {busyAction === "change-resolution"
                  ? "Resolving…"
                  : changeResolution?.replacementVersionId
                    ? "Resolve with issued revision"
                    : "Reopen unchanged proposal"}
              </button>
            </div>
          ) : null}
        </div>
      ) : lifecycle.canRecordDecision && canUpdate ? (
        <form
          className="mt-4 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void recordDecision();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor="quote-v2-staff-decision"
                className="text-sm font-semibold"
              >
                Client decision
              </label>
              <select
                id="quote-v2-staff-decision"
                className={`mt-2 w-full ${TEAM_SELECT}`}
                value={decision}
                disabled={disabled}
                onChange={(event) => {
                  setDecision(event.target.value as "accepted" | "declined");
                  setDecisionConfirmed(false);
                }}
              >
                <option value="accepted">Accepted</option>
                <option value="declined">Declined</option>
              </select>
            </div>
            <div>
              <label
                htmlFor="quote-v2-decision-source"
                className="text-sm font-semibold"
              >
                Evidence source
              </label>
              <select
                id="quote-v2-decision-source"
                className={`mt-2 w-full ${TEAM_SELECT}`}
                value={decisionSource}
                disabled={disabled}
                onChange={(event) =>
                  setDecisionSource(
                    event.target.value as QuoteV2StaffDecisionSource,
                  )
                }
              >
                {DECISION_SOURCES.map((source) => (
                  <option key={source.value} value={source.value}>
                    {source.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor="quote-v2-decision-signer"
                className="text-sm font-semibold"
              >
                Signer name
              </label>
              <input
                id="quote-v2-decision-signer"
                className={`mt-2 w-full ${TEAM_INPUT}`}
                maxLength={240}
                value={signerName}
                disabled={disabled}
                required
                onChange={(event) => setSignerName(event.target.value)}
              />
            </div>
            <div>
              <label
                htmlFor="quote-v2-decision-title"
                className="text-sm font-semibold"
              >
                Signer title {decision === "accepted" ? "(required)" : ""}
              </label>
              <input
                id="quote-v2-decision-title"
                className={`mt-2 w-full ${TEAM_INPUT}`}
                maxLength={160}
                value={signerTitle}
                disabled={disabled}
                required={decision === "accepted"}
                onChange={(event) => setSignerTitle(event.target.value)}
              />
            </div>
            <div>
              <label
                htmlFor="quote-v2-decision-company"
                className="text-sm font-semibold"
              >
                Signer company (optional)
              </label>
              <input
                id="quote-v2-decision-company"
                className={`mt-2 w-full ${TEAM_INPUT}`}
                maxLength={240}
                value={signerCompany}
                disabled={disabled}
                onChange={(event) => setSignerCompany(event.target.value)}
              />
            </div>
            {decision === "declined" ? (
              <div>
                <label
                  htmlFor="quote-v2-decline-category"
                  className="text-sm font-semibold"
                >
                  Decline category
                </label>
                <select
                  id="quote-v2-decline-category"
                  className={`mt-2 w-full ${TEAM_SELECT}`}
                  value={declineCategory}
                  disabled={disabled}
                  onChange={(event) =>
                    setDeclineCategory(
                      event.target.value as typeof declineCategory,
                    )
                  }
                >
                  {DECLINE_CATEGORIES.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
          </div>

          {decision === "accepted" && lifecycle.optionChoices.length > 0 ? (
            <fieldset className="rounded-2xl border border-[color:var(--team-border)] p-4">
              <legend className="px-1 text-sm font-semibold">
                Accepted customer options
              </legend>
              <p className="text-xs text-[color:var(--team-text-muted)]">
                Select only the configuration the customer approved. Server
                rules will verify group minimums and maximums.
              </p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {lifecycle.optionChoices.map((option) => (
                  <label
                    key={option.id}
                    className="flex min-h-11 items-center gap-3 rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-3 text-sm"
                  >
                    <input
                      type="checkbox"
                      className={`h-5 w-5 ${TEAM_FOCUS_RING}`}
                      checked={selectedOptionIds.includes(option.id)}
                      disabled={disabled}
                      onChange={(event) =>
                        setSelectedOptionIds((current) =>
                          event.target.checked
                            ? [...new Set([...current, option.id])]
                            : current.filter((id) => id !== option.id),
                        )
                      }
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}

          <div>
            <label
              htmlFor="quote-v2-decision-notes"
              className="text-sm font-semibold"
            >
              Evidence notes
            </label>
            <textarea
              id="quote-v2-decision-notes"
              className={`mt-2 min-h-28 w-full ${TEAM_INPUT}`}
              maxLength={2_000}
              value={decisionNotes}
              disabled={disabled}
              required
              onChange={(event) => setDecisionNotes(event.target.value)}
              placeholder="Record when and how the client communicated this exact decision."
            />
          </div>

          <label className="flex min-h-11 items-start gap-3 text-sm">
            <input
              type="checkbox"
              className={`mt-0.5 h-5 w-5 shrink-0 ${TEAM_FOCUS_RING}`}
              checked={decisionConfirmed}
              disabled={disabled}
              onChange={(event) => setDecisionConfirmed(event.target.checked)}
            />
            <span>
              I confirm the named client provided this {decision} decision for
              the exact issued proposal and, for approval, affirmed authority
              and its stated terms.
            </span>
          </label>

          {lifecycle.canNotifyCustomer ? (
            <NotificationOptIn
              id="quote-v2-decision-notify"
              checked={decisionNotify}
              disabled={disabled}
              canSend={canSend}
              onChange={setDecisionNotify}
            />
          ) : null}

          <button
            type="submit"
            className={teamButtonClass("primary")}
            disabled={
              disabled ||
              !signerName.trim() ||
              !decisionNotes.trim() ||
              (decision === "accepted" && !signerTitle.trim()) ||
              !decisionConfirmed
            }
          >
            {busyAction === "decision"
              ? "Recording…"
              : decision === "accepted"
                ? "Record client approval"
                : "Record client decline"}
          </button>
        </form>
      ) : (
        <div className={`mt-4 ${teamStatePanelClass("info")}`}>
          {openChange
            ? "This change request is read only with your current permissions."
            : lifecycle.aggregateState === "open"
              ? "A staff decision becomes available only for the exact current, unexpired issued version with no open change request."
              : `No client decision action is available while this quote is ${humanize(lifecycle.aggregateState).toLowerCase()}.`}
        </div>
      )}

      {canUpdate && (lifecycle.canVoid || lifecycle.canArchive) ? (
        <details className="mt-4 rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] p-4">
          <summary
            className={`min-h-11 cursor-pointer content-center text-sm font-semibold ${TEAM_FOCUS_RING}`}
          >
            More lifecycle actions
          </summary>
          <div className="mt-4 space-y-5 border-t border-[color:var(--team-border)] pt-4">
            {lifecycle.canVoid ? (
              <fieldset className="space-y-3">
                <legend className="font-semibold text-[color:var(--team-danger-text)]">
                  Void quote
                </legend>
                <p className="text-sm text-[color:var(--team-text-muted)]">
                  Voiding stops customer actions, releases active holds, and
                  closes open change tasks. Issued evidence remains readable
                  according to retention policy.
                </p>
                <label
                  htmlFor="quote-v2-void-reason"
                  className="text-sm font-semibold"
                >
                  Void reason
                </label>
                <textarea
                  id="quote-v2-void-reason"
                  className={`min-h-24 w-full ${TEAM_INPUT}`}
                  maxLength={2_000}
                  value={voidReason}
                  disabled={disabled}
                  onChange={(event) => setVoidReason(event.target.value)}
                />
                <label className="flex min-h-11 items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    className={`mt-0.5 h-5 w-5 shrink-0 ${TEAM_FOCUS_RING}`}
                    checked={voidConfirmed}
                    disabled={disabled}
                    onChange={(event) => setVoidConfirmed(event.target.checked)}
                  />
                  <span>
                    I confirm this exact current quote should be voided and its
                    customer actions and active holds should stop.
                  </span>
                </label>
                {lifecycle.canNotifyCustomer ? (
                  <NotificationOptIn
                    id="quote-v2-void-notify"
                    checked={voidNotify}
                    disabled={disabled}
                    canSend={canSend}
                    onChange={setVoidNotify}
                  />
                ) : null}
                <button
                  type="button"
                  className={teamButtonClass("danger")}
                  disabled={disabled || !voidReason.trim() || !voidConfirmed}
                  onClick={() => void runTerminalAction("void")}
                >
                  {busyAction === "void" ? "Voiding…" : "Void quote"}
                </button>
              </fieldset>
            ) : null}

            {lifecycle.canArchive ? (
              <fieldset className="space-y-3 border-t border-[color:var(--team-border)] pt-5 first:border-0 first:pt-0">
                <legend className="font-semibold">Archive quote</legend>
                <p className="text-sm text-[color:var(--team-text-muted)]">
                  Archiving removes this completed record from active work while
                  preserving its immutable proposal, response, and audit
                  evidence.
                </p>
                <label
                  htmlFor="quote-v2-archive-reason"
                  className="text-sm font-semibold"
                >
                  Archive reason
                </label>
                <textarea
                  id="quote-v2-archive-reason"
                  className={`min-h-24 w-full ${TEAM_INPUT}`}
                  maxLength={2_000}
                  value={archiveReason}
                  disabled={disabled}
                  onChange={(event) => setArchiveReason(event.target.value)}
                />
                <label className="flex min-h-11 items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    className={`mt-0.5 h-5 w-5 shrink-0 ${TEAM_FOCUS_RING}`}
                    checked={archiveConfirmed}
                    disabled={disabled}
                    onChange={(event) =>
                      setArchiveConfirmed(event.target.checked)
                    }
                  />
                  <span>
                    I confirm this exact current quote should leave active work
                    while its retained evidence remains preserved.
                  </span>
                </label>
                {lifecycle.canNotifyCustomer ? (
                  <NotificationOptIn
                    id="quote-v2-archive-notify"
                    checked={archiveNotify}
                    disabled={disabled}
                    canSend={canSend}
                    onChange={setArchiveNotify}
                  />
                ) : null}
                <button
                  type="button"
                  className={teamButtonClass("secondary")}
                  disabled={
                    disabled || !archiveReason.trim() || !archiveConfirmed
                  }
                  onClick={() => void runTerminalAction("archive")}
                >
                  {busyAction === "archive" ? "Archiving…" : "Archive quote"}
                </button>
              </fieldset>
            ) : null}
          </div>
        </details>
      ) : lifecycle.aggregateState === "accepted" &&
        (detail["opportunity"] as Record<string, unknown> | null)?.[
          "status"
        ] !== "won" ? (
        <p className="mt-4 text-xs text-[color:var(--team-text-soft)]">
          Accepted quotes can be archived after fulfillment is closed as won.
        </p>
      ) : null}
    </section>
  );
}
