import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { PartnerAccessHelp } from "@/app/partners/components/PartnerAccessHelp";
import { PARTNER_INVITATION_TOKEN_COOKIE } from "@/lib/partner-application-session";

export const metadata: Metadata = {
  title: "Your partner invitation",
  robots: { index: false, follow: false, nocache: true },
  referrer: "same-origin",
};
export const dynamic = "force-dynamic";

export default async function PartnerInvitationAcceptancePage({
  searchParams,
}: {
  searchParams: Promise<{ accepted?: string; error?: string }>;
}) {
  const params = await searchParams;
  const token = (await cookies()).get(PARTNER_INVITATION_TOKEN_COOKIE)?.value;
  const validToken = Boolean(token && /^[A-Za-z0-9_-]{43}$/u.test(token));
  const retryable =
    params.error === "unavailable" || params.error === "rate_limited";
  return (
    <section className="mx-auto max-w-md space-y-6">
      <header className="space-y-3">
        <h1 className="font-display text-3xl font-semibold text-primary-900">
          Your partner invitation
        </h1>
        <p className="text-base leading-7 text-slate-600">
          Continue to set your password and start requesting service. Already
          use the portal? You’ll confirm your existing password once.
        </p>
      </header>
      {params.error || !validToken ? (
        <p
          role="alert"
          className="rounded-xl border border-slate-200 bg-white p-4 text-base leading-7 text-slate-700"
        >
          {retryable
            ? params.error === "rate_limited"
              ? "Too many attempts. Wait a few minutes, then try again."
              : "We couldn’t open the invitation right now. Your link has been kept so you can try again."
            : "This invitation is missing, expired, canceled, or already used. Your company administrator or Sales can help."}
        </p>
      ) : null}
      {validToken && (!params.error || retryable) ? (
        <form
          method="post"
          action="/partners/invitations/accept/complete"
          data-partner-analytics="invitation_accept"
        >
          <button
            type="submit"
            className="inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-primary-900 px-5 py-3 font-semibold text-white"
          >
            Continue to password setup
          </button>
        </form>
      ) : null}
      <PartnerAccessHelp />
      <Link
        href="/partners/login"
        className="inline-flex min-h-11 items-center font-semibold text-primary-900 underline"
      >
        Return to sign in
      </Link>
    </section>
  );
}
