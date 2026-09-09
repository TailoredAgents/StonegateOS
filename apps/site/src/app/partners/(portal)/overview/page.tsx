import type { Metadata, Route } from "next";
import Link from "next/link";
import { CalendarPlus2 } from "lucide-react";
import { callPartnerApi } from "@/app/partners/lib/api";
import { getPartnerPortalContext } from "@/app/partners/lib/portal-context";
import type { PartnerJobSummary } from "@/app/partners/lib/portal-v2";
import {
  PartnerNotice,
  PartnerPageHeader,
  PartnerPanel,
  PartnerStatusBadge,
  partnerPrimaryButtonClass,
} from "@/app/partners/components/PartnerPortalUi";
import {
  PartnerNotificationList,
  type PartnerDashboardNotification,
} from "@/app/partners/components/PartnerNotificationList";
import { PartnerAccessHelp } from "@/app/partners/components/PartnerAccessHelp";
import { PartnerPageRefresh } from "@/app/partners/components/PartnerPageRefresh";

export const metadata: Metadata = { title: "Home" };

type Overview = {
  ok: true;
  nextJob: {
    id: string;
    status: string;
    locationName: string | null;
    startAt: string | null;
    endAt: string | null;
    timezone: string;
  } | null;
  savedRequest: {
    id: string;
    locationName: string | null;
    updatedAt: string;
  } | null;
  outstandingBalances: Array<{
    amountMinor: number;
    currency: string;
    minorUnit: number;
  }> | null;
};

async function load<T>(path: string): Promise<T | null> {
  const response = await callPartnerApi(path).catch(() => null);
  if (!response?.ok) return null;
  return response.json().catch(() => null) as Promise<T | null>;
}

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
  if (context.status !== "authenticated") return null;
  const [overview, recent, updates] = await Promise.all([
    load<Overview>("/api/portal/v2/overview"),
    context.capabilities.jobs
      ? load<{ jobs: PartnerJobSummary[] }>("/api/portal/v2/jobs?limit=5")
      : null,
    load<{
      notifications: PartnerDashboardNotification[];
      page?: { nextCursor?: string | null };
    }>("/api/portal/v2/notifications?state=unread&limit=5"),
  ]);
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
      {!overview || !updates || (context.capabilities.jobs && !recent) ? (
        <PartnerNotice tone="warning">
          Some information could not be refreshed. Your existing jobs are
          unchanged. Try again or contact Stonegate below.
        </PartnerNotice>
      ) : null}
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
      {updates?.notifications.length ? (
        <section aria-labelledby="updates-heading">
          <h2
            id="updates-heading"
            className="mb-3 text-xl font-semibold text-slate-950"
          >
            Your updates
          </h2>
          <PartnerPanel>
            <PartnerNotificationList
              key={context.accountId}
              initialNotifications={updates.notifications}
              initialNextCursor={updates.page?.nextCursor ?? null}
            />
          </PartnerPanel>
        </section>
      ) : null}
      {overview?.outstandingBalances?.some(
        (balance) => balance.amountMinor > 0,
      ) ? (
        <PartnerPanel>
          <h2 className="font-semibold text-slate-950">Invoices to pay</h2>
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
      {context.capabilities.jobs ? (
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
            {(recent?.jobs ?? []).map((job) => (
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
          {recent?.jobs.length === 0 ? (
            <p className="py-3 text-sm text-slate-600">
              Your service requests will appear here.
            </p>
          ) : null}
        </section>
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
