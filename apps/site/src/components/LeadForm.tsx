'use client';

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { availabilityWindows } from "@myst-os/pricing";
import { Button, cn } from "@myst-os/ui";
import { DEFAULT_LEAD_SERVICE_OPTIONS, type LeadServiceOption } from "@/lib/lead-services";
import { useUTM } from "../lib/use-utm";

interface LeadFormProps extends React.HTMLAttributes<HTMLDivElement> {
  services?: LeadServiceOption[];
}

type IdleState = { status: "idle" | "submitting" };
type ErrorState = { status: "error"; message: string };
type SuccessState = {
  status: "success";
  message: string;
  appointmentId: string | null;
  rescheduleToken: string | null;
  startAtIso: string | null;
  preferredDate: string | null;
  timeWindow: string | null;
  durationMinutes: number | null;
  services: string[];
};

type FormState = IdleState | ErrorState | SuccessState;

const INITIAL_STATE: FormState = { status: "idle" };

const APPOINTMENT_TIME_ZONE =
  process.env["NEXT_PUBLIC_APPOINTMENT_TIMEZONE"] ?? "America/New_York";

export function LeadForm({ services, className, ...props }: LeadFormProps) {
  const serviceOptions = services?.length ? services : DEFAULT_LEAD_SERVICE_OPTIONS;
  const utm = useUTM();
  const searchParams = useSearchParams();
  const [formState, setFormState] = React.useState<FormState>(INITIAL_STATE);
  const [selectedServices, setSelectedServices] = React.useState<string[]>([]);
  const [preferredDate, setPreferredDate] = React.useState<string>("");
  const [timeWindow, setTimeWindow] = React.useState<string>("");
  const [localError, setLocalError] = React.useState<string | null>(null);
  const [step, setStep] = React.useState<1 | 2>(1);
  const [isRescheduleOpen, setIsRescheduleOpen] = React.useState(false);
  const [rescheduleDate, setRescheduleDate] = React.useState<string>("");
  const [rescheduleWindow, setRescheduleWindow] = React.useState<string>("");
  const [rescheduleStatus, setRescheduleStatus] =
    React.useState<"idle" | "submitting" | "success" | "error">("idle");
  const [rescheduleFeedback, setRescheduleFeedback] = React.useState<string | null>(null);
  const [initialTokenHandled, setInitialTokenHandled] = React.useState(false);
  const formRef = React.useRef<HTMLFormElement>(null);
  const apiBase = process.env["NEXT_PUBLIC_API_BASE_URL"]?.replace(/\/$/, "");
  const submitUrl = `${apiBase ?? ""}/api/web/lead-intake`;
  const serviceLabelMap = React.useMemo(
    () => new Map(serviceOptions.map((service) => [service.slug, service.title])),
    [serviceOptions]
  );
  const availabilityMap = React.useMemo(
    () => new Map(availabilityWindows.map((window) => [window.id, window])),
    []
  );
  const timeFormatter = React.useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", {
        dateStyle: "full",
        timeStyle: "short",
        timeZone: APPOINTMENT_TIME_ZONE
      }),
    []
  );
  const dateFormatter = React.useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", {
        dateStyle: "full",
        timeZone: APPOINTMENT_TIME_ZONE
      }),
    []
  );
  const appointmentTimeZoneLabel = React.useMemo(
    () => (APPOINTMENT_TIME_ZONE.includes("_") ? APPOINTMENT_TIME_ZONE.replace("_", " ") : APPOINTMENT_TIME_ZONE),
    []
  );
  const buildConfirmationMessage = React.useCallback(
    ({
      startAtIso,
      preferredDateValue,
      timeWindowValue
    }: {
      startAtIso: string | null;
      preferredDateValue: string | null;
      timeWindowValue: string | null;
    }): string => {
      const windowLabel = timeWindowValue
        ? availabilityMap.get(timeWindowValue)?.label ?? timeWindowValue
        : null;

      if (startAtIso) {
        const arrivalText = timeFormatter.format(new Date(startAtIso));
        return `Crew arrival is locked for ${arrivalText} (${appointmentTimeZoneLabel}). You'll get prep tips plus reminders 24h and 2h before we roll up.`;
      }

      if (preferredDateValue) {
        const parsed = new Date(`${preferredDateValue}T00:00:00`);
        const dateText = dateFormatter.format(parsed);
        const windowText = windowLabel ? ` during the ${windowLabel} window` : "";
        return `We penciled you in for ${dateText}${windowText}. We'll text shortly with exact arrival details (${appointmentTimeZoneLabel}).`;
      }

      if (windowLabel) {
        return `We're locking in the ${windowLabel} window (${appointmentTimeZoneLabel}) and will confirm by text shortly.`;
      }

      return "Our dispatcher is reviewing your request now. Expect a confirmation text shortly with the best arrival window for your property.";
    },
    [availabilityMap, dateFormatter, timeFormatter, appointmentTimeZoneLabel]
  );
  const serviceTitles = React.useMemo(() => {
    if (formState.status !== "success") {
      return [] as string[];
    }
    return formState.services.map((slug) => serviceLabelMap.get(slug) ?? slug);
  }, [formState, serviceLabelMap]);
  const appointmentDisplay = React.useMemo(() => {
    if (formState.status !== "success") {
      return null as string | null;
    }
    if (formState.startAtIso) {
      const date = new Date(formState.startAtIso);
      return timeFormatter.format(date);
    }
    if (formState.preferredDate) {
      const parsed = new Date(`${formState.preferredDate}T00:00:00`);
      const dateText = dateFormatter.format(parsed);
      if (formState.timeWindow) {
        const window = availabilityMap.get(formState.timeWindow);
        const label = window?.label ?? formState.timeWindow;
        return `${dateText} (${label})`;
      }
      return dateText;
    }
    return null;
  }, [formState, availabilityMap, timeFormatter, dateFormatter]);
  React.useEffect(() => {
    if (initialTokenHandled) {
      return;
    }

    const appointmentIdParam = searchParams?.get("appointmentId");
    const tokenParam = searchParams?.get("token");

    if (appointmentIdParam && tokenParam && formState.status === "idle") {
      setFormState({
        status: "success",
        message: "Let's pick a new time for your on-site estimate.",
        appointmentId: appointmentIdParam,
        rescheduleToken: tokenParam,
        startAtIso: null,
        preferredDate: null,
        timeWindow: null,
        durationMinutes: null,
        services: []
      });
      setIsRescheduleOpen(true);
      setRescheduleStatus("idle");
      setRescheduleFeedback(null);
      setRescheduleDate("");
      setRescheduleWindow("");
      setInitialTokenHandled(true);
    }
  }, [searchParams, formState.status, initialTokenHandled]);

  const toggleService = (slug: string) => {
    setSelectedServices((prev) =>
      prev.includes(slug) ? prev.filter((item) => item !== slug) : [...prev, slug]
    );
  };

  const focusField = (name: string) => {
    const field = formRef.current?.elements.namedItem(name);
    if (!field) {
      return;
    }

    if ("item" in field && typeof field.item === "function") {
      const node = field.item(0);
      if (node instanceof HTMLElement) {
        node.scrollIntoView({ behavior: "smooth", block: "center" });
        node.focus();
      }
      return;
    }

    if (field instanceof HTMLElement) {
      field.scrollIntoView({ behavior: "smooth", block: "center" });
      field.focus();
    }
  };

  const resetForm = () => {
    setFormState({ status: "idle" });
    setSelectedServices([]);
    setPreferredDate("");
    setTimeWindow("");
    setLocalError(null);
    setStep(1);
    setIsRescheduleOpen(false);
    setRescheduleDate("");
    setRescheduleWindow("");
    setRescheduleStatus("idle");
    setRescheduleFeedback(null);
    setInitialTokenHandled(true);
    formRef.current?.reset();
  };

  const goToStepTwo = () => {
    if (!formRef.current) {
      setStep(2);
      return;
    }

    if (!selectedServices.length) {
      setLocalError("Select at least one service to continue.");
      focusField("selectedServices");
      return;
    }

    const formData = new FormData(formRef.current);
    const requiredFields: Array<{ key: string; label: string }> = [
      { key: "addressLine1", label: "service address" },
      { key: "city", label: "city" },
      { key: "state", label: "state" },
      { key: "postalCode", label: "ZIP" }
    ];

    for (const field of requiredFields) {
      const value = formData.get(field.key);
      if (typeof value !== "string" || value.trim().length === 0) {
        setLocalError(`Enter your ${field.label}.`);
        focusField(field.key);
        return;
      }
    }

    setLocalError(null);
    setStep(2);
    requestAnimationFrame(() => focusField("name"));
  };

  const handleBackToStepOne = () => {
    setStep(1);
    setLocalError(null);
    requestAnimationFrame(() => focusField("selectedServices"));
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (formState.status === "submitting") {
      return;
    }

    setLocalError(null);
    const form = event.currentTarget;
    const formData = new FormData(form);

    const consentChecked = formData.get("consent") === "on";
    if (!selectedServices.length) {
      setLocalError("Select at least one service for your in-person estimate.");
      setStep(1);
      focusField("selectedServices");
      return;
    }
    if (!preferredDate) {
      setLocalError("Choose a preferred visit date.");
      setStep(2);
      focusField("preferredDate");
      return;
    }
    if (!timeWindow) {
      setLocalError("Pick a time window that works for you.");
      setStep(2);
      focusField("timeWindow");
      return;
    }
    if (!consentChecked) {
      setLocalError("Please approve appointment updates and tips so we can reach you.");
      setStep(2);
      focusField("consent");
      return;
    }

    const getValue = (key: string): string => {
      const value = formData.get(key);
      return typeof value === "string" ? value.trim() : "";
    };

    const getOptionalValue = (key: string): string | undefined => {
      const value = formData.get(key);
      const trimmed = typeof value === "string" ? value.trim() : "";
      return trimmed.length > 0 ? trimmed : undefined;
    };

    const utmRaw = formData.get("utm");
    let utmPayload: Record<string, unknown> = {};
    if (typeof utmRaw === "string" && utmRaw.trim().length > 0) {
      try {
        const parsed = JSON.parse(utmRaw) as unknown;
        if (parsed && typeof parsed === "object") {
          utmPayload = parsed as Record<string, unknown>;
        }
      } catch {
        // ignore malformed payload
      }
    }

    setFormState({ status: "submitting" });
    const servicesSnapshot = [...selectedServices];

    const payload = {
      appointmentType: "in_person_estimate" as const,
      services: selectedServices,
      name: getValue("name"),
      phone: getValue("phone"),
      email: getOptionalValue("email"),
      addressLine1: getValue("addressLine1"),
      city: getValue("city"),
      state: getValue("state"),
      postalCode: getValue("postalCode"),
      notes: getOptionalValue("notes"),
      consent: consentChecked,
      scheduling: {
        preferredDate,
        timeWindow,
        alternateDate: getOptionalValue("alternateDate")
      },
      utm: utmPayload,
      gclid: getOptionalValue("gclid"),
      fbclid: getOptionalValue("fbclid"),
      hp_company: getOptionalValue("company")
    };

    try {
      const response = await fetch(submitUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      const result = (await response.json().catch(() => null)) as
        | {
            ok?: boolean;
            appointmentId?: string | null;
            rescheduleToken?: string | null;
            startAt?: string | null;
            durationMinutes?: number | null;
            preferredDate?: string | null;
            timeWindow?: string | null;
          }
        | null;

      if (!response.ok || !result?.ok) {
        throw new Error("Submission failed");
      }

      const preferredDateValue = result.preferredDate ?? preferredDate ?? "";
      const timeWindowValue = result.timeWindow ?? timeWindow ?? "";

      const successMessage = buildConfirmationMessage({
        startAtIso: result.startAt ?? null,
        preferredDateValue: preferredDateValue || null,
        timeWindowValue: timeWindowValue || null
      });
      setFormState({
        status: "success",
        message: successMessage,
        appointmentId: result.appointmentId ?? null,
        rescheduleToken: result.rescheduleToken ?? null,
        startAtIso: result.startAt ?? null,
        preferredDate: preferredDateValue || null,
        timeWindow: timeWindowValue || null,
        durationMinutes: result.durationMinutes ?? null,
        services: servicesSnapshot
      });
      setRescheduleDate(preferredDateValue);
      setRescheduleWindow(timeWindowValue);
      setRescheduleStatus("idle");
      setRescheduleFeedback(null);
      setIsRescheduleOpen(false);
      setInitialTokenHandled(true);
      form.reset();
      setSelectedServices([]);
      setPreferredDate("");
      setTimeWindow("");
    } catch (error) {
      console.error(error);
      setFormState({
        status: "error",
        message:
          "We couldn&apos;t schedule your estimate. Please call or text and we&apos;ll assist right away."
      });
    }
  };

  const handleRescheduleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      formState.status !== "success" ||
      !formState.appointmentId ||
      !formState.rescheduleToken
    ) {
      return;
    }

    if (!rescheduleDate) {
      setRescheduleStatus("error");
      setRescheduleFeedback("Pick a new visit date to reschedule your estimate.");
      return;
    }

    if (!rescheduleWindow) {
      setRescheduleStatus("error");
      setRescheduleFeedback("Select a preferred time window to reschedule.");
      return;
    }

    setRescheduleStatus("submitting");
    setRescheduleFeedback(null);

    try {
      const response = await fetch(
        `${apiBase ?? ""}/api/web/appointments/${formState.appointmentId}/reschedule`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            preferredDate: rescheduleDate,
            timeWindow: rescheduleWindow,
            rescheduleToken: formState.rescheduleToken
          })
        }
      );

      const result = (await response.json().catch(() => null)) as
        | {
            ok?: boolean;
            startAt?: string | null;
            preferredDate?: string | null;
            timeWindow?: string | null;
            durationMinutes?: number | null;
            rescheduleToken?: string | null;
          }
        | null;

      if (!response.ok || !result?.ok) {
        throw new Error("reschedule_failed");
      }

      const updatedStartAtIso = result.startAt ?? formState.startAtIso ?? null;
      const updatedPreferred = (result.preferredDate ?? rescheduleDate) || formState.preferredDate || null;
      const updatedWindow = (result.timeWindow ?? rescheduleWindow) || formState.timeWindow || null;
      const updatedMessage = buildConfirmationMessage({
        startAtIso: updatedStartAtIso,
        preferredDateValue: updatedPreferred,
        timeWindowValue: updatedWindow
      });

      setRescheduleStatus("success");
      setRescheduleFeedback("Appointment updated. We'll send refreshed reminders before arrival.");
      setFormState((previous) => {
        if (previous.status !== "success") {
          return previous;
        }

        return {
          ...previous,
          message: updatedMessage,
          startAtIso: updatedStartAtIso,
          preferredDate: updatedPreferred,
          timeWindow: updatedWindow,
          durationMinutes: result.durationMinutes ?? previous.durationMinutes,
          rescheduleToken: result.rescheduleToken ?? previous.rescheduleToken
        } satisfies SuccessState;
      });
      setIsRescheduleOpen(false);
    } catch (error) {
      console.error(error);
      setRescheduleStatus("error");
      setRescheduleFeedback(
        "We couldn't reschedule right now. Please call or text and we'll adjust manually."
      );
    }
  };

  if (formState.status === "success") {
    return (
      <div
        className={cn(
          "rounded-xl bg-white p-8 shadow-float shadow-primary-900/10",
          className
        )}
        {...props}
      >
        <h3 className="font-display text-headline text-primary-800">
          You&apos;re on our in-person schedule!
        </h3>
        <div className="mt-3 space-y-2 text-neutral-600">
          <p className="text-body">
            {appointmentDisplay
              ? `We'll see you ${appointmentDisplay}.`
              : "We'll call to confirm a time that works best for you."}
          </p>
          <p className="text-sm text-neutral-600">{formState.message}</p>
          {appointmentDisplay ? (
            <p className="text-xs text-neutral-500">Times shown in {appointmentTimeZoneLabel}.</p>
          ) : null}
        </div>
        {serviceTitles.length ? (
          <div className="mt-6">
            <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-neutral-500">
              Services to review
            </h4>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-neutral-600">
              {serviceTitles.map((title) => (
                <li key={title}>{title}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {rescheduleFeedback ? (
          <div
            role="status"
            className={cn(
              "mt-6 rounded-md border px-4 py-3 text-sm",
              rescheduleStatus === "error"
                ? "border-danger-200 bg-danger-50 text-danger-700"
                : "border-accent-200 bg-accent-50 text-accent-700"
            )}
          >
            {rescheduleFeedback}
          </div>
        ) : null}
        {isRescheduleOpen ? (
          <form
            onSubmit={(event) => void handleRescheduleSubmit(event)}
            className="mt-6 space-y-5 rounded-lg border border-neutral-200 bg-neutral-50/60 p-4"
          >
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label htmlFor="rescheduleDate" className="text-sm font-medium text-neutral-700">
                  New visit date
                </label>
                <input
                  id="rescheduleDate"
                  name="rescheduleDate"
                  type="date"
                  required
                  value={rescheduleDate}
                  onChange={(event) => setRescheduleDate(event.target.value)}
                  className="mt-2 w-full rounded-md border border-neutral-300/60 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
                />
              </div>
              <div>
                <span className="text-sm font-medium text-neutral-700">Preferred time window</span>
                <div className="mt-2 grid gap-2 sm:grid-cols-3">
                  {availabilityWindows.map((window) => (
                    <label
                      key={window.id}
                      htmlFor={`rescheduleWindow-${window.id}`}
                      className={cn(
                        "relative flex cursor-pointer flex-col gap-1 rounded-lg border p-3 text-xs transition",
                        rescheduleWindow === window.id
                          ? "border-accent-500 bg-accent-50/80 shadow-soft"
                          : "border-neutral-200 bg-white hover:border-neutral-300"
                      )}
                    >
                      <input
                        type="radio"
                        id={`rescheduleWindow-${window.id}`}
                        name="rescheduleWindow"
                        value={window.id}
                        checked={rescheduleWindow === window.id}
                        onChange={(event) => setRescheduleWindow(event.target.value)}
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                        required
                        aria-label={window.label}
                      />
                      <span className="font-semibold text-neutral-700 pointer-events-none">{window.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={rescheduleStatus === "submitting"}>
                {rescheduleStatus === "submitting" ? "Saving..." : "Confirm new time"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setIsRescheduleOpen(false);
                  setRescheduleStatus("idle");
                  setRescheduleFeedback(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div className="mt-6 flex flex-wrap gap-3">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setIsRescheduleOpen(true);
                setRescheduleStatus("idle");
                setRescheduleFeedback(null);
                setRescheduleDate(formState.preferredDate ?? "");
                setRescheduleWindow(formState.timeWindow ?? "");
              }}
              disabled={!formState.appointmentId || !formState.rescheduleToken}
            >
              Reschedule
            </Button>
            <Button type="button" onClick={resetForm}>
              Schedule another estimate
            </Button>
          </div>
        )}
        <p className="mt-6 text-xs text-neutral-500">
          Need faster help? Call{" "}
          <a href="tel:16785417725" className="text-accent-600 underline">
            (678) 541-7725
          </a>{" "}
          and mention your estimate request.
        </p>
      </div>
    );
  }

  const stepDescription =
    step === 1
      ? "Tell us about the property so we can prep the right crew."
      : "How can we reach you and what arrival window works best?";

  return (
    <div
      className={cn(
        "rounded-xl bg-white p-8 shadow-soft shadow-primary-900/10",
        className
      )}
      {...props}
    >
      <div className="mb-6 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs font-semibold uppercase tracking-[0.14em] text-neutral-500">
          <span className="inline-flex items-center gap-2 rounded-full border border-neutral-200 px-3 py-1 text-neutral-600">
            Step {step} of 2
          </span>
          <span className="text-[0.7rem] font-medium normal-case tracking-normal text-neutral-500">
            Takes &lt; 1 minute. No spam.
          </span>
        </div>
        <h3 className="font-display text-2xl text-primary-800">
          Book your in-person estimate
        </h3>
        <p className="text-sm text-neutral-600">{stepDescription}</p>
      </div>

      {localError ? (
        <div
          role="alert"
          aria-live="assertive"
          className="mb-4 rounded-md border border-danger-200 bg-danger-50 px-4 py-3 text-sm text-danger-700"
        >
          {localError}
        </div>
      ) : null}

      {formState.status === "error" ? (
        <div
          role="alert"
          aria-live="assertive"
          className="mb-4 rounded-md border border-danger-200 bg-danger-50 px-4 py-3 text-sm text-danger-700"
        >
          {formState.message}
        </div>
      ) : null}

      <form ref={formRef} onSubmit={(event) => void handleSubmit(event)} className="space-y-6">
        <section className={cn("space-y-3", step === 1 ? "" : "hidden")}>
          <h4 className="text-sm font-semibold uppercase tracking-[0.14em] text-neutral-500">
            Services to review
          </h4>
          <div className="grid gap-3 md:grid-cols-2">
            {serviceOptions.map((service) => {
              const isSelected = selectedServices.includes(service.slug);
              return (
                <label
                  key={service.slug}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition",
                    isSelected
                      ? "border-accent-500 bg-accent-50/80 shadow-soft"
                      : "border-neutral-200 bg-white hover:border-neutral-300"
                  )}
                >
                  <input
                    type="checkbox"
                    name="selectedServices"
                    value={service.slug}
                    checked={isSelected}
                    onChange={() => toggleService(service.slug)}
                    className="mt-1 h-4 w-4 accent-accent-500"
                  />
                  <div className="space-y-1">
                    <p className="font-medium text-neutral-800">{service.title}</p>
                    {service.description ? (
                      <p className="text-sm text-neutral-600">{service.description}</p>
                    ) : null}
                  </div>
                </label>
              );
            })}
          </div>
        </section>

        <section className={cn("grid gap-4 md:grid-cols-2", step === 2 ? "" : "hidden")}>
          <div>
            <label htmlFor="name" className="text-sm font-medium text-neutral-700">
              Full name
            </label>
            <input
              id="name"
              name="name"
              type="text"
              required
              placeholder="Jamie Customer"
              className="mt-2 w-full rounded-md border border-neutral-300/60 bg-white px-3 py-2 text-body text-neutral-700 outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
            />
          </div>
          <div>
            <label htmlFor="email" className="text-sm font-medium text-neutral-700">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              placeholder="you@email.com"
              className="mt-2 w-full rounded-md border border-neutral-300/60 bg-white px-3 py-2 text-body text-neutral-700 outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
            />
          </div>
          <div>
            <label htmlFor="phone" className="text-sm font-medium text-neutral-700">
              Mobile phone
            </label>
            <input
              id="phone"
              name="phone"
              type="tel"
              required
              placeholder="(678) 541-7725"
              className="mt-2 w-full rounded-md border border-neutral-300/60 bg-white px-3 py-2 text-body text-neutral-700 outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
            />
          </div>
        </section>

        <section className={cn("space-y-4", step === 1 ? "" : "hidden")}>
          <div>
            <label htmlFor="addressLine1" className="text-sm font-medium text-neutral-700">
              Service address
            </label>
            <input
              id="addressLine1"
              name="addressLine1"
              type="text"
              required
              placeholder="Street address"
              className="mt-2 w-full rounded-md border border-neutral-300/60 bg-white px-3 py-2 text-body text-neutral-700 outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
            />
          </div>
          <div className="grid gap-4 md:grid-cols-[2fr_1fr_1fr]">
            <div>
              <label htmlFor="city" className="text-sm font-medium text-neutral-700">
                City
              </label>
              <input
                id="city"
                name="city"
                type="text"
                required
                placeholder="Woodstock"
                className="mt-2 w-full rounded-md border border-neutral-300/60 bg-white px-3 py-2 text-body text-neutral-700 outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
              />
            </div>
            <div>
              <label htmlFor="state" className="text-sm font-medium text-neutral-700">
                State
              </label>
              <input
                id="state"
                name="state"
                type="text"
                required
                maxLength={2}
                placeholder="GA"
                className="mt-2 w-full rounded-md border border-neutral-300/60 bg-white px-3 py-2 text-body text-neutral-700 uppercase outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
              />
            </div>
            <div>
              <label htmlFor="postalCode" className="text-sm font-medium text-neutral-700">
                ZIP
              </label>
              <input
                id="postalCode"
                name="postalCode"
                type="text"
                required
                placeholder="30189"
                className="mt-2 w-full rounded-md border border-neutral-300/60 bg-white px-3 py-2 text-body text-neutral-700 outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
              />
            </div>
          </div>
        </section>

        <section className={cn("grid gap-4 md:grid-cols-2", step === 2 ? "" : "hidden")}>
          <div>
            <label htmlFor="preferredDate" className="text-sm font-medium text-neutral-700">
              Preferred visit date
            </label>
            <input
              id="preferredDate"
              name="preferredDate"
              type="date"
              required
              value={preferredDate}
              onChange={(event) => setPreferredDate(event.target.value)}
              className="mt-2 w-full rounded-md border border-neutral-300/60 bg-white px-3 py-2 text-body text-neutral-700 outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
            />
          </div>
          <div>
            <label htmlFor="alternateDate" className="text-sm font-medium text-neutral-700">
              Alternate date (optional)
            </label>
            <input
              id="alternateDate"
              name="alternateDate"
              type="date"
              className="mt-2 w-full rounded-md border border-neutral-300/60 bg-white px-3 py-2 text-body text-neutral-700 outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
            />
          </div>
        </section>

        <section className={cn("space-y-3", step === 2 ? "" : "hidden")}>
          <span className="text-sm font-medium text-neutral-700">Preferred time window</span>
          <div className="grid gap-3 sm:grid-cols-3">
            {availabilityWindows.map((window) => (
              <label
                key={window.id}
                htmlFor={`timeWindow-${window.id}`}
                className={cn(
                  "relative flex cursor-pointer flex-col gap-1 rounded-lg border p-4 text-sm transition",
                  timeWindow === window.id
                    ? "border-accent-500 bg-accent-50/80 shadow-soft"
                    : "border-neutral-200 bg-white hover:border-neutral-300"
                )}
              >
                <input
                  type="radio"
                  id={`timeWindow-${window.id}`}
                  name="timeWindow"
                  value={window.id}
                  checked={timeWindow === window.id}
                  onChange={(event) => setTimeWindow(event.target.value)}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  required
                  aria-label={window.label}
                />
                <span className="text-sm font-semibold text-neutral-700 pointer-events-none">{window.label}</span>
                <span className="text-xs text-neutral-500 pointer-events-none">
                  Crews arrive within this window; we&apos;ll send an SMS when we&apos;re on the way.
                </span>
              </label>
            ))}
          </div>
        </section>

        <section className={cn("space-y-3", step === 2 ? "" : "hidden")}>
          <label htmlFor="notes" className="text-sm font-medium text-neutral-700">
            Notes for the crew (gate codes, surfaces, pets)
          </label>
          <textarea
            id="notes"
            name="notes"
            rows={4}
            placeholder="Deck square footage, stains to tackle, parking notes, etc."
            className="mt-2 w-full rounded-md border border-neutral-300/60 bg-white px-3 py-2 text-body text-neutral-700 outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
          />
        </section>

        <div className={cn("flex items-start gap-3 rounded-md bg-neutral-100/60 p-4", step === 2 ? "" : "hidden")}>
          <input
            id="consent"
            name="consent"
            type="checkbox"
            className="mt-1 h-4 w-4 accent-accent-500"
          />
          <label htmlFor="consent" className="text-sm text-neutral-600">
            I agree to receive appointment updates and service tips from Stonegate. Text messaging rates may
            apply. Reply STOP to opt out anytime.
          </label>
        </div>

        <input type="hidden" name="utm" value={JSON.stringify(utm)} />
        <input type="hidden" name="gclid" value={utm.gclid ?? ""} />
        <input type="hidden" name="fbclid" value={utm.fbclid ?? ""} />
        <input type="text" name="company" className="hidden" tabIndex={-1} autoComplete="off" />

        {step === 1 ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Button
              type="button"
              variant="primary"
              onClick={goToStepTwo}
              className="w-full justify-center sm:w-auto"
            >
              Next: Contact &amp; time
            </Button>
            <p className="text-center text-xs text-neutral-500 sm:text-left">
              We&apos;ll ask for scheduling details on the next step.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
              <Button
                type="submit"
                variant="primary"
                disabled={formState.status === "submitting"}
                className="w-full justify-center sm:w-auto"
              >
                {formState.status === "submitting" ? "Scheduling..." : "Book in-person estimate"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={handleBackToStepOne}
                className="w-full justify-center sm:w-auto"
              >
                Back
              </Button>
            </div>
            <p className="text-center text-xs text-neutral-500 sm:text-right">
              We confirm instantly and send text updates.
            </p>
          </div>
        )}
      </form>
    </div>
  );
}


