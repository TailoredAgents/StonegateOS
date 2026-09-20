"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { partnerCompanyHref } from "../partner-company-navigation";
import type { PartnerRequestInboxItem } from "@myst-os/sdk";
import {
  partnerBillingDisputeDecisionAction,
  partnerCancellationRequestDecisionAction,
  partnerJobChangeRequestDecisionAction,
  partnerLocationAddressReviewDecisionAction,
} from "../actions/partner-administration";
import { TEAM_INPUT_COMPACT, teamButtonClass } from "./team-ui";

type Decision = {
  value: string;
  label: string;
  confirmation: string;
  danger?: boolean;
};
function text(value: unknown) {
  return typeof value === "string"
    ? value
    : typeof value === "number"
      ? String(value)
      : "";
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function address(value: unknown) {
  const item = record(value);
  return (
    [
      item["line1"],
      item["line2"],
      item["city"],
      item["state"],
      item["postalCode"],
    ]
      .map(text)
      .filter(Boolean)
      .join(", ") || "Not supplied"
  );
}
export function PartnerRequestDecisionPanel({
  item,
  details,
  onReady,
  onChanged,
}: {
  item: PartnerRequestInboxItem;
  details: Record<string, unknown>;
  onReady?: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const proposed = record(details["proposedChanges"]),
    materiality = record(proposed["materiality"]);
  const impacts = [
    "price",
    "schedule",
    "service",
    "quantity",
    "hazards",
    "proof",
  ].filter((key) => materiality[key] === true);
  const quotes = Array.isArray(details["availableChangeOrderQuotes"])
    ? details["availableChangeOrderQuotes"].flatMap((value) => {
        const quote = record(value);
        return typeof quote["id"] === "string" &&
          typeof quote["number"] === "string"
          ? [
              {
                id: quote["id"],
                label: `${quote["number"]} · version ${text(quote["version"])}`,
              },
            ]
          : [];
      })
    : [];
  const decisions: Decision[] =
    item.kind === "cancellation"
      ? [
          {
            value: "approved",
            label: "Approve and cancel job",
            confirmation: "APPROVE CANCELLATION",
            danger: true,
          },
          {
            value: "declined",
            label: "Decline and keep schedule",
            confirmation: "DECLINE CANCELLATION",
          },
        ]
      : item.kind === "billing"
        ? [
            {
              value: "information_provided",
              label: "Record information provided",
              confirmation: "PROVIDE BILLING INFORMATION",
            },
            {
              value: "adjustment_required",
              label: "Require adjustment review",
              confirmation: "REQUIRE BILLING ADJUSTMENT",
            },
            {
              value: "refund_review",
              label: "Send to refund review",
              confirmation: "SEND TO REFUND REVIEW",
            },
            {
              value: "declined",
              label: "Decline billing request",
              confirmation: "DECLINE BILLING REQUEST",
              danger: true,
            },
          ]
        : item.kind === "address"
          ? [
              {
                value: "verified",
                label: "Verify location",
                confirmation: "VERIFY LOCATION",
              },
              {
                value: "correction_required",
                label: "Require correction",
                confirmation: "REQUEST ADDRESS CORRECTION",
              },
              {
                value: "dismissed",
                label: "Dismiss without change",
                confirmation: "DISMISS ADDRESS REVIEW",
                danger: true,
              },
            ]
          : [
              ...(!impacts.length
                ? [
                    {
                      value: "approved",
                      label: "Approve public-field change",
                      confirmation: "APPROVE JOB CHANGE",
                    },
                  ]
                : []),
              {
                value: "change_order_required",
                label: "Route to change order",
                confirmation: "REQUIRE CHANGE ORDER",
              },
              {
                value: "declined",
                label: "Decline without changes",
                confirmation: "DECLINE JOB CHANGE",
                danger: true,
              },
            ];
  const [choice, setChoice] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const selected = decisions.find((decision) => decision.value === choice);
  useEffect(() => {
    onReady?.();
  }, [onReady]);
  async function submit(data: FormData) {
    if (busy || !selected) return;
    const entries: Array<[string, string]> = [];
    data.forEach((value, key) =>
      entries.push([key, typeof value === "string" ? value : value.name]),
    );
    const fingerprint = JSON.stringify(entries);
    if (attempt.current?.fingerprint !== fingerprint)
      attempt.current = {
        fingerprint,
        key: `partner-inbox:${item.kind}:${crypto.randomUUID()}`,
      };
    data.set("idempotencyKey", attempt.current.key);
    setBusy(true);
    setMessage("");
    try {
      const action =
        item.kind === "cancellation"
          ? partnerCancellationRequestDecisionAction
          : item.kind === "billing"
            ? partnerBillingDisputeDecisionAction
            : item.kind === "address"
              ? partnerLocationAddressReviewDecisionAction
              : partnerJobChangeRequestDecisionAction;
      await action(data);
      await onChanged();
      setMessage(
        "Request refreshed. Review its current status above before taking another action.",
      );
    } catch {
      setMessage(
        "The decision could not be confirmed. Your entries are unchanged; retry this same decision.",
      );
    } finally {
      setBusy(false);
    }
  }
  const pending = details["state"] === "pending";
  return (
    <section className="min-w-0 space-y-4" aria-label="Request review">
      {text(details["reason"]) ? (
        <div>
          <h3 className="text-sm font-semibold">Partner’s request</h3>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">
            {text(details["reason"])}
          </p>
        </div>
      ) : null}
      {item.kind === "address" ? (
        <dl className="grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-sm font-semibold">Entered address</dt>
            <dd className="mt-1 break-words text-sm">
              {address(details["enteredAddress"])}
            </dd>
          </div>
          <div>
            <dt className="text-sm font-semibold">Suggested address</dt>
            <dd className="mt-1 break-words text-sm">
              {details["providerSuggestion"]
                ? address(details["providerSuggestion"])
                : "No correction returned"}
            </dd>
          </div>
        </dl>
      ) : null}
      {item.kind === "change" ? (
        <>
          <h3 className="text-sm font-semibold">Requested changes</h3>
          <dl className="space-y-3">
            {[
              { key: "description", label: "Work description" },
              { key: "crewInstructions", label: "Crew instructions" },
              { key: "accessDetails", label: "Arrival instructions" },
              { key: "onSiteContact", label: "Contact for the visit" },
            ]
              .filter((field) => Object.hasOwn(proposed, field.key))
              .map((field) => (
                <div key={field.key}>
                  <dt className="text-xs text-slate-600">{field.label}</dt>
                  <dd className="whitespace-pre-wrap break-words text-sm">
                    {proposed[field.key] === null
                      ? "Clear this field"
                      : field.key === "onSiteContact"
                        ? ["name", "phone", "email"]
                            .map((key) =>
                              text(record(proposed[field.key])[key]),
                            )
                            .filter(Boolean)
                            .join(" · ")
                        : text(proposed[field.key])}
                  </dd>
                </div>
              ))}
          </dl>
          {impacts.length ? (
            <p className="text-sm text-amber-900">
              Requires a change order: {impacts.join(", ")}.
            </p>
          ) : null}
        </>
      ) : null}
      <p className="text-sm leading-6 text-slate-600">
        {item.kind === "cancellation"
          ? "Approving cancels the appointment and any pending schedule change. Declining keeps the schedule. No fee is applied automatically."
          : item.kind === "billing"
            ? "Record the billing follow-up needed. This does not change an invoice, payment or refund."
            : item.kind === "address"
              ? "Verify the address using current evidence, request a correction, or dismiss this review."
              : "Approval updates only the requested description, crew instructions, arrival instructions or contact. Price and other material changes require a change order; the original job stays unchanged until that process is complete."}
      </p>
      {message ? (
        <p
          role="status"
          className="rounded-lg border border-slate-200 p-3 text-sm"
        >
          {message}
        </p>
      ) : null}
      {!pending && item.stage === "needs_attention" ? (
        <Link
          href={partnerCompanyHref(
            item.accountId,
            item.kind === "billing" ? "billing" : "jobs",
          )}
          className={teamButtonClass("secondary")}
        >
          {item.kind === "billing" ? "Open billing tools" : "Open company jobs"}
        </Link>
      ) : null}
      {pending && item.canAct ? (
        <form
          action={submit}
          className="space-y-4 border-t border-slate-200 pt-4"
        >
          <fieldset disabled={busy} className="space-y-4">
            <input
              type="hidden"
              name={item.kind === "address" ? "reviewId" : "requestId"}
              value={item.id}
            />
            <input
              type="hidden"
              name="expectedVersion"
              value={text(details["revision"])}
            />
            <div className="text-sm">
              <label className="block" htmlFor="partner-request-decision">
                Decision
              </label>
              <select
                id="partner-request-decision"
                name="decision"
                required
                value={choice}
                onChange={(event) => setChoice(event.target.value)}
                className={`${TEAM_INPUT_COMPACT} mt-1`}
              >
                <option value="">Choose a decision</option>
                {decisions.map((decision) => (
                  <option key={decision.value} value={decision.value}>
                    {decision.label}
                  </option>
                ))}
              </select>
            </div>
            {selected ? (
              <>
                <fieldset
                  disabled={choice !== "verified"}
                  hidden={choice !== "verified"}
                >
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block text-sm">
                      Latitude
                      <input
                        type="number"
                        min={-90}
                        max={90}
                        step="any"
                        name="latitude"
                        required={choice === "verified"}
                        className={`${TEAM_INPUT_COMPACT} mt-1`}
                      />
                    </label>
                    <label className="block text-sm">
                      Longitude
                      <input
                        type="number"
                        min={-180}
                        max={180}
                        step="any"
                        name="longitude"
                        required={choice === "verified"}
                        className={`${TEAM_INPUT_COMPACT} mt-1`}
                      />
                    </label>
                  </div>
                  <label className="mt-3 block text-sm">
                    Service-area decision
                    <select
                      name="serviceAreaEligible"
                      required={choice === "verified"}
                      defaultValue=""
                      className={`${TEAM_INPUT_COMPACT} mt-1`}
                    >
                      <option value="">Choose verified result</option>
                      <option value="true">Eligible</option>
                      <option value="false">Outside area</option>
                    </select>
                  </label>
                </fieldset>
                {choice === "change_order_required" ? (
                  <label className="block text-sm">
                    Issued fixed-price job quote
                    <select
                      required
                      name="partnerQuoteId"
                      defaultValue=""
                      className={`${TEAM_INPUT_COMPACT} mt-1`}
                    >
                      <option value="">Choose the issued quote</option>
                      {quotes.map((quote) => (
                        <option key={quote["id"]} value={quote["id"]}>
                          {quote.label}
                        </option>
                      ))}
                    </select>
                    {!quotes.length ? (
                      <span className="mt-1 block text-amber-900">
                        Create and issue a fixed-price quote for this job in the
                        company’s Billing workspace first.
                      </span>
                    ) : null}
                  </label>
                ) : (
                  <input type="hidden" name="partnerQuoteId" value="" />
                )}
                <label className="block text-sm">
                  {item.kind === "address"
                    ? "Decision evidence"
                    : item.kind === "billing"
                      ? "Partner-visible outcome explanation"
                      : "Staff decision reason"}
                  <textarea
                    name={item.kind === "address" ? "note" : "reason"}
                    required
                    minLength={12}
                    maxLength={item.kind === "billing" ? 2000 : 1000}
                    className={`${TEAM_INPUT_COMPACT} mt-1 min-h-24 resize-y`}
                  />
                </label>
                <label className="block text-sm">
                  Type {selected.confirmation}
                  <input
                    name="confirmation"
                    autoComplete="off"
                    required
                    className={`${TEAM_INPUT_COMPACT} mt-1`}
                  />
                </label>
                <button
                  type="submit"
                  disabled={
                    busy ||
                    (choice === "change_order_required" && !quotes.length)
                  }
                  className={teamButtonClass(
                    selected.danger ? "danger" : "primary",
                  )}
                >
                  {busy ? "Recording decision…" : selected.label}
                </button>
              </>
            ) : null}
          </fieldset>
        </form>
      ) : (
        <p className="text-sm text-slate-600">
          {pending
            ? "Your role can read this request but cannot make this decision."
            : `Current outcome: ${item.statusLabel}. ${item.stage === "needs_attention" ? "The recorded follow-up still needs to be completed using the appropriate billing or job workflow." : "The recorded decision is retained in the request history."}`}
        </p>
      )}
    </section>
  );
}
