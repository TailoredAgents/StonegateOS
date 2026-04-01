"use client";

import React from "react";
import { teamButtonClass } from "./team-ui";

type SceneGroup = {
  id?: string | null;
  label?: string | null;
  mediaCount?: number | null;
  notes?: string[] | null;
};

type StatedScope = {
  perceivedSize?: string | null;
  unpicturedScopeSignals?: string[] | null;
};

type MediaAnalysisPayload = {
  ok?: boolean;
  analysis?: {
    sourceChannel?: string | null;
    mediaCount?: number | null;
    videoCount?: number | null;
    visibleVolumeBucket?: string | null;
    visibleVolumeRange?: string | null;
    mergedVolumeBucket?: string | null;
    mergedVolumeRange?: string | null;
    visibleMattressCount?: number | null;
    visiblePaintCanCount?: number | null;
    visibleTireCount?: number | null;
    sceneGroupsJson?: SceneGroup[] | null;
    statedScopeJson?: StatedScope | null;
    riskFlags?: string[] | null;
    missingViews?: string[] | null;
    confidence?: "low" | "medium" | "high" | null;
    summary?: string | null;
    source?: string | null;
    updatedAt?: string | null;
  } | null;
  error?: string;
};

type Props = {
  contactId: string;
};

function formatLabel(value: string | null | undefined): string {
  if (typeof value !== "string" || value.trim().length === 0) return "Unknown";
  return value
    .split("_")
    .filter((part) => part.trim().length > 0)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function formatList(items: string[] | null | undefined): string {
  const safe = Array.isArray(items)
    ? items.filter((item) => typeof item === "string" && item.trim().length > 0)
    : [];
  return safe.length > 0 ? safe.join(", ") : "None";
}

function formatTimestamp(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

function confidenceClasses(confidence: "low" | "medium" | "high" | null | undefined): string {
  switch (confidence) {
    case "high":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "medium":
      return "border-amber-200 bg-amber-50 text-amber-700";
    case "low":
      return "border-rose-200 bg-rose-50 text-rose-700";
    default:
      return "border-slate-200 bg-slate-100 text-slate-500";
  }
}

export function ContactMediaAnalysisClient({ contactId }: Props): React.ReactElement {
  const [payload, setPayload] = React.useState<MediaAnalysisPayload | null>(null);
  const [status, setStatus] = React.useState<"idle" | "loading" | "error">("loading");
  const [refreshing, setRefreshing] = React.useState(false);

  const requestUrl = `/api/team/contacts/media-analysis?contactId=${encodeURIComponent(contactId)}&includeQuotePrice=1`;

  const refreshAnalysis = React.useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch(requestUrl, {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      const data = (await response.json().catch(() => null)) as MediaAnalysisPayload | null;
      if (!response.ok || !data?.ok) {
        throw new Error(typeof data?.error === "string" ? data.error : "Unable to load media analysis.");
      }
      setPayload(data);
      setStatus("idle");
    } catch {
      setPayload(null);
      setStatus("error");
    } finally {
      setRefreshing(false);
    }
  }, [requestUrl]);

  React.useEffect(() => {
    const controller = new AbortController();
    setStatus("loading");

    void (async () => {
      try {
        const response = await fetch(requestUrl, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        const data = (await response.json().catch(() => null)) as MediaAnalysisPayload | null;
        if (!response.ok || !data?.ok) {
          throw new Error(typeof data?.error === "string" ? data.error : "Unable to load media analysis.");
        }
        setPayload(data);
        setStatus("idle");
      } catch (error) {
        if ((error as { name?: string }).name === "AbortError") return;
        setPayload(null);
        setStatus("error");
      }
    })();

    return () => controller.abort();
  }, [requestUrl]);

  const analysis = payload?.analysis ?? null;
  const updatedAt = formatTimestamp(analysis?.updatedAt);
  const sceneGroups = Array.isArray(analysis?.sceneGroupsJson) ? analysis.sceneGroupsJson : [];
  const statedScope = analysis?.statedScopeJson ?? null;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Media Estimate</div>
          <div className="text-sm font-semibold text-slate-900">Photo analysis</div>
        </div>
        <button
          type="button"
          className={teamButtonClass("secondary", "sm")}
          onClick={() => void refreshAnalysis()}
          disabled={refreshing}
        >
          {refreshing ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      <div className="mt-3 space-y-3 text-xs text-slate-600">
        {status === "loading" ? (
          <div>Loading media analysis...</div>
        ) : status === "error" ? (
          <div className="text-rose-600">Unable to load media analysis.</div>
        ) : analysis ? (
          <>
            {analysis.summary ? (
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm leading-6 text-slate-700">
                {analysis.summary}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold ${confidenceClasses(
                  analysis.confidence,
                )}`}
              >
                {formatLabel(analysis.confidence)} confidence
              </span>
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-600">
                {analysis.mediaCount ?? 0} media
              </span>
              {(analysis.videoCount ?? 0) > 0 ? (
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-600">
                  {analysis.videoCount} video
                </span>
              ) : null}
              {analysis.source ? (
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-600">
                  {formatLabel(analysis.source)}
                </span>
              ) : null}
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <div className="font-semibold text-slate-700">Visible estimate</div>
                <div>{formatLabel(analysis.visibleVolumeRange ?? analysis.visibleVolumeBucket)}</div>
              </div>
              <div>
                <div className="font-semibold text-slate-700">Merged estimate</div>
                <div>{formatLabel(analysis.mergedVolumeRange ?? analysis.mergedVolumeBucket)}</div>
              </div>
              <div>
                <div className="font-semibold text-slate-700">Customer-selected size</div>
                <div>{formatLabel(statedScope?.perceivedSize)}</div>
              </div>
              <div>
                <div className="font-semibold text-slate-700">Add-ons found</div>
                <div>
                  Mattress {analysis.visibleMattressCount ?? 0} • Paint {analysis.visiblePaintCanCount ?? 0} • Tires{" "}
                  {analysis.visibleTireCount ?? 0}
                </div>
              </div>
            </div>

            {sceneGroups.length > 0 ? (
              <div>
                <div className="font-semibold text-slate-700">Scene groups</div>
                <div className="mt-1 space-y-1">
                  {sceneGroups.slice(0, 4).map((group, index) => (
                    <div key={group.id ?? `${group.label ?? "scene"}-${index}`} className="rounded-xl bg-slate-50 px-3 py-2">
                      <div className="font-medium text-slate-700">
                        {group.label ?? `Scene ${index + 1}`} {typeof group.mediaCount === "number" ? `(${group.mediaCount} media)` : ""}
                      </div>
                      {Array.isArray(group.notes) && group.notes.length > 0 ? (
                        <div className="mt-1 text-[11px] text-slate-500">{group.notes.join(" ")}</div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <div className="font-semibold text-slate-700">Missing views</div>
                <div>{formatList(analysis.missingViews)}</div>
              </div>
              <div>
                <div className="font-semibold text-slate-700">Risk flags</div>
                <div>{formatList(analysis.riskFlags)}</div>
              </div>
            </div>

            {Array.isArray(statedScope?.unpicturedScopeSignals) && statedScope.unpicturedScopeSignals.length > 0 ? (
              <div>
                <div className="font-semibold text-slate-700">Unpictured scope hints</div>
                <div>{statedScope.unpicturedScopeSignals.join(", ")}</div>
              </div>
            ) : null}

            {updatedAt ? <div className="text-[11px] text-slate-500">Updated {updatedAt}</div> : null}
          </>
        ) : (
          <div>No media analysis on file yet.</div>
        )}
      </div>
    </div>
  );
}
