"use client";

import * as React from "react";
import Link from "next/link";
import { CheckCircle2, LoaderCircle, MailCheck } from "lucide-react";
import {
  onboardingOperationKey,
  partnerOnboardingFetch,
} from "../lib/onboarding";
import {
  PartnerNotice,
  partnerPrimaryButtonClass,
  partnerSecondaryButtonClass,
} from "./PartnerPortalUi";

export function PartnerEmailChangeConfirmation({
  hasToken,
}: {
  hasToken: boolean;
}) {
  const [busy, setBusy] = React.useState(false);
  const [complete, setComplete] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function confirm() {
    if (!hasToken || busy) return;
    setBusy(true);
    setError(null);
    const result = await partnerOnboardingFetch<{
      ok: true;
      emailChanged: true;
      autoLogin: false;
    }>("email-change/confirm", {
      method: "POST",
      headers: {
        "Idempotency-Key": onboardingOperationKey("email-change-confirm"),
      },
      body: JSON.stringify({}),
    }).catch(() => null);
    setBusy(false);
    if (!result?.ok) {
      setError(
        result?.response.status === 409
          ? "This email change could not be completed safely. Contact Stonegate support."
          : (result?.error.message ??
              "This confirmation link is invalid or expired."),
      );
      return;
    }
    setComplete(true);
  }

  if (complete) {
    return (
      <div className="mx-auto max-w-xl rounded-3xl border border-emerald-200 bg-white p-6 text-center shadow-xl shadow-slate-200/60 sm:p-10">
        <CheckCircle2
          className="mx-auto h-12 w-12 text-emerald-700"
          aria-hidden="true"
        />
        <h1 className="mt-5 text-2xl font-semibold text-slate-950">
          Email updated—you’re ready to sign in
        </h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          Sign in with your new email and existing password. For security, all
          other signed-in devices were signed out.
        </p>
        <Link
          href="/partners/login?emailChanged=1"
          className={`${partnerPrimaryButtonClass} mt-6`}
        >
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/60 sm:p-10">
      <MailCheck className="h-12 w-12 text-primary-700" aria-hidden="true" />
      <p className="mt-5 text-xs font-semibold uppercase tracking-[0.16em] text-primary-700">
        Keep sign-in simple
      </p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
        Confirm your new sign-in email
      </h1>
      <p className="mt-3 text-sm leading-6 text-slate-600">
        This makes the new email the one you use to sign in and signs out other
        devices for security. Your company information will not change.
      </p>
      {error || !hasToken ? (
        <PartnerNotice tone="error" className="mt-5">
          {error ?? "This confirmation link is missing or expired."}
        </PartnerNotice>
      ) : null}
      <button
        type="button"
        onClick={() => void confirm()}
        disabled={!hasToken || busy}
        aria-busy={busy}
        className={`${partnerPrimaryButtonClass} mt-6 w-full`}
      >
        {busy ? (
          <LoaderCircle
            className="h-4 w-4 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : (
          <MailCheck className="h-4 w-4" aria-hidden="true" />
        )}
        {busy ? "Confirming…" : "Confirm email change"}
      </button>
      <Link
        href="/partners/login"
        className={`${partnerSecondaryButtonClass} mt-3 w-full`}
      >
        Return to sign in
      </Link>
    </div>
  );
}
