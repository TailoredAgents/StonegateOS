import type { Metadata } from "next";
import Link from "next/link";
import { CalendarClock } from "lucide-react";
import { callPartnerApi } from "@/app/partners/lib/api";
import { PartnerRescheduleFlow } from "@/app/partners/components/PartnerRescheduleFlow";
import type { PartnerCancellationDecision } from "@/app/partners/components/PartnerJobActions";
import {
  PartnerErrorState,
  PartnerPageHeader,
  PartnerPanel,
  partnerSecondaryButtonClass,
} from "@/app/partners/components/PartnerPortalUi";

type RescheduleJob = {
  id: string;
  status: string;
  location: { name: string | null; address: { line1: string } | null };
  schedule: {
    arrivalWindow: { startAt: string; endAt: string; timezone: string } | null;
  };
  cancellation: PartnerCancellationDecision;
  allowedActions: string[];
};

export const metadata: Metadata = { title: "Change job schedule" };

function isRescheduleJob(value: unknown): value is RescheduleJob {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["id"] === "string" &&
    typeof record["status"] === "string" &&
    typeof record["location"] === "object" &&
    typeof record["schedule"] === "object" &&
    typeof record["cancellation"] === "object" &&
    Array.isArray(record["allowedActions"])
  );
}

function formatCurrentWindow(window: {
  startAt: string;
  endAt: string;
  timezone: string;
}): string {
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: window.timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(window.startAt));
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: window.timezone,
    hour: "numeric",
    minute: "2-digit",
  });
  return `${date}, ${formatter.format(new Date(window.startAt))}–${formatter.format(new Date(window.endAt))}`;
}

export default async function PartnerReschedulePage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = await params;
  const response = await callPartnerApi(
    `/api/portal/v2/jobs/${encodeURIComponent(jobId)}`,
  ).catch(() => null);
  if (!response?.ok) {
    return (
      <PartnerErrorState
        title="This job could not be prepared for rescheduling"
        description="No schedule was changed. Return to the job and try again after reviewing its current status."
        retryHref={`/partners/bookings/${encodeURIComponent(jobId)}`}
      />
    );
  }
  const payload = (await response.json().catch(() => null)) as {
    job?: unknown;
  } | null;
  if (!isRescheduleJob(payload?.job)) {
    return (
      <PartnerErrorState
        title="The job response was incomplete"
        description="No schedule was changed. Return to the job and refresh its details."
        retryHref={`/partners/bookings/${encodeURIComponent(jobId)}`}
      />
    );
  }
  const job = payload.job;
  const etag = response.headers.get("etag");
  const currentWindow = job.schedule.arrivalWindow;
  if (!etag || !currentWindow || !job.allowedActions.includes("reschedule")) {
    return (
      <PartnerErrorState
        title="This job cannot be rescheduled online"
        description="Its status or schedule no longer allows a self-service change. No schedule was changed."
        retryHref={`/partners/bookings/${encodeURIComponent(job.id)}`}
      />
    );
  }
  const locationName =
    job.location.name?.trim() || job.location.address?.line1 || "this job";
  const cancellationDeadline = job.cancellation.deadlineAt
    ? Date.parse(job.cancellation.deadlineAt)
    : Number.NaN;
  const scheduleChangeRequiresReview =
    job.status === "confirmed" &&
    (!job.cancellation.directCancellationEnabled ||
      job.cancellation.policySource === "unconfigured" ||
      !Number.isFinite(cancellationDeadline) ||
      Date.now() >= cancellationDeadline);

  return (
    <div className="space-y-5 sm:space-y-6">
      <PartnerPageHeader
        eyebrow={`Job ${job.id.slice(0, 8).toUpperCase()}`}
        title="Change arrival window"
        description={`Choose a new two-hour arrival window for ${locationName}. Your current schedule stays in place until the change is confirmed.`}
        breadcrumbs={[
          { label: "Overview", href: "/partners/overview" },
          { label: "Jobs", href: "/partners/bookings" },
          {
            label: `Job ${job.id.slice(0, 8)}`,
            href: `/partners/bookings/${job.id}`,
          },
          {
            label: "Change schedule",
            href: `/partners/bookings/${job.id}/reschedule`,
          },
        ]}
      />

      <PartnerPanel>
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-50 text-primary-700">
            <CalendarClock className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h2 className="font-semibold text-slate-950">
              Current arrival window
            </h2>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              {formatCurrentWindow(currentWindow)}
            </p>
          </div>
        </div>
      </PartnerPanel>

      <PartnerRescheduleFlow
        jobId={job.id}
        jobEtag={etag}
        currentWindow={currentWindow}
        cancellation={job.cancellation}
        scheduleChangeRequiresReview={scheduleChangeRequiresReview}
      />

      <Link
        href={`/partners/bookings/${encodeURIComponent(job.id)}`}
        className={partnerSecondaryButtonClass}
      >
        Back to job
      </Link>
    </div>
  );
}
