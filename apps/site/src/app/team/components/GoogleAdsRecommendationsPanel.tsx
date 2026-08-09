"use client";

import React from "react";
import { SubmitButton } from "@/components/SubmitButton";

type RecommendationStatus =
  | "proposed"
  | "approved"
  | "ignored"
  | "applying"
  | "applied"
  | "failed"
  | "reconciliation_required";

type GoogleAdsOperationState =
  | "requested"
  | "dispatched"
  | "succeeded"
  | "failed"
  | "reconciliation_required";

type GoogleAdsLastAction = {
  id: string;
  state: GoogleAdsOperationState;
  version: number;
  provider: string;
  providerOperationId: string | null;
  providerIdempotencySupported: boolean;
  term: string;
  matchType: string;
  requestedAt: string;
  dispatchedAt: string | null;
  completedAt: string | null;
  reconciliationRequiredAt: string | null;
  providerStatus: number | null;
  failureCode: string | null;
  failureDetail: string | null;
};

type GoogleAdsChange = {
  action?: unknown;
  scope?: unknown;
  entity?: unknown;
  current?: unknown;
  currentEvidence?: unknown;
  proposed?: unknown;
};

export type GoogleAdsRecommendation = {
  id: string;
  kind: string;
  status: RecommendationStatus;
  version: string;
  payload: Record<string, unknown>;
  change: GoogleAdsChange | null;
  lastAction: GoogleAdsLastAction | null;
  decidedAt: string | null;
  appliedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type GoogleAdsActionItem = { id: string; expectedVersion: string };

const REVIEWABLE_STATUSES = new Set<RecommendationStatus>([
  "proposed",
  "approved",
  "ignored",
  "failed",
]);

function safeString(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  return "";
}

function isRecommendationStatus(value: string): value is RecommendationStatus {
  return [
    "proposed",
    "approved",
    "ignored",
    "applying",
    "applied",
    "failed",
    "reconciliation_required",
  ].includes(value);
}

function safeNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function toUsd(value: unknown): string | null {
  const number = safeNumber(value);
  return number === null ? null : `$${number.toFixed(2)}`;
}

function toPercent(value: unknown): string | null {
  const number = safeNumber(value);
  if (number === null) return null;
  const normalized = number > 1 ? number / 100 : number;
  return `${Math.round(Math.max(0, Math.min(1, normalized)) * 100)}%`;
}

function fmtDate(value: string | null): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Invalid timestamp"
    : new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

function shortHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`.padEnd(
    16,
    "0",
  );
}

function actionKey(
  nonce: string,
  action: string,
  items: GoogleAdsActionItem[],
): string {
  const scope = [...items]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((item) => `${item.id}:${item.expectedVersion}`)
    .join("|");
  return `google-ads:${action}:${nonce}:${shortHash(scope)}`;
}

function actionItem(item: GoogleAdsRecommendation): GoogleAdsActionItem {
  return { id: item.id, expectedVersion: item.version };
}

function buildCsv(rows: Array<Record<string, string>>): string {
  const headers = Array.from(
    rows.reduce((set, row) => {
      for (const key of Object.keys(row)) set.add(key);
      return set;
    }, new Set<string>()),
  );
  const escapeCell = (cell: string): string => {
    const normalized = cell.replace(/\r?\n/gu, " ").trim();
    return /[",]/u.test(normalized)
      ? `"${normalized.replace(/"/gu, '""')}"`
      : normalized;
  };
  return [
    headers.map(escapeCell).join(","),
    ...rows.map((row) =>
      headers.map((header) => escapeCell(row[header] ?? "")).join(","),
    ),
  ].join("\n");
}

function downloadFile(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function statusLabel(status: RecommendationStatus): string {
  return status === "reconciliation_required"
    ? "Needs reconciliation"
    : status.charAt(0).toUpperCase() + status.slice(1);
}

function operationStateLabel(state: GoogleAdsOperationState): string {
  if (state === "succeeded") return "Applied";
  if (state === "reconciliation_required") return "Needs reconciliation";
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function statusClasses(status: RecommendationStatus): string {
  if (status === "applied") {
    return "border-emerald-300 bg-emerald-50 text-emerald-900";
  }
  if (status === "failed" || status === "reconciliation_required") {
    return "border-rose-300 bg-rose-50 text-rose-900";
  }
  if (status === "applying" || status === "approved") {
    return "border-amber-300 bg-amber-50 text-amber-900";
  }
  return "border-slate-200 bg-white text-slate-700";
}

function RecommendationEvidence({
  item,
}: {
  item: GoogleAdsRecommendation;
}): React.ReactElement {
  const proposed =
    item.change?.proposed && typeof item.change.proposed === "object"
      ? (item.change.proposed as Record<string, unknown>)
      : null;
  const proposedTerm = safeString(proposed?.["term"]);
  const proposedMatchType = safeString(proposed?.["matchType"]);
  const lastAction = item.lastAction;

  return (
    <div className="mt-2 space-y-2 text-xs">
      {item.kind === "negative_keyword" ? (
        <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-slate-700">
          <div>
            <span className="font-semibold text-slate-900">Current:</span> not
            re-queried by this report
          </div>
          <div className="mt-1">
            <span className="font-semibold text-slate-900">Proposed:</span> add
            customer-level {proposedMatchType || "keyword"} negative
            {proposedTerm ? ` “${proposedTerm}”` : ""}
          </div>
        </div>
      ) : null}

      {lastAction ? (
        <div
          className={`rounded-lg border px-3 py-2 ${
            lastAction.state === "failed" ||
            lastAction.state === "reconciliation_required"
              ? "border-rose-200 bg-rose-50 text-rose-900"
              : "border-slate-200 bg-slate-50 text-slate-700"
          }`}
        >
          <div className="font-semibold">
            Last apply action: {operationStateLabel(lastAction.state)}
          </div>
          <div className="mt-1">
            Last checkpoint:{" "}
            {fmtDate(
              lastAction.completedAt ??
                lastAction.dispatchedAt ??
                lastAction.requestedAt,
            )}
          </div>
          {lastAction.providerOperationId ? (
            <div className="mt-1 break-all font-mono text-[11px]">
              Provider operation: {lastAction.providerOperationId}
            </div>
          ) : null}
          {lastAction.failureDetail ? (
            <div className="mt-1">{lastAction.failureDetail}</div>
          ) : null}
          <div className="mt-1 text-[11px]">
            Provider request-key deduplication: unsupported. The CRM never
            auto-retries an uncertain dispatch.
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RecommendationActions(props: {
  item: GoogleAdsRecommendation;
  requestNonce: string;
  advertisingChangesDisabled: boolean;
  canReview: boolean;
  canApply: boolean;
  updateAction: (formData: FormData) => Promise<void>;
  applyAction?: (formData: FormData) => Promise<void>;
}): React.ReactElement {
  const { item } = props;
  const current = [actionItem(item)];
  const canReview = props.canReview && REVIEWABLE_STATUSES.has(item.status);
  const canApply =
    props.canApply &&
    item.status === "approved" &&
    item.kind === "negative_keyword";

  return (
    <div className="flex flex-wrap gap-2">
      {canReview && item.status !== "approved" ? (
        <form
          action={props.updateAction}
          onSubmit={(event) => {
            if (
              !window.confirm(
                "Approve this Google Ads recommendation for a separate apply step?",
              )
            ) {
              event.preventDefault();
            }
          }}
        >
          <input type="hidden" name="id" value={item.id} />
          <input type="hidden" name="status" value="approved" />
          <input type="hidden" name="confirmation" value="approve" />
          <input type="hidden" name="expectedVersion" value={item.version} />
          <input
            type="hidden"
            name="idempotencyKey"
            value={actionKey(props.requestNonce, "approve", current)}
          />
          <SubmitButton className="min-h-11 rounded-xl bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800">
            Approve
          </SubmitButton>
        </form>
      ) : null}

      {canReview && item.status !== "ignored" ? (
        <form
          action={props.updateAction}
          onSubmit={(event) => {
            if (!window.confirm("Ignore this Google Ads recommendation?")) {
              event.preventDefault();
            }
          }}
        >
          <input type="hidden" name="id" value={item.id} />
          <input type="hidden" name="status" value="ignored" />
          <input type="hidden" name="confirmation" value="ignore" />
          <input type="hidden" name="expectedVersion" value={item.version} />
          <input
            type="hidden"
            name="idempotencyKey"
            value={actionKey(props.requestNonce, "ignore", current)}
          />
          <SubmitButton className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50">
            Ignore
          </SubmitButton>
        </form>
      ) : null}

      {canApply && props.applyAction ? (
        <form
          action={props.applyAction}
          onSubmit={(event) => {
            if (
              !window.confirm(
                "Apply this customer-level negative keyword in Google Ads now? The provider cannot deduplicate retries, so uncertain results will require reconciliation.",
              )
            ) {
              event.preventDefault();
            }
          }}
        >
          <input type="hidden" name="id" value={item.id} />
          <input
            type="hidden"
            name="confirmation"
            value="apply_google_ads_change"
          />
          <input type="hidden" name="expectedVersion" value={item.version} />
          <input
            type="hidden"
            name="idempotencyKey"
            value={actionKey(props.requestNonce, "apply", current)}
          />
          <SubmitButton
            disabled={props.advertisingChangesDisabled}
            className="min-h-11 rounded-xl bg-emerald-700 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-slate-400"
          >
            {props.advertisingChangesDisabled
              ? "Apply paused"
              : "Apply to Google Ads"}
          </SubmitButton>
        </form>
      ) : null}
    </div>
  );
}

function recommendationDescription(item: GoogleAdsRecommendation): {
  label: string;
  details: string[];
  reason: string;
  riskReason: string;
} {
  const term = safeString(item.payload["term"]).trim();
  const campaignName = safeString(item.payload["campaignName"]).trim();
  const campaignId = safeString(item.payload["campaignId"]).trim();
  const tier = safeString(item.payload["tier"]).trim();
  const matchType = safeString(item.payload["matchType"]).trim();
  const risk = safeString(item.payload["risk"]).trim().toLowerCase();
  const confidence = toPercent(item.payload["confidence"]);
  const clicks = safeNumber(
    item.payload["impactClicks"] ?? item.payload["clicks"],
  );
  const impressions = safeNumber(item.payload["impactImpressions"]);
  const cost = toUsd(item.payload["impactCost"] ?? item.payload["cost"]);
  const campaignIds = Array.isArray(item.payload["campaignIds"])
    ? (item.payload["campaignIds"] as unknown[])
        .map((value) => safeString(value).trim())
        .filter(Boolean)
    : [];
  const details: string[] = [];
  if (tier) details.push(`Tier ${tier.toUpperCase()}`);
  if (matchType) details.push(matchType.toLowerCase());
  if (risk) details.push(`risk ${risk}`);
  if (confidence) details.push(`confidence ${confidence}`);
  if (campaignIds.length > 1)
    details.push(`seen in ${campaignIds.length} campaigns`);
  else if (campaignName) details.push(campaignName);
  else if (campaignId) details.push(`campaign ${campaignId}`);
  if (clicks !== null) details.push(`${clicks} clicks`);
  if (cost) details.push(`${cost} spend`);
  if (impressions !== null && impressions > 0)
    details.push(`${impressions} impressions`);

  return {
    label:
      item.kind === "negative_keyword"
        ? term || "Negative keyword"
        : item.kind === "pause_candidate"
          ? campaignName || campaignId || "Pause candidate"
          : item.kind,
    details,
    reason: safeString(item.payload["reason"]).trim(),
    riskReason: safeString(item.payload["riskReason"]).trim(),
  };
}

export function GoogleAdsRecommendationsPanel(props: {
  recommendations: GoogleAdsRecommendation[];
  requestNonce: string;
  advertisingChangesDisabled: boolean;
  advertisingChangesDisabledMessage: string | null;
  canReview: boolean;
  canApply: boolean;
  updateAction: (formData: FormData) => Promise<void>;
  bulkUpdateAction?: (formData: FormData) => Promise<void>;
  applyAction?: (formData: FormData) => Promise<void>;
  bulkApplyAction?: (formData: FormData) => Promise<void>;
}): React.ReactElement {
  const [statusFilter, setStatusFilter] = React.useState<
    RecommendationStatus | "all"
  >("all");
  const [kindFilter, setKindFilter] = React.useState("all");
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(
    () => new Set(),
  );

  const kinds = React.useMemo(
    () =>
      Array.from(new Set(props.recommendations.map((item) => item.kind))).sort(
        (a, b) => a.localeCompare(b),
      ),
    [props.recommendations],
  );
  const filtered = React.useMemo(
    () =>
      props.recommendations.filter(
        (item) =>
          (statusFilter === "all" || item.status === statusFilter) &&
          (kindFilter === "all" || item.kind === kindFilter),
      ),
    [kindFilter, props.recommendations, statusFilter],
  );
  React.useEffect(() => {
    const visible = new Set(filtered.map((item) => item.id));
    setSelectedIds(
      (previous) => new Set([...previous].filter((id) => visible.has(id))),
    );
  }, [filtered]);

  const selected = React.useMemo(
    () => props.recommendations.filter((item) => selectedIds.has(item.id)),
    [props.recommendations, selectedIds],
  );
  const approvable = selected
    .filter(
      (item) =>
        REVIEWABLE_STATUSES.has(item.status) && item.status !== "approved",
    )
    .map(actionItem);
  const ignorable = selected
    .filter(
      (item) =>
        REVIEWABLE_STATUSES.has(item.status) && item.status !== "ignored",
    )
    .map(actionItem);
  const applicable = selected
    .filter(
      (item) => item.status === "approved" && item.kind === "negative_keyword",
    )
    .map(actionItem);
  const canSelectItem = React.useCallback(
    (item: GoogleAdsRecommendation) =>
      (props.canReview && REVIEWABLE_STATUSES.has(item.status)) ||
      (props.canApply &&
        item.status === "approved" &&
        item.kind === "negative_keyword"),
    [props.canApply, props.canReview],
  );
  const selectable = filtered.filter(canSelectItem);
  const approvedNegatives = props.recommendations
    .filter(
      (item) => item.kind === "negative_keyword" && item.status === "approved",
    )
    .map((item) => safeString(item.payload["term"]).trim())
    .filter(Boolean);

  const exportApproved = React.useCallback(() => {
    const rows = props.recommendations
      .filter((item) => item.status === "approved")
      .map((item) => ({
        id: item.id,
        kind: item.kind,
        status: item.status,
        term: safeString(item.payload["term"]),
        matchType: safeString(item.payload["matchType"]),
        campaignId: safeString(item.payload["campaignId"]),
        reason: safeString(item.payload["reason"]),
        version: item.version,
      }));
    downloadFile(
      "stonegate-google-ads-approved-recommendations.csv",
      buildCsv(rows),
    );
  }, [props.recommendations]);

  return (
    <div className="rounded-xl border border-slate-200 bg-white/80 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Recommendations
          </h3>
          <p className="mt-1 max-w-2xl text-xs text-slate-600">
            Approval only records a decision. Applying is a separate confirmed
            provider action with a durable receipt; nothing auto-applies.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs font-semibold text-slate-700">
            Status{" "}
            <select
              className="ml-1 min-h-11 rounded-lg border border-slate-300 bg-white px-2 text-xs font-semibold text-slate-900"
              value={statusFilter}
              onChange={(event) => {
                const value = event.target.value;
                if (value === "all" || isRecommendationStatus(value)) {
                  setStatusFilter(value);
                }
              }}
            >
              <option value="all">All</option>
              <option value="proposed">Proposed</option>
              <option value="approved">Approved</option>
              <option value="ignored">Ignored</option>
              <option value="applying">Applying</option>
              <option value="applied">Applied</option>
              <option value="failed">Failed</option>
              <option value="reconciliation_required">
                Needs reconciliation
              </option>
            </select>
          </label>
          <label className="text-xs font-semibold text-slate-700">
            Type{" "}
            <select
              className="ml-1 min-h-11 rounded-lg border border-slate-300 bg-white px-2 text-xs font-semibold text-slate-900"
              value={kindFilter}
              onChange={(event) => setKindFilter(event.target.value)}
            >
              <option value="all">All</option>
              {kinds.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
          </label>
          {selectable.length > 0 ? (
            <button
              type="button"
              className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50"
              onClick={() =>
                setSelectedIds(new Set(selectable.map((item) => item.id)))
              }
            >
              Select actionable
            </button>
          ) : null}
          {selectedIds.size > 0 ? (
            <button
              type="button"
              className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              onClick={() => setSelectedIds(new Set())}
            >
              Clear ({selectedIds.size})
            </button>
          ) : null}
        </div>
      </div>

      {props.advertisingChangesDisabled ? (
        <div
          className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950"
          role="alert"
        >
          {props.advertisingChangesDisabledMessage ??
            "Advertising apply controls are temporarily disabled server-side."}
        </div>
      ) : null}

      {selectedIds.size > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <span className="mr-1 text-xs font-semibold text-slate-700">
            Selected actions
          </span>
          {props.canReview &&
          props.bulkUpdateAction &&
          approvable.length > 0 ? (
            <form
              action={props.bulkUpdateAction}
              onSubmit={(event) => {
                if (
                  !window.confirm(
                    `Approve ${approvable.length} recommendation(s) for a separate apply step?`,
                  )
                ) {
                  event.preventDefault();
                }
              }}
            >
              <input
                type="hidden"
                name="items"
                value={JSON.stringify(approvable)}
              />
              <input type="hidden" name="status" value="approved" />
              <input type="hidden" name="confirmation" value="approve" />
              <input
                type="hidden"
                name="idempotencyKey"
                value={actionKey(
                  props.requestNonce,
                  "bulk-approve",
                  approvable,
                )}
              />
              <SubmitButton className="min-h-11 rounded-xl bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800">
                Approve {approvable.length}
              </SubmitButton>
            </form>
          ) : null}
          {props.canReview && props.bulkUpdateAction && ignorable.length > 0 ? (
            <form
              action={props.bulkUpdateAction}
              onSubmit={(event) => {
                if (
                  !window.confirm(
                    `Ignore ${ignorable.length} recommendation(s)?`,
                  )
                ) {
                  event.preventDefault();
                }
              }}
            >
              <input
                type="hidden"
                name="items"
                value={JSON.stringify(ignorable)}
              />
              <input type="hidden" name="status" value="ignored" />
              <input type="hidden" name="confirmation" value="ignore" />
              <input
                type="hidden"
                name="idempotencyKey"
                value={actionKey(props.requestNonce, "bulk-ignore", ignorable)}
              />
              <SubmitButton className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50">
                Ignore {ignorable.length}
              </SubmitButton>
            </form>
          ) : null}
          {props.canApply && props.bulkApplyAction && applicable.length > 0 ? (
            <form
              action={props.bulkApplyAction}
              onSubmit={(event) => {
                if (
                  !window.confirm(
                    `Apply ${applicable.length} customer-level negative keyword(s) in Google Ads now? Uncertain provider results will be quarantined, not retried.`,
                  )
                ) {
                  event.preventDefault();
                }
              }}
            >
              <input
                type="hidden"
                name="items"
                value={JSON.stringify(applicable)}
              />
              <input
                type="hidden"
                name="confirmation"
                value="apply_google_ads_changes"
              />
              <input
                type="hidden"
                name="idempotencyKey"
                value={actionKey(props.requestNonce, "bulk-apply", applicable)}
              />
              <SubmitButton
                disabled={
                  props.advertisingChangesDisabled || applicable.length > 25
                }
                className="min-h-11 rounded-xl bg-emerald-700 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-slate-400"
              >
                {applicable.length > 25
                  ? "Apply at most 25"
                  : `Apply ${applicable.length} to Google Ads`}
              </SubmitButton>
            </form>
          ) : null}
          {applicable.length > 25 ? (
            <span className="text-xs font-semibold text-amber-800">
              Reduce the apply selection to 25 or fewer.
            </span>
          ) : null}
        </div>
      ) : null}

      {filtered.length === 0 ? (
        <div className="mt-3 text-sm text-slate-600">
          No recommendations match your filters.
        </div>
      ) : (
        <>
          <div className="mt-3 space-y-3 md:hidden">
            {filtered.map((item) => {
              const description = recommendationDescription(item);
              const selectableItem = canSelectItem(item);
              return (
                <article
                  key={item.id}
                  className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4 text-sm shadow-sm"
                >
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-1 h-5 w-5 rounded border-slate-300"
                      checked={selectedIds.has(item.id)}
                      disabled={!selectableItem}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        setSelectedIds((previous) => {
                          const next = new Set(previous);
                          if (checked) next.add(item.id);
                          else next.delete(item.id);
                          return next;
                        });
                      }}
                      aria-label={`Select ${description.label}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="font-semibold text-slate-900">
                          {description.label}
                        </div>
                        <span
                          className={`rounded-full border px-2 py-1 text-xs font-semibold ${statusClasses(item.status)}`}
                        >
                          {statusLabel(item.status)}
                        </span>
                      </div>
                      {description.details.length > 0 ? (
                        <div className="mt-1 text-xs text-slate-500">
                          {description.details.join(" • ")}
                        </div>
                      ) : null}
                      {description.riskReason ? (
                        <div className="mt-1 text-xs text-rose-700">
                          {description.riskReason}
                        </div>
                      ) : null}
                      {description.reason ? (
                        <div className="mt-1 text-xs text-slate-600">
                          {description.reason}
                        </div>
                      ) : null}
                      <RecommendationEvidence item={item} />
                      <div className="mt-3">
                        <RecommendationActions
                          item={item}
                          requestNonce={props.requestNonce}
                          advertisingChangesDisabled={
                            props.advertisingChangesDisabled
                          }
                          canReview={props.canReview}
                          canApply={props.canApply}
                          updateAction={props.updateAction}
                          applyAction={props.applyAction}
                        />
                      </div>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>

          <div className="mt-3 hidden overflow-x-auto md:block">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <th className="py-2 pr-2">
                    <span className="sr-only">Select</span>
                  </th>
                  <th className="py-2 pr-4">Recommendation and diff</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {filtered.map((item) => {
                  const description = recommendationDescription(item);
                  const selectableItem = canSelectItem(item);
                  return (
                    <tr key={item.id} className="align-top">
                      <td className="py-3 pr-2">
                        <input
                          type="checkbox"
                          className="h-5 w-5 rounded border-slate-300"
                          checked={selectedIds.has(item.id)}
                          disabled={!selectableItem}
                          onChange={(event) => {
                            const checked = event.target.checked;
                            setSelectedIds((previous) => {
                              const next = new Set(previous);
                              if (checked) next.add(item.id);
                              else next.delete(item.id);
                              return next;
                            });
                          }}
                          aria-label={`Select ${description.label}`}
                        />
                      </td>
                      <td className="max-w-xl py-3 pr-4">
                        <div className="font-semibold text-slate-900">
                          {description.label}
                        </div>
                        {description.details.length > 0 ? (
                          <div className="text-xs text-slate-500">
                            {description.details.join(" • ")}
                          </div>
                        ) : null}
                        {description.riskReason ? (
                          <div className="mt-1 text-xs text-rose-700">
                            {description.riskReason}
                          </div>
                        ) : null}
                        {description.reason ? (
                          <div className="mt-1 text-xs text-slate-600">
                            {description.reason}
                          </div>
                        ) : null}
                        <RecommendationEvidence item={item} />
                      </td>
                      <td className="py-3 pr-4">
                        <span
                          className={`inline-flex rounded-full border px-2 py-1 text-xs font-semibold ${statusClasses(item.status)}`}
                        >
                          {statusLabel(item.status)}
                        </span>
                      </td>
                      <td className="py-3">
                        <div className="flex justify-end">
                          <RecommendationActions
                            item={item}
                            requestNonce={props.requestNonce}
                            advertisingChangesDisabled={
                              props.advertisingChangesDisabled
                            }
                            canReview={props.canReview}
                            canApply={props.canApply}
                            updateAction={props.updateAction}
                            applyAction={props.applyAction}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {approvedNegatives.length > 0 ? (
        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Approved negatives
              </div>
              <div className="mt-1 text-[11px] text-slate-500">
                Export is a review aid. Only a confirmed Apply action can mark a
                recommendation applied in the CRM.
              </div>
            </div>
            <button
              type="button"
              className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50"
              onClick={exportApproved}
            >
              Export approved CSV
            </button>
          </div>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-white p-3 text-xs text-slate-900">
            {approvedNegatives.join("\n")}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
