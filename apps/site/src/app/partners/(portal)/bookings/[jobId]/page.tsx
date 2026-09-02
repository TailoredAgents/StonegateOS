import type { Metadata, Route } from "next";
import Link from "next/link";
import {
  BellRing,
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
  parsePartnerJobActionAvailability,
  type PartnerJobActionAvailability,
} from "@/app/partners/lib/job-action-availability";
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
  operations: {
    eta: {
      state:
        | "operational_estimate"
        | "not_published"
        | "complete"
        | "not_applicable";
      startAt: string | null;
      endAt: string | null;
      publishedAt: string | null;
    };
    assignedTeam: {
      state: "assigned" | "pending" | "complete" | "not_applicable";
      displayLabel: "Stonegate service crew";
      memberCount: number | null;
    };
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
  pricingBasis: {
    pricingState:
      | "contracted"
      | "estimate"
      | "quote_required"
      | "standard_rate";
    agreementLabel: string;
    agreementRevision: number;
    effectiveFrom: string;
    effectiveTo: string | null;
    finalPriceSource: "accepted_change_order_quote_v2" | null;
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
  cancellationRequest: {
    id: string | null;
    state: "pending" | "reconciliation_required";
    reason: string | null;
    revision: number | null;
    createdAt: string | null;
  } | null;
  changeRequest: {
    id: string;
    state: "pending";
    reason: string;
    revision: number;
    createdAt: string;
    consequence: string;
  } | null;
  changeOrder: {
    id: string;
    state: "offered" | "accepted" | "declined" | "superseded";
    partnerQuoteId: string;
    amount: {
      amountMinor: number;
      currency: string;
      minorUnit: number;
    } | null;
    operationalEffectsPending: Array<"schedule" | "service" | "proof">;
    revision: number;
    createdAt: string;
    resolvedAt: string | null;
  } | null;
  notificationDestination: {
    inApp: boolean;
    email: { enabled: boolean; destination: string };
    sms: { enabled: boolean; destination: string | null };
    settingsPath: string;
  };
  notificationDeliveryHistory: Array<{
    id: string;
    event: { key: string; label: string };
    channel: { key: "in_app" | "email" | "sms"; label: string };
    status: {
      key: "not_sent" | "pending" | "sent" | "failed" | "checking";
      label: string;
    };
    createdAt: string;
    acceptedAt: string | null;
    updatedAt: string;
  }>;
  actionAvailability: PartnerJobActionAvailability[];
  allowedActions: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
};

type ThreadSummary = {
  job: { id: string | null };
  unreadCount: number;
};

type JobNotification = {
  id: string;
  jobId: string;
  eventKey: string;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
};

type JobNotificationsPayload = {
  ok: true;
  notifications: JobNotification[];
  page: { limit: number; nextCursor: string | null; hasMore: boolean };
};

const EMPTY_MESSAGE_PAGE: PartnerMessagePage = {
  limit: 50,
  nextCursor: null,
  hasMore: false,
};

const DELIVERY_EVENT_LABELS: Record<string, string> = {
  "booking.created": "Booking received",
  "booking.review_received": "Review request received",
  "booking.rescheduled": "Schedule updated",
  "booking.reschedule_review_requested": "Reschedule review requested",
  "booking.canceled": "Job canceled",
  "booking.cancellation_review_requested": "Cancellation review requested",
};
const DELIVERY_CHANNEL_LABELS: Record<string, string> = {
  in_app: "In-app",
  email: "Email",
  sms: "SMS",
};
const DELIVERY_STATUS_LABELS: Record<string, string> = {
  not_sent: "Not sent by preference",
  pending: "Queued",
  sent: "Accepted for delivery",
  failed: "Could not send",
  checking: "Delivery being checked",
};

function isDateTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isJobOperationsSummary(
  value: unknown,
): value is JobDetail["operations"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const eta = record["eta"];
  const assignedTeam = record["assignedTeam"];
  if (
    !eta ||
    typeof eta !== "object" ||
    Array.isArray(eta) ||
    !assignedTeam ||
    typeof assignedTeam !== "object" ||
    Array.isArray(assignedTeam)
  ) {
    return false;
  }
  const etaRecord = eta as Record<string, unknown>;
  const teamRecord = assignedTeam as Record<string, unknown>;
  const etaState = etaRecord["state"];
  const teamState = teamRecord["state"];
  const etaDatesValid =
    etaState === "operational_estimate"
      ? isDateTime(etaRecord["startAt"]) &&
        isDateTime(etaRecord["endAt"]) &&
        isDateTime(etaRecord["publishedAt"]) &&
        Date.parse(etaRecord["endAt"]) > Date.parse(etaRecord["startAt"])
      : ["not_published", "complete", "not_applicable"].includes(
          typeof etaState === "string" ? etaState : "",
        ) &&
        etaRecord["startAt"] === null &&
        etaRecord["endAt"] === null &&
        etaRecord["publishedAt"] === null;
  const memberCount = teamRecord["memberCount"];
  return (
    etaDatesValid &&
    ["assigned", "pending", "complete", "not_applicable"].includes(
      typeof teamState === "string" ? teamState : "",
    ) &&
    teamRecord["displayLabel"] === "Stonegate service crew" &&
    (memberCount === null ||
      (Number.isSafeInteger(memberCount) &&
        Number(memberCount) >= 1 &&
        Number(memberCount) <= 99)) &&
    (teamState !== "assigned" || memberCount !== null)
  );
}

function isJobNotificationDeliveryHistory(
  value: unknown,
): value is JobDetail["notificationDeliveryHistory"] {
  return (
    Array.isArray(value) &&
    value.length <= 50 &&
    value.every((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return false;
      }
      const record = entry as Record<string, unknown>;
      const event = record["event"];
      const channel = record["channel"];
      const status = record["status"];
      if (
        !event ||
        typeof event !== "object" ||
        Array.isArray(event) ||
        !channel ||
        typeof channel !== "object" ||
        Array.isArray(channel) ||
        !status ||
        typeof status !== "object" ||
        Array.isArray(status)
      ) {
        return false;
      }
      const eventRecord = event as Record<string, unknown>;
      const channelRecord = channel as Record<string, unknown>;
      const statusRecord = status as Record<string, unknown>;
      const eventKey = eventRecord["key"];
      const channelKey = channelRecord["key"];
      const statusKey = statusRecord["key"];
      return (
        typeof record["id"] === "string" &&
        /^[0-9a-f-]{36}$/iu.test(record["id"]) &&
        typeof eventKey === "string" &&
        eventRecord["label"] === DELIVERY_EVENT_LABELS[eventKey] &&
        typeof channelKey === "string" &&
        channelRecord["label"] === DELIVERY_CHANNEL_LABELS[channelKey] &&
        typeof statusKey === "string" &&
        statusRecord["label"] === DELIVERY_STATUS_LABELS[statusKey] &&
        isDateTime(record["createdAt"]) &&
        (record["acceptedAt"] === null || isDateTime(record["acceptedAt"])) &&
        isDateTime(record["updatedAt"])
      );
    })
  );
}

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
  const notification = record["notificationDestination"];
  const notificationRecord =
    notification &&
    typeof notification === "object" &&
    !Array.isArray(notification)
      ? (notification as Record<string, unknown>)
      : null;
  const email = notificationRecord?.["email"];
  const emailRecord =
    email && typeof email === "object" && !Array.isArray(email)
      ? (email as Record<string, unknown>)
      : null;
  const sms = notificationRecord?.["sms"];
  const smsRecord =
    sms && typeof sms === "object" && !Array.isArray(sms)
      ? (sms as Record<string, unknown>)
      : null;
  const pricingBasis = record["pricingBasis"];
  const pricingRecord =
    pricingBasis &&
    typeof pricingBasis === "object" &&
    !Array.isArray(pricingBasis)
      ? (pricingBasis as Record<string, unknown>)
      : null;
  const pricingBasisValid =
    pricingBasis === null ||
    (pricingRecord !== null &&
      ["contracted", "estimate", "quote_required", "standard_rate"].includes(
        typeof pricingRecord["pricingState"] === "string"
          ? pricingRecord["pricingState"]
          : "",
      ) &&
      typeof pricingRecord["agreementLabel"] === "string" &&
      Number.isSafeInteger(pricingRecord["agreementRevision"]) &&
      typeof pricingRecord["effectiveFrom"] === "string" &&
      (pricingRecord["effectiveTo"] === null ||
        typeof pricingRecord["effectiveTo"] === "string") &&
      (pricingRecord["finalPriceSource"] === null ||
        pricingRecord["finalPriceSource"] ===
          "accepted_change_order_quote_v2"));
  return (
    typeof record["id"] === "string" &&
    typeof record["status"] === "string" &&
    typeof record["service"] === "object" &&
    typeof record["schedule"] === "object" &&
    isJobOperationsSummary(record["operations"]) &&
    typeof record["cancellation"] === "object" &&
    pricingBasisValid &&
    typeof notificationRecord?.["inApp"] === "boolean" &&
    typeof notificationRecord["settingsPath"] === "string" &&
    notificationRecord["settingsPath"] === "/partners/settings#notifications" &&
    typeof emailRecord?.["enabled"] === "boolean" &&
    typeof emailRecord["destination"] === "string" &&
    typeof smsRecord?.["enabled"] === "boolean" &&
    (smsRecord["destination"] === null ||
      typeof smsRecord["destination"] === "string") &&
    isJobNotificationDeliveryHistory(record["notificationDeliveryHistory"]) &&
    parsePartnerJobActionAvailability(record["actionAvailability"]) !== null &&
    Array.isArray(record["allowedActions"])
  );
}

function isJobNotificationsPayload(
  value: unknown,
  expectedJobId: string,
): value is JobNotificationsPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const page = record["page"];
  return (
    record["ok"] === true &&
    Array.isArray(record["notifications"]) &&
    record["notifications"].every((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return false;
      }
      const notification = entry as Record<string, unknown>;
      return (
        typeof notification["id"] === "string" &&
        notification["jobId"] === expectedJobId &&
        typeof notification["eventKey"] === "string" &&
        typeof notification["title"] === "string" &&
        typeof notification["body"] === "string" &&
        (notification["readAt"] === null ||
          typeof notification["readAt"] === "string") &&
        typeof notification["createdAt"] === "string"
      );
    }) &&
    Boolean(page) &&
    typeof page === "object" &&
    !Array.isArray(page) &&
    typeof (page as Record<string, unknown>)["hasMore"] === "boolean"
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
  const operationalEtaValue =
    job.operations.eta.state === "operational_estimate" &&
    job.operations.eta.startAt &&
    job.operations.eta.endAt
      ? `${formatDateTime(job.operations.eta.startAt, timezone)} – ${formatDateTime(job.operations.eta.endAt, timezone)}`
      : job.operations.eta.state === "complete"
        ? "Job completed"
        : job.operations.eta.state === "not_applicable"
          ? "Not applicable"
          : "No operational estimate published";
  const operationalEtaDetail =
    job.operations.eta.state === "operational_estimate" &&
    job.operations.eta.publishedAt
      ? `Published ${formatDateTime(job.operations.eta.publishedAt, timezone)}. This estimate may change; the promised two-hour arrival window remains authoritative.`
      : job.operations.eta.state === "not_published" &&
          job.schedule.arrivalWindow
        ? "Use the promised two-hour arrival window until Stonegate publishes a narrower operational estimate."
        : null;
  const assignedTeamValue =
    job.operations.assignedTeam.state === "assigned"
      ? job.operations.assignedTeam.displayLabel
      : job.operations.assignedTeam.state === "complete"
        ? "Service crew completed this job"
        : job.operations.assignedTeam.state === "not_applicable"
          ? "Not applicable"
          : "Assignment pending";
  const assignedTeamDetail =
    job.operations.assignedTeam.state === "assigned" &&
    job.operations.assignedTeam.memberCount
      ? `${job.operations.assignedTeam.memberCount} assigned ${job.operations.assignedTeam.memberCount === 1 ? "team member" : "team members"}. Individual names and live location are not shared.`
      : null;
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
  let jobNotifications: JobNotification[] = [];
  let jobNotificationsHaveMore = false;
  let jobNotificationsError: string | null = null;
  const [notificationsResponse, messagesResponse, threadsResponse] =
    await Promise.all([
      callPartnerApi(
        `/api/portal/v2/notifications?state=all&jobId=${encodeURIComponent(job.id)}&limit=25`,
      ).catch(() => null),
      canReadMessages
        ? callPartnerApi(
            `/api/portal/v2/jobs/${encodeURIComponent(job.id)}/messages?limit=50`,
          ).catch(() => null)
        : Promise.resolve(null),
      canReadMessages
        ? callPartnerApi("/api/portal/v2/threads?limit=100").catch(() => null)
        : Promise.resolve(null),
    ]);

  if (notificationsResponse?.ok) {
    const notificationsPayload = (await notificationsResponse
      .json()
      .catch(() => null)) as unknown;
    if (isJobNotificationsPayload(notificationsPayload, job.id)) {
      jobNotifications = notificationsPayload.notifications;
      jobNotificationsHaveMore = notificationsPayload.page.hasMore;
    } else {
      jobNotificationsError =
        "The update history response was incomplete. Refresh before relying on it.";
    }
  } else {
    jobNotificationsError =
      "Job update history couldn’t be loaded. No job information was changed.";
  }

  if (canReadMessages) {
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
          { label: "Overview", href: "/partners/overview" },
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
        {job.changeOrder?.state === "offered" ? (
          <PartnerNotice tone="warning" className="mt-3">
            A fixed-price change order for{" "}
            <strong>
              {job.changeOrder.amount
                ? formatMoney(job.changeOrder.amount)
                : "this job"}
            </strong>{" "}
            is ready for review. Your current job remains unchanged until you
            respond.{" "}
            <Link
              className="font-semibold underline underline-offset-2"
              href={`/partners/billing/quotes/${encodeURIComponent(job.changeOrder.partnerQuoteId)}`}
            >
              Review change order
            </Link>
          </PartnerNotice>
        ) : job.changeOrder?.state === "accepted" &&
          job.changeOrder.operationalEffectsPending.length > 0 ? (
          <PartnerNotice tone="warning" className="mt-3">
            The change-order price is final. Stonegate still needs to execute
            these operational updates:{" "}
            {job.changeOrder.operationalEffectsPending.map(humanize).join(", ")}
            . Until confirmed, the schedule, service, and proof requirements
            shown on this job remain in effect.
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
                icon={Clock3}
                label="Operational arrival estimate"
                value={operationalEtaValue}
                detail={operationalEtaDetail}
              />
              <DetailItem
                icon={UserRound}
                label="Assigned team"
                value={assignedTeamValue}
                detail={assignedTeamDetail}
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
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                  Communication record
                </p>
                <h2 className="mt-1 text-lg font-semibold text-slate-950">
                  Job update history
                </h2>
              </div>
              <BellRing
                className="h-5 w-5 text-primary-700"
                aria-hidden="true"
              />
            </div>
            {jobNotificationsError ? (
              <PartnerNotice tone="warning" className="mt-4">
                {jobNotificationsError}
              </PartnerNotice>
            ) : jobNotifications.length ? (
              <>
                <ol className="mt-4 divide-y divide-slate-200">
                  {jobNotifications.map((notification) => (
                    <li
                      key={notification.id}
                      className="py-4 first:pt-0 last:pb-0"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <h3 className="font-semibold text-slate-950">
                          {notification.title}
                        </h3>
                        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">
                          {notification.readAt ? "Read" : "New"}
                        </span>
                      </div>
                      <p className="mt-1 text-sm leading-6 text-slate-600">
                        {notification.body}
                      </p>
                      <time
                        dateTime={notification.createdAt}
                        className="mt-1 block text-xs text-slate-500"
                      >
                        {formatDateTime(notification.createdAt, timezone)}
                      </time>
                    </li>
                  ))}
                </ol>
                {jobNotificationsHaveMore ? (
                  <p className="mt-4 text-xs text-slate-500">
                    Showing the 25 most recent job updates. Older account
                    notifications remain available from Overview.
                  </p>
                ) : null}
              </>
            ) : (
              <div className="mt-4">
                <PartnerEmptyState
                  title="No job notifications yet"
                  description="Confirmation, schedule, proof, billing, and payment updates sent for this job will appear here."
                />
              </div>
            )}
            <section
              aria-labelledby="job-notification-delivery-heading"
              className="mt-6 border-t border-slate-200 pt-5"
            >
              <h3
                id="job-notification-delivery-heading"
                className="font-semibold text-slate-950"
              >
                Delivery status for you
              </h3>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                This account-member view shows recorded scheduling notification
                attempts without exposing destinations or provider details.
              </p>
              {job.notificationDeliveryHistory.length ? (
                <ul className="mt-3 space-y-2">
                  {job.notificationDeliveryHistory.map((delivery) => (
                    <li
                      key={delivery.id}
                      className="grid gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                    >
                      <div className="min-w-0">
                        <p className="font-semibold text-slate-950">
                          {delivery.event.label}
                        </p>
                        <p className="mt-0.5 text-sm text-slate-600">
                          {delivery.channel.label} · {delivery.status.label}
                        </p>
                      </div>
                      <time
                        dateTime={delivery.updatedAt}
                        className="text-xs text-slate-500 sm:text-right"
                      >
                        {formatDateTime(delivery.updatedAt, timezone)}
                      </time>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 rounded-xl bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-600">
                  No per-channel scheduling delivery attempts are recorded for
                  you on this job yet.
                </p>
              )}
              <p className="mt-3 text-xs leading-5 text-slate-500">
                “Accepted for delivery” confirms provider acceptance, not that a
                person opened or read the message.
              </p>
            </section>
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
              Actions and unavailable reasons reflect the current job, schedule,
              account policy, pending reviews, and your role.
            </p>
            <div className="mt-4">
              <PartnerJobActions
                jobId={job.id}
                etag={etag}
                allowedActions={job.allowedActions}
                actionAvailability={job.actionAvailability}
                cancellation={job.cancellation}
                references={job.references}
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
              <p className="mt-3 text-xs leading-5 text-slate-600">
                Updates are recorded in-app
                {job.notificationDestination.email.enabled
                  ? ` and emailed to ${job.notificationDestination.email.destination}`
                  : ""}
                {job.notificationDestination.sms.enabled &&
                job.notificationDestination.sms.destination
                  ? `; SMS is enabled for ${job.notificationDestination.sms.destination}`
                  : "; SMS is not enabled"}
                .{" "}
                <Link
                  className="font-semibold text-primary-700 underline underline-offset-2"
                  href={job.notificationDestination.settingsPath as Route}
                >
                  Notification settings
                </Link>
              </p>
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
              {job.pricingBasis ? (
                <>
                  <CompactItem
                    label="Price basis"
                    value={
                      job.pricingBasis.finalPriceSource ===
                      "accepted_change_order_quote_v2"
                        ? "Accepted change order"
                        : humanize(job.pricingBasis.pricingState)
                    }
                  />
                  <CompactItem
                    label="Account agreement"
                    value={`${job.pricingBasis.agreementLabel} · revision ${job.pricingBasis.agreementRevision}`}
                  />
                  <CompactItem
                    label="Agreement period"
                    value={`${formatDateTime(job.pricingBasis.effectiveFrom, timezone)}–${job.pricingBasis.effectiveTo ? formatDateTime(job.pricingBasis.effectiveTo, timezone) : "no scheduled end"}`}
                  />
                </>
              ) : null}
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
      <dd className="min-w-0 max-w-[60%] break-words text-right font-semibold text-slate-900">
        {value}
      </dd>
    </div>
  );
}
