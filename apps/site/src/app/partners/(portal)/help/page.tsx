import type { Metadata } from "next";
import Link from "next/link";
import { Clock3, Mail, MessageSquareText, Phone } from "lucide-react";
import { getPublicCompanyProfile } from "@/lib/company";
import {
  PartnerPageHeader,
  PartnerPanel,
  partnerPrimaryButtonClass,
  partnerSecondaryButtonClass,
} from "@/app/partners/components/PartnerPortalUi";

export const metadata: Metadata = { title: "Help" };

export default function PartnerHelpPage() {
  const company = getPublicCompanyProfile();
  return (
    <div className="space-y-5 sm:space-y-6">
      <PartnerPageHeader
        eyebrow="Partner support"
        title="How can we help?"
        description="Reach the Stonegate team for scheduling questions, access help, special materials, or documentation."
        breadcrumbs={[
          { label: "Overview", href: "/partners/overview" },
          { label: "Help", href: "/partners/help" },
        ]}
        actions={
          <a
            href={`tel:${company.phoneE164}`}
            className={partnerPrimaryButtonClass}
          >
            <Phone className="h-4 w-4" aria-hidden="true" />
            Call {company.phoneDisplay}
          </a>
        }
      />

      <div className="grid gap-4 md:grid-cols-3">
        <PartnerPanel className="flex flex-col">
          <Phone className="h-6 w-6 text-primary-700" aria-hidden="true" />
          <h2 className="mt-4 font-semibold text-slate-950">Call</h2>
          <p className="mt-1 flex-1 text-sm leading-6 text-slate-600">
            Best for same-day needs, schedule changes, or material questions.
          </p>
          <a
            href={`tel:${company.phoneE164}`}
            className={`${partnerSecondaryButtonClass} mt-5 w-full`}
          >
            {company.phoneDisplay}
          </a>
        </PartnerPanel>
        <PartnerPanel className="flex flex-col">
          <MessageSquareText
            className="h-6 w-6 text-primary-700"
            aria-hidden="true"
          />
          <h2 className="mt-4 font-semibold text-slate-950">Text</h2>
          <p className="mt-1 flex-1 text-sm leading-6 text-slate-600">
            Send a quick question or identify the job you need help with.
          </p>
          <a
            href={`sms:${company.phoneE164}`}
            className={`${partnerSecondaryButtonClass} mt-5 w-full`}
          >
            Text Stonegate
          </a>
        </PartnerPanel>
        <PartnerPanel className="flex flex-col">
          <Mail className="h-6 w-6 text-primary-700" aria-hidden="true" />
          <h2 className="mt-4 font-semibold text-slate-950">Email</h2>
          <p className="mt-1 flex-1 text-sm leading-6 text-slate-600">
            Use email for documents, account details, or a less urgent request.
          </p>
          <a
            href={`mailto:${company.email}`}
            className={`${partnerSecondaryButtonClass} mt-5 w-full`}
          >
            Email Stonegate
          </a>
        </PartnerPanel>
      </div>

      <PartnerPanel>
        <div className="flex items-start gap-3">
          <Clock3
            className="mt-0.5 h-5 w-5 shrink-0 text-primary-700"
            aria-hidden="true"
          />
          <div>
            <h2 className="font-semibold text-slate-950">Support hours</h2>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              {company.hoursSummary}
            </p>
          </div>
        </div>
      </PartnerPanel>

      <PartnerPanel>
        <h2 className="text-lg font-semibold text-slate-950">
          Common questions
        </h2>
        <div className="mt-4 divide-y divide-slate-200">
          {[
            {
              question: "How do I request same-day service?",
              answer:
                "Call or text Stonegate. Online scheduling begins with the next available service day.",
            },
            {
              question: "What if a location is gated or hard to access?",
              answer:
                "Use Locations to save ordinary access, parking, loading, and site-contact details. Save a gate or lockbox code only in the separate private-access field, which is encrypted and never shown back.",
            },
            {
              question: "Can I change a scheduled job?",
              answer:
                "Open the job and choose Request schedule change when that action is available. Stonegate will confirm the replacement; do not assume the original time changed until its status updates.",
            },
            {
              question: "Where do I request before-and-after photos?",
              answer:
                "During Schedule job, use the Photos & proof step to request before photos, after photos, or a formal package and attach reference images. After submission, use Photos & proof to add or review job-linked evidence.",
            },
          ].map((item) => (
            <details
              key={item.question}
              className="group py-4 first:pt-0 last:pb-0"
            >
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 font-semibold text-slate-900 [&::-webkit-details-marker]:hidden">
                {item.question}
                <span
                  className="text-xl font-normal text-slate-400 transition group-open:rotate-45 motion-reduce:transition-none"
                  aria-hidden="true"
                >
                  +
                </span>
              </summary>
              <p className="pb-2 pr-8 text-sm leading-6 text-slate-600">
                {item.answer}
              </p>
            </details>
          ))}
        </div>
      </PartnerPanel>

      <PartnerPanel>
        <h2 className="font-semibold text-slate-950">
          Policies &amp; accessibility
        </h2>
        <p className="mt-1 text-sm leading-6 text-slate-600">
          Review the policies that apply to portal use and service. For an
          accessible-format request or help using this workspace, call or email
          Stonegate.
        </p>
        <nav
          aria-label="Partner policies"
          className="mt-4 flex flex-wrap gap-x-5 gap-y-3 text-sm font-semibold text-primary-800"
        >
          <Link
            href="/terms"
            className="inline-flex min-h-11 items-center underline underline-offset-4"
          >
            Terms
          </Link>
          <Link
            href="/privacy"
            className="inline-flex min-h-11 items-center underline underline-offset-4"
          >
            Privacy
          </Link>
          <Link
            href="/service-agreement"
            className="inline-flex min-h-11 items-center underline underline-offset-4"
          >
            Service agreement
          </Link>
          <a
            href={`mailto:${company.email}?subject=Partner%20portal%20accessibility%20help`}
            className="inline-flex min-h-11 items-center underline underline-offset-4"
          >
            Accessibility help
          </a>
        </nav>
      </PartnerPanel>
    </div>
  );
}
