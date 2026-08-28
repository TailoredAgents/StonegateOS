"use client";

import * as React from "react";
import { ChevronLeft, CircleAlert, PencilLine, Plus } from "lucide-react";
import {
  acknowledgeExpenseMutationAttempt,
  getExpenseMutationAttempt,
} from "./lib/expense-mutation-idempotency";
import {
  centsToMoneyInput,
  expenseErrorMessage,
  formatExpenseMoney,
  moneyInputToCents,
} from "./spend-v2-utils";

type FixedCostCategory = { id: string; name: string };

export type MobileFixedCost = {
  seriesId: string;
  version: number;
  name: string;
  categoryId: string;
  category: string;
  monthlyAmountCents: number;
  effectiveStartDate: string;
  state: "active" | "ended";
  createdAt: string;
};

export type MobileFixedCostsPayload = {
  ok: true;
  currency: "USD";
  asOf: string;
  summary: {
    activeCount: number;
    monthlyAmountCents: number;
    dailyAccrualCents: number;
  };
  costs: MobileFixedCost[];
};

type EditorValue = {
  name: string;
  monthlyAmountCents: number;
  categoryId: string;
  effectiveStartDate: string;
};

type FixedCostMode =
  | { name: "list" }
  | { name: "create" }
  | { name: "revise"; cost: MobileFixedCost }
  | { name: "end"; cost: MobileFixedCost };

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-cyan-200 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950";
const controlClass = `${focusRing} min-h-11 w-full rounded-lg border border-white/15 bg-slate-950 px-3 py-2.5 text-base text-white`;
const primaryButton = `${focusRing} min-h-11 w-full rounded-lg bg-cyan-300 px-4 py-3 text-sm font-bold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50`;
const secondaryButton = `${focusRing} min-h-11 rounded-lg border border-white/15 bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50`;
const cardClass = "rounded-xl border border-white/10 bg-white/[0.07] p-4";

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function parseFixedCost(value: unknown): MobileFixedCost | null {
  const record = recordValue(value);
  if (
    !record ||
    typeof record["seriesId"] !== "string" ||
    !record["seriesId"].trim() ||
    record["seriesId"].length > 200 ||
    !Number.isSafeInteger(record["version"]) ||
    Number(record["version"]) < 1 ||
    typeof record["name"] !== "string" ||
    !record["name"].trim() ||
    typeof record["categoryId"] !== "string" ||
    !record["categoryId"].trim() ||
    typeof record["category"] !== "string" ||
    !record["category"].trim() ||
    !Number.isSafeInteger(record["monthlyAmountCents"]) ||
    Number(record["monthlyAmountCents"]) < 1 ||
    typeof record["effectiveStartDate"] !== "string" ||
    !DATE_PATTERN.test(record["effectiveStartDate"]) ||
    (record["state"] !== "active" && record["state"] !== "ended") ||
    typeof record["createdAt"] !== "string" ||
    Number.isNaN(Date.parse(record["createdAt"]))
  ) {
    return null;
  }
  return record as MobileFixedCost;
}

export function parseMobileFixedCostsPayload(
  value: unknown,
): MobileFixedCostsPayload | null {
  const record = recordValue(value);
  const summary = recordValue(record?.["summary"]);
  const rawCosts = record?.["costs"];
  if (
    record?.["ok"] !== true ||
    record["currency"] !== "USD" ||
    typeof record["asOf"] !== "string" ||
    !DATE_PATTERN.test(record["asOf"]) ||
    !summary ||
    !nonnegativeSafeInteger(summary["activeCount"]) ||
    !nonnegativeSafeInteger(summary["monthlyAmountCents"]) ||
    !nonnegativeSafeInteger(summary["dailyAccrualCents"]) ||
    !Array.isArray(rawCosts)
  ) {
    return null;
  }
  const costs = rawCosts.map(parseFixedCost);
  if (costs.some((cost) => cost === null)) return null;
  return {
    ok: true,
    currency: "USD",
    asOf: record["asOf"],
    summary: {
      activeCount: summary["activeCount"],
      monthlyAmountCents: summary["monthlyAmountCents"],
      dailyAccrualCents: summary["dailyAccrualCents"],
    },
    costs: costs as MobileFixedCost[],
  };
}

async function responsePayload(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

async function fetchFixedCosts(): Promise<MobileFixedCostsPayload> {
  const response = await fetch("/api/mobile/expenses/fixed-costs", {
    cache: "no-store",
    credentials: "include",
  });
  const payload = await responsePayload(response);
  if (!response.ok) {
    throw new Error(
      expenseErrorMessage(payload, "Fixed costs are unavailable."),
    );
  }
  const parsed = parseMobileFixedCostsPayload(payload);
  if (!parsed) throw new Error("The fixed-cost response was invalid.");
  return parsed;
}

function StatusNotice({
  message,
  tone,
}: {
  message: string;
  tone: "error" | "success" | "info";
}) {
  const classes =
    tone === "error"
      ? "border-rose-300/30 bg-rose-300/10 text-rose-100"
      : tone === "success"
        ? "border-emerald-300/30 bg-emerald-300/10 text-emerald-100"
        : "border-cyan-300/25 bg-cyan-300/10 text-cyan-100";
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      aria-atomic="true"
      className={`rounded-lg border p-3 text-sm leading-6 ${classes}`}
    >
      {message}
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1.5 block text-xs font-semibold text-slate-300">
      {children}
    </span>
  );
}

function FixedCostEditor({
  mode,
  categories,
  asOf,
  saving,
  onSubmit,
  onBack,
  onEnd,
}: {
  mode: Extract<FixedCostMode, { name: "create" | "revise" }>;
  categories: readonly FixedCostCategory[];
  asOf: string;
  saving: boolean;
  onSubmit: (value: EditorValue) => Promise<void>;
  onBack: () => void;
  onEnd?: () => void;
}) {
  const existing = mode.name === "revise" ? mode.cost : null;
  const [name, setName] = React.useState(existing?.name ?? "");
  const [amount, setAmount] = React.useState(
    existing ? centsToMoneyInput(existing.monthlyAmountCents) : "",
  );
  const [categoryId, setCategoryId] = React.useState(
    existing?.categoryId ?? "",
  );
  const [effectiveStartDate, setEffectiveStartDate] = React.useState(asOf);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const normalizedName = name.trim();
    const monthlyAmountCents = moneyInputToCents(amount);
    if (!normalizedName) {
      setError("Enter a name for this fixed cost.");
      return;
    }
    if (monthlyAmountCents === null || monthlyAmountCents < 1) {
      setError("Enter a monthly amount greater than $0.00.");
      return;
    }
    if (!categoryId) {
      setError("Choose an expense category.");
      return;
    }
    if (!DATE_PATTERN.test(effectiveStartDate)) {
      setError("Choose when this fixed cost takes effect.");
      return;
    }
    if (
      effectiveStartDate > asOf ||
      effectiveStartDate < (existing?.effectiveStartDate ?? "2000-01-01")
    ) {
      setError(
        existing
          ? `Choose a date from ${existing.effectiveStartDate} through ${asOf}.`
          : `Choose a date from 2000-01-01 through ${asOf}.`,
      );
      return;
    }
    await onSubmit({
      name: normalizedName,
      monthlyAmountCents,
      categoryId,
      effectiveStartDate,
    });
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-4">
      <div className="rounded-lg border border-cyan-300/20 bg-cyan-300/10 p-3 text-sm leading-6 text-cyan-100">
        This schedule is included automatically in Overview. If you save the
        same bill as a receipt, link it to this fixed cost under More details so
        it is counted once.
      </div>
      <label className="block">
        <FieldLabel>Name</FieldLabel>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={120}
          required
          autoComplete="off"
          placeholder="Rent, insurance, software…"
          className={controlClass}
        />
      </label>
      <label className="block">
        <FieldLabel>Monthly amount</FieldLabel>
        <div className="relative">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xl font-semibold text-slate-400"
          >
            $
          </span>
          <input
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            inputMode="decimal"
            autoComplete="off"
            required
            aria-label="Monthly fixed cost in dollars"
            placeholder="0.00"
            className={`${controlClass} pl-8 text-xl font-semibold`}
          />
        </div>
      </label>
      <label className="block">
        <FieldLabel>Category</FieldLabel>
        <select
          value={categoryId}
          onChange={(event) => setCategoryId(event.target.value)}
          className={controlClass}
          required
        >
          <option value="">Choose category</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <FieldLabel>
          {existing ? "Apply changes starting" : "Start date"}
        </FieldLabel>
        <input
          type="date"
          value={effectiveStartDate}
          min={existing?.effectiveStartDate ?? "2000-01-01"}
          max={asOf}
          onChange={(event) => setEffectiveStartDate(event.target.value)}
          required
          className={controlClass}
        />
        {existing ? (
          <span className="mt-1.5 block text-xs leading-5 text-slate-400">
            Earlier dates can change previous weekly reports. Existing history
            remains versioned.
          </span>
        ) : null}
      </label>
      <div className="rounded-lg border border-white/10 bg-slate-950 p-3 text-xs leading-5 text-slate-400">
        The monthly amount is spread across the actual calendar days in each
        month, including weekends.
      </div>
      {error ? <StatusNotice tone="error" message={error} /> : null}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {saving ? "Saving fixed cost" : ""}
      </div>
      <button type="submit" disabled={saving} className={primaryButton}>
        {saving
          ? "Saving…"
          : existing
            ? "Save fixed cost change"
            : "Add fixed cost"}
      </button>
      {existing && onEnd ? (
        <button
          type="button"
          onClick={onEnd}
          disabled={saving}
          className={`${secondaryButton} w-full border-rose-300/25 text-rose-100`}
        >
          End this fixed cost
        </button>
      ) : null}
      <button
        type="button"
        onClick={onBack}
        disabled={saving}
        className={`${secondaryButton} w-full`}
      >
        Back
      </button>
    </form>
  );
}

function EndFixedCost({
  cost,
  asOf,
  saving,
  onSubmit,
  onBack,
}: {
  cost: MobileFixedCost;
  asOf: string;
  saving: boolean;
  onSubmit: (effectiveStartDate: string) => Promise<void>;
  onBack: () => void;
}) {
  const [effectiveStartDate, setEffectiveStartDate] = React.useState(asOf);
  const [error, setError] = React.useState<string | null>(null);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!DATE_PATTERN.test(effectiveStartDate)) {
      setError("Choose an end date.");
      return;
    }
    if (
      effectiveStartDate < cost.effectiveStartDate ||
      effectiveStartDate > asOf
    ) {
      setError(
        `Choose a date from ${cost.effectiveStartDate} through ${asOf}.`,
      );
      return;
    }
    await onSubmit(effectiveStartDate);
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-4">
      <div className="rounded-xl border border-amber-300/30 bg-amber-300/10 p-4 text-sm leading-6 text-amber-100">
        <div className="flex gap-2">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <p>
            {cost.name} will stop contributing to Overview on the selected date.
            Weeks on or after that date will recalculate. The fixed-cost audit
            history remains intact.
          </p>
        </div>
      </div>
      <label className="block">
        <FieldLabel>End date</FieldLabel>
        <input
          type="date"
          value={effectiveStartDate}
          min={cost.effectiveStartDate}
          max={asOf}
          onChange={(event) => setEffectiveStartDate(event.target.value)}
          className={controlClass}
          required
        />
      </label>
      {error ? <StatusNotice tone="error" message={error} /> : null}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {saving ? "Ending fixed cost" : ""}
      </div>
      <button
        type="submit"
        disabled={saving}
        className={`${focusRing} min-h-11 w-full rounded-lg bg-rose-200 px-4 py-3 text-sm font-bold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50`}
      >
        {saving ? "Ending…" : "Confirm end date"}
      </button>
      <button
        type="button"
        onClick={onBack}
        disabled={saving}
        className={`${secondaryButton} w-full`}
      >
        Back
      </button>
    </form>
  );
}

function CostRow({
  cost,
  onEdit,
}: {
  cost: MobileFixedCost;
  onEdit?: () => void;
}) {
  const content = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-white">
          {cost.name}
        </span>
        <span className="mt-1 block text-xs leading-5 text-slate-400">
          {cost.category} · {cost.state === "ended" ? "ended" : "from"}{" "}
          {cost.effectiveStartDate}
        </span>
      </span>
      <span className="shrink-0 text-right">
        <span className="block text-sm font-bold text-white">
          {formatExpenseMoney(cost.monthlyAmountCents)}
        </span>
        <span className="mt-1 block text-[11px] text-slate-400">per month</span>
      </span>
      {onEdit ? (
        <PencilLine
          aria-hidden="true"
          className="size-4 shrink-0 text-cyan-200"
        />
      ) : null}
    </>
  );
  return onEdit ? (
    <button
      type="button"
      onClick={onEdit}
      aria-label={`Edit ${cost.name}, ${formatExpenseMoney(cost.monthlyAmountCents)} per month`}
      className={`${focusRing} flex min-h-11 w-full items-center gap-3 rounded-lg border border-white/10 bg-slate-950 p-3 text-left`}
    >
      {content}
    </button>
  ) : (
    <div className="flex items-center gap-3 rounded-lg border border-white/10 bg-slate-950 p-3">
      {content}
    </div>
  );
}

export function MobileFixedCosts({
  employeeId,
  categories,
  onBack,
  onChanged,
}: {
  employeeId: string;
  categories: readonly FixedCostCategory[];
  onBack: () => void;
  onChanged: () => void;
}) {
  const [payload, setPayload] = React.useState<MobileFixedCostsPayload | null>(
    null,
  );
  const [mode, setMode] = React.useState<FixedCostMode>({ name: "list" });
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const headingRef = React.useRef<HTMLHeadingElement>(null);

  const reload = React.useCallback(async () => {
    const next = await fetchFixedCosts();
    setPayload(next);
    return next;
  }, []);

  React.useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void fetchFixedCosts()
      .then((next) => active && setPayload(next))
      .catch(
        (reason: unknown) =>
          active &&
          setError(
            reason instanceof Error
              ? reason.message
              : "Fixed costs are unavailable.",
          ),
      )
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  React.useEffect(() => {
    headingRef.current?.focus();
  }, [mode]);

  const runMutation = async (input: {
    operation: string;
    path: string;
    method: "POST" | "PATCH";
    body: Record<string, unknown>;
    version?: number;
    successMessage: string;
  }) => {
    setSaving(true);
    setError(null);
    setNotice(null);
    let committed = false;
    try {
      const attempt = await getExpenseMutationAttempt({
        employeeId,
        operation: input.operation,
        payload: input.body,
      });
      const response = await fetch(input.path, {
        method: input.method,
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": attempt.idempotencyKey,
          ...(input.version === undefined
            ? {}
            : { "If-Match": String(input.version) }),
        },
        body: JSON.stringify(input.body),
      });
      const responseBody = await responsePayload(response);
      if (!response.ok) {
        setError(
          expenseErrorMessage(responseBody, "The fixed cost was not saved."),
        );
        return;
      }
      committed = true;
      await acknowledgeExpenseMutationAttempt(attempt);
      setMode({ name: "list" });
      setNotice(input.successMessage);
      onChanged();
      try {
        await reload();
      } catch {
        setError(
          `${input.successMessage} The latest fixed-cost list could not be reloaded; reopen it to refresh.`,
        );
      }
    } catch (reason) {
      setError(
        committed
          ? `${input.successMessage} Its secure retry record could not be cleared, so review the list before retrying.`
          : reason instanceof Error &&
              reason.message.startsWith("Secure expense retry storage")
            ? reason.message
            : "The connection was interrupted. Nothing was reported as saved; retry the same change.",
      );
    } finally {
      setSaving(false);
    }
  };

  const asOf = payload?.asOf ?? new Date().toISOString().slice(0, 10);
  const activeCosts =
    payload?.costs.filter((cost) => cost.state === "active") ?? [];
  const endedCosts =
    payload?.costs.filter((cost) => cost.state === "ended") ?? [];
  const title =
    mode.name === "create"
      ? "Add fixed cost"
      : mode.name === "revise"
        ? `Update ${mode.cost.name}`
        : mode.name === "end"
          ? `End ${mode.cost.name}`
          : "Fixed costs";

  return (
    <div className="space-y-4">
      <header className={cardClass}>
        <div className="flex items-start gap-3">
          <button
            type="button"
            aria-label={mode.name === "list" ? "Back to Overview" : "Back"}
            onClick={() =>
              mode.name === "list" ? onBack() : setMode({ name: "list" })
            }
            disabled={saving}
            className={`${secondaryButton} grid size-11 shrink-0 place-items-center p-0`}
          >
            <ChevronLeft aria-hidden="true" className="size-5" />
          </button>
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-cyan-300">
              Overview setup
            </p>
            <h2
              ref={headingRef}
              tabIndex={-1}
              className="mt-1 truncate text-lg font-semibold outline-none"
            >
              {title}
            </h2>
          </div>
        </div>
      </header>

      {error ? <StatusNotice tone="error" message={error} /> : null}
      {notice ? <StatusNotice tone="success" message={notice} /> : null}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {loading ? "Loading fixed costs" : ""}
      </div>

      {mode.name === "create" ? (
        <div className={cardClass}>
          <FixedCostEditor
            mode={mode}
            categories={categories}
            asOf={asOf}
            saving={saving}
            onBack={() => setMode({ name: "list" })}
            onSubmit={(value) =>
              runMutation({
                operation: "fixed-cost-create",
                path: "/api/mobile/expenses/fixed-costs",
                method: "POST",
                body: value,
                successMessage: `${value.name} was added to fixed costs.`,
              })
            }
          />
        </div>
      ) : mode.name === "revise" ? (
        <div className={cardClass}>
          <FixedCostEditor
            mode={mode}
            categories={categories}
            asOf={asOf}
            saving={saving}
            onBack={() => setMode({ name: "list" })}
            onEnd={() => setMode({ name: "end", cost: mode.cost })}
            onSubmit={(value) => {
              const body = {
                action: "revise",
                expectedVersion: mode.cost.version,
                ...value,
              };
              return runMutation({
                operation: `fixed-cost-revise:${mode.cost.seriesId}`,
                path: `/api/mobile/expenses/fixed-costs/${encodeURIComponent(mode.cost.seriesId)}`,
                method: "PATCH",
                body,
                version: mode.cost.version,
                successMessage: `${value.name} was updated.`,
              });
            }}
          />
        </div>
      ) : mode.name === "end" ? (
        <div className={cardClass}>
          <EndFixedCost
            cost={mode.cost}
            asOf={asOf}
            saving={saving}
            onBack={() => setMode({ name: "revise", cost: mode.cost })}
            onSubmit={(effectiveStartDate) => {
              const body = {
                action: "end",
                expectedVersion: mode.cost.version,
                effectiveStartDate,
              };
              return runMutation({
                operation: `fixed-cost-end:${mode.cost.seriesId}`,
                path: `/api/mobile/expenses/fixed-costs/${encodeURIComponent(mode.cost.seriesId)}`,
                method: "PATCH",
                body,
                version: mode.cost.version,
                successMessage: `${mode.cost.name} was ended.`,
              });
            }}
          />
        </div>
      ) : payload ? (
        <>
          <section className={cardClass} aria-labelledby="fixed-cost-summary">
            <h3
              id="fixed-cost-summary"
              className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400"
            >
              Current run rate
            </h3>
            <p className="mt-2 text-2xl font-bold text-white">
              {formatExpenseMoney(payload.summary.monthlyAmountCents)}
              <span className="ml-1 text-sm font-semibold text-slate-400">
                / month
              </span>
            </p>
            <p className="mt-1 text-sm leading-6 text-slate-300">
              {payload.summary.activeCount} active fixed cost
              {payload.summary.activeCount === 1 ? "" : "s"} ·{" "}
              {formatExpenseMoney(payload.summary.dailyAccrualCents)} accrued on{" "}
              {payload.asOf}
            </p>
          </section>

          <button
            type="button"
            onClick={() => {
              setError(null);
              setNotice(null);
              setMode({ name: "create" });
            }}
            className={primaryButton}
          >
            <span className="inline-flex items-center gap-2">
              <Plus aria-hidden="true" className="size-5" />
              Add fixed cost
            </span>
          </button>

          <section className={cardClass} aria-labelledby="active-fixed-costs">
            <h3 id="active-fixed-costs" className="text-base font-semibold">
              Active fixed costs
            </h3>
            <div className="mt-3 space-y-2">
              {activeCosts.length ? (
                activeCosts.map((cost) => (
                  <CostRow
                    key={cost.seriesId}
                    cost={cost}
                    onEdit={() => {
                      setError(null);
                      setNotice(null);
                      setMode({ name: "revise", cost });
                    }}
                  />
                ))
              ) : (
                <p className="rounded-lg border border-dashed border-white/15 bg-slate-950 p-4 text-sm leading-6 text-slate-400">
                  No fixed costs are active yet. Add rent, insurance, software,
                  and other steady monthly overhead here.
                </p>
              )}
            </div>
          </section>

          {endedCosts.length ? (
            <details className={cardClass}>
              <summary
                className={`${focusRing} flex min-h-11 cursor-pointer items-center text-sm font-semibold text-slate-200`}
              >
                Past fixed costs ({endedCosts.length})
              </summary>
              <div className="mt-3 space-y-2 border-t border-white/10 pt-3">
                {endedCosts.map((cost) => (
                  <CostRow key={cost.seriesId} cost={cost} />
                ))}
              </div>
            </details>
          ) : null}
        </>
      ) : loading ? (
        <div className={`${cardClass} text-sm text-slate-300`}>
          Loading fixed costs…
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setLoading(true);
            setError(null);
            void reload()
              .catch((reason: unknown) =>
                setError(
                  reason instanceof Error
                    ? reason.message
                    : "Fixed costs are unavailable.",
                ),
              )
              .finally(() => setLoading(false));
          }}
          className={primaryButton}
        >
          Retry fixed costs
        </button>
      )}
    </div>
  );
}
