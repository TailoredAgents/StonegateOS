import type { Metadata, Route } from "next";
import Link from "next/link";
import { CalendarPlus2 } from "lucide-react";
import { callPartnerApi } from "@/app/partners/lib/api";
import { getPartnerPortalContext } from "@/app/partners/lib/portal-context";
import {
  loadPartnerPortalResource,
  portalLoadErrorMessage,
} from "../../lib/portal-load";
import {
  parsePortalOverview,
  parsePortalJobs,
  parsePortalNotifications,
} from "../../lib/portal-read-models";
import { PartnerHomeSection } from "../../components/PartnerHomeSection";
import {
  PartnerPageHeader,
  PartnerPanel,
  PartnerStatusBadge,
  partnerPrimaryButtonClass,
} from "@/app/partners/components/PartnerPortalUi";
import { PartnerNotificationList } from "@/app/partners/components/PartnerNotificationList";
import { PartnerAccessHelp } from "@/app/partners/components/PartnerAccessHelp";
import { PartnerPageRefresh } from "@/app/partners/components/PartnerPageRefresh";

export const metadata: Metadata = { title: "Home" };

function arrival(
  start: string | null | undefined,
  end: string | null | undefined,
  timezone = "America/New_York",
) {
  if (!start || !end) return "Waiting for Stonegate to confirm";
  const from = new Date(start),
    to = new Date(end);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()))
    return "Time to be confirmed";
  return `${new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", month: "short", day: "numeric" }).format(from)} · ${new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" }).format(from)}–${new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(to)}`;
}

export default async function PartnersHomePage() {
  const context = await getPartnerPortalContext();
  if (context.status !== "authenticated" || !context.availability.reads)
    return null;
  const [overviewResult, recentResult, updatesResult] = await Promise.all([
    loadPartnerPortalResource(
      () => callPartnerApi("/api/portal/v2/overview"),
      parsePortalOverview,
    ),
    context.capabilities.jobs
      ? loadPartnerPortalResource(
          () => callPartnerApi("/api/portal/v2/jobs?limit=5"),
          parsePortalJobs,
        )
      : null,
    loadPartnerPortalResource(
      () => callPartnerApi("/api/portal/v2/notifications?state=unread&limit=5"),
      parsePortalNotifications,
    ),
  ]);
  const overview = overviewResult.status === "ok" ? overviewResult.value : null;
  const recent = recentResult?.status === "ok" ? recentResult.value : null;
  const updates = updatesResult.status === "ok" ? updatesResult.value : null;
  const overviewError =
    overviewResult.status === "error"
      ? portalLoadErrorMessage(
          overviewResult,
          "Your next job, saved request, and invoice summary could not be refreshed. Try again.",
        )
      : null;
  const next = overview?.nextJob;
  const saved = overview?.savedRequest;
  return (
    <div className="space-y-6">
      <PartnerPageRefresh resourceKey={context.accountId} />
      <PartnerPageHeader
        title="Home"
        description={context.accountLabel}
        actions={
          context.capabilities.schedule ? (
            <Link href="/partners/book" className={partnerPrimaryButtonClass}>
              <CalendarPlus2 className="h-4 w-4" aria-hidden="true" />
              Request service
            </Link>
          ) : undefined
        }
      />
      <PartnerHomeSection
        key={`overview:${context.accountId}`}
        title="Job and account summary"
        error={overviewError}
      >
        {context.capabilities.jobs ? (
          <section aria-labelledby="next-job-heading">
            <h2
              id="next-job-heading"
              className="mb-3 text-xl font-semibold text-slate-950"
            >
              Your next job
            </h2>
            <PartnerPanel>
              {next ? (
                <Link
                  href={`/partners/bookings/${next.id}` as Route}
                  className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h3 className="font-semibold text-slate-950">
                      {next.locationName || "Stonegate service"}
                    </h3>
                    <PartnerStatusBadge status={next.status} />
                  </div>
                  <p className="mt-2 text-sm text-slate-700">
                    {arrival(next.startAt, next.endAt, next.timezone)}
                  </p>
                  <span className="mt-3 inline-flex min-h-11 items-center font-semibold text-primary-800">
                    Open job →
                  </span>
                </Link>
              ) : (
                <p className="text-sm leading-6 text-slate-600">
                  {overview
                    ? "No confirmed upcoming job. Requests awaiting confirmation are listed in My jobs."
                    : "Your next job could not be loaded."}
                </p>
              )}
            </PartnerPanel>
          </section>
        ) : null}
        {saved && context.capabilities.schedule ? (
          <PartnerPanel>
            <h2 className="text-lg font-semibold text-slate-950">
              Continue your saved request
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              {saved.locationName || "Your unfinished service request"}
            </p>
            <Link
              href={`/partners/book?draftId=${saved.id}` as Route}
              className="mt-2 inline-flex min-h-11 items-center font-semibold text-primary-800"
            >
              Continue request →
            </Link>
          </PartnerPanel>
        ) : null}
        {overview?.outstandingBalances?.some(
          (balance) => balance.amountMinor > 0,
        ) ? (
          <PartnerPanel>
            <h2 className="font-semibold text-slate-950">
              Outstanding invoices
            </h2>
            <p className="mt-1 text-sm text-slate-700">
              {overview.outstandingBalances
                .map((balance) =>
                  new Intl.NumberFormat("en-US", {
                    style: "currency",
                    currency: balance.currency,
                  }).format(balance.amountMinor / 10 ** balance.minorUnit),
                )
                .join(" + ")}
            </p>
            <Link
              href="/partners/billing"
              className="inline-flex min-h-11 items-center font-semibold text-primary-800"
            >
              View billing →
            </Link>
          </PartnerPanel>
        ) : null}
      </PartnerHomeSection>
      <PartnerHomeSection
        key={`updates:${context.accountId}`}
        title="Your updates"
        error={
          updatesResult.status === "error"
            ? portalLoadErrorMessage(
                updatesResult,
                "Your updates could not be refreshed. Try again.",
              )
            : null
        }
      >
        <h2 className="text-xl font-semibold text-slate-950">Your updates</h2>
        {updates ? (
          <PartnerPanel>
            {updates.items.length ? (
              <PartnerNotificationList
                key={context.accountId}
                initialNotifications={updates.items}
                initialNextCursor={updates.nextCursor}
              />
            ) : (
              <p className="text-sm text-slate-600">
                You’re all caught up. New messages and service updates will
                appear here.
              </p>
            )}
          </PartnerPanel>
        ) : null}
      </PartnerHomeSection>
      {context.capabilities.jobs ? (
        <PartnerHomeSection
          key={`recent:${context.accountId}`}
          title="Recent jobs"
          error={
            recentResult?.status === "error"
              ? portalLoadErrorMessage(
                  recentResult,
                  "Your recent jobs could not be refreshed. Try again.",
                )
              : null
          }
        >
          <section aria-labelledby="recent-jobs-heading">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h2
                id="recent-jobs-heading"
                className="text-xl font-semibold text-slate-950"
              >
                Recent jobs
              </h2>
              <Link
                href="/partners/bookings"
                className="inline-flex min-h-11 items-center font-semibold text-primary-800"
              >
                My jobs →
              </Link>
            </div>
            <ul className="divide-y divide-slate-200">
              {(recent?.items ?? []).map((job) => (
                <li key={job.id}>
                  <Link
                    href={`/partners/bookings/${job.id}` as Route}
                    className="flex min-h-16 flex-wrap items-center justify-between gap-3 rounded-lg py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                  >
                    <span>
                      <span className="block font-semibold text-slate-950">
                        {job.location.name || "Stonegate service"}
                      </span>
                      <span className="mt-1 block text-sm text-slate-600">
                        {arrival(
                          job.schedule.arrivalWindow?.startAt,
                          job.schedule.arrivalWindow?.endAt,
                          job.schedule.arrivalWindow?.timezone,
                        )}
                      </span>
                    </span>
                    <PartnerStatusBadge status={job.status} />
                  </Link>
                </li>
              ))}
            </ul>
            {recent?.items.length === 0 ? (
              <p className="py-3 text-sm text-slate-600">
                Your service requests will appear here.
              </p>
            ) : null}
          </section>
        </PartnerHomeSection>
      ) : null}
      <Link
        href={"/partners/updates" as Route}
        className="inline-flex min-h-11 items-center font-semibold text-primary-800"
      >
        All updates →
      </Link>
      <PartnerAccessHelp />
    </div>
  );
}
