import type { Metadata } from "next";
import type { Route } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, KeyRound, Link2, ShieldCheck } from "lucide-react";
import {
  requestPartnerMagicLinkAction,
  partnerPasswordLoginAction,
} from "@/app/partners/actions";
import { PartnerMutationSubmitButton } from "@/app/partners/PartnerMutationSubmitButton";
import {
  PartnerNotice,
  partnerFieldClass,
  partnerPrimaryButtonClass,
  partnerSecondaryButtonClass,
} from "@/app/partners/components/PartnerPortalUi";
import { getPartnerPortalContext } from "@/app/partners/lib/portal-context";
import { normalizePartnerReturnTo } from "@/app/partners/lib/safe-return";

export const metadata: Metadata = {
  title: "Sign in",
};

export default async function PartnerLoginPage({
  searchParams,
}: {
  searchParams?: Promise<{
    sent?: string;
    error?: string;
    returnTo?: string;
  }>;
}) {
  const params = (await searchParams) ?? {};
  const returnTo = normalizePartnerReturnTo(params.returnTo);
  const context = await getPartnerPortalContext();
  if (context.status === "authenticated") redirect(returnTo as Route);

  const sent = params.sent === "1";
  const error =
    typeof params.error === "string" && params.error.trim().length
      ? params.error.trim()
      : null;

  const errorMessage = (() => {
    if (!error) return null;
    if (error === "email_or_phone_required") {
      return "Enter your work email or mobile phone number.";
    }
    if (error === "missing_credentials") {
      return "Enter both your email and password.";
    }
    if (error === "expired_or_invalid") {
      return "That secure link has expired or was already used. Request a new link below.";
    }
    if (error === "missing_token") {
      return "That sign-in link is incomplete. Request a new link below.";
    }
    if (error === "invalid_credentials" || error === "login_failed") {
      return "The email or password did not match an active partner account.";
    }
    if (error === "rate_limited") {
      return "Too many sign-in attempts were made. Wait a moment, then try again.";
    }
    if (error === "temporarily_unavailable" || error === "request_failed") {
      return "We couldn’t send a sign-in link right now. Try again shortly or contact support.";
    }
    return "We couldn’t sign you in. Try again or request a new secure link.";
  })();

  return (
    <div className="grid overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-xl shadow-slate-200/60 lg:grid-cols-[0.9fr_1.1fr]">
      <section className="relative overflow-hidden bg-primary-900 px-6 py-8 text-white sm:px-8 sm:py-10 lg:p-12">
        <div
          className="absolute -right-20 -top-20 h-56 w-56 rounded-full bg-accent-500/20 blur-3xl"
          aria-hidden="true"
        />
        <div className="relative">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent-200">
            Built for busy partners
          </p>
          <h1 className="mt-3 max-w-lg text-3xl font-semibold tracking-tight sm:text-4xl">
            Your jobs, locations, and service schedule in one place.
          </h1>
          <p className="mt-4 max-w-lg text-sm leading-6 text-primary-100 sm:text-base">
            Securely schedule pickups, track upcoming work, and keep every
            service location organized.
          </p>
          <ul className="mt-8 space-y-4 text-sm text-primary-50">
            {[
              "Schedule service from your partner rate card",
              "Reuse saved addresses and access details",
              "Request schedule changes or cancel with the job context preserved",
            ].map((item) => (
              <li key={item} className="flex items-start gap-3">
                <ShieldCheck
                  className="mt-0.5 h-5 w-5 shrink-0 text-accent-200"
                  aria-hidden="true"
                />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <div className="p-6 sm:p-8 lg:p-10">
        <div className="max-w-xl">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary-700">
            Partner access
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
            Sign in to your portal
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Use a secure link for the simplest sign-in, or use your password if
            you set one.
          </p>
          {sent ? (
            <PartnerNotice tone="success" className="mt-5">
              If the details match an active invitation, we’ll send a secure
              link by text and/or email.
            </PartnerNotice>
          ) : null}
          {errorMessage ? (
            <PartnerNotice tone="error" className="mt-5">
              {errorMessage}
            </PartnerNotice>
          ) : null}

          <section aria-labelledby="secure-link-heading" className="mt-7">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-50 text-primary-700">
                <Link2 className="h-5 w-5" aria-hidden="true" />
              </div>
              <div>
                <h3
                  id="secure-link-heading"
                  className="font-semibold text-slate-950"
                >
                  Send a secure sign-in link
                </h3>
                <p className="text-xs text-slate-500">No password needed</p>
              </div>
            </div>
            <form
              action={requestPartnerMagicLinkAction}
              className="mt-4 space-y-4"
              data-partner-analytics="magic_link_request"
            >
              <input type="hidden" name="returnTo" value={returnTo} />
              <label className="block" htmlFor="partner-identifier">
                <span className="text-sm font-semibold text-slate-700">
                  Work email or mobile phone
                </span>
                <input
                  id="partner-identifier"
                  name="identifier"
                  type="text"
                  required
                  autoComplete="username"
                  className={partnerFieldClass}
                  placeholder="you@company.com or (404) 555-1234"
                />
              </label>
              <label className="flex min-h-11 items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700">
                <input
                  id="partner-magic-remember"
                  name="rememberMe"
                  type="checkbox"
                  className="mt-0.5 h-5 w-5 rounded border-slate-300 text-primary-700 focus:ring-primary-600"
                />
                <span>
                  <span className="block font-semibold text-slate-800">
                    Keep me signed in
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-500">
                    Use only on a private device. This extends the session from
                    12 hours to 30 days.
                  </span>
                </span>
              </label>
              <PartnerMutationSubmitButton
                className={`${partnerPrimaryButtonClass} w-full`}
                pendingLabel="Sending secure link…"
              >
                Send me a login link
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </PartnerMutationSubmitButton>
            </form>
          </section>

          <details className="group mt-7 border-t border-slate-200 pt-6">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between rounded-xl px-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 [&::-webkit-details-marker]:hidden">
              <span className="flex items-center gap-2">
                <KeyRound
                  className="h-4 w-4 text-slate-500"
                  aria-hidden="true"
                />
                Sign in with a password
              </span>
              <span
                className="text-slate-400 transition group-open:rotate-90"
                aria-hidden="true"
              >
                ›
              </span>
            </summary>
            <form
              action={partnerPasswordLoginAction}
              className="mt-4 space-y-4"
              data-partner-analytics="password_login"
            >
              <input type="hidden" name="returnTo" value={returnTo} />
              <label className="block" htmlFor="partner-email">
                <span className="text-sm font-semibold text-slate-700">
                  Email
                </span>
                <input
                  id="partner-email"
                  name="email"
                  type="email"
                  required
                  autoComplete="username"
                  className={partnerFieldClass}
                  placeholder="you@company.com"
                />
              </label>
              <label className="flex min-h-11 items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700">
                <input
                  id="partner-password-remember"
                  name="rememberMe"
                  type="checkbox"
                  className="mt-0.5 h-5 w-5 rounded border-slate-300 text-primary-700 focus:ring-primary-600"
                />
                <span>
                  <span className="block font-semibold text-slate-800">
                    Keep me signed in
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-500">
                    Use only on a private device. This extends the session from
                    12 hours to 30 days.
                  </span>
                </span>
              </label>
              <label className="block" htmlFor="partner-password">
                <span className="text-sm font-semibold text-slate-700">
                  Password
                </span>
                <input
                  id="partner-password"
                  name="password"
                  type="password"
                  required
                  autoComplete="current-password"
                  className={partnerFieldClass}
                />
              </label>
              <PartnerMutationSubmitButton
                className={`${partnerSecondaryButtonClass} w-full`}
                pendingLabel="Signing in…"
              >
                Sign in with password
              </PartnerMutationSubmitButton>
            </form>
          </details>

          <p className="mt-7 border-t border-slate-200 pt-5 text-sm leading-6 text-slate-600">
            Need a new partner account? Tell us about your company and service
            needs on the{" "}
            <Link
              href="/partners/request-access"
              className="font-semibold text-primary-800 underline underline-offset-4"
            >
              request access page
            </Link>
            . If you already have an invitation, use the secure sign-in link
            above.
          </p>
          <Link
            href="/"
            className="mt-3 inline-flex min-h-11 items-center text-sm font-semibold text-primary-800 underline-offset-4 hover:underline"
          >
            Return to the Stonegate website
          </Link>
        </div>
      </div>
    </div>
  );
}
