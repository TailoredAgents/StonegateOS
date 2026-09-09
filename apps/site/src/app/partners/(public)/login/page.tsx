import type { Metadata, Route } from "next";
import { redirect } from "next/navigation";
import { PartnerAccessHelp } from "@/app/partners/components/PartnerAccessHelp";
import { PartnerPasswordLoginForm } from "@/app/partners/components/PartnerPasswordLoginForm";
import {
  PartnerNotice,
} from "@/app/partners/components/PartnerPortalUi";
import { getPartnerPortalContext } from "@/app/partners/lib/portal-context";
import { normalizePartnerReturnTo } from "@/app/partners/lib/safe-return";

export const metadata: Metadata = {
  title: "Partner sign in",
  robots: { index: false, follow: false, nocache: true },
  referrer: "same-origin",
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
    emailChanged?: string;
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
    <div className="mx-auto w-full max-w-md">
      <div>
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-950">
            Partner sign in
          </h1>
          <p className="mt-3 text-base leading-7 text-slate-600">
            Request service and check your Stonegate jobs.
          </p>

          {params.reset === "1" ? (
            <PartnerNotice tone="success" className="mt-5">
              Password reset. Sign in with your new password.
            </PartnerNotice>
          ) : null}
          {params.emailChanged === "1" ? (
            <PartnerNotice tone="success" className="mt-5">
              Your email was updated. Sign in with your new email.
            </PartnerNotice>
          ) : null}
          {loginError(error) ? (
            <PartnerNotice tone="error" className="mt-5">
              {loginError(error)}
            </PartnerNotice>
          ) : null}

          <PartnerPasswordLoginForm returnTo={returnTo} />

          <PartnerAccessHelp className="mt-6 border-t border-slate-200 pt-4" />
        </div>
      </div>
    </div>
  );
}
