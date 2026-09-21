"use client";

import React, { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { CalendarClock, FileText, MapPin, NotebookPen } from "lucide-react";
import {
  formatPropertyAddress,
  formatPropertyStreet,
} from "@/lib/property-address";
import {
  addPropertyAction,
  bookInboxAppointmentAction,
  createInboxQuoteAction,
  rescheduleInboxAppointmentAction,
} from "../actions";
import {
  APPOINTMENT_BOOKING_SELECTION_OPTIONS,
  resolveBookingSelection,
  type AppointmentBookingSelection,
} from "../lib/booking-details";
import { quoteWorkspaceHref } from "../quotes-workspace";
import {
  type CustomerWorkspace,
  type CustomerWorkspaceAppointment,
  type CustomerWorkspaceProperty,
} from "../lib/customer-workspace";
import { insertInboxComposerDraft } from "../inbox-composer-drafts";
import { AppointmentBookingDetailsFields } from "./AppointmentBookingDetailsFields";
import { TeamWorkflowDrawer } from "./TeamWorkflowDrawer";
import { ContactNameEditorClient } from "./ContactNameEditorClient";
import { TEAM_INPUT_COMPACT, TEAM_SELECT, teamButtonClass } from "./team-ui";

type QuoteServiceOption = {
  id: string;
  label: string;
  description?: string | null;
  allowCustomPrice: boolean;
};

type QuoteZoneOption = {
  id: string;
  name: string;
};

type TeamMemberOption = {
  id: string;
  name: string;
};

type Props = {
  contactId: string;
  employeeId?: string;
  threadId?: string | null;
  activeChannel: string;
  details?: React.ReactNode;
  primaryActions?: React.ReactNode;
  latestInboundBody?: string | null;
  aiActionType?: string | null;
  services: QuoteServiceOption[];
  zones: QuoteZoneOption[];
  teamMembers: TeamMemberOption[];
};

type Drawer =
  | "details"
  | "quote"
  | "booking"
  | "reschedule"
  | "contact"
  | "address"
  | "note"
  | null;

const moneyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

function formatDateTime(value: string | null): string {
  if (!value) return "Time TBD";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function propertyLabel(
  property: CustomerWorkspaceProperty | null | undefined,
): string {
  return formatPropertyAddress(property);
}

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export function InboxCustomerWorkspaceClient({
  contactId,
  employeeId,
  threadId,
  activeChannel,
  details,
  primaryActions,
  services,
  zones,
  teamMembers,
}: Props): React.ReactElement {
  const [workspace, setWorkspace] = useState<CustomerWorkspace | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [selectedAppointmentId, setSelectedAppointmentId] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [scheduleWarning, setScheduleWarning] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const requestRef = React.useRef<AbortController | null>(null);

  const loadWorkspace = React.useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/team/contacts/workspace?contactId=${encodeURIComponent(contactId)}`,
        { cache: "no-store", signal: controller.signal },
      );
      const data = (await response.json().catch(() => null)) as
        | CustomerWorkspace
        | { ok?: false; message?: string }
        | null;
      if (controller.signal.aborted) return;
      if (!response.ok || !data?.ok || data.contact.id !== contactId) {
        setError(
          data && "message" in data && data.message
            ? data.message
            : "Customer details could not load.",
        );
        return;
      }
      setWorkspace(data);
      setSelectedAppointmentId((current) =>
        data.upcomingAppointments.some(
          (appointment) => appointment.id === current,
        )
          ? current
          : data.upcomingAppointments[0]?.id || "",
      );
    } catch {
      if (!controller.signal.aborted)
        setError("Customer details could not load.");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [contactId]);

  useEffect(() => {
    setWorkspace(null);
    setDrawer(null);
    setLoading(false);
    setError(null);
    setNotice(null);
    setScheduleWarning(null);
    setSelectedAppointmentId("");
    return () => requestRef.current?.abort();
  }, [contactId]);

  function openDrawer(next: Exclude<Drawer, null>): void {
    setDrawer(next);
    if (!workspace && !loading) void loadWorkspace();
  }

  const selectedAppointment =
    workspace?.upcomingAppointments.find(
      (appointment) => appointment.id === selectedAppointmentId,
    ) ??
    workspace?.upcomingAppointments[0] ??
    null;

  function handleActionResult(result: {
    ok: boolean;
    error?: string;
    warning?: string;
    draftText?: string;
  }): void {
    setScheduleWarning(result.ok ? (result.warning ?? null) : null);
    if (!result.ok) {
      setNotice(result.error ?? "Unable to save. Your entries are still here.");
      return;
    }
    if (result.draftText) {
      const channel =
        activeChannel === "sms" ||
        activeChannel === "email" ||
        activeChannel === "dm"
          ? activeChannel
          : "web";
      insertInboxComposerDraft({
        employeeId,
        contactId,
        threadId,
        channel,
        body: result.draftText,
      });
      setNotice("Saved. Review the prepared reply before sending.");
    } else {
      setNotice("Saved.");
    }
    setDrawer(null);
    void loadWorkspace();
  }

  const disclosureClass =
    "rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-3";
  const summaryClass =
    "cursor-pointer text-sm font-semibold text-[color:var(--team-text)]";
  const detailsLoading = loading ? (
    <p
      className="py-3 text-sm text-[color:var(--team-text-muted)]"
      role="status"
    >
      Loading customer details…
    </p>
  ) : error ? (
    <div
      className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
      role="alert"
    >
      <p>{error}</p>
      <button
        type="button"
        className={teamButtonClass("secondary", "sm")}
        onClick={() => void loadWorkspace()}
      >
        Retry details
      </button>
    </div>
  ) : null;

  return (
    <div data-inbox-customer-workspace className="min-w-0">
      <div
        className="flex flex-wrap items-center gap-1 sm:gap-2"
        aria-label="Customer actions"
      >
        {primaryActions}
        <button
          type="button"
          className={teamButtonClass("secondary", "sm") + " max-sm:px-2"}
          onClick={() => openDrawer("quote")}
          aria-label="Create quote"
        >
          <FileText
            className="mr-1 hidden h-4 w-4 sm:block"
            aria-hidden="true"
          />
          <span className="text-xs sm:hidden">Quote</span>
          <span className="hidden text-xs sm:inline">Create quote</span>
        </button>
        <button
          type="button"
          className={teamButtonClass("secondary", "sm") + " max-sm:px-2"}
          onClick={() => openDrawer("booking")}
        >
          <CalendarClock
            className="mr-1 hidden h-4 w-4 sm:block"
            aria-hidden="true"
          />
          Book
        </button>
        <button
          type="button"
          className={teamButtonClass("secondary", "sm") + " max-sm:px-2"}
          onClick={() => openDrawer("details")}
          aria-haspopup="dialog"
          aria-label="Customer details"
        >
          <span className="text-xs sm:hidden">Details</span>
          <span className="hidden text-xs sm:inline">Customer details</span>
        </button>
      </div>
      {notice && !drawer ? (
        <p
          role="status"
          className="mt-2 text-xs text-[color:var(--team-text-muted)]"
        >
          {notice}
        </p>
      ) : null}
      {scheduleWarning && !drawer ? (
        <p
          role="status"
          className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
        >
          Warning: {scheduleWarning}
        </p>
      ) : null}
      {drawer ? (
        <TeamWorkflowDrawer
          title={drawerTitle(drawer)}
          onClose={() => setDrawer(null)}
        >
          {notice ? (
            <p
              role="status"
              className="mb-3 text-sm text-[color:var(--team-text-muted)]"
            >
              {notice}
            </p>
          ) : null}
          {detailsLoading}
          {drawer === "details" ? (
            <div className="space-y-3">
              {workspace ? (
                <>
                  <details className={disclosureClass}>
                    <summary className={summaryClass}>
                      Contact information
                    </summary>
                    <div className="mt-3 space-y-2 text-sm text-[color:var(--team-text-muted)]">
                      <p>
                        {workspace.contact.name ||
                          workspace.contact.phoneE164 ||
                          workspace.contact.phone ||
                          "Customer"}
                      </p>
                      <ContactNameEditorClient
                        contactId={contactId}
                        contactName={workspace.contact.name}
                        onSaved={() => void loadWorkspace()}
                      />
                      {workspace.contact.phoneE164 ||
                      workspace.contact.phone ? (
                        <p>
                          {workspace.contact.phoneE164 ||
                            workspace.contact.phone}
                        </p>
                      ) : null}
                      {workspace.contact.email ? (
                        <p>{workspace.contact.email}</p>
                      ) : null}
                      <button
                        type="button"
                        className={teamButtonClass("secondary", "sm")}
                        onClick={() => openDrawer("contact")}
                      >
                        Edit contact
                      </button>
                    </div>
                  </details>
                  <details className={disclosureClass}>
                    <summary className={summaryClass}>Addresses</summary>
                    <div className="mt-3 space-y-3 text-sm text-[color:var(--team-text-muted)]">
                      {workspace.properties.map((property) => (
                        <p key={property.id}>{propertyLabel(property)}</p>
                      ))}
                      <button
                        type="button"
                        className={teamButtonClass("secondary", "sm")}
                        onClick={() => openDrawer("address")}
                      >
                        <MapPin className="mr-1 h-4 w-4" aria-hidden="true" />
                        Add address
                      </button>
                    </div>
                  </details>
                  {workspace.upcomingAppointments.length ? (
                    <details className={disclosureClass}>
                      <summary className={summaryClass}>
                        Appointments ({workspace.upcomingAppointments.length})
                      </summary>
                      <div className="mt-3 space-y-3">
                        {workspace.upcomingAppointments.map((appointment) => (
                          <div
                            key={appointment.id}
                            className="flex flex-wrap items-center justify-between gap-3 text-sm"
                          >
                            <div>
                              <p className="font-medium">
                                {formatDateTime(appointment.startAt)}
                              </p>
                              {appointment.property ? (
                                <p className="text-xs text-[color:var(--team-text-muted)]">
                                  {propertyLabel(appointment.property)}
                                </p>
                              ) : null}
                            </div>
                            <button
                              type="button"
                              className={teamButtonClass("secondary", "sm")}
                              onClick={() => {
                                setSelectedAppointmentId(appointment.id);
                                openDrawer("reschedule");
                              }}
                            >
                              Reschedule
                            </button>
                          </div>
                        ))}
                      </div>
                    </details>
                  ) : null}
                  {workspace.quotes.length ? (
                    <details className={disclosureClass}>
                      <summary className={summaryClass}>
                        Quotes ({workspace.quotes.length})
                      </summary>
                      <div className="mt-3 space-y-3 text-sm">
                        {workspace.quotes.map((quote) => (
                          <div
                            key={quote.id}
                            className="rounded-lg border border-[color:var(--team-border)] p-3"
                          >
                            <div className="flex flex-wrap justify-between gap-2">
                              <span className="font-semibold">
                                {quote.quoteNumber ?? "Quote"}
                              </span>
                              {typeof quote.total === "number" ? (
                                <span>
                                  {moneyFormatter.format(quote.total)}
                                </span>
                              ) : null}
                            </div>
                            {quote.latestChangeRequest ? (
                              <p className="mt-2 text-xs text-amber-700">
                                {quote.latestChangeRequest.reason ??
                                  "Customer requested a change"}
                              </p>
                            ) : null}
                            <Link
                              href={
                                quote.shareToken
                                  ? `/quote/${quote.shareToken}?preview=1`
                                  : quoteWorkspaceHref("manage")
                              }
                              target={quote.shareToken ? "_blank" : undefined}
                              rel={quote.shareToken ? "noreferrer" : undefined}
                              className="mt-2 inline-flex min-h-11 items-center font-semibold text-primary-700"
                            >
                              {quote.shareToken
                                ? "Preview quote"
                                : "Open in Quotes"}
                            </Link>
                          </div>
                        ))}
                      </div>
                    </details>
                  ) : null}
                  {!details ? (
                    <details className={disclosureClass}>
                      <summary className={summaryClass}>Add a note</summary>
                      <button
                        type="button"
                        className={`${teamButtonClass("secondary", "sm")} mt-3`}
                        onClick={() => openDrawer("note")}
                      >
                        <NotebookPen
                          className="mr-1 h-4 w-4"
                          aria-hidden="true"
                        />
                        Add note
                      </button>
                    </details>
                  ) : null}
                </>
              ) : null}
              {details}
            </div>
          ) : null}
          {workspace && !loading && !error ? (
            <>
              {drawer === "quote" ? (
                <QuoteDrawer
                  workspace={workspace}
                  services={services}
                  zones={zones}
                  isPending={isPending}
                  onSubmit={(formData) => {
                    startTransition(async () => {
                      handleActionResult(
                        await createInboxQuoteAction(formData),
                      );
                    });
                  }}
                />
              ) : null}
              {drawer === "booking" ? (
                <BookingDrawer
                  workspace={workspace}
                  teamMembers={teamMembers}
                  isPending={isPending}
                  onSubmit={(formData) => {
                    startTransition(async () => {
                      handleActionResult(
                        await bookInboxAppointmentAction(formData),
                      );
                    });
                  }}
                />
              ) : null}
              {drawer === "reschedule" ? (
                <RescheduleDrawer
                  appointments={workspace.upcomingAppointments}
                  selectedAppointment={selectedAppointment}
                  selectedAppointmentId={selectedAppointmentId}
                  setSelectedAppointmentId={setSelectedAppointmentId}
                  isPending={isPending}
                  onSubmit={(formData) => {
                    startTransition(async () => {
                      handleActionResult(
                        await rescheduleInboxAppointmentAction(formData),
                      );
                    });
                  }}
                />
              ) : null}
              {drawer === "contact" ? (
                <ContactDrawer
                  workspace={workspace}
                  isPending={isPending}
                  onSaved={() => {
                    setDrawer(null);
                    void loadWorkspace();
                  }}
                />
              ) : null}
              {drawer === "address" ? (
                <AddressDrawer
                  contactId={workspace.contact.id}
                  isPending={isPending}
                  onSubmit={(formData) => {
                    startTransition(async () => {
                      await addPropertyAction(formData);
                      setDrawer(null);
                      setNotice("Address saved.");
                      void loadWorkspace();
                    });
                  }}
                />
              ) : null}
              {drawer === "note" ? (
                <NoteDrawer
                  contactId={workspace.contact.id}
                  onSaved={() => {
                    setDrawer(null);
                    setNotice("Note saved.");
                    void loadWorkspace();
                  }}
                />
              ) : null}
            </>
          ) : null}
        </TeamWorkflowDrawer>
      ) : null}
    </div>
  );
}

function drawerTitle(drawer: Exclude<Drawer, null>): string {
  if (drawer === "details") return "Customer details";
  if (drawer === "quote") return "Create quote";
  if (drawer === "booking") return "Book appointment";
  if (drawer === "reschedule") return "Reschedule appointment";
  if (drawer === "address") return "Add address";
  if (drawer === "note") return "Add note";
  return "Edit contact";
}

function Checklist({
  items,
}: {
  items: Array<{ label: string; done: boolean }>;
}): React.ReactElement {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        Required info
      </div>
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        {items.map((item) => (
          <span
            key={item.label}
            className={`rounded-full border px-2 py-1 font-medium ${
              item.done
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border-amber-200 bg-amber-50 text-amber-700"
            }`}
          >
            {item.done ? "OK" : "Needs"} {item.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function QuoteDrawer({
  workspace,
  services,
  zones,
  isPending,
  onSubmit,
}: {
  workspace: CustomerWorkspace;
  services: QuoteServiceOption[];
  zones: QuoteZoneOption[];
  isPending: boolean;
  onSubmit: (formData: FormData) => void;
}): React.ReactElement {
  const [propertyId, setPropertyId] = useState(
    workspace.properties[0]?.id ?? "__new",
  );
  const [selectedServices, setSelectedServices] = useState<string[]>([]);
  const [servicePrices, setServicePrices] = useState<Record<string, string>>(
    {},
  );
  const [clientScope, setClientScope] = useState("");
  const [notes, setNotes] = useState("");
  const [mutationKey] = useState(
    () =>
      `quote-inbox-create:${workspace.contact.id}:${globalThis.crypto.randomUUID()}`,
  );
  const [newAddress, setNewAddress] = useState({
    addressLine1: "",
    addressLine2: "",
    city: "",
    state: "",
    postalCode: "",
  });
  const zoneId = zones[0]?.id ?? "";

  const usingNewAddress = propertyId === "__new";
  const selectedProperty =
    workspace.properties.find((property) => property.id === propertyId) ?? null;
  const hasAddress = usingNewAddress
    ? Boolean(
        newAddress.addressLine1.trim() &&
          newAddress.city.trim() &&
          newAddress.state.trim() &&
          newAddress.postalCode.trim(),
      )
    : Boolean(propertyId);
  const serviceOverrides = useMemo(() => {
    const overrides: Record<string, number> = {};
    for (const serviceId of selectedServices) {
      const raw = servicePrices[serviceId] ?? "";
      const value = Number(raw);
      if (Number.isFinite(value) && value > 0) overrides[serviceId] = value;
    }
    return overrides;
  }, [selectedServices, servicePrices]);
  const canSubmit =
    Boolean(hasAddress && zoneId && selectedServices.length) &&
    selectedServices.every((serviceId) => {
      const value = Number(servicePrices[serviceId] ?? "");
      return Number.isFinite(value) && value > 0;
    });

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        formData.set("services", JSON.stringify(selectedServices));
        formData.set("serviceOverrides", JSON.stringify(serviceOverrides));
        formData.set("contactId", workspace.contact.id);
        formData.set("contactName", workspace.contact.name);
        formData.set("zoneId", zoneId);
        onSubmit(formData);
      }}
    >
      <input type="hidden" name="idempotencyKey" value={mutationKey} />
      <input type="hidden" name="confirmation" value="create_quote" />
      <Checklist
        items={[
          { label: "customer", done: true },
          { label: "address", done: hasAddress },
          { label: "service", done: selectedServices.length > 0 },
          { label: "price", done: canSubmit },
          {
            label: "send method",
            done: Boolean(workspace.contact.phone || workspace.contact.email),
          },
        ]}
      />
      <label className="flex flex-col gap-1 text-sm text-slate-700">
        <span>Property</span>
        <select
          name="propertyId"
          value={propertyId}
          onChange={(event) => setPropertyId(event.target.value)}
          className={TEAM_SELECT}
        >
          {workspace.properties.length
            ? workspace.properties.map((property) => (
                <option key={property.id} value={property.id}>
                  {propertyLabel(property)}
                </option>
              ))
            : null}
          <option value="__new">Use a new address...</option>
        </select>
      </label>
      {usingNewAddress ? (
        <div className="rounded-xl border border-primary-200 bg-primary-50/60 p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-primary-800">
            New quote address
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm text-slate-700 sm:col-span-2">
              <span>Street address</span>
              <input
                name="newAddressLine1"
                required
                value={newAddress.addressLine1}
                onChange={(event) =>
                  setNewAddress((current) => ({
                    ...current,
                    addressLine1: event.target.value,
                  }))
                }
                className={TEAM_INPUT_COMPACT}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-slate-700 sm:col-span-2">
              <span>Address line 2</span>
              <input
                name="newAddressLine2"
                value={newAddress.addressLine2}
                onChange={(event) =>
                  setNewAddress((current) => ({
                    ...current,
                    addressLine2: event.target.value,
                  }))
                }
                className={TEAM_INPUT_COMPACT}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-slate-700">
              <span>City</span>
              <input
                name="newCity"
                required
                value={newAddress.city}
                onChange={(event) =>
                  setNewAddress((current) => ({
                    ...current,
                    city: event.target.value,
                  }))
                }
                className={TEAM_INPUT_COMPACT}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-slate-700">
              <span>State</span>
              <input
                name="newState"
                required
                maxLength={2}
                value={newAddress.state}
                onChange={(event) =>
                  setNewAddress((current) => ({
                    ...current,
                    state: event.target.value.toUpperCase(),
                  }))
                }
                className={TEAM_INPUT_COMPACT}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-slate-700">
              <span>ZIP</span>
              <input
                name="newPostalCode"
                required
                value={newAddress.postalCode}
                onChange={(event) =>
                  setNewAddress((current) => ({
                    ...current,
                    postalCode: event.target.value,
                  }))
                }
                className={TEAM_INPUT_COMPACT}
              />
            </label>
          </div>
        </div>
      ) : null}
      <input
        type="hidden"
        name="propertyLabel"
        value={propertyLabel(selectedProperty)}
      />
      <div className="grid gap-2 sm:grid-cols-2">
        {services.map((service) => {
          const checked = selectedServices.includes(service.id);
          return (
            <div
              key={service.id}
              className={`rounded-xl border p-3 ${checked ? "border-primary-300 bg-primary-50" : "border-slate-200 bg-white"}`}
            >
              <label className="flex items-start gap-2 text-sm font-semibold text-slate-800">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() =>
                    setSelectedServices((current) =>
                      current.includes(service.id)
                        ? current.filter((item) => item !== service.id)
                        : [...current, service.id],
                    )
                  }
                />
                <span>{service.label}</span>
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                placeholder="Total price"
                disabled={!checked}
                value={servicePrices[service.id] ?? ""}
                onChange={(event) =>
                  setServicePrices((current) => ({
                    ...current,
                    [service.id]: event.target.value,
                  }))
                }
                className={`${TEAM_INPUT_COMPACT} mt-2 w-full disabled:bg-slate-100`}
              />
            </div>
          );
        })}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm text-slate-700">
          <span>Duration</span>
          <select
            name="jobDurationMinutes"
            defaultValue="120"
            className={TEAM_SELECT}
          >
            <option value="60">1 hour</option>
            <option value="120">2 hours</option>
            <option value="180">3 hours</option>
            <option value="240">Half day</option>
            <option value="480">Full day</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm text-slate-700">
          <span>Deposit</span>
          <select name="depositRate" defaultValue="0" className={TEAM_SELECT}>
            <option value="0">No deposit</option>
            <option value="0.1">10%</option>
            <option value="0.25">25%</option>
            <option value="0.5">50%</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm text-slate-700">
          <span>Expires in days</span>
          <input
            name="expiresInDays"
            type="number"
            min="1"
            max="90"
            defaultValue="7"
            className={TEAM_INPUT_COMPACT}
          />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-sm text-slate-700">
        <span>Scope shown to customer</span>
        <textarea
          name="clientScope"
          value={clientScope}
          onChange={(event) => setClientScope(event.target.value)}
          rows={4}
          className={TEAM_INPUT_COMPACT}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm text-slate-700">
        <span>Internal notes</span>
        <textarea
          name="notes"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          rows={3}
          className={TEAM_INPUT_COMPACT}
        />
      </label>
      <button
        type="submit"
        disabled={!canSubmit || isPending}
        className={teamButtonClass("primary", "md")}
      >
        {isPending ? "Creating..." : "Create quote and draft reply"}
      </button>
    </form>
  );
}

function BookingDrawer({
  workspace,
  teamMembers,
  isPending,
  onSubmit,
}: {
  workspace: CustomerWorkspace;
  teamMembers: TeamMemberOption[];
  isPending: boolean;
  onSubmit: (formData: FormData) => void;
}): React.ReactElement {
  const [appointmentType, setAppointmentType] =
    useState<AppointmentBookingSelection>("junk_removal");
  const [propertyId, setPropertyId] = useState(
    workspace.properties[0]?.id ?? "",
  );
  const selectedProperty =
    workspace.properties.find((property) => property.id === propertyId) ?? null;
  const isInPersonQuote = appointmentType === "in_person_quote";
  const defaultMemberId = workspace.contact.salespersonMemberId ?? "";

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        formData.set("contactId", workspace.contact.id);
        formData.set("contactName", workspace.contact.name);
        formData.set("propertyLabel", propertyLabel(selectedProperty));
        onSubmit(formData);
      }}
    >
      <Checklist
        items={[
          { label: "customer", done: Boolean(workspace.contact.name) },
          {
            label: "phone/email",
            done: Boolean(workspace.contact.phone || workspace.contact.email),
          },
          { label: "address", done: workspace.properties.length > 0 },
          { label: "date/time", done: false },
          {
            label: "seller",
            done: isInPersonQuote || Boolean(defaultMemberId),
          },
        ]}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm text-slate-700">
          <span>What are we booking?</span>
          <select
            name="appointmentType"
            value={appointmentType}
            onChange={(event) =>
              setAppointmentType(resolveBookingSelection(event.target.value))
            }
            className={TEAM_SELECT}
          >
            {APPOINTMENT_BOOKING_SELECTION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm text-slate-700">
          <span>Property</span>
          <select
            name="propertyId"
            value={propertyId}
            onChange={(event) => setPropertyId(event.target.value)}
            required
            className={TEAM_SELECT}
          >
            {workspace.properties.length ? (
              workspace.properties.map((property) => (
                <option key={property.id} value={property.id}>
                  {propertyLabel(property)}
                </option>
              ))
            ) : (
              <option value="">Add an address first</option>
            )}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm text-slate-700">
          <span>Start time</span>
          <input
            name="startAt"
            type="datetime-local"
            required
            step={300}
            className={TEAM_INPUT_COMPACT}
          />
        </label>
        {!isInPersonQuote ? (
          <>
            <label className="flex flex-col gap-1 text-sm text-slate-700">
              <span>Duration minutes</span>
              <input
                name="durationMinutes"
                type="number"
                min={15}
                step={5}
                defaultValue={60}
                className={TEAM_INPUT_COMPACT}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-slate-700">
              <span>Travel buffer minutes</span>
              <input
                name="travelBufferMinutes"
                type="number"
                min={0}
                step={5}
                defaultValue={30}
                className={TEAM_INPUT_COMPACT}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-slate-700">
              <span>Assigned associate</span>
              <select
                name="assignedAssociateMemberId"
                defaultValue={defaultMemberId}
                className={TEAM_SELECT}
              >
                <option value="">Unassigned</option>
                {teamMembers.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm text-slate-700">
              <span>Who sold the job?</span>
              <select
                name="soldByMemberId"
                defaultValue={defaultMemberId}
                required
                className={TEAM_SELECT}
              >
                <option value="">Select seller</option>
                {teamMembers.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="sm:col-span-2">
              <AppointmentBookingDetailsFields
                teamMembers={teamMembers}
                serviceType={appointmentType}
                labelClassName="flex flex-col gap-1 text-sm text-slate-700"
                fieldClassName={TEAM_INPUT_COMPACT}
              />
            </div>
          </>
        ) : null}
      </div>
      <label className="flex flex-col gap-1 text-sm text-slate-700">
        <span>Appointment notes</span>
        <textarea name="notes" rows={3} className={TEAM_INPUT_COMPACT} />
      </label>
      <button
        type="submit"
        disabled={isPending || !propertyId}
        className={teamButtonClass("primary", "md")}
      >
        {isPending ? "Booking..." : "Book and draft confirmation"}
      </button>
    </form>
  );
}

function RescheduleDrawer({
  appointments,
  selectedAppointment,
  selectedAppointmentId,
  setSelectedAppointmentId,
  isPending,
  onSubmit,
}: {
  appointments: CustomerWorkspaceAppointment[];
  selectedAppointment: CustomerWorkspaceAppointment | null;
  selectedAppointmentId: string;
  setSelectedAppointmentId: (value: string) => void;
  isPending: boolean;
  onSubmit: (formData: FormData) => void;
}): React.ReactElement {
  if (!appointments.length) {
    return (
      <p className="text-sm text-slate-600">
        No upcoming appointment found. Book a new appointment instead.
      </p>
    );
  }
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(new FormData(event.currentTarget));
      }}
    >
      <label className="flex flex-col gap-1 text-sm text-slate-700">
        <span>Appointment</span>
        <select
          name="appointmentId"
          value={selectedAppointmentId}
          onChange={(event) => setSelectedAppointmentId(event.target.value)}
          className={TEAM_SELECT}
        >
          {appointments.map((appointment) => (
            <option key={appointment.id} value={appointment.id}>
              {formatDateTime(appointment.startAt)}{" "}
              {appointment.property
                ? `| ${formatPropertyStreet(appointment.property)}`
                : ""}
            </option>
          ))}
        </select>
      </label>
      {selectedAppointment ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
          Current time:{" "}
          <span className="font-semibold text-slate-900">
            {formatDateTime(selectedAppointment.startAt)}
          </span>
        </div>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm text-slate-700">
          <span>New date</span>
          <input
            name="preferredDate"
            type="date"
            required
            className={TEAM_INPUT_COMPACT}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-slate-700">
          <span>New time</span>
          <input
            name="startTime"
            type="time"
            required
            step={900}
            className={TEAM_INPUT_COMPACT}
          />
        </label>
      </div>
      <button
        type="submit"
        disabled={isPending}
        className={teamButtonClass("primary", "md")}
      >
        {isPending ? "Rescheduling..." : "Reschedule and draft confirmation"}
      </button>
    </form>
  );
}

function ContactDrawer({
  workspace,
  isPending,
  onSaved,
}: {
  workspace: CustomerWorkspace;
  isPending: boolean;
  onSaved: () => void;
}): React.ReactElement {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = event.currentTarget;
    void (async () => {
      setSaving(true);
      setError(null);
      const formData = new FormData(form);
      const response = await fetch("/api/team/contacts/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactId: workspace.contact.id,
          phone: formString(formData, "phone"),
          email: formString(formData, "email"),
        }),
      });
      const data = (await response.json().catch(() => null)) as {
        message?: string;
      } | null;
      setSaving(false);
      if (!response.ok) {
        setError(data?.message ?? "Unable to update contact.");
        return;
      }
      onSaved();
    })();
  }

  return (
    <form className="space-y-4" onSubmit={handleSubmit}>
      <Checklist
        items={[
          {
            label: "phone or email",
            done: Boolean(workspace.contact.phone || workspace.contact.email),
          },
          { label: "address", done: workspace.properties.length > 0 },
        ]}
      />
      <label className="flex flex-col gap-1 text-sm text-slate-700">
        <span>Phone</span>
        <input
          name="phone"
          defaultValue={
            workspace.contact.phone ?? workspace.contact.phoneE164 ?? ""
          }
          className={TEAM_INPUT_COMPACT}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm text-slate-700">
        <span>Email</span>
        <input
          name="email"
          type="email"
          defaultValue={workspace.contact.email ?? ""}
          className={TEAM_INPUT_COMPACT}
        />
      </label>
      {error ? <p className="text-sm text-rose-600">{error}</p> : null}
      <button
        type="submit"
        disabled={saving || isPending}
        className={teamButtonClass("primary", "md")}
      >
        {saving ? "Saving..." : "Save contact"}
      </button>
    </form>
  );
}

function AddressDrawer({
  contactId,
  isPending,
  onSubmit,
}: {
  contactId: string;
  isPending: boolean;
  onSubmit: (formData: FormData) => void;
}): React.ReactElement {
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        formData.set("contactId", contactId);
        onSubmit(formData);
      }}
    >
      <input type="hidden" name="contactId" value={contactId} />
      <label className="flex flex-col gap-1 text-sm text-slate-700">
        <span>Address line 1</span>
        <input name="addressLine1" required className={TEAM_INPUT_COMPACT} />
      </label>
      <label className="flex flex-col gap-1 text-sm text-slate-700">
        <span>Address line 2</span>
        <input name="addressLine2" className={TEAM_INPUT_COMPACT} />
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm text-slate-700">
          <span>City</span>
          <input name="city" required className={TEAM_INPUT_COMPACT} />
        </label>
        <label className="flex flex-col gap-1 text-sm text-slate-700">
          <span>State</span>
          <input
            name="state"
            required
            defaultValue="GA"
            className={TEAM_INPUT_COMPACT}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-slate-700">
          <span>ZIP</span>
          <input name="postalCode" required className={TEAM_INPUT_COMPACT} />
        </label>
      </div>
      <button
        type="submit"
        disabled={isPending}
        className={teamButtonClass("primary", "md")}
      >
        {isPending ? "Saving..." : "Save address"}
      </button>
    </form>
  );
}

function NoteDrawer({
  contactId,
  onSaved,
}: {
  contactId: string;
  onSaved: () => void;
}): React.ReactElement {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = event.currentTarget;
    void (async () => {
      setSaving(true);
      setError(null);
      const formData = new FormData(form);
      const response = await fetch("/api/team/contacts/notes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          contactId,
          body: formString(formData, "body"),
        }),
      });
      const data = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      setSaving(false);
      if (!response.ok) {
        setError(data?.error?.replace(/_/g, " ") ?? "Unable to save note.");
        return;
      }
      onSaved();
    })();
  }

  return (
    <form className="space-y-4" onSubmit={handleSubmit}>
      <label className="flex flex-col gap-1 text-sm text-slate-700">
        <span>Note</span>
        <textarea
          name="body"
          rows={4}
          required
          className={TEAM_INPUT_COMPACT}
        />
      </label>
      {error ? <p className="text-sm text-rose-600">{error}</p> : null}
      <button
        type="submit"
        disabled={saving}
        className={teamButtonClass("primary", "md")}
      >
        {saving ? "Saving..." : "Save note"}
      </button>
    </form>
  );
}
