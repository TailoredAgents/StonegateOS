import React from "react";
import { callAdminApi } from "../lib/api";

type AuditEvent = {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  createdAt: string;
  actor?: {
    type?: string;
    id?: string | null;
    role?: string | null;
    label?: string | null;
    name?: string | null;
  };
  meta?: Record<string, unknown> | null;
};

function formatAgo(iso: string): string {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return "just now";
  const diff = Date.now() - value.getTime();
  if (diff < 60_000) return "just now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export async function AuditLogSection(): Promise<React.ReactElement> {
  const response = await callAdminApi("/api/admin/audit?limit=50");
  if (!response.ok) {
    throw new Error("Failed to load audit log");
  }

  const payload = (await response.json()) as { events?: AuditEvent[] };
  const events = payload.events ?? [];

  return (
    <section className="space-y-6">
      <header className="rounded-3xl border border-slate-200 bg-white/90 p-6 shadow-xl shadow-slate-200/60 backdrop-blur">
        <h2 className="text-xl font-semibold text-slate-900">Audit Log</h2>
        <p className="mt-1 text-sm text-slate-600">
          Track who changed policies, sent messages, or paused automation.
        </p>
      </header>

      {events.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white/70 p-5 text-sm text-slate-500 shadow-sm">
          No audit activity yet.
        </div>
      ) : (
        <div className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur">
          <ul className="divide-y divide-slate-200">
            {events.map((event) => {
              const actorLabel = event.actor?.name ?? event.actor?.label ?? event.actor?.type ?? "system";
              return (
                <li key={event.id} className="py-4 text-sm text-slate-700">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                      {event.action}
                    </span>
                    <span className="text-xs text-slate-500">{formatAgo(event.createdAt)}</span>
                  </div>
                  <div className="mt-2 text-sm font-medium text-slate-900">
                    {actorLabel} -> {event.entityType}
                    {event.entityId ? ` (${event.entityId})` : ""}
                  </div>
                  {event.meta ? (
                    <div className="mt-1 text-xs text-slate-500">
                      {Object.entries(event.meta)
                        .map(([key, value]) => `${key}: ${String(value)}`)
                        .join(" - ")}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
