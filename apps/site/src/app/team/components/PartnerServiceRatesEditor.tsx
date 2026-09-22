"use client";

import * as React from "react";
import {
  PARTNER_SERVICE_DEFINITIONS,
  PARTNER_SERVICE_RATE_UNIT_LABELS,
  PartnerServiceRateCardInputSchema,
  type PartnerServiceRateDraft,
  type PartnerServiceRateEditorData,
} from "@myst-os/pricing";
import {
  loadPartnerServiceRates,
  savePartnerServiceRates,
} from "../actions/partner-service-rates";

const FIELD =
  "mt-1 block min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base font-normal text-slate-900";
const BUTTON =
  "inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 disabled:opacity-50";
type Rate = PartnerServiceRateDraft["rates"][number];
const RATE_FIELD_LABELS: Record<string, string> = {
  label: "Rate name",
  unit: "Price per",
  unitAmount: "Rate (USD)",
  measurement: "What this rate covers",
  fullLoadCubicYards: "Full-load capacity",
  roomMaxSquareFeet: "Maximum room floor area",
  roomMaxHeightFeet: "Maximum ceiling height",
  materials: "Who supplies materials?",
  coats: "Included coats",
  inclusions: "Included work",
  exclusions: "Exclusions",
};
function blankRate(serviceKey: string, variantKey: string, suffix = ""): Rate {
  const service = PARTNER_SERVICE_DEFINITIONS.find(
    (entry) => entry.key === serviceKey,
  )!;
  const variant = service.variants.find((entry) => entry.key === variantKey)!;
  return {
    key: `${serviceKey}_${variantKey}${suffix}`,
    serviceKey,
    variantKey,
    label: service.variants.length > 1 ? variant.label : service.label,
    unit: "job",
    unitAmount: "",
    measurement: "",
    inclusions: [...service.inclusions],
    exclusions: [],
    materials: null,
    coats: null,
    fullLoadCubicYards: null,
    roomMaxSquareFeet: null,
    roomMaxHeightFeet: null,
  };
}
function editorCard(
  data: PartnerServiceRateEditorData,
): PartnerServiceRateDraft {
  const saved =
    data.draft ??
    (data.published?.source === "structured"
      ? {
          currency: data.published.currency,
          visitMinimum: data.published.visitMinimum,
          effectiveFrom: data.published.effectiveFrom,
          effectiveTo: data.published.effectiveTo,
          rates: data.published.rates,
        }
      : {
          currency: "USD",
          visitMinimum: null,
          effectiveFrom: new Date().toISOString(),
          effectiveTo: null,
          rates: [],
        });
  const rates = [...saved.rates];
  for (const service of PARTNER_SERVICE_DEFINITIONS)
    for (const variant of service.variants)
      if (
        !rates.some(
          (rate) =>
            rate.serviceKey === service.key && rate.variantKey === variant.key,
        )
      )
        rates.push(blankRate(service.key, variant.key));
  return { ...saved, rates };
}
const lines = (value: string) => value.split("\n");
const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const easternDate = (value: string) => {
  const parts = dateFormatter.formatToParts(new Date(value));
  return ["year", "month", "day"]
    .map((name) => parts.find((part) => part.type === name)?.value ?? "")
    .join("-");
};
const dateIso = (value: string) => {
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    hourCycle: "h23",
  });
  for (const utcHour of ["04", "05"]) {
    const candidate = `${value}T${utcHour}:00:00.000Z`;
    if (
      easternDate(candidate) === value &&
      hour.format(new Date(candidate)) === "00"
    )
      return candidate;
  }
  throw new Error("Unsupported effective date");
};

export function PartnerServiceRatesEditor({
  accountId,
  canManage,
  onPublished,
  onDirtyChange,
}: {
  accountId: string;
  canManage: boolean;
  onPublished?: (complete: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [data, setData] = React.useState<PartnerServiceRateEditorData | null>(
    null,
  );
  const [card, setCard] = React.useState<PartnerServiceRateDraft | null>(null);
  const [openService, setOpenService] = React.useState<string | null>(null);
  const [visible, setVisible] = React.useState(true);
  const [busy, setBusy] = React.useState<"load" | "draft" | "publish" | null>(
    "load",
  );
  const [notice, setNotice] = React.useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [dirty, setDirty] = React.useState(false);
  React.useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  const requestGeneration = React.useRef(0);
  const operation = React.useRef<{ payload: string; key: string } | null>(null);
  const statusRef = React.useRef<HTMLDivElement>(null);
  const saveLock = React.useRef(false);
  React.useEffect(() => {
    for (const key of Object.keys(errors)) {
      const index = key.match(/^(?:card\.)?rates\.(\d+)\./u)?.[1];
      if (!index) continue;
      const serviceKey = card?.rates[Number(index)]?.serviceKey;
      if (serviceKey) {
        setOpenService(serviceKey);
        break;
      }
    }
  }, [errors, card]);
  const load = React.useCallback(async () => {
    const generation = ++requestGeneration.current;
    setBusy("load");
    const result = await loadPartnerServiceRates(accountId).catch(() => null);
    if (generation !== requestGeneration.current) return;
    setBusy(null);
    if (!result?.ok) {
      setNotice({
        ok: false,
        message: result?.message ?? "Service rates could not be loaded.",
      });
      return;
    }
    setData(result.data);
    setCard(editorCard(result.data));
    setVisible(result.data.portalVisible);
    setDirty(false);
    onPublished?.(result.data.published?.complete === true);
  }, [accountId, onPublished]);
  React.useEffect(() => {
    setData(null);
    setCard(null);
    void load();
    const generation = requestGeneration;
    return () => {
      generation.current++;
    };
  }, [load]);
  React.useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);
  React.useEffect(() => {
    if (notice) statusRef.current?.focus();
  }, [notice]);
  function changeRate(index: number, patch: Partial<Rate>) {
    setCard((current) =>
      current
        ? {
            ...current,
            rates: current.rates.map((rate, i) =>
              i === index ? { ...rate, ...patch } : rate,
            ),
          }
        : current,
    );
    setDirty(true);
    setNotice(null);
    setErrors({});
  }
  function changeCard(patch: Partial<PartnerServiceRateDraft>) {
    setCard((current) => (current ? { ...current, ...patch } : current));
    setDirty(true);
    setNotice(null);
    setErrors({});
  }
  async function save(action: "draft" | "publish") {
    if (!card || !data || busy || saveLock.current) return;
    const generation = requestGeneration.current;
    const nextCard = {
      ...card,
      visitMinimum: card.visitMinimum?.trim() || null,
      rates: card.rates.map((rate) => ({
        ...rate,
        inclusions: rate.inclusions.map((item) => item.trim()).filter(Boolean),
        exclusions: rate.exclusions.map((item) => item.trim()).filter(Boolean),
        fullLoadCubicYards: rate.fullLoadCubicYards?.trim() || null,
        roomMaxSquareFeet: rate.roomMaxSquareFeet?.trim() || null,
        roomMaxHeightFeet: rate.roomMaxHeightFeet?.trim() || null,
      })),
    };
    if (action === "publish") {
      // Empty amount rows stay in the saved draft, not in the published card.
      const populatedIndices = nextCard.rates.flatMap((rate, index) =>
        rate.unitAmount.trim() ? [index] : [],
      );
      const parsed = PartnerServiceRateCardInputSchema.safeParse({
        ...nextCard,
        rates: populatedIndices.map((index) => nextCard.rates[index]!),
      });
      if (!parsed.success) {
        setErrors(
          Object.fromEntries(
            parsed.error.issues.map((issue) => [
              issue.path[0] === "rates" && typeof issue.path[1] === "number"
                ? [
                    "rates",
                    populatedIndices[issue.path[1]],
                    ...issue.path.slice(2),
                  ].join(".")
                : issue.path.join("."),
              issue.message,
            ]),
          ),
        );
        setNotice({
          ok: false,
          message: parsed.error.issues
            .map((issue) => {
              const rate =
                issue.path[0] === "rates" && typeof issue.path[1] === "number"
                  ? nextCard.rates[populatedIndices[issue.path[1]]!]
                  : null;
              const service = PARTNER_SERVICE_DEFINITIONS.find(
                (entry) => entry.key === rate?.serviceKey,
              );
              const field = String(issue.path[2] ?? "");
              const message =
                field === "inclusions" && rate?.inclusions.length === 0
                  ? "List the work included in this rate."
                  : issue.message;
              return rate && service
                ? `${service.label} (${rate.label}): ${RATE_FIELD_LABELS[field] ?? field} — ${message}`
                : message;
            })
            .filter((message, i, all) => all.indexOf(message) === i)
            .join(" "),
        });
        return;
      }
    }
    const change = { action, portalVisible: visible, card: nextCard };
    const payload = JSON.stringify({ revision: data.revision, change });
    if (operation.current?.payload !== payload)
      operation.current = {
        payload,
        key: "partner-service-rates:" + crypto.randomUUID(),
      };
    saveLock.current = true;
    setBusy(action);
    setNotice(null);
    setErrors({});
    const result = await savePartnerServiceRates({
      accountId,
      revision: data.revision,
      operationKey: operation.current.key,
      change,
    }).catch(() => null);
    if (generation !== requestGeneration.current) return;
    if (!result?.ok) {
      saveLock.current = false;
      setBusy(null);
    }
    if (!result?.ok) {
      setNotice({
        ok: false,
        message:
          result?.message ??
          "The save could not be confirmed. Try again with the same entries.",
      });
      setErrors(result && !result.ok ? (result.fieldErrors ?? {}) : {});
      return;
    }
    operation.current = null;
    setDirty(false);
    setData((current) =>
      current ? { ...current, revision: result.revision } : current,
    );
    if (action === "publish") {
      const refreshed = await loadPartnerServiceRates(accountId).catch(
        () => null,
      );
      if (generation !== requestGeneration.current) return;
      if (refreshed?.ok) {
        setData(refreshed.data);
        onPublished?.(refreshed.data.published?.complete === true);
      } else onPublished?.(false);
    }
    saveLock.current = false;
    setBusy(null);
    setNotice({
      ok: true,
      message:
        action === "draft"
          ? "Draft saved. The partner's published rates are unchanged."
          : "Rates published as a new version. Existing request snapshots are unchanged. Blank amounts remain unpriced.",
    });
  }
  if (!data || !card)
    return (
      <section aria-label="Service rates" className="space-y-3">
        <h3 className="font-semibold">Service rates</h3>
        {busy === "load" ? (
          <p role="status">Loading service rates…</p>
        ) : (
          <>
            <p role="alert">{notice?.message}</p>
            <button
              type="button"
              className={BUTTON}
              onClick={() => void load()}
            >
              Try again
            </button>
          </>
        )}
      </section>
    );
  const fieldError = (index: number, key: string) =>
    Object.entries(errors).find(([path]) =>
      [`rates.${index}.${key}`, `card.rates.${index}.${key}`].some(
        (prefix) => path === prefix || path.startsWith(prefix + "."),
      ),
    )?.[1];
  const errorAttributes = (index: number, key: string) => ({
    "aria-invalid": Boolean(fieldError(index, key)),
    "aria-describedby": fieldError(index, key)
      ? `partner-rate-${index}-${key}-error`
      : undefined,
  });
  return (
    <section
      aria-labelledby="partner-service-rates-title"
      className="space-y-4"
      data-partner-unsaved={dirty || undefined}
    >
      <div>
        <h3 id="partner-service-rates-title" className="text-lg font-semibold">
          Service rates
        </h3>
        <p className="mt-1 text-sm text-slate-600">
          Set this company&apos;s agreed rates. A rate is not a job total. Empty
          amounts remain unpriced.
        </p>
      </div>
      {notice ? (
        <div
          ref={statusRef}
          tabIndex={-1}
          role={notice.ok ? "status" : "alert"}
          className={`rounded-lg border p-3 text-sm ${notice.ok ? "border-emerald-200 bg-emerald-50" : "border-rose-200 bg-rose-50"}`}
        >
          {notice.message}
        </div>
      ) : null}
      {data.published?.legacyItems.length ? (
        <details className="rounded-lg border border-slate-200 p-3">
          <summary className="min-h-11 cursor-pointer font-semibold">
            Existing flat rates ({data.published.legacyItems.length})
          </summary>
          <p className="text-sm text-slate-600">
            These saved rates remain available until a structured card takes
            effect. Enter any replacement rates explicitly below.
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {data.published.legacyItems.map((rate) => (
              <li key={rate.id}>
                {rate.serviceKey} · {rate.label || rate.tierKey}:{" "}
                {new Intl.NumberFormat("en-US", {
                  style: "currency",
                  currency: data.published!.currency,
                }).format(rate.amountCents / 100)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <fieldset
        disabled={!canManage || busy !== null}
        className="min-w-0 space-y-4"
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <label
            className="text-sm font-medium"
            htmlFor="partner-visit-minimum"
          >
            Minimum per visit (USD, optional)
            <input
              id="partner-visit-minimum"
              className={FIELD}
              inputMode="decimal"
              value={card.visitMinimum ?? ""}
              onChange={(event) =>
                changeCard({ visitMinimum: event.target.value })
              }
              maxLength={30}
            />
            <span className="mt-1 block text-xs text-slate-600">
              Applied once to the combined visit, not once for each service.
            </span>
          </label>
          <label
            className="text-sm font-medium"
            htmlFor="partner-rates-effective"
          >
            Effective date
            <input
              type="date"
              id="partner-rates-effective"
              className={FIELD}
              value={easternDate(card.effectiveFrom)}
              onChange={(event) => {
                if (event.target.value)
                  changeCard({ effectiveFrom: dateIso(event.target.value) });
              }}
            />
          </label>
          <label className="text-sm font-medium" htmlFor="partner-rates-expiry">
            End date (optional)
            <input
              type="date"
              id="partner-rates-expiry"
              className={FIELD}
              value={card.effectiveTo ? easternDate(card.effectiveTo) : ""}
              onChange={(event) =>
                changeCard({
                  effectiveTo: event.target.value
                    ? dateIso(event.target.value)
                    : null,
                })
              }
            />
            <span className="mt-1 block text-xs text-slate-600">
              Ends at the start of this date, Eastern time.
            </span>
          </label>
        </div>
        <label className="flex min-h-11 items-center gap-3 text-sm">
          <input
            type="checkbox"
            className="h-5 w-5 accent-teal-700"
            checked={visible}
            onChange={(event) => {
              setVisible(event.target.checked);
              setDirty(true);
            }}
          />
          Show published rates to partner users with billing access
        </label>
        {PARTNER_SERVICE_DEFINITIONS.map((service) => {
          const enteredRateCount = card.rates.filter(
            (rate) => rate.serviceKey === service.key && rate.unitAmount,
          ).length;
          return (
            <details
              key={service.key}
              className="border-t border-slate-200"
              open={openService === service.key}
              onToggle={(event) => {
                const isOpen = event.currentTarget.open;
                setOpenService((current) =>
                  isOpen
                    ? service.key
                    : current === service.key
                      ? null
                      : current,
                );
              }}
            >
              <summary className="min-h-14 cursor-pointer py-3 font-semibold">
                <span>{service.label}</span>
                <span className="ml-2 text-xs font-normal text-slate-500">
                  {enteredRateCount} {enteredRateCount === 1 ? "rate" : "rates"}{" "}
                  entered
                </span>
              </summary>
              <div className="space-y-4 pb-4">
                {card.rates.map((rate, index) =>
                  rate.serviceKey !== service.key ? null : (
                    <div
                      key={rate.key}
                      data-partner-rate-index={index}
                      className="space-y-3 rounded-lg bg-slate-50 p-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h4 className="text-sm font-semibold">
                          {
                            service.variants.find(
                              (variant) => variant.key === rate.variantKey,
                            )?.label
                          }
                        </h4>
                        {card.rates.filter(
                          (entry) =>
                            entry.serviceKey === rate.serviceKey &&
                            entry.variantKey === rate.variantKey,
                        ).length > 1 ? (
                          <button
                            type="button"
                            className="min-h-11 px-2 text-sm text-rose-800 underline"
                            onClick={() =>
                              changeCard({
                                rates: card.rates.filter((_, i) => i !== index),
                              })
                            }
                          >
                            Remove rate
                          </button>
                        ) : null}
                      </div>
                      <div className="grid gap-3 sm:grid-cols-3">
                        <label
                          className="text-sm font-medium"
                          htmlFor={`partner-rate-${index}-label`}
                        >
                          Rate name
                          <input
                            id={`partner-rate-${index}-label`}
                            className={FIELD}
                            value={rate.label}
                            maxLength={160}
                            {...errorAttributes(index, "label")}
                            onChange={(event) =>
                              changeRate(index, { label: event.target.value })
                            }
                          />
                        </label>
                        <label
                          className="text-sm font-medium"
                          htmlFor={`partner-rate-${index}-unit`}
                        >
                          Price per
                          <select
                            id={`partner-rate-${index}-unit`}
                            className={FIELD}
                            value={rate.unit}
                            {...errorAttributes(index, "unit")}
                            onChange={(event) =>
                              changeRate(index, {
                                unit: event.target.value as Rate["unit"],
                              })
                            }
                          >
                            {Object.entries(
                              PARTNER_SERVICE_RATE_UNIT_LABELS,
                            ).map(([key, label]) => (
                              <option key={key} value={key}>
                                {label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label
                          className="text-sm font-medium"
                          htmlFor={`partner-rate-${index}-amount`}
                        >
                          Rate (USD)
                          <input
                            id={`partner-rate-${index}-amount`}
                            className={FIELD}
                            inputMode="decimal"
                            value={rate.unitAmount}
                            maxLength={30}
                            placeholder="Enter agreed rate"
                            {...errorAttributes(index, "unitAmount")}
                            onChange={(event) =>
                              changeRate(index, {
                                unitAmount: event.target.value,
                              })
                            }
                          />
                        </label>
                      </div>
                      <label
                        className="block text-sm font-medium"
                        htmlFor={`partner-rate-${index}-measurement`}
                      >
                        What this rate covers
                        <input
                          id={`partner-rate-${index}-measurement`}
                          className={FIELD}
                          value={rate.measurement}
                          maxLength={2000}
                          {...errorAttributes(index, "measurement")}
                          placeholder="Define the size, surface or work included"
                          onChange={(event) =>
                            changeRate(index, {
                              measurement: event.target.value,
                            })
                          }
                        />
                      </label>
                      {rate.unit === "load" ? (
                        <label
                          className="block text-sm font-medium"
                          htmlFor={`partner-rate-${index}-load`}
                        >
                          Full-load capacity (cubic yards)
                          <input
                            id={`partner-rate-${index}-load`}
                            className={FIELD}
                            inputMode="decimal"
                            value={rate.fullLoadCubicYards ?? ""}
                            maxLength={30}
                            {...errorAttributes(index, "fullLoadCubicYards")}
                            onChange={(event) =>
                              changeRate(index, {
                                fullLoadCubicYards: event.target.value,
                              })
                            }
                          />
                        </label>
                      ) : null}
                      {rate.unit === "room" ? (
                        <div className="grid gap-3 sm:grid-cols-2">
                          {(
                            [
                              [
                                "roomMaxSquareFeet",
                                "Maximum room floor area (sq ft)",
                              ],
                              [
                                "roomMaxHeightFeet",
                                "Maximum ceiling height (ft)",
                              ],
                            ] as const
                          ).map(([key, label]) => (
                            <label
                              key={key}
                              className="text-sm font-medium"
                              htmlFor={`partner-rate-${index}-${key}`}
                            >
                              {label}
                              <input
                                id={`partner-rate-${index}-${key}`}
                                className={FIELD}
                                inputMode="decimal"
                                value={rate[key] ?? ""}
                                maxLength={30}
                                onChange={(event) =>
                                  changeRate(index, {
                                    [key]: event.target.value,
                                  })
                                }
                                aria-invalid={Boolean(fieldError(index, key))}
                                aria-describedby={
                                  fieldError(index, key)
                                    ? `partner-rate-${index}-${key}-error`
                                    : undefined
                                }
                              />
                              {fieldError(index, key) ? (
                                <span
                                  id={`partner-rate-${index}-${key}-error`}
                                  className="mt-1 block text-sm text-rose-700"
                                >
                                  {fieldError(index, key)}
                                </span>
                              ) : null}
                            </label>
                          ))}
                        </div>
                      ) : null}
                      {service.key === "painting" ||
                      service.key === "drywall-repair-paint" ? (
                        <div className="grid gap-3 sm:grid-cols-2">
                          <label
                            className="text-sm font-medium"
                            htmlFor={`partner-rate-${index}-materials`}
                          >
                            Who supplies materials?
                            <select
                              id={`partner-rate-${index}-materials`}
                              className={FIELD}
                              value={rate.materials ?? ""}
                              {...errorAttributes(index, "materials")}
                              onChange={(event) =>
                                changeRate(index, {
                                  materials: event.target.value
                                    ? (event.target.value as Rate["materials"])
                                    : null,
                                })
                              }
                            >
                              <option value="">Choose</option>
                              <option value="stonegate">Stonegate</option>
                              <option value="partner">Partner</option>
                              <option value="mixed">
                                Both — describe below
                              </option>
                            </select>
                          </label>
                          <label
                            className="text-sm font-medium"
                            htmlFor={`partner-rate-${index}-coats`}
                          >
                            Included coats
                            <input
                              id={`partner-rate-${index}-coats`}
                              type="number"
                              min={1}
                              max={10}
                              className={FIELD}
                              value={rate.coats ?? ""}
                              {...errorAttributes(index, "coats")}
                              onChange={(event) =>
                                changeRate(index, {
                                  coats: event.target.value
                                    ? Number(event.target.value)
                                    : null,
                                })
                              }
                            />
                          </label>
                        </div>
                      ) : null}
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label
                          className="text-sm font-medium"
                          htmlFor={`partner-rate-${index}-included`}
                        >
                          Included work
                          <textarea
                            id={`partner-rate-${index}-included`}
                            rows={2}
                            className={FIELD}
                            value={rate.inclusions.join("\n")}
                            {...errorAttributes(index, "inclusions")}
                            onChange={(event) =>
                              changeRate(index, {
                                inclusions: lines(event.target.value),
                              })
                            }
                            placeholder="One item per line"
                          />
                        </label>
                        <label
                          className="text-sm font-medium"
                          htmlFor={`partner-rate-${index}-excluded`}
                        >
                          Exclusions (optional)
                          <textarea
                            id={`partner-rate-${index}-excluded`}
                            rows={2}
                            className={FIELD}
                            value={rate.exclusions.join("\n")}
                            {...errorAttributes(index, "exclusions")}
                            onChange={(event) =>
                              changeRate(index, {
                                exclusions: lines(event.target.value),
                              })
                            }
                            placeholder="One item per line"
                          />
                        </label>
                      </div>
                      {Object.entries(RATE_FIELD_LABELS)
                        .filter(
                          ([key]) =>
                            ![
                              "roomMaxSquareFeet",
                              "roomMaxHeightFeet",
                            ].includes(key) && fieldError(index, key),
                        )
                        .map(([key, label]) => (
                          <p
                            key={key}
                            id={`partner-rate-${index}-${key}-error`}
                            className="text-sm text-rose-700"
                          >
                            {label}:{" "}
                            {key === "inclusions" &&
                            rate.inclusions.every((value) => !value.trim())
                              ? "List the work included in this rate."
                              : fieldError(index, key)}
                          </p>
                        ))}
                    </div>
                  ),
                )}
                <div className="flex flex-wrap gap-2">
                  {service.variants.map((variant) => (
                    <button
                      key={variant.key}
                      type="button"
                      className={BUTTON}
                      onClick={() =>
                        changeCard({
                          rates: [
                            ...card.rates,
                            blankRate(
                              service.key,
                              variant.key,
                              "_" + crypto.randomUUID().slice(0, 8),
                            ),
                          ],
                        })
                      }
                    >
                      Add{" "}
                      {service.variants.length > 1
                        ? variant.label.toLowerCase()
                        : "another"}{" "}
                      rate
                    </button>
                  ))}
                </div>
              </div>
            </details>
          );
        })}
        {canManage ? (
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              className={BUTTON}
              onClick={() => void save("draft")}
            >
              {busy === "draft" ? "Saving…" : "Save draft"}
            </button>
            <button
              type="button"
              className={BUTTON + " !bg-primary-900 !text-white"}
              onClick={() => void save("publish")}
            >
              {busy === "publish" ? "Publishing…" : "Publish rates"}
            </button>
          </div>
        ) : (
          <p className="text-sm text-slate-600">
            Your role can view rates. Editing requires the Partner Rates
            permission.
          </p>
        )}
      </fieldset>
    </section>
  );
}
