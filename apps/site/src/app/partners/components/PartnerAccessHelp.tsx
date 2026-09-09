import { PARTNER_SUPPORT } from "../lib/partner-support";

export function PartnerAccessHelp({ className = "" }: { className?: string }) {
  return (
    <aside
      aria-label="Partner access and help"
      className={`text-sm leading-6 text-slate-600 ${className}`}
    >
      <p className="font-semibold text-slate-900">Need access or help?</p>
      <p>
        Email{" "}
        <a
          href={`mailto:${PARTNER_SUPPORT.email}`}
          className="inline-flex min-h-11 max-w-full items-center break-all font-semibold text-primary-900 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2"
          data-partner-analytics="landing_email_support"
        >
          {PARTNER_SUPPORT.email}
        </a>{" "}
        or call{" "}
        <a
          href={`tel:${PARTNER_SUPPORT.phoneE164}`}
          className="inline-flex min-h-11 items-center whitespace-nowrap font-semibold text-primary-900 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2"
          data-partner-analytics="landing_call_support"
        >
          {PARTNER_SUPPORT.phoneDisplay}
        </a>
        .
      </p>
    </aside>
  );
}
