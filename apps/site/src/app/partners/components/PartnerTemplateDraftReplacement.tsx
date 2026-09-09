"use client";

import { useRef, useState } from "react";
import {
  createPortalOperationKey,
  partnerPortalFetch,
  type PartnerDraft,
} from "../lib/portal-v2";
import {
  PartnerNotice,
  partnerFieldClass,
  partnerSecondaryButtonClass,
} from "./PartnerPortalUi";

/** Updating a template snapshots only reusable fields; submitted work is untouched. */
export function PartnerTemplateDraftReplacement({
  templateId,
  etag,
  onSaved,
}: {
  templateId: string;
  etag: string;
  onSaved: () => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<PartnerDraft[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operation = useRef<{ fingerprint: string; key: string } | null>(null);
  async function load(next?: string) {
    setBusy(true);
    setError(null);
    const result = await partnerPortalFetch<{
      drafts: PartnerDraft[];
      page: { nextCursor: string | null };
    }>(
      `booking-drafts?limit=25${next ? `&cursor=${encodeURIComponent(next)}` : ""}`,
      { signal: AbortSignal.timeout(8_000) },
    ).catch(() => null);
    setBusy(false);
    if (!result?.ok) {
      setError("Saved requests could not be loaded. Please try again.");
      return;
    }
    setDrafts((current) =>
      next
        ? [
            ...new Map(
              [...current, ...result.data.drafts].map((draft) => [
                draft.id,
                draft,
              ]),
            ).values(),
          ]
        : result.data.drafts,
    );
    setCursor(result.data.page.nextCursor);
    setLoaded(true);
  }
  async function replace() {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    const fingerprint = `${selected}:${etag}`;
    if (operation.current?.fingerprint !== fingerprint)
      operation.current = {
        fingerprint,
        key: createPortalOperationKey("template-replace"),
      };
    const result = await partnerPortalFetch(`service-templates/${templateId}`, {
      method: "PATCH",
      signal: AbortSignal.timeout(10_000),
      headers: { "If-Match": etag, "Idempotency-Key": operation.current.key },
      body: JSON.stringify({ draftId: selected }),
    }).catch(() => null);
    setBusy(false);
    if (!result?.ok) {
      setError(
        result?.error.message ??
          "The change could not be confirmed. Retry safely to check its result.",
      );
      return;
    }
    setSelected("");
    operation.current = null;
    await onSaved();
  }
  return (
    <details
      className="w-full border-t border-slate-200 pt-2"
      onToggle={(event) => {
        if (event.currentTarget.open && !loaded && !busy) void load();
      }}
    >
      <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold">
        Replace saved details
      </summary>
      <p className="text-sm leading-6 text-slate-600">
        Edit an unfinished request, then choose it here to update this template.
        Existing jobs and recurring schedules stay unchanged. Photos, access
        codes, prices and payments are not copied.
      </p>
      {error ? <PartnerNotice tone="error">{error}</PartnerNotice> : null}
      <label className="mt-3 block text-sm">
        Use details from
        <select
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
          className={partnerFieldClass}
          disabled={busy}
        >
          <option value="">Choose a saved request</option>
          {drafts.map((draft) => (
            <option key={draft.id} value={draft.id}>
              {draft.description?.slice(0, 100) || "Untitled request"}
            </option>
          ))}
        </select>
      </label>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className={partnerSecondaryButtonClass}
          disabled={busy || !selected}
          onClick={() => void replace()}
        >
          {busy ? "Working…" : "Replace template details"}
        </button>
        {cursor ? (
          <button
            type="button"
            className={partnerSecondaryButtonClass}
            disabled={busy}
            onClick={() => void load(cursor)}
          >
            More saved requests
          </button>
        ) : null}
        {!loaded && !busy ? (
          <button
            type="button"
            className={partnerSecondaryButtonClass}
            onClick={() => void load()}
          >
            Retry loading
          </button>
        ) : null}
      </div>
    </details>
  );
}
