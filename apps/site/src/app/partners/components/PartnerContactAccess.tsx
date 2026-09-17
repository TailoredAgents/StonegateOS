"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import {
  bookingContactErrors,
  normalizeBookingContact,
  type BookingContactDetails,
  type PartnerContactAccessValues,
} from "../lib/booking-contact";
import {
  partnerFieldClass,
  partnerSecondaryButtonClass,
} from "./PartnerPortalUi";

type Props = {
  value: PartnerContactAccessValues;
  onChange: (key: keyof PartnerContactAccessValues, value: string) => void;
  fieldErrors: Record<string, string>;
  initialCrewInstructions: string;
  locationContact?: BookingContactDetails;
  requesterContact?: BookingContactDetails;
  locationAccessDetails?: string;
  onUseContact: (contact: BookingContactDetails) => void;
  accessChoices: React.ReactNode;
};

function belongsTo(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}.`);
}

function matchingErrors(
  errors: Record<string, string>,
  ...roots: string[]
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(errors).filter(([field]) =>
      roots.some((root) => belongsTo(field, root)),
    ),
  );
}

function primaryErrors(errors: Record<string, string>): Record<string, string> {
  return matchingErrors(errors, "onSiteContact", "contactMethod");
}

function ErrorMessages({
  id,
  errors,
}: {
  id: string;
  errors: Record<string, string>;
}) {
  const messages = [...new Set(Object.values(errors))];
  return messages.length ? (
    <div id={id} className="space-y-1 text-sm font-medium text-rose-700">
      {messages.map((message) => (
        <p key={message}>{message}</p>
      ))}
    </div>
  ) : null;
}

function contactSummary(contact: BookingContactDetails): string {
  return [contact.name, contact.phone, contact.email]
    .filter(Boolean)
    .join(" · ");
}

function sameContact(
  left: BookingContactDetails,
  right: BookingContactDetails,
): boolean {
  return (
    left.name === right.name &&
    left.phone === right.phone &&
    left.email === right.email
  );
}

function focusField(id: string): void {
  window.requestAnimationFrame(() => document.getElementById(id)?.focus());
}

function ContactFields({
  kind,
  contact,
  errors,
  onChange,
}: {
  kind: "primary" | "backup";
  contact: BookingContactDetails;
  errors: Record<string, string>;
  onChange: (key: keyof BookingContactDetails, value: string) => void;
}) {
  const errorId = `partner-book-${kind}-contact-errors`;
  const fields = [
    {
      key: "name",
      label: "Name",
      type: "text",
      autocomplete: "name",
      limit: 200,
    },
    {
      key: "phone",
      label: "Phone",
      type: "tel",
      autocomplete: "tel",
      limit: 50,
    },
    {
      key: "email",
      label: "Email",
      type: "email",
      autocomplete: "email",
      limit: 320,
    },
  ] as const;
  return (
    <div className="space-y-3">
      <div className="grid gap-4 sm:grid-cols-3">
        {fields.map((field) => {
          const id = `partner-book-${kind === "primary" ? "contact" : "alternate"}-${field.key}`;
          const invalid =
            kind === "primary"
              ? Boolean(
                  errors[`onSiteContact.${field.key}`] ||
                    (field.key === "name"
                      ? errors["onSiteContact"]
                      : errors["contactMethod"]),
                )
              : Boolean(
                  errors[`scope.alternateContact.${field.key}`] ||
                    (field.key === "name"
                      ? errors["scope.alternateContact"]
                      : undefined),
                );
          return (
            <label
              key={field.key}
              htmlFor={id}
              className="text-sm font-semibold text-slate-700"
            >
              {field.label}
              <input
                id={id}
                type={field.type}
                autoComplete={`section-${kind}-contact ${field.autocomplete}`}
                inputMode={
                  field.key === "phone"
                    ? "tel"
                    : field.key === "email"
                      ? "email"
                      : undefined
                }
                required={kind === "primary" && field.key === "name"}
                maxLength={kind === "backup" ? field.limit : undefined}
                value={contact[field.key]}
                onChange={(event) => onChange(field.key, event.target.value)}
                className={`${partnerFieldClass} font-normal`}
                aria-invalid={invalid}
                aria-describedby={invalid ? errorId : undefined}
              />
            </label>
          );
        })}
      </div>
      <ErrorMessages id={errorId} errors={errors} />
    </div>
  );
}

function OptionalContactRow({
  id,
  title,
  summary,
  errors,
  compactSummary = false,
  children,
}: {
  id: string;
  title: string;
  summary: string;
  errors: Record<string, string>;
  compactSummary?: boolean;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDetailsElement>(null);
  const hasErrors = Object.keys(errors).length > 0;
  React.useEffect(() => {
    if (hasErrors && ref.current) ref.current.open = true;
  }, [hasErrors, errors]);
  return (
    <details
      id={id}
      ref={ref}
      className="group/contact-option border-t border-slate-200"
    >
      <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 rounded-lg py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-slate-900">
            {title}{" "}
            <span className="font-normal text-slate-500">(optional)</span>
          </span>
          <span
            className={
              compactSummary
                ? "mt-0.5 block truncate text-xs text-slate-600"
                : "mt-0.5 block break-words text-xs text-slate-600 [overflow-wrap:anywhere]"
            }
            title={compactSummary ? summary : undefined}
          >
            {summary}
          </span>
        </span>
        <ChevronDown
          className="h-4 w-4 shrink-0 text-slate-500 transition-transform group-open/contact-option:rotate-180 motion-reduce:transition-none"
          aria-hidden="true"
        />
      </summary>
      <div className="space-y-3 pb-4 pt-1">{children}</div>
    </details>
  );
}

export function PartnerContactAccess({
  value,
  onChange,
  fieldErrors,
  initialCrewInstructions,
  locationContact,
  requesterContact,
  locationAccessDetails,
  onUseContact,
  accessChoices,
}: Props) {
  const primary = {
    name: value.contactName,
    phone: value.contactPhone,
    email: value.contactEmail,
  };
  const backup = {
    name: value.alternateContactName,
    phone: value.alternateContactPhone,
    email: value.alternateContactEmail,
  };
  const normalizedPrimary = normalizeBookingContact(primary);
  const currentPrimaryErrors = primaryErrors(bookingContactErrors(value));
  const serverPrimaryErrors = primaryErrors(fieldErrors);
  const primaryValid = Object.keys(currentPrimaryErrors).length === 0;
  const [attemptedDone, setAttemptedDone] = React.useState(false);
  const displayedPrimaryErrors = {
    ...(attemptedDone ? currentPrimaryErrors : {}),
    ...serverPrimaryErrors,
  };
  const primaryRef = React.useRef<HTMLDetailsElement>(null);
  const primarySummaryRef = React.useRef<HTMLElement>(null);
  const hasPrimaryErrors = Object.keys(displayedPrimaryErrors).length > 0;
  React.useEffect(() => {
    // Only reveal automatically. Finishing a field must never collapse its editor.
    if ((!primaryValid || hasPrimaryErrors) && primaryRef.current)
      primaryRef.current.open = true;
  }, [primaryValid, hasPrimaryErrors, fieldErrors]);

  const backupErrors = matchingErrors(fieldErrors, "scope.alternateContact");
  const accessErrors = matchingErrors(fieldErrors, "accessDetails");
  const crewErrors = matchingErrors(fieldErrors, "crewInstructions");
  const crewPresent = Boolean(
    initialCrewInstructions.trim() ||
      value.crewInstructions.trim() ||
      Object.keys(crewErrors).length,
  );
  const [hasShownCrew, setHasShownCrew] = React.useState(crewPresent);
  React.useEffect(() => {
    if (crewPresent) setHasShownCrew(true);
  }, [crewPresent]);

  const isValidChoice = (candidate: BookingContactDetails): boolean =>
    Object.keys(
      primaryErrors(
        bookingContactErrors({
          ...value,
          contactName: candidate.name,
          contactPhone: candidate.phone,
          contactEmail: candidate.email,
        }),
      ),
    ).length === 0;
  const locationChoice = normalizeBookingContact(locationContact);
  const requesterChoice = normalizeBookingContact(requesterContact);
  const offerLocation =
    isValidChoice(locationChoice) &&
    !sameContact(locationChoice, normalizedPrimary);
  const offerRequester =
    isValidChoice(requesterChoice) &&
    !sameContact(requesterChoice, normalizedPrimary) &&
    (!offerLocation || !sameContact(requesterChoice, locationChoice));
  const applyContact = (candidate: BookingContactDetails): void => {
    setAttemptedDone(false);
    onUseContact(candidate);
    focusField("partner-book-contact-name");
  };
  const done = (): void => {
    const errors = { ...currentPrimaryErrors, ...serverPrimaryErrors };
    if (Object.keys(errors).length) {
      setAttemptedDone(true);
      const field = Object.keys(errors)[0];
      focusField(
        field === "onSiteContact.email"
          ? "partner-book-contact-email"
          : field === "contactMethod" || field === "onSiteContact.phone"
            ? "partner-book-contact-phone"
            : "partner-book-contact-name",
      );
      return;
    }
    setAttemptedDone(false);
    if (primaryRef.current) primaryRef.current.open = false;
    primarySummaryRef.current?.focus();
  };
  const savedAccess = locationAccessDetails ?? "";
  const offerSavedAccess = Boolean(
    savedAccess.trim() && savedAccess.trim() !== value.accessDetails.trim(),
  );

  return (
    <div className="space-y-4">
      <details
        id="partner-book-primary-contact"
        ref={primaryRef}
        className="group/primary-contact"
      >
        <summary
          ref={primarySummaryRef}
          className="flex min-h-14 cursor-pointer list-none items-center gap-3 rounded-lg py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 [&::-webkit-details-marker]:hidden"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-slate-900">
              Contact for this visit
            </span>
            <span className="mt-1 block break-words text-sm text-slate-700 [overflow-wrap:anywhere]">
              {contactSummary(normalizedPrimary) ||
                "Add a name and a phone number or email."}
            </span>
          </span>
          <span className="inline-flex min-h-11 shrink-0 items-center text-sm font-semibold text-primary-800">
            Change contact
          </span>
          <ChevronDown
            className="h-4 w-4 shrink-0 text-slate-500 transition-transform group-open/primary-contact:rotate-180 motion-reduce:transition-none"
            aria-hidden="true"
          />
        </summary>
        <div className="space-y-3 pb-2 pt-3">
          <p className="text-xs leading-5 text-slate-600">
            A name and either a phone number or email are required.
          </p>
          {offerLocation || offerRequester ? (
            <div className="flex flex-wrap gap-2">
              {offerLocation ? (
                <button
                  type="button"
                  className={partnerSecondaryButtonClass}
                  onClick={() => applyContact(locationChoice)}
                >
                  Use location contact
                </button>
              ) : null}
              {offerRequester ? (
                <button
                  type="button"
                  className={partnerSecondaryButtonClass}
                  onClick={() => applyContact(requesterChoice)}
                >
                  Use my details
                </button>
              ) : null}
            </div>
          ) : null}
          <ContactFields
            kind="primary"
            contact={primary}
            errors={displayedPrimaryErrors}
            onChange={(key, nextValue) =>
              onChange(
                key === "name"
                  ? "contactName"
                  : key === "phone"
                    ? "contactPhone"
                    : "contactEmail",
                nextValue,
              )
            }
          />
          <button
            type="button"
            className={partnerSecondaryButtonClass}
            onClick={done}
          >
            Done
          </button>
        </div>
      </details>

      <OptionalContactRow
        id="partner-book-backup-contact"
        title="Backup contact"
        summary={
          contactSummary(normalizeBookingContact(backup)) ||
          "Add another person if needed"
        }
        errors={backupErrors}
      >
        <p className="text-xs leading-5 text-slate-600">
          If you add a backup person, include their name and a phone number or
          email.
        </p>
        <ContactFields
          kind="backup"
          contact={backup}
          errors={backupErrors}
          onChange={(key, nextValue) =>
            onChange(
              key === "name"
                ? "alternateContactName"
                : key === "phone"
                  ? "alternateContactPhone"
                  : "alternateContactEmail",
              nextValue,
            )
          }
        />
      </OptionalContactRow>

      {accessChoices}

      <div className="space-y-3">
        <label
          className="block text-sm font-semibold text-slate-700"
          htmlFor="partner-book-access"
        >
          Arrival instructions{" "}
          <span className="font-normal text-slate-500">(optional)</span>
          <textarea
            id="partner-book-access"
            value={value.accessDetails}
            onChange={(event) => onChange("accessDetails", event.target.value)}
            rows={2}
            maxLength={4000}
            className={`${partnerFieldClass} font-normal`}
            placeholder="Parking, entry, loading access, or access hours."
            aria-invalid={Boolean(Object.keys(accessErrors).length)}
            aria-describedby={
              Object.keys(accessErrors).length
                ? "partner-book-access-error"
                : undefined
            }
          />
        </label>
        <ErrorMessages id="partner-book-access-error" errors={accessErrors} />
        {offerSavedAccess ? (
          <button
            type="button"
            className={partnerSecondaryButtonClass}
            onClick={() => {
              onChange("accessDetails", savedAccess);
              focusField("partner-book-access");
            }}
          >
            Use saved location instructions
          </button>
        ) : null}
      </div>

      {hasShownCrew || crewPresent ? (
        <OptionalContactRow
          id="partner-book-saved-crew-instructions"
          title="Saved crew instructions"
          compactSummary
          summary={value.crewInstructions.trim() || "No crew instructions"}
          errors={crewErrors}
        >
          <p className="text-xs leading-5 text-slate-600">
            Kept from this request. Update or clear anything that no longer
            applies.
          </p>
          <label
            className="block text-sm font-semibold text-slate-700"
            htmlFor="partner-book-crew-instructions"
          >
            Crew instructions
            <textarea
              id="partner-book-crew-instructions"
              value={value.crewInstructions}
              onChange={(event) =>
                onChange("crewInstructions", event.target.value)
              }
              rows={3}
              maxLength={4000}
              className={`${partnerFieldClass} font-normal`}
              aria-invalid={Boolean(Object.keys(crewErrors).length)}
              aria-describedby={
                Object.keys(crewErrors).length
                  ? "partner-book-crew-instructions-error"
                  : undefined
              }
            />
          </label>
          <ErrorMessages
            id="partner-book-crew-instructions-error"
            errors={crewErrors}
          />
        </OptionalContactRow>
      ) : null}
    </div>
  );
}
