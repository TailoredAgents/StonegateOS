"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, LoaderCircle, ShieldCheck } from "lucide-react";
import type {
  PartnerQuoteLineItem,
  PartnerQuoteOptionGroup,
} from "../lib/portal-v2";
import { createPortalOperationKey, partnerPortalFetch } from "../lib/portal-v2";
import {
  PartnerNotice,
  PartnerPanel,
  partnerFieldClass,
  partnerPrimaryButtonClass,
  partnerSecondaryButtonClass,
} from "./PartnerPortalUi";

type Decision = "accepted" | "declined";
type Message = Readonly<{
  tone: "success" | "warning" | "error";
  text: string;
}>;

function quoteDecisionError(code: string, status: number): Message {
  if (code === "approval_required") {
    return {
      tone: "warning",
      text: "This quote still needs account approval. Complete the required approval before accepting it.",
    };
  }
  if (
    code === "revision_mismatch" ||
    code === "quote_not_actionable" ||
    code === "quote_change_pending" ||
    code === "quote_conflict" ||
    status === 409 ||
    status === 412
  ) {
    return {
      tone: "warning",
      text: "This quote changed or is no longer open for that response. Refresh and review the current version before trying again.",
    };
  }
  if (code === "invalid_acceptance_evidence") {
    return {
      tone: "error",
      text: "Your selections do not meet this quote’s requirements. Review each option group and try again.",
    };
  }
  if (code === "rate_limited") {
    return {
      tone: "warning",
      text: "Too many response attempts were made. Wait a moment, then try again.",
    };
  }
  return {
    tone: "error",
    text: "We couldn’t record this response. No quote decision was changed.",
  };
}

function optionLines(
  groupId: string,
  lineItems: readonly PartnerQuoteLineItem[],
): PartnerQuoteLineItem[] {
  return lineItems.filter((line) => line.optionGroupId === groupId);
}

function defaultSelections(
  groups: readonly PartnerQuoteOptionGroup[],
  lines: readonly PartnerQuoteLineItem[],
): string[] {
  const selected = new Set<string>();
  for (const group of groups) {
    const candidates = optionLines(group.id, lines);
    const defaults = candidates.filter((line) => line.selectedByDefault);
    for (const line of defaults.slice(0, group.maximumSelections)) {
      selected.add(line.id);
    }
  }
  return [...selected];
}

function validateSelections(
  groups: readonly PartnerQuoteOptionGroup[],
  lines: readonly PartnerQuoteLineItem[],
  selectedIds: ReadonlySet<string>,
): string | null {
  for (const group of groups) {
    const candidates = new Set(
      optionLines(group.id, lines).map((line) => line.id),
    );
    const count = [...selectedIds].filter((id) => candidates.has(id)).length;
    if (count < group.minimumSelections || count > group.maximumSelections) {
      return `${group.label} requires ${group.minimumSelections === group.maximumSelections ? String(group.minimumSelections) : `${group.minimumSelections}–${group.maximumSelections}`} selection${group.maximumSelections === 1 ? "" : "s"}.`;
    }
  }
  return null;
}

export function PartnerQuoteDecisionForm({
  quoteId,
  initialEtag,
  allowedActions,
  signerName,
  signerCompany,
  consentVersion,
  optionGroups,
  lineItems,
}: {
  quoteId: string;
  initialEtag: string | null;
  allowedActions: readonly string[];
  signerName: string;
  signerCompany: string;
  consentVersion: string;
  optionGroups: readonly PartnerQuoteOptionGroup[];
  lineItems: readonly PartnerQuoteLineItem[];
}) {
  const router = useRouter();
  const canAccept = allowedActions.includes("accept");
  const canDecline = allowedActions.includes("decline");
  const [decision, setDecision] = React.useState<Decision>(
    canAccept ? "accepted" : "declined",
  );
  const [name, setName] = React.useState(signerName);
  const [title, setTitle] = React.useState("");
  const [company, setCompany] = React.useState(signerCompany);
  const [authorityAffirmed, setAuthorityAffirmed] = React.useState(false);
  const [consentAffirmed, setConsentAffirmed] = React.useState(false);
  const [category, setCategory] = React.useState<
    "price" | "scope" | "timing" | "competitor" | "other"
  >("other");
  const [notes, setNotes] = React.useState("");
  const [selectedIds, setSelectedIds] = React.useState<string[]>(() =>
    defaultSelections(optionGroups, lineItems),
  );
  const [etag, setEtag] = React.useState(initialEtag);
  const [busy, setBusy] = React.useState(false);
  const [resolved, setResolved] = React.useState<Decision | null>(null);
  const [message, setMessage] = React.useState<Message | null>(null);
  const feedbackRef = React.useRef<HTMLDivElement>(null);
  const operationRef = React.useRef<{
    fingerprint: string;
    key: string;
  } | null>(null);

  const canSubmit =
    Boolean(etag) &&
    !resolved &&
    ((decision === "accepted" && canAccept) ||
      (decision === "declined" && canDecline));

  function updateGroup(
    group: PartnerQuoteOptionGroup,
    lineId: string,
    checked: boolean,
  ) {
    const groupLineIds = new Set(
      optionLines(group.id, lineItems).map((line) => line.id),
    );
    setSelectedIds((current) => {
      if (group.mode === "single") {
        return [
          ...current.filter((id) => !groupLineIds.has(id)),
          ...(checked ? [lineId] : []),
        ];
      }
      return checked
        ? [...new Set([...current, lineId])]
        : current.filter((id) => id !== lineId);
    });
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!etag || !canSubmit) return;
    const trimmedName = name.trim();
    const trimmedTitle = title.trim();
    if (trimmedName.length < 2) {
      setMessage({
        tone: "error",
        text: "Enter the responding person’s name.",
      });
      requestAnimationFrame(() => feedbackRef.current?.focus());
      return;
    }
    if (decision === "accepted") {
      const selectionError = validateSelections(
        optionGroups,
        lineItems,
        new Set(selectedIds),
      );
      if (selectionError) {
        setMessage({ tone: "error", text: selectionError });
        requestAnimationFrame(() => feedbackRef.current?.focus());
        return;
      }
      if (trimmedTitle.length < 2 || !authorityAffirmed || !consentAffirmed) {
        setMessage({
          tone: "error",
          text: "Enter your title and confirm both signing authority and the proposal consent before accepting.",
        });
        requestAnimationFrame(() => feedbackRef.current?.focus());
        return;
      }
    }
    const payload =
      decision === "accepted"
        ? {
            decision,
            signer: {
              name: trimmedName,
              title: trimmedTitle,
              ...(company.trim() ? { company: company.trim() } : {}),
            },
            authorityAffirmed: true as const,
            consentAffirmed: true as const,
            selectedOptionIds: [...selectedIds].sort(),
            consentVersion,
          }
        : {
            decision,
            signer: {
              name: trimmedName,
              ...(trimmedTitle ? { title: trimmedTitle } : {}),
              ...(company.trim() ? { company: company.trim() } : {}),
            },
            category,
            ...(notes.trim() ? { notes: notes.trim() } : {}),
          };
    const fingerprint = JSON.stringify({ payload, etag });
    if (operationRef.current?.fingerprint !== fingerprint) {
      operationRef.current = {
        fingerprint,
        key: createPortalOperationKey("quote-decision"),
      };
    }
    setBusy(true);
    setMessage(null);
    const result = await partnerPortalFetch<{
      ok: true;
      data: {
        quoteId: string;
        responseId: string;
        decision: Decision;
        respondedAt: string;
        replayed: boolean;
        certificateState?: "ready" | "pending";
      };
    }>(`quotes/${encodeURIComponent(quoteId)}/decision`, {
      method: "POST",
      headers: {
        "If-Match": etag,
        "Idempotency-Key": operationRef.current.key,
      },
      body: JSON.stringify(payload),
    }).catch(() => null);
    setBusy(false);
    if (!result?.ok) {
      const code = result?.error.error ?? "service_unavailable";
      const status = result?.response.status ?? 503;
      setMessage(quoteDecisionError(code, status));
      if ([409, 412].includes(status)) router.refresh();
      requestAnimationFrame(() => feedbackRef.current?.focus());
      return;
    }
    const committed = result.data.data.decision;
    setResolved(committed);
    setEtag(result.response.headers.get("etag") ?? etag);
    operationRef.current = null;
    setMessage({
      tone: "success",
      text:
        committed === "accepted"
          ? result.data.data.certificateState === "ready"
            ? "Quote accepted. Your response and acceptance certificate are ready."
            : "Quote accepted. Your response is saved; the acceptance certificate is still being prepared."
          : "Quote declined. Your response has been saved.",
    });
    requestAnimationFrame(() => feedbackRef.current?.focus());
    router.refresh();
  }

  if (!canAccept && !canDecline) return null;

  return (
    <PartnerPanel>
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary-700">
          Keep service moving
        </p>
        <h2 className="mt-1 text-lg font-semibold text-slate-950">
          Review and respond to this quote
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
          Accept or decline this version here. Your name, selections, and
          decision are saved with this exact quote and cannot be changed
          afterward.
        </p>
      </div>

      {message ? (
        <div
          ref={feedbackRef}
          tabIndex={-1}
          className="mt-5 focus:outline-none"
        >
          <PartnerNotice tone={message.tone}>{message.text}</PartnerNotice>
        </div>
      ) : null}
      <form
        onSubmit={(event) => void submit(event)}
        className="mt-5 space-y-5"
        aria-busy={busy}
      >
        <fieldset disabled={busy || Boolean(resolved)}>
          <legend className="text-sm font-semibold text-slate-800">
            Response
          </legend>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            {canAccept ? (
              <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-800">
                <input
                  type="radio"
                  name="quoteDecision"
                  value="accepted"
                  checked={decision === "accepted"}
                  onChange={() => setDecision("accepted")}
                />
                Accept this quote
              </label>
            ) : null}
            {canDecline ? (
              <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-800">
                <input
                  type="radio"
                  name="quoteDecision"
                  value="declined"
                  checked={decision === "declined"}
                  onChange={() => setDecision("declined")}
                />
                Decline this quote
              </label>
            ) : null}
          </div>
        </fieldset>

        {decision === "accepted" && optionGroups.length > 0 ? (
          <div className="space-y-4" aria-label="Proposal options">
            {optionGroups.map((group) => {
              const lines = optionLines(group.id, lineItems);
              return (
                <fieldset
                  key={group.id}
                  disabled={busy || Boolean(resolved)}
                  className="rounded-xl border border-slate-200 bg-slate-50/70 p-4"
                >
                  <legend className="px-1 font-semibold text-slate-950">
                    {group.label}
                  </legend>
                  <p className="mt-1 text-xs text-slate-600">
                    Choose {group.minimumSelections}
                    {group.maximumSelections !== group.minimumSelections
                      ? `–${group.maximumSelections}`
                      : ""}
                    .
                  </p>
                  <div className="mt-3 grid gap-2">
                    {lines.map((line) => (
                      <label
                        key={line.id}
                        className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-slate-200 bg-white px-3 py-3 text-sm text-slate-800"
                      >
                        <input
                          type={group.mode === "single" ? "radio" : "checkbox"}
                          name={`option-${group.id}`}
                          value={line.id}
                          checked={selectedIds.includes(line.id)}
                          onChange={(event) =>
                            updateGroup(group, line.id, event.target.checked)
                          }
                        />
                        <span>
                          <span className="font-semibold">{line.name}</span>
                          {line.description ? (
                            <span className="mt-0.5 block text-xs leading-5 text-slate-600">
                              {line.description}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              );
            })}
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <label>
            <span className="text-sm font-semibold text-slate-700">
              Name of person responding
            </span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              minLength={2}
              maxLength={160}
              autoComplete="name"
              className={partnerFieldClass}
              disabled={busy || Boolean(resolved)}
            />
          </label>
          <label>
            <span className="text-sm font-semibold text-slate-700">
              Title {decision === "declined" ? "(optional)" : ""}
            </span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required={decision === "accepted"}
              minLength={decision === "accepted" ? 2 : undefined}
              maxLength={160}
              autoComplete="organization-title"
              className={partnerFieldClass}
              disabled={busy || Boolean(resolved)}
            />
          </label>
          <label className="sm:col-span-2">
            <span className="text-sm font-semibold text-slate-700">
              Company (optional)
            </span>
            <input
              value={company}
              onChange={(event) => setCompany(event.target.value)}
              maxLength={200}
              autoComplete="organization"
              className={partnerFieldClass}
              disabled={busy || Boolean(resolved)}
            />
          </label>
        </div>

        {decision === "accepted" ? (
          <fieldset
            disabled={busy || Boolean(resolved)}
            className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/70 p-4"
          >
            <legend className="px-1 font-semibold text-slate-950">
              Required confirmations
            </legend>
            <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm leading-6 text-slate-700">
              <input
                type="checkbox"
                checked={authorityAffirmed}
                onChange={(event) => setAuthorityAffirmed(event.target.checked)}
                required
                className="mt-1"
              />
              I am authorized to accept this proposal for the account shown.
            </label>
            <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm leading-6 text-slate-700">
              <input
                type="checkbox"
                checked={consentAffirmed}
                onChange={(event) => setConsentAffirmed(event.target.checked)}
                required
                className="mt-1"
              />
              I reviewed the current scope, pricing, selected options, terms,
              payment terms, and change-order rules and agree to this version.
            </label>
          </fieldset>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <label>
              <span className="text-sm font-semibold text-slate-700">
                Primary reason
              </span>
              <select
                value={category}
                onChange={(event) =>
                  setCategory(
                    event.target.value as
                      | "price"
                      | "scope"
                      | "timing"
                      | "competitor"
                      | "other",
                  )
                }
                className={partnerFieldClass}
                disabled={busy || Boolean(resolved)}
              >
                <option value="price">Price</option>
                <option value="scope">Scope</option>
                <option value="timing">Timing</option>
                <option value="competitor">Different provider</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label>
              <span className="text-sm font-semibold text-slate-700">
                Notes (optional)
              </span>
              <textarea
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                maxLength={2_000}
                rows={4}
                className={partnerFieldClass}
                disabled={busy || Boolean(resolved)}
              />
            </label>
          </div>
        )}

        <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-4">
          <button
            type="submit"
            disabled={busy || !canSubmit}
            className={partnerPrimaryButtonClass}
          >
            {busy ? (
              <LoaderCircle
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : resolved ? (
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            ) : (
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
            )}
            {busy
              ? "Recording response…"
              : resolved
                ? "Response recorded"
                : decision === "accepted"
                  ? "Accept this quote"
                  : "Decline this quote"}
          </button>
          <button
            type="button"
            className={partnerSecondaryButtonClass}
            disabled={busy}
            onClick={() => router.refresh()}
          >
            Refresh quote
          </button>
        </div>
      </form>
    </PartnerPanel>
  );
}
