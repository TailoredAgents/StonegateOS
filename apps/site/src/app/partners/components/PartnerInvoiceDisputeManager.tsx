"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { createPortalOperationKey, partnerPortalFetch } from "../lib/portal-v2";
import {
  PartnerNotice,
  partnerFieldClass,
  partnerPrimaryButtonClass,
  partnerSecondaryButtonClass,
} from "./PartnerPortalUi";

type RequestState =
  | "pending"
  | "information_provided"
  | "adjustment_required"
  | "refund_review"
  | "declined";

type BillingRequest = {
  id: string;
  category: string;
  reason: string;
  evidence: {
    disputedAmountMinor: number | null;
    reference: string | null;
    details: string | null;
  };
  state: RequestState;
  revision: number;
  resolution: { reason: string; resolvedAt: string } | null;
  createdAt: string;
};

type HistoryPayload = {
  ok: true;
  invoice: {
    id: string;
    number: string;
    status: string;
    currency: string;
    revision: number;
  };
  requests: BillingRequest[];
  page: {
    hasMore: boolean;
    nextCursor: string | null;
  };
};

type Notice = { tone: "success" | "warning" | "error"; text: string };

const CATEGORY_OPTIONS = [
  ["invoice_amount", "Invoice amount"],
  ["duplicate_charge", "Possible duplicate charge"],
  ["payment_not_reflected", "Payment not reflected"],
  ["service_concern", "Service concern"],
  ["refund_request", "Request refund review"],
  ["tax_or_document", "Tax or document question"],
  ["other", "Other billing question"],
] as const;
const DISPUTABLE_INVOICE_STATES = new Set([
  "issued",
  "partially_paid",
  "paid",
  "overdue",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHistory(value: unknown): HistoryPayload | null {
  if (!isRecord(value) || value["ok"] !== true || !isRecord(value["invoice"]))
    return null;
  const invoice = value["invoice"];
  if (
    typeof invoice["id"] !== "string" ||
    typeof invoice["number"] !== "string" ||
    typeof invoice["status"] !== "string" ||
    typeof invoice["currency"] !== "string" ||
    !Number.isSafeInteger(invoice["revision"]) ||
    !Array.isArray(value["requests"]) ||
    !isRecord(value["page"]) ||
    typeof value["page"]["hasMore"] !== "boolean" ||
    (value["page"]["nextCursor"] !== null &&
      typeof value["page"]["nextCursor"] !== "string")
  ) {
    return null;
  }
  const states = new Set<RequestState>([
    "pending",
    "information_provided",
    "adjustment_required",
    "refund_review",
    "declined",
  ]);
  const requests: BillingRequest[] = [];
  for (const item of value["requests"].slice(0, 100)) {
    if (
      !isRecord(item) ||
      typeof item["id"] !== "string" ||
      typeof item["category"] !== "string" ||
      typeof item["reason"] !== "string" ||
      typeof item["state"] !== "string" ||
      !states.has(item["state"] as RequestState) ||
      !Number.isSafeInteger(item["revision"]) ||
      typeof item["createdAt"] !== "string" ||
      !isRecord(item["evidence"])
    ) {
      return null;
    }
    const evidence = item["evidence"];
    const amount = evidence["disputedAmountMinor"];
    const reference = evidence["reference"];
    const details = evidence["details"];
    const resolution = item["resolution"];
    if (
      (amount !== null && !Number.isSafeInteger(amount)) ||
      (reference !== null && typeof reference !== "string") ||
      (details !== null && typeof details !== "string") ||
      (resolution !== null &&
        (!isRecord(resolution) ||
          typeof resolution["reason"] !== "string" ||
          typeof resolution["resolvedAt"] !== "string"))
    ) {
      return null;
    }
    requests.push({
      id: item["id"],
      category: item["category"],
      reason: item["reason"],
      evidence: {
        disputedAmountMinor: amount as number | null,
        reference,
        details,
      },
      state: item["state"] as RequestState,
      revision: item["revision"] as number,
      resolution:
        resolution === null
          ? null
          : {
              reason: resolution["reason"] as string,
              resolvedAt: resolution["resolvedAt"] as string,
            },
      createdAt: item["createdAt"],
    });
  }
  return {
    ok: true,
    invoice: {
      id: invoice["id"],
      number: invoice["number"],
      status: invoice["status"],
      currency: invoice["currency"],
      revision: invoice["revision"] as number,
    },
    requests,
    page: {
      hasMore: value["page"]["hasMore"],
      nextCursor: value["page"]["nextCursor"],
    },
  };
}

function stateLabel(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function formText(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export function PartnerInvoiceDisputeManager({
  invoiceId,
  canRequest,
}: {
  invoiceId: string;
  canRequest: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [history, setHistory] = React.useState<HistoryPayload | null>(null);
  const [etag, setEtag] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<Notice | null>(null);
  const feedbackRef = React.useRef<HTMLDivElement>(null);
  const operationRef = React.useRef<{
    fingerprint: string;
    key: string;
  } | null>(null);

  async function load(cursor: string | null = null): Promise<void> {
    if (cursor) setLoadingMore(true);
    else setLoading(true);
    setNotice(null);
    const result = await partnerPortalFetch<HistoryPayload>(
      `v2/invoices/${encodeURIComponent(invoiceId)}/dispute-requests${
        cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""
      }`,
    ).catch(() => null);
    if (cursor) setLoadingMore(false);
    else setLoading(false);
    const parsed = result?.ok ? parseHistory(result.data) : null;
    if (!result?.ok || !parsed) {
      setNotice({
        tone: "error",
        text:
          result?.response.status === 404
            ? "This invoice is no longer available to the selected account."
            : "Billing-request history could not be loaded. No request was submitted.",
      });
      return;
    }
    setHistory((current) =>
      cursor && current
        ? {
            ...parsed,
            requests: [
              ...current.requests,
              ...parsed.requests.filter(
                (item) =>
                  !current.requests.some((existing) => existing.id === item.id),
              ),
            ],
          }
        : parsed,
    );
    setEtag(result.response.headers.get("etag"));
  }

  async function toggle(): Promise<void> {
    const next = !open;
    setOpen(next);
    if (next && !history && !loading) await load();
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canRequest || !etag || submitting) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const dollars = formText(form, "disputedAmount");
    let disputedAmountMinor: number | null = null;
    if (dollars) {
      if (!/^\d{1,8}(?:\.\d{1,2})?$/u.test(dollars)) {
        setNotice({
          tone: "error",
          text: "Enter the optional disputed amount as dollars and cents.",
        });
        return;
      }
      disputedAmountMinor = Math.round(Number(dollars) * 100);
    }
    const payload = {
      category: formText(form, "category"),
      reason: formText(form, "reason"),
      evidence: {
        disputedAmountMinor,
        reference: formText(form, "reference") || null,
        details: formText(form, "details") || null,
      },
    };
    const fingerprint = JSON.stringify(payload);
    if (operationRef.current?.fingerprint !== fingerprint) {
      operationRef.current = {
        fingerprint,
        key: createPortalOperationKey(
          `billing-request-${invoiceId.slice(0, 8)}`,
        ),
      };
    }
    setSubmitting(true);
    setNotice(null);
    const result = await partnerPortalFetch<
      HistoryPayload & {
        request: BillingRequest;
      }
    >(`v2/invoices/${encodeURIComponent(invoiceId)}/dispute-requests`, {
      method: "POST",
      headers: {
        "If-Match": etag,
        "Idempotency-Key": operationRef.current.key,
      },
      body: JSON.stringify(payload),
    }).catch(() => null);
    setSubmitting(false);
    if (!result?.ok) {
      const code = result?.error.error ?? "service_unavailable";
      setNotice({
        tone: code === "mfa_step_up_required" ? "warning" : "error",
        text:
          code === "mfa_step_up_required"
            ? "Verify this secure session in Account & security, then return and submit again. No billing request was recorded."
            : code === "billing_request_pending"
              ? "This invoice already has a request under review. Refresh its history before trying again."
              : [409, 412].includes(result?.response.status ?? 0)
                ? "The invoice or request history changed. Refresh and review it before submitting again."
                : "The request could not be submitted. No adjustment or refund was started.",
      });
      requestAnimationFrame(() => feedbackRef.current?.focus());
      return;
    }
    operationRef.current = null;
    formElement.reset();
    await load();
    setNotice({
      tone: "success",
      text: "Billing request received. The invoice, payment, and refund status have not changed while Stonegate reviews it.",
    });
    requestAnimationFrame(() => feedbackRef.current?.focus());
  }

  return (
    <div className="mt-3 border-t border-slate-200 pt-3">
      <button
        type="button"
        className={partnerSecondaryButtonClass}
        aria-expanded={open}
        onClick={() => void toggle()}
      >
        {open ? "Hide billing requests" : "Ask about this invoice"}
      </button>
      {open ? (
        <div className="mt-4 space-y-4">
          <div ref={feedbackRef} tabIndex={-1} aria-live="polite">
            {notice ? (
              <PartnerNotice tone={notice.tone}>{notice.text}</PartnerNotice>
            ) : null}
          </div>
          {notice?.text.includes("Account & security") ? (
            <Link
              href={"/partners/settings" as Route}
              className={partnerSecondaryButtonClass}
            >
              Verify secure session
            </Link>
          ) : null}
          {loading ? (
            <p className="text-sm text-slate-600" role="status">
              Loading billing-request history…
            </p>
          ) : history ? (
            <>
              {history.requests.length > 0 ? (
                <ol className="space-y-3" aria-label="Billing request history">
                  {history.requests.map((request) => (
                    <li
                      key={request.id}
                      className="rounded-xl border border-slate-200 bg-white p-3"
                    >
                      <div className="flex flex-wrap justify-between gap-2">
                        <span className="text-sm font-semibold text-slate-950">
                          {stateLabel(request.category)}
                        </span>
                        <span className="text-xs font-semibold text-slate-600">
                          {stateLabel(request.state)}
                        </span>
                      </div>
                      <p className="mt-2 whitespace-pre-wrap break-words text-sm text-slate-700">
                        {request.reason}
                      </p>
                      {request.evidence.disputedAmountMinor !== null ||
                      request.evidence.reference ||
                      request.evidence.details ? (
                        <dl className="mt-3 grid gap-2 text-xs text-slate-600 sm:grid-cols-2">
                          {request.evidence.disputedAmountMinor !== null ? (
                            <div>
                              <dt className="font-semibold">
                                Amount submitted
                              </dt>
                              <dd>
                                {new Intl.NumberFormat("en-US", {
                                  style: "currency",
                                  currency: history.invoice.currency,
                                }).format(
                                  request.evidence.disputedAmountMinor / 100,
                                )}
                              </dd>
                            </div>
                          ) : null}
                          {request.evidence.reference ? (
                            <div>
                              <dt className="font-semibold">Reference</dt>
                              <dd className="break-words">
                                {request.evidence.reference}
                              </dd>
                            </div>
                          ) : null}
                          {request.evidence.details ? (
                            <div className="sm:col-span-2">
                              <dt className="font-semibold">
                                Supporting details
                              </dt>
                              <dd className="whitespace-pre-wrap break-words">
                                {request.evidence.details}
                              </dd>
                            </div>
                          ) : null}
                        </dl>
                      ) : null}
                      <p className="mt-2 text-xs text-slate-500">
                        Submitted {new Date(request.createdAt).toLocaleString()}
                      </p>
                      {request.resolution ? (
                        <p className="mt-2 whitespace-pre-wrap break-words text-xs text-slate-700">
                          Stonegate response: {request.resolution.reason}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-slate-600">
                  No billing requests have been submitted for this invoice.
                </p>
              )}
              {history.page.hasMore && history.page.nextCursor ? (
                <button
                  type="button"
                  className={partnerSecondaryButtonClass}
                  disabled={loadingMore}
                  onClick={() => void load(history.page.nextCursor)}
                >
                  {loadingMore ? "Loading more…" : "Load older requests"}
                </button>
              ) : null}
              {canRequest &&
              DISPUTABLE_INVOICE_STATES.has(history.invoice.status) &&
              !history.requests.some(
                (request) => request.state === "pending",
              ) ? (
                <form
                  onSubmit={(event) => void submit(event)}
                  className="grid gap-4"
                >
                  <label className="text-sm font-semibold text-slate-800">
                    Request category
                    <select
                      className={`${partnerFieldClass} mt-1`}
                      name="category"
                      required
                    >
                      {CATEGORY_OPTIONS.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-sm font-semibold text-slate-800">
                    What should Stonegate review?
                    <textarea
                      className={`${partnerFieldClass} mt-1 min-h-28 resize-y`}
                      name="reason"
                      minLength={10}
                      maxLength={2_000}
                      required
                      aria-describedby={`billing-request-help-${invoiceId}`}
                    />
                  </label>
                  <p
                    id={`billing-request-help-${invoiceId}`}
                    className="text-xs leading-5 text-slate-500"
                  >
                    Submitting records a review request only. It does not change
                    the invoice or initiate a refund.
                  </p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="text-sm font-semibold text-slate-800">
                      Disputed amount (optional)
                      <input
                        className={`${partnerFieldClass} mt-1`}
                        name="disputedAmount"
                        inputMode="decimal"
                        placeholder="0.00"
                      />
                    </label>
                    <label className="text-sm font-semibold text-slate-800">
                      Reference (optional)
                      <input
                        className={`${partnerFieldClass} mt-1`}
                        name="reference"
                        maxLength={160}
                      />
                    </label>
                  </div>
                  <label className="text-sm font-semibold text-slate-800">
                    Supporting details (optional)
                    <textarea
                      className={`${partnerFieldClass} mt-1 min-h-24 resize-y`}
                      name="details"
                      maxLength={4_000}
                    />
                  </label>
                  <button
                    className={partnerPrimaryButtonClass}
                    type="submit"
                    disabled={submitting || !etag}
                  >
                    {submitting
                      ? "Submitting request…"
                      : "Submit billing request"}
                  </button>
                </form>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
