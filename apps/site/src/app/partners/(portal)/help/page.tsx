import type { Metadata } from "next";
import Link from "next/link";
import { PartnerPageHeader, PartnerPanel } from "@/app/partners/components/PartnerPortalUi";
import { PartnerAccessHelp } from "@/app/partners/components/PartnerAccessHelp";
import { getPublicCompanyProfile } from "@/lib/company";

export const metadata: Metadata = { title: "Help" };

export default function PartnerHelpPage() {
  return <div className="max-w-3xl space-y-6">
    <PartnerPageHeader title="Help" description="Contact the Stonegate team for access, service requests, or help with a job." />
    <PartnerAccessHelp />
    <p className="text-sm text-slate-600">{getPublicCompanyProfile().hoursSummary}</p>
    <PartnerPanel>
      <h2 className="text-lg font-semibold text-slate-950">Common questions</h2>
      <div className="mt-3 divide-y divide-slate-200">
        {[
          ["Need service today?", "Call Stonegate. Online arrival windows begin the next local day; same-day requests need our team’s help."],
          ["Need to change a job?", "Open My jobs, choose the job, and request a schedule change or cancellation. Your existing time stays in place until a replacement is confirmed."],
          ["Where are photos and documents?", "Open the job to view its photos, messages, completion record, and any billing documents your role can access."],
        ].map(([question, answer]) => <details key={question} className="py-2">
          <summary className="flex min-h-11 cursor-pointer items-center font-semibold text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2">{question}</summary>
          <p className="pb-3 text-sm leading-6 text-slate-600">{answer}</p>
        </details>)}
      </div>
    </PartnerPanel>
    <nav aria-label="Partner policies" className="flex flex-wrap gap-x-5 text-sm font-semibold text-primary-900">
      <Link href="/terms" className="inline-flex min-h-11 items-center underline">Terms</Link>
      <Link href="/privacy" className="inline-flex min-h-11 items-center underline">Privacy</Link>
      <Link href="/service-agreement" className="inline-flex min-h-11 items-center underline">Service agreement</Link>
    </nav>
  </div>;
}
