"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  CircleHelp,
  Clock3,
  LoaderCircle,
  MailCheck,
  Save,
  Send,
  ShieldCheck,
  Sparkles,
  X,
  XCircle,
} from "lucide-react";
import { cn } from "@myst-os/ui";
import type {
  PartnerCompanyResolutionChoice,
  PartnerOnboardingApplication,
  PartnerOnboardingApplicationPayload,
  PartnerOnboardingRequirements,
  PartnerPersona,
  PartnerRequestedNeed,
} from "../lib/onboarding";
import {
  onboardingOperationKey,
  parsePartnerOnboardingApplicationResponse,
  PARTNER_REQUESTED_NEEDS,
  partnerOnboardingFetch,
} from "../lib/onboarding";
import { getPartnerPersonaPresentation } from "../lib/persona-presentation";
import {
  PartnerNotice,
  partnerFieldClass,
  partnerPrimaryButtonClass,
  partnerSecondaryButtonClass,
} from "./PartnerPortalUi";

const NEED_LABELS: Record<PartnerRequestedNeed, string> = {
  schedule_jobs: "Schedule pickups and jobs",
  manage_locations: "Manage multiple locations",
  photos_and_proof: "Upload photos and receive completion proof",
  invoices_and_documents: "Access invoices and documents",
  reporting: "Review account reporting",
  recurring_service: "Coordinate recurring service",
};

type FormState = {
  name: string;
  phone: string;
  companyName: string;
  website: string;
  partnerType: PartnerPersona | "";
  serviceAreas: string;
  requestedNeeds: PartnerRequestedNeed[];
  companyResolutionChoice: PartnerCompanyResolutionChoice;
  termsAccepted: boolean;
  privacyAccepted: boolean;
};

type BusyAction = "save" | "submit" | "respond" | "withdraw" | "resend";

function initialState(application: PartnerOnboardingApplication): FormState {
  const companyResolutionChoice =
    application.companyResolution.choice === "join_existing" &&
    !application.companyResolution.accountLabel
      ? "manual_review"
      : application.companyResolution.choice;
  return {
    name: application.name,
    phone: application.phone ?? "",
    companyName: application.companyName,
    website: application.website ?? "",
    partnerType: application.partnerType ?? "",
    serviceAreas: application.serviceAreas.join(", "),
    requestedNeeds: application.requestedNeeds,
    companyResolutionChoice,
    termsAccepted: false,
    privacyAccepted: false,
  };
}

function serviceAreaList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,]/u)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ].slice(0, 20);
}

function payloadFromState(
  state: FormState,
  application: PartnerOnboardingApplication,
): PartnerOnboardingApplicationPayload | null {
  if (!state.partnerType) return null;
  return {
    name: state.name.trim(),
    phone: state.phone.trim() || null,
    companyName: state.companyName.trim(),
    website: state.website.trim() || null,
    partnerType: state.partnerType,
    serviceAreas: serviceAreaList(state.serviceAreas),
    requestedNeeds: state.requestedNeeds,
    companyResolutionChoice: state.companyResolutionChoice,
    companyCandidateId:
      state.companyResolutionChoice === "join_existing"
        ? application.companyResolution.candidateId
        : null,
  };
}

function patchFromState(
  state: FormState,
  application: PartnerOnboardingApplication,
): Partial<PartnerOnboardingApplicationPayload> {
  const name = state.name.trim();
  const companyName = state.companyName.trim();
  return {
    ...(name ? { name } : {}),
    phone: state.phone.trim() || null,
    ...(companyName ? { companyName } : {}),
    website: state.website.trim() || null,
    ...(state.partnerType ? { partnerType: state.partnerType } : {}),
    serviceAreas: serviceAreaList(state.serviceAreas),
    requestedNeeds: state.requestedNeeds,
    companyResolutionChoice: state.companyResolutionChoice,
    companyCandidateId:
      state.companyResolutionChoice === "join_existing"
        ? application.companyResolution.candidateId
        : null,
  };
}

function validate(
  state: FormState,
  mode: "save" | "submit" | "respond",
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (mode !== "save") {
    if (state.name.trim().length < 2) errors["name"] = "Enter your full name.";
    if (state.companyName.trim().length < 2) {
      errors["companyName"] = "Enter your company name.";
    }
    if (!state.partnerType) errors["partnerType"] = "Choose a partner type.";
  } else {
    if (state.name.trim() && state.name.trim().length < 2) {
      errors["name"] = "Enter at least two characters, or leave this blank.";
    }
    if (state.companyName.trim() && state.companyName.trim().length < 2) {
      errors["companyName"] =
        "Enter at least two characters, or leave this blank.";
    }
  }
  if (state.phone.trim() && state.phone.trim().length < 7) {
    errors["phone"] = "Enter a complete phone number, or leave this blank.";
  }
  if (state.website.trim()) {
    try {
      const parsed = new URL(state.website.trim());
      if (!/^https?:$/u.test(parsed.protocol)) throw new Error("scheme");
    } catch {
      errors["website"] =
        "Enter a complete website URL beginning with https://.";
    }
  }
  if (mode === "submit" && !state.termsAccepted) {
    errors["termsAccepted"] = "Accept the current terms and service agreement.";
  }
  if (mode === "submit" && !state.privacyAccepted) {
    errors["privacyAccepted"] = "Acknowledge the current privacy policy.";
  }
  return errors;
}

function statusCopy(application: PartnerOnboardingApplication): {
  icon: typeof Clock3;
  title: string;
  body: string;
  tone: string;
} {
  switch (application.status) {
    case "submitted":
      return {
        icon: CheckCircle2,
        title: "Application submitted",
        body: "Stonegate has your verified application. We’ll email you when review begins or if more information is needed.",
        tone: "bg-emerald-50 text-emerald-800 ring-emerald-200",
      };
    case "under_review":
      return {
        icon: Clock3,
        title: "Application under review",
        body: "Stonegate is reviewing the correct company and access path. No portal membership has been created yet.",
        tone: "bg-sky-50 text-sky-800 ring-sky-200",
      };
    case "approved_pending_activation":
      return {
        icon: ShieldCheck,
        title: "Approved—activation required",
        body: "Your access was approved. Use the activation email to create your password before signing in.",
        tone: "bg-emerald-50 text-emerald-800 ring-emerald-200",
      };
    case "approved":
      return {
        icon: ShieldCheck,
        title: "Application approved",
        body: "Use the activation email to create your password. If you already activated, sign in to open your company workspace.",
        tone: "bg-emerald-50 text-emerald-800 ring-emerald-200",
      };
    case "declined":
      return {
        icon: XCircle,
        title: "Application closed",
        body: "Stonegate could not approve this request. Contact the team if your company details or access needs have changed.",
        tone: "bg-slate-100 text-slate-700 ring-slate-200",
      };
    case "withdrawn":
      return {
        icon: XCircle,
        title: "Application withdrawn",
        body: "This request is closed and no portal access was created.",
        tone: "bg-slate-100 text-slate-700 ring-slate-200",
      };
    default:
      return {
        icon: CircleHelp,
        title: "Application needs information",
        body: "Review Stonegate’s request below, update your application if needed, and send a response.",
        tone: "bg-amber-50 text-amber-900 ring-amber-200",
      };
  }
}

function PartnerApplicationPersonaGuidance({
  persona,
  mode,
  onDismiss,
}: {
  persona: PartnerPersona | "" | null;
  mode: "application" | "confirmation";
  onDismiss: () => void;
}) {
  const presentation = getPartnerPersonaPresentation(persona);
  const headingId = `partner-application-persona-${mode}-heading`;
  return (
    <aside
      aria-labelledby={headingId}
      className="mt-5 rounded-2xl border border-primary-100 bg-primary-50/70 p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <p className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-primary-700">
            <Sparkles className="h-4 w-4" aria-hidden="true" />
            Presentation tailored for {presentation.label}
          </p>
          <h2 id={headingId} className="mt-2 font-semibold text-slate-950">
            {mode === "confirmation"
              ? presentation.onboarding.confirmationTitle
              : `Plan your ${presentation.label.toLowerCase()} workspace`}
          </h2>
          <p className="mt-1 text-sm leading-6 text-slate-700">
            {mode === "confirmation"
              ? presentation.onboarding.confirmationBody
              : presentation.onboarding.checklistLead}
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className={cn(partnerSecondaryButtonClass, "min-h-11 px-3")}
          aria-label="Dismiss persona onboarding suggestions"
        >
          <X className="h-4 w-4" aria-hidden="true" />
          Dismiss
        </button>
      </div>
      <ul className="mt-3 grid gap-2 text-sm leading-5 text-slate-700 sm:grid-cols-3">
        {presentation.onboarding.nextActions.map((action) => (
          <li
            key={action}
            className="rounded-xl border border-white bg-white p-3"
          >
            {action}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs leading-5 text-slate-600">
        Suggestions do not select requested features, create access, or change
        the information you entered.
      </p>
    </aside>
  );
}

export function PartnerApplicationWorkspace({
  initialApplication,
  requirements,
  justVerified,
}: {
  initialApplication: PartnerOnboardingApplication;
  requirements: PartnerOnboardingRequirements;
  justVerified: boolean;
}) {
  const [application, setApplication] = React.useState(initialApplication);
  const [form, setForm] = React.useState(() =>
    initialState(initialApplication),
  );
  const [responseText, setResponseText] = React.useState("");
  const [busy, setBusy] = React.useState<BusyAction | null>(null);
  const [notice, setNotice] = React.useState<{
    tone: "error" | "success" | "warning";
    text: string;
  } | null>(
    justVerified
      ? {
          tone: "success",
          text: "Email verified. Complete the application below; no company workspace or membership exists until approval.",
        }
      : null,
  );
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>(
    {},
  );
  const [showPersonaGuidance, setShowPersonaGuidance] = React.useState(true);
  const errorSummaryRef = React.useRef<HTMLDivElement>(null);

  const editable =
    application.status === "draft" ||
    application.status === "needs_information";
  const status = statusCopy(application);

  function update<K extends keyof FormState>(
    key: K,
    value: FormState[K],
  ): void {
    if (key === "partnerType" && value !== form.partnerType) {
      setShowPersonaGuidance(true);
    }
    setForm((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function applyApplicationResponse(
    data: unknown,
    etag: string | null,
  ): boolean {
    const record =
      typeof data === "object" && data !== null
        ? (data as Record<string, unknown>)
        : {};
    const parsed = parsePartnerOnboardingApplicationResponse(
      record["requirements"] ? record : { ...record, requirements },
      etag,
    );
    if (!parsed) return false;
    setApplication(parsed.application);
    setForm(initialState(parsed.application));
    return true;
  }

  async function saveOrSubmit(action: "save" | "submit"): Promise<void> {
    const errors = validate(form, action);
    if (Object.keys(errors).length) {
      setFieldErrors(errors);
      setNotice({
        tone: "error",
        text: "Review the highlighted fields before continuing.",
      });
      requestAnimationFrame(() => errorSummaryRef.current?.focus());
      return;
    }
    const submissionPayload = payloadFromState(form, application);
    if (action === "submit" && !submissionPayload) return;
    setBusy(action);
    setNotice(null);
    const result = await partnerOnboardingFetch<Record<string, unknown>>(
      action === "save" ? "application" : "application/submit",
      {
        method: action === "save" ? "PATCH" : "POST",
        headers: {
          "If-Match": application.etag,
          ...(action === "submit"
            ? {
                "Idempotency-Key": onboardingOperationKey(
                  "partner-application-submit",
                ),
              }
            : {}),
        },
        body: JSON.stringify(
          action === "submit"
            ? {
                ...submissionPayload,
                termsAccepted: true,
                termsVersion: requirements.termsVersion,
                privacyAccepted: true,
                privacyVersion: requirements.privacyVersion,
              }
            : patchFromState(form, application),
        ),
      },
    ).catch(() => null);
    setBusy(null);
    if (!result?.ok) {
      const serverErrors = result?.error.fieldErrors ?? {};
      setFieldErrors(serverErrors);
      setNotice({
        tone:
          result?.response.status === 409 || result?.response.status === 412
            ? "warning"
            : "error",
        text:
          result?.response.status === 412
            ? "Your application changed in another tab. Refresh before continuing."
            : (result?.error.message ?? "We couldn’t save your application."),
      });
      if (Object.keys(serverErrors).length) {
        requestAnimationFrame(() => errorSummaryRef.current?.focus());
      }
      return;
    }
    if (
      !applyApplicationResponse(
        result.data,
        result.response.headers.get("etag"),
      )
    ) {
      setNotice({
        tone: "warning",
        text: "The application was saved, but the updated status could not be displayed. Refresh this page.",
      });
      return;
    }
    setNotice({
      tone: "success",
      text:
        action === "save"
          ? "Draft saved. You can safely return using a new verification link."
          : "Application submitted. Stonegate will review the correct company and access path.",
    });
    setFieldErrors({});
  }

  async function statusMutation(
    action: "respond" | "withdraw" | "resend",
  ): Promise<void> {
    if (action === "respond" && responseText.trim().length < 2) {
      setFieldErrors({
        response: "Enter the information Stonegate requested.",
      });
      requestAnimationFrame(() => errorSummaryRef.current?.focus());
      return;
    }
    if (action === "respond") {
      const errors = validate(form, "respond");
      if (Object.keys(errors).length) {
        setFieldErrors(errors);
        setNotice({
          tone: "error",
          text: "Review the highlighted fields before sending your response.",
        });
        requestAnimationFrame(() => errorSummaryRef.current?.focus());
        return;
      }
    }
    setBusy(action);
    setNotice(null);
    const responsePayload = payloadFromState(form, application);
    const result = await partnerOnboardingFetch<Record<string, unknown>>(
      action === "resend" ? "activation/resend" : `application/${action}`,
      {
        method: "POST",
        headers: {
          "If-Match": application.etag,
          "Idempotency-Key": onboardingOperationKey(
            `partner-application-${action}`,
          ),
        },
        body: JSON.stringify(
          action === "respond"
            ? { ...responsePayload, response: responseText.trim() }
            : action === "resend"
              ? { email: application.email }
              : {},
        ),
      },
    ).catch(() => null);
    setBusy(null);
    if (!result?.ok) {
      setNotice({
        tone:
          result?.response.status === 409 || result?.response.status === 412
            ? "warning"
            : "error",
        text: result?.error.message ?? "We couldn’t complete that action.",
      });
      return;
    }
    if (action === "resend") {
      setNotice({
        tone: "success",
        text: "If activation is still pending, a new email will arrive shortly. Only the newest link will work.",
      });
      return;
    }
    applyApplicationResponse(result.data, result.response.headers.get("etag"));
    setResponseText("");
    setNotice({
      tone: "success",
      text:
        action === "respond"
          ? "Your response was sent for review."
          : "Application withdrawn. No portal access was created.",
    });
  }

  if (!editable) {
    const Icon = status.icon;
    return (
      <div className="mx-auto w-full max-w-3xl">
        <section
          className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/60 sm:p-10"
          aria-labelledby="application-status-heading"
        >
          <div
            className={cn(
              "flex h-14 w-14 items-center justify-center rounded-2xl ring-1",
              status.tone,
            )}
          >
            <Icon className="h-7 w-7" aria-hidden="true" />
          </div>
          <p className="mt-6 text-xs font-semibold uppercase tracking-[0.16em] text-primary-700">
            Partner access
          </p>
          <h1
            id="application-status-heading"
            className="mt-2 text-3xl font-semibold tracking-tight text-slate-950"
          >
            {status.title}
          </h1>
          <p className="mt-4 text-sm leading-6 text-slate-600 sm:text-base">
            {status.body}
          </p>
          <dl className="mt-7 grid gap-4 rounded-2xl bg-slate-50 p-5 text-sm sm:grid-cols-2">
            <div>
              <dt className="font-semibold text-slate-700">Verified email</dt>
              <dd className="mt-1 break-all text-slate-600">
                {application.email}
              </dd>
            </div>
            <div>
              <dt className="font-semibold text-slate-700">Company</dt>
              <dd className="mt-1 text-slate-600">
                {application.companyName || "Not supplied"}
              </dd>
            </div>
          </dl>
          {showPersonaGuidance ? (
            <PartnerApplicationPersonaGuidance
              persona={application.partnerType}
              mode="confirmation"
              onDismiss={() => setShowPersonaGuidance(false)}
            />
          ) : null}
          {notice ? (
            <PartnerNotice tone={notice.tone} className="mt-5">
              {notice.text}
            </PartnerNotice>
          ) : null}
          <div className="mt-7 flex flex-wrap gap-3">
            {["approved_pending_activation", "approved"].includes(
              application.status,
            ) ? (
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void statusMutation("resend")}
                className={partnerPrimaryButtonClass}
              >
                {busy === "resend" ? (
                  <LoaderCircle
                    className="h-4 w-4 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : (
                  <MailCheck className="h-4 w-4" aria-hidden="true" />
                )}
                {busy === "resend" ? "Sending…" : "Resend activation email"}
              </button>
            ) : null}
            {application.status === "approved" ? (
              <Link
                href="/partners/login"
                className={partnerSecondaryButtonClass}
              >
                Already activated? Sign in
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            ) : null}
            {["submitted", "under_review"].includes(application.status) ? (
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void statusMutation("withdraw")}
                className={partnerSecondaryButtonClass}
              >
                {busy === "withdraw" ? "Withdrawing…" : "Withdraw application"}
              </button>
            ) : null}
            <Link href="/partners" className={partnerSecondaryButtonClass}>
              Partner Portal information
            </Link>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl">
      <header className="mb-6">
        <ol
          className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500"
          aria-label="Application progress"
        >
          <li className="text-emerald-700">1. Email verified</li>
          <li aria-hidden="true">/</li>
          <li aria-current="step" className="text-primary-800">
            2. Company application
          </li>
          <li aria-hidden="true">/</li>
          <li>3. Staff review</li>
        </ol>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
          Complete your partner application
        </h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600 sm:text-base">
          Tell us how your company works so Stonegate can approve the correct
          workspace and role. Your draft is private and creates no portal
          membership.
        </p>
      </header>

      {application.status === "needs_information" &&
      application.informationRequest ? (
        <PartnerNotice tone="warning" className="mb-5">
          <div>
            <strong>Stonegate needs more information</strong>
            <p className="mt-1">{application.informationRequest}</p>
          </div>
        </PartnerNotice>
      ) : null}
      {notice ? (
        <PartnerNotice tone={notice.tone} className="mb-5">
          {notice.text}
        </PartnerNotice>
      ) : null}
      {Object.keys(fieldErrors).length ? (
        <div
          ref={errorSummaryRef}
          tabIndex={-1}
          role="alert"
          className="mb-5 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900 focus:outline-none focus:ring-2 focus:ring-rose-500"
        >
          <p className="font-semibold">Review these fields:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {Object.entries(fieldErrors).map(([field, error]) => (
              <li key={field}>
                <a
                  href={`#application-${field}`}
                  className="inline-flex min-h-11 items-center underline underline-offset-2"
                >
                  {error}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void saveOrSubmit("submit");
        }}
        className="space-y-5"
        data-partner-analytics="partner_application"
      >
        <section
          className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"
          aria-labelledby="application-contact-heading"
        >
          <h2
            id="application-contact-heading"
            className="text-lg font-semibold text-slate-950"
          >
            Your contact
          </h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label htmlFor="application-email">
              <span className="text-sm font-semibold text-slate-700">
                Verified work email
              </span>
              <input
                id="application-email"
                value={application.email}
                readOnly
                aria-readonly="true"
                className={cn(partnerFieldClass, "bg-slate-50 text-slate-600")}
              />
            </label>
            <label htmlFor="application-name">
              <span className="text-sm font-semibold text-slate-700">
                Full name
              </span>
              <input
                id="application-name"
                required
                minLength={2}
                maxLength={120}
                autoComplete="name"
                value={form.name}
                onChange={(event) => update("name", event.target.value)}
                aria-invalid={Boolean(fieldErrors["name"])}
                aria-describedby={
                  fieldErrors["name"] ? "application-name-error" : undefined
                }
                className={partnerFieldClass}
              />
              {fieldErrors["name"] ? (
                <span
                  id="application-name-error"
                  className="mt-1 block text-xs text-rose-700"
                >
                  {fieldErrors["name"]}
                </span>
              ) : null}
            </label>
            <label htmlFor="application-phone">
              <span className="text-sm font-semibold text-slate-700">
                Mobile phone{" "}
                <span className="font-normal text-slate-500">(optional)</span>
              </span>
              <input
                id="application-phone"
                type="tel"
                maxLength={32}
                autoComplete="tel"
                inputMode="tel"
                value={form.phone}
                onChange={(event) => update("phone", event.target.value)}
                aria-invalid={Boolean(fieldErrors["phone"])}
                aria-describedby={
                  fieldErrors["phone"] ? "application-phone-error" : undefined
                }
                className={partnerFieldClass}
              />
              {fieldErrors["phone"] ? (
                <span
                  id="application-phone-error"
                  className="mt-1 block text-xs text-rose-700"
                >
                  {fieldErrors["phone"]}
                </span>
              ) : null}
            </label>
          </div>
        </section>

        <section
          className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"
          aria-labelledby="application-company-heading"
        >
          <h2
            id="application-company-heading"
            className="text-lg font-semibold text-slate-950"
          >
            Company
          </h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label htmlFor="application-companyName">
              <span className="text-sm font-semibold text-slate-700">
                Company name
              </span>
              <input
                id="application-companyName"
                required
                minLength={2}
                maxLength={160}
                autoComplete="organization"
                value={form.companyName}
                onChange={(event) => update("companyName", event.target.value)}
                aria-invalid={Boolean(fieldErrors["companyName"])}
                aria-describedby={
                  fieldErrors["companyName"]
                    ? "application-companyName-error"
                    : undefined
                }
                className={partnerFieldClass}
              />
              {fieldErrors["companyName"] ? (
                <span
                  id="application-companyName-error"
                  className="mt-1 block text-xs text-rose-700"
                >
                  {fieldErrors["companyName"]}
                </span>
              ) : null}
            </label>
            <label htmlFor="application-website">
              <span className="text-sm font-semibold text-slate-700">
                Website{" "}
                <span className="font-normal text-slate-500">(optional)</span>
              </span>
              <input
                id="application-website"
                type="url"
                maxLength={500}
                autoComplete="url"
                inputMode="url"
                placeholder="https://example.com"
                value={form.website}
                onChange={(event) => update("website", event.target.value)}
                aria-invalid={Boolean(fieldErrors["website"])}
                aria-describedby={
                  fieldErrors["website"]
                    ? "application-website-error"
                    : undefined
                }
                className={partnerFieldClass}
              />
              {fieldErrors["website"] ? (
                <span
                  id="application-website-error"
                  className="mt-1 block text-xs text-rose-700"
                >
                  {fieldErrors["website"]}
                </span>
              ) : null}
            </label>
            <label className="sm:col-span-2" htmlFor="application-partnerType">
              <span className="text-sm font-semibold text-slate-700">
                Partner type
              </span>
              <select
                id="application-partnerType"
                required
                value={form.partnerType}
                onChange={(event) =>
                  update(
                    "partnerType",
                    event.target.value as PartnerPersona | "",
                  )
                }
                aria-invalid={Boolean(fieldErrors["partnerType"])}
                aria-describedby={
                  fieldErrors["partnerType"]
                    ? "application-partnerType-error"
                    : undefined
                }
                className={partnerFieldClass}
              >
                <option value="">Choose the closest match</option>
                {requirements.partnerTypes.map((persona) => (
                  <option key={persona} value={persona}>
                    {getPartnerPersonaPresentation(persona).label}
                  </option>
                ))}
              </select>
              {fieldErrors["partnerType"] ? (
                <span
                  id="application-partnerType-error"
                  className="mt-1 block text-xs text-rose-700"
                >
                  {fieldErrors["partnerType"]}
                </span>
              ) : null}
            </label>
            <label className="sm:col-span-2" htmlFor="application-serviceAreas">
              <span className="text-sm font-semibold text-slate-700">
                Primary service areas{" "}
                <span className="font-normal text-slate-500">(optional)</span>
              </span>
              <textarea
                id="application-serviceAreas"
                rows={3}
                maxLength={2_000}
                value={form.serviceAreas}
                onChange={(event) => update("serviceAreas", event.target.value)}
                className={partnerFieldClass}
                placeholder="Cities, ZIP codes, counties, or portfolio areas—separated by commas"
              />
            </label>
          </div>
          {form.partnerType && showPersonaGuidance ? (
            <PartnerApplicationPersonaGuidance
              persona={form.partnerType}
              mode="application"
              onDismiss={() => setShowPersonaGuidance(false)}
            />
          ) : null}
        </section>

        <section
          className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"
          aria-labelledby="application-needs-heading"
        >
          <h2
            id="application-needs-heading"
            className="text-lg font-semibold text-slate-950"
          >
            What should the portal help with?
          </h2>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {PARTNER_REQUESTED_NEEDS.map((need) => (
              <label
                key={need}
                className="flex min-h-11 items-start gap-3 rounded-xl border border-slate-200 px-3 py-3 text-sm text-slate-700"
              >
                <input
                  type="checkbox"
                  checked={form.requestedNeeds.includes(need)}
                  onChange={(event) =>
                    update(
                      "requestedNeeds",
                      event.target.checked
                        ? [...form.requestedNeeds, need]
                        : form.requestedNeeds.filter((value) => value !== need),
                    )
                  }
                  className="mt-0.5 h-5 w-5 rounded border-slate-300 text-primary-700"
                />
                {NEED_LABELS[need]}
              </label>
            ))}
          </div>
        </section>

        <section
          className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"
          aria-labelledby="application-company-path-heading"
        >
          <h2
            id="application-company-path-heading"
            className="text-lg font-semibold text-slate-950"
          >
            Company workspace path
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Stonegate makes the final company match during review. A verified
            email domain alone never creates membership.
          </p>
          <fieldset
            id="application-companyCandidateId"
            className="mt-4 space-y-3"
          >
            <legend className="sr-only">
              Requested company workspace path
            </legend>
            {application.companyResolution.accountLabel ? (
              <label className="flex items-start gap-3 rounded-xl border border-slate-200 p-4 text-sm">
                <input
                  type="radio"
                  name="company-resolution"
                  value="join_existing"
                  checked={form.companyResolutionChoice === "join_existing"}
                  onChange={() =>
                    update("companyResolutionChoice", "join_existing")
                  }
                  className="mt-0.5 h-5 w-5"
                />
                <span>
                  <span className="block font-semibold text-slate-900">
                    Request to join {application.companyResolution.accountLabel}
                  </span>
                  <span className="mt-1 block text-slate-600">
                    Stonegate will verify the company and approve the correct
                    role.
                  </span>
                </span>
              </label>
            ) : null}
            <label className="flex items-start gap-3 rounded-xl border border-slate-200 p-4 text-sm">
              <input
                type="radio"
                name="company-resolution"
                value="create_new"
                checked={form.companyResolutionChoice === "create_new"}
                onChange={() => update("companyResolutionChoice", "create_new")}
                className="mt-0.5 h-5 w-5"
              />
              <span>
                <span className="block font-semibold text-slate-900">
                  Create a company workspace if approved
                </span>
                <span className="mt-1 block text-slate-600">
                  Choose this when your company does not already use the portal.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-3 rounded-xl border border-slate-200 p-4 text-sm">
              <input
                type="radio"
                name="company-resolution"
                value="manual_review"
                checked={form.companyResolutionChoice === "manual_review"}
                onChange={() =>
                  update("companyResolutionChoice", "manual_review")
                }
                className="mt-0.5 h-5 w-5"
              />
              <span>
                <span className="block font-semibold text-slate-900">
                  I’m not sure—have Stonegate review it
                </span>
                <span className="mt-1 block text-slate-600">
                  Use this if the suggested company is unfamiliar or your
                  organization has multiple divisions.
                </span>
              </span>
            </label>
          </fieldset>
          {fieldErrors["companyCandidateId"] ? (
            <p className="mt-2 text-xs text-rose-700">
              {fieldErrors["companyCandidateId"]}
            </p>
          ) : null}
        </section>

        {application.status === "needs_information" ? (
          <section
            className="rounded-2xl border border-amber-200 bg-amber-50 p-5 sm:p-6"
            aria-labelledby="application-response-heading"
          >
            <h2
              id="application-response-heading"
              className="text-lg font-semibold text-amber-950"
            >
              Response for Stonegate
            </h2>
            <label htmlFor="application-response" className="mt-4 block">
              <span className="text-sm font-semibold text-amber-950">
                Additional information
              </span>
              <textarea
                id="application-response"
                rows={4}
                maxLength={2_000}
                value={responseText}
                onChange={(event) => {
                  setResponseText(event.target.value);
                  setFieldErrors((current) => {
                    const next = { ...current };
                    delete next["response"];
                    return next;
                  });
                }}
                aria-invalid={Boolean(fieldErrors["response"])}
                aria-describedby={
                  fieldErrors["response"]
                    ? "application-response-error"
                    : undefined
                }
                className={partnerFieldClass}
              />
              {fieldErrors["response"] ? (
                <span
                  id="application-response-error"
                  className="mt-1 block text-xs text-rose-700"
                >
                  {fieldErrors["response"]}
                </span>
              ) : null}
            </label>
            <div className="mt-4 flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void statusMutation("respond")}
                className={partnerPrimaryButtonClass}
              >
                {busy === "respond" ? (
                  <LoaderCircle
                    className="h-4 w-4 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : (
                  <Send className="h-4 w-4" aria-hidden="true" />
                )}
                {busy === "respond" ? "Sending response…" : "Send response"}
              </button>
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void statusMutation("withdraw")}
                className={partnerSecondaryButtonClass}
              >
                {busy === "withdraw" ? "Withdrawing…" : "Withdraw application"}
              </button>
            </div>
          </section>
        ) : (
          <section
            className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"
            aria-labelledby="application-agreements-heading"
          >
            <h2
              id="application-agreements-heading"
              className="text-lg font-semibold text-slate-950"
            >
              Agreements
            </h2>
            <div className="mt-4 space-y-3">
              <div className="flex items-start gap-3 text-sm leading-6 text-slate-700">
                <input
                  id="application-termsAccepted"
                  type="checkbox"
                  checked={form.termsAccepted}
                  onChange={(event) =>
                    update("termsAccepted", event.target.checked)
                  }
                  aria-invalid={Boolean(fieldErrors["termsAccepted"])}
                  aria-describedby={
                    fieldErrors["termsAccepted"]
                      ? "application-termsAccepted-error"
                      : undefined
                  }
                  className="mt-0.5 h-5 w-5 shrink-0 rounded border-slate-300 text-primary-700"
                />
                <div>
                  <label
                    htmlFor="application-termsAccepted"
                    className="font-medium text-slate-800"
                  >
                    I agree to the current Terms and Service Agreement.
                  </label>
                  <p className="mt-1 flex flex-wrap gap-x-3">
                    <Link
                      href="/terms"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-h-11 items-center font-semibold text-primary-800 underline"
                    >
                      Review Terms (new tab)
                    </Link>
                    <Link
                      href="/service-agreement"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-h-11 items-center font-semibold text-primary-800 underline"
                    >
                      Review Service Agreement (new tab)
                    </Link>
                  </p>
                </div>
              </div>
              {fieldErrors["termsAccepted"] ? (
                <span
                  id="application-termsAccepted-error"
                  className="block text-xs text-rose-700"
                >
                  {fieldErrors["termsAccepted"]}
                </span>
              ) : null}
              <div className="flex items-start gap-3 text-sm leading-6 text-slate-700">
                <input
                  id="application-privacyAccepted"
                  type="checkbox"
                  checked={form.privacyAccepted}
                  onChange={(event) =>
                    update("privacyAccepted", event.target.checked)
                  }
                  aria-invalid={Boolean(fieldErrors["privacyAccepted"])}
                  aria-describedby={
                    fieldErrors["privacyAccepted"]
                      ? "application-privacyAccepted-error"
                      : undefined
                  }
                  className="mt-0.5 h-5 w-5 shrink-0 rounded border-slate-300 text-primary-700"
                />
                <div>
                  <label
                    htmlFor="application-privacyAccepted"
                    className="font-medium text-slate-800"
                  >
                    I acknowledge the current Privacy Policy and consent to
                    account-related contact.
                  </label>
                  <p className="mt-1">
                    <Link
                      href="/privacy"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-h-11 items-center font-semibold text-primary-800 underline"
                    >
                      Review Privacy Policy (new tab)
                    </Link>
                  </p>
                </div>
              </div>
              {fieldErrors["privacyAccepted"] ? (
                <span
                  id="application-privacyAccepted-error"
                  className="block text-xs text-rose-700"
                >
                  {fieldErrors["privacyAccepted"]}
                </span>
              ) : null}
            </div>
          </section>
        )}

        {application.status === "draft" ? (
          <div className="sticky bottom-3 z-10 flex flex-col-reverse gap-3 rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-lg backdrop-blur sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs leading-5 text-slate-500">
              Your verified draft is account-free until Stonegate approval.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void saveOrSubmit("save")}
                className={partnerSecondaryButtonClass}
              >
                {busy === "save" ? (
                  <LoaderCircle
                    className="h-4 w-4 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : (
                  <Save className="h-4 w-4" aria-hidden="true" />
                )}
                {busy === "save" ? "Saving…" : "Save and finish later"}
              </button>
              <button
                type="submit"
                disabled={Boolean(busy)}
                className={partnerPrimaryButtonClass}
              >
                {busy === "submit" ? (
                  <LoaderCircle
                    className="h-4 w-4 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : (
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                )}
                {busy === "submit" ? "Submitting…" : "Submit for review"}
              </button>
            </div>
          </div>
        ) : null}
      </form>
    </div>
  );
}
