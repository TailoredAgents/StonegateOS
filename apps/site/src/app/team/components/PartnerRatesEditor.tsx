"use client";

import React from "react";

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
  const lines: string[] = [];
  for (const row of rows) {
    const serviceKey = sanitizeCsvValue(row.serviceKey);
    const tierKey = sanitizeCsvValue(row.tierKey);
    const label = sanitizeCsvValue(row.label);
    const amount = Number(String(row.amount).replace(/[^0-9.]/g, ""));
    if (!serviceKey || !tierKey || !Number.isFinite(amount)) continue;
    lines.push([serviceKey.toLowerCase(), tierKey, label, amount.toFixed(2)].join(","));
  }
  return lines.join("\n");
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
      amount: centsToAmountString(item.amountCents ?? 0)
    }));
}

export function PartnerRatesEditor({
  currency,
  initialItems
}: {
  currency: string;
  initialItems: RateItemRow[];
}) {
  const [rows, setRows] = React.useState<EditableRateRow[]>(
    initialItems.length
      ? fromInitial(initialItems)
      : [
          {
            id: "seed_quarter",
            serviceKey: "junk-removal",
            tierKey: "quarter",
            label: "Quarter load",
            amount: "150.00"
          },
          {
            id: "seed_half",
            serviceKey: "junk-removal",
            tierKey: "half",
            label: "Half load",
            amount: "300.00"
          },
          {
            id: "seed_full",
            serviceKey: "junk-removal",
            tierKey: "full",
            label: "Full load",
            amount: "600.00"
          }
        ]
  );

  const csvValue = React.useMemo(() => toCsv(rows), [rows]);

  return (
    <div className="space-y-3">
      <textarea name="ratesCsv" value={csvValue} readOnly hidden />

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between gap-3 border-b border-slate-100 bg-slate-50 px-3 py-2">
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Negotiated tiers ({currency})
          </div>
          <button
            type="button"
            className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-primary-300 hover:text-primary-700"
            onClick={() =>
              setRows((prev) => [
                ...prev,
                { id: `new_${Date.now()}`, serviceKey: "junk-removal", tierKey: "", label: "", amount: "" }
              ])
            }
          >
            + Add tier
          </button>
        </div>

        <div className="grid grid-cols-12 gap-2 px-3 py-3 text-xs">
          <div className="col-span-4 font-semibold uppercase tracking-[0.18em] text-slate-500">Service</div>
          <div className="col-span-3 font-semibold uppercase tracking-[0.18em] text-slate-500">Tier key</div>
          <div className="col-span-3 font-semibold uppercase tracking-[0.18em] text-slate-500">Label</div>
          <div className="col-span-2 text-right font-semibold uppercase tracking-[0.18em] text-slate-500">
            Amount
          </div>

          {rows.map((row) => (
            <React.Fragment key={row.id}>
              <div className="col-span-4">
                <input
                  value={row.serviceKey}
                  onChange={(e) =>
                    setRows((prev) =>
                      prev.map((r) => (r.id === row.id ? { ...r, serviceKey: e.target.value } : r))
                    )
                  }
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                  placeholder="junk-removal"
                />
              </div>
              <div className="col-span-3">
                <input
                  value={row.tierKey}
                  onChange={(e) =>
                    setRows((prev) =>
                      prev.map((r) => (r.id === row.id ? { ...r, tierKey: e.target.value } : r))
                    )
                  }
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                  placeholder="quarter"
                />
              </div>
              <div className="col-span-3">
                <input
                  value={row.label}
                  onChange={(e) =>
                    setRows((prev) =>
                      prev.map((r) => (r.id === row.id ? { ...r, label: e.target.value } : r))
                    )
                  }
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                  placeholder="Quarter load"
                />
              </div>
              <div className="col-span-2 flex items-center justify-end gap-2">
                <div className="text-xs text-slate-500">$</div>
                <input
                  value={row.amount}
                  onChange={(e) =>
                    setRows((prev) =>
                      prev.map((r) => (r.id === row.id ? { ...r, amount: e.target.value } : r))
                    )
                  }
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-right text-xs text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                  placeholder="150.00"
                  inputMode="decimal"
                />
                <button
                  type="button"
                  className="rounded-full border border-slate-200 bg-white px-2 py-2 text-xs font-semibold text-slate-600 hover:border-rose-300 hover:text-rose-700"
                  onClick={() => setRows((prev) => prev.filter((r) => r.id !== row.id))}
                  aria-label="Remove tier"
                  title="Remove tier"
                >
                  ×
                </button>
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
          Format: <span className="font-mono">serviceKey,tierKey,label,amount</span>
        </p>
        <textarea
          className="mt-2 min-h-[140px] w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 font-mono text-[11px] text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
          value={csvValue}
          onChange={(e) => {
            const lines = e.target.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
            const parsed: EditableRateRow[] = lines.map((line, idx) => {
              const [serviceKey = "", tierKey = "", label = "", amount = ""] = line.split(",").map((p) => p.trim());
              return {
                id: `csv_${Date.now()}_${idx}`,
                serviceKey,
                tierKey,
                label,
                amount
              };
            });
            setRows(parsed.length ? parsed : []);
          }}
        />
      </details>
    </div>
  );
}
