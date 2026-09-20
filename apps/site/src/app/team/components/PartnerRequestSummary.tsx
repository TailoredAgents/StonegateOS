"use client";
import { useSyncExternalStore } from "react";
import Link from "next/link";
import type { Route } from "next";
import type { PartnerRequestInboxCounts } from "@myst-os/sdk";
import { loadPartnerRequestInbox } from "../actions/partner-request-inbox";
import { teamButtonClass } from "./team-ui";

type Snapshot = { counts: PartnerRequestInboxCounts | null; error: boolean };
const empty: Snapshot = { counts: null, error: false };
let snapshot = empty,
  busy = false,
  timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();
export async function refreshPartnerRequestCounts() {
  if (busy || document.visibilityState !== "visible") return;
  busy = true;
  try {
    const result = await loadPartnerRequestInbox({ limit: 1 });
    snapshot = result.ok
      ? { counts: result.data.counts, error: false }
      : { ...snapshot, error: true };
  } catch {
    snapshot = { ...snapshot, error: true };
  } finally {
    busy = false;
    listeners.forEach((listener) => listener());
  }
}
function visibleRefresh() {
  void refreshPartnerRequestCounts();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    void refreshPartnerRequestCounts();
    timer = setInterval(() => void refreshPartnerRequestCounts(), 30_000);
    document.addEventListener("visibilitychange", visibleRefresh);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = null;
      document.removeEventListener("visibilitychange", visibleRefresh);
    }
  };
}
export function usePartnerRequestCounts() {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => empty,
  );
}
export function PartnerRequestBadge({ accountId }: { accountId?: string }) {
  const { counts, error } = usePartnerRequestCounts();
  const count = counts
    ? accountId
      ? (counts.byCompany[accountId] ?? 0)
      : counts.needsAttention
    : null;
  if (count === 0 && !error) return null;
  return (
    <span
      title={
        error
          ? "Request counts could not be refreshed"
          : `${count ?? "Loading"} partner requests needing attention`
      }
      aria-label={
        error
          ? "Request counts unavailable"
          : `${count ?? "Loading"} requests needing attention`
      }
      className="ml-auto inline-flex min-w-6 shrink-0 items-center justify-center rounded-full bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-950"
    >
      {error ? "!" : count === null ? "…" : count}
    </span>
  );
}
export function PartnerRequestShortcut({ accountId }: { accountId?: string }) {
  const { counts, error } = usePartnerRequestCounts();
  const count = counts
    ? accountId
      ? (counts.byCompany[accountId] ?? 0)
      : counts.needsAttention
    : null;
  const href =
    "/team/partners?p_admin=requests" +
    (accountId
      ? `&p_company=${encodeURIComponent(accountId)}&p_company_section=jobs`
      : "");
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-4">
      <div>
        <h3 className="font-semibold">Partner requests</h3>
        <p
          className="mt-1 text-sm text-[color:var(--team-text-muted)]"
          role="status"
        >
          {error
            ? "Request counts could not be refreshed."
            : count === null
              ? "Loading requests…"
              : count === 0
                ? "No requests need attention."
                : `${count} ${count === 1 ? "request needs" : "requests need"} attention.`}
        </p>
      </div>
      <Link href={href as Route} className={teamButtonClass("secondary")}>
        Review requests
      </Link>
    </div>
  );
}
