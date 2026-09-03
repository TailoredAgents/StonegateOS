"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  LoaderCircle,
  MailCheck,
  ShieldCheck,
} from "lucide-react";
import { cn } from "@myst-os/ui";
import {
  onboardingOperationKey,
  partnerOnboardingFetch,
} from "../lib/onboarding";
import {
  flushPartnerFunnelEvents,
  trackPartnerFunnelEvent,
} from "../lib/product-analytics";
import {
  PartnerNotice,
  partnerFieldClass,
  partnerPrimaryButtonClass,
  partnerSecondaryButtonClass,
} from "./PartnerPortalUi";

type RequestError = "invalid_or_expired" | "temporarily_unavailable" | null;

export function PartnerAccessRequestForm({
  initialError,
}: {
  initialError: RequestError;
}) {
  const [pending, setPending] = React.useState(false);
  const [complete, setComplete] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(
    initialError === "invalid_or_expired"
      ? "That verification link is invalid, expired, or already used. Request a new one below."
      : initialError === "temporarily_unavailable"
        ? "We couldn’t verify that link right now. Request a new link or try again shortly."
        : null,
  );
  const successRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (complete) successRef.current?.focus();
  }, [complete]);

  async function submit(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const email = new FormData(form).get("email");
    if (typeof email !== "string") return;
    trackPartnerFunnelEvent({
      stage: "access_request_started",
      surface: "access",
    });
    setPending(true);
    setMessage(null);
    const result = await partnerOnboardingFetch<{ ok: true; message?: string }>(
      "email-challenges",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": onboardingOperationKey("partner-email-challenge"),
        },
        body: JSON.stringify({ email: email.trim() }),
      },
    ).catch(() => null);
    setPending(false);
    if (!result?.ok) {
      setMessage(
        result?.response.status === 429
          ? "Too many links were requested. Wait a few minutes, then try again."
          : (result?.error.message ??
              "We couldn’t send a verification link. Try again shortly."),
      );
      return;
    }
    trackPartnerFunnelEvent({
      stage: "verification_request_accepted",
      surface: "access",
    });
    flushPartnerFunnelEvents();
    setComplete(true);
  }

  if (complete) {
    return (
      <div
        ref={successRef}
        tabIndex={-1}
        className="mx-auto max-w-2xl rounded-3xl border border-emerald-200 bg-white p-6 text-center shadow-xl shadow-slate-200/60 focus:outline-none sm:p-10"
      >
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">
          <CheckCircle2 className="h-7 w-7" aria-hidden="true" />
        </div>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">
          Check your work email
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-slate-600 sm:text-base">
          If that address can start or resume a partner request, we sent a
          one-use verification link. It expires in 30 minutes.
        </p>
        <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
          <button
            type="button"
            onClick={() => setComplete(false)}
            className={partnerSecondaryButtonClass}
          >
            Use a different email
          </button>
          <Link href="/partners/login" className={partnerPrimaryButtonClass}>
            Already approved? Sign in
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="grid overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-xl shadow-slate-200/60 lg:grid-cols-[0.85fr_1.15fr]">
      <section className="relative overflow-hidden bg-primary-900 px-6 py-8 text-white sm:px-8 sm:py-10 lg:p-10">
        <div
          className="absolute -left-20 -top-20 h-64 w-64 rounded-full bg-accent-500/20 blur-3xl"
          aria-hidden="true"
        />
        <div className="relative">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent-200">
            Partner with Stonegate
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight">
            Start with your verified work email.
          </h1>
          <p className="mt-4 text-sm leading-6 text-primary-100 sm:text-base">
            Verification keeps company requests connected to the right people.
            No company workspace or portal membership is created before
            Stonegate approval.
          </p>
          <ul className="mt-8 space-y-4 text-sm text-primary-50">
            {[
              "One-use link valid for 30 minutes",
              "A short, resumable application after verification",
              "Password activation only after approval",
            ].map((item) => (
              <li key={item} className="flex items-start gap-3">
                <ShieldCheck
                  className="mt-0.5 h-5 w-5 shrink-0 text-accent-200"
                  aria-hidden="true"
                />
                {item}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section
        className="p-6 sm:p-8 lg:p-10"
        aria-labelledby="partner-access-heading"
      >
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-50 text-primary-700">
            <MailCheck className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary-700">
              Step 1 of 2
            </p>
            <h2
              id="partner-access-heading"
              className="text-xl font-semibold text-slate-950"
            >
              Verify your email
            </h2>
          </div>
        </div>
        <p className="mt-4 text-sm leading-6 text-slate-600">
          Use the work address you want connected to your company. You’ll enter
          company and service details after opening the link.
        </p>
        {message ? (
          <PartnerNotice tone="error" className="mt-5">
            {message}
          </PartnerNotice>
        ) : null}
        <form
          onSubmit={(event) => void submit(event)}
          className="mt-6 space-y-5"
          data-partner-analytics="access_email_submit"
        >
          <label className="block" htmlFor="partner-request-email">
            <span className="text-sm font-semibold text-slate-700">
              Work email
            </span>
            <input
              id="partner-request-email"
              name="email"
              type="email"
              required
              maxLength={254}
              autoComplete="email"
              inputMode="email"
              className={partnerFieldClass}
              placeholder="you@company.com"
            />
          </label>
          <button
            type="submit"
            disabled={pending}
            aria-disabled={pending}
            aria-busy={pending}
            className={cn(partnerPrimaryButtonClass, "w-full")}
          >
            {pending ? (
              <LoaderCircle
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            )}
            <span aria-live="polite">
              {pending
                ? "Sending verification link…"
                : "Email me a verification link"}
            </span>
          </button>
        </form>
        <p className="mt-6 text-sm leading-6 text-slate-600">
          Already have an approved account?{" "}
          <Link
            href="/partners/login"
            className="font-semibold text-primary-800 underline underline-offset-4"
          >
            Sign in instead
          </Link>
          .
        </p>
      </section>
    </div>
  );
}
