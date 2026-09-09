import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PartnerAccessHelp } from "@/app/partners/components/PartnerAccessHelp";
import { callPartnerApplicantApi } from "@/app/partners/lib/api";
import {
  parsePartnerOnboardingApplicationResponse,
  type PartnerOnboardingApplicationStatus,
} from "@/app/partners/lib/onboarding";

export const metadata: Metadata = {
  title: "Previous access request",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};
export const dynamic = "force-dynamic";

const STATUS_LABELS: Record<PartnerOnboardingApplicationStatus, string> = {
  draft: "Saved draft",
  submitted: "Received",
  under_review: "Under review",
  needs_information: "More information needed",
  approved_pending_activation: "Approved — activation needed",
  approved: "Approved",
  declined: "Not approved",
  withdrawn: "Withdrawn",
};

export default async function PartnerApplicationPage() {
  const response = await callPartnerApplicantApi(
    "/api/portal/v2/onboarding/application",
    { timeoutMs: 10_000 },
  ).catch(() => null);
  if (response?.status === 401) redirect("/partners/application/expired");
  const payload = response?.ok
    ? parsePartnerOnboardingApplicationResponse(
        await response.json().catch(() => null),
        response.headers.get("etag"),
      )
    : null;
  return (
    <section className="mx-auto max-w-xl space-y-6">
      <header className="space-y-3">
        <h1 className="font-display text-3xl font-semibold text-primary-900">
          Your previous access request
        </h1>
        <p className="text-base leading-7 text-slate-600">
          Partner access is now arranged directly with Stonegate. Existing
          requests are kept for reference; contact Sales for an update or any
          changes.
        </p>
      </header>
      {payload ? (
        <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5">
          <dl className="space-y-3 text-base">
            <div>
              <dt className="text-sm text-slate-500">Status</dt>
              <dd className="font-semibold text-primary-900">
                {STATUS_LABELS[payload.application.status]}
              </dd>
            </div>
            {payload.application.companyName ? (
              <div>
                <dt className="text-sm text-slate-500">Company</dt>
                <dd>{payload.application.companyName}</dd>
              </div>
            ) : null}
            <div>
              <dt className="text-sm text-slate-500">Email</dt>
              <dd className="break-all">{payload.application.email}</dd>
            </div>
          </dl>
          {payload.application.informationRequest ? (
            <p className="whitespace-pre-wrap text-slate-700">
              {payload.application.informationRequest}
            </p>
          ) : null}
          {["approved", "approved_pending_activation"].includes(
            payload.application.status,
          ) ? (
            <p className="text-sm leading-6 text-slate-600">
              Use your activation email to finish setting up. If you cannot find
              it, Sales can help.
            </p>
          ) : null}
        </div>
      ) : (
        <div
          role="alert"
          className="rounded-2xl border border-slate-200 bg-white p-5"
        >
          <p className="font-semibold text-primary-900">
            We couldn’t load your request.
          </p>
          <p className="mt-2 text-slate-600">
            Nothing was changed. Try again or contact Sales for help.
          </p>
          <a
            className="mt-3 inline-flex min-h-11 items-center font-semibold text-primary-900 underline"
            href="/partners/application"
          >
            Try again
          </a>
        </div>
      )}
      <PartnerAccessHelp />
      <Link
        href="/partners/login"
        className="inline-flex min-h-11 items-center font-semibold text-primary-900 underline"
      >
        Back to sign in
      </Link>
    </section>
  );
}
