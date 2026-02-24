"use client";

import Link from "next/link";
import { useCallback } from "react";
import { Badge, Button, cn } from "@myst-os/ui";

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    dataLayer?: unknown[];
  }
}

type HeroCtaType = "schedule" | "call" | "text";

const trustBadges: Array<{
  label: string;
  tone: "highlight" | "default" | "neutral";
}> = [
  { label: "Google 5.0 • 13 reviews", tone: "highlight" },
  { label: "No-Surprise Pricing", tone: "default" },
  { label: "Licensed & Insured", tone: "default" },
  { label: "Background-checked", tone: "neutral" },
  { label: "Same-day available", tone: "neutral" },
  { label: "<24h response", tone: "neutral" },
];

function trackHeroEvent(type: HeroCtaType) {
  try {
    if (typeof window === "undefined") {
      return;
    }

    const payload = {
      event_category: "hero",
      event_label: `hero_${type}_cta`,
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

export function HeroV2({
  className,
  variant = "lean",
}: {
  className?: string;
  variant?: "lean" | "full";
}) {
  const isLean = variant === "lean";
  const handleSchedule = useCallback(() => trackHeroEvent("schedule"), []);
  const handleCall = useCallback(() => trackHeroEvent("call"), []);
  const handleText = useCallback(() => trackHeroEvent("text"), []);

  return (
    <section
      className={cn(
        "relative overflow-hidden rounded-3xl bg-gradient-to-br from-neutral-50 via-white to-neutral-100 ring-1 ring-black/5 shadow-xl",
        className,
      )}
    >
      <div
        className={cn(
          "mx-auto grid items-center gap-8 sm:gap-10 px-6 sm:px-10 md:px-12 py-12 sm:py-16 md:py-20 min-h-[60svh] md:min-h-[560px]",
          isLean
            ? "max-w-6xl"
            : "max-w-6xl md:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]",
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
              Book online in under a minute. Licensed and insured crews with
              same-day availability in Woodstock and nearby North Metro
              communities.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
            <Button
              asChild
              size="lg"
              className="w-full justify-center shadow-soft sm:w-auto"
              onClick={handleSchedule}
            >
              <Link href="/book">Get Instant Quote</Link>
            </Button>
            <Button
              asChild
              variant="ghost"
              size="lg"
              className="w-full justify-center border border-neutral-300/70 text-primary-800 sm:w-auto"
              onClick={handleCall}
            >
              <a href="tel:+14047772631">Call (404) 777-2631</a>
            </Button>
            {isLean ? null : (
              <Button
                asChild
                variant="ghost"
                size="lg"
                className="w-full justify-center border border-neutral-300/70 text-primary-800 sm:w-auto"
                onClick={handleText}
              >
                <a href="sms:+14047772631">Text Us</a>
              </Button>
            )}
          </div>

          <div className="flex flex-wrap items-start gap-2 sm:gap-3">
            {trustBadges.map((badge) => (
              <Badge
                key={badge.label}
                tone={badge.tone}
                className="max-w-full whitespace-normal text-[0.62rem] leading-tight tracking-[0.14em] sm:text-overline sm:tracking-[0.18em]"
              >
                {badge.label}
              </Badge>
            ))}
          </div>
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
                    Clear scope. Clear price. Fast pickup.
                  </h2>
                </div>
                <ul className="space-y-2 text-sm text-neutral-600">
                  <li>
                    - Before work begins, we confirm included items and your
                    total price.
                  </li>
                  <li>- Any added items are re-quoted and approved first.</li>
                  <li>- No travel fees in our core service area.</li>
                </ul>
                <div className="rounded-lg bg-neutral-50 p-4 text-sm text-neutral-600">
                  <p className="font-semibold text-neutral-700">
                    &ldquo;The two guys who helped me were great! Very polite
                    and eager to help.&rdquo;
                  </p>
                  <p className="mt-2 text-xs uppercase tracking-[0.18em] text-neutral-500">
                    Ashlyn Hickmon • Google Review
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
