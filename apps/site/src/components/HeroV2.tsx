'use client';

import Link from "next/link";
import { useCallback } from "react";
import { Badge, Button, cn } from "@myst-os/ui";

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    dataLayer?: Array<Record<string, unknown>>;
  }
}

type HeroCtaType = "schedule" | "call" | "text";

function trackHeroEvent(type: HeroCtaType) {
  try {
    if (typeof window === "undefined") {
      return;
    }

    const payload = {
      event_category: "hero",
      event_label: `hero_${type}_cta`
    };

    if (typeof window.gtag === "function") {
      window.gtag("event", "click", payload);
    } else if (Array.isArray(window.dataLayer)) {
      window.dataLayer.push({ event: "hero_cta_click", type, ...payload });
    }
  } catch (error) {
    console.warn("Hero CTA tracking failed", error);
  }
}

export function HeroV2({ className, variant = "lean" }: { className?: string; variant?: "lean" | "full" }) {
  const isLean = variant === "lean";
  const handleSchedule = useCallback(() => trackHeroEvent("schedule"), []);
  const handleCall = useCallback(() => trackHeroEvent("call"), []);
  const handleText = useCallback(() => trackHeroEvent("text"), []);

  return (
    <section
      className={cn(
        "relative overflow-hidden rounded-3xl bg-gradient-to-br from-neutral-50 via-white to-neutral-100 ring-1 ring-black/5 shadow-xl",
        className
      )}
    >
      <div
        className={cn(
          "mx-auto grid items-center gap-8 sm:gap-10 px-6 sm:px-10 md:px-12 py-12 sm:py-16 md:py-20 min-h-[60svh] md:min-h-[560px]",
          isLean ? "max-w-6xl" : "max-w-6xl md:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]"
        )}
      >
        <div className="space-y-6">
          <div className="space-y-4">
            <span className="inline-flex items-center rounded-full bg-neutral-100 px-3 py-1 text-sm font-semibold uppercase tracking-[0.14em] text-neutral-700">
              Fast junk removal
            </span>
            <h1 className="font-display text-3xl tracking-tight text-primary-900 sm:text-5xl md:text-6xl">
              Junk removal that clears clutter fast and responsibly
            </h1>
            <p className="max-w-xl text-base text-neutral-600 sm:text-lg">
              On-site estimate in under 24 hours. Licensed & insured. Serving Roswell, Alpharetta, Milton & nearby.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
            <Button
              asChild
              size="lg"
              className="w-full justify-center shadow-soft sm:w-auto"
              onClick={handleSchedule}
            >
              <Link href="#schedule-estimate">Get My Estimate</Link>
            </Button>
            <Button
              asChild
              variant="ghost"
              size="lg"
              className="w-full justify-center border border-neutral-300/70 text-primary-800 sm:w-auto"
              onClick={handleCall}
            >
              <a href="tel:16785417725">Call (678) 541-7725</a>
            </Button>
            {isLean ? null : (
              <Button
                asChild
                variant="ghost"
                size="lg"
                className="w-full justify-center border border-neutral-300/70 text-primary-800 sm:w-auto"
                onClick={handleText}
              >
                <a href="sms:16785417725">Text Us</a>
              </Button>
            )}
          </div>

          {isLean ? null : (
            <div className="flex flex-wrap gap-3">
              <Badge tone="highlight">4.9 avg (1,247 reviews)</Badge>
              <Badge tone="default">Licensed & Insured</Badge>
              <Badge tone="neutral">Make-It-Right Guarantee</Badge>
              <Badge tone="default">On-Site in &lt; 24 hrs</Badge>
            </div>
          )}
        </div>

        {isLean ? null : (
          <div className="hidden md:block">
            <div className="rounded-2xl border border-neutral-200/80 bg-white/90 p-6 shadow-soft">
              <div className="space-y-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent-700">
                    Why homeowners choose Stonegate
                  </p>
                  <h2 className="mt-2 text-xl font-semibold text-primary-900">
                    Trusted crews. Spotless finishes. Guaranteed.
                  </h2>
                </div>
                <ul className="space-y-2 text-sm text-neutral-600">
                  <li>- Fast, careful hauling with licensed and insured crews.</li>
                  <li>- Responsible disposal and recycling whenever possible.</li>
                  <li>- Make-It-Right Guarantee: we fix issues within 48 hours.</li>
                </ul>
                <div className="rounded-lg bg-neutral-50 p-4 text-sm text-neutral-600">
                  <p className="font-semibold text-neutral-700">&ldquo;Their crew was on time, communicative, and left everything spotless.&rdquo;</p>
                  <p className="mt-2 text-xs uppercase tracking-[0.18em] text-neutral-500">Brianna S. - Woodstock</p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

