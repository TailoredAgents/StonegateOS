import type { PublicCompanyProfile } from "@/lib/company";
import { PartnerAccessHelp } from "./PartnerAccessHelp";
import { PartnerPasswordLoginForm } from "./PartnerPasswordLoginForm";

export function PartnerLandingContent({
  sessionUnavailable = false,
}: {
  company: PublicCompanyProfile;
  sessionUnavailable?: boolean;
}) {
  return (
    <section
      className="partner-login-card mx-auto w-full max-w-lg"
      aria-labelledby="partner-landing-title"
    >
      <p className="text-sm font-semibold text-primary-900">
        Stonegate Partner Portal
      </p>
      <h1
        id="partner-landing-title"
        className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl"
      >
        Quick and easy service for our partners.
      </h1>
      {sessionUnavailable ? (
        <div
          className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950"
          role="status"
        >
          <p>
            We couldn’t check your sign-in right now. Your jobs and account have
            not changed.
          </p>
          <a
            href="/partners"
            className="mt-2 inline-flex min-h-11 items-center font-semibold underline underline-offset-4"
            data-partner-analytics="unavailable_retry"
          >
            Try again
          </a>
        </div>
      ) : (
        <PartnerPasswordLoginForm />
      )}
      <PartnerAccessHelp className="mt-8 border-t border-slate-200 pt-6" />
    </section>
  );
}
