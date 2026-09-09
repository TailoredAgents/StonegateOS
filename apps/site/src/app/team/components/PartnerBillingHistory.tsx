"use client";
import { useRef, useState } from "react";
import { loadPartnerBillingHistory, type BillingHistoryItem, type BillingHistoryKind } from "../actions/partner-billing";

const BUTTON = "min-h-11 rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:opacity-50";
const money = (value: number, currency: string) => new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value / 100);
const when = (value: string) => new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short",
}).format(new Date(value));

export function PartnerBillingHistory({ accountId, invoiceId, kind, currency, download }: {
  accountId: string; invoiceId: string; kind: BillingHistoryKind; currency: string; download: (documentId: string) => Promise<void>;
}) {
  const [items, setItems] = useState<BillingHistoryItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const label = kind === "documents" ? "Document history" : "Refund history";
  async function load(older = false) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await loadPartnerBillingHistory(accountId, invoiceId, kind, older && cursor ? cursor : undefined);
      if (!result.ok) { setError(result.message); return; }
      setItems((current) => [...new Map([...(older ? current : []), ...result.data.items].map((row) => [row.id, row])).values()]);
      setCursor(result.data.nextCursor);
      setLoaded(true);
    } catch {
      setError("History could not be loaded. Your current records are unchanged; try again.");
    } finally { inFlight.current = false; setBusy(false); }
  }
  return <section aria-label={label} className="space-y-3" aria-busy={busy}>
    <h5 className="text-sm font-semibold">{label}</h5>
    <p className="text-sm text-slate-600">{loaded
      ? `${items.length} records loaded, newest first. Times shown in Eastern time.`
      : "Load this invoice’s history, including older records."}</p>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {loaded && items.length === 0 && <p className="text-sm text-slate-600">No {kind === "documents" ? "documents" : "refund requests"} recorded for this invoice.</p>}
    {items.length > 0 && <ul className="divide-y divide-slate-100 text-sm">
      {items.map((item) => <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
        <div>
          <p>{"kind" in item ? item.kind.replaceAll("_", " ") : `Refund ${money(item.amountCents, currency)}`} · {item.status.replaceAll("_", " ")}</p>
          <time dateTime={item.createdAt} className="text-slate-600">{when(item.createdAt)}</time>
        </div>
        {"documentId" in item && item.documentId && <button className={BUTTON} type="button" onClick={() => void download(item.documentId!)}>Download {item.kind.replaceAll("_", " ")}</button>}
      </li>)}
    </ul>}
    <div className="flex flex-wrap gap-2">
      {!loaded && <button className={BUTTON} type="button" disabled={busy} onClick={() => void load()}>{busy ? "Loading history…" : error ? "Retry history" : `View ${label.toLowerCase()}`}</button>}
      {loaded && cursor && <button className={BUTTON} type="button" disabled={busy} onClick={() => void load(true)}>{busy ? "Loading history…" : error ? "Retry older records" : "Load older records"}</button>}
      {loaded && <button className={BUTTON} type="button" disabled={busy} onClick={() => void load()}>Refresh history</button>}
    </div>
    <p role="status" aria-live="polite" className="sr-only">{busy ? "Loading history" : loaded ? `${items.length} records loaded${cursor ? "; more records available" : "; end of history"}.` : "History has not been loaded."}</p>
    {loaded && !cursor && items.length > 0 && <p className="text-sm text-slate-600">End of history.</p>}
  </section>;
}
