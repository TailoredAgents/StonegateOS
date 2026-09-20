"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import {
  PARTNER_REQUEST_KINDS,
  PARTNER_REQUEST_STAGES,
  type PartnerRequestInboxResponse,
  type PartnerRequestInboxDetailResponse,
  type PartnerRequestKind,
  type PartnerRequestStage,
} from "@myst-os/sdk";
import {
  loadPartnerRequestInbox,
  loadPartnerRequestDetail,
  markPartnerRequestOpened,
} from "../actions/partner-request-inbox";
import { PartnerServiceReviews } from "./PartnerServiceReviews";
import { PartnerRescheduleReviews } from "./PartnerRescheduleReviews";
import { PartnerRequestDecisionPanel } from "./PartnerRequestDecisionPanel";
import { refreshPartnerRequestCounts } from "./PartnerRequestSummary";
import { partnerCompanyHref } from "../partner-company-navigation";
import { TEAM_INPUT_COMPACT, teamButtonClass } from "./team-ui";
const KINDS: Record<PartnerRequestKind, string> = {
  service: "Service requests",
  reschedule: "Schedule changes",
  cancellation: "Cancellations",
  change: "Job changes",
  billing: "Billing questions",
  address: "Address reviews",
};
const STAGES: Record<PartnerRequestStage, string> = {
  needs_attention: "Needs attention",
  waiting_on_client: "Waiting on client",
  handled: "Handled",
};
function date(value: string) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    ? new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "America/New_York",
      }).format(parsed)
    : "Date unavailable";
}
function stage(value?: string): PartnerRequestStage {
  return PARTNER_REQUEST_STAGES.includes(value as PartnerRequestStage)
    ? (value as PartnerRequestStage)
    : "needs_attention";
}
function kind(value?: string): PartnerRequestKind | "" {
  return PARTNER_REQUEST_KINDS.includes(value as PartnerRequestKind)
    ? (value as PartnerRequestKind)
    : "";
}
export function PartnerRequestInbox({
  accountId,
  initialStatus,
  initialKind,
  initialQuery,
  initialRequestKey,
  alertGroupId,
}: {
  accountId?: string;
  initialStatus?: string;
  initialKind?: string;
  initialQuery?: string;
  initialRequestKey?: string;
  alertGroupId?: string;
}) {
  const [status, setStatus] = useState(stage(initialStatus)),
    [requestKind, setKind] = useState(kind(initialKind)),
    [query, setQuery] = useState(initialQuery ?? ""),
    [search, setSearch] = useState(initialQuery ?? "");
  const [requestKey, setRequestKey] = useState(initialRequestKey ?? ""),
    [data, setData] = useState<PartnerRequestInboxResponse | null>(null),
    [selected, setSelected] =
      useState<PartnerRequestInboxDetailResponse | null>(null);
  const [busy, setBusy] = useState(false),
    [loadingDetail, setLoadingDetail] = useState(false),
    [error, setError] = useState(""),
    [detailError, setDetailError] = useState("");
  const generation = useRef(0),
    detailGeneration = useRef(0),
    dirty = useRef(false),
    busyRead = useRef(false),
    hasMoreLoaded = useRef(false),
    detailHeading = useRef<HTMLHeadingElement>(null),
    listRef = useRef<HTMLDivElement>(null),
    opened = useRef(new Set<string>());
  const latest = useRef({
    status,
    requestKind,
    search,
    requestKey,
    accountId,
    alertGroupId,
  });
  latest.current = {
    status,
    requestKind,
    search,
    requestKey,
    accountId,
    alertGroupId,
  };
  const readyRequestKey = useRef("");
  const pendingFocusKey = useRef("");
  const lastUrl = useRef("");
  const dataRef = useRef(data);
  dataRef.current = data;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const load = useCallback(async (more = false, background = false) => {
    if (background && (busyRead.current || hasMoreLoaded.current)) return;
    const current = ++generation.current;
    busyRead.current = true;
    if (!background) setBusy(true);
    const filters = latest.current;
    const result = await loadPartnerRequestInbox({
      status: filters.alertGroupId ? undefined : filters.status,
      kind: filters.alertGroupId ? undefined : filters.requestKind,
      accountId: filters.accountId,
      q: filters.alertGroupId ? undefined : filters.search,
      alertGroupId: filters.alertGroupId,
      limit: filters.alertGroupId ? 100 : 25,
      ...(more && dataRef.current?.page.nextCursor
        ? { cursor: dataRef.current.page.nextCursor }
        : {}),
    }).catch(() => ({
      ok: false as const,
      message: "Requests could not be refreshed. Try again.",
    }));
    if (current !== generation.current) return;
    busyRead.current = false;
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setError("");
    hasMoreLoaded.current = more;
    setData((previous) =>
      more && previous
        ? {
            ...result.data,
            requests: [
              ...previous.requests,
              ...result.data.requests.filter(
                (item) =>
                  !previous.requests.some(
                    (existing) => existing.key === item.key,
                  ),
              ),
            ],
          }
        : result.data,
    );
  }, []);
  const loadDetail = useCallback(async (key: string, refresh = false) => {
    const current = ++detailGeneration.current;
    if (!key) {
      setSelected(null);
      setDetailError("");
      setLoadingDetail(false);
      return;
    }
    if (!refresh) {
      pendingFocusKey.current = key;
      setSelected(null);
      setLoadingDetail(true);
    }
    setDetailError("");
    const account =
      latest.current.accountId ??
      dataRef.current?.requests.find((item) => item.key === key)?.accountId ??
      (selectedRef.current?.request.key === key
        ? selectedRef.current.request.accountId
        : undefined);
    const result = await loadPartnerRequestDetail(key, account).catch(() => ({
      ok: false as const,
      message: "This request could not be loaded. Try again.",
    }));
    if (current !== detailGeneration.current) return;
    setLoadingDetail(false);
    if (result.ok) {
      if (
        refresh &&
        (result.data.request.state !== selectedRef.current?.request.state ||
          result.data.record?.["revision"] !==
            selectedRef.current?.record?.["revision"])
      )
        dirty.current = false;
      setSelected(result.data);
    } else setDetailError(result.message);
  }, []);
  useEffect(() => {
    if (
      selected &&
      pendingFocusKey.current === selected.request.key &&
      selected.request.key === latest.current.requestKey &&
      detailHeading.current
    ) {
      detailHeading.current.focus();
      pendingFocusKey.current = "";
    }
  }, [selected]);
  useEffect(() => {
    hasMoreLoaded.current = false;
    setData(null);
    void load();
  }, [status, requestKind, search, accountId, alertGroupId, load]);
  useEffect(() => {
    void loadDetail(requestKey);
    return () => {
      detailGeneration.current++;
    };
  }, [requestKey, loadDetail]);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") void load(false, true);
    };
    const timer = setInterval(refresh, 30_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      generation.current++;
    };
  }, [load]);
  function syncUrl(next: Partial<typeof latest.current>) {
    const current = { ...latest.current, ...next };
    const url = new URL(window.location.href);
    url.searchParams.set("p_admin", "requests");
    for (const [key, value] of Object.entries({
      p_request_status: current.status,
      p_request_kind: current.requestKind,
      p_admin_q: current.search,
      p_request: current.requestKey,
      p_alert: current.alertGroupId ?? "",
    })) {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    lastUrl.current = url.pathname + url.search;
    window.history.pushState(null, "", lastUrl.current);
  }
  function mayLeave() {
    return (
      !dirty.current ||
      window.confirm("Leave this request without saving your changes?")
    );
  }
  function selectRequest(key: string) {
    if (!mayLeave()) return;
    dirty.current = false;
    setRequestKey(key);
    syncUrl({ requestKey: key });
    if (!key) requestAnimationFrame(() => listRef.current?.focus());
  }
  useEffect(() => {
    lastUrl.current = window.location.pathname + window.location.search;
    const pop = () => {
      if (
        dirty.current &&
        !window.confirm("Leave this request without saving your changes?")
      ) {
        window.history.pushState(null, "", lastUrl.current);
        return;
      }
      lastUrl.current = window.location.pathname + window.location.search;
      const params = new URLSearchParams(window.location.search);
      dirty.current = false;
      setStatus(stage(params.get("p_request_status") ?? undefined));
      setKind(kind(params.get("p_request_kind") ?? undefined));
      setQuery(params.get("p_admin_q") ?? "");
      setSearch(params.get("p_admin_q") ?? "");
      setRequestKey(params.get("p_request") ?? "");
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (dirty.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("popstate", pop);
    window.addEventListener("beforeunload", unload);
    return () => {
      window.removeEventListener("popstate", pop);
      window.removeEventListener("beforeunload", unload);
    };
  }, []);
  const acknowledge = useCallback(() => {
    const row = selectedRef.current?.request;
    const current = latest.current.requestKey;
    if (
      document.visibilityState !== "visible" ||
      readyRequestKey.current !== current ||
      !detailHeading.current?.getClientRects().length ||
      !row ||
      row.key !== current ||
      row.kind !== "service" ||
      !row.canAcknowledge ||
      opened.current.has(current)
    )
      return;
    opened.current.add(current);
    void markPartnerRequestOpened({ bookingId: row.id }).then((ok) => {
      if (!ok) opened.current.delete(current);
      else {
        void refreshPartnerRequestCounts();
        setData((previous) =>
          previous
            ? {
                ...previous,
                requests: previous.requests.map((item) =>
                  item.key === current ? { ...item, isNew: false } : item,
                ),
              }
            : previous,
        );
      }
    });
  }, []);
  const acknowledgeGroup = useCallback(() => {
    const current = dataRef.current;
    const group = current?.group;
    if (
      !current ||
      !current.requests.length ||
      document.visibilityState !== "visible" ||
      !group?.canAcknowledge ||
      group.openedAt ||
      current.page.nextCursor ||
      current.requests.length !== group.memberCount ||
      opened.current.has(group.id) ||
      !listRef.current?.getClientRects().length
    )
      return;
    opened.current.add(group.id);
    void markPartnerRequestOpened({ groupId: group.id }).then((ok) => {
      if (!ok) opened.current.delete(group.id);
    });
  }, []);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      acknowledge();
      acknowledgeGroup();
    });
    return () => cancelAnimationFrame(frame);
  }, [data, requestKey, acknowledgeGroup, acknowledge]);
  useEffect(() => {
    const visible = () => {
      if (document.visibilityState === "visible")
        requestAnimationFrame(() => {
          acknowledge();
          acknowledgeGroup();
        });
    };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, [acknowledge, acknowledgeGroup]);
  const detailReady = useCallback(() => {
    readyRequestKey.current = latest.current.requestKey;
    requestAnimationFrame(acknowledge);
  }, [acknowledge]);
  async function changed(confirmed = false) {
    if (confirmed) dirty.current = false;
    await Promise.all([
      loadDetail(latest.current.requestKey, true),
      load(),
      refreshPartnerRequestCounts(),
    ]);
  }
  useEffect(() => {
    setRequestKey(initialRequestKey ?? "");
  }, [initialRequestKey]);
  const counts = data?.counts;
  return (
    <section
      className="min-w-0 space-y-4"
      aria-labelledby="partner-requests-heading"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="partner-requests-heading" className="text-xl font-semibold">
            Requests
          </h2>
          <p className="mt-1 text-sm text-[color:var(--team-text-muted)]">
            Review partner requests and confirm the next step.
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void load()}
          className={teamButtonClass("secondary", "sm")}
        >
          Refresh requests
        </button>
      </div>
      {alertGroupId ? (
        <p className="rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-950">
          Requests from this owner alert
          {data?.group
            ? ` · ${data.group.memberCount} request${data.group.memberCount === 1 ? "" : "s"}`
            : ""}
          .{" "}
          <Link href="/team/partners?p_admin=requests" className="underline">
            View all requests
          </Link>
        </p>
      ) : null}
      {!alertGroupId ? (
        <>
          <nav aria-label="Request status" className="flex flex-wrap gap-2">
            {PARTNER_REQUEST_STAGES.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  if (!mayLeave()) return;
                  dirty.current = false;
                  setStatus(value);
                  setRequestKey("");
                  syncUrl({ status: value, requestKey: "" });
                }}
                aria-current={status === value ? "page" : undefined}
                className={`inline-flex min-h-11 items-center gap-2 rounded-lg px-3 py-2 text-sm ${status === value ? "bg-slate-900 font-semibold text-white" : "border border-slate-200 bg-white text-slate-700"}`}
              >
                {STAGES[value]}
                <span className="text-xs">
                  {counts
                    ? value === "needs_attention"
                      ? counts.needsAttention
                      : value === "waiting_on_client"
                        ? counts.waitingOnClient
                        : counts.handled
                    : "…"}
                </span>
              </button>
            ))}
          </nav>
          <form
            className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(180px,240px)_auto]"
            onSubmit={(event) => {
              event.preventDefault();
              if (!mayLeave()) return;
              dirty.current = false;
              setSearch(query);
              setRequestKey("");
              syncUrl({ search: query, requestKey: "" });
            }}
          >
            <label className="block min-w-0 text-sm">
              Find company
              <input
                type="search"
                value={query}
                maxLength={100}
                onChange={(event) => setQuery(event.target.value)}
                className={`${TEAM_INPUT_COMPACT} mt-1 block w-full`}
                placeholder="Company name"
              />
            </label>
            <div className="min-w-0 text-sm">
              <label className="block" htmlFor="partner-request-kind">
                Request type
              </label>
              <select
                id="partner-request-kind"
                value={requestKind}
                onChange={(event) => {
                  if (!mayLeave()) return;
                  const value = kind(event.target.value);
                  dirty.current = false;
                  setKind(value);
                  setRequestKey("");
                  syncUrl({ requestKind: value, requestKey: "" });
                }}
                className={`${TEAM_INPUT_COMPACT} mt-1 block w-full`}
              >
                <option value="">All request types</option>
                {PARTNER_REQUEST_KINDS.map((value) => (
                  <option key={value} value={value}>
                    {KINDS[value]}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className={teamButtonClass("secondary")}>
              Search requests
            </button>
          </form>
        </>
      ) : null}
      {error ? (
        <p
          role="status"
          className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950"
        >
          {error}
        </p>
      ) : null}
      <div
        className={`grid min-w-0 items-start gap-5 ${requestKey ? "lg:grid-cols-[minmax(250px,0.8fr)_minmax(0,1.7fr)]" : ""}`}
      >
        <div
          ref={listRef}
          tabIndex={-1}
          aria-label="Request list"
          className={`min-w-0 space-y-3 outline-none ${requestKey ? "hidden lg:block" : ""}`}
        >
          {busy && !data ? <p role="status">Loading requests…</p> : null}
          {data && !data.requests.length ? (
            <p className="rounded-xl border border-dashed border-slate-300 p-6 text-sm text-slate-600">
              No requests match these filters.
            </p>
          ) : null}
          <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white">
            {data?.requests.map((item) => (
              <li key={item.key}>
                <button
                  type="button"
                  onClick={() => selectRequest(item.key)}
                  aria-current={requestKey === item.key ? "true" : undefined}
                  className={`w-full min-w-0 space-y-2 p-4 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-teal-700 ${requestKey === item.key ? "bg-teal-50" : "hover:bg-slate-50"}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="break-words font-semibold text-slate-950">
                      {item.accountName}
                    </span>
                    {item.isNew ? (
                      <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-900">
                        New
                      </span>
                    ) : null}
                  </div>
                  <p className="break-words text-sm text-slate-800">
                    {item.kind === "service" ? item.service : KINDS[item.kind]}{" "}
                    · {item.statusLabel}
                  </p>
                  <p className="break-words text-sm text-slate-600">
                    {[item.siteName, item.address]
                      .filter(Boolean)
                      .join(" · ") || "Address needs review"}
                  </p>
                  {item.preferredWindows.length ? (
                    <p className="break-words text-xs text-slate-600">
                      Requested:{" "}
                      {item.preferredWindows
                        .map(
                          (window) =>
                            `${window.localDate} · ${window.timeOfDay === "anytime" ? "Any time" : window.timeOfDay}`,
                        )
                        .join("; ")}
                    </p>
                  ) : null}
                  <p className="text-xs text-slate-500">
                    Received {date(item.receivedAt)}
                  </p>
                </button>
              </li>
            ))}
          </ul>
          {data?.page.nextCursor ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void load(true)}
              className={teamButtonClass("secondary")}
            >
              {busy ? "Loading…" : "Load more requests"}
            </button>
          ) : null}
        </div>
        {requestKey ? (
          <article
            className="min-w-0 space-y-5 rounded-xl border border-slate-200 bg-white p-4 sm:p-5"
            onInputCapture={() => {
              dirty.current = true;
            }}
            onChangeCapture={() => {
              dirty.current = true;
            }}
          >
            <button
              type="button"
              onClick={() => selectRequest("")}
              className={teamButtonClass("secondary", "sm")}
            >
              Back to requests
            </button>
            {loadingDetail ? <p role="status">Loading request…</p> : null}
            {detailError ? (
              <p role="alert">
                {detailError}{" "}
                <button
                  type="button"
                  onClick={() => void loadDetail(requestKey)}
                  className={teamButtonClass("secondary", "sm")}
                >
                  Try again
                </button>
              </p>
            ) : null}
            {selected ? (
              <>
                <header className="space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <h3
                      ref={detailHeading}
                      tabIndex={-1}
                      className="min-w-0 break-words text-xl font-semibold outline-none"
                    >
                      {selected.request.kind === "service"
                        ? selected.request.service
                        : KINDS[selected.request.kind]}
                    </h3>
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700">
                      {selected.request.statusLabel}
                    </span>
                  </div>
                  <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-xs text-slate-500">
                        Company and requester
                      </dt>
                      <dd className="mt-1 break-words">
                        <Link
                          href={partnerCompanyHref(selected.request.accountId)}
                          className="font-medium underline"
                        >
                          {selected.request.accountName}
                        </Link>
                        {selected.request.requesterName
                          ? ` · ${selected.request.requesterName}`
                          : ""}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-slate-500">Received</dt>
                      <dd className="mt-1">
                        {date(selected.request.receivedAt)}
                      </dd>
                    </div>
                    <div className="sm:col-span-2">
                      <dt className="text-xs text-slate-500">
                        Service address
                      </dt>
                      <dd className="mt-1 break-words">
                        {[selected.request.siteName, selected.request.address]
                          .filter(Boolean)
                          .join(" · ") || "Address needs review"}
                      </dd>
                    </div>
                    {selected.request.preferredWindows.length ? (
                      <div className="sm:col-span-2">
                        <dt className="text-xs text-slate-500">
                          Requested timing
                        </dt>
                        <dd className="mt-1 break-words">
                          {selected.request.preferredWindows
                            .map(
                              (window) =>
                                `${window.localDate} · ${window.timeOfDay === "anytime" ? "Any time" : window.timeOfDay}`,
                            )
                            .join("; ")}
                        </dd>
                      </div>
                    ) : null}
                  </dl>
                </header>
                {selected.request.kind === "service" ? (
                  <PartnerServiceReviews
                    key={selected.request.key}
                    embedded
                    requestId={selected.request.id}
                    accountId={selected.request.accountId}
                    includeScheduled
                    canSchedule={selected.request.canAct}
                    onReady={detailReady}
                    onChanged={() => void changed(true)}
                  />
                ) : selected.request.kind === "reschedule" ? (
                  <PartnerRescheduleReviews
                    key={selected.request.key}
                    embedded
                    requestId={selected.request.id}
                    accountId={selected.request.accountId}
                    canDecide={selected.request.canAct}
                    onChanged={() => void changed(true)}
                  />
                ) : selected.record ? (
                  <PartnerRequestDecisionPanel
                    key={`${selected.request.key}:${String(selected.record["revision"])}`}
                    item={selected.request}
                    details={selected.record}
                    onChanged={() => changed()}
                  />
                ) : (
                  <p role="alert">
                    The complete review details could not be loaded.{" "}
                    <Link
                      className="underline"
                      href={selected.request.detailHref as Route}
                    >
                      Open the existing review workspace
                    </Link>
                    .
                  </p>
                )}
              </>
            ) : null}
          </article>
        ) : null}
      </div>
    </section>
  );
}
