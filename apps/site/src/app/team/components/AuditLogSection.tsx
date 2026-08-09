import React from "react";
import type { Route } from "next";
import Link from "next/link";
import {
  hasTeamPermission,
  requireCurrentTeamPrincipal,
} from "@/lib/team-principal";
import { callAdminApiAs } from "../lib/api";
import { isTeamSurfaceId, teamSurfaceHref } from "../surface-registry";
import {
  TEAM_CARD_PADDED,
  TEAM_SECTION_SUBTITLE,
  TEAM_SECTION_TITLE,
  teamButtonClass,
} from "./team-ui";

export type AuditLogFilters = {
  action?: string;
  actorId?: string;
  actorType?: string;
  entityType?: string;
  entityId?: string;
  outcome?: string;
  correlationId?: string;
  from?: string;
  to?: string;
  cursor?: string;
};

type AuditEvent = {
  id: string;
  action: string;
  outcome: string | null;
  surface: string | null;
  entityType: string;
  entityId: string | null;
  correlationId: string | null;
  requiredPermissions: string[];
  providerOperationId: string | null;
  createdAt: string;
  actor: {
    type: string;
    id: string | null;
    role: string | null;
    label: string | null;
    name: string | null;
    sessionId: string | null;
    authMethod: string | null;
  };
  meta: Record<string, unknown> | null;
};

type AuditPayload = {
  events: AuditEvent[];
  retention: {
    onlineDisposition: "indefinite";
    mutationProtection: "append_only_database_trigger";
    archiveWorkflow: "not_configured";
    legalHoldWorkflow: "not_configured";
  };
  pagination: {
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
};

function compactId(value: string | null): string {
  if (!value) return "not recorded";
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function isAuditRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatAuditValue(value: unknown): string {
  if (value === undefined) return "not recorded";
  if (value === null) return "none";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function auditChangeRows(
  meta: Record<string, unknown> | null,
): Array<{ field: string; before: string; after: string }> {
  const before = isAuditRecord(meta?.["before"]) ? meta?.["before"] : null;
  const after = isAuditRecord(meta?.["after"]) ? meta?.["after"] : null;
  if (!before && !after) return [];
  const fields = Array.from(
    new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]),
  ).sort();
  return fields.map((field) => ({
    field,
    before: formatAuditValue(before?.[field]),
    after: formatAuditValue(after?.[field]),
  }));
}

function auditSurfaceHref(surface: string | null): Route | null {
  if (!surface) return null;
  const normalized = surface.trim().toLowerCase();
  return isTeamSurfaceId(normalized) ? teamSurfaceHref(normalized) : null;
}

function auditRecordHref(
  entityType: string,
  entityId: string | null,
): Route | null {
  if (!entityId) return null;
  switch (entityType.trim().toLowerCase().replaceAll("-", "_")) {
    case "contact":
    case "customer":
      return teamSurfaceHref("contacts", { query: { contactId: entityId } });
    case "instant_quote":
      return `/team/instant-quotes/${encodeURIComponent(entityId)}` as Route;
    case "merge_suggestion":
      return teamSurfaceHref("merge", {
        query: { mergeSuggestionId: entityId },
      });
    default:
      return null;
  }
}

function formatTimestamp(iso: string): string {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "America/New_York",
  }).format(value);
}

function activeFilters(filters: AuditLogFilters): Record<string, string> {
  return Object.fromEntries(
    Object.entries(filters).filter(
      ([key, value]) => key !== "cursor" && typeof value === "string" && value.length > 0,
    ),
  );
}

function filterHref(
  filters: AuditLogFilters,
  cursor?: string | null,
): ReturnType<typeof teamSurfaceHref> {
  const query = {
    auditAction: filters.action,
    auditActorId: filters.actorId,
    auditActorType: filters.actorType,
    auditEntityType: filters.entityType,
    auditEntityId: filters.entityId,
    auditOutcome: filters.outcome,
    auditCorrelationId: filters.correlationId,
    auditFrom: filters.from,
    auditTo: filters.to,
    auditCursor: cursor || undefined,
  };
  return teamSurfaceHref("audit", {
    query,
  });
}

function auditExportHref(filters: AuditLogFilters): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(activeFilters(filters))) {
    search.set(key, value);
  }
  const query = search.toString();
  return `/api/team/audit/export${query ? `?${query}` : ""}`;
}

export async function AuditLogSection({
  filters = {},
}: {
  filters?: AuditLogFilters;
}): Promise<React.ReactElement> {
  const principal = await requireCurrentTeamPrincipal();
  const apiQuery = new URLSearchParams({ limit: "50" });
  for (const [key, value] of Object.entries(filters)) {
    if (typeof value === "string" && value.trim().length > 0) {
      apiQuery.set(key, value.trim());
    }
  }

  let payload: AuditPayload | null = null;
  let error: string | null = null;
  try {
    const response = await callAdminApiAs(
      principal,
      `/api/admin/audit?${apiQuery.toString()}`,
    );
    if (response.ok) {
      payload = (await response.json()) as AuditPayload;
    } else {
      const detail = (await response.json().catch(() => null)) as
        | { message?: string; error?: string }
        | null;
      error =
        detail?.message ??
        (response.status === 422
          ? "One or more audit filters are invalid. Clear the filters and try again."
          : `Audit events are unavailable (HTTP ${response.status}).`);
    }
  } catch {
    error = "Audit events are unavailable because the API could not be reached.";
  }

  const events = payload?.events ?? [];
  const appliedFilterCount = Object.keys(activeFilters(filters)).length;

  return (
    <section className="space-y-4" aria-labelledby="audit-log-heading">
      <header className={TEAM_CARD_PADDED}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="audit-log-heading" className={TEAM_SECTION_TITLE}>
              Audit Log
            </h2>
            <p className={TEAM_SECTION_SUBTITLE}>
              Verified people and services, what they attempted, the outcome, and
              the records affected. Sensitive message and contact data is redacted.
            </p>
          </div>
          {hasTeamPermission(principal, "audit.export") ? (
            <a
              href={auditExportHref(filters)}
              className={teamButtonClass("secondary")}
              download
            >
              Export redacted JSONL
            </a>
          ) : null}
        </div>
      </header>

      {payload?.retention ? (
        <aside className="rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950" aria-label="Audit retention policy">
          <p className="font-semibold">Retention: online indefinitely</p>
          <p className="mt-1">
            Database updates and deletion are blocked. Archive and legal-hold
            workflows are not configured yet, so no event is automatically removed.
          </p>
        </aside>
      ) : null}

      <form
        action={teamSurfaceHref("audit")}
        method="get"
        className={`${TEAM_CARD_PADDED} grid gap-3 sm:grid-cols-2 xl:grid-cols-4`}
        aria-label="Filter audit events"
      >
        <label className="grid gap-1 text-sm text-slate-700">
          <span className="font-medium">Action</span>
          <input
            name="auditAction"
            defaultValue={filters.action}
            placeholder="e.g. contact.deleted"
            className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 py-2"
          />
        </label>
        <label className="grid gap-1 text-sm text-slate-700">
          <span className="font-medium">Outcome</span>
          <select
            name="auditOutcome"
            defaultValue={filters.outcome ?? ""}
            className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 py-2"
          >
            <option value="">All outcomes</option>
            <option value="succeeded">Succeeded</option>
            <option value="failed">Failed</option>
            <option value="denied">Denied</option>
            <option value="attempted">Attempted</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm text-slate-700">
          <span className="font-medium">Actor type</span>
          <select
            name="auditActorType"
            defaultValue={filters.actorType ?? ""}
            className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 py-2"
          >
            <option value="">All actor types</option>
            <option value="human">Human</option>
            <option value="worker">Worker</option>
            <option value="ai">AI</option>
            <option value="system">System</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm text-slate-700">
          <span className="font-medium">Actor ID</span>
          <input
            name="auditActorId"
            defaultValue={filters.actorId}
            placeholder="Team member UUID"
            className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 py-2"
          />
        </label>
        <label className="grid gap-1 text-sm text-slate-700">
          <span className="font-medium">Entity type</span>
          <input
            name="auditEntityType"
            defaultValue={filters.entityType}
            placeholder="e.g. contact"
            className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 py-2"
          />
        </label>
        <label className="grid gap-1 text-sm text-slate-700">
          <span className="font-medium">Entity ID</span>
          <input
            name="auditEntityId"
            defaultValue={filters.entityId}
            placeholder="Record ID"
            className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 py-2"
          />
        </label>
        <label className="grid gap-1 text-sm text-slate-700">
          <span className="font-medium">Correlation ID</span>
          <input
            name="auditCorrelationId"
            defaultValue={filters.correlationId}
            placeholder="Request or operation ID"
            className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 py-2"
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="grid gap-1 text-sm text-slate-700">
            <span className="font-medium">From</span>
            <input
              name="auditFrom"
              type="date"
              defaultValue={filters.from}
              className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 py-2"
            />
          </label>
          <label className="grid gap-1 text-sm text-slate-700">
            <span className="font-medium">To</span>
            <input
              name="auditTo"
              type="date"
              defaultValue={filters.to}
              className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 py-2"
            />
          </label>
        </div>
        <div className="flex flex-wrap items-end gap-2 sm:col-span-2 xl:col-span-4">
          <button type="submit" className={teamButtonClass("primary")}>
            Apply filters
          </button>
          {appliedFilterCount > 0 ? (
            <Link href={teamSurfaceHref("audit")} className={teamButtonClass("secondary")}>
              Clear {appliedFilterCount} filter{appliedFilterCount === 1 ? "" : "s"}
            </Link>
          ) : null}
        </div>
      </form>

      {error ? (
        <div className="rounded-2xl border border-rose-300 bg-rose-50 p-5 text-sm text-rose-950" role="alert">
          <p className="font-semibold">Audit events could not be loaded</p>
          <p className="mt-1">{error}</p>
          <Link href={filterHref(filters)} className={`${teamButtonClass("secondary", "sm")} mt-3`}>
            Try again
          </Link>
        </div>
      ) : events.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-5 text-sm text-slate-600">
          {appliedFilterCount > 0
            ? "No audit events match these filters."
            : "No audit activity has been recorded yet."}
        </div>
      ) : (
        <div className={TEAM_CARD_PADDED}>
          <ol className="divide-y divide-slate-200">
            {events.map((event) => {
              const actorLabel =
                event.actor.name ?? event.actor.label ?? event.actor.type ?? "system";
              const changeRows = auditChangeRows(event.meta);
              const surfaceHref = auditSurfaceHref(event.surface);
              const recordHref = auditRecordHref(
                event.entityType,
                event.entityId,
              );
              return (
                <li key={event.id} className="py-4 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="rounded-full border border-slate-300 bg-slate-100 px-2 py-1 font-semibold text-slate-800">
                      {event.action}
                    </span>
                    <span className="rounded-full border border-slate-300 bg-white px-2 py-1 font-medium text-slate-700">
                      Outcome: {event.outcome ?? "not recorded"}
                    </span>
                    <time dateTime={event.createdAt} className="text-slate-600">
                      {formatTimestamp(event.createdAt)} ET
                    </time>
                  </div>
                  <p className="mt-2 text-sm font-medium text-slate-950">
                    {actorLabel} ({event.actor.type}) → {event.entityType}
                    {event.entityId ? ` (${compactId(event.entityId)})` : ""}
                  </p>
                  <p className="mt-1 text-xs text-slate-600">
                    Auth: {event.actor.authMethod ?? "not recorded"} · Role: {event.actor.role ?? "none"} · Correlation: {compactId(event.correlationId)}
                  </p>
                  <details className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold text-slate-800">
                      Event details
                    </summary>
                    <dl className="grid gap-2 text-xs text-slate-700 sm:grid-cols-2">
                      <div><dt className="font-semibold">Event ID</dt><dd className="break-all">{event.id}</dd></div>
                      <div><dt className="font-semibold">Actor ID</dt><dd className="break-all">{event.actor.id ?? "not recorded"}</dd></div>
                      <div><dt className="font-semibold">Session ID</dt><dd className="break-all">{event.actor.sessionId ?? "not recorded"}</dd></div>
                      <div><dt className="font-semibold">Surface</dt><dd>{event.surface ?? "not recorded"}</dd></div>
                      <div><dt className="font-semibold">Provider operation</dt><dd className="break-all">{event.providerOperationId ?? "not recorded"}</dd></div>
                      <div><dt className="font-semibold">Required permissions</dt><dd>{event.requiredPermissions.join(", ") || "not recorded"}</dd></div>
                    </dl>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {surfaceHref ? (
                        <Link
                          href={surfaceHref}
                          className={teamButtonClass("secondary", "sm")}
                        >
                          Open originating surface
                        </Link>
                      ) : null}
                      {recordHref ? (
                        <Link
                          href={recordHref}
                          className={teamButtonClass("secondary", "sm")}
                        >
                          Open affected record
                        </Link>
                      ) : null}
                      {event.correlationId ? (
                        <Link
                          href={filterHref({ correlationId: event.correlationId })}
                          className={teamButtonClass("secondary", "sm")}
                        >
                          Related request events
                        </Link>
                      ) : null}
                      {event.entityId ? (
                        <Link
                          href={filterHref({
                            entityType: event.entityType,
                            entityId: event.entityId,
                          })}
                          className={teamButtonClass("secondary", "sm")}
                        >
                          All events for this record
                        </Link>
                      ) : null}
                    </div>
                    {changeRows.length > 0 ? (
                      <section className="mt-3" aria-label="Safe before and after change summary">
                        <h3 className="text-sm font-semibold text-slate-900">
                          Change summary
                        </h3>
                        <dl className="mt-2 grid gap-2">
                          {changeRows.map((change) => (
                            <div
                              key={change.field}
                              className="grid gap-1 rounded-lg border border-slate-200 bg-white p-3 sm:grid-cols-[minmax(8rem,0.6fr)_1fr_1fr]"
                            >
                              <dt className="font-semibold text-slate-900">
                                {change.field}
                              </dt>
                              <dd className="break-words">
                                <span className="font-semibold">Before:</span>{" "}
                                {change.before}
                              </dd>
                              <dd className="break-words">
                                <span className="font-semibold">After:</span>{" "}
                                {change.after}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </section>
                    ) : null}
                    {event.meta ? (
                      <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-3 text-xs text-slate-100">
                        {JSON.stringify(event.meta, null, 2)}
                      </pre>
                    ) : null}
                  </details>
                </li>
              );
            })}
          </ol>
          {payload?.pagination.hasMore && payload.pagination.nextCursor ? (
            <div className="mt-5 border-t border-slate-200 pt-4">
              <Link
                href={filterHref(filters, payload.pagination.nextCursor)}
                className={teamButtonClass("secondary")}
              >
                View older events
              </Link>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
