import type { Metadata, Route } from "next";
import Link from "next/link";
import {
  ArrowRight,
  CalendarClock,
  ClipboardCheck,
  Clock3,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { cn } from "@myst-os/ui";
import { callPartnerApi } from "@/app/partners/lib/api";
import { getPartnerPortalContext } from "@/app/partners/lib/portal-context";
import {
  approvalStateLabel,
  formatApprovalDate,
  isPartnerApprovalSummary,
  type PartnerApprovalState,
  type PartnerApprovalSummary,
} from "@/app/partners/lib/portal-approvals";
import { PartnerApprovalMfaGate } from "@/app/partners/components/PartnerApprovalWorkspace";
import {
  PartnerEmptyState,
  PartnerErrorState,
  PartnerNotice,
  PartnerPageHeader,
  PartnerPanel,
  partnerFieldClass,
  partnerSecondaryButtonClass,
} from "@/app/partners/components/PartnerPortalUi";

export const metadata: Metadata = { title: "Approvals" };

const FILTERS: Array<{
  value: "" | PartnerApprovalState;
  label: string;
}> = [
  { value: "pending", label: "Needs decision" },
  { value: "", label: "All approval requests" },
  { value: "approved", label: "Approved" },
  {
    value: "approved_needs_reschedule",
    label: "Approved · reschedule needed",
  },
  { value: "declined", label: "Declined" },
  { value: "expired", label: "Expired" },
  { value: "withdrawn", label: "Withdrawn" },
];

type ApprovalListPayload = {
  ok?: unknown;
  approvalRequests?: unknown;
  page?: {
    limit?: unknown;
    nextCursor?: unknown;
    hasMore?: unknown;
  };
};

async function responseErrorCode(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => null)) as {
    error?: unknown;
  } | null;
  return typeof payload?.error === "string" ? payload.error : "unknown";
}

async function loadMfaEnrollment(): Promise<boolean | null> {
  const response = await callPartnerApi("/api/portal/v2/mfa", {
    timeoutMs: 12_000,
  }).catch(() => null);
  if (!response?.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    ok?: unknown;
    security?: { enrolled?: unknown };
  } | null;
  return payload?.ok === true && typeof payload.security?.enrolled === "boolean"
    ? payload.security.enrolled
    : null;
}

function statusClass(state: PartnerApprovalState): string {
  if (state === "approved") {
    return "bg-emerald-50 text-emerald-800 ring-emerald-200";
  }
  if (state === "declined") {
    return "bg-rose-50 text-rose-800 ring-rose-200";
  }
  if (state === "pending") {
    return "bg-amber-50 text-amber-900 ring-amber-200";
  }
  if (state === "approved_needs_reschedule") {
    return "bg-sky-50 text-sky-900 ring-sky-200";
  }
  return "bg-slate-100 text-slate-700 ring-slate-200";
}

function ApprovalStatus({ state }: { state: PartnerApprovalState }) {
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset",
        statusClass(state),
      )}
    >
      {approvalStateLabel(state)}
    </span>
  );
}

function requestHeadline(approval: PartnerApprovalSummary): string {
  return approval.target.kind === "booking"
    ? `Job ${approval.target.id.slice(0, 8).toUpperCase()}`
    : `Booking request ${approval.target.id.slice(0, 8).toUpperCase()}`;
}

export default async function PartnerApprovalsPage({
  searchParams,
}: {
  searchParams?: Promise<{ state?: string; cursor?: string }>;
}) {
  const params = (await searchParams) ?? {};
  const context = await getPartnerPortalContext();
  const rawState = typeof params.state === "string" ? params.state.trim() : "";
  const selectedFilter = FILTERS.some((option) => option.value === rawState)
    ? (rawState as "" | PartnerApprovalState)
    : "pending";
  const cursor =
    typeof params.cursor === "string" && params.cursor.length <= 4_096
      ? params.cursor.trim()
      : "";

  const header = (
    <PartnerPageHeader
      eyebrow="Commercial controls"
      title="Approvals"
      description="Review account requests, captured rules, schedule holds, commercial amounts, and immutable decision history."
      breadcrumbs={[
          { label: "Overview", href: "/partners/overview" },
        { label: "Approvals", href: "/partners/approvals" },
      ]}
      actions={
        context.status === "authenticated" && context.capabilities.jobs ? (
          <Link
            href={"/partners/bookings" as Route}
            className={partnerSecondaryButtonClass}
          >
            View jobs
          </Link>
        ) : undefined
      }
    />
  );

  if (context.status !== "authenticated" || !context.capabilities.approvals) {
    return (
      <div className="space-y-5 sm:space-y-6">
        {header}
        <PartnerPanel>
          <PartnerNotice tone="info">
            Your current account role does not include approval access. Ask an
            account administrator to assign an approver role if you need to
            review these requests.
          </PartnerNotice>
        </PartnerPanel>
      </div>
    );
  }

  const query = new URLSearchParams({ limit: "25" });
  if (selectedFilter) query.set("state", selectedFilter);
  if (cursor) query.set("cursor", cursor);
  const response = await callPartnerApi(
    `/api/portal/v2/approval-requests?${query.toString()}`,
    { timeoutMs: 15_000 },
  ).catch(() => null);

  if (!response?.ok) {
    const code = response ? await responseErrorCode(response) : "unavailable";
    if (response?.status === 403 && code === "mfa_step_up_required") {
      const enrolled = await loadMfaEnrollment();
      return (
        <div className="space-y-5 sm:space-y-6">
          {header}
          <PartnerApprovalMfaGate enrolled={enrolled} />
        </div>
      );
    }
    if (response?.status === 403) {
      return (
        <div className="space-y-5 sm:space-y-6">
          {header}
          <PartnerPanel>
            <PartnerNotice tone="info">
              This account role cannot view approvals. No request details were
              disclosed.
            </PartnerNotice>
          </PartnerPanel>
        </div>
      );
    }
    if (response?.status === 422) {
      return (
        <div className="space-y-5 sm:space-y-6">
          {header}
          <PartnerPanel>
            <PartnerEmptyState
              title="That approval page link is no longer valid"
              description="Clear the saved filter or pagination link to reload current account approvals."
              action={{
                href: "/partners/approvals",
                label: "Show current approvals",
              }}
              icon={<ClipboardCheck className="h-6 w-6" aria-hidden="true" />}
            />
          </PartnerPanel>
        </div>
      );
    }
    return (
      <div className="space-y-5 sm:space-y-6">
        {header}
        <PartnerErrorState
          title="We couldn’t load approvals"
          description="No decision or schedule hold was changed. Try again before relying on this list."
          retryHref="/partners/approvals"
        />
      </div>
    );
  }

  const payload = (await response
    .json()
    .catch(() => null)) as ApprovalListPayload | null;
  const rawApprovals = payload?.approvalRequests;
  if (
    payload?.ok !== true ||
    !Array.isArray(rawApprovals) ||
    !rawApprovals.every(isPartnerApprovalSummary)
  ) {
    return (
      <div className="space-y-5 sm:space-y-6">
        {header}
        <PartnerErrorState
          title="The approval response was incomplete"
          description="No decision was changed. Refresh before reviewing account requests."
          retryHref="/partners/approvals"
        />
      </div>
    );
  }
  const approvals = rawApprovals;
  const hasMore = payload.page?.hasMore === true;
  const nextCursor =
    hasMore && typeof payload.page?.nextCursor === "string"
      ? payload.page.nextCursor
      : null;

  return (
    <div className="space-y-5 sm:space-y-6">
      {header}

      <PartnerPanel>
        <form
          method="get"
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          aria-label="Filter approval requests"
        >
          <label htmlFor="partner-approval-state" className="min-w-0 flex-1">
            <span className="text-sm font-semibold text-slate-700">
              Request state
            </span>
            <select
              id="partner-approval-state"
              name="state"
              defaultValue={selectedFilter}
              className={partnerFieldClass}
            >
              {FILTERS.map((filter) => (
                <option value={filter.value} key={filter.value || "all"}>
                  {filter.label}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={partnerSecondaryButtonClass}>
            Apply filter
          </button>
        </form>
      </PartnerPanel>

      {approvals.length === 0 ? (
        <PartnerPanel>
          <PartnerEmptyState
            title={
              selectedFilter === "pending"
                ? "No approvals need your decision"
                : "No approval requests match this state"
            }
            description={
              selectedFilter === "pending"
                ? "New account approval requests will appear here after secure MFA verification."
                : "Choose a different state to review account approval history."
            }
            action={
              selectedFilter === "pending"
                ? context.capabilities.jobs
                  ? { href: "/partners/bookings", label: "View jobs" }
                  : undefined
                : {
                    href: "/partners/approvals",
                    label: "Show pending approvals",
                  }
            }
            icon={<ClipboardCheck className="h-6 w-6" aria-hidden="true" />}
          />
        </PartnerPanel>
      ) : (
        <ol className="grid gap-3" aria-label="Approval requests">
          {approvals.map((approval) => {
            const href =
              `/partners/approvals/${encodeURIComponent(approval.id)}` as Route;
            const remaining = Math.max(
              0,
              approval.requiredDecisionCount - approval.decisionCounts.approved,
            );
            return (
              <li key={approval.id}>
                <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-primary-200 hover:shadow-md sm:p-5">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-base font-semibold text-slate-950 sm:text-lg">
                          <Link
                            href={href}
                            className="rounded underline-offset-4 hover:text-primary-800 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                          >
                            {requestHeadline(approval)}
                          </Link>
                        </h2>
                        <ApprovalStatus state={approval.state} />
                      </div>

                      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
                        <div>
                          <dt className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">
                            <UserRound className="h-4 w-4" aria-hidden="true" />
                            Requester
                          </dt>
                          <dd className="mt-1 font-medium text-slate-800">
                            {approval.requester.displayName}
                            {approval.requester.byCurrentMember ? " (you)" : ""}
                          </dd>
                          {approval.requester.roleKey ? (
                            <p className="mt-0.5 text-xs text-slate-500">
                              {approval.requester.roleKey
                                .replaceAll("_", " ")
                                .replace(/\b\w/gu, (letter) =>
                                  letter.toUpperCase(),
                                )}
                            </p>
                          ) : null}
                        </div>
                        <div>
                          <dt className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">
                            <ShieldCheck
                              className="h-4 w-4"
                              aria-hidden="true"
                            />
                            Decision progress
                          </dt>
                          <dd className="mt-1 font-medium text-slate-800">
                            {approval.decisionCounts.approved} of{" "}
                            {approval.requiredDecisionCount} approved
                          </dd>
                        </div>
                        <div>
                          <dt className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">
                            <Clock3 className="h-4 w-4" aria-hidden="true" />
                            Approval hold
                          </dt>
                          <dd className="mt-1 font-medium text-slate-800">
                            {approval.expiresAt ? (
                              <time dateTime={approval.expiresAt}>
                                {formatApprovalDate(approval.expiresAt)}
                              </time>
                            ) : (
                              "No expiry recorded"
                            )}
                          </dd>
                        </div>
                        <div>
                          <dt className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">
                            <CalendarClock
                              className="h-4 w-4"
                              aria-hidden="true"
                            />
                            Submitted
                          </dt>
                          <dd className="mt-1 font-medium text-slate-800">
                            <time dateTime={approval.createdAt}>
                              {formatApprovalDate(approval.createdAt)}
                            </time>
                          </dd>
                        </div>
                      </dl>

                      {approval.state === "pending" ? (
                        <p className="mt-3 text-sm text-slate-600">
                          {approval.requestedByCurrentMember
                            ? "Self-approval is prohibited; another authorized approver must decide."
                            : approval.currentMemberDecision
                              ? `Your ${approval.currentMemberDecision} decision is recorded. ${remaining} approval decision${remaining === 1 ? "" : "s"} remain.`
                              : `${remaining} approval decision${remaining === 1 ? "" : "s"} remain.`}
                        </p>
                      ) : null}
                    </div>

                    <Link
                      href={href}
                      className={`${partnerSecondaryButtonClass} w-full shrink-0 lg:w-auto`}
                    >
                      {approval.state === "pending" &&
                      !approval.requestedByCurrentMember &&
                      !approval.currentMemberDecision
                        ? "Review request"
                        : "View details"}
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
              `/partners/approvals?${new URLSearchParams({
                ...(selectedFilter ? { state: selectedFilter } : {}),
                cursor: nextCursor,
              }).toString()}` as Route
            }
            className={partnerSecondaryButtonClass}
          >
            Load older requests
          </Link>
        </div>
      ) : null}
    </div>
  );
}
