"use client";

import React from "react";
import { SubmitButton } from "@/components/SubmitButton";

type RecommendationStatus = "proposed" | "approved" | "ignored" | "applied";

export type GoogleAdsRecommendation = {
  id: string;
  kind: string;
  status: RecommendationStatus;
  payload: Record<string, unknown>;
  decidedAt: string | null;
  appliedAt: string | null;
  createdAt: string;
};

function safeString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function safeNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function toUsd(value: unknown): string | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return `$${n.toFixed(2)}`;
}

function toPercent(value: unknown): string | null {
  const n = safeNumber(value);
  if (n === null) return null;
  const normalized = n > 1 ? n / 100 : n;
  const pct = Math.round(Math.max(0, Math.min(1, normalized)) * 100);
  return `${pct}%`;
}

function buildCsv(rows: Array<Record<string, string>>): string {
  const headers = Array.from(
    rows.reduce((set, row) => {
      for (const key of Object.keys(row)) set.add(key);
      return set;
    }, new Set<string>())
  );

  const escapeCell = (cell: string): string => {
    const normalized = cell.replace(/\r?\n/g, " ").trim();
    if (/[",]/.test(normalized)) return `"${normalized.replace(/"/g, '""')}"`;
    return normalized;
  };

  const lines: string[] = [];
  lines.push(headers.map(escapeCell).join(","));
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCell(row[h] ?? "")).join(","));
  }
  return lines.join("\n");
}

function downloadFile(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function GoogleAdsRecommendationsPanel(props: {
  recommendations: GoogleAdsRecommendation[];
  updateAction: (formData: FormData) => Promise<void>;
  bulkUpdateAction?: (formData: FormData) => Promise<void>;
  applyAction?: (formData: FormData) => Promise<void>;
  bulkApplyAction?: (formData: FormData) => Promise<void>;
}): React.ReactElement {
  const [statusFilter, setStatusFilter] = React.useState<RecommendationStatus | "all">("proposed");
  const [kindFilter, setKindFilter] = React.useState<string>("all");
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(() => new Set());

  const kinds = React.useMemo(() => {
    const set = new Set<string>();
    for (const item of props.recommendations) set.add(item.kind);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [props.recommendations]);

  const filtered = React.useMemo(() => {
    return props.recommendations.filter((item) => {
      if (statusFilter !== "all" && item.status !== statusFilter) return false;
      if (kindFilter !== "all" && item.kind !== kindFilter) return false;
      return true;
    });
  }, [props.recommendations, statusFilter, kindFilter]);

  React.useEffect(() => {
    const visible = new Set(filtered.map((row) => row.id));
    setSelectedIds((prev) => {
      const next = new Set<string>();
      for (const id of prev) if (visible.has(id)) next.add(id);
      return next;
    });
  }, [filtered]);

  const approvedNegatives = React.useMemo(() => {
    return props.recommendations
      .filter((item) => item.kind === "negative_keyword" && item.status === "approved")
      .map((item) => safeString(item.payload["term"]).trim())
      .filter((term) => term.length > 0);
  }, [props.recommendations]);

  const selectedIdsArray = React.useMemo(() => Array.from(selectedIds), [selectedIds]);

  const selectedApprovedNegativeIds = React.useMemo(() => {
    if (selectedIds.size === 0) return [];
    return props.recommendations
      .filter((row) => selectedIds.has(row.id))
      .filter((row) => row.kind === "negative_keyword" && row.status === "approved")
      .map((row) => row.id);
  }, [props.recommendations, selectedIds]);

  const exportApprovedNegatives = React.useCallback(() => {
    const rows = approvedNegatives.map((term) => ({ term }));
    downloadFile(`stonegate-google-ads-approved-negatives.csv`, buildCsv(rows));
  }, [approvedNegatives]);

  const exportAllApproved = React.useCallback(() => {
    const rows: Array<Record<string, string>> = [];
    for (const item of props.recommendations) {
      if (item.status !== "approved") continue;
      rows.push({
        id: item.id,
        kind: item.kind,
        status: item.status,
        term: safeString(item.payload["term"]).trim(),
        tier: safeString(item.payload["tier"]).trim(),
        matchType: safeString(item.payload["matchType"]).trim(),
        origin: safeString(item.payload["origin"]).trim(),
        campaignId: safeString(item.payload["campaignId"]).trim(),
        campaignName: safeString(item.payload["campaignName"]).trim(),
        clicks: safeString(item.payload["clicks"]).trim(),
        cost: safeString(item.payload["cost"]).trim(),
        reason: safeString(item.payload["reason"]).trim(),
        createdAt: safeString(item.createdAt)
      });
    }
    downloadFile(`stonegate-google-ads-approved-recommendations.csv`, buildCsv(rows));
  }, [props.recommendations]);

  return (
    <div className="rounded-xl border border-slate-200 bg-white/80 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Recommendations</div>
          <div className="mt-1 text-xs text-slate-500">Approve items you want to apply. Nothing auto-applies changes.</div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs font-semibold text-slate-700">
            Status{" "}
            <select
              className="ml-1 rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-900"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as any)}
            >
              <option value="all">All</option>
              <option value="proposed">Proposed</option>
              <option value="approved">Approved</option>
              <option value="ignored">Ignored</option>
              <option value="applied">Applied</option>
            </select>
          </label>

          <label className="text-xs font-semibold text-slate-700">
            Type{" "}
            <select
              className="ml-1 rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-900"
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value)}
            >
              <option value="all">All</option>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            className="rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50"
            onClick={() => setSelectedIds(new Set(filtered.map((row) => row.id)))}
          >
            Select all shown
          </button>

          {selectedIdsArray.length > 0 ? (
            <button
              type="button"
              className="rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              onClick={() => setSelectedIds(new Set())}
            >
              Clear ({selectedIdsArray.length})
            </button>
          ) : null}

          {props.bulkUpdateAction && selectedIdsArray.length > 0 ? (
            <>
              <form action={props.bulkUpdateAction}>
                <input type="hidden" name="ids" value={JSON.stringify(selectedIdsArray)} />
                <input type="hidden" name="status" value="approved" />
                <SubmitButton className="rounded-xl bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800">
                  Approve selected
                </SubmitButton>
              </form>

              <form action={props.bulkUpdateAction}>
                <input type="hidden" name="ids" value={JSON.stringify(selectedIdsArray)} />
                <input type="hidden" name="status" value="ignored" />
                <SubmitButton className="rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50">
                  Ignore selected
                </SubmitButton>
              </form>

              {props.bulkApplyAction && selectedApprovedNegativeIds.length > 0 ? (
                <form
                  action={props.bulkApplyAction}
                  onSubmit={(event) => {
                    if (
                      !confirm(
                        `Apply ${selectedApprovedNegativeIds.length} approved negative keyword(s) in Google Ads now?`
                      )
                    ) {
                      event.preventDefault();
                    }
                  }}
                >
                  <input type="hidden" name="ids" value={JSON.stringify(selectedApprovedNegativeIds)} />
                  <SubmitButton className="rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700">
                    Apply approved selected
                  </SubmitButton>
                </form>
              ) : null}
            </>
          ) : null}

          {approvedNegatives.length > 0 ? (
            <>
              <button
                type="button"
                className="rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50"
                onClick={exportApprovedNegatives}
              >
                Export negatives CSV
              </button>
              <button
                type="button"
                className="rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50"
                onClick={exportAllApproved}
              >
                Export approved CSV
              </button>
            </>
          ) : null}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="mt-3 text-sm text-slate-600">No recommendations match your filters.</div>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                <th className="py-2 pr-2"></th>
                <th className="py-2 pr-4">Item</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {filtered.map((item) => {
                const term = safeString(item.payload["term"]).trim();
                const campaignName = safeString(item.payload["campaignName"]).trim();
                const campaignId = safeString(item.payload["campaignId"]).trim();
                const tier = safeString(item.payload["tier"]).trim();
                const matchType = safeString(item.payload["matchType"]).trim();
                const clicks = item.payload["clicks"];
                const cost = item.payload["cost"];
                const callConv = item.payload["callConversions"];
                const bookConv = item.payload["bookingConversions"];
                const risk = safeString(item.payload["risk"]).trim().toLowerCase();
                const confidence = toPercent(item.payload["confidence"]);
                const riskReason = safeString(item.payload["riskReason"]).trim();
                const impactClicks = safeNumber(item.payload["impactClicks"]) ?? safeNumber(clicks);
                const impactImpressions = safeNumber(item.payload["impactImpressions"]);
                const impactCost = safeNumber(item.payload["impactCost"]) ?? safeNumber(cost);
                const campaignIds = Array.isArray(item.payload["campaignIds"])
                  ? (item.payload["campaignIds"] as unknown[])
                      .map((v) => safeString(v).trim())
                      .filter((v) => v.length > 0)
                  : [];

                const label =
                  item.kind === "negative_keyword"
                    ? term || "Negative keyword"
                    : item.kind === "pause_candidate"
                      ? campaignName || campaignId || "Pause candidate"
                      : `${item.kind}`;

                const subtitleParts: string[] = [];
                if (item.kind === "negative_keyword" && tier) subtitleParts.push(`Tier ${tier.toUpperCase()}`);
                if (item.kind === "negative_keyword" && matchType) subtitleParts.push(matchType.toLowerCase());
                if (item.kind === "negative_keyword") {
                  if (risk) subtitleParts.push(`risk ${risk}`);
                  if (confidence) subtitleParts.push(`confidence ${confidence}`);

                  if (campaignIds.length > 1) subtitleParts.push(`seen in ${campaignIds.length} campaigns`);
                  else if (campaignName) subtitleParts.push(campaignName);
                  else if (campaignId) subtitleParts.push(`campaign ${campaignId}`);

                  if (impactClicks !== null) subtitleParts.push(`${impactClicks} clicks`);
                  const usd = toUsd(impactCost ?? "");
                  if (usd) subtitleParts.push(`${usd} spend`);
                  if (impactImpressions !== null && impactImpressions > 0) subtitleParts.push(`${impactImpressions} impr`);
                } else {
                  if (campaignName) subtitleParts.push(campaignName);
                  if (campaignId) subtitleParts.push(`campaign ${campaignId}`);
                  const clickN = safeNumber(clicks);
                  if (clickN !== null) subtitleParts.push(`${clickN} clicks`);
                  const usd = toUsd(cost);
                  if (usd) subtitleParts.push(`${usd} spend`);
                }
                if (typeof callConv === "number" || typeof bookConv === "number") {
                  const call = typeof callConv === "number" ? callConv : Number(callConv);
                  const book = typeof bookConv === "number" ? bookConv : Number(bookConv);
                  if (Number.isFinite(call) || Number.isFinite(book)) {
                    subtitleParts.push(`calls ${Number.isFinite(call) ? call : 0} / bookings ${Number.isFinite(book) ? book : 0}`);
                  }
                }

                const reason = safeString(item.payload["reason"]).trim();

                return (
                  <tr key={item.id} className="align-top">
                    <td className="py-2 pr-2">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-slate-300"
                        checked={selectedIds.has(item.id)}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setSelectedIds((prev) => {
                            const next = new Set(prev);
                            if (checked) next.add(item.id);
                            else next.delete(item.id);
                            return next;
                          });
                        }}
                        aria-label="Select recommendation"
                      />
                    </td>
                    <td className="py-2 pr-4">
                      <div className="font-semibold text-slate-900">{label}</div>
                      {subtitleParts.length > 0 ? (
                        <div className="text-xs text-slate-500">{subtitleParts.join(" • ")}</div>
                      ) : null}
                      {riskReason ? <div className="mt-1 text-xs text-rose-600">{riskReason}</div> : null}
                      {reason ? <div className="mt-1 text-xs text-slate-500">{reason}</div> : null}
                    </td>
                    <td className="py-2 pr-4">
                      <span className="rounded-full border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-700">
                        {item.status}
                      </span>
                    </td>
                    <td className="py-2 pr-4">
                      <div className="flex justify-end gap-2">
                        {item.status !== "approved" ? (
                          <form action={props.updateAction}>
                            <input type="hidden" name="id" value={item.id} />
                            <input type="hidden" name="status" value="approved" />
                            <SubmitButton className="rounded-xl bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800">
                              Approve
                            </SubmitButton>
                          </form>
                        ) : null}

                        {item.status !== "ignored" ? (
                          <form action={props.updateAction}>
                            <input type="hidden" name="id" value={item.id} />
                            <input type="hidden" name="status" value="ignored" />
                            <SubmitButton className="rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50">
                              Ignore
                            </SubmitButton>
                          </form>
                        ) : null}

                        {item.status === "approved" && item.kind === "negative_keyword" && props.applyAction ? (
                          <form
                            action={props.applyAction}
                            onSubmit={(event) => {
                              if (!confirm("Apply this negative keyword in Google Ads now?")) {
                                event.preventDefault();
                              }
                            }}
                          >
                            <input type="hidden" name="id" value={item.id} />
                            <SubmitButton className="rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700">
                              Apply
                            </SubmitButton>
                          </form>
                        ) : null}

                        {item.status === "approved" ? (
                          <form action={props.updateAction}>
                            <input type="hidden" name="id" value={item.id} />
                            <input type="hidden" name="status" value="applied" />
                            <SubmitButton className="rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-900 hover:bg-emerald-100">
                              Mark applied
                            </SubmitButton>
                          </form>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {approvedNegatives.length > 0 ? (
        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Approved negatives (copy/paste)</div>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-white p-3 text-xs text-slate-900">
            {approvedNegatives.join("\n")}
          </pre>
          <div className="mt-2 text-[11px] text-slate-500">
            Tip: use "Apply" to push negatives into Google Ads, or apply them manually and then click "Mark applied".
          </div>
        </div>
      ) : null}
    </div>
  );
}
