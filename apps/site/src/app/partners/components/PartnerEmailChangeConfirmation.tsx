"use client";

import * as React from "react";
import Link from "next/link";
import { CheckCircle2, LoaderCircle, MailCheck } from "lucide-react";
import { PartnerAccessHelp } from "./PartnerAccessHelp";
import { partnerOnboardingFetch } from "../lib/onboarding";
import {
  PartnerNotice,
  partnerPrimaryButtonClass,
  partnerSecondaryButtonClass,
} from "./PartnerPortalUi";

export function PartnerEmailChangeConfirmation({
  hasToken,
  operationKey,
  initialError = null,
}: {
  hasToken: boolean;
  operationKey: string;
  initialError?: string | null;
}) {
  const [busy, setBusy] = React.useState(false);
  const [complete, setComplete] = React.useState(false);
  const [error, setError] = React.useState<string | null>(initialError);
  const messageRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (error || complete) messageRef.current?.focus();
  }, [error, complete]);

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
        "Idempotency-Key": "partner-email-change:" + operationKey,
      },
      body: JSON.stringify({}),
    }).catch(() => null);
    setBusy(false);
    if (!result?.ok) {
      setError(
        !result || result.response.status >= 500
          ? "We couldn’t reach the account service. Your link has not been cleared; try again or contact Sales."
          : result.response.status === 429
            ? "Too many attempts. Wait a few minutes, then try again."
            : result.response.status === 409
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
      <div
        ref={messageRef}
        tabIndex={-1}
        className="mx-auto max-w-md text-center"
      >
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
        <PartnerAccessHelp className="mt-5 text-left" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md">
      <MailCheck className="h-12 w-12 text-primary-700" aria-hidden="true" />
      <h1 className="mt-5 text-3xl font-semibold tracking-tight text-slate-950">
        Confirm your new sign-in email
      </h1>
      <p className="mt-3 text-sm leading-6 text-slate-600">
        This makes the new email the one you use to sign in and signs out other
        devices for security. Your company information will not change.
      </p>
      {error || !hasToken ? (
        <div ref={messageRef} tabIndex={-1}>
          <PartnerNotice tone="error" className="mt-5">
            {error ?? "This confirmation link is missing or expired."}
          </PartnerNotice>
        </div>
      ) : null}
      <form
        method="post"
        action="/partners/form"
        onSubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
      >
        <input type="hidden" name="operation" value="email_change" />
        <input type="hidden" name="operationKey" value={operationKey} />
        <button
          type="submit"
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
      </form>
      <Link
        href="/partners/login"
        className={`${partnerSecondaryButtonClass} mt-3 w-full`}
      >
        Return to sign in
      </Link>
      <PartnerAccessHelp className="mt-5" />
    </div>
  );
}
