"use client";

import { useEffect, useRef, useState } from "react";
import { formEntryText } from "@/lib/form-entry-text";
import { StaffScheduleResourcePicker } from "./StaffScheduleResourcePicker";
import {
  loadPartnerRescheduleReviews,
  decidePartnerRescheduleReview,
  type RescheduleReview,
  type RescheduleReviewDetail,
} from "../actions/partner-reschedule-reviews";

const FIELD =
  "mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base text-slate-900";
const BUTTON =
  "inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-primary-900 disabled:opacity-50";
function windowLabel(
  start: string | null | undefined,
  end: string | null | undefined,
  timezone = "America/New_York",
) {
  if (!start || !end) return "No confirmed window";
  const format = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  });
  return `${format.format(new Date(start))} – ${format.format(new Date(end))}`;
}

export function PartnerRescheduleReviews({
  canDecide,
  accountId,
  requestId,
  embedded = false,
  onReady,
  onChanged,
}: {
  canDecide: boolean;
  accountId?: string;
  requestId?: string;
  embedded?: boolean;
  onReady?: () => void;
  onChanged?: () => void;
}) {
  const [items, setItems] = useState<RescheduleReview[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  const [detail, setDetail] = useState<RescheduleReviewDetail | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const selected = useRef("");
  const generation = useRef(0);
  const pendingDecision = useRef<{ fingerprint: string; key: string } | null>(
    null,
  );
  async function load(more = false) {
    const requestGeneration = ++generation.current;
    setBusy(true);
    setMessage("");
    const result = await loadPartnerRescheduleReviews({
      accountId,
      ...(more && cursor ? { cursor } : {}),
    }).catch(() => ({
      ok: false as const,
      message: "The requests could not be loaded. Try again.",
    }));
    if (requestGeneration !== generation.current) return;
    setBusy(false);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    setItems((current) =>
      more ? [...current, ...result.items] : result.items,
    );
    setCursor(result.nextCursor);
  }
  useEffect(() => {
    setItems([]);
    setCursor(null);
    setDetail(null);
    selected.current = "";
    pendingDecision.current = null;
    if (requestId) void open(requestId);
    else void load();
    return () => {
      generation.current += 1;
    };
  }, [accountId, requestId]);
  useEffect(() => {
    if (detail) onReady?.();
  }, [detail]);
  async function open(id: string) {
    const requestGeneration = ++generation.current;
    selected.current = id;
    setDetail(null);
    setBusy(true);
    setMessage("");
    pendingDecision.current = null;
    const result = await loadPartnerRescheduleReviews({ id, accountId }).catch(
      () => ({
        ok: false as const,
        message: "This request could not be loaded. Try again.",
      }),
    );
    if (selected.current !== id || requestGeneration !== generation.current)
      return;
    setBusy(false);
    if (!result.ok) setMessage(result.message);
    else setDetail(result.detail);
  }
  async function decide(
    form: HTMLFormElement,
    decision: "accepted" | "declined",
  ) {
    if (
      !detail ||
      busy ||
      !form.reportValidity() ||
      (accountId && detail.request.accountId !== accountId)
    )
      return;
    const data = new FormData(form),
      startAt = formEntryText(data.get("startAt")),
      reason = formEntryText(data.get("reason"));
    if (decision === "accepted" && !startAt) {
      setMessage("Choose a replacement window before accepting.");
      return;
    }
    const selectedResourceIds = data
      .getAll("selectedResourceIds")
      .map(formEntryText);
    if (
      decision === "accepted" &&
      data.get("resourceSelectionMode") === "manual" &&
      !selectedResourceIds.length
    ) {
      setMessage(
        "Select the required resources or turn off specific selection.",
      );
      return;
    }
    const payload = {
      ...(accountId ? { accountId } : {}),
      id: detail.request.id,
      version: detail.request.updatedAt,
      decision,
      reason,
      ...(decision === "accepted" ? { startAt, selectedResourceIds } : {}),
    };
    const fingerprint = JSON.stringify(payload);
    if (
      !pendingDecision.current ||
      pendingDecision.current.fingerprint !== fingerprint
    )
      pendingDecision.current = {
        fingerprint,
        key: `reschedule-review:${crypto.randomUUID()}`,
      };
    setBusy(true);
    const requestGeneration = ++generation.current;
    const result = await decidePartnerRescheduleReview({
      ...payload,
      key: pendingDecision.current.key,
    }).catch(() => ({
      ok: false,
      message: "The result could not be confirmed. Retry this same decision.",
    }));
    if (requestGeneration !== generation.current) return;
    setBusy(false);
    setMessage(result.message);
    if (result.ok) {
      pendingDecision.current = null;
      onChanged?.();
      if (requestId) await open(requestId);
      else {
        setDetail(null);
        await load();
      }
    }
  }
  return (
    <section
      className={
        embedded
          ? "min-w-0 space-y-4"
          : "space-y-4 rounded-xl border border-slate-200 bg-white p-5"
      }
    >
      {!embedded ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-slate-950">
              Schedule-change reviews
            </h2>
            <button
              type="button"
              className={BUTTON}
              disabled={busy}
              onClick={() => void load()}
            >
              Refresh requests
            </button>
          </div>
          <p className="text-sm leading-6 text-slate-600">
            The original job remains scheduled until you accept a feasible
            replacement.
          </p>
          {message ? (
            <p
              role="status"
              className="rounded-lg border border-slate-200 p-3 text-sm"
            >
              {message}
            </p>
          ) : null}
          {busy ? (
            <p role="status" className="text-sm">
              Loading…
            </p>
          ) : null}
          <ul className="divide-y divide-slate-200">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void open(item.id)}
                  className="min-h-11 py-3 text-left text-sm font-semibold text-primary-900"
                >
                  Request from{" "}
                  {new Intl.DateTimeFormat("en-US", {
                    dateStyle: "medium",
                    timeZone: "America/New_York",
                  }).format(new Date(item.createdAt))}{" "}
                  ·{" "}
                  {item.preferredWindows
                    .map(
                      (window) =>
                        `${window.localDate} ${window.timeOfDay ?? ""}`,
                    )
                    .join(", ") || "Selected arrival window"}
                </button>
              </li>
            ))}
          </ul>
          {!busy && !items.length && !message ? (
            <p className="text-sm text-slate-600">
              No pending schedule-change requests.
            </p>
          ) : null}
          {cursor ? (
            <button
              type="button"
              disabled={busy}
              className={BUTTON}
              onClick={() => void load(true)}
            >
              Load older requests
            </button>
          ) : null}
        </>
      ) : null}
      {embedded && busy ? <p role="status">Loading schedule details…</p> : null}
      {embedded && message ? (
        <p role="status">
          {message}{" "}
          <button
            type="button"
            disabled={busy}
            onClick={() => requestId && void open(requestId)}
            className={BUTTON}
          >
            Refresh request
          </button>
        </p>
      ) : null}
      {detail ? (
        <div
          key={detail.request.id}
          className="space-y-3 border-t border-slate-200 pt-4"
        >
          <h3 className="font-semibold">
            {detail.request.siteName || "Service request"}
          </h3>
          <p className="text-sm">
            Current:{" "}
            {windowLabel(
              detail.request.previousArrivalStartAt,
              detail.request.previousArrivalEndAt,
              detail.request.timezone,
            )}
          </p>
          {detail.warning ? (
            <p role="status" className="text-sm text-amber-900">
              {detail.warning}
            </p>
          ) : null}
          {canDecide && detail.request.state === "pending" ? (
            <form
              method="post"
              onSubmit={(event) => event.preventDefault()}
              className="space-y-3"
            >
              <label className="block text-sm font-semibold">
                Replacement arrival window
                <select name="startAt" className={FIELD} disabled={busy}>
                  <option value="">Choose a current window</option>
                  {detail.candidates.map((slot) => (
                    <option key={slot.startAt} value={slot.startAt}>
                      {windowLabel(
                        slot.windowStartAt,
                        slot.windowEndAt,
                        detail.request.timezone,
                      )}{" "}
                      · planned start{" "}
                      {new Intl.DateTimeFormat("en-US", {
                        timeStyle: "short",
                        timeZone: detail.request.timezone ?? "America/New_York",
                      }).format(new Date(slot.startAt))}
                    </option>
                  ))}
                </select>
              </label>
              {detail.request.appointmentId ? (
                <StaffScheduleResourcePicker
                  key={detail.request.appointmentId}
                  appointmentId={detail.request.appointmentId}
                  disabled={busy}
                />
              ) : null}
              <label className="block text-sm font-semibold">
                Decision reason
                <textarea
                  name="reason"
                  required
                  minLength={12}
                  maxLength={1000}
                  className={FIELD}
                  disabled={busy}
                />
              </label>
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  className={BUTTON}
                  disabled={busy || !detail.candidates.length}
                  onClick={(event) =>
                    void decide(event.currentTarget.form!, "accepted")
                  }
                >
                  Accept replacement
                </button>
                <button
                  type="button"
                  className={BUTTON}
                  disabled={busy}
                  onClick={(event) =>
                    void decide(event.currentTarget.form!, "declined")
                  }
                >
                  Decline — keep original
                </button>
              </div>
            </form>
          ) : (
            <p className="text-sm">
              {detail.request.state === "pending"
                ? "Your role can review, but cannot decide."
                : `This request is ${detail.request.state}.`}
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}
