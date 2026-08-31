import Link from "next/link";
import type { Route } from "next";
import {
  ArrowLeft,
  BriefcaseBusiness,
  Building2,
  CalendarClock,
  Camera,
  CircleDollarSign,
  Eye,
  FileText,
  MapPin,
  MessageSquareText,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import type { TeamRequestPrincipal } from "@/lib/team-principal";
import {
  PartnerPanel,
  PartnerStatusBadge,
} from "@/app/partners/components/PartnerPortalUi";
import { callAdminApiAs } from "../lib/api";
import {
  parsePartnerStaffPreviewResponse,
  type PartnerStaffPreviewPayload,
} from "../partner-preview";
import { teamSurfaceHref } from "../surface-registry";
import { teamButtonClass } from "./team-ui";

function previewHref(orgContactId: string, jobId?: string | null): Route {
  const query = new URLSearchParams({
    p_selected: orgContactId,
    p_preview: "1",
  });
  if (jobId) query.set("p_preview_job", jobId);
  return teamSurfaceHref("partners", { query });
}

function managementHref(orgContactId: string): Route {
  return teamSurfaceHref("partners", {
    query: { p_selected: orgContactId },
  });
}

function humanize(value: string | null | undefined): string {
  if (!value) return "Not provided";
  return value
    .replace(/[-_]+/gu, " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function formatDateTime(
  value: string | null | undefined,
  timezone = "America/New_York",
): string {
  if (!value) return "Scheduling pending";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Scheduling pending";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  }
}

function formatMoney(value: {
  amountMinor: number;
  currency: string;
  minorUnit: number;
}): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: value.currency,
    }).format(value.amountMinor / 10 ** value.minorUnit);
  } catch {
    return `${value.currency} ${(value.amountMinor / 10 ** value.minorUnit).toFixed(value.minorUnit)}`;
  }
}

function formatOutstanding(
  balances: PartnerStaffPreviewPayload["summary"]["outstandingBalances"],
): string {
  if (balances.length === 0) return "$0.00";
  return balances.map(formatMoney).join(" · ");
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

function textAt(
  record: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function locationLabel(
  job: PartnerStaffPreviewPayload["jobs"][number],
): string {
  return (
    job.location.name?.trim() ||
    job.location.address?.line1 ||
    "Service location"
  );
}

function SummaryCard({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  detail: string;
  icon: typeof BriefcaseBusiness;
}) {
  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-600">
            {label}
          </p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">{value}</p>
          <p className="mt-1 text-xs leading-5 text-slate-600">{detail}</p>
        </div>
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-50 text-primary-700 ring-1 ring-primary-100">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
      </div>
    </article>
  );
}

function PreviewUnavailable({
  orgContactId,
  status,
}: {
  orgContactId: string;
  status: number | null;
}) {
  const missing = status === 404;
  const denied = status === 403;
  return (
    <section className="space-y-5" data-partner-read-only-preview="true">
      <ReadOnlyBanner />
      <div
        role={denied ? "alert" : "status"}
        className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <h2 className="text-lg font-semibold text-slate-950">
          {denied
            ? "Preview access is not available"
            : missing
              ? "This Partner Portal account could not be found"
              : "The Partner Portal preview is temporarily unavailable"}
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          {denied
            ? "Your Team role does not include the Partner Read capability. No partner data was shown."
            : missing
              ? "The selected CRM record is not bound to an accessible Partner Portal account, or the requested job is outside that account. No cross-account details were disclosed."
              : "No account, scheduling, payment, message, or membership information was changed. Try again from Partner management."}
        </p>
        <Link
          href={managementHref(orgContactId)}
          className={`${teamButtonClass("secondary", "sm")} mt-5`}
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Return to partner management
        </Link>
      </div>
    </section>
  );
}

function ReadOnlyBanner() {
  return (
    <div
      role="status"
      aria-label="Read-only support preview"
      data-partner-preview-mutations="disabled"
      className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-4 text-amber-950 shadow-sm sm:px-5"
    >
      <div className="flex items-start gap-3">
        <Eye className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <div>
          <h2 className="font-semibold">Read-only support preview</h2>
          <p className="mt-1 text-sm leading-6">
            This is audited, account-level partner-facing data. It does not
            create a partner session. Scheduling, payments, messages, uploads,
            downloads, approvals, and account or team changes are disabled.
          </p>
        </div>
      </div>
    </div>
  );
}

function JobDetail({
  preview,
  orgContactId,
}: {
  preview: PartnerStaffPreviewPayload;
  orgContactId: string;
}) {
  const job = preview.selectedJob;
  if (!job) {
    const statuses = Object.entries(preview.summary.statusCounts).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return (
      <div className="space-y-4">
        <PartnerPanel>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary-700">
            Account overview
          </p>
          <h2 className="mt-1 text-xl font-semibold text-slate-950">
            What the account can track
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Select a job to inspect its partner-visible schedule promise,
            location, scope, timeline, proof, documents, and billing summary.
          </p>
          {statuses.length ? (
            <dl className="mt-5 grid gap-3 sm:grid-cols-2">
              {statuses.map(([status, count]) => (
                <div
                  key={status}
                  className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3"
                >
                  <dt>
                    <PartnerStatusBadge status={status} />
                  </dt>
                  <dd className="text-lg font-semibold text-slate-950">
                    {count}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-5 text-sm text-slate-600">
              This account has no partner jobs yet.
            </p>
          )}
        </PartnerPanel>
        <PartnerPanel>
          <div className="flex items-start gap-3">
            <ShieldCheck
              className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700"
              aria-hidden="true"
            />
            <div>
              <h2 className="font-semibold text-slate-950">
                Account boundary verified
              </h2>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                Jobs and related records in this view are filtered by the
                canonical Partner Portal account before they are returned.
              </p>
            </div>
          </div>
        </PartnerPanel>
      </div>
    );
  }

  const timezone =
    job.schedule.arrivalWindow?.timezone ?? "America/New_York";
  const address = job.location.address;
  const description = textAt(job.scope, "description");
  const crewInstructions = textAt(job.scope, "crewInstructions");
  const accessDetails =
    textAt(job.scope, "accessDetails") ?? job.location.access.instructions;
  return (
    <div className="space-y-4">
      <PartnerPanel>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary-700">
              Job {job.id.slice(0, 8).toUpperCase()}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold text-slate-950">
                {job.location.name?.trim() ||
                  address?.line1 ||
                  humanize(job.service.key)}
              </h2>
              <PartnerStatusBadge status={job.status} />
            </div>
            <p className="mt-2 text-sm text-slate-600">
              {humanize(job.service.key)} ·{" "}
              {formatDateTime(
                job.schedule.arrivalWindow?.startAt,
                timezone,
              )}
            </p>
          </div>
          <Link
            href={previewHref(orgContactId)}
            className={teamButtonClass("secondary", "sm")}
          >
            Close job
          </Link>
        </div>

        <dl className="mt-5 grid gap-3 border-t border-slate-200 pt-5 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-600">
              Arrival window
            </dt>
            <dd className="mt-1 text-sm font-medium text-slate-950">
              {formatDateTime(
                job.schedule.arrivalWindow?.startAt,
                timezone,
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-600">
              Location
            </dt>
            <dd className="mt-1 text-sm font-medium text-slate-950">
              {address
                ? [
                    address.line1,
                    address.line2,
                    address.city,
                    address.state,
                    address.postalCode,
                  ]
                    .filter(Boolean)
                    .join(", ")
                : "Not provided"}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-600">
              PO / cost center
            </dt>
            <dd className="mt-1 text-sm font-medium text-slate-950">
              {[job.references.poNumber, job.references.costCenter]
                .filter(Boolean)
                .join(" · ") || "Not provided"}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-600">
              Recorded amount
            </dt>
            <dd className="mt-1 text-sm font-medium text-slate-950">
              {job.financial ? formatMoney(job.financial) : "Not available"}
            </dd>
          </div>
        </dl>

        <div className="mt-5 grid gap-4 border-t border-slate-200 pt-5">
          {[
            ["Work description", description],
            ["Crew instructions", crewInstructions],
            ["Access details", accessDetails],
            ["Parking", job.location.access.parking],
            ["Loading", job.location.access.loading],
          ].map(([label, value]) => (
            <div key={label}>
              <h3 className="text-sm font-semibold text-slate-950">{label}</h3>
              <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-600">
                {value || "Not provided"}
              </p>
            </div>
          ))}
        </div>
      </PartnerPanel>

      <PartnerPanel>
        <div className="flex items-center gap-3">
          <CalendarClock
            className="h-5 w-5 text-primary-700"
            aria-hidden="true"
          />
          <h2 className="font-semibold text-slate-950">Job timeline</h2>
        </div>
        {job.timeline.length ? (
          <ol className="mt-4 space-y-3">
            {job.timeline.map((event) => (
              <li
                key={event.id}
                className="rounded-xl border border-slate-200 bg-slate-50 p-4"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="font-semibold text-slate-950">
                    {event.label}
                  </h3>
                  <time className="text-xs text-slate-600" dateTime={event.at}>
                    {formatDateTime(event.at, timezone)}
                  </time>
                </div>
                {event.detail ? (
                  <p className="mt-1 text-sm leading-6 text-slate-600">
                    {event.detail}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-4 text-sm text-slate-600">
            No public timeline events have been recorded.
          </p>
        )}
      </PartnerPanel>

      <div className="grid gap-4 lg:grid-cols-2">
        <PartnerPanel>
          <div className="flex items-center gap-3">
            <Camera className="h-5 w-5 text-primary-700" aria-hidden="true" />
            <h2 className="font-semibold text-slate-950">Photos &amp; proof</h2>
          </div>
          {job.evidence.length ? (
            <ul className="mt-4 space-y-2">
              {job.evidence.map((item) => (
                <li
                  key={item.id}
                  className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-slate-950">
                      {humanize(item.category)}
                    </span>
                    <PartnerStatusBadge status={item.status} />
                  </div>
                  <p className="mt-1 break-all text-slate-600">
                    {item.filename}
                  </p>
                  {item.caption ? (
                    <p className="mt-1 text-slate-600">{item.caption}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-sm text-slate-600">
              No partner-visible evidence is attached.
            </p>
          )}
        </PartnerPanel>

        <PartnerPanel>
          <div className="flex items-center gap-3">
            <FileText
              className="h-5 w-5 text-primary-700"
              aria-hidden="true"
            />
            <h2 className="font-semibold text-slate-950">Documents</h2>
          </div>
          {job.documents.length ? (
            <ul className="mt-4 space-y-2">
              {job.documents.map((document) => (
                <li
                  key={document.id}
                  className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm"
                >
                  <p className="break-all font-semibold text-slate-950">
                    {document.filename}
                  </p>
                  <p className="mt-1 text-xs text-slate-600">
                    {humanize(document.type)} · Version {document.version} ·{" "}
                    {formatBytes(document.byteSize)}
                  </p>
                  <p className="mt-1 text-xs font-semibold text-amber-800">
                    Download disabled in support preview
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-sm text-slate-600">
              No partner-visible documents are available.
            </p>
          )}
        </PartnerPanel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <PartnerPanel>
          <div className="flex items-center gap-3">
            <CircleDollarSign
              className="h-5 w-5 text-primary-700"
              aria-hidden="true"
            />
            <h2 className="font-semibold text-slate-950">Billing summary</h2>
          </div>
          {job.invoices.length ? (
            <ul className="mt-4 space-y-2">
              {job.invoices.map((invoice) => (
                <li
                  key={invoice.id}
                  className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-slate-950">
                      {invoice.number}
                    </span>
                    <PartnerStatusBadge status={invoice.status} />
                  </div>
                  <p className="mt-2 text-slate-600">
                    Total {formatMoney(invoice.total)} · Balance{" "}
                    {formatMoney(invoice.balance)}
                  </p>
                  <p className="mt-1 text-xs font-semibold text-amber-800">
                    Payment disabled in support preview
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-sm text-slate-600">
              No invoices are linked to this job.
            </p>
          )}
        </PartnerPanel>

        <PartnerPanel>
          <div className="flex items-center gap-3">
            <MessageSquareText
              className="h-5 w-5 text-primary-700"
              aria-hidden="true"
            />
            <h2 className="font-semibold text-slate-950">Conversation</h2>
          </div>
          <p className="mt-4 text-sm leading-6 text-slate-600">
            {job.conversation
              ? `${job.conversation.subject || "Job thread"}${job.conversation.lastMessageAt ? ` · Last update ${formatDateTime(job.conversation.lastMessageAt, timezone)}` : ""}`
              : "No partner-visible job thread is available."}
          </p>
          <p className="mt-3 text-xs font-semibold text-amber-800">
            Reading or sending messages is disabled in support preview
          </p>
        </PartnerPanel>
      </div>

      <PartnerPanel>
        <div className="flex items-start gap-3">
          <ShieldCheck
            className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700"
            aria-hidden="true"
          />
          <div>
            <h2 className="font-semibold text-slate-950">
              All job actions are disabled
            </h2>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              This preview returns an empty action set. Rescheduling,
              cancellation, messaging, payments, approvals, uploads, and
              downloads require a real authorized partner or staff workflow.
            </p>
          </div>
        </div>
      </PartnerPanel>
    </div>
  );
}

export async function PartnerPortalReadOnlyPreview({
  principal,
  orgContactId,
  selectedJobId,
}: {
  principal: TeamRequestPrincipal;
  orgContactId: string;
  selectedJobId?: string | null;
}): Promise<React.ReactElement> {
  const query = new URLSearchParams();
  if (selectedJobId) query.set("jobId", selectedJobId);
  const endpoint = `/api/admin/partners/portal-preview/${encodeURIComponent(orgContactId)}${query.size ? `?${query.toString()}` : ""}`;

  let response: Response | null = null;
  try {
    response = await callAdminApiAs(principal, endpoint);
  } catch {
    response = null;
  }
  if (!response?.ok) {
    return (
      <PreviewUnavailable
        orgContactId={orgContactId}
        status={response?.status ?? null}
      />
    );
  }
  const preview = parsePartnerStaffPreviewResponse(
    await response.json().catch(() => null),
  );
  if (!preview) {
    return <PreviewUnavailable orgContactId={orgContactId} status={500} />;
  }

  return (
    <section
      className="space-y-5 sm:space-y-6"
      data-partner-read-only-preview="true"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href={managementHref(orgContactId)}
          className={teamButtonClass("secondary", "sm")}
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Return to partner management
        </Link>
        <span className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-600">
          Account {preview.account.id.slice(0, 8).toUpperCase()}
        </span>
      </div>

      <ReadOnlyBanner />

      <header className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary-700">
              Partner Portal account preview
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">
              {preview.account.name}
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              Account overview and job records as exposed through the
              partner-facing read model, with every mutation surface removed.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <PartnerStatusBadge status={preview.account.status} />
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${
                preview.account.portalAccessEnabled
                  ? "bg-emerald-50 text-emerald-800 ring-emerald-200"
                  : "bg-amber-50 text-amber-900 ring-amber-200"
              }`}
            >
              Portal access{" "}
              {preview.account.portalAccessEnabled ? "enabled" : "disabled"}
            </span>
          </div>
        </div>
      </header>

      <section
        aria-label="Partner account summary"
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
      >
        <SummaryCard
          label="Jobs"
          value={preview.summary.totalJobCount}
          detail={preview.page.hasMore ? "Showing the 100 newest" : "All account jobs"}
          icon={BriefcaseBusiness}
        />
        <SummaryCard
          label="Active locations"
          value={preview.summary.activeLocationCount}
          detail="Saved service sites"
          icon={MapPin}
        />
        <SummaryCard
          label="Active members"
          value={preview.summary.activeMemberCount}
          detail="Portal account memberships"
          icon={UsersRound}
        />
        <SummaryCard
          label="Outstanding balance"
          value={formatOutstanding(preview.summary.outstandingBalances)}
          detail="Issued, partial, and overdue invoices"
          icon={CircleDollarSign}
        />
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(18rem,0.72fr)_minmax(0,1.55fr)]">
        <PartnerPanel>
          <div className="flex items-center gap-3">
            <Building2
              className="h-5 w-5 text-primary-700"
              aria-hidden="true"
            />
            <div>
              <h2 className="font-semibold text-slate-950">Jobs</h2>
              <p className="mt-0.5 text-xs text-slate-600">
                Select a record to inspect its read-only detail.
              </p>
            </div>
          </div>
          {preview.jobs.length ? (
            <ol
              className="mt-4 max-h-[72rem] space-y-2 overflow-y-auto pr-1"
              aria-label="Partner jobs in support preview"
            >
              {preview.jobs.map((job) => {
                const active = preview.selectedJob?.id === job.id;
                return (
                  <li key={job.id}>
                    <Link
                      href={previewHref(orgContactId, job.id)}
                      aria-current={active ? "page" : undefined}
                      className={`block min-h-11 rounded-xl border p-3 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 ${
                        active
                          ? "border-primary-300 bg-primary-50"
                          : "border-slate-200 bg-slate-50 hover:border-primary-200 hover:bg-white"
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold text-slate-950">
                          {locationLabel(job)}
                        </span>
                        <PartnerStatusBadge status={job.status} />
                      </div>
                      <p className="mt-1 text-sm text-slate-600">
                        {humanize(job.service.key)}
                      </p>
                      <p className="mt-1 text-xs text-slate-600">
                        {formatDateTime(
                          job.schedule.arrivalWindow?.startAt,
                          job.schedule.arrivalWindow?.timezone,
                        )}
                      </p>
                    </Link>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="mt-4 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-5 text-sm text-slate-600">
              No partner jobs are available for this account.
            </p>
          )}
        </PartnerPanel>

        <JobDetail preview={preview} orgContactId={orgContactId} />
      </div>
    </section>
  );
}
