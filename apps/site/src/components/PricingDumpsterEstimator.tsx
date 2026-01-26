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
  const interiorTop = 86;
  const interiorBottom = 160;
  const fillHeight = (interiorBottom - interiorTop) * safeRatio;
  const fillY = interiorBottom - fillHeight;

  return (
    <svg
      viewBox="0 0 640 280"
      className={cn("h-full w-full", className)}
      role="img"
      aria-label="Trailer load visual"
    >
      <defs>
        <linearGradient id="pe-trailer-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#a8acb3" />
          <stop offset="45%" stopColor="#7b808a" />
          <stop offset="100%" stopColor="#676c76" />
        </linearGradient>
        <linearGradient id="pe-trailer-body-shadow" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#525764" stopOpacity="0.96" />
          <stop offset="100%" stopColor="#2f3440" stopOpacity="0.96" />
        </linearGradient>
        <linearGradient id="pe-trailer-frame" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#1f2937" />
          <stop offset="100%" stopColor="#0b1220" />
        </linearGradient>
        <linearGradient id="pe-trailer-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.92" />
          <stop offset="100%" stopColor="#b45309" stopOpacity="0.96" />
        </linearGradient>
        <clipPath id="pe-trailer-interior">
          <polygon points="110,86 510,86 520,160 100,160" />
        </clipPath>
        <clipPath id="pe-trailer-fill-area">
          <rect x="0" y={fillY} width="640" height={interiorBottom - fillY} />
        </clipPath>
      </defs>

      {/* Shadow */}
      <ellipse cx="320" cy="250" rx="260" ry="18" fill="#0f172a" opacity="0.12" />

      {/* Tongue / hitch */}
      <path
        d="M520 180 L625 212 L620 226 L505 196 Z"
        fill="url(#pe-trailer-frame)"
        opacity="0.95"
      />
      <rect x="602" y="206" width="20" height="10" rx="3" fill="#0b1220" opacity="0.9" />
      <rect x="590" y="214" width="10" height="26" rx="3" fill="#111827" opacity="0.92" />

      {/* Frame */}
      <rect x="85" y="176" width="448" height="18" rx="7" fill="url(#pe-trailer-frame)" />
      <rect x="90" y="170" width="440" height="7" rx="3.5" fill="#0b1220" opacity="0.92" />

      {/* Wheels + fender */}
      <g>
        <path
          d="M230 206 C250 184 286 184 306 206 L306 220 L230 220 Z"
          fill="#111827"
          opacity="0.92"
        />
        <circle cx="258" cy="222" r="30" fill="#0b1220" />
        <circle cx="258" cy="222" r="22" fill="#111827" />
        <circle cx="258" cy="222" r="6" fill="#0b1220" opacity="0.95" />

        <path
          d="M298 206 C318 184 354 184 374 206 L374 220 L298 220 Z"
          fill="#111827"
          opacity="0.92"
        />
        <circle cx="326" cy="222" r="30" fill="#0b1220" />
        <circle cx="326" cy="222" r="22" fill="#111827" />
        <circle cx="326" cy="222" r="6" fill="#0b1220" opacity="0.95" />
      </g>

      {/* Body */}
      <polygon points="90,176 100,70 520,70 530,176" fill="url(#pe-trailer-body)" />
      <polygon points="510,70 520,70 530,176 520,176" fill="url(#pe-trailer-body-shadow)" opacity="0.85" />
      <polyline points="100,70 90,176" fill="none" stroke="#111827" strokeWidth="3" opacity="0.55" />
      <polyline points="520,70 530,176" fill="none" stroke="#111827" strokeWidth="3" opacity="0.55" />

      {/* Interior fill */}
      <g clipPath="url(#pe-trailer-interior)">
        <rect
          x={0}
          y={fillY}
          width={640}
          height={280 - fillY}
          fill="url(#pe-trailer-fill)"
          className="motion-safe:transition-[y,height] motion-safe:duration-300 motion-safe:ease-out"
        />
        <g clipPath="url(#pe-trailer-fill-area)" opacity="0.18" fill="#0f172a">
          <rect x="118" y="122" width="84" height="18" rx="6" />
          <rect x="218" y="134" width="98" height="16" rx="6" />
          <rect x="336" y="124" width="92" height="18" rx="6" />
          <rect x="438" y="138" width="78" height="16" rx="6" />
        </g>
        <rect x={0} y={0} width={640} height={280} fill="#000" opacity="0.06" />
      </g>

      {/* Top tarp */}
      <path
        d="M100 68 C140 52 470 52 520 68 L512 82 C470 68 142 68 108 82 Z"
        fill="#0b1220"
        opacity="0.94"
      />

      {/* Ribs + rails */}
      <g stroke="#111827" opacity="0.38" strokeWidth="3">
        <line x1="160" y1="76" x2="152" y2="176" />
        <line x1="230" y1="76" x2="224" y2="176" />
        <line x1="300" y1="76" x2="296" y2="176" />
        <line x1="370" y1="76" x2="368" y2="176" />
        <line x1="440" y1="76" x2="440" y2="176" />
      </g>
      <g stroke="#111827" opacity="0.25" strokeWidth="4">
        <line x1="110" y1="110" x2="510" y2="110" />
        <line x1="102" y1="148" x2="518" y2="148" />
      </g>

      {/* Reflective tape */}
      <g opacity="0.85">
        <rect x="155" y="155" width="52" height="6" rx="3" fill="#ef4444" />
        <rect x="218" y="155" width="58" height="6" rx="3" fill="#f97316" />
        <rect x="288" y="155" width="56" height="6" rx="3" fill="#ef4444" />
      </g>
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
  const selectedAddonSummary = React.useMemo(() => {
    const parts: string[] = [];
    if (addons.mattress > 0) parts.push(`${addons.mattress} mattress${addons.mattress === 1 ? "" : "es"}`);
    if (addons.paint > 0) parts.push(`${addons.paint} paint can${addons.paint === 1 ? "" : "s"}`);
    if (addons.tire > 0) parts.push(`${addons.tire} tire${addons.tire === 1 ? "" : "s"}`);
    return parts;
  }, [addons]);
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
            <div className="mx-auto aspect-[16/7] w-full max-w-xl">
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
          <div className="sticky top-24 z-10 rounded-2xl bg-white/90 p-5 shadow-soft ring-1 ring-neutral-200/70 backdrop-blur">
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
            <div className="mt-4 border-t border-neutral-200/70 pt-3 text-xs text-neutral-600">
              {selectedAddonSummary.length ? (
                <p>
                  Add-ons selected:{" "}
                  <span className="font-semibold text-neutral-900">{selectedAddonSummary.join(" · ")}</span>
                </p>
              ) : (
                <p>No add-ons selected.</p>
              )}
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
