import type { Metadata } from "next";
import Link from "next/link";
import { MailCheck, ShieldCheck } from "lucide-react";
import {
  PartnerNotice,
  PartnerPanel,
  partnerPrimaryButtonClass,
  partnerSecondaryButtonClass,
} from "@/app/partners/components/PartnerPortalUi";

export const metadata: Metadata = {
  title: "Accept team invitation",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export const dynamic = "force-dynamic";

type PageProps = { searchParams: Promise<{ token?: string; error?: string }> };

export default async function PartnerInvitationAcceptancePage({ searchParams }: PageProps) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token.trim() : "";
  const validToken = /^[A-Za-z0-9_-]{32,256}$/u.test(token);

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-10 sm:px-6 sm:py-16">
      <PartnerPanel className="p-6 sm:p-8">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-50 text-primary-700 ring-1 ring-primary-100">
          <MailCheck className="h-6 w-6" aria-hidden="true" />
        </div>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight text-slate-950">
          Join your company workspace
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Accepting activates access only for the company and role named in your invitation. This link can be used once and expires after 30 minutes.
        </p>

        {params.error || !validToken ? (
          <PartnerNotice tone="error" className="mt-5">
            This invitation is invalid, expired, revoked, or already used. Ask your account administrator to send a new invitation.
          </PartnerNotice>
        ) : (
          <form method="post" action="/partners/invitations/accept/complete" className="mt-6 space-y-5" data-partner-analytics="invitation_accept">
            <input type="hidden" name="token" value={token} />
            <label className="flex items-start gap-3 text-sm leading-6 text-slate-700">
              <input
                type="checkbox"
                name="rememberMe"
                value="1"
                className="mt-1 h-4 w-4 rounded border-slate-300 text-primary-700 focus:ring-primary-500"
              />
              Keep me signed in on this device for 30 days. Otherwise, this session lasts 12 hours.
            </label>
            <button type="submit" className={partnerPrimaryButtonClass}>
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              Accept invitation
            </button>
          </form>
        )}

        <Link href="/partners/login" className={`${partnerSecondaryButtonClass} mt-4`}>
          Return to sign in
        </Link>
      </PartnerPanel>
    </div>
  );
}
