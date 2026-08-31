import type { Metadata } from "next";
import Link from "next/link";
import {
  CalendarClock,
  Camera,
  CircleDollarSign,
  Clock3,
  FileText,
  MapPin,
  MessageSquareText,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { callPartnerApi } from "@/app/partners/lib/api";
import {
  PartnerJobActions,
  type PartnerCancellationDecision,
} from "@/app/partners/components/PartnerJobActions";
import {
  PartnerJobMessages,
  type PartnerJobMessage,
  type PartnerMessagePage,
  type PartnerMessagesPayload,
} from "@/app/partners/components/PartnerJobMessages";
import { PartnerDocumentDownloadButton } from "@/app/partners/components/PartnerDocumentDownloadButton";
import { PartnerJobReceiptActions } from "@/app/partners/components/PartnerJobReceiptActions";
import { getPartnerPortalContext } from "@/app/partners/lib/portal-context";
import {
  PartnerEmptyState,
  PartnerErrorState,
  PartnerNotice,
  PartnerPageHeader,
  PartnerPanel,
  PartnerStatusBadge,
  partnerSecondaryButtonClass,
} from "@/app/partners/components/PartnerPortalUi";

type JobDetail = {
  id: string;
  status: string;
  confirmationMode: string;
  service: {
    key: string | null;
    tierKey: string | null;
    addOns: Array<{
      key: string;
      label: string;
      unitLabel: string;
      quantity: number;
      requiresReview: boolean;
      unitAmount: {
        amountMinor: number;
        currency: string;
        minorUnit: number;
      } | null;
      lineTotal: {
        amountMinor: number;
        currency: string;
        minorUnit: number;
      } | null;
    }>;
  };
  schedule: {
    arrivalWindow: { startAt: string; endAt: string; timezone: string } | null;
    completedAt: string | null;
  };
  location: {
    id: string | null;
    name: string | null;
    externalPropertyId: string | null;
    address: {
      line1: string;
      line2: string | null;
      city: string;
      state: string;
      postalCode: string;
    } | null;
    access: {
      instructions: string | null;
      parking: string | null;
      loading: string | null;
    };
    onSiteContact: Record<string, unknown> | null;
  };
  scope: Record<string, unknown> | null;
  proofRequirements: Record<string, unknown> | null;
  reviewReasons: string[];
  references: {
    poNumber: string | null;
    costCenter: string | null;
    project: string | null;
    billingContact: Record<string, unknown> | null;
  };
  financial: {
    amountMinor: number;
    currency: string;
    minorUnit: number;
  } | null;
  timeline: Array<{
    id: string;
    type: string;
    label: string;
    detail: string | null;
    at: string;
    actorType: string;
  }>;
  evidence: Array<{
    id: string;
    category: string;
    caption: string | null;
    filename: string;
    status: string;
    createdAt: string;
  }>;
  proofPackages: Array<{
    id: string;
    version: number;
    generatedAt: string;
    pdfDocumentId: string | null;
    zipDocumentId: string | null;
  }>;
  documents: Array<{
    id: string;
    type: string;
    filename: string;
    contentType: string;
    byteSize: number;
    generatedAt: string;
  }>;
  quotes: Array<{
    id: string;
    number: string;
    status: string;
    total: { amountMinor: number; currency: string; minorUnit: number };
    expiresAt: string | null;
  }>;
  invoices: Array<{
    id: string;
    number: string;
    status: string;
    total: { amountMinor: number; currency: string; minorUnit: number };
    balance: { amountMinor: number; currency: string; minorUnit: number };
    hostedPaymentUrl: string | null;
    dueDate: string | null;
  }>;
  conversation: {
    threadId: string;
    subject: string | null;
    lastMessageAt: string | null;
  } | null;
  cancellation: PartnerCancellationDecision;
  allowedActions: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
};

type ThreadSummary = {
  job: { id: string | null };
  unreadCount: number;
};

const EMPTY_MESSAGE_PAGE: PartnerMessagePage = {
  limit: 50,
  nextCursor: null,
  hasMore: false,
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ jobId: string }>;
}): Promise<Metadata> {
  const { jobId } = await params;
  return { title: `Job ${jobId.slice(0, 8)}` };
}

function isJobDetail(value: unknown): value is JobDetail {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["id"] === "string" &&
    typeof record["status"] === "string" &&
    typeof record["service"] === "object" &&
    typeof record["schedule"] === "object" &&
    typeof record["cancellation"] === "object" &&
    Array.isArray(record["allowedActions"])
  );
}

function textAt(
  record: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formatDateTime(
  value: string | null,
  timezone = "America/New_York",
): string {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Not scheduled";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    dateStyle: "long",
    timeStyle: "short",
  }).format(date);
}

function humanize(value: string | null | undefined): string {
  if (!value) return "Not provided";
  return value
    .replace(/[-_]+/gu, " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function formatMoney(value: {
  amountMinor: number;
  currency: string;
  minorUnit: number;
}): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: value.currency || "USD",
  }).format(value.amountMinor / 10 ** value.minorUnit);
}

function proofRequested(requirements: Record<string, unknown> | null): string {
  if (!requirements) return "No specific proof requirement recorded";
  const items = [
    requirements["before"] === true ||
    (typeof requirements["before"] === "number" && requirements["before"] > 0)
      ? "Before photos"
      : null,
    requirements["after"] === true ||
    (typeof requirements["after"] === "number" && requirements["after"] > 0)
      ? "After photos"
      : null,
    requirements["package"] === true ? "Formal proof package" : null,
  ].filter(Boolean);
  return items.join(", ") || "No specific proof requirement recorded";
}

function preferredSchedule(
  scope: Record<string, unknown> | null,
  fallbackTimezone: string,
): Array<{ localDate: string; timeOfDay: string; timezone: string }> {
  const raw = scope?.["preferredWindows"];
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 3).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const localDate = record["localDate"];
    const timeOfDay = record["timeOfDay"];
    const timezone = record["timezone"];
    if (
      typeof localDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(localDate) ||
      typeof timeOfDay !== "string"
    ) {
      return [];
    }
    return [
      {
        localDate,
        timeOfDay,
        timezone: typeof timezone === "string" ? timezone : fallbackTimezone,
      },
    ];
  });
}

function formatPreferredDate(value: string, timezone: string): string {
  const date = new Date(`${value}T12:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date);
}

export default async function PartnerJobDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ jobId: string }>;
  searchParams?: Promise<{ created?: string }>;
}) {
  const { jobId } = await params;
  const query: { created?: string } = searchParams ? await searchParams : {};
  const [response, portalContext] = await Promise.all([
    callPartnerApi(`/api/portal/v2/jobs/${encodeURIComponent(jobId)}`).catch(
      () => null,
    ),
    getPartnerPortalContext(),
  ]);
  if (!response?.ok) {
    if (response?.status === 404) {
      return (
        <PartnerErrorState
          title="This job could not be found"
          description="It may belong to another account, or the link may be out of date. Return to Jobs to continue."
          retryHref="/partners/bookings"
        />
      );
    }
    const unavailable = [409, 501, 503].includes(response?.status ?? 503);
    return (
      <PartnerErrorState
        title={
          unavailable
            ? "Job details are temporarily unavailable"
            : "We couldn’t load this job"
        }
        description="No job information was changed. Try again in a moment or contact Stonegate for an immediate update."
        retryHref={`/partners/bookings/${encodeURIComponent(jobId)}`}
      />
    );
  }
  const payload = (await response.json().catch(() => null)) as {
    job?: unknown;
  } | null;
  if (!isJobDetail(payload?.job)) {
    return (
      <PartnerErrorState
        title="This job response was incomplete"
        description="No information was changed. Refresh or contact Stonegate with this job link."
        retryHref={`/partners/bookings/${encodeURIComponent(jobId)}`}
      />
    );
  }
  const job = payload.job;
  const etag = response.headers.get("etag");
  const timezone = job.schedule.arrivalWindow?.timezone ?? "America/New_York";
  const preferredWindows = preferredSchedule(job.scope, timezone);
  const address = job.location.address;
  const locationLabel = address
    ? [
        address.line1,
        address.line2,
        `${address.city}, ${address.state} ${address.postalCode}`,
      ]
        .filter(Boolean)
        .join(", ")
    : job.location.name?.trim() || "Stonegate service location";
  const calendarWindow = ["canceled", "declined"].includes(job.status)
    ? null
    : job.schedule.arrivalWindow;
  const calendarWindowConfirmed = [
    "confirmed",
    "en_route",
    "in_progress",
    "completed",
  ].includes(job.status);
  const description = textAt(job.scope, "description");
  const crewInstructions = textAt(job.scope, "crewInstructions");
  const accessDetails =
    textAt(job.scope, "accessDetails") ?? job.location.access.instructions;
  const canReadMessages =
    portalContext.status === "authenticated" &&
    portalContext.permissions.readMessages;
  const canSendMessages =
    canReadMessages &&
    portalContext.permissions.sendMessages &&
    job.allowedActions.includes("message");
  let initialMessages: PartnerJobMessage[] = [];
  let initialMessagePage = EMPTY_MESSAGE_PAGE;
  let initialMessageError: string | null = null;
  let initialUnreadCount: number | undefined;

  if (canReadMessages) {
    const [messagesResponse, threadsResponse] = await Promise.all([
      callPartnerApi(
        `/api/portal/v2/jobs/${encodeURIComponent(job.id)}/messages?limit=50`,
      ).catch(() => null),
      callPartnerApi("/api/portal/v2/threads?limit=100").catch(() => null),
    ]);
    if (messagesResponse?.ok) {
      const messagesPayload = (await messagesResponse
        .json()
        .catch(() => null)) as PartnerMessagesPayload | null;
      if (
        messagesPayload?.ok === true &&
        Array.isArray(messagesPayload.messages) &&
        messagesPayload.page &&
        typeof messagesPayload.page.hasMore === "boolean"
      ) {
        initialMessages = messagesPayload.messages;
        initialMessagePage = messagesPayload.page;
      } else {
        initialMessageError =
          "The message history response was incomplete. Try loading it again.";
      }
    } else {
      initialMessageError =
        "Messages couldn’t be loaded. No job information was changed.";
    }
    if (threadsResponse?.ok) {
      const threadsPayload = (await threadsResponse
        .json()
        .catch(() => null)) as { threads?: ThreadSummary[] } | null;
      const matchingThread = Array.isArray(threadsPayload?.threads)
        ? threadsPayload.threads.find((thread) => thread.job?.id === job.id)
        : undefined;
      if (matchingThread && Number.isFinite(matchingThread.unreadCount)) {
        initialUnreadCount = Math.max(0, matchingThread.unreadCount);
      }
    }
  }

  return (
    <div className="space-y-5 sm:space-y-6">
      <PartnerPageHeader
        eyebrow={`Job ${job.id.slice(0, 8).toUpperCase()}`}
        title={
          job.location.name?.trim() ||
          address?.line1 ||
          humanize(job.service.key)
        }
        description={`${humanize(job.service.key)} · ${formatDateTime(job.schedule.arrivalWindow?.startAt ?? null, timezone)}`}
        breadcrumbs={[
          { label: "Overview", href: "/partners" },
          { label: "Jobs", href: "/partners/bookings" },
          {
            label: `Job ${job.id.slice(0, 8)}`,
            href: `/partners/bookings/${job.id}`,
          },
        ]}
        actions={<PartnerStatusBadge status={job.status} />}
      >
        {query.created === "1" ? (
          <PartnerNotice tone="success">
            Request received. Current confirmation:{" "}
            <strong>{humanize(job.confirmationMode)}</strong>.
          </PartnerNotice>
        ) : null}
        {job.reviewReasons.length ? (
          <PartnerNotice
            tone="warning"
            className={query.created === "1" ? "mt-3" : undefined}
          >
            {job.confirmationMode === "approval" && job.schedule.arrivalWindow
              ? "Account approval is required. The requested window is held only temporarily and is not confirmed; if the approval hold expires, a scheduler must choose a new available window."
              : `Stonegate review is needed before every detail is final. Your ${job.schedule.arrivalWindow ? "preferred arrival window" : "preferred dates"} and current status remain visible here; no time is reserved until Stonegate confirms it.`}
          </PartnerNotice>
        ) : null}
      </PartnerPageHeader>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(20rem,0.75fr)]">
        <div className="space-y-5">
          <PartnerPanel>
            <h2 className="text-lg font-semibold text-slate-950">
              Request details
            </h2>
            <dl className="mt-4 grid gap-4 sm:grid-cols-2">
              <DetailItem
                icon={CalendarClock}
                label="Arrival window"
                value={
                  job.schedule.arrivalWindow
                    ? `${formatDateTime(job.schedule.arrivalWindow.startAt, timezone)} – ${formatDateTime(job.schedule.arrivalWindow.endAt, timezone)}`
                    : preferredWindows.length
                      ? preferredWindows
                          .map((window) =>
                            formatPreferredDate(
                              window.localDate,
                              window.timezone,
                            ),
                          )
                          .join(" · ")
                      : "Scheduling pending"
                }
                detail={
                  !job.schedule.arrivalWindow && preferredWindows.length
                    ? `${humanize(preferredWindows[0]?.timeOfDay)} preferred · Not reserved`
                    : null
                }
              />
              <DetailItem
                icon={MapPin}
                label="Location"
                value={
                  address
                    ? [
                        address.line1,
                        address.line2,
                        `${address.city}, ${address.state} ${address.postalCode}`,
                      ]
                        .filter(Boolean)
                        .join(", ")
                    : "Location unavailable"
                }
              />
              <DetailItem
                icon={UserRound}
                label="On-site contact"
                value={
                  textAt(job.location.onSiteContact, "name") ?? "Not provided"
                }
                detail={
                  textAt(job.location.onSiteContact, "phone") ??
                  textAt(job.location.onSiteContact, "email")
                }
              />
              <DetailItem
                icon={ShieldCheck}
                label="Proof requested"
                value={proofRequested(job.proofRequirements)}
              />
            </dl>
            <div className="mt-5 space-y-4 border-t border-slate-200 pt-5">
              <TextBlock label="Work description" value={description} />
              {job.service.addOns.length ? (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                    Add-ons
                  </h3>
                  <ul className="mt-2 space-y-2 text-sm text-slate-700">
                    {job.service.addOns.map((addOn) => (
                      <li
                        key={addOn.key}
                        className="flex flex-wrap justify-between gap-x-4 gap-y-1"
                      >
                        <span>
                          {addOn.label} × {addOn.quantity} {addOn.unitLabel}
                        </span>
                        {addOn.lineTotal ? (
                          <span className="font-semibold text-slate-950">
                            {formatMoney(addOn.lineTotal)}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <TextBlock label="Access details" value={accessDetails} />
              <TextBlock label="Crew instructions" value={crewInstructions} />
            </div>
          </PartnerPanel>

          {canReadMessages ? (
            <PartnerPanel>
              <PartnerJobMessages
                jobId={job.id}
                timezone={timezone}
                canSend={canSendMessages}
                initialMessages={initialMessages}
                initialPage={initialMessagePage}
                initialUnreadCount={initialUnreadCount}
                initialError={initialMessageError}
              />
            </PartnerPanel>
          ) : null}

          <PartnerPanel>
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                  Progress
                </p>
                <h2 className="mt-1 text-lg font-semibold text-slate-950">
                  Job timeline
                </h2>
              </div>
              <Clock3 className="h-5 w-5 text-primary-700" aria-hidden="true" />
            </div>
            {job.timeline.length ? (
              <ol className="mt-5 space-y-0">
                {job.timeline.map((event, index) => (
                  <li
                    key={event.id}
                    className="relative grid grid-cols-[1.25rem_minmax(0,1fr)] gap-3 pb-5 last:pb-0"
                  >
                    {index < job.timeline.length - 1 ? (
                      <span
                        className="absolute bottom-0 left-[9px] top-5 w-px bg-slate-200"
                        aria-hidden="true"
                      />
                    ) : null}
                    <span
                      className="relative mt-1 h-5 w-5 rounded-full border-4 border-white bg-primary-600 ring-1 ring-primary-200"
                      aria-hidden="true"
                    />
                    <div>
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <h3 className="font-semibold text-slate-950">
                          {event.label}
                        </h3>
                        <time
                          dateTime={event.at}
                          className="text-xs text-slate-500"
                        >
                          {formatDateTime(event.at, timezone)}
                        </time>
                      </div>
                      {event.detail ? (
                        <p className="mt-1 text-sm leading-6 text-slate-600">
                          {event.detail}
                        </p>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="mt-4">
                <PartnerEmptyState
                  title="Timeline is being prepared"
                  description="The current job status is shown above. New milestones will appear here as work progresses."
                />
              </div>
            )}
          </PartnerPanel>

          <PartnerPanel>
            <div className="flex items-center gap-3">
              <Camera className="h-5 w-5 text-primary-700" aria-hidden="true" />
              <div>
                <h2 className="font-semibold text-slate-950">
                  Photos &amp; proof
                </h2>
                <p className="mt-0.5 text-sm text-slate-600">
                  Job-linked evidence currently visible to your account.
                </p>
              </div>
            </div>
            {job.evidence.length ? (
              <ul className="mt-4 grid gap-3 sm:grid-cols-2">
                {job.evidence.map((evidence) => (
                  <li
                    key={evidence.id}
                    className="rounded-xl border border-slate-200 bg-slate-50 p-4"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-950">
                        {humanize(evidence.category)}
                      </span>
                      <PartnerStatusBadge status={evidence.status} />
                    </div>
                    <p className="mt-2 break-all text-sm text-slate-600">
                      {evidence.filename}
                    </p>
                    {evidence.caption ? (
                      <p className="mt-1 text-sm text-slate-600">
                        {evidence.caption}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="mt-4">
                <PartnerEmptyState
                  title="No shared photos yet"
                  description="Upload and share controls appear when the account proof service is available for this job."
                  action={{
                    href: "/partners/photos",
                    label: "Open Photos & proof",
                  }}
                  icon={<Camera className="h-6 w-6" aria-hidden="true" />}
                />
              </div>
            )}
          </PartnerPanel>
        </div>

        <aside className="space-y-5">
          <PartnerPanel>
            <h2 className="text-lg font-semibold text-slate-950">
              Job actions
            </h2>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              Available actions reflect this job’s status and your account role.
            </p>
            <div className="mt-4">
              <PartnerJobActions
                jobId={job.id}
                etag={etag}
                allowedActions={job.allowedActions}
                cancellation={job.cancellation}
              />
            </div>
            <div className="mt-5 border-t border-slate-200 pt-5">
              <h3 className="text-sm font-semibold text-slate-950">
                Receipt &amp; sharing
              </h3>
              <div className="mt-3">
                <PartnerJobReceiptActions
                  jobId={job.id}
                  serviceLabel={humanize(job.service.key)}
                  locationLabel={locationLabel}
                  arrivalWindow={calendarWindow}
                  confirmed={calendarWindowConfirmed}
                />
              </div>
            </div>
          </PartnerPanel>

          <PartnerPanel>
            <div className="flex items-center gap-3">
              <CircleDollarSign
                className="h-5 w-5 text-primary-700"
                aria-hidden="true"
              />
              <h2 className="font-semibold text-slate-950">
                Billing &amp; references
              </h2>
            </div>
            <dl className="mt-4 space-y-3 text-sm">
              <CompactItem
                label="Recorded amount"
                value={
                  job.financial ? formatMoney(job.financial) : "Not available"
                }
              />
              <CompactItem
                label="PO / work order"
                value={job.references.poNumber ?? "Not provided"}
              />
              <CompactItem
                label="Cost center"
                value={job.references.costCenter ?? "Not provided"}
              />
              <CompactItem
                label="Project"
                value={job.references.project ?? "Not provided"}
              />
              <CompactItem
                label="Billing contact"
                value={
                  textAt(job.references.billingContact, "name") ??
                  "Not provided"
                }
              />
              {textAt(job.references.billingContact, "email") ? (
                <CompactItem
                  label="Billing email"
                  value={
                    textAt(job.references.billingContact, "email") ??
                    "Not provided"
                  }
                />
              ) : null}
            </dl>
            <Link
              href="/partners/billing"
              className={`${partnerSecondaryButtonClass} mt-4 w-full`}
            >
              Open billing &amp; documents
            </Link>
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
                    className="flex flex-col gap-3 rounded-xl border border-slate-200 p-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-900">
                        {document.filename}
                      </p>
                      <p className="text-xs text-slate-500">
                        {humanize(document.type)}
                      </p>
                    </div>
                    <PartnerDocumentDownloadButton documentId={document.id} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm leading-6 text-slate-600">
                No account-visible documents are attached to this job.
              </p>
            )}
          </PartnerPanel>

          <PartnerPanel>
            <div className="flex items-center gap-3">
              <MessageSquareText
                className="h-5 w-5 text-primary-700"
                aria-hidden="true"
              />
              <h2 className="font-semibold text-slate-950">
                Need help with this job?
              </h2>
            </div>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Stonegate support can see this job ID and help with access,
              timing, documentation, or billing.
            </p>
            <Link
              href="/partners/help"
              className={`${partnerSecondaryButtonClass} mt-4 w-full`}
            >
              Contact support
            </Link>
          </PartnerPanel>
        </aside>
      </div>
    </div>
  );
}

function DetailItem({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof MapPin;
  label: string;
  value: string;
  detail?: string | null;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
      <dt className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
        <Icon className="h-4 w-4" aria-hidden="true" />
        {label}
      </dt>
      <dd className="mt-2 text-sm font-semibold leading-6 text-slate-950">
        {value}
      </dd>
      {detail ? (
        <dd className="mt-1 text-sm text-slate-600">{detail}</dd>
      ) : null}
    </div>
  );
}

function TextBlock({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-slate-950">{label}</h3>
      <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-600">
        {value ?? "Not provided"}
      </p>
    </div>
  );
}

function CompactItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className="max-w-[60%] text-right font-semibold text-slate-900">
        {value}
      </dd>
    </div>
  );
}
