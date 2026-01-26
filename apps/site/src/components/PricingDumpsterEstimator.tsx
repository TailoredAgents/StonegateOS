'use client';

import * as React from "react";
import Link from "next/link";
import Image from "next/image";
import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button, cn } from "@myst-os/ui";

import {
  ADDONS,
  type AddonId,
  type LoadTier,
  PRICING_ESTIMATOR_QUERY_KEYS,
  computeAddonTotal,
  getTierById,
  getTierBySliderValue,
  normalizeTierId
} from "@/lib/pricing-estimator";

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    dataLayer?: Array<Record<string, unknown>>;
  }
}

const TRACKING_QUERY_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid"
];

function buildBookHref(tier: LoadTier, addons: Record<AddonId, number>, searchParams: URLSearchParams) {
  const query = new URLSearchParams();
  for (const key of TRACKING_QUERY_KEYS) {
    const value = searchParams.get(key);
    if (value) query.set(key, value);
  }

  query.set("intent", "pricing-estimator");
  query.set(PRICING_ESTIMATOR_QUERY_KEYS.load, tier.id);
  if (addons.mattress > 0) query.set(PRICING_ESTIMATOR_QUERY_KEYS.mattress, String(addons.mattress));
  if (addons.paint > 0) query.set(PRICING_ESTIMATOR_QUERY_KEYS.paint, String(addons.paint));
  if (addons.tire > 0) query.set(PRICING_ESTIMATOR_QUERY_KEYS.tire, String(addons.tire));

  const queryString = query.toString();
  return queryString ? `/book?${queryString}` : "/book";
}

function trackPricingEstimatorEvent(action: string, payload: Record<string, unknown>) {
  try {
    if (typeof window === "undefined") {
      return;
    }

    const eventPayload = {
      event_category: "pricing_estimator",
      event_label: action,
      ...payload
    };

    if (typeof window.gtag === "function") {
      window.gtag("event", action, eventPayload);
    } else if (Array.isArray(window.dataLayer)) {
      window.dataLayer.push({ event: "pricing_estimator", action, ...eventPayload });
    }
  } catch (error) {
    console.warn("Pricing estimator tracking failed", error);
  }
}

function clampInt(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function formatUsd(value: number) {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function parseCount(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return null;
  return clampInt(parsed, 0, 99);
}

function buildEstimatorSearchParams(tier: LoadTier, addons: Record<AddonId, number>, base: URLSearchParams) {
  const next = new URLSearchParams(base.toString());
  next.set(PRICING_ESTIMATOR_QUERY_KEYS.load, tier.id);

  const entries = [
    [PRICING_ESTIMATOR_QUERY_KEYS.mattress, addons.mattress],
    [PRICING_ESTIMATOR_QUERY_KEYS.paint, addons.paint],
    [PRICING_ESTIMATOR_QUERY_KEYS.tire, addons.tire]
  ] as const;

  for (const [key, count] of entries) {
    if (count > 0) next.set(key, String(count));
    else next.delete(key);
  }

  return next;
}

function buildEstimateHref(tier: LoadTier, addons: Record<AddonId, number>, searchParams: URLSearchParams) {
  const query = new URLSearchParams();
  for (const key of TRACKING_QUERY_KEYS) {
    const value = searchParams.get(key);
    if (value) query.set(key, value);
  }

  query.set("intent", "pricing-estimator");
  query.set(PRICING_ESTIMATOR_QUERY_KEYS.load, tier.id);
  if (addons.mattress > 0) query.set(PRICING_ESTIMATOR_QUERY_KEYS.mattress, String(addons.mattress));
  if (addons.paint > 0) query.set(PRICING_ESTIMATOR_QUERY_KEYS.paint, String(addons.paint));
  if (addons.tire > 0) query.set(PRICING_ESTIMATOR_QUERY_KEYS.tire, String(addons.tire));

  const queryString = query.toString();
  return queryString ? `/estimate?${queryString}` : "/estimate";
}

type AddonCountersProps = {
  value: Record<AddonId, number>;
  onChange: (next: Record<AddonId, number>) => void;
};

function AddonCounters({ value, onChange }: AddonCountersProps) {
  const update = (id: AddonId, nextCount: number) => {
    const safeCount = clampInt(nextCount, 0, 99);
    onChange({ ...value, [id]: safeCount });
  };

  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-neutral-500">Add-ons</p>
      <div className="space-y-2">
        {ADDONS.map((addon) => (
          <div
            key={addon.id}
            className="flex items-center justify-between gap-3 rounded-xl border border-neutral-200 bg-white px-3 py-3 shadow-soft"
          >
            <div>
              <p className="text-sm font-semibold text-primary-900">{addon.label}</p>
              <p className="text-xs text-neutral-500">{formatUsd(addon.unitPrice)} each</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-neutral-300/70 bg-white text-lg font-semibold text-primary-900 shadow-soft transition hover:border-primary-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500 disabled:opacity-50"
                onClick={() => update(addon.id, (value[addon.id] ?? 0) - 1)}
                disabled={(value[addon.id] ?? 0) <= 0}
                aria-label={`Remove one ${addon.label.toLowerCase()}`}
              >
                −
              </button>
              <label className="sr-only" htmlFor={`addon-${addon.id}`}>
                {addon.label} count
              </label>
              <input
                id={`addon-${addon.id}`}
                type="number"
                min={0}
                max={99}
                inputMode="numeric"
                value={value[addon.id] ?? 0}
                onChange={(event) => update(addon.id, Number.parseInt(event.target.value, 10))}
                className="h-9 w-14 rounded-md border border-neutral-300 bg-white px-2 text-center text-sm font-semibold text-neutral-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
              />
              <button
                type="button"
                className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-neutral-300/70 bg-white text-lg font-semibold text-primary-900 shadow-soft transition hover:border-primary-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
                onClick={() => update(addon.id, (value[addon.id] ?? 0) + 1)}
                aria-label={`Add one ${addon.label.toLowerCase()}`}
              >
                +
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DumpsterSvg({ fillRatio, className }: { fillRatio: number; className?: string }) {
  const safeRatio = Math.min(1, Math.max(0, fillRatio));
  const top = 82;
  const bottom = 170;
  const fillHeight = (bottom - top) * safeRatio;
  const fillY = bottom - fillHeight;

  return (
    <svg
      viewBox="0 0 320 220"
      className={cn("h-full w-full", className)}
      role="img"
      aria-label="Trailer load visual"
    >
      <defs>
        <linearGradient id="dumpster-front" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0f4c5c" />
          <stop offset="100%" stopColor="#06323c" />
        </linearGradient>
        <linearGradient id="dumpster-right" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#0b3f4c" />
          <stop offset="100%" stopColor="#052a33" />
        </linearGradient>
        <linearGradient id="dumpster-left" x1="1" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#125a6c" />
          <stop offset="100%" stopColor="#0a3b46" />
        </linearGradient>
        <linearGradient id="dumpster-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.92" />
          <stop offset="100%" stopColor="#b45309" stopOpacity="0.96" />
        </linearGradient>
        <clipPath id="front-window">
          <polygon points="122,82 252,82 234,170 108,170" />
        </clipPath>
      </defs>

      {/* Shadow */}
      <ellipse cx="170" cy="195" rx="110" ry="18" fill="#0f172a" opacity="0.12" />

      {/* Left face */}
      <polygon points="60,40 110,70 90,180 40,150" fill="url(#dumpster-left)" />
      {/* Right face */}
      <polygon points="210,40 260,70 240,180 190,150" fill="url(#dumpster-right)" />
      {/* Front face */}
      <polygon points="110,70 260,70 240,180 90,180" fill="url(#dumpster-front)" />

      {/* Fill window */}
      <g clipPath="url(#front-window)">
        <rect
          x={0}
          y={fillY}
          width={320}
          height={220 - fillY}
          fill="url(#dumpster-fill)"
          className="motion-safe:transition-[y,height] motion-safe:duration-300 motion-safe:ease-out"
        />
        <rect x={0} y={0} width={320} height={220} fill="#000" opacity="0.08" />
      </g>

      {/* Rim */}
      <polygon
        points="60,40 210,40 260,70 110,70"
        fill="#0b3440"
        opacity="0.92"
      />
      <polygon points="78,50 198,50 238,72 118,72" fill="#041c22" opacity="0.92" />

      {/* Accent lines */}
      <polyline points="110,70 90,180" fill="none" stroke="#ffffff" opacity="0.10" strokeWidth="2" />
      <polyline points="260,70 240,180" fill="none" stroke="#ffffff" opacity="0.08" strokeWidth="2" />
      <polyline points="60,40 40,150" fill="none" stroke="#ffffff" opacity="0.10" strokeWidth="2" />
      <polyline points="210,40 190,150" fill="none" stroke="#ffffff" opacity="0.07" strokeWidth="2" />
    </svg>
  );
}

export function PricingDumpsterEstimator({ className }: { className?: string }) {
  return (
    <React.Suspense fallback={<PricingDumpsterEstimatorFallback className={className} />}>
      <PricingDumpsterEstimatorInner className={className} />
    </React.Suspense>
  );
}

function PricingDumpsterEstimatorFallback({ className }: { className?: string }) {
  return (
    <div className={cn("space-y-5", className)}>
      <div className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-500">Interactive estimator</p>
        <h2 className="font-display text-2xl text-primary-900">Estimate your trailer volume</h2>
        <p className="text-sm text-neutral-600">
          Drag the slider to match your load size. Add common surcharges to see a more realistic range.
        </p>
      </div>
      <div className="rounded-2xl border border-neutral-200 bg-gradient-to-br from-white via-neutral-50 to-neutral-100 p-4 shadow-soft">
        <p className="text-sm text-neutral-600">Loading estimator…</p>
      </div>
      <Button asChild size="lg" className="min-w-[220px] justify-center">
        <Link href="/book">Get instant quote</Link>
      </Button>
    </div>
  );
}

function PricingDumpsterEstimatorInner({ className }: { className?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [tier, setTier] = React.useState<LoadTier>(() => getTierById("quarter"));
  const [addons, setAddons] = React.useState<Record<AddonId, number>>({
    mattress: 0,
    paint: 0,
    tire: 0
  });
  const hydratedRef = React.useRef(false);
  const urlSyncEnabledRef = React.useRef(false);

  const addonTotal = React.useMemo(() => computeAddonTotal(addons), [addons]);
  const totalMin = tier.min + addonTotal;
  const totalMax = tier.max + addonTotal;

  const ariaSummary = `Estimated price range ${formatUsd(totalMin)} to ${formatUsd(totalMax)} for ${tier.label}.`;

  const reset = () => {
    urlSyncEnabledRef.current = true;
    setTier(getTierById("quarter"));
    setAddons({ mattress: 0, paint: 0, tire: 0 });
    trackPricingEstimatorEvent("reset", {});
  };

  React.useEffect(() => {
    const params = searchParams;
    const hasEstimatorParams =
      params.has(PRICING_ESTIMATOR_QUERY_KEYS.load) ||
      params.has(PRICING_ESTIMATOR_QUERY_KEYS.mattress) ||
      params.has(PRICING_ESTIMATOR_QUERY_KEYS.paint) ||
      params.has(PRICING_ESTIMATOR_QUERY_KEYS.tire);
    const tierId = normalizeTierId(params.get(PRICING_ESTIMATOR_QUERY_KEYS.load));
    const mattress = parseCount(params.get(PRICING_ESTIMATOR_QUERY_KEYS.mattress));
    const paint = parseCount(params.get(PRICING_ESTIMATOR_QUERY_KEYS.paint));
    const tire = parseCount(params.get(PRICING_ESTIMATOR_QUERY_KEYS.tire));

    const nextTier = tierId ? getTierById(tierId) : getTierById("quarter");
    const nextAddons = {
      mattress: mattress ?? 0,
      paint: paint ?? 0,
      tire: tire ?? 0
    } satisfies Record<AddonId, number>;

    if (hasEstimatorParams) {
      urlSyncEnabledRef.current = true;
    }
    hydratedRef.current = true;
    setTier((prev) => (prev.id === nextTier.id ? prev : nextTier));
    setAddons((prev) => {
      const same =
        prev.mattress === nextAddons.mattress && prev.paint === nextAddons.paint && prev.tire === nextAddons.tire;
      return same ? prev : nextAddons;
    });
  }, [searchParams]);

  React.useEffect(() => {
    if (!hydratedRef.current) {
      return;
    }
    if (pathname !== "/pricing") {
      return;
    }
    if (!urlSyncEnabledRef.current) {
      return;
    }

    const current = new URLSearchParams(searchParams.toString());
    const next = buildEstimatorSearchParams(tier, addons, current);
    if (next.toString() === current.toString()) {
      return;
    }

    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }, [addons, pathname, router, searchParams, tier]);

  const estimateHref = React.useMemo(
    () => buildEstimateHref(tier, addons, new URLSearchParams(searchParams.toString())),
    [addons, searchParams, tier]
  );

  const bookHref = React.useMemo(
    () => buildBookHref(tier, addons, new URLSearchParams(searchParams.toString())),
    [addons, searchParams, tier]
  );

  const handleTierChange = (nextTier: LoadTier) => {
    urlSyncEnabledRef.current = true;
    setTier(nextTier);
    trackPricingEstimatorEvent("tier_change", {
      tier: nextTier.id,
      sliderValue: nextTier.sliderValue
    });
  };

  const handleAddonsChange = (next: Record<AddonId, number>) => {
    urlSyncEnabledRef.current = true;
    setAddons(next);
    trackPricingEstimatorEvent("addons_change", {
      mattress: next.mattress,
      paint: next.paint,
      tire: next.tire
    });
  };

  return (
    <div className={cn("space-y-5", className)}>
      <div className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-500">Interactive estimator</p>
        <h2 className="font-display text-2xl text-primary-900">Estimate your trailer volume</h2>
        <p className="text-sm text-neutral-600">
          Drag the slider to match your load size. Add common surcharges to see a more realistic range.
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <div className="space-y-4">
          <div className="rounded-2xl border border-neutral-200 bg-gradient-to-br from-white via-neutral-50 to-neutral-100 p-4 shadow-soft">
            <div className="mx-auto aspect-[16/11] max-w-md">
              <DumpsterSvg fillRatio={tier.sliderValue / 100} />
            </div>

            <div className="mt-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-primary-900">Load size: {tier.label}</p>
                <p
                  className="rounded-full bg-primary-50 px-3 py-1 text-sm font-semibold text-primary-900 ring-1 ring-primary-100"
                  role="status"
                  aria-live="polite"
                >
                  Pricing: {formatUsd(totalMin)}–{formatUsd(totalMax)}
                </p>
              </div>

              <label className="sr-only" htmlFor="dumpster-load-slider">
                Trailer load size
              </label>
              <input
                id="dumpster-load-slider"
                type="range"
                min={25}
                max={100}
                step={25}
                value={tier.sliderValue}
                onChange={(event) => {
                  const next = clampInt(Number.parseInt(event.target.value, 10), 25, 100);
                  handleTierChange(getTierBySliderValue(next));
                }}
                className="w-full accent-accent-500"
                aria-valuemin={25}
                aria-valuemax={100}
                aria-valuenow={tier.sliderValue}
                aria-valuetext={tier.label}
              />
              <div className="flex justify-between text-xs font-semibold uppercase tracking-[0.22em] text-neutral-500">
                <button
                  type="button"
                  className="hover:text-primary-700"
                  onClick={() => handleTierChange(getTierById("quarter"))}
                >
                  ¼
                </button>
                <button type="button" className="hover:text-primary-700" onClick={() => handleTierChange(getTierById("half"))}>
                  ½
                </button>
                <button
                  type="button"
                  className="hover:text-primary-700"
                  onClick={() => handleTierChange(getTierById("threeQuarter"))}
                >
                  ¾
                </button>
                <button type="button" className="hover:text-primary-700" onClick={() => handleTierChange(getTierById("full"))}>
                  Full
                </button>
              </div>
              <p className="sr-only">{ariaSummary}</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button asChild size="lg" className="min-w-[220px] justify-center">
              <Link
                href={bookHref as Route}
                onClick={() => {
                  trackPricingEstimatorEvent("quote_click", {
                    tier: tier.id,
                    mattress: addons.mattress,
                    paint: addons.paint,
                    tire: addons.tire,
                    estimateMin: totalMin,
                    estimateMax: totalMax
                  });
                }}
              >
                Get instant quote
              </Link>
            </Button>
            <Button
              asChild
              variant="secondary"
              size="lg"
              className="min-w-[160px] justify-center"
            >
              <a
                href="tel:+14047772631"
                onClick={() => {
                  trackPricingEstimatorEvent("call_click", {
                    tier: tier.id,
                    mattress: addons.mattress,
                    paint: addons.paint,
                    tire: addons.tire
                  });
                }}
              >
                Call now
              </a>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="lg"
              className="min-w-[160px] justify-center"
              onClick={reset}
            >
              Reset
            </Button>
          </div>
          <p className="text-xs text-neutral-500">
            This is an estimate range. Final pricing is confirmed on-site based on access and material type.
          </p>
          <p className="text-xs text-neutral-500">
            Prefer an on-site estimate?{" "}
            <Link className="font-semibold text-primary-700 hover:text-primary-800" href={estimateHref as Route}>
              Schedule an estimate
            </Link>
            .
          </p>
        </div>

        <div className="space-y-4 md:pt-1">
          <div className="sticky top-24 z-10 rounded-2xl border border-neutral-200 bg-white/95 p-4 shadow-soft backdrop-blur md:static md:bg-transparent md:p-0 md:shadow-none">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-neutral-500">Summary</p>
                <p className="mt-1 text-sm font-semibold text-primary-900">
                  {tier.label} + add-ons
                </p>
                <p className="mt-1 text-xs text-neutral-500">
                  Base {formatUsd(tier.min)}–{formatUsd(tier.max)} · Add-ons {formatUsd(addonTotal)}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-neutral-500">Total</p>
                <p className="mt-1 text-lg font-semibold text-primary-900">
                  {formatUsd(totalMin)}–{formatUsd(totalMax)}
                </p>
              </div>
            </div>
          </div>

          <AddonCounters value={addons} onChange={handleAddonsChange} />
        </div>
      </div>

      <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-soft">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-neutral-500">Trailer reference</p>
        <div className="mt-3 relative aspect-[16/9] overflow-hidden rounded-xl">
          <Image
            src="/images/gallery/trailer_16x9.jpg"
            alt="Stonegate trailer used for junk removal pricing by volume"
            fill
            className="object-cover"
            sizes="(min-width: 768px) 768px, 100vw"
            priority={false}
          />
        </div>
        <p className="mt-3 text-xs text-neutral-500">
          Pricing is primarily based on how full the trailer is. Access and material type can affect labor and disposal.
        </p>
      </div>
    </div>
  );
}
