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
import { PartnerAccessHelp } from "./PartnerAccessHelp";
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

export function PartnerPasswordRecoveryForm({
  operationKey,
  sent = false,
  initialError = null,
}: {
  operationKey: string;
  sent?: boolean;
  initialError?: string | null;
}) {
  const [pending, setPending] = React.useState(false);
  const [complete, setComplete] = React.useState(sent);
  const [error, setError] = React.useState<string | null>(initialError);
  const completeRef = React.useRef<HTMLDivElement>(null);
  const errorRef = React.useRef<HTMLDivElement>(null);
  const retry = React.useRef<{ email: string; key: string } | null>(null);
  React.useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  React.useEffect(() => {
    if (complete) completeRef.current?.focus();
  }, [complete]);

  async function submit(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    if (pending || !form.reportValidity()) return;
    const email = new FormData(form).get("email");
    if (typeof email !== "string") return;
    const normalizedEmail = email.trim();
    if (retry.current?.email !== normalizedEmail)
      retry.current = {
        email: normalizedEmail,
        key: onboardingOperationKey("partner-password-recovery"),
      };
    setPending(true);
    setError(null);
    const result = await partnerOnboardingFetch<{ ok: true }>(
      "password-recovery/request",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": retry.current.key,
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
        className="mx-auto max-w-md text-center"
      >
        <CheckCircle2
          className="mx-auto h-12 w-12 text-emerald-700"
          aria-hidden="true"
        />
        <h1 className="mt-5 text-2xl font-semibold text-slate-950">
          Check your email
        </h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          If that address matches an active partner account, a reset email has
          been requested. Check your inbox and spam folder. The one-use link
          lasts 30 minutes.
        </p>
        <Link
          href="/partners/login"
          className={cn(partnerPrimaryButtonClass, "mt-6")}
        >
          Return to sign in
        </Link>
        <PartnerAccessHelp className="mt-5 text-left" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-50 text-primary-700 ring-1 ring-primary-100">
        <MailCheck className="h-6 w-6" aria-hidden="true" />
      </div>
      <h1 className="mt-5 text-3xl font-semibold tracking-tight text-slate-950">
        Get back into your account
      </h1>
      <p className="mt-3 text-sm leading-6 text-slate-600">
        Enter the email you use to sign in. If it matches an active partner
        account, we’ll send a secure, one-use reset link.
      </p>
      {error ? (
        <div ref={errorRef} tabIndex={-1}>
          <PartnerNotice tone="error" className="mt-5">
            {error}
          </PartnerNotice>
        </div>
      ) : null}
      <form
        method="post"
        action="/partners/form"
        onSubmit={(event) => void submit(event)}
        className="mt-6 space-y-5"
        data-partner-analytics="password_recovery_request"
      >
        <input type="hidden" name="operation" value="recovery" />
        <input type="hidden" name="operationKey" value={operationKey} />
        <label className="block" htmlFor="partner-recovery-email">
          <span className="text-sm font-semibold text-slate-700">Email</span>
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
      <PartnerAccessHelp className="mt-5" />
    </div>
  );
}
