import type { Metadata, Route } from "next";
import Link from "next/link";
import {
  ArrowRight,
  Bell,
  BriefcaseBusiness,
  CalendarPlus2,
  Camera,
  CircleDollarSign,
  ClipboardCheck,
  MapPin,
} from "lucide-react";
import { callPartnerApi } from "@/app/partners/lib/api";
import {
  getPartnerPortalContext,
  partnerPersonaLabel,
  type PartnerCapability,
} from "@/app/partners/lib/portal-context";
import {
  loadPartnerCommercial,
  type PartnerCommercialState,
} from "@/app/partners/lib/portal-commercial";
import type {
  PartnerInvoice,
  PartnerJobSummary,
} from "@/app/partners/lib/portal-v2";
import {
  PartnerEmptyState,
  PartnerNotice,
  PartnerPageHeader,
  PartnerPanel,
  PartnerStatusBadge,
  PartnerStatCard,
  partnerPrimaryButtonClass,
} from "@/app/partners/components/PartnerPortalUi";
import {
  PartnerNotificationList,
  type PartnerDashboardNotification,
} from "@/app/partners/components/PartnerNotificationList";

export const metadata: Metadata = { title: "Overview" };

type Page = { nextCursor?: string | null; hasMore?: boolean };
type JobsPayload = { ok?: boolean; jobs?: PartnerJobSummary[]; page?: Page };
type LocationsPayload = {
  ok?: boolean;
  locations?: Array<{ id: string }>;
  page?: Page;
};
type NotificationsPayload = {
  ok?: boolean;
  notifications?: PartnerDashboardNotification[];
  page?: Page;
};
type ApprovalPayload = {
  ok?: boolean;
  approvalRequests?: Array<{ id: string; state?: string }>;
  page?: Page;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function responseJson<T>(response: Response | null): Promise<T | null> {
  if (!response?.ok) return null;
  const payload = (await response.json().catch(() => null)) as unknown;
  return isRecord(payload) && payload["ok"] === true ? (payload as T) : null;
}

function formatDateTime(
  value: string | null,
  timezone = "America/New_York",
): string {
  if (!value) return "Time to be confirmed";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Time to be confirmed";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function serviceLabel(value: string | null): string {
  if (!value) return "Service job";
  return value
    .replace(/[-_]+/gu, " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function outstandingBalance(
  invoices: PartnerCommercialState<PartnerInvoice>,
): string {
  if (invoices.status !== "ready") return "Unavailable";
  const byCurrency = new Map<
    string,
    { amountMinor: number; minorUnit: number }
  >();
  for (const invoice of invoices.items) {
    if (["paid", "void"].includes(invoice.status)) continue;
    const balance = invoice.amounts.balance;
    const current = byCurrency.get(balance.currency) ?? {
      amountMinor: 0,
      minorUnit: balance.minorUnit,
    };
    current.amountMinor += balance.amountMinor;
    byCurrency.set(balance.currency, current);
  }
  if (!byCurrency.size) return "$0.00";
  return [...byCurrency.entries()]
    .map(([currency, value]) =>
      new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
      }).format(value.amountMinor / 10 ** value.minorUnit),
    )
    .join(" + ");
}

function isOverviewInvoice(value: unknown): value is PartnerInvoice {
  if (!isRecord(value) || !isRecord(value["amounts"])) return false;
  const balance = value["amounts"]["balance"];
  return (
    typeof value["id"] === "string" &&
    typeof value["status"] === "string" &&
    isRecord(balance) &&
    typeof balance["amountMinor"] === "number" &&
    typeof balance["currency"] === "string" &&
    typeof balance["minorUnit"] === "number"
  );
}

export default async function PartnersHomePage({
  searchParams,
}: {
  searchParams?: Promise<{ setup?: string }>;
}) {
  const params = (await searchParams) ?? {};
  const setup = params.setup === "1";
  const context = await getPartnerPortalContext();
  const capabilities =
    context.status === "authenticated" ? context.capabilities : null;

  const [
    jobsResponse,
    locationsResponse,
    notificationsResponse,
    approvalsResponse,
    invoices,
  ] = await Promise.all([
    capabilities?.jobs
      ? callPartnerApi("/api/portal/v2/jobs?limit=100").catch(() => null)
      : Promise.resolve(null),
    capabilities?.locations
      ? callPartnerApi("/api/portal/v2/locations?active=true&limit=100").catch(
          () => null,
        )
      : Promise.resolve(null),
    callPartnerApi("/api/portal/v2/notifications?state=unread&limit=5").catch(
      () => null,
    ),
    capabilities?.approvals
      ? callPartnerApi(
          "/api/portal/v2/approval-requests?state=pending&limit=25",
        ).catch(() => null)
      : Promise.resolve(null),
    capabilities?.billing
      ? loadPartnerCommercial<PartnerInvoice>(
          "invoices",
          "invoices",
          isOverviewInvoice,
        )
      : Promise.resolve({ status: "forbidden" } as const),
  ]);

  const [jobsPayload, locationsPayload, notificationsPayload, approvalPayload] =
    await Promise.all([
      responseJson<JobsPayload>(jobsResponse),
      responseJson<LocationsPayload>(locationsResponse),
      responseJson<NotificationsPayload>(notificationsResponse),
      responseJson<ApprovalPayload>(approvalsResponse),
    ]);
  const jobs = Array.isArray(jobsPayload?.jobs) ? jobsPayload.jobs : [];
  const locations = Array.isArray(locationsPayload?.locations)
    ? locationsPayload.locations
    : [];
  const notifications = Array.isArray(notificationsPayload?.notifications)
    ? notificationsPayload.notifications
    : [];
  const approvalCount = Array.isArray(approvalPayload?.approvalRequests)
    ? approvalPayload.approvalRequests.filter(
        (approval) => !approval.state || approval.state === "pending",
      ).length
    : 0;
  const activeStatuses = new Set([
    "requested",
    "approval_needed",
    "under_review",
    "confirmed",
    "en_route",
    "in_progress",
  ]);
  const activeJobs = jobs.filter((job) => activeStatuses.has(job.status));
  const completedCount = jobs.filter(
    (job) => job.status === "completed",
  ).length;
  const actionJobCount = jobs.filter((job) =>
    ["approval_needed", "under_review"].includes(job.status),
  ).length;
  const nextJob = activeJobs
    .filter((job) => job.schedule.arrivalWindow?.startAt)
    .sort((left, right) =>
      String(left.schedule.arrivalWindow?.startAt).localeCompare(
        String(right.schedule.arrivalWindow?.startAt),
      ),
    )[0];
  const accountLabel =
    context.status === "authenticated"
      ? context.accountLabel
      : "Partner account";
  const persona =
    context.status === "authenticated"
      ? partnerPersonaLabel(context.partnerType)
      : "Partner services";
  const firstName =
    context.status === "authenticated"
      ? context.user.name.split(/\s+/u)[0] || context.user.name
      : "there";
  const dataUnavailable =
    Boolean(capabilities?.jobs && !jobsPayload) ||
    Boolean(capabilities?.locations && !locationsPayload) ||
    !notificationsPayload;
  const quickActions: Array<{
    href: Route;
    label: string;
    description: string;
    icon: typeof CalendarPlus2;
    capability: PartnerCapability;
  }> = [
    {
      href: "/partners/book",
      label: "Schedule a job",
      description:
        "Choose a location, add scope and photos, then select live availability.",
      icon: CalendarPlus2,
      capability: "schedule",
    },
    {
      href: "/partners/bookings",
      label: "Review jobs",
      description:
        "Track status, change timing, share proof, or message Stonegate.",
      icon: BriefcaseBusiness,
      capability: "jobs",
    },
    {
      href: "/partners/properties",
      label: "Manage locations",
      description:
        "Reuse site contacts, access notes, parking, and loading details.",
      icon: MapPin,
      capability: "locations",
    },
    {
      href: "/partners/photos",
      label: "Photos & proof",
      description:
        "Review intake, before, after, and completion documentation.",
      icon: Camera,
      capability: "proof",
    },
  ];

  return (
    <div className="space-y-5 sm:space-y-6">
      <PartnerPageHeader
        eyebrow={persona}
        title={`Welcome back, ${firstName}`}
        description={`Manage service for ${accountLabel}, from the first scope note through payment and completion proof.`}
        actions={
          capabilities?.schedule ? (
            <Link href="/partners/book" className={partnerPrimaryButtonClass}>
              <CalendarPlus2 className="h-4 w-4" aria-hidden="true" />
              Schedule job
            </Link>
          ) : undefined
        }
      >
        {setup ? (
          <PartnerNotice tone="warning">
            <span className="font-semibold">Finish account security:</span>{" "}
            review your password, MFA, sessions, and notification preferences.{" "}
            <Link className="font-semibold underline" href="/partners/settings">
              Open settings
            </Link>
          </PartnerNotice>
        ) : null}
        {dataUnavailable ? (
          <PartnerNotice tone="warning" className={setup ? "mt-3" : undefined}>
            Some dashboard information could not be refreshed. No account or job
            information was changed.
          </PartnerNotice>
        ) : null}
      </PartnerPageHeader>

      <section
        aria-label="Account summary"
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
      >
        <PartnerStatCard
          label="Upcoming jobs"
          value={`${activeJobs.length}${jobsPayload?.page?.hasMore ? "+" : ""}`}
          detail="Confirmed or awaiting action"
        />
        <PartnerStatCard
          label="Actions & approvals"
          value={actionJobCount + approvalCount}
          detail="Review, scope, or approval needed"
        />
        <PartnerStatCard
          label="Unread updates"
          value={`${notifications.length}${notificationsPayload?.page?.hasMore ? "+" : ""}`}
          detail="Messages, proof, schedules, and billing"
        />
        <PartnerStatCard
          label="Outstanding balance"
          value={outstandingBalance(invoices)}
          detail="Across issued account invoices"
        />
      </section>

      {(notifications.length > 0 || approvalCount > 0) && (
        <section aria-labelledby="attention-heading">
          <div className="mb-3 flex items-center gap-2">
            <Bell className="h-5 w-5 text-primary-700" aria-hidden="true" />
            <h2
              id="attention-heading"
              className="text-lg font-semibold text-slate-950"
            >
              Needs your attention
            </h2>
          </div>
          <PartnerPanel>
            {approvalCount > 0 ? (
              <Link
                href={"/partners/approvals" as Route}
                className="flex min-h-11 items-center justify-between gap-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm"
              >
                <span className="flex items-center gap-3 font-semibold text-amber-950">
                  <ClipboardCheck className="h-5 w-5" aria-hidden="true" />
                  {approvalCount} approval{approvalCount === 1 ? "" : "s"}{" "}
                  waiting
                </span>
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            ) : null}
            {notifications.length ? (
              <div className={approvalCount ? "mt-3" : undefined}>
                <PartnerNotificationList initialNotifications={notifications} />
              </div>
            ) : null}
          </PartnerPanel>
        </section>
      )}

      <section aria-labelledby="quick-actions-heading">
        <h2
          id="quick-actions-heading"
          className="mb-3 text-lg font-semibold text-slate-950"
        >
          Quick actions
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {quickActions
            .filter((action) => capabilities?.[action.capability] ?? false)
            .map((action) => {
              const Icon = action.icon;
              return (
                <Link
                  key={action.href}
                  href={action.href}
                  className="group rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-primary-200 hover:shadow-md motion-reduce:hover:translate-y-0"
                >
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary-50 text-primary-700 ring-1 ring-primary-100">
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </div>
                  <h3 className="mt-4 font-semibold text-slate-950 group-hover:text-primary-800">
                    {action.label}
                  </h3>
                  <p className="mt-1 text-sm leading-6 text-slate-600">
                    {action.description}
                  </p>
                  <span className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-primary-800">
                    Open <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </span>
                </Link>
              );
            })}
        </div>
      </section>

      <PartnerPanel>
        {nextJob ? (
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                Next job
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <h2 className="text-lg font-semibold text-slate-950">
                  {nextJob.location.name ??
                    nextJob.location.address?.line1 ??
                    "Scheduled service"}
                </h2>
                <PartnerStatusBadge status={nextJob.status} />
              </div>
              <p className="mt-2 text-sm text-slate-600">
                {formatDateTime(
                  nextJob.schedule.arrivalWindow?.startAt ?? null,
                  nextJob.schedule.arrivalWindow?.timezone,
                )}{" "}
                · {serviceLabel(nextJob.service.key)}
              </p>
            </div>
            <Link
              href={`/partners/bookings/${nextJob.id}` as Route}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:border-primary-300 hover:text-primary-800"
            >
              Open job <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
        ) : (
          <PartnerEmptyState
            title="No upcoming jobs"
            description={`You have ${completedCount} completed job${completedCount === 1 ? "" : "s"} in this account. New work will appear here after it is requested.`}
            action={
              capabilities?.schedule
                ? { href: "/partners/book", label: "Schedule a job" }
                : undefined
            }
            icon={<CircleDollarSign className="h-6 w-6" aria-hidden="true" />}
          />
        )}
      </PartnerPanel>

      <p className="text-center text-xs text-slate-700">
        {locations.length}
        {locationsPayload?.page?.hasMore ? "+" : ""} active saved location
        {locations.length === 1 && !locationsPayload?.page?.hasMore
          ? ""
          : "s"}{" "}
        in this account.
      </p>
    </div>
  );
}
