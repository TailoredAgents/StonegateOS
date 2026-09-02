import type { Metadata, Route } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { KeyRound, ShieldCheck } from "lucide-react";
import { partnerPasswordMfaAction } from "@/app/partners/actions";
import { PartnerMutationSubmitButton } from "@/app/partners/PartnerMutationSubmitButton";
import {
  PartnerNotice,
  partnerFieldClass,
  partnerPrimaryButtonClass,
} from "@/app/partners/components/PartnerPortalUi";
import { normalizePartnerReturnTo } from "@/app/partners/lib/safe-return";
import { PARTNER_AUTH_TRANSACTION_COOKIE } from "@/lib/partner-session";

export const metadata: Metadata = {
  title: "Verify partner sign in",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

function verificationError(code: string | null): string | null {
  if (!code) return null;
  if (code === "invalid_mfa_code" || code === "verification_failed") {
    return "That verification code was not accepted. Check the current code and try again.";
  }
  if (code === "rate_limited") {
    return "Too many verification attempts were made. Wait a moment before trying again.";
  }
  return "Verification is temporarily unavailable. Your password was accepted, but no portal session was created.";
}

export default async function PartnerPasswordMfaPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string; returnTo?: string }>;
}) {
  const params = (await searchParams) ?? {};
  const returnTo = normalizePartnerReturnTo(params.returnTo);
  const transactionToken = (await cookies()).get(
    PARTNER_AUTH_TRANSACTION_COOKIE,
  )?.value;
  if (!transactionToken || !/^[A-Za-z0-9_-]{43}$/u.test(transactionToken)) {
    const query = new URLSearchParams({ error: "mfa_transaction_expired" });
    if (returnTo !== "/partners/overview") query.set("returnTo", returnTo);
    redirect(`/partners/login?${query.toString()}` as Route);
  }
  const error =
    typeof params.error === "string" && params.error.trim()
      ? params.error.trim()
      : null;

  return (
    <div className="mx-auto max-w-xl rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/60 sm:p-10">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-50 text-primary-700 ring-1 ring-primary-100">
        <ShieldCheck className="h-6 w-6" aria-hidden="true" />
      </div>
      <p className="mt-5 text-xs font-semibold uppercase tracking-[0.16em] text-primary-700">
        Secure partner access
      </p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
        Verify your sign in
      </h1>
      <p className="mt-3 text-sm leading-6 text-slate-600">
        Your password was accepted. Enter the current code from your
        authenticator app, or use one unused recovery code. No portal session
        exists until verification succeeds.
      </p>

      {verificationError(error) ? (
        <PartnerNotice tone="error" className="mt-5">
          {verificationError(error)}
        </PartnerNotice>
      ) : null}

      <form action={partnerPasswordMfaAction} className="mt-7 space-y-4">
        <input type="hidden" name="returnTo" value={returnTo} />
        <fieldset>
          <legend className="text-sm font-semibold text-slate-800">
            Verification method
          </legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <label className="flex min-h-11 items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800">
              <input
                name="method"
                type="radio"
                value="totp"
                defaultChecked
                className="h-5 w-5 border-slate-300 text-primary-700 focus:ring-primary-600"
              />
              Authenticator code
            </label>
            <label className="flex min-h-11 items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800">
              <input
                name="method"
                type="radio"
                value="recovery"
                className="h-5 w-5 border-slate-300 text-primary-700 focus:ring-primary-600"
              />
              Recovery code
            </label>
          </div>
        </fieldset>
        <label className="block" htmlFor="partner-mfa-verification">
          <span className="text-sm font-semibold text-slate-700">
            Verification code
          </span>
          <input
            id="partner-mfa-verification"
            name="verification"
            type="text"
            required
            minLength={6}
            maxLength={40}
            autoComplete="one-time-code"
            inputMode="text"
            spellCheck={false}
            className={partnerFieldClass}
          />
          <span className="mt-1 block text-xs leading-5 text-slate-500">
            Authenticator codes contain six digits. Recovery codes may include
            dashes.
          </span>
        </label>
        <PartnerMutationSubmitButton
          className={partnerPrimaryButtonClass + " w-full"}
          pendingLabel="Verifying…"
        >
          <KeyRound className="h-4 w-4" aria-hidden="true" />
          Verify and continue
        </PartnerMutationSubmitButton>
      </form>

      <p className="mt-6 border-t border-slate-200 pt-5 text-sm leading-6 text-slate-600">
        Cannot access your authenticator or recovery codes? For your security,
        Stonegate must verify and recover the account before sign-in can
        continue.{" "}
        <Link
          href="/partners/login"
          className="font-semibold text-primary-800 underline underline-offset-4"
        >
          Start over
        </Link>
        .
      </p>
    </div>
  );
}
