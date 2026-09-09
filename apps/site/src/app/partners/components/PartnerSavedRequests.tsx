"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { createPortalOperationKey, partnerPortalFetch, type PartnerDraft } from "../lib/portal-v2";
import { PartnerNotice, partnerSecondaryButtonClass } from "./PartnerPortalUi";

export function PartnerSavedRequests({ currentDraftId, canDiscard }: { currentDraftId?: string; canDiscard: boolean }) {
  const [drafts, setDrafts] = useState<PartnerDraft[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const discardKeys = useRef(new Map<string, string>());
  const load = async (next?: string) => {
    setBusy(true); setError(null);
    const result = await partnerPortalFetch<{ ok: true; drafts: PartnerDraft[]; page: { nextCursor: string | null } }>(`booking-drafts?limit=10${next ? `&cursor=${encodeURIComponent(next)}` : ""}`);
    setBusy(false);
    if (!result.ok) { setError(result.error.message); return; }
    if (!Array.isArray(result.data.drafts) || !result.data.page) { setError("Saved requests could not be loaded. Try again shortly."); return; }
    setDrafts((current) => next ? [...current, ...result.data.drafts] : result.data.drafts);
    setCursor(result.data.page.nextCursor);
  };
  useEffect(() => { void load(); }, []);
  const discard = async (draft: PartnerDraft) => {
    if (!window.confirm("Discard this unfinished request? Submitted jobs are not affected.")) return;
    setBusy(true); setError(null);
    const key = discardKeys.current.get(draft.id) ?? createPortalOperationKey("draft-discard");
    discardKeys.current.set(draft.id, key);
    const result = await partnerPortalFetch(`booking-drafts/${draft.id}`, { method: "DELETE", headers: { "If-Match": draft.etag, "Idempotency-Key": key } });
    setBusy(false);
    if (!result.ok) { setError(result.error.message); return; }
    setDrafts((current) => current.filter((item) => item.id !== draft.id));
  };
  const visible = drafts.filter((item) => item.id !== currentDraftId);
  if (!visible.length && !error && !cursor) return null;
  return <details className="rounded-xl border border-slate-200 bg-white p-4"><summary className="min-h-11 cursor-pointer font-semibold text-slate-800">Unfinished requests</summary>{error ? <PartnerNotice tone="error">{error}</PartnerNotice> : null}<ul className="divide-y divide-slate-200">{visible.map((draft) => <li key={draft.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><Link href={`/partners/book?draftId=${draft.id}`} className="min-h-11 max-w-full flex-1 truncate py-3 font-medium text-primary-800 underline">{draft.description?.slice(0, 90) || "Untitled request"}</Link>{canDiscard ? <button type="button" className={partnerSecondaryButtonClass} disabled={busy} onClick={() => void discard(draft)}>Discard</button> : null}</li>)}</ul>{cursor ? <button type="button" className={partnerSecondaryButtonClass} disabled={busy} onClick={() => void load(cursor)}>More saved requests</button> : null}</details>;
}
