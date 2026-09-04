import type { Metadata, Route } from "next";
import Link from "next/link";
import {
  ArrowRight,
  BriefcaseBusiness,
  CalendarPlus2,
  Clock3,
  MapPin,
  Search,
} from "lucide-react";
import { callPartnerApi } from "@/app/partners/lib/api";
import { getPartnerPortalContext } from "@/app/partners/lib/portal-context";
import type { PartnerJobSummary } from "@/app/partners/lib/portal-v2";
import {
  PartnerEmptyState,
  PartnerErrorState,
  PartnerNotice,
  PartnerPageHeader,
  PartnerPanel,
  PartnerStatusBadge,
  partnerFieldClass,
  partnerPrimaryButtonClass,
  partnerSecondaryButtonClass,
} from "@/app/partners/components/PartnerPortalUi";

export const metadata: Metadata = { title: "Jobs" };

const JOB_STATUS_OPTIONS = [
  ["", "All statuses"],
  ["requested", "Requested"],
  ["approval_needed", "Approval needed"],
  ["under_review", "Under review"],
  ["confirmed", "Confirmed"],
  ["en_route", "En route"],
  ["in_progress", "In progress"],
  ["completed", "Completed"],
  ["canceled", "Canceled"],
  ["declined", "Declined"],
] as const;

const JOB_VIEWS = [
  { key: "all", label: "All jobs", statuses: [] },
  {
    key: "upcoming",
    label: "Upcoming",
    statuses: ["confirmed", "en_route", "in_progress"],
  },
  {
    key: "attention",
    label: "Needs attention",
    statuses: ["requested", "approval_needed", "under_review"],
  },
  {
    key: "history",
    label: "History",
    statuses: ["completed", "canceled", "declined"],
  },
] as const;

type JobView = (typeof JOB_VIEWS)[number]["key"];

function dateOnly(value: string | undefined): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return "";
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
    ? value
    : "";
}

function formatDateTime(
  value: string | null,
  timezone = "America/New_York",
): string {
  if (!value) return "Scheduling pending";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Scheduling pending";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function humanize(value: string | null | undefined): string {
  if (!value) return "Service";
  return value
    .replace(/[-_]+/gu, " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function locationLabel(job: PartnerJobSummary): string {
  if (job.location.name?.trim()) return job.location.name;
  const address = job.location.address;
  return address ? `${address.line1}, ${address.city}` : "Service location";
}

function formatMoney(job: PartnerJobSummary): string | null {
  if (!job.financial) return null;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: job.financial.currency || "USD",
  }).format(job.financial.amountMinor / 10 ** job.financial.minorUnit);
}

function nextStep(status: string): string {
  switch (status) {
    case "requested":
      return "Stonegate is checking the request";
    case "approval_needed":
      return "An account approval is needed";
    case "under_review":
      return "Stonegate is reviewing the details";
    case "confirmed":
      return "Check the arrival window and site contact";
    case "en_route":
      return "Keep the on-site contact available";
    case "in_progress":
      return "Follow updates here";
    case "completed":
      return "Review proof and documents";
    case "canceled":
      return "No further action is required";
    case "declined":
      return "Review the job or contact Stonegate";
    default:
      return "Open the job for current details";
  }
}

function isJobSummary(value: unknown): value is PartnerJobSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["id"] === "string" &&
    typeof record["status"] === "string" &&
    typeof record["service"] === "object" &&
    typeof record["schedule"] === "object" &&
    typeof record["location"] === "object"
  );
}

export default async function PartnerBookingsPage({
  searchParams,
}: {
  searchParams?: Promise<{
    created?: string;
    status?: string;
    search?: string;
    view?: string;
    from?: string;
    to?: string;
    cursor?: string;
  }>;
}) {
  const params = (await searchParams) ?? {};
  const status = JOB_STATUS_OPTIONS.some(([value]) => value === params.status)
    ? (params.status?.trim() ?? "")
    : "";
  const search =
    typeof params.search === "string" ? params.search.trim().slice(0, 100) : "";
  const view = JOB_VIEWS.some((item) => item.key === params.view)
    ? (params.view as JobView)
    : "all";
  const from = dateOnly(params.from);
  const to = dateOnly(params.to);
  const cursor = typeof params.cursor === "string" ? params.cursor.trim() : "";
  const query = new URLSearchParams({ limit: "25" });
  const viewStatuses =
    JOB_VIEWS.find((item) => item.key === view)?.statuses ?? [];
  if (status) query.set("status", status);
  else if (viewStatuses.length > 0) query.set("status", viewStatuses.join(","));
  if (search) query.set("search", search);
  if (from) query.set("from", `${from}T00:00:00.000Z`);
  if (to) query.set("to", `${to}T23:59:59.999Z`);
  if (cursor) query.set("cursor", cursor);

  const [response, context] = await Promise.all([
    callPartnerApi(`/api/portal/v2/jobs?${query.toString()}`).catch(() => null),
    getPartnerPortalContext(),
  ]);
  const permissions =
    context.status === "authenticated" ? context.permissions : null;

  if (!response?.ok) {
    const unavailable = [404, 409, 501, 503].includes(response?.status ?? 503);
    return (
      <div className="space-y-5 sm:space-y-6">
        <PartnerPageHeader
          eyebrow="Your service requests"
          title="Jobs"
          description="See the status and next step for every Stonegate job in this account."
          breadcrumbs={[
            { label: "Overview", href: "/partners/overview" },
            { label: "Jobs", href: "/partners/bookings" },
          ]}
        />
        {unavailable ? (
          <PartnerPanel>
            <PartnerEmptyState
              title="The upgraded job workspace is not available for this account yet"
              description="No job data has been changed. Contact Stonegate if you need an immediate status update or service record."
              action={{ href: "/partners/help", label: "Contact Stonegate" }}
              icon={
                <BriefcaseBusiness className="h-6 w-6" aria-hidden="true" />
              }
            />
          </PartnerPanel>
        ) : (
          <PartnerErrorState
            title="We couldn’t load your jobs"
            description="Your job records are unchanged. Try again in a moment."
            retryHref="/partners/bookings"
          />
        )}
      </div>
    );
  }

  const payload = (await response.json().catch(() => null)) as {
    jobs?: unknown[];
    page?: { nextCursor?: string | null; hasMore?: boolean };
  } | null;
  const jobs = (payload?.jobs ?? []).filter(isJobSummary);
  const nextCursor = payload?.page?.hasMore
    ? (payload.page.nextCursor ?? null)
    : null;

  return (
    <div className="space-y-5 sm:space-y-6">
      <PartnerPageHeader
        eyebrow="Your service requests"
        title="Jobs"
        description="Find any job quickly, see what happens next, and keep updates, proof, and documents together."
        breadcrumbs={[
          { label: "Overview", href: "/partners/overview" },
          { label: "Jobs", href: "/partners/bookings" },
        ]}
        actions={
          permissions?.scheduleJobs ? (
            <Link href="/partners/book" className={partnerPrimaryButtonClass}>
              <CalendarPlus2 className="h-4 w-4" aria-hidden="true" />
              Request service
            </Link>
          ) : undefined
        }
      >
        {params.created === "1" ? (
          <PartnerNotice tone="success">
            Your request was sent. Its status and next step are shown below.
          </PartnerNotice>
        ) : null}
      </PartnerPageHeader>

      <PartnerPanel>
        <nav
          aria-label="Job views"
          className="mb-4 flex gap-2 overflow-x-auto pb-1"
        >
          {JOB_VIEWS.map((item) => {
            const active = view === item.key && !status;
            const viewQuery = new URLSearchParams({ view: item.key });
            if (search) viewQuery.set("search", search);
            if (from) viewQuery.set("from", from);
            if (to) viewQuery.set("to", to);
            return (
              <Link
                key={item.key}
                href={`/partners/bookings?${viewQuery.toString()}` as Route}
                aria-current={active ? "page" : undefined}
                className={`${partnerSecondaryButtonClass} shrink-0 ${
                  active
                    ? "border-primary-300 bg-primary-50 text-primary-900"
                    : ""
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <form
          method="get"
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_11rem_10rem_10rem_auto] lg:items-end"
          role="search"
        >
          <input type="hidden" name="view" value={view} />
          <label htmlFor="partner-job-search">
            <span className="text-sm font-semibold text-slate-700">
              Search jobs
            </span>
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                aria-hidden="true"
              />
              <input
                id="partner-job-search"
                name="search"
                type="search"
                defaultValue={search}
                maxLength={100}
                className={`${partnerFieldClass} pl-10`}
                placeholder="Location, PO, or project"
              />
            </div>
          </label>
          <label htmlFor="partner-job-status">
            <span className="text-sm font-semibold text-slate-700">Status</span>
            <select
              id="partner-job-status"
              name="status"
              defaultValue={status}
              className={partnerFieldClass}
            >
              {JOB_STATUS_OPTIONS.map(([value, label]) => (
                <option key={value || "all"} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor="partner-job-from">
            <span className="text-sm font-semibold text-slate-700">From</span>
            <input
              id="partner-job-from"
              name="from"
              type="date"
              defaultValue={from}
              className={partnerFieldClass}
            />
          </label>
          <label htmlFor="partner-job-to">
            <span className="text-sm font-semibold text-slate-700">To</span>
            <input
              id="partner-job-to"
              name="to"
              type="date"
              defaultValue={to}
              min={from || undefined}
              className={partnerFieldClass}
            />
          </label>
          <button type="submit" className={partnerSecondaryButtonClass}>
            Apply filters
          </button>
        </form>
      </PartnerPanel>

      {jobs.length === 0 ? (
        <PartnerPanel>
          <PartnerEmptyState
            title={
              status || search || view !== "all" || from || to
                ? "No jobs match these filters"
                : "No jobs yet"
            }
            description={
              status || search || view !== "all" || from || to
                ? "Try a different view, status, date range, or search term."
                : "Request service and its status, updates, proof, and documents will stay organized here."
            }
            action={
              status || search || view !== "all" || from || to
                ? { href: "/partners/bookings", label: "Clear filters" }
                : permissions?.scheduleJobs
                  ? { href: "/partners/book", label: "Request service" }
                  : undefined
            }
            icon={<BriefcaseBusiness className="h-6 w-6" aria-hidden="true" />}
          />
        </PartnerPanel>
      ) : (
        <ol className="grid gap-3" aria-label="Jobs">
          {jobs.map((job) => {
            const window = job.schedule.arrivalWindow;
            const detailHref =
              `/partners/bookings/${encodeURIComponent(job.id)}` as Route;
            return (
              <li key={job.id}>
                <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-primary-200 hover:shadow-md sm:p-5">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-base font-semibold text-slate-950 sm:text-lg">
                          <Link
                            href={detailHref}
                            className="rounded underline-offset-4 hover:text-primary-800 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                          >
                            {locationLabel(job)}
                          </Link>
                        </h2>
                        <PartnerStatusBadge status={job.status} />
                      </div>
                      <p className="mt-1 text-sm font-medium text-slate-700">
                        {humanize(job.service.key)}
                      </p>
                      <p className="mt-2 text-sm text-primary-800">
                        <span className="font-semibold">Next:</span>{" "}
                        {nextStep(job.status)}
                      </p>
                      <div className="mt-3 flex flex-col gap-2 text-sm text-slate-600 sm:flex-row sm:flex-wrap sm:gap-x-5">
                        <span className="inline-flex items-center gap-2">
                          <Clock3
                            className="h-4 w-4 shrink-0 text-slate-400"
                            aria-hidden="true"
                          />
                          <time dateTime={window?.startAt}>
                            {formatDateTime(
                              window?.startAt ?? null,
                              window?.timezone,
                            )}
                          </time>
                        </span>
                        {job.location.address ? (
                          <span className="inline-flex items-center gap-2">
                            <MapPin
                              className="h-4 w-4 shrink-0 text-slate-400"
                              aria-hidden="true"
                            />
                            {job.location.address.line1},{" "}
                            {job.location.address.city}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                        {job.references.poNumber ? (
                          <span>PO: {job.references.poNumber}</span>
                        ) : null}
                        {job.references.costCenter ? (
                          <span>Cost center: {job.references.costCenter}</span>
                        ) : null}
                        {job.references.project ? (
                          <span>Project: {job.references.project}</span>
                        ) : null}
                        {formatMoney(job) ? (
                          <span>{formatMoney(job)}</span>
                        ) : null}
                      </div>
                    </div>
                    <Link
                      href={detailHref}
                      className={`${partnerSecondaryButtonClass} w-full shrink-0 sm:w-auto`}
                    >
                      View details{" "}
                      <ArrowRight className="h-4 w-4" aria-hidden="true" />
                    </Link>
                  </div>
                </article>
              </li>
            );
          })}
        </ol>
      )}

      {nextCursor ? (
        <div className="flex justify-center">
          <Link
            href={
              `/partners/bookings?${new URLSearchParams({ ...(view !== "all" ? { view } : {}), ...(status ? { status } : {}), ...(search ? { search } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}), cursor: nextCursor }).toString()}` as Route
            }
            className={partnerSecondaryButtonClass}
          >
            Load older jobs
          </Link>
        </div>
      ) : null}
    </div>
  );
}
