import Link from "next/link";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { ADMIN_SESSION_COOKIE } from "@/lib/admin-session";
import { CREW_SESSION_COOKIE } from "@/lib/crew-session";
import { resolveTeamPrincipalFromCookies } from "@/lib/team-principal";
import {
  exchangeLegacyTeamSessionAction,
  requestTeamMagicLinkAction,
  teamPasswordLoginAction,
} from "./actions";
import { LoginSubmitButton } from "./LoginSubmitButton";
import { RecoverySubmitButton } from "./RecoverySubmitButton";

export const metadata: Metadata = {
  title: "Team sign in",
  robots: { index: false, follow: false },
};

export default async function TeamLoginPage({
  searchParams,
}: {
  searchParams?: Promise<{
    sent?: string;
    error?: string;
    retryAfter?: string;
  }>;
}) {
  const params = (await searchParams) ?? {};
  const principal = await resolveTeamPrincipalFromCookies();
  if (principal) {
    return (
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/50">
        <h1 className="text-xl font-semibold text-slate-900">
          You are already signed in.
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          Go to the{" "}
          <Link className="text-primary-700 underline" href="/team">
            Team Console
          </Link>
          .
        </p>
      </div>
    );
  }

  const cookieStore = await cookies();
  const hasLegacyRecoveryCookie = Boolean(
    cookieStore.get(ADMIN_SESSION_COOKIE)?.value ||
      cookieStore.get(CREW_SESSION_COOKIE)?.value,
  );

  const sent = params.sent === "1";
  const error =
    typeof params.error === "string" && params.error.trim().length
      ? params.error.trim()
      : null;
  const retryAfter =
    typeof params.retryAfter === "string" &&
    /^\d{1,5}$/u.test(params.retryAfter)
      ? Number(params.retryAfter)
      : null;
  const errorMessage = (() => {
    if (!error) return null;
    if (error === "too_many_login_requests" || error === "rate_limited") {
      return retryAfter
        ? `Too many sign-in attempts. Try again in about ${retryAfter} seconds.`
        : "Too many sign-in attempts. Wait a moment and try again.";
    }
    if (error === "login_service_unavailable") {
      return "Sign-in is temporarily unavailable. Your request was not sent; please try again.";
    }
    if (error === "missing_credentials") {
      return "Enter both your email and password.";
    }
    if (error === "expired_or_invalid") {
      return "That sign-in link is expired or has already been used. Request a new link.";
    }
    if (error === "missing_token") {
      return "The sign-in link is incomplete. Request a new link.";
    }
    if (error === "email_or_phone_required") {
      return "Enter your work email or phone number.";
    }
    if (error === "login_failed" || error === "invalid_credentials") {
      return "The email or password did not match an active account.";
    }
    if (error === "recovery_failed") {
      return retryAfter
        ? `We could not restore access. Wait about ${retryAfter} seconds, then try again or use your normal sign-in.`
        : "We could not restore access. Try again later or use your normal sign-in.";
    }
    return "We could not sign you in. Please try again or request a new link.";
  })();

  return (
    <div className="space-y-5">
      <header className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/50">
        <h1 className="text-2xl font-semibold text-slate-900">
          Stonegate Team Console
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Sign in with your work email (magic link) or password.
        </p>
        {sent ? (
          <div
            className="mt-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"
            role="status"
            aria-live="polite"
          >
            If your email is on the team, you&apos;ll receive a secure login
            link shortly.
          </div>
        ) : null}
        {errorMessage ? (
          <div
            className="mt-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
            role="alert"
          >
            {errorMessage}
          </div>
        ) : null}
      </header>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/50">
          <h2 className="text-lg font-semibold text-slate-900">Magic link</h2>
          <p className="mt-1 text-sm text-slate-600">
            We&apos;ll send a secure link via email or SMS (if your phone is on
            file).
          </p>
          <form action={requestTeamMagicLinkAction} className="mt-4 space-y-3">
            <label className="block">
              <div className="text-xs font-semibold text-slate-700">
                Email or phone
              </div>
              <input
                name="identifier"
                type="text"
                autoComplete="username"
                required
                className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                placeholder="you@stonegatejunkremoval.com or +16785551234"
              />
            </label>
            <LoginSubmitButton
              label="Send login link"
              pendingLabel="Sending secure link…"
              variant="primary"
            />
          </form>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/50">
          <h2 className="text-lg font-semibold text-slate-900">
            Password sign-in
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            If you&apos;ve set a password, sign in here.
          </p>
          <form action={teamPasswordLoginAction} className="mt-4 space-y-3">
            <label className="block">
              <div className="text-xs font-semibold text-slate-700">Email</div>
              <input
                name="email"
                type="email"
                autoComplete="username"
                required
                className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                placeholder="you@stonegatejunkremoval.com"
              />
            </label>
            <label className="block">
              <div className="text-xs font-semibold text-slate-700">
                Password
              </div>
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              />
            </label>
            <LoginSubmitButton
              label="Sign in with password"
              pendingLabel="Signing in…"
              variant="secondary"
            />
          </form>
        </section>
      </div>

      {hasLegacyRecoveryCookie ? (
        <section className="rounded-3xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-950 shadow-sm">
          <h2 className="font-semibold">Existing recovery session</h2>
          <p className="mt-1">
            A temporary legacy recovery session was found in this browser. You
            can exchange it once for a short-lived, revocable Team Console
            session. This does not make the legacy cookie a Team credential.
          </p>
          <form action={exchangeLegacyTeamSessionAction} className="mt-4">
            <RecoverySubmitButton />
          </form>
        </section>
      ) : (
        <section className="rounded-3xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900 shadow-sm">
          <h2 className="font-semibold">Need account recovery?</h2>
          <p className="mt-1">
            Contact an active owner to restore access. Legacy shared owner and
            crew keys do not directly authorize the Team Console.
          </p>
        </section>
      )}
    </div>
  );
}
