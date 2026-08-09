"use client";

import React from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import type { ContactReminderSummary, ContactSummary } from "./contacts.types";
import {
  PIPELINE_STAGES,
  badgeClassForPipelineStage,
  labelForPipelineStage,
} from "./pipeline.stages";
import { TEAM_TIME_ZONE } from "../lib/timezone";
import { teamSurfaceHref } from "../surface-registry";
import { teamButtonClass } from "./team-ui";
import { ContactNameEditorClient } from "./ContactNameEditorClient";
import { ContactPhoneEditorClient } from "./ContactPhoneEditorClient";
import { InboxContactNotesClient } from "./InboxContactNotesClient";
import { InboxContactRemindersClient } from "./InboxContactRemindersClient";
import { SubmitButton } from "@/components/SubmitButton";
import {
  addPropertyAction,
  bookAppointmentAction,
  deleteContactAction,
  deletePropertyAction,
  partnerPortalInviteUserAction,
  startContactCallAction,
  updatePropertyAction,
} from "../actions";
import { AppointmentBookingDetailsFields } from "./AppointmentBookingDetailsFields";
import {
  APPOINTMENT_BOOKING_SELECTION_OPTIONS,
  resolveBookingSelection,
  type AppointmentBookingDetailsPrefill,
  type AppointmentBookingSelection,
} from "../lib/booking-details";
import type { InstantQuoteHandoff } from "../lib/instant-quote-handoff";
import { quoteWorkspaceHref } from "../quotes-workspace";
import {
  CONTACT_SUBVIEWS,
  contactWorkspaceHref,
  type ContactSubview,
  type ContactWorkspaceCapabilities,
  type ContactWorkspaceLocation,
} from "../contacts-workspace";
import {
  classifyContactResourceResponse,
  contactResourceFailureMessage,
  type ContactResourceFailure,
} from "../contact-resource-state";
import {
  pipelineExpectedVersion,
  PIPELINE_ABSENT_VERSION,
  PipelineStageRequestError,
  requestPipelineStageMutation,
} from "../lib/pipeline-stage-mutation";

const ContactMediaAnalysisClient = dynamic(
  () =>
    import("./ContactMediaAnalysisClient").then(
      (module) => module.ContactMediaAnalysisClient,
    ),
  { loading: () => <p role="status">Loading media analysis…</p> },
);

const ContactSalesAgentMemoryClient = dynamic(
  () =>
    import("./ContactSalesAgentMemoryClient").then(
      (module) => module.ContactSalesAgentMemoryClient,
    ),
  { loading: () => <p role="status">Loading agent memory…</p> },
);

type Props = {
  contact: ContactSummary;
  actorId: string;
  teamMembers: Array<{ id: string; name: string }>;
  contactWorkspace?: boolean;
  subview?: ContactSubview;
  workspaceLocation?: Omit<ContactWorkspaceLocation, "contactId" | "subview">;
  capabilities?: ContactWorkspaceCapabilities;
  teamDirectoryAvailable?: boolean;
  instantQuoteHandoff?: InstantQuoteHandoff | null;
};

type QuotePhotosPayload = {
  ok?: boolean;
  photoUrls?: string[];
  error?: string;
};

const CONTACT_SUBVIEW_LABELS: Readonly<Record<ContactSubview, string>> = {
  overview: "Overview",
  properties: "Properties",
  activity: "Activity",
  "jobs-quotes": "Jobs & quotes",
  communications: "Communications",
  intelligence: "Intelligence",
};

const LEGACY_EMBEDDED_CAPABILITIES: ContactWorkspaceCapabilities = {
  callAttemptKeySeed: "legacy-call-actions-disabled",
  canWriteContact: true,
  canDeleteContact: true,
  canReadProperties: true,
  canWriteProperties: true,
  canDeleteProperties: true,
  canUpdatePipeline: true,
  canCall: false,
  canReadMessages: true,
  canMessage: true,
  canBook: true,
  canReadCalendar: true,
  canReadQuotes: true,
  canWriteQuotes: true,
  canReadPartners: true,
  canInvitePartners: true,
};

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TEAM_TIME_ZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

function isSystemTask(reminder: ContactReminderSummary): boolean {
  const title = reminder.title?.toLowerCase() ?? "";
  if (title.startsWith("auto:")) return true;
  const notes = reminder.notes ?? "";
  if (notes.includes("[auto]")) return true;
  if (notes.includes("kind=speed_to_lead")) return true;
  if (notes.includes("kind=follow_up")) return true;
  return false;
}

function buildMapsLink(contact: ContactSummary): string | null {
  const property = (contact.properties ?? [])[0];
  if (!property) return null;
  const parts = [
    property.addressLine1,
    property.city,
    property.state,
    property.postalCode,
  ].filter(Boolean);
  const query = parts.join(", ").trim();
  if (!query) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function buildMapsLinkForProperty(
  property: ContactSummary["properties"][number] | null | undefined,
): string | null {
  if (!property) return null;
  const parts = [
    property.addressLine1,
    property.addressLine2 ?? "",
    property.city,
    property.state,
    property.postalCode,
  ]
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(parts.join(", "))}`;
}

export function ContactsDetailsPaneClient({
  contact,
  actorId,
  teamMembers,
  contactWorkspace = false,
  subview = "overview",
  workspaceLocation = {},
  capabilities = LEGACY_EMBEDDED_CAPABILITIES,
  teamDirectoryAvailable = true,
  instantQuoteHandoff = null,
}: Props): React.ReactElement {
  const router = useRouter();
  const handoffInstantQuoteId = instantQuoteHandoff?.instantQuoteId ?? null;
  const handoffAppointmentType =
    instantQuoteHandoff?.bookingPrefill.appointmentType ?? "junk_removal";
  const handoffLoadSizeKind =
    instantQuoteHandoff?.bookingPrefill.loadSize.kind ?? null;
  const handoffCustomLoads =
    instantQuoteHandoff?.bookingPrefill.loadSize.customLoads ?? null;
  const handoffPriceRangeMinCents =
    instantQuoteHandoff?.bookingPrefill.priceRangeMinCents ?? null;
  const handoffPriceRangeMaxCents =
    instantQuoteHandoff?.bookingPrefill.priceRangeMaxCents ?? null;
  const handoffSourceType =
    instantQuoteHandoff?.bookingPrefill.source?.type ?? null;
  const memberNameById = React.useMemo(
    () => new Map(teamMembers.map((m) => [m.id, m.name])),
    [teamMembers],
  );
  const [stage, setStage] = React.useState(
    () => contact.pipeline?.stage ?? "new",
  );
  const [pipelineUpdatedAt, setPipelineUpdatedAt] = React.useState<
    string | null
  >(() => contact.pipeline?.updatedAt ?? null);
  const [assignee, setAssignee] = React.useState<string | null>(
    () => contact.salespersonMemberId ?? null,
  );
  const [showBookingForm, setShowBookingForm] = React.useState(
    () => handoffInstantQuoteId !== null,
  );
  const [bookingAppointmentType, setBookingAppointmentType] =
    React.useState<AppointmentBookingSelection>(() => handoffAppointmentType);
  const [addingProperty, setAddingProperty] = React.useState(false);
  const [editingPropertyId, setEditingPropertyId] = React.useState<
    string | null
  >(null);
  const [quotePhotoUrls, setQuotePhotoUrls] = React.useState<string[]>([]);
  const [quotePhotosStatus, setQuotePhotosStatus] = React.useState<
    "idle" | "loading" | "ready" | "empty" | ContactResourceFailure
  >("idle");
  const [quotePhotosReloadKey, setQuotePhotosReloadKey] = React.useState(0);

  React.useEffect(() => {
    setShowBookingForm(handoffInstantQuoteId !== null);
    setBookingAppointmentType(handoffAppointmentType);
    setAddingProperty(false);
    setEditingPropertyId(null);
  }, [contact.id, handoffAppointmentType, handoffInstantQuoteId]);

  React.useEffect(() => {
    setStage(contact.pipeline?.stage ?? "new");
    setPipelineUpdatedAt(contact.pipeline?.updatedAt ?? null);
  }, [contact.id, contact.pipeline?.stage, contact.pipeline?.updatedAt]);

  React.useEffect(() => {
    setAssignee(contact.salespersonMemberId ?? null);
  }, [contact.id, contact.salespersonMemberId]);

  React.useEffect(() => {
    setSystemTasks(
      (contact.reminders ?? [])
        .filter(isSystemTask)
        .sort((a, b) => Date.parse(a.dueAt ?? "") - Date.parse(b.dueAt ?? "")),
    );
  }, [contact.id, contact.reminders]);

  React.useEffect(() => {
    if (
      contactWorkspace &&
      (subview !== "intelligence" || !capabilities.canReadQuotes)
    ) {
      setQuotePhotoUrls([]);
      setQuotePhotosStatus("idle");
      return;
    }
    const controller = new AbortController();
    setQuotePhotosStatus("loading");

    void (async () => {
      try {
        const response = await fetch(
          `/api/team/contacts/quote-photos?contactId=${encodeURIComponent(contact.id)}`,
          {
            headers: { Accept: "application/json" },
            signal: controller.signal,
          },
        );
        let parsed = true;
        const data = (await response.json().catch(() => {
          parsed = false;
          return null;
        })) as QuotePhotosPayload | null;
        const failure = classifyContactResourceResponse({
          status: response.status,
          parsed,
          okFlag: data?.ok,
        });
        if (failure) {
          setQuotePhotoUrls([]);
          setQuotePhotosStatus(failure);
          return;
        }
        if (!Array.isArray(data?.photoUrls)) {
          setQuotePhotoUrls([]);
          setQuotePhotosStatus("malformed");
          return;
        }
        const urls = data.photoUrls.filter(
          (url) => typeof url === "string" && url.trim().length > 0,
        );
        setQuotePhotoUrls(urls);
        setQuotePhotosStatus(urls.length > 0 ? "ready" : "empty");
      } catch (error) {
        if ((error as { name?: string }).name === "AbortError") return;
        setQuotePhotoUrls([]);
        setQuotePhotosStatus("unavailable");
      }
    })();

    return () => controller.abort();
  }, [
    capabilities.canReadQuotes,
    contact.id,
    contactWorkspace,
    quotePhotosReloadKey,
    subview,
  ]);

  const [stageSaving, setStageSaving] = React.useState(false);
  const [stageError, setStageError] = React.useState<string | null>(null);

  const [assigneeSaving, setAssigneeSaving] = React.useState(false);
  const [assigneeError, setAssigneeError] = React.useState<string | null>(null);

  const [systemTasks, setSystemTasks] = React.useState<
    ContactReminderSummary[]
  >(() =>
    (contact.reminders ?? [])
      .filter(isSystemTask)
      .sort((a, b) => Date.parse(a.dueAt ?? "") - Date.parse(b.dueAt ?? "")),
  );

  const manualReminders = React.useMemo(() => {
    return (contact.reminders ?? [])
      .filter((reminder) => !isSystemTask(reminder))
      .sort((a, b) => Date.parse(a.dueAt ?? "") - Date.parse(b.dueAt ?? ""));
  }, [contact.reminders]);

  const initialNotes = React.useMemo(() => {
    return [...(contact.notes ?? [])].sort(
      (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    );
  }, [contact.notes]);

  async function updateStage(nextStage: string) {
    if (stageSaving) return;
    const previousStage = stage;
    if (nextStage === previousStage) return;
    const expectedVersion = pipelineExpectedVersion(pipelineUpdatedAt);
    const idempotencyKey = `pipeline-stage:${contact.id}:${expectedVersion}:${nextStage}`;
    setStageSaving(true);
    setStageError(null);
    try {
      const success = await requestPipelineStageMutation(
        () =>
          fetch("/api/team/contacts/pipeline", {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "Idempotency-Key": idempotencyKey,
              "If-Match": `"${expectedVersion}"`,
            },
            body: JSON.stringify({
              contactId: contact.id,
              stage: nextStage,
              previousStage,
            }),
          }),
        {
          actorId,
          contactId: contact.id,
          stage: nextStage,
          previousStage,
          submittedVersion: expectedVersion,
        },
      );
      setStage(success.data.pipeline.stage);
      setPipelineUpdatedAt(success.data.pipeline.updatedAt);
      router.refresh();
    } catch (error) {
      if (error instanceof PipelineStageRequestError) {
        if (error.status === 409 && error.current) {
          setStage(error.current.stage);
          setPipelineUpdatedAt(
            error.current.version === PIPELINE_ABSENT_VERSION
              ? null
              : error.current.updatedAt,
          );
          router.refresh();
        } else {
          setStage(previousStage);
        }
        setStageError(error.message);
      } else {
        setStage(previousStage);
        setStageError(
          "The pipeline stage could not be confirmed. Your previous stage was restored; try again.",
        );
      }
    } finally {
      setStageSaving(false);
    }
  }

  async function updateAssignee(nextAssignee: string | null) {
    if (assigneeSaving) return;
    setAssigneeSaving(true);
    setAssigneeError(null);
    try {
      const response = await fetch("/api/team/contacts/assignee", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contactId: contact.id,
          salespersonMemberId: nextAssignee,
        }),
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as {
          message?: string;
        } | null;
        setAssigneeError(
          typeof data?.message === "string"
            ? data.message
            : "Unable to update assignment.",
        );
        return;
      }

      setAssignee(nextAssignee);
    } finally {
      setAssigneeSaving(false);
    }
  }

  async function completeSystemTask(taskId: string) {
    if (!window.confirm("Mark this task done?")) return;
    const response = await fetch(`/api/team/contacts/reminders/${taskId}`, {
      method: "POST",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return;
    setSystemTasks((prev) => prev.filter((t) => t.id !== taskId));
  }

  const mapsLink = buildMapsLink(contact);
  const assignedLabel = assignee
    ? (memberNameById.get(assignee) ?? "Assigned")
    : "Unassigned";
  const canCall = Boolean(contact.phoneE164 ?? contact.phone);
  const handoffPropertyIsAvailable = Boolean(
    instantQuoteHandoff &&
      (contact.properties ?? []).some(
        (property) => property.id === instantQuoteHandoff.propertyId,
      ),
  );
  const primaryPropertyId = handoffPropertyIsAvailable
    ? (instantQuoteHandoff?.propertyId ?? "")
    : instantQuoteHandoff
      ? ""
      : ((contact.properties ?? [])[0]?.id ?? "");
  const bookingProperties = instantQuoteHandoff
    ? (contact.properties ?? []).filter(
        (property) => property.id === instantQuoteHandoff.propertyId,
      )
    : (contact.properties ?? []);
  const bookingPrefill = React.useMemo<AppointmentBookingDetailsPrefill | null>(
    () =>
      handoffInstantQuoteId &&
      handoffLoadSizeKind &&
      handoffPriceRangeMinCents !== null &&
      handoffPriceRangeMaxCents !== null
        ? {
            serviceType: handoffAppointmentType,
            source: handoffSourceType ? { type: handoffSourceType } : null,
            pricing: {
              mode: "range",
              rangeMinCents: handoffPriceRangeMinCents,
              rangeMaxCents: handoffPriceRangeMaxCents,
            },
            loadSize: {
              kind: handoffLoadSizeKind,
              customLoads: handoffCustomLoads,
            },
          }
        : null,
    [
      handoffAppointmentType,
      handoffCustomLoads,
      handoffInstantQuoteId,
      handoffLoadSizeKind,
      handoffPriceRangeMaxCents,
      handoffPriceRangeMinCents,
      handoffSourceType,
    ],
  );
  const hasBookingName = contact.name.trim().length > 0;
  const hasBookingPhone = Boolean(
    (contact.phoneE164 ?? contact.phone ?? "").trim(),
  );
  const hasBookingProperty = (contact.properties ?? []).length > 0;
  const isInPersonQuoteBooking = bookingAppointmentType === "in_person_quote";
  const canSubmitQuoteBooking = hasBookingName && hasBookingProperty;
  const quoteBookingBlockers = [
    !hasBookingName ? "contact name" : null,
    !hasBookingProperty ? "saved address" : null,
  ].filter((value): value is string => value !== null);
  const quoteBookingBlockedMessage =
    isInPersonQuoteBooking && quoteBookingBlockers.length > 0
      ? `Add ${quoteBookingBlockers.join(", ")} before booking an in-person quote.`
      : null;
  const canOpenSubview = (candidate: ContactSubview): boolean => {
    if (candidate === "properties") return capabilities.canReadProperties;
    if (candidate === "communications") return capabilities.canReadMessages;
    if (candidate === "jobs-quotes") {
      return (
        capabilities.canReadCalendar ||
        capabilities.canReadQuotes ||
        capabilities.canBook
      );
    }
    return true;
  };
  const activeSubviewAllowed = canOpenSubview(subview);

  return (
    <div className="space-y-4 [&_button]:min-h-11 [&_input:not([type=hidden])]:min-h-11 [&_select]:min-h-11">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <div className="truncate text-lg font-semibold text-slate-900">
              {contact.name}
            </div>
            <span
              className={`inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-wide ${badgeClassForPipelineStage(
                stage,
              )}`}
            >
              {labelForPipelineStage(stage)}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-600">
            {contact.phone ? (
              <span className="rounded-full bg-slate-100 px-3 py-1">
                {contact.phone}
              </span>
            ) : null}
            {contact.email ? (
              <span className="rounded-full bg-slate-100 px-3 py-1">
                {contact.email}
              </span>
            ) : null}
            <span className="rounded-full bg-slate-100 px-3 py-1">
              Assigned: {assignedLabel}
            </span>
          </div>
        </div>
        {capabilities.canWriteContact ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <ContactPhoneEditorClient
              contactId={contact.id}
              phone={contact.phone}
              email={contact.email}
            />
            <ContactNameEditorClient
              contactId={contact.id}
              contactName={contact.name}
            />
          </div>
        ) : null}
      </div>

      {contactWorkspace ? (
        <nav
          aria-label="Contact details"
          className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap"
        >
          {CONTACT_SUBVIEWS.map((candidate) => {
            const allowed = canOpenSubview(candidate);
            const active = subview === candidate;
            return allowed ? (
              <a
                key={candidate}
                href={contactWorkspaceHref({
                  contactId: contact.id,
                  subview: candidate,
                  ...workspaceLocation,
                  action:
                    candidate === "jobs-quotes"
                      ? workspaceLocation.action
                      : undefined,
                })}
                aria-current={active ? "page" : undefined}
                className={`inline-flex min-h-11 w-full items-center justify-center rounded-full border px-3 text-center text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-primary-200 sm:w-auto ${
                  active
                    ? "border-primary-600 bg-primary-600 text-white"
                    : "border-slate-200 bg-white text-slate-700 hover:border-primary-300 hover:text-primary-700"
                }`}
              >
                {CONTACT_SUBVIEW_LABELS[candidate]}
              </a>
            ) : (
              <span
                key={candidate}
                aria-disabled="true"
                title="Your current permissions do not include this contact view."
                className="inline-flex min-h-11 w-full items-center justify-center rounded-full border border-slate-200 bg-slate-50 px-3 text-center text-xs font-semibold text-slate-400 sm:w-auto"
              >
                {CONTACT_SUBVIEW_LABELS[candidate]}
              </span>
            );
          })}
        </nav>
      ) : null}

      <div
        className="flex flex-wrap items-center gap-2"
        aria-label="Contact quick actions"
      >
        {capabilities.canCall ? (
          <form
            action={startContactCallAction}
            className="inline"
            onSubmit={(event) => {
              if (!canCall) {
                event.preventDefault();
                return;
              }
              const label = contact.phone ?? "this contact";
              if (
                !window.confirm(
                  `Call ${contact.name} (${label}) from the Stonegate number?`,
                )
              ) {
                event.preventDefault();
              }
            }}
          >
            <input type="hidden" name="contactId" value={contact.id} />
            <input
              type="hidden"
              name="idempotencyKey"
              value={`team-call:${capabilities.callAttemptKeySeed}:${contact.id}`}
            />
            <input
              type="hidden"
              name="explicitNewAttempt"
              value="START NEW CALL"
            />
            <button
              type="submit"
              className={`${teamButtonClass("primary", "sm")} min-h-11`}
              disabled={!canCall}
            >
              Call
            </button>
          </form>
        ) : null}
        {capabilities.canMessage ? (
          <a
            className={`${teamButtonClass("secondary", "sm")} min-h-11`}
            href={teamSurfaceHref("inbox", {
              query: { contactId: contact.id },
            })}
          >
            Message
          </a>
        ) : null}
        {capabilities.canBook ? (
          <button
            type="button"
            className={`${teamButtonClass("secondary", "sm")} min-h-11`}
            onClick={() => setShowBookingForm((prev) => !prev)}
          >
            {showBookingForm ? "Close booking" : "Book appointment"}
          </button>
        ) : null}
        {capabilities.canReadCalendar ? (
          <a
            className={`${teamButtonClass("secondary", "sm")} min-h-11`}
            href={teamSurfaceHref("calendar", {
              query: { contactId: contact.id },
            })}
          >
            Calendar
          </a>
        ) : null}
        {capabilities.canWriteQuotes ? (
          <a
            className={`${teamButtonClass("secondary", "sm")} min-h-11`}
            href={quoteWorkspaceHref("create", {
              query: { contactId: contact.id },
            })}
          >
            Create quote
          </a>
        ) : null}
        <a
          className={`${teamButtonClass("secondary", "sm")} min-h-11 ${mapsLink ? "" : "pointer-events-none opacity-50"}`}
          href={mapsLink ?? "#"}
          target="_blank"
          rel="noreferrer"
        >
          Maps
        </a>
        {capabilities.canDeleteContact ? (
          <form
            action={deleteContactAction}
            className="inline"
            onSubmit={(event) => {
              if (
                !window.confirm(
                  `Move ${contact.name} to recovery? They will be hidden from active CRM views for 30 days. Automation will pause and queued operations will be quarantined for review.`,
                )
              ) {
                event.preventDefault();
              }
            }}
          >
            <input type="hidden" name="contactId" value={contact.id} />
            <input
              type="hidden"
              name="expectedVersion"
              value={contact.updatedAt}
            />
            <input
              type="hidden"
              name="idempotencyKey"
              value={`contact-delete:${contact.id}:${contact.updatedAt}`}
            />
            <SubmitButton
              className={`${teamButtonClass("danger", "sm")} min-h-11`}
              pendingLabel="Moving..."
            >
              Move to recovery
            </SubmitButton>
          </form>
        ) : null}
      </div>

      {contactWorkspace && !activeSubviewAllowed ? (
        <section
          className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
          role="alert"
          aria-labelledby="contact-subview-denied-title"
        >
          <h3 id="contact-subview-denied-title" className="font-semibold">
            This contact view is unavailable
          </h3>
          <p className="mt-1">
            Your current permissions do not include{" "}
            {CONTACT_SUBVIEW_LABELS[subview].toLowerCase()}. Choose an available
            contact view above.
          </p>
        </section>
      ) : null}

      {(!contactWorkspace ||
        (activeSubviewAllowed && subview === "overview")) &&
      (capabilities.canReadPartners || capabilities.canInvitePartners) ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                Partner portal
              </h3>
              <p className="mt-1 text-xs text-slate-500">
                Invite this contact to the Partner Portal. Sending an invite
                also marks them as a partner.
              </p>
            </div>
            {capabilities.canReadPartners ? (
              <a
                className={`${teamButtonClass("secondary", "sm")} min-h-11`}
                href={teamSurfaceHref("partners", {
                  query: { p_selected: contact.id },
                })}
              >
                Advanced setup
              </a>
            ) : null}
          </div>

          {capabilities.canInvitePartners ? (
            <form
              action={partnerPortalInviteUserAction}
              className="mt-4 grid gap-3 text-xs text-slate-600 sm:grid-cols-2"
              onSubmit={(event) => {
                const label =
                  contact.email ??
                  contact.phone ??
                  contact.name ??
                  "this contact";
                if (
                  !window.confirm(`Send a Partner Portal invite to ${label}?`)
                ) {
                  event.preventDefault();
                }
              }}
            >
              <input type="hidden" name="orgContactId" value={contact.id} />
              <input type="hidden" name="expectedVersion" value="new" />
              <input
                type="hidden"
                name="idempotencyKey"
                value={`partner-invite:${contact.id}:${contact.updatedAt}`}
              />

              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Name
                </span>
                <input
                  name="name"
                  defaultValue={contact.name}
                  required
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Email
                </span>
                <input
                  name="email"
                  type="email"
                  defaultValue={contact.email ?? ""}
                  placeholder="name@company.com"
                  required
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                />
              </label>

              <label className="flex flex-col gap-1 sm:col-span-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Phone (optional)
                </span>
                <input
                  name="phone"
                  type="tel"
                  defaultValue={contact.phoneE164 ?? contact.phone ?? ""}
                  placeholder="+1 404-555-1234"
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                />
              </label>

              <div className="sm:col-span-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] text-slate-500">
                  Invite includes a login link (expires in ~30 minutes).
                </span>
                <SubmitButton
                  className={teamButtonClass("primary", "sm")}
                  pendingLabel="Sending..."
                >
                  Send portal invite
                </SubmitButton>
              </div>
            </form>
          ) : (
            <p className="mt-3 text-xs text-slate-500">
              You can review the partner workspace, but sending portal invites
              requires partner invitation access.
            </p>
          )}
        </div>
      ) : null}

      {activeSubviewAllowed && capabilities.canBook && showBookingForm ? (
        <form
          action={bookAppointmentAction}
          className="grid gap-3 rounded-2xl border border-slate-200 bg-white p-4 text-xs text-slate-600"
        >
          <input type="hidden" name="contactId" value={contact.id} />
          {instantQuoteHandoff ? (
            <>
              <input
                type="hidden"
                name="instantQuoteId"
                value={instantQuoteHandoff.instantQuoteId}
              />
              <input type="hidden" name="source" value="team_instant_quote" />
            </>
          ) : null}
          <input
            type="hidden"
            name="currentAssignedAssociateMemberId"
            value={assignee ?? ""}
          />
          {isInPersonQuoteBooking ? (
            <input
              type="hidden"
              name="assignedAssociateMemberId"
              value={assignee ?? ""}
            />
          ) : null}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {instantQuoteHandoff ? (
              <div
                className="sm:col-span-2 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-xs text-sky-950"
                role="status"
              >
                <span className="font-semibold">
                  Verified instant quote loaded.
                </span>{" "}
                The saved property, price range, estimated load, attribution,
                and customer notes are prefilled below. Review them before
                confirming.
              </div>
            ) : null}
            {instantQuoteHandoff && !handoffPropertyIsAvailable ? (
              <div
                className="sm:col-span-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-950"
                role="alert"
              >
                The quote&apos;s verified property is not available in this
                customer view. Refresh or repair the relationship before
                booking; another address will not be substituted.
              </div>
            ) : null}
            <div className="sm:col-span-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Scheduling
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                What are we booking?
              </span>
              <select
                name="appointmentType"
                value={bookingAppointmentType}
                onChange={(event) =>
                  setBookingAppointmentType(
                    resolveBookingSelection(event.target.value),
                  )
                }
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              >
                {APPOINTMENT_BOOKING_SELECTION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Property
              </span>
              <select
                name="propertyId"
                defaultValue={primaryPropertyId}
                required={isInPersonQuoteBooking}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              >
                <option value="">
                  {isInPersonQuoteBooking
                    ? "Select saved address"
                    : "No address yet (create placeholder)"}
                </option>
                {bookingProperties.map((property) => (
                  <option key={property.id} value={property.id}>
                    {property.addressLine1}, {property.city}, {property.state}{" "}
                    {property.postalCode}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Start time
              </span>
              <input
                type="datetime-local"
                name="startAt"
                required
                step={300}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              />
            </label>

            {isInPersonQuoteBooking ? (
              <div className="sm:col-span-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-[11px] text-slate-600">
                In-person quote only uses the saved contact details plus a saved
                address, date, and time.
                {!hasBookingName ? " Add the contact name first." : ""}
                {!hasBookingProperty ? " Add a property address first." : ""}
              </div>
            ) : (
              <>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    Duration (minutes)
                  </span>
                  <input
                    name="durationMinutes"
                    type="number"
                    min={15}
                    step={5}
                    defaultValue={60}
                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    Travel buffer (minutes)
                  </span>
                  <input
                    name="travelBufferMinutes"
                    type="number"
                    min={0}
                    step={5}
                    defaultValue={30}
                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                  />
                </label>

                <div className="sm:col-span-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Ownership
                </div>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    Assigned Associate
                  </span>
                  <select
                    name="assignedAssociateMemberId"
                    defaultValue={assignee ?? ""}
                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                  >
                    <option value="">(Unassigned)</option>
                    {teamMembers.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    Who sold the job?
                  </span>
                  <select
                    name="soldByMemberId"
                    defaultValue={assignee ?? ""}
                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                  >
                    <option value="">(Select seller)</option>
                    {teamMembers.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    Seller Override Code
                  </span>
                  <input
                    name="soldByOverrideCode"
                    type="password"
                    autoComplete="off"
                    placeholder="Only needed if changing seller"
                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                  />
                </label>

                <p className="sm:col-span-2 text-[11px] text-slate-500">
                  Assigned Associate keeps the contact routed to the right phone
                  and owner. Who sold the job is stored on the appointment for
                  commission payouts, and changing it later requires the secret
                  code.
                </p>
                <AppointmentBookingDetailsFields
                  teamMembers={teamMembers}
                  serviceType={bookingAppointmentType}
                  bookingPrefill={bookingPrefill}
                  labelClassName="flex flex-col gap-1"
                  fieldClassName="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                />

                <div className="sm:col-span-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-[11px] text-slate-600">
                  Range-only jobs stay out of exact revenue projections until an
                  exact quote or final job total is saved.
                </div>

                <label className="flex flex-col gap-1 sm:col-span-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    Appointment notes (optional)
                  </span>
                  <textarea
                    name="notes"
                    rows={3}
                    defaultValue={
                      instantQuoteHandoff?.bookingPrefill.notes ?? ""
                    }
                    placeholder="What did they say? Parking/gate notes? Items? Time constraints?"
                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                  />
                </label>
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <SubmitButton
              className={teamButtonClass("primary", "sm")}
              pendingLabel="Booking..."
              disabled={
                (isInPersonQuoteBooking && !canSubmitQuoteBooking) ||
                Boolean(instantQuoteHandoff && !handoffPropertyIsAvailable)
              }
            >
              Confirm booking
            </SubmitButton>
            <button
              type="button"
              className={teamButtonClass("secondary", "sm")}
              onClick={() => setShowBookingForm(false)}
            >
              Cancel
            </button>
            <span className="text-[11px] text-slate-500">
              Calendar sync runs via the outbox worker.
            </span>
            {quoteBookingBlockedMessage ? (
              <span className="text-[11px] font-medium text-rose-600">
                {quoteBookingBlockedMessage}
              </span>
            ) : null}
            {!hasBookingPhone ? (
              <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-[11px] font-medium text-amber-800">
                Need&apos;s phone number
              </span>
            ) : null}
          </div>
        </form>
      ) : null}

      {!contactWorkspace || (activeSubviewAllowed && subview === "overview") ? (
        <div className="grid gap-3 rounded-2xl border border-slate-200 bg-white p-3 text-xs text-slate-600">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Stage
              </span>
              <select
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                value={stage}
                disabled={stageSaving || !capabilities.canUpdatePipeline}
                onChange={(e) => void updateStage(e.target.value)}
              >
                {PIPELINE_STAGES.map((value) => (
                  <option key={value} value={value}>
                    {labelForPipelineStage(value)}
                  </option>
                ))}
              </select>
              {stageError ? (
                <span className="mt-1 text-xs font-semibold text-rose-600">
                  {stageError}
                </span>
              ) : null}
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Assigned to
              </span>
              <select
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                value={assignee ?? ""}
                disabled={
                  assigneeSaving ||
                  !capabilities.canWriteContact ||
                  !teamDirectoryAvailable
                }
                onChange={(e) =>
                  void updateAssignee(
                    e.target.value.trim().length ? e.target.value : null,
                  )
                }
              >
                <option value="">(Unassigned)</option>
                {teamMembers.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
              {assigneeError ? (
                <span className="mt-1 text-xs font-semibold text-rose-600">
                  {assigneeError}
                </span>
              ) : null}
              {!teamDirectoryAvailable ? (
                <span
                  className="mt-1 text-xs font-medium text-amber-700"
                  role="status"
                >
                  Assignment is unavailable until the team directory reloads.
                </span>
              ) : null}
            </label>
          </div>

          <div className="flex flex-wrap gap-2">
            {capabilities.canReadCalendar ? (
              <span className="rounded-full bg-slate-100 px-3 py-1">
                Appointments: {contact.stats?.appointments ?? 0}
              </span>
            ) : null}
            {capabilities.canReadQuotes ? (
              <span className="rounded-full bg-slate-100 px-3 py-1">
                Quotes: {contact.stats?.quotes ?? 0}
              </span>
            ) : null}
            <span className="rounded-full bg-slate-100 px-3 py-1">
              Notes: {contact.notesCount ?? contact.notes?.length ?? 0}
            </span>
          </div>
          <div className="text-[11px] text-slate-500">
            Last activity: {formatDateTime(contact.lastActivityAt)}
          </div>
        </div>
      ) : null}

      {!contactWorkspace ||
      (activeSubviewAllowed && subview === "intelligence") ? (
        <>
          <ContactSalesAgentMemoryClient
            contactId={contact.id}
            canRefresh={capabilities.canWriteContact}
            includeQuotePrice={capabilities.canReadQuotes}
          />
          <ContactMediaAnalysisClient
            contactId={contact.id}
            canRefresh={capabilities.canWriteContact}
            includeQuotePrice={capabilities.canReadQuotes}
          />
        </>
      ) : null}

      {!contactWorkspace ||
      (activeSubviewAllowed && subview === "properties") ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Address
              </div>
              <div className="text-sm font-semibold text-slate-900">
                Properties
              </div>
            </div>
            {addingProperty || !capabilities.canWriteProperties ? null : (
              <button
                type="button"
                className={teamButtonClass("secondary", "sm")}
                onClick={() => {
                  setAddingProperty(true);
                  setEditingPropertyId(null);
                }}
              >
                Add property
              </button>
            )}
          </div>

          <div className="mt-3 space-y-3">
            {(contact.properties ?? []).map((property) => {
              const isEditing = editingPropertyId === property.id;
              return (
                <div
                  key={property.id}
                  className="rounded-2xl border border-slate-200 bg-slate-50/70 p-3"
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="text-xs text-slate-600">
                      <div className="text-sm font-semibold text-slate-900">
                        {property.addressLine1}
                        {property.addressLine2
                          ? `, ${property.addressLine2}`
                          : ""}
                      </div>
                      <div>
                        {property.city}, {property.state} {property.postalCode}
                      </div>
                      <div className="mt-1 text-[11px] text-slate-500">
                        Added {formatDateTime(property.createdAt)}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <a
                        className={`${teamButtonClass("secondary", "sm")} min-h-11 ${buildMapsLinkForProperty(property) ? "" : "pointer-events-none opacity-50"}`}
                        href={buildMapsLinkForProperty(property) ?? "#"}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Maps
                      </a>
                      {!capabilities.canWriteProperties ? null : isEditing ? (
                        <button
                          type="button"
                          className={teamButtonClass("secondary", "sm")}
                          onClick={() => setEditingPropertyId(null)}
                        >
                          Close
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={teamButtonClass("secondary", "sm")}
                          onClick={() => {
                            setAddingProperty(false);
                            setEditingPropertyId(property.id);
                          }}
                        >
                          Edit
                        </button>
                      )}
                      {capabilities.canDeleteProperties ? (
                        <form
                          action={deletePropertyAction}
                          onSubmit={(event) => {
                            if (
                              !window.confirm("Delete this property address?")
                            ) {
                              event.preventDefault();
                            }
                          }}
                        >
                          <input
                            type="hidden"
                            name="contactId"
                            value={contact.id}
                          />
                          <input
                            type="hidden"
                            name="propertyId"
                            value={property.id}
                          />
                          <SubmitButton
                            className={teamButtonClass("danger", "sm")}
                            pendingLabel="Deleting..."
                          >
                            Delete
                          </SubmitButton>
                        </form>
                      ) : null}
                    </div>
                  </div>

                  {capabilities.canWriteProperties && isEditing ? (
                    <form
                      action={updatePropertyAction}
                      className="mt-3 grid grid-cols-1 gap-3 text-xs text-slate-600 sm:grid-cols-2"
                      onSubmit={() => setEditingPropertyId(null)}
                    >
                      <input
                        type="hidden"
                        name="contactId"
                        value={contact.id}
                      />
                      <input
                        type="hidden"
                        name="propertyId"
                        value={property.id}
                      />
                      <label className="flex flex-col gap-1 sm:col-span-2">
                        <span>Address line 1</span>
                        <input
                          name="addressLine1"
                          defaultValue={property.addressLine1}
                          required
                          className="rounded-xl border border-slate-200 bg-white px-3 py-2"
                        />
                      </label>
                      <label className="flex flex-col gap-1 sm:col-span-2">
                        <span>Address line 2</span>
                        <input
                          name="addressLine2"
                          defaultValue={property.addressLine2 ?? ""}
                          className="rounded-xl border border-slate-200 bg-white px-3 py-2"
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span>City</span>
                        <input
                          name="city"
                          defaultValue={property.city}
                          required
                          className="rounded-xl border border-slate-200 bg-white px-3 py-2"
                        />
                      </label>
                      <div className="grid grid-cols-2 gap-3">
                        <label className="flex flex-col gap-1">
                          <span>State</span>
                          <input
                            name="state"
                            defaultValue={property.state}
                            required
                            maxLength={2}
                            className="rounded-xl border border-slate-200 bg-white px-3 py-2 uppercase"
                          />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span>Postal code</span>
                          <input
                            name="postalCode"
                            defaultValue={property.postalCode}
                            required
                            className="rounded-xl border border-slate-200 bg-white px-3 py-2"
                          />
                        </label>
                      </div>
                      <div className="flex flex-wrap gap-2 sm:col-span-2">
                        <SubmitButton
                          className={teamButtonClass("primary", "sm")}
                          pendingLabel="Saving..."
                        >
                          Save
                        </SubmitButton>
                        <button
                          type="button"
                          className={teamButtonClass("secondary", "sm")}
                          onClick={() => setEditingPropertyId(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : null}
                </div>
              );
            })}

            {addingProperty && capabilities.canWriteProperties ? (
              <form
                action={addPropertyAction}
                className="grid grid-cols-1 gap-3 rounded-2xl border border-dashed border-slate-300 bg-white p-3 text-xs text-slate-600 sm:grid-cols-2"
                onSubmit={() => setAddingProperty(false)}
              >
                <input type="hidden" name="contactId" value={contact.id} />
                <label className="flex flex-col gap-1 sm:col-span-2">
                  <span>Address line 1</span>
                  <input
                    name="addressLine1"
                    required
                    className="rounded-xl border border-slate-200 bg-white px-3 py-2"
                  />
                </label>
                <label className="flex flex-col gap-1 sm:col-span-2">
                  <span>Address line 2</span>
                  <input
                    name="addressLine2"
                    className="rounded-xl border border-slate-200 bg-white px-3 py-2"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span>City</span>
                  <input
                    name="city"
                    required
                    className="rounded-xl border border-slate-200 bg-white px-3 py-2"
                  />
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="flex flex-col gap-1">
                    <span>State</span>
                    <input
                      name="state"
                      required
                      maxLength={2}
                      className="rounded-xl border border-slate-200 bg-white px-3 py-2 uppercase"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span>Postal code</span>
                    <input
                      name="postalCode"
                      required
                      className="rounded-xl border border-slate-200 bg-white px-3 py-2"
                    />
                  </label>
                </div>
                <div className="flex flex-wrap gap-2 sm:col-span-2">
                  <SubmitButton
                    className={teamButtonClass("primary", "sm")}
                    pendingLabel="Saving..."
                  >
                    Save
                  </SubmitButton>
                  <button
                    type="button"
                    className={teamButtonClass("secondary", "sm")}
                    onClick={() => setAddingProperty(false)}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : null}

            {!addingProperty && (contact.properties ?? []).length === 0 ? (
              <div className="text-xs text-slate-500">
                No address yet. Add a property to save the job location.
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {contactWorkspace && activeSubviewAllowed && subview === "jobs-quotes" ? (
        <section
          className="rounded-2xl border border-slate-200 bg-white p-4"
          aria-labelledby="contact-jobs-quotes-title"
        >
          <h3
            id="contact-jobs-quotes-title"
            className="text-sm font-semibold text-slate-900"
          >
            Jobs and quotes
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            Open the full, permission-checked workspace for detailed lifecycle
            history. These counts come from the current contact snapshot.
          </p>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
            {capabilities.canReadCalendar ? (
              <div className="rounded-xl bg-slate-50 p-3">
                <dt className="text-xs text-slate-500">Appointments</dt>
                <dd className="mt-1 text-xl font-semibold text-slate-900">
                  {contact.stats?.appointments ?? 0}
                </dd>
              </div>
            ) : null}
            {capabilities.canReadQuotes ? (
              <div className="rounded-xl bg-slate-50 p-3">
                <dt className="text-xs text-slate-500">Quotes</dt>
                <dd className="mt-1 text-xl font-semibold text-slate-900">
                  {contact.stats?.quotes ?? 0}
                </dd>
              </div>
            ) : null}
          </dl>
          <div className="mt-4 flex flex-wrap gap-2">
            {capabilities.canReadCalendar ? (
              <a
                className={`${teamButtonClass("secondary", "sm")} min-h-11`}
                href={teamSurfaceHref("calendar", {
                  query: { contactId: contact.id },
                })}
              >
                View calendar work
              </a>
            ) : null}
            {capabilities.canReadQuotes ? (
              <a
                className={`${teamButtonClass("secondary", "sm")} min-h-11`}
                href={teamSurfaceHref("quotes", {
                  query: { contactId: contact.id },
                })}
              >
                View quotes
              </a>
            ) : null}
          </div>
        </section>
      ) : null}

      {contactWorkspace &&
      activeSubviewAllowed &&
      subview === "communications" ? (
        <section
          className="rounded-2xl border border-slate-200 bg-white p-4"
          aria-labelledby="contact-communications-title"
        >
          <h3
            id="contact-communications-title"
            className="text-sm font-semibold text-slate-900"
          >
            Communications
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            Conversation history and delivery status live in Inbox so one
            timeline remains the source of truth.
          </p>
          <dl className="mt-4 space-y-2 text-sm text-slate-700">
            <div>
              <dt className="text-xs font-semibold text-slate-500">Phone</dt>
              <dd>{contact.phone ?? "No phone number on file"}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold text-slate-500">Email</dt>
              <dd className="break-all">
                {contact.email ?? "No email address on file"}
              </dd>
            </div>
          </dl>
          <a
            className={`${teamButtonClass("primary", "sm")} mt-4 min-h-11`}
            href={teamSurfaceHref("inbox", {
              query: { contactId: contact.id },
            })}
          >
            Open conversation timeline
          </a>
        </section>
      ) : null}

      {capabilities.canReadQuotes &&
      (!contactWorkspace ||
        (activeSubviewAllowed && subview === "intelligence")) ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Instant Quote
              </div>
              <div className="text-sm font-semibold text-slate-900">
                Quote photos
              </div>
            </div>
            <div className="text-xs text-slate-500">
              {quotePhotoUrls.length ? `${quotePhotoUrls.length} photo(s)` : ""}
            </div>
          </div>
          <div className="mt-3 text-xs text-slate-600">
            {quotePhotosStatus === "loading" || quotePhotosStatus === "idle" ? (
              <div role="status">Loading photos…</div>
            ) : quotePhotosStatus !== "ready" &&
              quotePhotosStatus !== "empty" ? (
              <div className="text-rose-600" role="alert">
                <p>
                  {contactResourceFailureMessage(
                    "quote photos",
                    quotePhotosStatus,
                  )}
                </p>
                {quotePhotosStatus !== "forbidden" &&
                quotePhotosStatus !== "not-found" ? (
                  <button
                    type="button"
                    className={`${teamButtonClass("secondary", "sm")} mt-2`}
                    onClick={() =>
                      setQuotePhotosReloadKey((current) => current + 1)
                    }
                  >
                    Retry quote photos
                  </button>
                ) : null}
              </div>
            ) : quotePhotosStatus === "empty" ? (
              <div role="status">
                No quote photos are on file for this contact.
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {quotePhotoUrls.map((url) => (
                  <a
                    key={url}
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="group relative overflow-hidden rounded-xl border border-slate-200 bg-slate-50"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={url}
                      alt="Quote photo"
                      className="h-28 w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
                    />
                  </a>
                ))}
              </div>
            )}
            <div className="mt-2 text-[11px] text-slate-500">
              Photos can expire after 7 days.
            </div>
          </div>
        </div>
      ) : null}

      {!contactWorkspace || (activeSubviewAllowed && subview === "activity") ? (
        <>
          {systemTasks.length > 0 ? (
            <div className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                System tasks
              </div>
              <div className="space-y-2">
                {systemTasks.slice(0, 6).map((task) => (
                  <div
                    key={task.id}
                    className="rounded-2xl border border-slate-200 bg-white p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-slate-800">
                          {task.title}
                        </div>
                        <div className="mt-1 text-xs text-slate-500">
                          {formatDateTime(task.dueAt)}
                        </div>
                        {task.notes ? (
                          <div className="mt-1 text-xs text-slate-600 line-clamp-2">
                            {task.notes}
                          </div>
                        ) : null}
                      </div>
                      {capabilities.canWriteContact ? (
                        <button
                          type="button"
                          className={teamButtonClass("secondary", "sm")}
                          onClick={() => void completeSystemTask(task.id)}
                        >
                          Mark done
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <InboxContactRemindersClient
            key={contact.id}
            contactId={contact.id}
            initialReminders={manualReminders}
            readOnly={!capabilities.canWriteContact}
          />
          <InboxContactNotesClient
            contactId={contact.id}
            initialNotes={initialNotes}
            readOnly={!capabilities.canWriteContact}
          />
        </>
      ) : null}
    </div>
  );
}
