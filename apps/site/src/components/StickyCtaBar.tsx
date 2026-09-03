"use client";

import Link from "next/link";
import type { Route } from "next";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useMemo } from "react";
import { Button, cn } from "@myst-os/ui";
import { PRICING_ESTIMATOR_QUERY_KEYS } from "@/lib/pricing-estimator";

interface StickyCtaBarProps {
  className?: string;
}

const FALLBACK_PHONE_E164 = "+14047772631";

function normalizePhoneE164(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return FALLBACK_PHONE_E164;
  if (trimmed.startsWith("+")) return trimmed;
  const digits = trimmed.replace(/[^\d]/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return trimmed;
}

export function StickyCtaBar({ className }: StickyCtaBarProps) {
  const pathname = usePathname();
  if (
    pathname === "/book" ||
    pathname === "/bookdemo" ||
    pathname.startsWith("/book/") ||
    pathname.startsWith("/quote")
  ) {
    return null;
  }

  const phoneE164 = normalizePhoneE164(
    process.env["NEXT_PUBLIC_COMPANY_PHONE_E164"] ?? FALLBACK_PHONE_E164,
  );

  return (
    <>
      <div
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 border-t border-neutral-300/50 bg-white/95 px-4 pt-3 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] shadow-[0_-10px_24px_rgba(15,23,42,0.10)] md:hidden",
          className,
        )}
      >
        <div className="mx-auto flex max-w-xl items-center justify-between gap-3">
          <Button
            asChild
            variant="ghost"
            className="flex-1 min-h-[48px] rounded-md border border-neutral-300/70 text-base font-semibold text-primary-800 hover:border-primary-300"
          >
            <a href={`tel:${phoneE164}`}>Call</a>
          </Button>
          <Suspense
            fallback={
              <Button
                asChild
                className="flex-1 min-h-[48px] rounded-md text-base font-semibold"
              >
                <Link href="/book">Get Quote</Link>
              </Button>
            }
          >
            <StickyGetQuoteButton className="flex-1 min-h-[48px] rounded-md text-base font-semibold" />
          </Suspense>
        </div>
      </div>
    </>
  );
}

function StickyGetQuoteButton({
  className,
  label = "Get Quote",
}: {
  className?: string;
  label?: string;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const quoteHref = useMemo(() => {
    if (pathname !== "/pricing") {
      return "/book";
    }

    const params = new URLSearchParams(searchParams.toString());
    const hasEstimatorParams =
      params.has(PRICING_ESTIMATOR_QUERY_KEYS.load) ||
      params.has(PRICING_ESTIMATOR_QUERY_KEYS.mattress) ||
      params.has(PRICING_ESTIMATOR_QUERY_KEYS.paint) ||
      params.has(PRICING_ESTIMATOR_QUERY_KEYS.tire);
    if (!hasEstimatorParams) {
      return "/book";
    }

    params.set("intent", "pricing-estimator");
    return `/book?${params.toString()}`;
  }, [pathname, searchParams]);

  return (
    <Button
      asChild
      className={cn(
        "flex-1 min-h-[48px] rounded-md text-base font-semibold",
        className,
      )}
    >
      <Link href={quoteHref as Route}>{label}</Link>
    </Button>
  );
}
