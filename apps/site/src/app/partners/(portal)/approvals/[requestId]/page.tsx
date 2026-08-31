import type { Metadata, Route } from "next";
import Link from "next/link";
import {
  BadgeDollarSign,
  BriefcaseBusiness,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  FileText,
  MapPin,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { cn } from "@myst-os/ui";
import { callPartnerApi } from "@/app/partners/lib/api";
import { getPartnerPortalContext } from "@/app/partners/lib/portal-context";
import {
  approvalStateLabel,
  formatApprovalDate,
  formatApprovalMoney,
  humanizeApprovalValue,
  isPartnerApprovalDetail,
  type PartnerApprovalDetail,
  type PartnerApprovalState,
} from "@/app/partners/lib/portal-approvals";
import {
  PartnerApprovalDecisionForm,
  PartnerApprovalMfaGate,
} from "@/app/partners/components/PartnerApprovalWorkspace";
import {
  PartnerErrorState,
  PartnerNotice,
  PartnerPageHeader,
  PartnerPanel,
  partnerSecondaryButtonClass,
} from "@/app/partners/components/PartnerPortalUi";

const DISPLAY_TIMEZONE = "America/New_York";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ requestId: string }>;
}): Promise<Metadata> {
  const { requestId } = await params;
  return { title: `Approval ${requestId.slice(0, 8)}` };
}

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

function addressLabel(approval: PartnerApprovalDetail): string | null {
  const address = approval.request.address;
  if (!address) return null;
  return [
    address.line1,
    address.line2,
    [address.city, address.state, address.postalCode].filter(Boolean).join(" "),
    address.country,
  ]
    .filter(Boolean)
    .join(", ");
}

function ApprovalStateNotice({
  approval,
}: {
  approval: PartnerApprovalDetail;
}) {
  if (approval.state === "approved_needs_reschedule") {
    return (
      <PartnerNotice tone="warning">
        This request is approved, but its arrival-window hold expired. A
        scheduler must select a new available window before work can be
        confirmed. No slot is currently promised.
      </PartnerNotice>
    );
  }
  if (approval.state === "expired") {
    return (
      <PartnerNotice tone="warning">
        The decision hold expired. This request cannot be approved against the
        old window and must be rescheduled or reviewed by Stonegate.
      </PartnerNotice>
    );
  }
  if (approval.state === "approved") {
    return (
      <PartnerNotice tone="success">
        All captured approval requirements were satisfied. The approval record
        is immutable.
      </PartnerNotice>
    );
  }
  if (approval.state === "declined") {
    return (
      <PartnerNotice tone="info">
        This request was declined. Review the decision reason below before
        creating a revised request.
      </PartnerNotice>
    );
  }
  if (approval.state === "withdrawn") {
    return (
      <PartnerNotice tone="info">
        The requester withdrew this approval request. It is retained as
        read-only account history.
      </PartnerNotice>
    );
  }
  if (approval.requestedByCurrentMember) {
    return (
      <PartnerNotice tone="warning">
        You submitted this request. Self-approval is prohibited, so a different
        authorized account member must decide it.
      </PartnerNotice>
    );
  }
  if (approval.currentMemberDecision) {
    return (
      <PartnerNotice tone="info">
        Your {approval.currentMemberDecision} decision is recorded. This request
        is waiting for any remaining required account decisions.
      </PartnerNotice>
    );
  }
  return (
    <PartnerNotice tone="warning">
      This request needs an account decision before its approval hold expires.
      Review every matching rule and the request details below.
    </PartnerNotice>
  );
}

export default async function PartnerApprovalDetailPage({
  params,
}: {
  params: Promise<{ requestId: string }>;
}) {
  const { requestId } = await params;
  const context = await getPartnerPortalContext();

  if (context.status !== "authenticated" || !context.capabilities.approvals) {
    return (
      <div className="space-y-5 sm:space-y-6">
        <PartnerPageHeader
          eyebrow="Commercial controls"
          title="Approval request"
          description="Approval details are available only to authorized account approvers."
          breadcrumbs={[
            { label: "Overview", href: "/partners" },
            { label: "Approvals", href: "/partners/approvals" },
            { label: "Request", href: `/partners/approvals/${requestId}` },
          ]}
        />
        <PartnerPanel>
          <PartnerNotice tone="info">
            Your current account role cannot view this approval. No request
            details were disclosed.
          </PartnerNotice>
        </PartnerPanel>
      </div>
    );
  }

  const response = await callPartnerApi(
    `/api/portal/v2/approval-requests/${encodeURIComponent(requestId)}`,
    { timeoutMs: 15_000 },
  ).catch(() => null);

  if (!response?.ok) {
    const code = response ? await responseErrorCode(response) : "unavailable";
    if (response?.status === 403 && code === "mfa_step_up_required") {
      const enrolled = await loadMfaEnrollment();
      return (
        <div className="space-y-5 sm:space-y-6">
          <PartnerPageHeader
            eyebrow="Commercial controls"
            title="Approval request"
            description="Verify this secure session before viewing commercial request details."
            breadcrumbs={[
              { label: "Overview", href: "/partners" },
              { label: "Approvals", href: "/partners/approvals" },
              { label: "Request", href: `/partners/approvals/${requestId}` },
            ]}
          />
          <PartnerApprovalMfaGate enrolled={enrolled} />
        </div>
      );
    }
    if (response?.status === 404) {
      return (
        <PartnerErrorState
          title="This approval request could not be found"
          description="It may belong to another account or the link may be out of date. No account details were disclosed."
          retryHref="/partners/approvals"
        />
      );
    }
    if (response?.status === 403) {
      return (
        <PartnerErrorState
          title="Approval access is not available"
          description="Your current account role cannot view this request. No request details were disclosed."
          retryHref="/partners/approvals"
        />
      );
    }
    return (
      <PartnerErrorState
        title="We couldn’t load this approval"
        description="No decision or schedule hold was changed. Try again before relying on this request."
        retryHref={`/partners/approvals/${encodeURIComponent(requestId)}`}
      />
    );
  }

  const payload = (await response.json().catch(() => null)) as {
    ok?: unknown;
    approvalRequest?: unknown;
  } | null;
  if (
    payload?.ok !== true ||
    !isPartnerApprovalDetail(payload.approvalRequest)
  ) {
    return (
      <PartnerErrorState
        title="This approval response was incomplete"
        description="No decision was changed. Refresh before reviewing or deciding this request."
        retryHref={`/partners/approvals/${encodeURIComponent(requestId)}`}
      />
    );
  }

  const approval = payload.approvalRequest;
  const etag = response.headers.get("etag") ?? approval.etag;
  const request = approval.request;
  const service = request.serviceKey ?? request.serviceType ?? null;
  const address = addressLabel(approval);
  const approvedRemaining = Math.max(
    0,
    approval.requiredDecisionCount - approval.decisionCounts.approved,
  );
  const bookingHref =
    approval.target.kind === "booking" && context.capabilities.jobs
      ? (`/partners/bookings/${encodeURIComponent(approval.target.id)}` as Route)
      : null;

  return (
    <div className="space-y-5 sm:space-y-6">
      <PartnerPageHeader
        eyebrow={`Approval ${approval.id.slice(0, 8).toUpperCase()}`}
        title={service ? humanizeApprovalValue(service) : "Service request"}
        description="Review the immutable request snapshot and every matching account rule before making a decision."
        breadcrumbs={[
          { label: "Overview", href: "/partners" },
          { label: "Approvals", href: "/partners/approvals" },
          {
            label: `Request ${approval.id.slice(0, 8).toUpperCase()}`,
            href: `/partners/approvals/${approval.id}`,
          },
        ]}
        actions={
          bookingHref ? (
            <Link href={bookingHref} className={partnerSecondaryButtonClass}>
              <BriefcaseBusiness className="h-4 w-4" aria-hidden="true" />
              View related job
            </Link>
          ) : undefined
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          <span
            className={cn(
              "inline-flex rounded-full px-3 py-1.5 text-sm font-semibold ring-1 ring-inset",
              statusClass(approval.state),
            )}
          >
            {approvalStateLabel(approval.state)}
          </span>
          <span className="text-sm text-slate-600">
            Revision {approval.revision} · submitted{" "}
            <time dateTime={approval.createdAt}>
              {formatApprovalDate(approval.createdAt)}
            </time>
          </span>
        </div>
        <div className="mt-4">
          <ApprovalStateNotice approval={approval} />
        </div>
      </PartnerPageHeader>

      <PartnerPanel>
        <div className="flex items-center gap-2">
          <ClipboardCheck
            className="h-5 w-5 text-primary-700"
            aria-hidden="true"
          />
          <h2 className="text-lg font-semibold text-slate-950">
            Approval summary
          </h2>
        </div>
        <dl className="mt-5 grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
          <div>
            <dt className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">
              <UserRound className="h-4 w-4" aria-hidden="true" />
              Requester
            </dt>
            <dd className="mt-1.5 text-sm font-semibold text-slate-900">
              {approval.requester.displayName}
              {approval.requester.byCurrentMember ? " (you)" : ""}
            </dd>
            {approval.requester.roleKey ? (
              <p className="mt-1 text-xs text-slate-500">
                {humanizeApprovalValue(approval.requester.roleKey)}
              </p>
            ) : null}
          </div>
          <div>
            <dt className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              Decision progress
            </dt>
            <dd className="mt-1.5 text-sm font-semibold text-slate-900">
              {approval.decisionCounts.approved} of{" "}
              {approval.requiredDecisionCount} approvals recorded
            </dd>
            {approval.state === "pending" ? (
              <p className="mt-1 text-xs text-slate-500">
                {approvedRemaining} required decision
                {approvedRemaining === 1 ? "" : "s"} remain
              </p>
            ) : null}
          </div>
          <div>
            <dt className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">
              <Clock3 className="h-4 w-4" aria-hidden="true" />
              Approval hold expires
            </dt>
            <dd className="mt-1.5 text-sm font-semibold text-slate-900">
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
            <dt className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">
              <BadgeDollarSign className="h-4 w-4" aria-hidden="true" />
              Request amount
            </dt>
            <dd className="mt-1.5 text-sm font-semibold text-slate-900">
              {request.amount
                ? formatApprovalMoney(request.amount)
                : "Pricing review required"}
            </dd>
          </div>
        </dl>
      </PartnerPanel>

      <div className="grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
        <PartnerPanel>
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-primary-700" aria-hidden="true" />
            <h2 className="text-lg font-semibold text-slate-950">
              Request snapshot
            </h2>
          </div>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            These partner-visible details were captured when approval was
            requested. Internal notes, margins, provider data, and schedule IDs
            are not included.
          </p>
          <dl className="mt-5 grid gap-5 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">
                Service
              </dt>
              <dd className="mt-1.5 text-sm font-medium text-slate-900">
                {humanizeApprovalValue(service)}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">
                Account reference
              </dt>
              <dd className="mt-1.5 text-sm font-medium text-slate-900">
                {request.poNumber
                  ? `PO ${request.poNumber}`
                  : request.costCenter
                    ? `Cost center ${request.costCenter}`
                    : "Not provided"}
              </dd>
              {request.poNumber && request.costCenter ? (
                <p className="mt-1 text-xs text-slate-500">
                  Cost center {request.costCenter}
                </p>
              ) : null}
            </div>
            <div className="sm:col-span-2">
              <dt className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">
                <MapPin className="h-4 w-4" aria-hidden="true" />
                Service address
              </dt>
              <dd className="mt-1.5 text-sm font-medium text-slate-900">
                {address ?? "Address not included in this approval snapshot"}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">
                <CalendarClock className="h-4 w-4" aria-hidden="true" />
                Requested schedule
              </dt>
              <dd className="mt-1.5 text-sm font-medium text-slate-900">
                {request.scheduledStartAt ? (
                  <>
                    <time dateTime={request.scheduledStartAt}>
                      {formatApprovalDate(request.scheduledStartAt, {
                        timezone: DISPLAY_TIMEZONE,
                      })}
                    </time>
                    {request.scheduledEndAt ? (
                      <>
                        {" "}
                        to{" "}
                        <time dateTime={request.scheduledEndAt}>
                          {formatApprovalDate(request.scheduledEndAt, {
                            timezone: DISPLAY_TIMEZONE,
                          })}
                        </time>
                      </>
                    ) : null}
                    {" · Eastern Time"}
                  </>
                ) : (
                  "A confirmed arrival window is not included"
                )}
              </dd>
            </div>
            {request.description ? (
              <div className="sm:col-span-2">
                <dt className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">
                  Scope description
                </dt>
                <dd className="mt-1.5 whitespace-pre-wrap text-sm leading-6 text-slate-800">
                  {request.description}
                </dd>
              </div>
            ) : null}
            {request.notes ? (
              <div className="sm:col-span-2">
                <dt className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">
                  Request note
                </dt>
                <dd className="mt-1.5 whitespace-pre-wrap text-sm leading-6 text-slate-800">
                  {request.notes}
                </dd>
              </div>
            ) : null}
          </dl>
        </PartnerPanel>

        <PartnerPanel>
          <div className="flex items-center gap-2">
            <ShieldCheck
              className="h-5 w-5 text-primary-700"
              aria-hidden="true"
            />
            <h2 className="text-lg font-semibold text-slate-950">
              Matching approval rules
            </h2>
          </div>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Every rule captured below applies independently. Rule changes made
            later do not rewrite this request.
          </p>
          {!approval.rulesValid || approval.rules.length === 0 ? (
            <PartnerNotice tone="warning" className="mt-5">
              The captured rules could not be verified. No account decision can
              be safely accepted until Stonegate reviews this request.
            </PartnerNotice>
          ) : (
            <ol className="mt-5 space-y-3" aria-label="Matching approval rules">
              {approval.rules.map((rule) => (
                <li
                  key={rule.id}
                  className="rounded-xl border border-slate-200 bg-slate-50 p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <h3 className="font-semibold text-slate-950">
                      {rule.name}
                    </h3>
                    <span className="text-xs font-medium text-slate-500">
                      Version {rule.version}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-slate-700">
                    {rule.requiredDecisionCount} eligible approval
                    {rule.requiredDecisionCount === 1 ? "" : "s"} required
                  </p>
                  <p className="mt-1 text-xs leading-5 text-slate-500">
                    Eligible roles:{" "}
                    {rule.requiredApproverRoleKeys
                      .map((role) => humanizeApprovalValue(role))
                      .join(", ")}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </PartnerPanel>
      </div>

      <PartnerPanel>
        <div className="flex items-center gap-2">
          <CheckCircle2
            className="h-5 w-5 text-primary-700"
            aria-hidden="true"
          />
          <h2 className="text-lg font-semibold text-slate-950">
            Decision history
          </h2>
        </div>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Decisions and their partner-visible reasons are immutable audit
          records. Member names are intentionally minimized in this view.
        </p>
        {approval.decisions.length === 0 ? (
          <p className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-600">
            No decisions have been recorded.
          </p>
        ) : (
          <ol className="mt-5 space-y-3" aria-label="Approval decision history">
            {approval.decisions.map((decision) => (
              <li
                key={decision.id}
                className="rounded-xl border border-slate-200 p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={cn(
                        "rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset",
                        decision.decision === "approved"
                          ? "bg-emerald-50 text-emerald-800 ring-emerald-200"
                          : "bg-rose-50 text-rose-800 ring-rose-200",
                      )}
                    >
                      {decision.decision === "approved"
                        ? "Approved"
                        : "Declined"}
                    </span>
                    <span className="text-sm font-medium text-slate-700">
                      {decision.byCurrentMember
                        ? "You"
                        : decision.roleKey
                          ? humanizeApprovalValue(decision.roleKey)
                          : "Authorized account member"}
                    </span>
                  </div>
                  <time
                    dateTime={decision.createdAt}
                    className="text-xs text-slate-500"
                  >
                    {formatApprovalDate(decision.createdAt)}
                  </time>
                </div>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-700">
                  {decision.reason || "No decision note was provided."}
                </p>
              </li>
            ))}
          </ol>
        )}
        {approval.resolvedAt ? (
          <p className="mt-4 flex items-center gap-2 text-xs text-slate-500">
            <Clock3 className="h-4 w-4" aria-hidden="true" />
            Resolved{" "}
            <time dateTime={approval.resolvedAt}>
              {formatApprovalDate(approval.resolvedAt)}
            </time>
          </p>
        ) : null}
      </PartnerPanel>

      <PartnerApprovalDecisionForm
        requestId={approval.id}
        initialEtag={etag}
        initialState={approval.state}
        requestedByCurrentMember={approval.requestedByCurrentMember}
        initialCurrentMemberDecision={approval.currentMemberDecision}
        expiresAt={approval.expiresAt}
        rulesValid={approval.rulesValid && approval.rules.length > 0}
      />
    </div>
  );
}
