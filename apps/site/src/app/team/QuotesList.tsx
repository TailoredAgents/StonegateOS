"use client";

import { useMemo, useState } from "react";
import { SubmitButton } from "@/components/SubmitButton";
import { teamButtonClass } from "./components/team-ui";

type Quote = {
  id: string;
  status: string;
  services: string[];
  addOns: string[] | null;
  total: number;
  quoteNumber: string | null;
  displayStatus: string;
  jobDurationMinutes: number;
  clientScope: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  expiresAt: string | null;
  viewedAt: string | null;
  lastViewedAt: string | null;
  viewCount: number;
  decisionAt: string | null;
  decisionNotes: string | null;
  refreshRequestedAt: string | null;
  acceptedAppointmentId: string | null;
  shareToken: string | null;
  contact: { name: string; email: string | null };
  property: { addressLine1: string; city: string; state: string; postalCode: string };
};

type ServerAction = (formData: FormData) => void | Promise<void>;
type Bucket = "all" | "pending" | "approved" | "rejected";
type ViewFilter = "all" | "viewed" | "not_viewed";
type SortKey = "updated_desc" | "created_desc" | "total_desc" | "expires_asc";

const moneyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0
});

function fmtDate(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function fmtCurrency(value: number): string {
  return moneyFormatter.format(value);
}

function statusLabel(value: string): string {
  if (value === "declined" || value === "rejected") return "Rejected";
  if (value === "refresh_requested") return "Refresh requested";
  if (value === "pending") return "Ready to send";
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizedStatus(quote: Quote): string {
  return (quote.displayStatus || quote.status || "").trim().toLowerCase();
}

function quoteBucket(quote: Quote): Exclude<Bucket, "all"> {
  const status = normalizedStatus(quote);
  if (["accepted", "booked", "approved"].includes(status) || quote.acceptedAppointmentId) return "approved";
  if (["declined", "rejected", "expired"].includes(status)) return "rejected";
  return "pending";
}

function statusClass(quote: Quote): string {
  const bucket = quoteBucket(quote);
  const status = normalizedStatus(quote);
  if (bucket === "approved") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (bucket === "rejected") return "border-rose-200 bg-rose-50 text-rose-700";
  if (status === "pending") return "border-slate-200 bg-slate-100 text-slate-700";
  return "border-amber-200 bg-amber-50 text-amber-700";
}

function quoteSearchText(quote: Quote): string {
  return [
    quote.quoteNumber ?? "",
    quote.id,
    quote.contact.name,
    quote.contact.email ?? "",
    quote.property.addressLine1,
    quote.property.city,
    quote.property.state,
    quote.property.postalCode,
    quote.services.join(" "),
    fmtCurrency(quote.total)
  ]
    .join(" ")
    .toLowerCase();
}

function sortValue(value: string | null): number {
  if (!value) return 0;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function QuoteActions({
  quote,
  sendAction,
  decisionAction,
  deleteAction
}: {
  quote: Quote;
  sendAction: ServerAction;
  decisionAction: ServerAction;
  deleteAction: ServerAction;
}) {
  const bucket = quoteBucket(quote);
  const canSend = quote.status === "pending" || quote.status === "sent";

  return (
    <div className="flex flex-wrap items-center gap-2">
      {canSend ? (
        <form action={sendAction}>
          <input type="hidden" name="quoteId" value={quote.id} />
          <SubmitButton className={teamButtonClass("primary", "sm")} pendingLabel="Sending...">
            Send
          </SubmitButton>
        </form>
      ) : null}
      {bucket !== "approved" ? (
        <form action={decisionAction}>
          <input type="hidden" name="quoteId" value={quote.id} />
          <input type="hidden" name="decision" value="accepted" />
          <SubmitButton
            className="inline-flex items-center justify-center rounded-full border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
            pendingLabel="Saving..."
          >
            Approve
          </SubmitButton>
        </form>
      ) : null}
      {bucket !== "rejected" ? (
        <form action={decisionAction}>
          <input type="hidden" name="quoteId" value={quote.id} />
          <input type="hidden" name="decision" value="declined" />
          <SubmitButton
            className="inline-flex items-center justify-center rounded-full border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
            pendingLabel="Saving..."
          >
            Reject
          </SubmitButton>
        </form>
      ) : null}
      {quote.shareToken ? (
        <a
          href={`/quote/${quote.shareToken}?preview=1`}
          target="_blank"
          rel="noreferrer"
          className={teamButtonClass("secondary", "sm")}
        >
          Preview
        </a>
      ) : null}
      <form
        action={deleteAction}
        onSubmit={(event) => {
          if (!window.confirm("Delete this quote? This cannot be undone.")) {
            event.preventDefault();
          }
        }}
      >
        <input type="hidden" name="quoteId" value={quote.id} />
        <SubmitButton className={teamButtonClass("danger", "sm")} pendingLabel="Deleting...">
          Delete
        </SubmitButton>
      </form>
    </div>
  );
}

export function QuotesList({
  initial,
  sendAction,
  decisionAction,
  deleteAction
}: {
  initial: Quote[];
  sendAction: ServerAction;
  decisionAction: ServerAction;
  deleteAction: ServerAction;
}) {
  const [query, setQuery] = useState("");
  const [bucket, setBucket] = useState<Bucket>("all");
  const [exactStatus, setExactStatus] = useState("all");
  const [viewFilter, setViewFilter] = useState<ViewFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("updated_desc");

  const counts = useMemo(() => {
    return initial.reduce(
      (acc, quote) => {
        acc.all += 1;
        acc[quoteBucket(quote)] += 1;
        return acc;
      },
      { all: 0, pending: 0, approved: 0, rejected: 0 } satisfies Record<Bucket, number>
    );
  }, [initial]);

  const statusOptions = useMemo(() => {
    return Array.from(new Set(initial.map((quote) => normalizedStatus(quote)).filter(Boolean))).sort();
  }, [initial]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return initial
      .filter((quote) => {
        if (bucket !== "all" && quoteBucket(quote) !== bucket) return false;
        if (exactStatus !== "all" && normalizedStatus(quote) !== exactStatus) return false;
        if (viewFilter === "viewed" && !quote.viewedAt) return false;
        if (viewFilter === "not_viewed" && quote.viewedAt) return false;
        if (needle && !quoteSearchText(quote).includes(needle)) return false;
        return true;
      })
      .sort((a, b) => {
        if (sortKey === "created_desc") return sortValue(b.createdAt) - sortValue(a.createdAt);
        if (sortKey === "total_desc") return b.total - a.total;
        if (sortKey === "expires_asc") return sortValue(a.expiresAt) - sortValue(b.expiresAt);
        return sortValue(b.updatedAt) - sortValue(a.updatedAt);
      });
  }, [bucket, exactStatus, initial, query, sortKey, viewFilter]);

  const bucketButtons: Array<{ key: Bucket; label: string; helper: string }> = [
    { key: "all", label: "All quotes", helper: "Created and sent" },
    { key: "pending", label: "Pending approval", helper: "Waiting on customer" },
    { key: "approved", label: "Approved", helper: "Accepted or booked" },
    { key: "rejected", label: "Rejected", helper: "Declined or expired" }
  ];

  return (
    <section className="rounded-3xl border border-[color:var(--team-border)] bg-[color:var(--team-card)] p-4 text-[color:var(--team-text)] shadow-[0_24px_56px_var(--team-card-shadow)] sm:p-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary-600">Quote Management</p>
          <h3 className="text-lg font-semibold text-[color:var(--team-text)]">Global quote view</h3>
          <p className="mt-1 text-sm text-[color:var(--team-text-muted)]">
            Search every quote, filter by approval state, and take action without opening a separate screen.
          </p>
        </div>
        <p className="rounded-full border border-[color:var(--team-border)] bg-[color:var(--team-surface)] px-3 py-2 text-xs font-semibold text-[color:var(--team-text-muted)]">
          Showing {filtered.length} of {initial.length}
        </p>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-4">
        {bucketButtons.map((item) => {
          const active = bucket === item.key;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => setBucket(item.key)}
              className={`rounded-2xl border px-4 py-3 text-left transition ${
                active
                  ? "border-primary-300 bg-primary-50 text-primary-900 shadow-sm"
                  : "border-[color:var(--team-border)] bg-[color:var(--team-surface)] text-[color:var(--team-text)] hover:border-primary-200"
              }`}
            >
              <span className="block text-2xl font-semibold">{counts[item.key]}</span>
              <span className="mt-1 block text-sm font-semibold">{item.label}</span>
              <span className="mt-1 block text-xs text-[color:var(--team-text-soft)]">{item.helper}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-5 grid gap-3 lg:grid-cols-[minmax(260px,1fr)_180px_180px_180px]">
        <label className="flex flex-col gap-1 text-xs font-semibold text-[color:var(--team-text-muted)]">
          Search
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Name, quote #, address, service, amount"
            className="rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] px-4 py-3 text-sm font-normal text-[color:var(--team-text)] shadow-sm placeholder:text-[color:var(--team-text-soft)] focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-[color:var(--team-text-muted)]">
          Status
          <select
            value={exactStatus}
            onChange={(event) => setExactStatus(event.target.value)}
            className="rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] px-3 py-3 text-sm font-normal text-[color:var(--team-text)] shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
          >
            <option value="all">Any status</option>
            {statusOptions.map((status) => (
              <option key={status} value={status}>
                {statusLabel(status)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-[color:var(--team-text-muted)]">
          Viewed
          <select
            value={viewFilter}
            onChange={(event) => setViewFilter(event.target.value as ViewFilter)}
            className="rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] px-3 py-3 text-sm font-normal text-[color:var(--team-text)] shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
          >
            <option value="all">Any view state</option>
            <option value="viewed">Viewed</option>
            <option value="not_viewed">Not viewed</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-[color:var(--team-text-muted)]">
          Sort
          <select
            value={sortKey}
            onChange={(event) => setSortKey(event.target.value as SortKey)}
            className="rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] px-3 py-3 text-sm font-normal text-[color:var(--team-text)] shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
          >
            <option value="updated_desc">Recently updated</option>
            <option value="created_desc">Newest created</option>
            <option value="total_desc">Highest total</option>
            <option value="expires_asc">Expires soon</option>
          </select>
        </label>
      </div>

      {filtered.length === 0 ? (
        <p className="mt-5 rounded-2xl border border-dashed border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-5 text-sm text-[color:var(--team-text-soft)]">
          No quotes match those filters.
        </p>
      ) : (
        <>
          <div className="mt-5 hidden overflow-hidden rounded-2xl border border-[color:var(--team-border)] lg:block">
            <table className="min-w-full divide-y divide-[color:var(--team-border)] text-left text-sm">
              <thead className="bg-[color:var(--team-surface)] text-xs font-semibold uppercase tracking-wide text-[color:var(--team-text-muted)]">
                <tr>
                  <th className="px-4 py-3">Quote</th>
                  <th className="px-4 py-3">Client</th>
                  <th className="px-4 py-3">Value</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Activity</th>
                  <th className="px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--team-border)] bg-white">
                {filtered.map((quote) => (
                  <tr key={quote.id} className="align-top">
                    <td className="px-4 py-4">
                      <p className="font-semibold text-slate-950">{quote.quoteNumber ?? quote.id.slice(0, 8).toUpperCase()}</p>
                      <p className="mt-1 text-xs text-slate-500">{quote.services.join(", ") || "No services listed"}</p>
                      {quote.clientScope ? (
                        <p className="mt-2 line-clamp-2 max-w-xs text-xs text-slate-500">{quote.clientScope}</p>
                      ) : null}
                    </td>
                    <td className="px-4 py-4">
                      <p className="font-semibold text-slate-900">{quote.contact.name}</p>
                      <p className="mt-1 text-xs text-slate-500">{quote.contact.email ?? "No email"}</p>
                      <p className="mt-1 max-w-xs text-xs text-slate-500">
                        {quote.property.addressLine1}, {quote.property.city}, {quote.property.state} {quote.property.postalCode}
                      </p>
                    </td>
                    <td className="px-4 py-4 font-semibold text-slate-950">{fmtCurrency(quote.total)}</td>
                    <td className="px-4 py-4">
                      <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${statusClass(quote)}`}>
                        {statusLabel(normalizedStatus(quote))}
                      </span>
                    </td>
                    <td className="px-4 py-4 text-xs text-slate-500">
                      <p>Created {fmtDate(quote.createdAt)}</p>
                      <p className="mt-1">Sent {fmtDate(quote.sentAt)}</p>
                      <p className="mt-1">
                        {quote.viewedAt ? `${quote.viewCount} views, last ${fmtDate(quote.lastViewedAt)}` : "Not viewed"}
                      </p>
                      <p className="mt-1">Expires {fmtDate(quote.expiresAt)}</p>
                    </td>
                    <td className="px-4 py-4">
                      <QuoteActions
                        quote={quote}
                        sendAction={sendAction}
                        decisionAction={decisionAction}
                        deleteAction={deleteAction}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-5 space-y-3 lg:hidden">
            {filtered.map((quote) => (
              <article key={quote.id} className="rounded-2xl border border-[color:var(--team-border)] bg-white p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${statusClass(quote)}`}>
                      {statusLabel(normalizedStatus(quote))}
                    </span>
                    <h4 className="mt-3 text-base font-semibold text-slate-950">
                      {quote.quoteNumber ?? quote.id.slice(0, 8).toUpperCase()} - {quote.contact.name}
                    </h4>
                    <p className="mt-1 text-sm text-slate-600">
                      {quote.property.addressLine1}, {quote.property.city}
                    </p>
                  </div>
                  <p className="shrink-0 text-sm font-semibold text-slate-950">{fmtCurrency(quote.total)}</p>
                </div>
                <div className="mt-4 grid gap-2 text-xs text-slate-600 sm:grid-cols-2">
                  <p className="rounded-xl border border-slate-200 bg-slate-50 p-3">Sent: {fmtDate(quote.sentAt)}</p>
                  <p className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    Viewed: {quote.viewedAt ? `${quote.viewCount}x` : "No"}
                  </p>
                  <p className="rounded-xl border border-slate-200 bg-slate-50 p-3">Expires: {fmtDate(quote.expiresAt)}</p>
                  <p className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    Decision: {quote.decisionAt ? fmtDate(quote.decisionAt) : "Waiting"}
                  </p>
                </div>
                {quote.clientScope ? <p className="mt-3 line-clamp-3 text-sm text-slate-600">{quote.clientScope}</p> : null}
                <div className="mt-4">
                  <QuoteActions
                    quote={quote}
                    sendAction={sendAction}
                    decisionAction={decisionAction}
                    deleteAction={deleteAction}
                  />
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
