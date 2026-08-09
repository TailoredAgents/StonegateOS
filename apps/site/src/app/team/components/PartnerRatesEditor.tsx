"use client";

import React from "react";
import {
  getPartnerServiceLabel,
  getPartnerTierLabel,
  PARTNER_ALLOWED_SERVICE_KEYS,
  PARTNER_DEMO_TIER_KEYS,
  PARTNER_JUNK_ADDON_TIER_KEYS,
  PARTNER_JUNK_BASE_TIER_KEYS,
  PARTNER_LAND_CLEARING_TIER_KEYS,
  type PartnerServiceKey,
} from "@myst-os/pricing";

type ServiceOption = { key: PartnerServiceKey; label: string };
const SERVICE_OPTIONS: ServiceOption[] = (
  PARTNER_ALLOWED_SERVICE_KEYS as readonly PartnerServiceKey[]
).map((key) => ({
  key,
  label: getPartnerServiceLabel(key),
}));

const JUNK_BASE_TIER_KEYS = PARTNER_JUNK_BASE_TIER_KEYS as readonly string[];
const JUNK_ADDON_TIER_KEYS = PARTNER_JUNK_ADDON_TIER_KEYS as readonly string[];
const DEMO_TIER_KEYS = PARTNER_DEMO_TIER_KEYS as readonly string[];
const LAND_CLEARING_TIER_KEYS =
  PARTNER_LAND_CLEARING_TIER_KEYS as readonly string[];

type RateItemRow = {
  id: string;
  serviceKey: string;
  tierKey: string;
  label: string | null;
  amountCents: number;
  sortOrder: number;
};

type EditableRateRow = {
  id: string;
  serviceKey: string;
  tierKey: string;
  label: string;
  amount: string;
};

function centsToAmountString(amountCents: number): string {
  if (!Number.isFinite(amountCents)) return "";
  return (amountCents / 100).toFixed(2);
}

function sanitizeCsvValue(value: string): string {
  return value.replace(/[\r\n,]+/g, " ").trim();
}

function toCsv(rows: EditableRateRow[]): string {
  return rows
    .map((row) => {
      const serviceKey = sanitizeCsvValue(row.serviceKey);
      const tierKey = sanitizeCsvValue(row.tierKey);
      const label = sanitizeCsvValue(row.label);
      const amount = sanitizeCsvValue(row.amount);
      return [serviceKey.toLowerCase(), tierKey, label, amount].join(",");
    })
    .join("\n");
}

function fromInitial(items: RateItemRow[]): EditableRateRow[] {
  return items
    .slice()
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map((item) => ({
      id: item.id,
      serviceKey: item.serviceKey ?? "",
      tierKey: item.tierKey ?? "",
      label: item.label ?? "",
      amount: centsToAmountString(item.amountCents ?? 0),
    }));
}

function buildStonegateDefaultRows(): EditableRateRow[] {
  return [
    {
      id: "seed_quarter",
      serviceKey: "junk-removal",
      tierKey: "quarter",
      label: "Quarter load",
      amount: "150.00",
    },
    {
      id: "seed_half",
      serviceKey: "junk-removal",
      tierKey: "half",
      label: "Half load",
      amount: "300.00",
    },
    {
      id: "seed_three_quarter",
      serviceKey: "junk-removal",
      tierKey: "three_quarter",
      label: "3/4 load",
      amount: "450.00",
    },
    {
      id: "seed_full",
      serviceKey: "junk-removal",
      tierKey: "full",
      label: "Full load",
      amount: "600.00",
    },
    {
      id: "seed_mattress_fee",
      serviceKey: "junk-removal",
      tierKey: "mattress_fee",
      label: "Mattress fee (each)",
      amount: "30.00",
    },
    {
      id: "seed_paint_fee",
      serviceKey: "junk-removal",
      tierKey: "paint_fee",
      label: "Paint cans (each)",
      amount: "10.00",
    },
    {
      id: "seed_tire_fee",
      serviceKey: "junk-removal",
      tierKey: "tire_fee",
      label: "Tires (each)",
      amount: "10.00",
    },

    {
      id: "seed_demo_small",
      serviceKey: "demo-hauloff",
      tierKey: "small",
      label: "Small demo",
      amount: "650.00",
    },
    {
      id: "seed_demo_medium",
      serviceKey: "demo-hauloff",
      tierKey: "medium",
      label: "Medium demo",
      amount: "1250.00",
    },
    {
      id: "seed_demo_large",
      serviceKey: "demo-hauloff",
      tierKey: "large",
      label: "Large demo",
      amount: "2400.00",
    },

    {
      id: "seed_land_small_patch",
      serviceKey: "land-clearing",
      tierKey: "small_patch",
      label: "Small patch",
      amount: "850.00",
    },
    {
      id: "seed_land_yard_section",
      serviceKey: "land-clearing",
      tierKey: "yard_section",
      label: "Yard section",
      amount: "1650.00",
    },
    {
      id: "seed_land_most_of_yard",
      serviceKey: "land-clearing",
      tierKey: "most_of_yard",
      label: "Most of a yard",
      amount: "3200.00",
    },
    {
      id: "seed_land_full_lot",
      serviceKey: "land-clearing",
      tierKey: "full_lot",
      label: "Full lot (starting)",
      amount: "5500.00",
    },
    {
      id: "seed_land_not_sure",
      serviceKey: "land-clearing",
      tierKey: "not_sure",
      label: "Not sure",
      amount: "1650.00",
    },
  ];
}

function mergePresetRows(
  existing: EditableRateRow[],
  preset: EditableRateRow[],
): EditableRateRow[] {
  const keyOf = (row: EditableRateRow) =>
    `${row.serviceKey.trim().toLowerCase()}:${row.tierKey.trim()}`;
  const existingKeys = new Set(existing.map(keyOf));
  const missing = preset.filter(
    (row) =>
      row.serviceKey.trim().length &&
      row.tierKey.trim().length &&
      !existingKeys.has(keyOf(row)),
  );
  return missing.length ? [...existing, ...missing] : existing;
}

export function PartnerRatesEditor({
  currency,
  initialItems,
}: {
  currency: string;
  initialItems: RateItemRow[];
}) {
  const [rows, setRowsState] = React.useState<EditableRateRow[]>(
    initialItems.length
      ? fromInitial(initialItems)
      : buildStonegateDefaultRows(),
  );
  const [rawDraft, setRawDraft] = React.useState<string | null>(null);
  const setRows = React.useCallback<
    React.Dispatch<React.SetStateAction<EditableRateRow[]>>
  >((value) => {
    setRawDraft(null);
    setRowsState(value);
  }, []);

  const structuredCsv = React.useMemo(() => toCsv(rows), [rows]);
  const submissionCsv = rawDraft ?? structuredCsv;

  return (
    <div className="space-y-3">
      <textarea name="ratesCsv" value={submissionCsv} readOnly hidden />

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between gap-3 border-b border-slate-100 bg-slate-50 px-3 py-2">
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Negotiated tiers ({currency})
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="min-h-[44px] rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:border-primary-300 hover:text-primary-700"
              onClick={() =>
                setRows((prev) =>
                  mergePresetRows(prev, buildStonegateDefaultRows()),
                )
              }
            >
              Insert Stonegate defaults
            </button>
            <button
              type="button"
              className="min-h-[44px] rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:border-primary-300 hover:text-primary-700"
              onClick={() =>
                setRows((prev) => [
                  ...prev.slice(0, 99),
                  {
                    id: `new_${Date.now()}`,
                    serviceKey: "junk-removal",
                    tierKey: "",
                    label: "",
                    amount: "",
                  },
                ])
              }
              disabled={rows.length >= 100}
            >
              + Add tier
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2 px-3 py-3 text-xs sm:grid-cols-12">
          <div className="hidden sm:block sm:col-span-4 font-semibold uppercase tracking-[0.18em] text-slate-500">
            Service
          </div>
          <div className="hidden sm:block sm:col-span-2 font-semibold uppercase tracking-[0.18em] text-slate-500">
            Tier key
          </div>
          <div className="hidden sm:block sm:col-span-3 font-semibold uppercase tracking-[0.18em] text-slate-500">
            Label
          </div>
          <div className="hidden sm:block sm:col-span-3 text-right font-semibold uppercase tracking-[0.18em] text-slate-500">
            Amount
          </div>

          {rows.map((row) => (
            <React.Fragment key={row.id}>
              <div className="sm:col-span-4">
                <div className="mb-1 sm:hidden text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Service
                </div>
                <select
                  value={row.serviceKey}
                  onChange={(e) =>
                    setRows((prev) =>
                      prev.map((r) =>
                        r.id === row.id
                          ? {
                              ...r,
                              serviceKey: e.target.value,
                              tierKey: "",
                              label: "",
                            }
                          : r,
                      ),
                    )
                  }
                  aria-label="Rate service"
                  className="min-h-[44px] w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                >
                  {SERVICE_OPTIONS.map((opt) => (
                    <option key={opt.key} value={opt.key}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="sm:col-span-2">
                <div className="mb-1 sm:hidden text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Tier key
                </div>
                {row.serviceKey === "junk-removal" ? (
                  <select
                    value={row.tierKey}
                    onChange={(e) =>
                      setRows((prev) =>
                        prev.map((r) =>
                          r.id === row.id
                            ? {
                                ...r,
                                tierKey: e.target.value,
                                label: r.label.trim().length
                                  ? r.label
                                  : getPartnerTierLabel(
                                      r.serviceKey,
                                      e.target.value,
                                    ),
                              }
                            : r,
                        ),
                      )
                    }
                    aria-label="Rate tier"
                    className="min-h-[44px] w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                  >
                    <option value="">Choose...</option>
                    <optgroup label="Base tiers">
                      {JUNK_BASE_TIER_KEYS.map((key) => (
                        <option key={key} value={key}>
                          {key}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Add-ons">
                      {JUNK_ADDON_TIER_KEYS.map((key) => (
                        <option key={key} value={key}>
                          {key}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                ) : row.serviceKey === "demo-hauloff" ? (
                  <select
                    value={row.tierKey}
                    onChange={(e) =>
                      setRows((prev) =>
                        prev.map((r) =>
                          r.id === row.id
                            ? {
                                ...r,
                                tierKey: e.target.value,
                                label: r.label.trim().length
                                  ? r.label
                                  : getPartnerTierLabel(
                                      r.serviceKey,
                                      e.target.value,
                                    ),
                              }
                            : r,
                        ),
                      )
                    }
                    aria-label="Rate tier"
                    className="min-h-[44px] w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                  >
                    <option value="">Choose...</option>
                    {DEMO_TIER_KEYS.map((key) => (
                      <option key={key} value={key}>
                        {getPartnerTierLabel("demo-hauloff", key)}
                      </option>
                    ))}
                  </select>
                ) : row.serviceKey === "land-clearing" ? (
                  <select
                    value={row.tierKey}
                    onChange={(e) =>
                      setRows((prev) =>
                        prev.map((r) =>
                          r.id === row.id
                            ? {
                                ...r,
                                tierKey: e.target.value,
                                label: r.label.trim().length
                                  ? r.label
                                  : getPartnerTierLabel(
                                      r.serviceKey,
                                      e.target.value,
                                    ),
                              }
                            : r,
                        ),
                      )
                    }
                    aria-label="Rate tier"
                    className="min-h-[44px] w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                  >
                    <option value="">Choose...</option>
                    {LAND_CLEARING_TIER_KEYS.map((key) => (
                      <option key={key} value={key}>
                        {getPartnerTierLabel("land-clearing", key)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={row.tierKey}
                    maxLength={100}
                    onChange={(e) =>
                      setRows((prev) =>
                        prev.map((r) =>
                          r.id === row.id
                            ? { ...r, tierKey: e.target.value }
                            : r,
                        ),
                      )
                    }
                    aria-label="Rate tier"
                    className="min-h-[44px] w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                    placeholder="tier_key"
                  />
                )}
              </div>
              <div className="sm:col-span-3">
                <div className="mb-1 sm:hidden text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Label
                </div>
                <input
                  value={row.label}
                  maxLength={120}
                  onChange={(e) =>
                    setRows((prev) =>
                      prev.map((r) =>
                        r.id === row.id ? { ...r, label: e.target.value } : r,
                      ),
                    )
                  }
                  aria-label="Rate label"
                  className="min-h-[44px] w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                  placeholder="Quarter load"
                />
              </div>
              <div className="sm:col-span-3">
                <div className="mb-1 sm:hidden text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Amount
                </div>
                <div className="flex items-center justify-start gap-2 sm:justify-end">
                  <div className="shrink-0 text-xs text-slate-500">$</div>
                  <input
                    value={row.amount}
                    maxLength={10}
                    onChange={(e) =>
                      setRows((prev) =>
                        prev.map((r) =>
                          r.id === row.id
                            ? { ...r, amount: e.target.value }
                            : r,
                        ),
                      )
                    }
                    aria-label="Rate amount in dollars"
                    className="min-h-[44px] min-w-[96px] flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-right text-xs text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                    placeholder="150.00"
                    inputMode="decimal"
                  />
                  <button
                    type="button"
                    className="min-h-[44px] min-w-[44px] shrink-0 rounded-full border border-slate-200 bg-white px-2 py-2 text-xs font-semibold text-slate-600 hover:border-rose-300 hover:text-rose-700"
                    onClick={() =>
                      setRows((prev) => prev.filter((r) => r.id !== row.id))
                    }
                    aria-label="Remove tier"
                    title="Remove tier"
                  >
                    x
                  </button>
                </div>
              </div>
            </React.Fragment>
          ))}
        </div>
      </div>

      <details className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
        <summary className="cursor-pointer text-xs font-semibold text-slate-700">
          Advanced: edit raw CSV
        </summary>
        <p className="mt-2 text-xs text-slate-500">
          Format:{" "}
          <span className="font-mono">serviceKey,tierKey,label,amount</span>.
          Every non-empty line must be complete; invalid rows are rejected and
          are never silently removed.
        </p>
        {rawDraft !== null ? (
          <div
            role="status"
            className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
          >
            <span>
              The raw CSV below overrides the structured rows above when you
              save.
            </span>
            <button
              type="button"
              className="min-h-[44px] rounded-xl border border-amber-300 bg-white px-3 py-2 font-semibold"
              onClick={() => setRawDraft(null)}
            >
              Discard raw changes
            </button>
          </div>
        ) : null}
        <textarea
          className="mt-2 min-h-[140px] w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 font-mono text-[11px] text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
          value={submissionCsv}
          maxLength={65_536}
          aria-label="Partner rates raw CSV"
          onChange={(event) => setRawDraft(event.target.value)}
        />
      </details>
    </div>
  );
}
