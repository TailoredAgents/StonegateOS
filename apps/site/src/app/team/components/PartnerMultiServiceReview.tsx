"use client";
import { useEffect, useRef, useState } from "react";
import type { PartnerMultiServiceRequest } from "@myst-os/sdk";
import {
  formatPartnerServiceRate,
  multiplyPartnerRateToCents,
} from "@myst-os/pricing";
import {
  changePartnerServiceRequest,
  loadPartnerVisitResources,
} from "../actions/partner-multi-service";
import { previewPartnerServiceArrival } from "../actions/partner-service-reviews";
import { teamButtonClass } from "./team-ui";

const inputClass =
  "min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm";
const money = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );
const local = (value: string, timezone: string) =>
  new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(new Date(value));
type LinePrice = { amount: string; rateKey: string; quantity: string };

/** Staff-only pricing and actual visits. Shared client information stays in the main panel. */
export function PartnerMultiServiceReview({
  accountId,
  bookingId,
  data,
  preferredWindows,
  canEdit,
  canPrice = canEdit,
  onChanged,
  onEditing,
}: {
  accountId: string;
  bookingId: string;
  data: PartnerMultiServiceRequest;
  preferredWindows: { localDate: string; timeOfDay: string }[];
  canEdit: boolean;
  canPrice?: boolean;
  onChanged: () => void;
  onEditing?: () => void;
}) {
  const [prices, setPrices] = useState<Record<string, LinePrice>>(() =>
    Object.fromEntries(
      data.serviceLines.map((line) => [
        line.id,
        {
          amount:
            line.quotedAmountCents === null
              ? ""
              : (line.quotedAmountCents / 100).toFixed(2),
          rateKey: "",
          quantity: "",
        },
      ]),
    ),
  );
  const [pricingOpen, setPricingOpen] = useState(
      data.quotedTotalCents === null,
    ),
    [schedulingOpen, setSchedulingOpen] = useState(false);
  const [editingVisit, setEditingVisit] = useState<string | null>(null);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [openPrice, setOpenPrice] = useState(data.serviceLines[0]?.id ?? "");
  const [selected, setSelected] = useState<string[]>([]),
    [date, setDate] = useState(""),
    [time, setTime] = useState("09:00"),
    [duration, setDuration] = useState(""),
    [buffer, setBuffer] = useState("0");
  const [resourceIds, setResourceIds] = useState<string[]>([]),
    [resources, setResources] = useState<
      { id: string; label: string; kind: string }[]
    >([]),
    [resourceError, setResourceError] = useState("");
  const [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false),
    [arrival, setArrival] = useState<{
      startAt: string;
      arrivalStartAt: string;
      arrivalEndAt: string;
      timezone: string;
      selectionKey: string;
    } | null>(null),
    [arrivalError, setArrivalError] = useState("");
  const selectionKey = JSON.stringify([accountId, bookingId, date, time]);
  const validArrival = arrival?.selectionKey === selectionKey ? arrival : null;
  const pending = useRef<{ fingerprint: string; key: string } | null>(null),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function loadResources() {
    setResourceError("");
    const result = await loadPartnerVisitResources(accountId, bookingId).catch(
      () => ({
        ok: false as const,
        message: "Crew and equipment could not be loaded. Try again.",
      }),
    );
    if (!mounted.current) return;
    if (result.ok) setResources(result.resources);
    else setResourceError(result.message);
  }
  useEffect(() => {
    if (schedulingOpen) void loadResources();
  }, [schedulingOpen]);
  useEffect(() => {
    setArrival(null);
    setArrivalError("");
    if (!schedulingOpen || !date || !time) return;
    let current = true;
    void previewPartnerServiceArrival({
      id: bookingId,
      accountId,
      preferredDate: date,
      startTime: time,
    })
      .then((result) => {
        if (!current) return;
        if (result.ok) setArrival({ ...result, selectionKey });
        else setArrivalError(result.message);
      })
      .catch(() => {
        if (current)
          setArrivalError(
            "The arrival window could not be checked. Try again.",
          );
      });
    return () => {
      current = false;
    };
  }, [
    schedulingOpen,
    date,
    time,
    accountId,
    bookingId,
    selectionKey,
    previewAttempt,
  ]);
  async function save(
    action: "price" | "visits" | "visit-status" | "visit-reschedule",
    body: Record<string, unknown>,
    visitId?: string,
  ) {
    if (busy || saved) return;
    setBusy(true);
    setMessage("");
    const fingerprint = JSON.stringify({
      version: data.version,
      action,
      body,
      visitId,
    });
    if (!pending.current || pending.current.fingerprint !== fingerprint)
      pending.current = { fingerprint, key: crypto.randomUUID() };
    const result = await changePartnerServiceRequest({
      accountId,
      bookingId,
      version: data.version,
      key: pending.current.key,
      action,
      visitId,
      body,
    }).catch(() => ({
      ok: false as const,
      message:
        "The save could not be confirmed. Retry the same change or refresh to check its status.",
    }));
    if (!mounted.current) return;
    setBusy(false);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    setSaved(true);
    setMessage("Saved. Refreshing the request…");
    onChanged();
  }
  const activeLines = data.serviceLines.filter(
    (line) => !["completed", "canceled"].includes(line.status),
  );
  const changePrice = (id: string, patch: Partial<LinePrice>) =>
    setPrices((old) => ({ ...old, [id]: { ...old[id]!, ...patch } }));
  return (
    <div className="min-w-0 space-y-5" onChange={onEditing}>
      {message ? (
        <div
          role={saved ? "status" : "alert"}
          className={`rounded-lg p-3 text-sm ${saved ? "bg-teal-50 text-teal-950" : "bg-rose-50 text-rose-950"}`}
        >
          <p>{message}</p>
          {saved ? (
            <button
              type="button"
              onClick={onChanged}
              className="mt-2 min-h-11 underline"
            >
              Refresh details
            </button>
          ) : null}
        </div>
      ) : null}
      <section aria-label="Request pricing" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="font-semibold">Price review</h4>
          {data.quotedTotalCents !== null ? (
            <span className="font-semibold">
              {money(data.quotedTotalCents)}
            </span>
          ) : (
            <span className="text-sm text-amber-900">Price needed</span>
          )}
        </div>
        {canPrice && !saved ? (
          <button
            type="button"
            aria-expanded={pricingOpen}
            onClick={() => setPricingOpen(!pricingOpen)}
            className="min-h-11 text-sm font-semibold text-teal-800 underline"
          >
            {pricingOpen
              ? "Hide price details"
              : data.quotedTotalCents === null
                ? "Review service prices"
                : "Review or change price"}
          </button>
        ) : null}
        {pricingOpen && canPrice && !saved ? (
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const invalidLine = data.serviceLines.find(
                (line) =>
                  line.status !== "canceled" &&
                  (!prices[line.id]?.amount ||
                    !/^\d+(?:\.\d{1,2})?$/.test(prices[line.id]!.amount)),
              );
              if (invalidLine) {
                setOpenPrice(invalidLine.id);
                setMessage(`Enter a reviewed price for ${invalidLine.label}.`);
                return;
              }
              const rawNote = form.get("reason");
              const note = typeof rawNote === "string" ? rawNote.trim() : "";
              const manual = data.serviceLines.some(
                (line) =>
                  line.status !== "canceled" && !prices[line.id]?.rateKey,
              );
              if ((manual || note.length > 0) && note.length < 12) {
                setMessage("Add a brief note explaining the reviewed amounts.");
                return;
              }
              const linePrices = data.serviceLines
                .filter((line) => line.status !== "canceled")
                .map((line) => {
                  const price = prices[line.id]!;
                  return {
                    serviceLineId: line.id,
                    amountCents: Math.round(Number(price.amount) * 100),
                    description: line.label,
                    ...(price.rateKey && price.quantity
                      ? {
                          charges: [
                            {
                              rateKey: price.rateKey,
                              quantity: price.quantity,
                            },
                          ],
                        }
                      : {}),
                  };
                });
              void save("price", {
                linePrices,
                reason:
                  note ||
                  "Reviewed quantities using the company’s published rates.",
              });
            }}
            className="space-y-4"
          >
            {data.serviceLines
              .filter((line) => line.status !== "canceled")
              .map((line) => {
                const snapshot =
                  line.currentRateSnapshot ??
                  line.pricingSnapshot ??
                  line.rateSnapshot;
                const quoteRequired = snapshot?.status === "quote_required";
                const rates = snapshot?.rates ?? [],
                  price = prices[line.id]!;
                return (
                  <details
                    key={line.id}
                    open={openPrice === line.id}
                    onToggle={(event) => {
                      if (event.currentTarget.open) setOpenPrice(line.id);
                    }}
                    className="border-t border-slate-200 pt-2"
                  >
                    <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-3 text-sm font-semibold">
                      <span>{line.label}</span>
                      <span className="shrink-0 text-xs font-normal">
                        {!rates.length && !quoteRequired
                          ? "Rate not set yet"
                          : price.amount
                            ? money(Math.round(Number(price.amount) * 100))
                            : quoteRequired
                              ? "Quote required"
                              : "Price needed"}
                      </span>
                    </summary>
                    <fieldset
                      className="min-w-0 space-y-2 pb-3"
                      disabled={busy}
                    >
                      <legend className="sr-only">{line.label}</legend>
                      {!rates.length && !quoteRequired ? (
                        <p className="text-sm text-amber-900">
                          Rate not set yet.{" "}
                          <a
                            className="underline"
                            href={`/team/partners?p_company=${accountId}&p_admin=companies&p_company_section=settings`}
                          >
                            Set company rates
                          </a>{" "}
                          before confirming this price.
                        </p>
                      ) : (
                        <>
                          {quoteRequired ? (
                            <p className="text-sm text-slate-600">
                              Quote required. Enter the price reviewed for this
                              request and explain it in the price review note.
                            </p>
                          ) : (
                            <label className="block text-sm">
                              Agreed rate
                              <select
                                className={inputClass}
                                value={price.rateKey}
                                onChange={(event) => {
                                  const rate = rates.find(
                                    (item) => item.key === event.target.value,
                                  );
                                  let amount = price.amount;
                                  if (rate && price.quantity) {
                                    try {
                                      amount = (
                                        multiplyPartnerRateToCents(
                                          rate.unitAmount,
                                          price.quantity,
                                        ) / 100
                                      ).toFixed(2);
                                    } catch {
                                      amount = "";
                                    }
                                  }
                                  changePrice(line.id, {
                                    rateKey: event.target.value,
                                    amount,
                                  });
                                }}
                              >
                                <option value="">Enter reviewed amount</option>
                                {rates.map((rate) => (
                                  <option key={rate.key} value={rate.key}>
                                    {formatPartnerServiceRate(
                                      rate,
                                      snapshot?.currency ?? "USD",
                                    )}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                          {price.rateKey ? (
                            <label className="block text-sm">
                              Reviewed quantity
                              <input
                                className={inputClass}
                                inputMode="decimal"
                                required
                                value={price.quantity}
                                onChange={(event) => {
                                  const rate = rates.find(
                                    (item) => item.key === price.rateKey,
                                  )!;
                                  let amount = "";
                                  try {
                                    amount = (
                                      multiplyPartnerRateToCents(
                                        rate.unitAmount,
                                        event.target.value,
                                      ) / 100
                                    ).toFixed(2);
                                  } catch {
                                    // Incomplete quantities leave the reviewed amount blank.
                                  }
                                  changePrice(line.id, {
                                    quantity: event.target.value,
                                    amount,
                                  });
                                }}
                              />
                            </label>
                          ) : null}
                          <label className="block text-sm">
                            Service total ($)
                            <input
                              className={inputClass}
                              type="number"
                              min="0"
                              step="0.01"
                              required
                              value={price.amount}
                              readOnly={Boolean(price.rateKey)}
                              onChange={(event) =>
                                changePrice(line.id, {
                                  amount: event.target.value,
                                })
                              }
                            />
                          </label>
                        </>
                      )}
                    </fieldset>
                  </details>
                );
              })}
            <label className="block text-sm">
              Price review note
              <textarea
                name="reason"
                minLength={12}
                maxLength={1000}
                rows={2}
                className={inputClass}
                placeholder="Confirm quantities, included work, and any adjustments."
              />
            </label>
            <p className="text-xs leading-5 text-slate-600">
              One minimum applies to each visit’s total. Included hauloff and
              painting should not be charged again.
            </p>
            <button
              className={teamButtonClass("primary", "sm")}
              disabled={
                busy ||
                data.serviceLines.some((line) => {
                  const snapshot =
                    line.currentRateSnapshot ??
                    line.pricingSnapshot ??
                    line.rateSnapshot;
                  return (
                    line.status !== "canceled" &&
                    !snapshot?.rates.length &&
                    snapshot?.status !== "quote_required"
                  );
                })
              }
            >
              Confirm price
            </button>
          </form>
        ) : null}
      </section>
      <section
        className="space-y-3 border-t border-slate-200 pt-4"
        aria-label="Scheduled visits"
      >
        <h4 className="font-semibold">Visits</h4>
        {data.visits.length ? (
          <ul className="space-y-3">
            {data.visits.map((visit, index) => (
              <li
                key={visit.id}
                className="rounded-lg border border-slate-200 p-3 text-sm"
              >
                <div className="flex flex-wrap justify-between gap-2">
                  <strong>Visit {index + 1}</strong>
                  <span>{visit.status.replaceAll("_", " ")}</span>
                </div>
                <p className="mt-1">{local(visit.startAt, visit.timezone)}</p>
                <p className="mt-1 text-slate-600">
                  {data.serviceLines
                    .filter((line) => visit.serviceLineIds.includes(line.id))
                    .map((line) => line.label)
                    .join(", ")}
                </p>
                {visit.arrivalStartAt && visit.arrivalEndAt ? (
                  <p className="mt-2 text-xs">
                    Arrival: {local(visit.arrivalStartAt, visit.timezone)} –{" "}
                    {new Intl.DateTimeFormat("en-US", {
                      timeStyle: "short",
                      timeZone: visit.timezone,
                    }).format(new Date(visit.arrivalEndAt))}
                  </p>
                ) : null}
                {canEdit &&
                !saved &&
                !["completed", "canceled"].includes(visit.status) ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer py-2 font-medium">
                      Update this visit
                    </summary>
                    {visit.status === "scheduled" ? (
                      <button
                        type="button"
                        className="min-h-11 text-sm font-semibold text-teal-800 underline"
                        onClick={() => {
                          setEditingVisit(visit.id);
                          setSelected(visit.serviceLineIds);
                          setDate(
                            new Intl.DateTimeFormat("en-CA", {
                              year: "numeric",
                              month: "2-digit",
                              day: "2-digit",
                              timeZone: visit.timezone,
                            }).format(new Date(visit.startAt)),
                          );
                          setTime(
                            new Intl.DateTimeFormat("en-GB", {
                              hour: "2-digit",
                              minute: "2-digit",
                              hourCycle: "h23",
                              timeZone: visit.timezone,
                            }).format(new Date(visit.startAt)),
                          );
                          setDuration(
                            visit.endAt
                              ? String(
                                  (Date.parse(visit.endAt) -
                                    Date.parse(visit.startAt)) /
                                    60000,
                                )
                              : "",
                          );
                          setSchedulingOpen(true);
                        }}
                      >
                        Change date or time
                      </button>
                    ) : null}
                    <form
                      className="space-y-3"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const form = new FormData(event.currentTarget);
                        void save(
                          "visit-status",
                          {
                            status: form.get("status"),
                            completedServiceLineIds:
                              form.getAll("completedLine"),
                          },
                          visit.id,
                        );
                      }}
                    >
                      <label className="block">
                        Visit status
                        <select
                          name="status"
                          className={inputClass}
                          defaultValue="completed"
                        >
                          <option value="in_progress">In progress</option>
                          <option value="completed">Visit completed</option>
                          <option value="canceled">Cancel visit</option>
                        </select>
                      </label>
                      <fieldset>
                        <legend className="text-xs text-slate-600">
                          Mark only fully finished services
                        </legend>
                        {data.serviceLines
                          .filter(
                            (line) =>
                              visit.serviceLineIds.includes(line.id) &&
                              line.status !== "completed",
                          )
                          .map((line) => (
                            <label
                              key={line.id}
                              className="flex min-h-11 items-center gap-2"
                            >
                              <input
                                type="checkbox"
                                name="completedLine"
                                value={line.id}
                                className="h-4 w-4"
                              />
                              {line.label}
                            </label>
                          ))}
                      </fieldset>
                      <button
                        className={teamButtonClass("secondary", "sm")}
                        disabled={busy}
                      >
                        Save visit update
                      </button>
                    </form>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-600">No visits confirmed yet.</p>
        )}
        {canEdit && activeLines.length && !saved ? (
          <button
            type="button"
            className={teamButtonClass("secondary", "sm")}
            onClick={() => {
              setEditingVisit(null);
              setSchedulingOpen(!schedulingOpen);
              if (!selected.length)
                setSelected(activeLines.map((line) => line.id));
            }}
            aria-expanded={schedulingOpen}
          >
            {schedulingOpen ? "Close scheduling" : "Schedule a visit"}
          </button>
        ) : null}
        {schedulingOpen && !saved ? (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!validArrival) return;
              void save(
                editingVisit ? "visit-reschedule" : "visits",
                {
                  serviceLineIds: selected,
                  date,
                  startTime: time,
                  durationMinutes: Number(duration),
                  travelBufferMinutes: Number(buffer),
                  resourceIds,
                },
                editingVisit ?? undefined,
              );
            }}
          >
            <fieldset disabled={busy || Boolean(editingVisit)}>
              <legend className="text-sm font-medium">
                Work for this visit
              </legend>
              {activeLines.map((line) => (
                <label
                  key={line.id}
                  className="flex min-h-11 items-center gap-2 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(line.id)}
                    onChange={(event) =>
                      setSelected((old) =>
                        event.target.checked
                          ? [...old, line.id]
                          : old.filter((id) => id !== line.id),
                      )
                    }
                    className="h-4 w-4"
                  />
                  {line.label}
                </label>
              ))}
            </fieldset>
            {preferredWindows.length ? (
              <div className="space-y-2 text-sm">
                <p className="font-medium">Client’s preferred dates</p>
                {preferredWindows.map((window, index) => (
                  <button
                    key={index}
                    type="button"
                    className="min-h-11 w-full rounded-lg border border-slate-200 px-3 py-2 text-left"
                    onClick={() => setDate(window.localDate)}
                  >
                    {new Intl.DateTimeFormat("en-US", {
                      dateStyle: "medium",
                      timeZone: "UTC",
                    }).format(new Date(`${window.localDate}T12:00:00Z`))}{" "}
                    ·{" "}
                    {window.timeOfDay === "anytime"
                      ? "Any time"
                      : window.timeOfDay}
                  </button>
                ))}
              </div>
            ) : null}
            <label className="block text-sm">
              Visit date
              <input
                required
                type="date"
                className={inputClass}
                value={date}
                onChange={(event) => setDate(event.target.value)}
              />
            </label>
            <label className="block text-sm">
              Start time (Eastern)
              <select
                className={inputClass}
                value={time}
                onChange={(event) => setTime(event.target.value)}
              >
                {Array.from({ length: 48 }, (_, index) => {
                  const hour = Math.floor(index / 2),
                    minute = index % 2 ? "30" : "00",
                    value = `${String(hour).padStart(2, "0")}:${minute}`;
                  return (
                    <option key={value} value={value}>
                      {hour % 12 || 12}:{minute} {hour < 12 ? "AM" : "PM"}
                    </option>
                  );
                })}
              </select>
            </label>
            <label className="block text-sm">
              Work duration (minutes)
              <input
                type="number"
                required
                min="30"
                step="15"
                max="1440"
                className={inputClass}
                value={duration}
                onChange={(event) => setDuration(event.target.value)}
              />
            </label>
            <details>
              <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">
                Crew, truck and equipment
              </summary>
              {resourceError ? (
                <p role="alert" className="text-sm text-rose-800">
                  {resourceError}
                  <button
                    type="button"
                    className="ml-2 min-h-11 underline"
                    onClick={() => void loadResources()}
                  >
                    Retry
                  </button>
                </p>
              ) : null}
              {resources.map((resource) => (
                <label
                  key={resource.id}
                  className="flex min-h-11 items-center gap-2 text-sm"
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={resourceIds.includes(resource.id)}
                    onChange={(event) =>
                      setResourceIds((old) =>
                        event.target.checked
                          ? [...old, resource.id]
                          : old.filter((id) => id !== resource.id),
                      )
                    }
                  />
                  {resource.label} · {resource.kind}
                </label>
              ))}
              <label className="block text-sm">
                Travel buffer (minutes)
                <input
                  type="number"
                  min="0"
                  max="240"
                  step="5"
                  className={inputClass}
                  value={buffer}
                  onChange={(event) => setBuffer(event.target.value)}
                />
              </label>
            </details>
            {validArrival ? (
              <div className="rounded-lg bg-slate-50 p-3 text-sm">
                <strong>Confirm this arrival window</strong>
                <p className="mt-1">
                  {local(validArrival.arrivalStartAt, validArrival.timezone)} –{" "}
                  {new Intl.DateTimeFormat("en-US", {
                    timeStyle: "short",
                    timeZone: validArrival.timezone,
                  }).format(new Date(validArrival.arrivalEndAt))}
                </p>
              </div>
            ) : arrivalError ? (
              <p role="alert" className="text-sm text-rose-800">
                {arrivalError}{" "}
                <button
                  type="button"
                  className="min-h-11 underline"
                  onClick={() => setPreviewAttempt((value) => value + 1)}
                >
                  Retry
                </button>
              </p>
            ) : date ? (
              <p role="status" className="text-sm">
                Checking arrival window…
              </p>
            ) : null}
            <button
              className={teamButtonClass("primary", "sm")}
              disabled={
                busy ||
                !validArrival ||
                !selected.length ||
                data.quotedTotalCents === null
              }
            >
              {editingVisit ? "Confirm new schedule" : "Confirm service"}
            </button>
            {data.quotedTotalCents === null ? (
              <p className="text-sm text-amber-900">
                Confirm the service prices before scheduling.
              </p>
            ) : null}
          </form>
        ) : null}
      </section>
    </div>
  );
}
