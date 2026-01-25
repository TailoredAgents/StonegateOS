import React from "react";

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

export function SystemHealthBanner({ health }: { health: SystemHealth | null }) {
  if (!health) return null;
  const blockers = Array.isArray(health.blockers) ? health.blockers : [];
  const warnings = Array.isArray(health.warnings) ? health.warnings : [];

  if (blockers.length === 0 && warnings.length === 0) return null;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white/80 p-4 shadow-sm shadow-slate-200/60">
      {blockers.length > 0 ? (
        <div className="rounded-xl border border-rose-200/70 bg-rose-50/70 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-rose-700">
            Action Required
          </p>
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

      {warnings.length > 0 ? (
        <div className={`mt-4 rounded-xl border border-amber-200/70 bg-amber-50/70 p-4 ${blockers.length ? "" : ""}`}>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-700">
            Warnings
          </p>
          <div className="mt-3 space-y-3">
            {warnings.map((item) => (
              <div key={item.id} className="rounded-lg bg-white/70 p-3">
                <p className="text-sm font-semibold text-amber-900">{item.title}</p>
                <p className="mt-1 text-sm text-amber-800">{item.detail}</p>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

