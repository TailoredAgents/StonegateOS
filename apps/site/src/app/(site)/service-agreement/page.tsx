import { getPublicCompanyProfile } from "@/lib/company";

export const metadata = {
  title: "Service Agreement and Cancellation Policy | Stonegate Junk Removal",
  description:
    "Service agreement, cancellation policy, and refund terms for Stonegate Junk Removal bookings.",
};

const LAST_UPDATED = "2026-03-14";

export default function ServiceAgreementPage() {
  const company = getPublicCompanyProfile();

  return (
    <div className="mx-auto max-w-3xl px-6 py-16 md:px-10">
      <h1 className="font-display text-4xl text-primary-900">
        Service Agreement and Cancellation Policy
      </h1>
      <p className="mt-2 text-sm text-neutral-500">
        Last updated: {LAST_UPDATED}
      </p>

      <div className="prose prose-neutral mt-10 max-w-none">
        <p>
          This Service Agreement and Cancellation Policy applies to all quotes,
          bookings, deposits, payments, and services provided by {company.name}.
          By requesting, accepting, scheduling, rescheduling, or booking service
          with us, you agree to this policy.
        </p>

        <h2>Quotes, scope, and final pricing</h2>
        <p>
          Quotes are based on the information available at the time they are
          prepared. Final pricing may change if the job scope, item volume, item
          weight, access conditions, disposal requirements, material type, or
          site conditions differ from the information provided before service.
        </p>

        <h2>Deposits and prepaid jobs</h2>
        <p>
          Any job paid before service, and any deposit made before service, is
          refundable only at the owner&apos;s sole discretion, except where a
          refund is required by applicable law. Deposits and prepaid amounts may
          be retained to cover scheduling, reserved crew time, administrative
          costs, travel preparation, payment processing costs, disposal
          planning, and other business costs incurred in reliance on the
          booking.
        </p>

        <h2>Cancellation deadline</h2>
        <p>
          Cancellations must be made at least 24 hours before the originally
          scheduled service date and time. A cancellation made less than 24
          hours before the originally scheduled service date and time may result
          in forfeiture of any deposit or prepaid amount, at the owner&apos;s
          sole discretion.
        </p>

        <h2>Rescheduled jobs</h2>
        <p>
          If a job is rescheduled and later canceled, {company.name} may charge
          up to the full agreed service amount. In that circumstance, the
          customer is not entitled to a refund of any deposit, prepaid amount,
          or other payment, except where a refund is required by applicable law.
        </p>

        <h2>Customer agreement and refund waiver</h2>
        <p>
          By booking through us, you agree to this Service Agreement and
          Cancellation Policy, including the refund terms above. To the fullest
          extent permitted by law, you waive and release any right, claim,
          chargeback, dispute, or demand for a refund that conflicts with this
          policy.
        </p>

        <h2>Enforceability</h2>
        <p>
          This policy is intended to be enforced to the fullest extent permitted
          by law. If any part of this policy is found invalid or unenforceable,
          the remaining provisions will remain in effect.
        </p>

        <h2>Contact</h2>
        <p>
          Questions about this policy? Email{" "}
          <a href={`mailto:${company.email}`}>{company.email}</a> or call{" "}
          <a href={`tel:${company.phoneE164}`}>{company.phoneDisplay}</a>.
        </p>
      </div>
    </div>
  );
}
