"use client";

import Link from "next/link";
import Image from "next/image";
import { ArrowUpRight, ShieldCheck } from "lucide-react";
import { useCallback } from "react";
import { Button, cn } from "@myst-os/ui";
import { isAnalyticsAllowed, isPublicTrackingPath } from "@/lib/cookie-consent";

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    dataLayer?: unknown[];
  }
}

type HeroCtaType = "schedule" | "call" | "text";

const GOOGLE_REVIEW_RATING =
  process.env["NEXT_PUBLIC_GOOGLE_REVIEW_RATING"]?.trim() || "5.0";
const GOOGLE_REVIEW_COUNT =
  process.env["NEXT_PUBLIC_GOOGLE_REVIEW_COUNT"]?.trim() || "15";

function trackHeroEvent(type: HeroCtaType) {
  try {
    const gaId = process.env["NEXT_PUBLIC_GA4_ID"]?.trim();
    if (
      typeof window === "undefined" ||
      !isAnalyticsAllowed() ||
      !isPublicTrackingPath(window.location.pathname) ||
      !gaId ||
      !/^G-[A-Z0-9]+$/u.test(gaId) ||
      gaId === "G-E2ETEST"
    ) {
      return;
    }

    const payload = {
      event_category: "hero",
      event_label: `hero_${type}_cta`,
      send_to: gaId,
    };

    if (typeof window.gtag === "function") {
      window.gtag("event", "click", payload);
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
  const handleSchedule = useCallback(() => trackHeroEvent("schedule"), []);
  const handleCall = useCallback(() => trackHeroEvent("call"), []);
  const phone = process.env["NEXT_PUBLIC_COMPANY_PHONE_E164"] || "+14047772631";

  return (
    <section className={cn("public-hero", className)} data-variant={variant}>
      <div className="public-hero-copy">
        <p className="public-eyebrow">Junk removal · North Metro Atlanta</p>
        <h1>
          Less clutter.
          <br />
          <em>More possibility.</em>
        </h1>
        <p className="public-hero-description">
          A garage you can park in. A room you can use again. We do the lifting,
          loading, and hauling—so you can enjoy your space.
        </p>
        <div className="public-hero-actions">
          <Button
            asChild
            size="lg"
            className="public-hero-primary"
            onClick={handleSchedule}
          >
            <Link href="/book">
              Get my instant quote <ArrowUpRight size={18} aria-hidden="true" />
            </Link>
          </Button>
          <Button
            asChild
            size="lg"
            variant="ghost"
            className="public-hero-secondary"
            onClick={handleCall}
          >
            <a href={`tel:${phone}`}>Call the crew</a>
          </Button>
        </div>
        <div className="public-hero-rating">
          <span className="public-stars" aria-label="5 stars">
            ★★★★★
          </span>
          <span>
            {GOOGLE_REVIEW_RATING} on Google · {GOOGLE_REVIEW_COUNT} reviews
          </span>
        </div>
      </div>
      <div className="public-hero-image">
        <Image
          src="/images/gallery/trailer_16x9.jpg"
          alt="Stonegate’s junk removal trailer ready for a local pickup"
          fill
          priority
          sizes="(min-width: 768px) 560px, 100vw"
        />
        <div className="public-hero-image-note">
          <ShieldCheck size={28} strokeWidth={1.5} aria-hidden="true" />
          <div>
            <strong>Your space. Our care.</strong>
            <p>Careful pickup. Clear pricing. A fresh start.</p>
          </div>
        </div>
      </div>
    </section>
  );
}
