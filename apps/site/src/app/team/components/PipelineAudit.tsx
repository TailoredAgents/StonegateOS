import React from "react";
import { callAdminApi } from "../lib/api";
import { labelForPipelineStage } from "./pipeline.stages";

type AuditEvent = {
  id: string;
  contactId: string | null;
  contactName: string | null;
  fromStage: string | null;
  toStage: string | null;
  reason: string | null;
  createdAt: string;
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

export async function PipelineAudit(): Promise<React.ReactElement | null> {
  const response = await callAdminApi("/api/admin/crm/pipeline/audit");
  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as { events?: AuditEvent[] };
  const events = data.events ?? [];
  if (events.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white/80 p-4 text-sm text-slate-500 shadow-sm">
        No recent automation recorded.
      </div>
    );
  }

  return (
    <div className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-900">Recent pipeline automation</h3>
          <p className="text-xs text-slate-500">Auto stage changes from quotes and appointments.</p>
        </div>
      </div>
      <ul className="divide-y divide-slate-200">
        {events.map((event) => (
          <li key={event.id} className="py-3 text-sm text-slate-700">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-700">
                {event.reason ?? "auto"}
              </span>
              <span className="text-xs text-slate-500">{formatAgo(event.createdAt)}</span>
            </div>
            <div className="mt-1 text-sm font-medium text-slate-900">
              {event.contactName ?? "Contact"} &mdash; {labelForPipelineStage(event.fromStage ?? "unknown")} →{" "}
              {labelForPipelineStage(event.toStage ?? "unknown")}
            </div>
            {event.meta && typeof event.meta === "object" ? (
              <div className="mt-1 text-xs text-slate-500">
                {Object.entries(event.meta)
                  .map(([key, value]) => `${key}: ${String(value)}`)
                  .join(" · ")}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

