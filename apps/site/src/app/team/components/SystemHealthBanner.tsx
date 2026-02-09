"use client";

import * as React from "react";

type HealthFinding = {
  id: string;
  severity: "blocker" | "warning";
  title: string;
  detail: string;
  fix: string[];
};

type SystemHealth = {
  blockers: HealthFinding[];
  warnings: HealthFinding[];
  generatedAt?: string;
};

const DISMISS_STORAGE_KEY = "myst-system-health-dismissed-v1";
const DISMISS_TTL_MS = 24 * 60 * 60 * 1000;

function readDismissed(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(DISMISS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const rec = parsed as Record<string, unknown>;
    const now = Date.now();
    const out: Record<string, number> = {};
    for (const [id, value] of Object.entries(rec)) {
      const n = typeof value === "number" ? value : Number(value);
      if (Number.isFinite(n) && n > now) out[id] = n;
    }
    return out;
  } catch {
    return {};
  }
}

function writeDismissed(next: Record<string, number>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DISMISS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

export function SystemHealthBanner({ health }: { health: SystemHealth | null }) {
  const blockers = Array.isArray(health?.blockers) ? health!.blockers : [];
  const warnings = Array.isArray(health?.warnings) ? health!.warnings : [];

  const [dismissed, setDismissed] = React.useState<Record<string, number>>(() => readDismissed());

  React.useEffect(() => {
    setDismissed(readDismissed());
  }, []);

  const visibleWarnings = warnings.filter((item) => !dismissed[item.id]);

  if (blockers.length === 0 && visibleWarnings.length === 0) return null;

  const dismissWarning = React.useCallback((id: string) => {
    const expiresAt = Date.now() + DISMISS_TTL_MS;
    setDismissed((prev) => {
      const next = { ...prev, [id]: expiresAt };
      writeDismissed(next);
      return next;
    });
  }, []);

  const dismissAllWarnings = React.useCallback(() => {
    const expiresAt = Date.now() + DISMISS_TTL_MS;
    setDismissed((prev) => {
      const next = { ...prev };
      for (const w of warnings) {
        next[w.id] = expiresAt;
      }
      writeDismissed(next);
      return next;
    });
  }, [warnings]);

  return (
    <section className="rounded-2xl border border-slate-200 bg-white/80 p-4 shadow-sm shadow-slate-200/60">
      {blockers.length > 0 ? (
        <div className="rounded-xl border border-rose-200/70 bg-rose-50/70 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-rose-700">Action Required</p>
          <p className="mt-1 text-sm font-semibold text-rose-900">
            Some customer-facing actions are disabled until these are fixed.
          </p>
          <div className="mt-4 space-y-4">
            {blockers.map((item) => (
              <div key={item.id} className="rounded-lg bg-white/70 p-3">
                <p className="text-sm font-semibold text-rose-900">{item.title}</p>
                <p className="mt-1 text-sm text-rose-800">{item.detail}</p>
                {Array.isArray(item.fix) && item.fix.length > 0 ? (
                  <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-rose-800">
                    {item.fix.map((step, idx) => (
                      <li key={`${item.id}-${idx}`}>{step}</li>
                    ))}
                  </ol>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {visibleWarnings.length > 0 ? (
        <div className={`mt-4 rounded-xl border border-amber-200/70 bg-amber-50/70 p-4 ${blockers.length ? "" : ""}`}>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-700">Warnings</p>
            <button
              type="button"
              onClick={dismissAllWarnings}
              className="rounded-full border border-amber-200 bg-white px-3 py-1 text-[11px] font-semibold text-amber-800 hover:border-amber-300 hover:text-amber-900"
            >
              Dismiss 24h
            </button>
          </div>
          <div className="mt-3 space-y-3">
            {visibleWarnings.map((item) => (
              <div key={item.id} className="rounded-lg bg-white/70 p-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <p className="text-sm font-semibold text-amber-900">{item.title}</p>
                  <button
                    type="button"
                    onClick={() => dismissWarning(item.id)}
                    className="self-start rounded-full border border-amber-200 bg-white px-3 py-1 text-[11px] font-semibold text-amber-800 hover:border-amber-300 hover:text-amber-900"
                  >
                    Dismiss
                  </button>
                </div>
                <p className="mt-1 text-sm text-amber-800">{item.detail}</p>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

