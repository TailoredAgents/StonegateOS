"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  LoaderCircle,
  MailCheck,
} from "lucide-react";
import { cn } from "@myst-os/ui";
import {
  onboardingOperationKey,
  partnerOnboardingFetch,
} from "../lib/onboarding";
import {
  PartnerNotice,
  partnerFieldClass,
  partnerPrimaryButtonClass,
  partnerSecondaryButtonClass,
} from "./PartnerPortalUi";

export function PartnerPasswordRecoveryForm() {
  const [pending, setPending] = React.useState(false);
  const [complete, setComplete] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const completeRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (complete) completeRef.current?.focus();
  }, [complete]);

  async function submit(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const email = new FormData(form).get("email");
    if (typeof email !== "string") return;
    setPending(true);
    setError(null);
    const result = await partnerOnboardingFetch<{ ok: true }>(
      "password-recovery/request",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": onboardingOperationKey(
            "partner-password-recovery",
          ),
        },
        body: JSON.stringify({ email: email.trim() }),
      },
    ).catch(() => null);
    setPending(false);
    if (!result?.ok) {
      setError(
        result?.response.status === 429
          ? "Too many reset links were requested. Wait a few minutes, then try again."
          : (result?.error.message ?? "We couldn’t request a password reset."),
      );
      return;
    }
    setComplete(true);
  }

  if (complete) {
    return (
      <div
        ref={completeRef}
        tabIndex={-1}
        className="mx-auto max-w-xl rounded-3xl border border-emerald-200 bg-white p-6 text-center shadow-xl shadow-slate-200/60 focus:outline-none sm:p-10"
      >
        <CheckCircle2
          className="mx-auto h-12 w-12 text-emerald-700"
          aria-hidden="true"
        />
        <h1 className="mt-5 text-2xl font-semibold text-slate-950">
          Check your email
        </h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          If the address belongs to an active partner account, we sent a one-use
          password-reset link. For security, this message is the same for every
          address.
        </p>
        <Link
          href="/partners/login"
          className={cn(partnerPrimaryButtonClass, "mt-6")}
        >
          Return to sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/60 sm:p-10">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-50 text-primary-700 ring-1 ring-primary-100">
        <MailCheck className="h-6 w-6" aria-hidden="true" />
      </div>
      <h1 className="mt-5 text-3xl font-semibold tracking-tight text-slate-950">
        Reset your portal password
      </h1>
      <p className="mt-3 text-sm leading-6 text-slate-600">
        Enter the email for your activated partner account. We’ll send a secure,
        one-use reset link if the account is eligible.
      </p>
      {error ? (
        <PartnerNotice tone="error" className="mt-5">
          {error}
        </PartnerNotice>
      ) : null}
      <form
        onSubmit={(event) => void submit(event)}
        className="mt-6 space-y-5"
        data-partner-analytics="password_recovery_request"
      >
        <label className="block" htmlFor="partner-recovery-email">
          <span className="text-sm font-semibold text-slate-700">
            Work email
          </span>
          <input
            id="partner-recovery-email"
            name="email"
            type="email"
            required
            maxLength={254}
            autoComplete="email"
            inputMode="email"
            className={partnerFieldClass}
          />
        </label>
        <button
          type="submit"
          disabled={pending}
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
          {pending ? "Requesting reset link…" : "Email me a reset link"}
        </button>
      </form>
      <Link
        href="/partners/login"
        className={cn(partnerSecondaryButtonClass, "mt-4 w-full")}
      >
        Return to sign in
      </Link>
    </div>
  );
}
