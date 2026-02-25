'use client';

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
  if (pathname === "/book" || pathname === "/bookbrush" || pathname.startsWith("/book/") || pathname.startsWith("/quote")) {
    return null;
  }

  const phoneE164 = normalizePhoneE164(process.env["NEXT_PUBLIC_COMPANY_PHONE_E164"] ?? FALLBACK_PHONE_E164);

  return (
    <>
      <div
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 border-t border-neutral-300/50 bg-white/95 px-4 pt-3 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] shadow-[0_-10px_24px_rgba(15,23,42,0.10)] md:hidden",
          className
        )}
      >
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
          <Button
            asChild
            variant="ghost"
            className="flex-1 min-h-[48px] rounded-md border border-neutral-300/70 text-base font-semibold text-primary-800 hover:border-primary-300"
          >
            <a href={`tel:${phoneE164}`}>Call</a>
          </Button>
          <Button
            asChild
            variant="ghost"
            className="flex-1 min-h-[48px] rounded-md border border-neutral-300/70 text-base font-semibold text-primary-800 hover:border-primary-300"
          >
            <a href={`sms:${phoneE164}`}>Text</a>
          </Button>
          <Suspense
            fallback={
              <Button asChild className="flex-1 min-h-[48px] rounded-md text-base font-semibold">
                <Link href="/book">Get Quote</Link>
              </Button>
            }
          >
            <StickyGetQuoteButton className="flex-1 min-h-[48px] rounded-md text-base font-semibold" />
          </Suspense>
        </div>
      </div>

      <div className={cn("fixed bottom-5 right-5 z-40 hidden md:block", className)}>
        <div className="rounded-2xl border border-neutral-300/60 bg-white/95 p-2 shadow-[0_16px_34px_rgba(15,23,42,0.18)] backdrop-blur-sm">
          <p className="px-2 pb-1 text-[11px] font-medium text-neutral-500">
            Book online in under a minute
          </p>
          <div className="flex items-center gap-2">
            <Button
              asChild
              variant="ghost"
              className="min-h-[44px] rounded-md border border-neutral-300/70 px-4 text-sm font-semibold text-primary-800 hover:border-primary-300"
            >
              <a href={`tel:${phoneE164}`}>Call</a>
            </Button>
            <Suspense
              fallback={
                <Button asChild className="min-h-[44px] rounded-md px-4 text-sm font-semibold">
                  <Link href="/book">Get Instant Quote</Link>
                </Button>
              }
            >
              <StickyGetQuoteButton
                label="Get Instant Quote"
                className="min-h-[44px] rounded-md px-4 text-sm font-semibold"
              />
            </Suspense>
          </div>
        </div>
      </div>
    </>
  );
}

function StickyGetQuoteButton({
  className,
  label = "Get Quote"
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
    <Button asChild className={cn("flex-1 min-h-[48px] rounded-md text-base font-semibold", className)}>
      <Link href={quoteHref as Route}>{label}</Link>
    </Button>
  );
}
