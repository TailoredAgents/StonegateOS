import type { Metadata, Route } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, LockKeyhole, ShieldCheck } from "lucide-react";
import { partnerPasswordLoginAction } from "@/app/partners/actions";
import { PartnerMutationSubmitButton } from "@/app/partners/PartnerMutationSubmitButton";
import {
  PartnerNotice,
  partnerFieldClass,
  partnerPrimaryButtonClass,
} from "@/app/partners/components/PartnerPortalUi";
import { getPartnerPortalContext } from "@/app/partners/lib/portal-context";
import { normalizePartnerReturnTo } from "@/app/partners/lib/safe-return";

export const metadata: Metadata = {
  title: "Partner sign in",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

function loginError(code: string | null): string | null {
  if (!code) return null;
  if (code === "missing_credentials")
    return "Enter both your email and password.";
  if (code === "activation_required" || code === "pending_activation") {
    return "Your access is approved but not activated. Use the activation email to create your password.";
  }
  if (code === "rate_limited") {
    return "Too many sign-in attempts were made. Wait a moment, then try again.";
  }
  if (code === "security_setup_updated") {
    return "The sign-in process has been updated. Sign in with your email and password.";
  }
  if (code === "temporarily_unavailable" || code === "request_failed") {
    return "Sign-in is temporarily unavailable. Try again shortly or contact Stonegate.";
  }
  return "The email or password did not match an active partner account.";
}

export default async function PartnerLoginPage({
  searchParams,
}: {
  searchParams?: Promise<{
    reset?: string;
    error?: string;
    returnTo?: string;
  }>;
}) {
  const params = (await searchParams) ?? {};
  const returnTo = normalizePartnerReturnTo(params.returnTo);
  const context = await getPartnerPortalContext();
  if (context.status === "authenticated") redirect(returnTo as Route);
  const error =
    typeof params.error === "string" && params.error.trim()
      ? params.error.trim()
      : null;

  return (
    <div className="grid overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-xl shadow-slate-200/60 lg:grid-cols-[0.88fr_1.12fr]">
      <section className="relative overflow-hidden bg-primary-900 px-6 py-8 text-white sm:px-8 sm:py-10 lg:p-12">
        <div
          className="absolute -right-20 -top-20 h-56 w-56 rounded-full bg-accent-500/20 blur-3xl"
          aria-hidden="true"
        />
        <div className="relative">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent-200">
            Quick and easy partner service
          </p>
          <h1 className="mt-3 max-w-lg text-3xl font-semibold tracking-tight sm:text-4xl">
            Request service without starting from scratch.
          </h1>
          <p className="mt-4 max-w-lg text-sm leading-6 text-primary-100 sm:text-base">
            Use your saved locations and job details to request service, follow
            the work, and find photos and documents when you need them.
          </p>
          <ul className="mt-8 space-y-4 text-sm text-primary-50">
            {[
              "Reuse saved locations and instructions",
              "See clear scheduling and job updates",
              "Keep photos and paperwork with each job",
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

      <div className="p-6 sm:p-8 lg:p-10">
        <div className="max-w-xl">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary-50 text-primary-700 ring-1 ring-primary-100">
              <LockKeyhole className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary-700">
                Welcome back
              </p>
              <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                Sign in to your portal
              </h2>
            </div>
          </div>

          {params.reset === "1" ? (
            <PartnerNotice tone="success" className="mt-5">
              Password reset. Sign in with your new password.
            </PartnerNotice>
          ) : null}
          {loginError(error) ? (
            <PartnerNotice tone="error" className="mt-5">
              {loginError(error)}
            </PartnerNotice>
          ) : null}

          <form
            action={partnerPasswordLoginAction}
            className="mt-7 space-y-4"
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
                maxLength={254}
                autoComplete="username"
                inputMode="email"
                className={partnerFieldClass}
                placeholder="you@company.com"
              />
            </label>
            <div>
              <div className="flex items-center justify-between gap-3">
                <label
                  htmlFor="partner-password"
                  className="text-sm font-semibold text-slate-700"
                >
                  Password
                </label>
                <Link
                  href={"/partners/forgot-password" as Route}
                  className="inline-flex min-h-11 items-center text-sm font-semibold text-primary-800 underline underline-offset-4"
                >
                  Forgot password?
                </Link>
              </div>
              <input
                id="partner-password"
                name="password"
                type="password"
                required
                minLength={1}
                maxLength={128}
                autoComplete="current-password"
                className={partnerFieldClass}
              />
            </div>
            <label className="flex min-h-11 items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700">
              <input
                name="rememberMe"
                type="checkbox"
                className="mt-0.5 h-5 w-5 rounded border-slate-300 text-primary-700 focus:ring-primary-600"
              />
              <span>
                <span className="block font-semibold text-slate-800">
                  Keep me signed in
                </span>
                <span className="mt-0.5 block text-xs text-slate-500">
                  Use only on a private device. This extends the session from 12
                  hours to 30 days.
                </span>
              </span>
            </label>
            <PartnerMutationSubmitButton
              className={`${partnerPrimaryButtonClass} w-full`}
              pendingLabel="Signing in…"
            >
              Sign in
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </PartnerMutationSubmitButton>
          </form>

          <p className="mt-7 border-t border-slate-200 pt-5 text-sm leading-6 text-slate-600">
            Need a company account?{" "}
            <Link
              href="/partners/request-access"
              className="font-semibold text-primary-800 underline underline-offset-4"
            >
              Verify your work email and request access
            </Link>
            .
          </p>
        </div>
      </div>
    </div>
  );
}
