"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { partnerFieldClass } from "./PartnerPortalUi";

export type PartnerWorkOrderBillingValues = {
  poNumber: string;
  costCenter: string;
  projectReference: string;
  billingContactName: string;
  billingContactEmail: string;
};

type Props = {
  value: PartnerWorkOrderBillingValues;
  onChange: (key: keyof PartnerWorkOrderBillingValues, value: string) => void;
  fieldErrors: Record<string, string>;
};

function messagesFor(
  errors: Record<string, string>,
  ...fields: string[]
): string[] {
  return [
    ...new Set(
      fields.flatMap((field) => (errors[field] ? [errors[field]] : [])),
    ),
  ];
}

function ErrorMessages({ id, messages }: { id: string; messages: string[] }) {
  return messages.length ? (
    <div id={id} className="space-y-1 text-sm font-medium text-rose-700">
      {messages.map((message) => (
        <p key={message}>{message}</p>
      ))}
    </div>
  ) : null;
}

function BillingField({
  id,
  label,
  value,
  onChange,
  maxLength,
  errors,
  aggregateErrorId,
  type = "text",
  autoComplete,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  errors: string[];
  aggregateErrorId?: string;
  type?: "text" | "email";
  autoComplete?: string;
}) {
  const errorId = `${id}-error`;
  const describedBy =
    [errors.length ? errorId : null, aggregateErrorId]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <div className="min-w-0 space-y-2">
      <label
        htmlFor={id}
        className="block text-sm font-semibold text-slate-700"
      >
        {label}
        <input
          id={id}
          type={type}
          inputMode={type === "email" ? "email" : undefined}
          autoComplete={autoComplete}
          maxLength={maxLength}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={`${partnerFieldClass} font-normal`}
          aria-invalid={Boolean(errors.length || aggregateErrorId)}
          aria-describedby={describedBy}
        />
      </label>
      <ErrorMessages id={errorId} messages={errors} />
    </div>
  );
}

function BillingDetailsRow({
  id,
  title,
  summary,
  hasErrors,
  fieldErrors,
  children,
}: {
  id: string;
  title: string;
  summary: string;
  hasErrors: boolean;
  fieldErrors: Record<string, string>;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDetailsElement>(null);
  React.useEffect(() => {
    // Keep native disclosure state, including when a validation attempt repeats.
    // Editing a saved value must never close its editor or remove its inputs.
    if (hasErrors && ref.current) ref.current.open = true;
  }, [hasErrors, fieldErrors]);
  return (
    <details
      id={id}
      ref={ref}
      tabIndex={-1}
      className="group/billing-detail border-t border-slate-200"
    >
      <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 rounded-lg py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-slate-900">
            {title}
          </span>
          <span className="mt-0.5 block break-words text-xs font-normal text-slate-600 [overflow-wrap:anywhere]">
            {summary}
          </span>
        </span>
        <ChevronDown
          className="h-4 w-4 shrink-0 text-slate-500 transition-transform group-open/billing-detail:rotate-180 motion-reduce:transition-none"
          aria-hidden="true"
        />
      </summary>
      <div className="space-y-3 pb-4 pt-1">{children}</div>
    </details>
  );
}

export function PartnerWorkOrderBilling({
  value,
  onChange,
  fieldErrors,
}: Props) {
  const commercialErrors = messagesFor(fieldErrors, "commercial");
  const poErrors = messagesFor(fieldErrors, "commercial.poNumber");
  const projectErrors = messagesFor(fieldErrors, "commercial.projectReference");
  const costCenterErrors = messagesFor(fieldErrors, "commercial.costCenter");
  const billingNamePaths = [
    "commercial.billingContact.name",
    "billingContact.name",
    "billingContactName",
  ];
  const billingEmailPaths = [
    "commercial.billingContact.email",
    "billingContact.email",
    "billingContactEmail",
  ];
  const billingNameErrors = messagesFor(fieldErrors, ...billingNamePaths);
  const billingEmailErrors = messagesFor(fieldErrors, ...billingEmailPaths);
  const billingAggregateErrors = [
    ...new Set(
      Object.entries(fieldErrors)
        .filter(
          ([field]) =>
            (field === "commercial.billingContact" ||
              field.startsWith("commercial.billingContact.") ||
              field === "billingContact" ||
              field.startsWith("billingContact.")) &&
            !billingNamePaths.includes(field) &&
            !billingEmailPaths.includes(field),
        )
        .map(([, message]) => message),
    ),
  ];
  const billingHasErrors = Boolean(
    billingNameErrors.length ||
      billingEmailErrors.length ||
      billingAggregateErrors.length,
  );
  const billingAggregateErrorId = billingAggregateErrors.length
    ? "partner-book-billing-error"
    : undefined;
  const referenceSummary =
    [
      value.projectReference.trim()
        ? `Project: ${value.projectReference.trim()}`
        : "",
      value.costCenter.trim() ? `Cost center: ${value.costCenter.trim()}` : "",
    ]
      .filter(Boolean)
      .join(" · ") || "Add internal references";
  const contactSummary =
    [value.billingContactName.trim(), value.billingContactEmail.trim()]
      .filter(Boolean)
      .join(" · ") || "Add a contact for billing questions";

  return (
    <div className="space-y-4">
      <ErrorMessages
        id="partner-book-commercial-error"
        messages={commercialErrors}
      />
      <div className="space-y-2">
        <BillingField
          id="partner-book-po"
          label="Work order / PO number"
          value={value.poNumber}
          onChange={(next) => onChange("poNumber", next)}
          maxLength={500}
          errors={poErrors}
        />
        {!poErrors.length && !commercialErrors.length ? (
          <p className="text-xs leading-5 text-slate-500">
            If needed, add your company’s work order or purchase order number.
          </p>
        ) : null}
      </div>

      <BillingDetailsRow
        id="partner-book-commercial-references"
        title="Project and cost center"
        summary={referenceSummary}
        hasErrors={Boolean(projectErrors.length || costCenterErrors.length)}
        fieldErrors={fieldErrors}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <BillingField
            id="partner-book-project"
            label="Project or property reference"
            value={value.projectReference}
            onChange={(next) => onChange("projectReference", next)}
            maxLength={500}
            errors={projectErrors}
          />
          <BillingField
            id="partner-book-cost-center"
            label="Cost center"
            value={value.costCenter}
            onChange={(next) => onChange("costCenter", next)}
            maxLength={500}
            errors={costCenterErrors}
          />
        </div>
      </BillingDetailsRow>

      <BillingDetailsRow
        id="partner-book-billing-contact"
        title="Billing contact"
        summary={contactSummary}
        hasErrors={billingHasErrors}
        fieldErrors={fieldErrors}
      >
        <p className="text-xs leading-5 text-slate-600">
          For billing questions about this job. Add both a name and email.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <BillingField
            id="partner-book-billing-name"
            label="Name"
            autoComplete="section-billing name"
            value={value.billingContactName}
            onChange={(next) => onChange("billingContactName", next)}
            maxLength={200}
            errors={billingNameErrors}
            aggregateErrorId={billingAggregateErrorId}
          />
          <BillingField
            id="partner-book-billing-email"
            label="Email"
            type="email"
            autoComplete="section-billing email"
            value={value.billingContactEmail}
            onChange={(next) => onChange("billingContactEmail", next)}
            maxLength={320}
            errors={billingEmailErrors}
            aggregateErrorId={billingAggregateErrorId}
          />
        </div>
        <ErrorMessages
          id="partner-book-billing-error"
          messages={billingAggregateErrors}
        />
      </BillingDetailsRow>
    </div>
  );
}
