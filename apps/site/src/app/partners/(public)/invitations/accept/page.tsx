import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { MailCheck, ShieldCheck } from "lucide-react";
import {
  PartnerNotice,
  PartnerPanel,
  partnerPrimaryButtonClass,
  partnerSecondaryButtonClass,
} from "@/app/partners/components/PartnerPortalUi";
import { PARTNER_INVITATION_TOKEN_COOKIE } from "@/lib/partner-application-session";

export const metadata: Metadata = {
  title: "Accept team invitation",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};
export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<{ accepted?: string; error?: string }>;
};

export default async function PartnerInvitationAcceptancePage({
  searchParams,
}: PageProps) {
  const params = await searchParams;
  const accepted = params.accepted === "1";
  const recoverableError =
    params.error === "unavailable" || params.error === "rate_limited";
  const token = (await cookies()).get(PARTNER_INVITATION_TOKEN_COOKIE)?.value;
  const validToken = Boolean(token && /^[A-Za-z0-9_-]{32,256}$/u.test(token));

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-10 sm:px-6 sm:py-16">
      <PartnerPanel className="p-6 sm:p-8">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-50 text-primary-700 ring-1 ring-primary-100">
          <MailCheck className="h-6 w-6" aria-hidden="true" />
        </div>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight text-slate-950">
          {accepted ? "Invitation accepted" : "Join your company workspace"}
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          {accepted
            ? "Check your email for the separate activation link that completes your secure account setup."
            : "Accepting confirms the company and role invitation. It does not activate portal access; we’ll email a separate one-use activation link after acceptance."}
        </p>

        {accepted ? (
          <PartnerNotice tone="success" className="mt-5">
            Your invitation has been recorded. Use the activation email to set
            or confirm your password and complete required two-step
            verification. Your portal access is not active until those security
            steps are finished.
          </PartnerNotice>
        ) : recoverableError ? (
          <PartnerNotice tone="warning" className="mt-5">
            {params.error === "rate_limited"
              ? "Too many acceptance attempts were made. Wait a few minutes, then try again."
              : "We couldn’t accept the invitation right now. The link remains available; try again shortly."}
          </PartnerNotice>
        ) : params.error || !validToken ? (
          <PartnerNotice tone="error" className="mt-5">
            This invitation is invalid, expired, revoked, or already used. Ask
            your account administrator to send a new invitation.
          </PartnerNotice>
        ) : null}

        {!accepted && validToken && (!params.error || recoverableError) ? (
          <form
            method="post"
            action="/partners/invitations/accept/complete"
            className="mt-6"
            data-partner-analytics="invitation_accept"
          >
            <button type="submit" className={partnerPrimaryButtonClass}>
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              Accept invitation
            </button>
          </form>
        ) : null}

        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          {accepted ? (
            <Link href="/partners/activate" className={partnerPrimaryButtonClass}>
              Request another activation link
            </Link>
          ) : null}
          <Link
            href={accepted ? "/partners" : "/partners/login"}
            className={partnerSecondaryButtonClass}
          >
            {accepted ? "Back to Partner Portal" : "Return to sign in"}
          </Link>
        </div>
      </PartnerPanel>
    </div>
  );
}
