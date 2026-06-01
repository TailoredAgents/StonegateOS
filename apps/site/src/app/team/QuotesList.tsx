"use client";

import { useMemo, useState } from "react";
import { SubmitButton } from "@/components/SubmitButton";

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

function fmtDate(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function statusLabel(value: string): string {
  if (value === "rejected") return "Rejected";
  if (value === "refresh_requested") return "Refresh requested";
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function statusClass(value: string): string {
  if (value === "accepted" || value === "booked") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (value === "rejected" || value === "expired") return "border-rose-200 bg-rose-50 text-rose-700";
  if (value === "viewed" || value === "sent" || value === "refresh_requested") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-neutral-200 bg-neutral-100 text-neutral-600";
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
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>("all");

  const filtered = useMemo(() => {
    const hay = q.trim().toLowerCase();
    return initial.filter((it) => {
      if (status !== "all" && it.status !== status) return false;
      if (!hay) return true;
      const addr = `${it.property.addressLine1} ${it.property.city} ${it.property.state} ${it.property.postalCode}`.toLowerCase();
      return (
        it.contact.name.toLowerCase().includes(hay) ||
        addr.includes(hay) ||
        it.services.join(" ").toLowerCase().includes(hay)
      );
    });
  }, [initial, q, status]);

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name, address, service"
          className="min-w-[240px] flex-1 rounded-md border border-neutral-300 px-2 py-1 text-sm"
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-md border border-neutral-300 px-2 py-1 text-sm">
          <option value="all">All</option>
          <option value="pending">Draft</option>
          <option value="sent">Open / Sent</option>
          <option value="accepted">Accepted</option>
          <option value="declined">Rejected</option>
        </select>
      </div>
      {filtered.length === 0 ? (
        <p className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-4 text-sm text-neutral-500">No quotes found.</p>
      ) : (
        filtered.map((q) => (
          <article key={q.id} className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${statusClass(q.displayStatus)}`}>
                    {statusLabel(q.displayStatus)}
                  </span>
                  <p className="text-sm text-neutral-500">{q.quoteNumber ?? q.id.slice(0, 8).toUpperCase()} - {q.contact.name}</p>
                </div>
                <p className="text-sm text-neutral-700">{q.property.addressLine1}, {q.property.city}</p>
              </div>
              <p className="text-sm font-semibold text-primary-900">{q.total.toLocaleString("en-US", { style: "currency", currency: "USD" })}</p>
            </div>
            <div className="mt-3 grid gap-2 text-xs text-neutral-600 sm:grid-cols-4">
              <div className="rounded-md border border-neutral-200 bg-neutral-50 p-2">
                <div className="font-semibold text-neutral-500">Viewed</div>
                <div>{q.viewedAt ? `${q.viewCount}x, last ${fmtDate(q.lastViewedAt)}` : "Not viewed"}</div>
              </div>
              <div className="rounded-md border border-neutral-200 bg-neutral-50 p-2">
                <div className="font-semibold text-neutral-500">Valid until</div>
                <div>{fmtDate(q.expiresAt)}</div>
              </div>
              <div className="rounded-md border border-neutral-200 bg-neutral-50 p-2">
                <div className="font-semibold text-neutral-500">Decision</div>
                <div>{q.decisionAt ? fmtDate(q.decisionAt) : "Waiting"}</div>
              </div>
              <div className="rounded-md border border-neutral-200 bg-neutral-50 p-2">
                <div className="font-semibold text-neutral-500">Booking</div>
                <div>{q.acceptedAppointmentId ? "Booked" : q.refreshRequestedAt ? "Refresh requested" : `${Math.round(q.jobDurationMinutes / 60 * 10) / 10} hr`}</div>
              </div>
            </div>
            {q.clientScope ? <p className="mt-3 line-clamp-2 text-sm text-neutral-600">{q.clientScope}</p> : null}
            <div className="mt-3 flex flex-wrap gap-2">
              {(q.status === "pending" || q.status === "sent") ? (
                <form action={sendAction}>
                  <input type="hidden" name="quoteId" value={q.id} />
                  <SubmitButton className="rounded-md bg-accent-600 px-3 py-1 text-xs font-semibold text-white" pendingLabel="Sending...">Send</SubmitButton>
                </form>
              ) : null}
              <form action={decisionAction}>
                <input type="hidden" name="quoteId" value={q.id} />
                <input type="hidden" name="decision" value="accepted" />
                <SubmitButton className="rounded-md border border-emerald-400 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700" pendingLabel="Saving...">Mark accepted</SubmitButton>
              </form>
              <form action={decisionAction}>
                <input type="hidden" name="quoteId" value={q.id} />
                <input type="hidden" name="decision" value="declined" />
                <SubmitButton className="rounded-md border border-rose-400 bg-rose-50 px-3 py-1 text-xs font-semibold text-rose-700" pendingLabel="Saving...">Mark declined</SubmitButton>
              </form>
              <form
                action={deleteAction}
                onSubmit={(e) => {
                  if (!window.confirm("Delete this quote? This cannot be undone.")) {
                    e.preventDefault();
                  }
                }}
              >
                <input type="hidden" name="quoteId" value={q.id} />
                <SubmitButton className="rounded-md border border-neutral-300 bg-white px-3 py-1 text-xs font-semibold text-neutral-700" pendingLabel="Deleting...">
                  Delete
                </SubmitButton>
              </form>
              {q.shareToken ? (
                <a href={`/quote/${q.shareToken}?preview=1`} target="_blank" rel="noreferrer" className="rounded-md border border-neutral-300 px-3 py-1 text-xs text-neutral-700">Preview link</a>
              ) : null}
            </div>
          </article>
        ))
      )}
    </section>
  );
}
