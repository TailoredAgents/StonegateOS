"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  Camera,
  Check,
  CheckCircle2,
  CircleAlert,
  Clock3,
  LoaderCircle,
  MapPin,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Truck,
  UserRound,
  X,
} from "lucide-react";
import { cn } from "@myst-os/ui";
import {
  createPortalOperationKey,
  partnerPortalFetch,
  withPortalSupportReference,
  type PartnerAvailability,
  type PartnerDraft,
  type PartnerHold,
} from "../lib/portal-v2";
import {
  PARTNER_EQUIPMENT_OPTIONS,
  PARTNER_HAZARD_OPTIONS,
  buildPartnerBookingScope,
  clampPartnerAddOnQuantity,
  serializePartnerAddOnQuantities,
} from "../lib/partner-booking-add-ons";
import {
  getPartnerPersonaPresentation,
  type PartnerPersonaProofPreset,
} from "../lib/persona-presentation";
import {
  PARTNER_SCHEDULE_ASSISTANCE_OPTIONS,
  scheduleAssistanceSummary,
  visibleRankedPartnerAlternatives,
} from "../lib/partner-scheduling-assistance";
import {
  flushPartnerFunnelEvents,
  trackPartnerFunnelEvent,
} from "../lib/product-analytics";
import {
  PartnerNotice,
  PartnerPanel,
  partnerFieldClass,
  partnerPrimaryButtonClass,
  partnerSecondaryButtonClass,
} from "./PartnerPortalUi";
import { PartnerDraftPhotoUpload } from "./PartnerDraftPhotoUpload";
import { PartnerInlineLocationForm } from "./PartnerInlineLocationForm";

export type BookingWizardLocation = {
  id: string;
  name: string;
  address: string;
  serviceAreaStatus?: string;
  timezone?: string;
};

export type BookingWizardService = {
  key: string;
  label: string;
  detail?: string;
  pricingStatus?: "contracted" | "review_required" | "hidden";
  bookable: boolean;
  priceState: PartnerServicePriceState;
  agreement: {
    label: string;
    currency: string;
    effectiveFrom: string;
    effectiveTo: string | null;
  } | null;
  inclusions: string[];
  exclusions: string[];
  quoteRule: string | null;
  basePrice?: BookingWizardMoney | null;
  baseOptions?: BookingWizardBaseOption[];
  addOns?: BookingWizardAddOn[];
};

export type BookingWizardBaseOption = {
  tierKey: string;
  label: string;
  priceState: Exclude<PartnerServicePriceState, "quote_required">;
  pricingStatus: "contracted" | "review_required" | "hidden";
  price: BookingWizardMoney | null;
};

export type PartnerServicePriceState =
  | "contracted"
  | "estimate"
  | "quote_required"
  | "standard_rate";

export type BookingWizardMoney = {
  amountMinor: number;
  currency: string;
  minorUnit: number;
};

export type BookingWizardAddOn = {
  key: string;
  label: string;
  detail?: string;
  priceState: Exclude<PartnerServicePriceState, "quote_required">;
  unitLabel: string;
  minimumQuantity: number;
  maximumQuantity: number;
  instantConfirmationMaxQuantity: number | null;
  requiresReview: boolean;
  pricingStatus: "contracted" | "review_required" | "hidden";
  unitPrice: BookingWizardMoney | null;
};

export type BookingWizardCancellationPolicy = {
  minimumNoticeMinutes: number;
  directCancellationEnabled: boolean;
  lateCancellationDisposition: "staff_review";
  automaticFeeMinor: null;
  source: "configured" | "unconfigured" | "launch_default";
  revision: number | null;
};

type WizardForm = {
  locationId: string;
  serviceKey: string;
  tierKey: string;
  addOnQuantities: Record<string, number>;
  description: string;
  itemCount: string;
  volume: string;
  restrictedItems: boolean;
  nonStandard: boolean;
  hazardCategories: string[];
  equipmentNeeds: string[];
  requiredCompletionDate: string;
  requiredCompletionTime: string;
  multiStop: boolean;
  multiStopDetails: string;
  alternateContactName: string;
  alternateContactPhone: string;
  alternateContactEmail: string;
  crewInstructions: string;
  accessDetails: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  proofBefore: boolean;
  proofBeforeCount: number;
  proofAfter: boolean;
  proofAfterCount: number;
  proofPackage: boolean;
  poNumber: string;
  costCenter: string;
  projectReference: string;
  billingContactName: string;
  billingContactEmail: string;
  preferredDateOne: string;
  preferredDateTwo: string;
  preferredDateThree: string;
  preferredTimeOfDay: "morning" | "afternoon" | "anytime";
  preferredTimezone: string;
  scheduleAssistancePreference: "none" | "waitlist" | "callback";
};

const STEPS = [
  { label: "Location", shortLabel: "Location", icon: MapPin },
  { label: "Service & scope", shortLabel: "Scope", icon: Truck },
  { label: "Contact & access", shortLabel: "Access", icon: UserRound },
  { label: "Photos & proof", shortLabel: "Proof", icon: Camera },
  {
    label: "Choose an arrival window",
    shortLabel: "Window",
    icon: CalendarClock,
  },
  { label: "Review & send", shortLabel: "Review", icon: ShieldCheck },
] as const;

const DEFAULT_FORM: WizardForm = {
  locationId: "",
  serviceKey: "",
  tierKey: "",
  addOnQuantities: {},
  description: "",
  itemCount: "",
  volume: "",
  restrictedItems: false,
  nonStandard: false,
  hazardCategories: [],
  equipmentNeeds: [],
  requiredCompletionDate: "",
  requiredCompletionTime: "",
  multiStop: false,
  multiStopDetails: "",
  alternateContactName: "",
  alternateContactPhone: "",
  alternateContactEmail: "",
  crewInstructions: "",
  accessDetails: "",
  contactName: "",
  contactPhone: "",
  contactEmail: "",
  proofBefore: true,
  proofBeforeCount: 1,
  proofAfter: true,
  proofAfterCount: 1,
  proofPackage: false,
  poNumber: "",
  costCenter: "",
  projectReference: "",
  billingContactName: "",
  billingContactEmail: "",
  preferredDateOne: "",
  preferredDateTwo: "",
  preferredDateThree: "",
  preferredTimeOfDay: "anytime",
  preferredTimezone: "America/New_York",
  scheduleAssistancePreference: "none",
};

function recordString(
  record: Record<string, unknown> | null,
  key: string,
): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

function recordStringArray(
  record: Record<string, unknown> | null,
  key: string,
): string[] {
  const value = record?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function formFromDraft(
  draft: PartnerDraft | null,
  defaults: Partial<WizardForm>,
): WizardForm {
  if (!draft) return { ...DEFAULT_FORM, ...defaults };
  const preferredWindows = Array.isArray(draft.preferredWindows)
    ? draft.preferredWindows.filter(
        (window): window is Record<string, unknown> =>
          Boolean(window) &&
          typeof window === "object" &&
          !Array.isArray(window),
      )
    : [];
  const preferredValue = (index: number, key: string): string => {
    const value = preferredWindows[index]?.[key];
    return typeof value === "string" ? value : "";
  };
  const preferredTimeOfDay = preferredValue(0, "timeOfDay");
  const billingContact =
    draft.commercial["billingContact"] &&
    typeof draft.commercial["billingContact"] === "object" &&
    !Array.isArray(draft.commercial["billingContact"])
      ? (draft.commercial["billingContact"] as Record<string, unknown>)
      : null;
  const requiredCompletion =
    draft.scope["requiredCompletion"] &&
    typeof draft.scope["requiredCompletion"] === "object" &&
    !Array.isArray(draft.scope["requiredCompletion"])
      ? (draft.scope["requiredCompletion"] as Record<string, unknown>)
      : null;
  const alternateContact =
    draft.scope["alternateContact"] &&
    typeof draft.scope["alternateContact"] === "object" &&
    !Array.isArray(draft.scope["alternateContact"])
      ? (draft.scope["alternateContact"] as Record<string, unknown>)
      : null;
  return {
    ...DEFAULT_FORM,
    ...defaults,
    locationId: draft.locationId ?? defaults.locationId ?? "",
    serviceKey: draft.serviceKey ?? defaults.serviceKey ?? "",
    tierKey: draft.tierKey ?? defaults.tierKey ?? "",
    addOnQuantities: Object.fromEntries(
      (Array.isArray(draft.selectedAddOns) ? draft.selectedAddOns : []).map(
        (addOn) => [addOn.key, addOn.quantity],
      ),
    ),
    description: draft.description ?? "",
    itemCount:
      typeof draft.scope["itemCount"] === "number"
        ? String(draft.scope["itemCount"])
        : "",
    volume:
      typeof draft.scope["volumeCubicYards"] === "number"
        ? String(draft.scope["volumeCubicYards"])
        : "",
    restrictedItems: draft.scope["restrictedItems"] === true,
    nonStandard: draft.scope["nonStandard"] === true,
    hazardCategories: recordStringArray(draft.scope, "hazardCategories"),
    equipmentNeeds: recordStringArray(draft.scope, "equipmentNeeds"),
    requiredCompletionDate: recordString(requiredCompletion, "localDate"),
    requiredCompletionTime: recordString(requiredCompletion, "localTime"),
    multiStop: draft.scope["multiStop"] === true,
    multiStopDetails: recordString(draft.scope, "multiStopDetails"),
    alternateContactName: recordString(alternateContact, "name"),
    alternateContactPhone: recordString(alternateContact, "phone"),
    alternateContactEmail: recordString(alternateContact, "email"),
    crewInstructions: draft.crewInstructions ?? "",
    accessDetails: draft.accessDetails ?? "",
    contactName: recordString(draft.onSiteContact, "name"),
    contactPhone: recordString(draft.onSiteContact, "phone"),
    contactEmail: recordString(draft.onSiteContact, "email"),
    proofBefore:
      typeof draft.proofRequirements["before"] === "number"
        ? draft.proofRequirements["before"] > 0
        : draft.proofRequirements["before"] !== false,
    proofBeforeCount:
      typeof draft.proofRequirements["before"] === "number" &&
      Number.isSafeInteger(draft.proofRequirements["before"]) &&
      draft.proofRequirements["before"] >= 0 &&
      draft.proofRequirements["before"] <= 40
        ? Math.max(1, draft.proofRequirements["before"])
        : (defaults.proofBeforeCount ?? 1),
    proofAfter:
      typeof draft.proofRequirements["after"] === "number"
        ? draft.proofRequirements["after"] > 0
        : draft.proofRequirements["after"] !== false,
    proofAfterCount:
      typeof draft.proofRequirements["after"] === "number" &&
      Number.isSafeInteger(draft.proofRequirements["after"]) &&
      draft.proofRequirements["after"] >= 0 &&
      draft.proofRequirements["after"] <= 40
        ? Math.max(1, draft.proofRequirements["after"])
        : (defaults.proofAfterCount ?? 1),
    proofPackage: draft.proofRequirements["package"] === true,
    poNumber: recordString(draft.commercial, "poNumber"),
    costCenter: recordString(draft.commercial, "costCenter"),
    projectReference: recordString(draft.commercial, "projectReference"),
    billingContactName: recordString(billingContact, "name"),
    billingContactEmail: recordString(billingContact, "email"),
    preferredDateOne: preferredValue(0, "localDate"),
    preferredDateTwo: preferredValue(1, "localDate"),
    preferredDateThree: preferredValue(2, "localDate"),
    preferredTimeOfDay:
      preferredTimeOfDay === "morning" ||
      preferredTimeOfDay === "afternoon" ||
      preferredTimeOfDay === "anytime"
        ? preferredTimeOfDay
        : "anytime",
    preferredTimezone:
      preferredValue(0, "timezone") ||
      defaults.preferredTimezone ||
      "America/New_York",
    scheduleAssistancePreference: draft.scheduleAssistancePreference,
  };
}

function draftMutation(form: WizardForm) {
  return {
    locationId: form.locationId || null,
    serviceKey: form.serviceKey || null,
    tierKey: form.tierKey || null,
    selectedAddOns: serializePartnerAddOnQuantities(form.addOnQuantities),
    description: form.description || null,
    scope: buildPartnerBookingScope({
      itemCount: form.itemCount,
      volumeCubicYards: form.volume,
      restrictedItems: form.restrictedItems,
      nonStandard: form.nonStandard,
      hazardCategories: form.hazardCategories,
      equipmentNeeds: form.equipmentNeeds,
      requiredCompletionDate: form.requiredCompletionDate,
      requiredCompletionTime: form.requiredCompletionTime,
      multiStop: form.multiStop,
      multiStopDetails: form.multiStopDetails,
      alternateContactName: form.alternateContactName,
      alternateContactPhone: form.alternateContactPhone,
      alternateContactEmail: form.alternateContactEmail,
    }),
    crewInstructions: form.crewInstructions || null,
    accessDetails: form.accessDetails || null,
    onSiteContact:
      form.contactName || form.contactPhone || form.contactEmail
        ? {
            name: form.contactName,
            phone: form.contactPhone || undefined,
            email: form.contactEmail || undefined,
          }
        : null,
    proofRequirements: {
      before: form.proofBefore ? form.proofBeforeCount : 0,
      after: form.proofAfter ? form.proofAfterCount : 0,
      package: form.proofPackage,
    },
    commercial: {
      ...(form.poNumber ? { poNumber: form.poNumber } : {}),
      ...(form.costCenter ? { costCenter: form.costCenter } : {}),
      ...(form.projectReference
        ? { projectReference: form.projectReference }
        : {}),
      ...(form.billingContactName || form.billingContactEmail
        ? {
            billingContact: {
              name: form.billingContactName,
              email: form.billingContactEmail,
            },
          }
        : {}),
    },
    preferredWindows: [
      form.preferredDateOne,
      form.preferredDateTwo,
      form.preferredDateThree,
    ]
      .filter(Boolean)
      .map((localDate) => ({
        localDate,
        timeOfDay: form.preferredTimeOfDay,
        timezone: form.preferredTimezone,
      })),
    scheduleAssistancePreference: form.scheduleAssistancePreference,
  };
}

function formatDate(value: string, timezone: string): string {
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(date);
}

function formatTime(value: string, timezone: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function preferredDateBoundary(
  timezone: string,
  daysFromToday: number,
): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  const localNoon = new Date(
    Date.UTC(
      value("year"),
      value("month") - 1,
      value("day") + daysFromToday,
      12,
    ),
  );
  return localNoon.toISOString().slice(0, 10);
}

function formatMoney(value: BookingWizardMoney): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: value.currency || "USD",
  }).format(value.amountMinor / 10 ** value.minorUnit);
}

function priceStateLabel(state: PartnerServicePriceState): string {
  switch (state) {
    case "contracted":
      return "Contracted final price";
    case "estimate":
      return "Account estimate";
    case "standard_rate":
      return "Standard account rate";
    case "quote_required":
      return "Quote required";
  }
}

function humanizePriceState(
  state: PartnerAvailability["pricing"]["status"],
): string {
  switch (state) {
    case "estimate":
      return "an estimate";
    case "standard_rate":
      return "a standard account rate";
    case "review_required":
      return "subject to review";
    case "quote_required":
      return "subject to a quote";
    case "contracted":
      return "contracted";
    case "hidden":
      return "not shown for this role";
  }
}

function formatCancellationNotice(minutes: number): string {
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${minutes} minutes`;
}

function fieldStep(field: string): number {
  if (field.startsWith("location")) return 0;
  if (
    field.startsWith("service") ||
    field.startsWith("scope") ||
    field === "description"
  )
    return 1;
  if (
    field.startsWith("onSite") ||
    field === "contactMethod" ||
    field.includes("Contact") ||
    field.includes("access")
  )
    return 2;
  if (field.startsWith("proof")) return 3;
  if (field.startsWith("preferred")) return 4;
  return 1;
}

function fieldElementId(field: string): string {
  if (field.startsWith("location")) return "partner-book-location";
  if (field.startsWith("service")) return "partner-book-service";
  if (field.startsWith("tier")) return "partner-book-base-option";
  if (field.startsWith("billing")) return "partner-book-billing-name";
  if (field === "description" || field.startsWith("scope"))
    return "partner-book-description";
  if (field.startsWith("onSite")) return "partner-book-contact-name";
  if (field === "contactMethod") return "partner-book-contact-phone";
  if (field.includes("Contact")) return "partner-book-contact-name";
  if (field.includes("access")) return "partner-book-access";
  if (field.startsWith("preferred")) return "partner-book-preferred-date-1";
  return "partner-book-description";
}

function localErrorsForStep(
  step: number,
  form: WizardForm,
  service?: BookingWizardService,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (step === 0 && !form.locationId)
    errors["locationId"] = "Choose a service location.";
  if (step === 1) {
    if (!form.serviceKey) errors["serviceKey"] = "Choose a service.";
    else if (service && !service.bookable) {
      errors["serviceKey"] =
        "This account service is not currently configured for a booking request.";
    }
    if ((service?.baseOptions?.length ?? 0) > 0 && !form.tierKey) {
      errors["tierKey"] = "Choose a base service option.";
    }
    if (!form.description.trim())
      errors["description"] = "Describe the work to be completed.";
    if (
      Boolean(form.billingContactName.trim()) !==
      Boolean(form.billingContactEmail.trim())
    ) {
      errors["billingContact"] =
        "Add both the billing contact name and email, or leave both blank.";
    } else if (
      form.billingContactEmail.trim() &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(form.billingContactEmail.trim())
    ) {
      errors["billingContact"] = "Enter a valid billing contact email.";
    }
  }
  if (step === 2) {
    if (!form.contactName.trim())
      errors["onSiteContact"] = "Add the on-site contact’s name.";
    if (!form.contactPhone.trim() && !form.contactEmail.trim()) {
      errors["contactMethod"] =
        "Add a phone number or email for the on-site contact.";
    }
  }
  return errors;
}

export function PartnerBookingWizard({
  locations,
  services,
  initialDraft = null,
  defaultLocationId = "",
  defaultServiceKey = "",
  canUploadPhotos = false,
  canManageLocations = false,
  defaultProofRequirements = { before: 1, after: 1 },
  cancellationPolicy,
  persona,
  supportPhoneE164,
  supportPhoneDisplay,
}: {
  locations: BookingWizardLocation[];
  services: BookingWizardService[];
  initialDraft?: PartnerDraft | null;
  defaultLocationId?: string;
  defaultServiceKey?: string;
  canUploadPhotos?: boolean;
  canManageLocations?: boolean;
  defaultProofRequirements?: { before: number; after: number };
  cancellationPolicy: BookingWizardCancellationPolicy;
  persona: string | null;
  supportPhoneE164: string;
  supportPhoneDisplay: string;
}) {
  const router = useRouter();
  const personaPresentation = getPartnerPersonaPresentation(persona);
  const [form, setForm] = React.useState<WizardForm>(() =>
    formFromDraft(initialDraft, {
      locationId: defaultLocationId,
      preferredTimezone:
        locations.find(
          (location) =>
            location.id === (initialDraft?.locationId || defaultLocationId),
        )?.timezone ?? "America/New_York",
      serviceKey: defaultServiceKey || services[0]?.key || "",
      proofBefore: defaultProofRequirements.before > 0,
      proofBeforeCount: Math.max(1, defaultProofRequirements.before),
      proofAfter: defaultProofRequirements.after > 0,
      proofAfterCount: Math.max(1, defaultProofRequirements.after),
      tierKey:
        services.find(
          (service) =>
            service.key === (defaultServiceKey || services[0]?.key || ""),
        )?.baseOptions?.length === 1
          ? services.find(
              (service) =>
                service.key === (defaultServiceKey || services[0]?.key || ""),
            )?.baseOptions?.[0]?.tierKey
          : "",
    }),
  );
  const [draft, setDraft] = React.useState<PartnerDraft | null>(initialDraft);
  const [step, setStep] = React.useState(0);
  const [furthestStep, setFurthestStep] = React.useState(0);
  const [saveStatus, setSaveStatus] = React.useState<
    "creating" | "saving" | "saved" | "error"
  >(initialDraft ? "saved" : "creating");
  const [message, setMessage] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>(
    {},
  );
  const [availability, setAvailability] =
    React.useState<PartnerAvailability | null>(null);
  const [availabilityLoading, setAvailabilityLoading] = React.useState(false);
  const [hold, setHold] = React.useState<PartnerHold | null>(null);
  const [holdSeconds, setHoldSeconds] = React.useState(0);
  const [submitting, setSubmitting] = React.useState(false);
  const [advancing, setAdvancing] = React.useState(false);
  const [draftPhotoCount, setDraftPhotoCount] = React.useState(0);
  const [showPersonaSuggestions, setShowPersonaSuggestions] =
    React.useState(true);
  const [personaFeedback, setPersonaFeedback] = React.useState<string | null>(
    null,
  );
  const [availableLocations, setAvailableLocations] =
    React.useState<BookingWizardLocation[]>(locations);
  const draftRef = React.useRef<PartnerDraft | null>(initialDraft);
  const holdRef = React.useRef<PartnerHold | null>(null);
  const submittedRef = React.useRef(false);
  const stepRef = React.useRef(step);
  stepRef.current = step;
  const funnelStartedRef = React.useRef(false);
  const abandonmentReportedRef = React.useRef(false);
  const abandonmentTimerRef = React.useRef<number | null>(null);
  const advancingRef = React.useRef(false);
  const submitOperationKeyRef = React.useRef(
    createPortalOperationKey("booking-submit"),
  );
  const saveQueueRef = React.useRef<Promise<unknown>>(Promise.resolve());
  const autosaveTimeoutRef = React.useRef<number | null>(null);
  const initialFormRef = React.useRef(form);

  React.useEffect(() => {
    setShowPersonaSuggestions(true);
    setPersonaFeedback(null);
  }, [personaPresentation.key]);

  React.useEffect(() => {
    if (abandonmentTimerRef.current !== null) {
      window.clearTimeout(abandonmentTimerRef.current);
      abandonmentTimerRef.current = null;
    }
    if (!funnelStartedRef.current) {
      funnelStartedRef.current = true;
      trackPartnerFunnelEvent({
        stage: "booking_started",
        persona,
        surface: "booking",
        step: 1,
      });
    }
    const reportAbandonment = (): void => {
      if (submittedRef.current || abandonmentReportedRef.current) return;
      abandonmentReportedRef.current = true;
      trackPartnerFunnelEvent({
        stage: "booking_abandoned",
        persona,
        surface: "booking",
        step: stepRef.current + 1,
      });
    };
    const onPageHide = (): void => {
      reportAbandonment();
      flushPartnerFunnelEvents();
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      abandonmentTimerRef.current = window.setTimeout(reportAbandonment, 0);
    };
  }, [persona]);

  const setCurrentDraft = React.useCallback((value: PartnerDraft) => {
    draftRef.current = value;
    setDraft(value);
  }, []);

  React.useEffect(() => {
    if (initialDraft) return;
    let active = true;
    const createDraft = async (): Promise<void> => {
      setSaveStatus("creating");
      const result = await partnerPortalFetch<{
        ok: true;
        draft: PartnerDraft;
      }>("booking-drafts", {
        method: "POST",
        headers: {
          "Idempotency-Key": createPortalOperationKey("booking-draft"),
        },
        body: JSON.stringify(draftMutation(initialFormRef.current)),
      }).catch(() => null);
      if (!active) return;
      if (!result?.ok) {
        setSaveStatus("error");
        setMessage(
          result?.error.message ??
            "We couldn’t start a secure booking draft. Try again or contact Stonegate.",
        );
        return;
      }
      setCurrentDraft(result.data.draft);
      const savedUrl = new URL(window.location.href);
      savedUrl.searchParams.set("draftId", result.data.draft.id);
      window.history.replaceState(window.history.state, "", savedUrl);
      setSaveStatus("saved");
    };
    void createDraft();
    return () => {
      active = false;
    };
  }, [initialDraft, setCurrentDraft]);

  const persist = React.useCallback(
    (snapshot: WizardForm): Promise<boolean> => {
      const task = saveQueueRef.current.then(async () => {
        const current = draftRef.current;
        if (!current) return false;
        setSaveStatus("saving");
        const result = await partnerPortalFetch<{
          ok: true;
          draft: PartnerDraft;
        }>(`booking-drafts/${current.id}`, {
          method: "PATCH",
          headers: { "If-Match": current.etag },
          body: JSON.stringify(draftMutation(snapshot)),
        }).catch(() => null);
        if (!result?.ok) {
          setSaveStatus("error");
          setMessage(
            result?.error.message ??
              "Your latest changes are still on this screen, but they could not be saved.",
          );
          if (result?.error.fieldErrors)
            setFieldErrors(result.error.fieldErrors);
          return false;
        }
        setCurrentDraft(result.data.draft);
        setSaveStatus("saved");
        setMessage(null);
        return true;
      });
      saveQueueRef.current = task.catch(() => undefined);
      return task;
    },
    [setCurrentDraft],
  );

  const draftId = draft?.id ?? null;

  const cancelPendingAutosave = React.useCallback((): void => {
    if (autosaveTimeoutRef.current === null) return;
    window.clearTimeout(autosaveTimeoutRef.current);
    autosaveTimeoutRef.current = null;
  }, []);

  React.useEffect(() => {
    if (!draftId) return;
    cancelPendingAutosave();
    setSaveStatus("saving");
    autosaveTimeoutRef.current = window.setTimeout(() => {
      autosaveTimeoutRef.current = null;
      void persist(form);
    }, 750);
    return cancelPendingAutosave;
  }, [cancelPendingAutosave, draftId, form, persist]);

  const hasUnsavedChanges = saveStatus !== "saved" && !submittedRef.current;

  React.useEffect(() => {
    if (!hasUnsavedChanges) return;
    const protectUnsavedChanges = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", protectUnsavedChanges);
    return () =>
      window.removeEventListener("beforeunload", protectUnsavedChanges);
  }, [hasUnsavedChanges]);

  const flushPersist = React.useCallback(
    async (snapshot: WizardForm): Promise<boolean> => {
      cancelPendingAutosave();
      const saved = await persist(snapshot);
      // A debounce callback may already have joined the queue before it could
      // be canceled. Drain the latest queue entry before using the draft ETag
      // for validate/submit so an autosave cannot create a revision mismatch.
      await saveQueueRef.current;
      return saved;
    },
    [cancelPendingAutosave, persist],
  );

  React.useEffect(() => {
    holdRef.current = hold;
    if (!hold) {
      setHoldSeconds(0);
      return;
    }
    const update = (): void => {
      const seconds = Math.max(
        0,
        Math.ceil((new Date(hold.expiresAt).getTime() - Date.now()) / 1000),
      );
      setHoldSeconds(seconds);
      if (seconds === 0) {
        setHold(null);
        setMessage(
          "That arrival-window hold expired. Your job details are saved; choose another window.",
        );
        setStep(4);
      }
    };
    update();
    const interval = window.setInterval(update, 1_000);
    return () => window.clearInterval(interval);
  }, [hold]);

  React.useEffect(() => {
    return () => {
      const currentDraft = draftRef.current;
      const currentHold = holdRef.current;
      if (!submittedRef.current && currentDraft && currentHold) {
        void fetch(
          `/api/partners/portal/booking-drafts/${encodeURIComponent(currentDraft.id)}/hold?holdId=${encodeURIComponent(currentHold.id)}`,
          { method: "DELETE", keepalive: true },
        );
      }
    };
  }, []);

  const releaseHeldTimeAfterEdit = (): void => {
    const currentDraft = draftRef.current;
    const currentHold = holdRef.current;
    if (!currentDraft || !currentHold) return;

    holdRef.current = null;
    setHold(null);
    setAvailability(null);
    setFurthestStep((current) => Math.min(current, 4));
    void fetch(
      `/api/partners/portal/booking-drafts/${encodeURIComponent(currentDraft.id)}/hold?holdId=${encodeURIComponent(currentHold.id)}`,
      { method: "DELETE" },
    ).catch(() => undefined);
  };

  const update = <K extends keyof WizardForm>(
    key: K,
    value: WizardForm[K],
  ): void => {
    releaseHeldTimeAfterEdit();
    if (String(key).startsWith("proof")) setPersonaFeedback(null);
    setForm((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => {
      const next = { ...current };
      if (key === "locationId") delete next["locationId"];
      if (key === "serviceKey") delete next["serviceKey"];
      if (key === "tierKey") delete next["tierKey"];
      if (key === "description") delete next["description"];
      if (["contactName", "contactPhone", "contactEmail"].includes(key)) {
        delete next["onSiteContact"];
        delete next["contactMethod"];
      }
      if (String(key).startsWith("preferred")) {
        delete next["preferredWindows"];
      }
      if (String(key).startsWith("billingContact")) {
        delete next["billingContact"];
      }
      return next;
    });
  };

  const applyProofPreset = (preset: PartnerPersonaProofPreset): void => {
    releaseHeldTimeAfterEdit();
    setForm((current) => ({
      ...current,
      proofBefore: preset.before > 0,
      proofBeforeCount: Math.max(1, preset.before),
      proofAfter: preset.after > 0,
      proofAfterCount: Math.max(1, preset.after),
      proofPackage: preset.package,
    }));
    setPersonaFeedback(
      `${preset.label} applied as a starting point. Review or override every proof field before continuing.`,
    );
  };

  const updateLocation = (locationId: string): void => {
    releaseHeldTimeAfterEdit();
    const timezone =
      availableLocations.find((location) => location.id === locationId)
        ?.timezone ?? "America/New_York";
    setForm((current) => ({
      ...current,
      locationId,
      preferredTimezone: timezone,
    }));
    setFieldErrors((current) => {
      const next = { ...current };
      delete next["locationId"];
      delete next["preferredWindows"];
      return next;
    });
  };

  const updateService = (serviceKey: string): void => {
    releaseHeldTimeAfterEdit();
    const nextService = services.find((service) => service.key === serviceKey);
    setForm((current) => ({
      ...current,
      serviceKey,
      tierKey:
        serviceKey === current.serviceKey
          ? current.tierKey
          : nextService?.baseOptions?.length === 1
            ? (nextService.baseOptions[0]?.tierKey ?? "")
            : "",
      addOnQuantities:
        serviceKey === current.serviceKey ? current.addOnQuantities : {},
    }));
    setFieldErrors((current) => {
      const next = { ...current };
      delete next["serviceKey"];
      delete next["tierKey"];
      delete next["selectedAddOns"];
      return next;
    });
  };

  const updateAddOn = (
    addOn: BookingWizardAddOn,
    selected: boolean,
    quantity?: number,
  ): void => {
    releaseHeldTimeAfterEdit();
    setForm((current) => {
      const addOnQuantities = { ...current.addOnQuantities };
      if (!selected) {
        delete addOnQuantities[addOn.key];
      } else {
        addOnQuantities[addOn.key] = clampPartnerAddOnQuantity({
          value: quantity,
          minimum: addOn.minimumQuantity,
          maximum: addOn.maximumQuantity,
        });
      }
      return { ...current, addOnQuantities };
    });
    setFieldErrors((current) => {
      const next = { ...current };
      delete next["selectedAddOns"];
      return next;
    });
  };

  const focusErrorSummary = React.useCallback(
    (errors: Record<string, string>): void => {
      if (!Object.keys(errors).length) return;
      window.requestAnimationFrame(() =>
        document.getElementById("partner-book-error-summary")?.focus(),
      );
    },
    [],
  );

  const loadAvailability = React.useCallback(async (): Promise<boolean> => {
    const current = draftRef.current;
    if (!current) return false;
    setAvailabilityLoading(true);
    setMessage(null);
    trackPartnerFunnelEvent({
      stage: "availability_requested",
      persona,
      surface: "booking",
      step: 4,
    });
    const saved = await flushPersist(form);
    const savedDraft = draftRef.current;
    if (!saved || !savedDraft) {
      setAvailabilityLoading(false);
      return false;
    }
    const validated = await partnerPortalFetch<{
      ok: true;
      draft: PartnerDraft;
      validation: {
        valid: boolean;
        ready: boolean;
        fieldErrors: Record<string, string>;
      };
    }>(`booking-drafts/${savedDraft.id}/validate`, {
      method: "POST",
      headers: { "If-Match": savedDraft.etag },
      body: JSON.stringify({}),
    }).catch(() => null);
    if (!validated?.ok) {
      setAvailabilityLoading(false);
      const errors = validated?.error.fieldErrors ?? {};
      setFieldErrors(errors);
      setMessage(
        validated?.error.message ?? "We couldn’t validate this booking draft.",
      );
      if (Object.keys(errors).length) {
        const targetStep = Math.min(...Object.keys(errors).map(fieldStep));
        setStep(targetStep);
        focusErrorSummary(errors);
      }
      return false;
    }
    setCurrentDraft(validated.data.draft);
    if (!validated.data.validation.valid) {
      const errors = validated.data.validation.fieldErrors;
      setAvailabilityLoading(false);
      setFieldErrors(errors);
      setMessage(
        "Complete the highlighted details before choosing an arrival window.",
      );
      const targetStep = Math.min(...Object.keys(errors).map(fieldStep));
      setStep(Number.isFinite(targetStep) ? targetStep : 1);
      focusErrorSummary(errors);
      return false;
    }

    const from = new Date();
    const to = new Date(from.getTime() + 30 * 86_400_000);
    const result = await partnerPortalFetch<{
      ok: true;
      availability: PartnerAvailability;
    }>(
      `booking-drafts/${savedDraft.id}/availability?${new URLSearchParams({
        from: from.toISOString(),
        to: to.toISOString(),
      }).toString()}`,
    ).catch(() => null);
    setAvailabilityLoading(false);
    if (!result?.ok) {
      trackPartnerFunnelEvent({
        stage: "availability_degraded",
        persona,
        surface: "booking",
        step: 4,
      });
      setAvailability(null);
      setMessage(
        withPortalSupportReference(
          "Live confirmation is not available for this scope right now. Your draft is saved; choose preferred dates and Stonegate will review the request without reserving a slot.",
          result?.error.correlationId,
        ),
      );
      return true;
    }
    trackPartnerFunnelEvent({
      stage: !result.data.availability.instantConfirmationEligible
        ? "availability_review_only"
        : result.data.availability.windows.some((window) => window.available)
          ? "availability_available"
          : "availability_slot_full",
      persona,
      surface: "booking",
      step: 4,
    });
    setCurrentDraft(result.data.availability.draft);
    setAvailability(result.data.availability);
    setForm((current) =>
      current.preferredTimezone === result.data.availability.timezone
        ? current
        : {
            ...current,
            preferredTimezone: result.data.availability.timezone,
          },
    );
    return true;
  }, [flushPersist, focusErrorSummary, form, persona, setCurrentDraft]);

  const goNext = async (): Promise<void> => {
    if (advancingRef.current) return;
    advancingRef.current = true;
    setAdvancing(true);
    try {
      const localErrors = localErrorsForStep(
        step,
        form,
        services.find((service) => service.key === form.serviceKey),
      );
      if (Object.keys(localErrors).length) {
        setFieldErrors(localErrors);
        setMessage("Complete the highlighted details to continue.");
        focusErrorSummary(localErrors);
        return;
      }
      if (step === 4 && !hold) {
        const preferredDates = [
          form.preferredDateOne,
          form.preferredDateTwo,
          form.preferredDateThree,
        ].filter(Boolean);
        const availableWindowExists =
          availability?.instantConfirmationEligible === true &&
          availability.windows.some((window) => window.available);
        if (
          availableWindowExists ||
          preferredDates.length === 0 ||
          new Set(preferredDates).size !== preferredDates.length
        ) {
          const errors = {
            preferredWindows: availableWindowExists
              ? "Choose one of the available arrival windows."
              : preferredDates.length === 0
                ? "Choose at least one preferred service date."
                : "Choose distinct preferred service dates.",
          };
          setFieldErrors(errors);
          setMessage(errors.preferredWindows);
          focusErrorSummary(errors);
          return;
        }
      }
      if (step === 3) {
        const loaded = await loadAvailability();
        if (!loaded) return;
      } else if (!(await persist(form))) {
        return;
      }
      const next = Math.min(STEPS.length - 1, step + 1);
      setStep(next);
      setFurthestStep((current) => Math.max(current, next));
      setMessage(null);
      window.requestAnimationFrame(() =>
        document.getElementById("partner-book-step-heading")?.focus(),
      );
    } finally {
      advancingRef.current = false;
      setAdvancing(false);
    }
  };

  const editReviewStep = (target: number): void => {
    setStep(target);
    window.requestAnimationFrame(() =>
      document.getElementById("partner-book-step-heading")?.focus(),
    );
  };

  const chooseWindow = async (windowId: string): Promise<void> => {
    setAvailabilityLoading(true);
    setMessage(null);
    // Availability can update the draft revision and then trigger a debounced
    // timezone autosave. Drain that queue before using If-Match so a user can
    // never lose a valid slot to our own in-flight autosave.
    cancelPendingAutosave();
    await saveQueueRef.current;
    const current = draftRef.current;
    if (!current) {
      setAvailabilityLoading(false);
      return;
    }
    const result = await partnerPortalFetch<{ ok: true; hold: PartnerHold }>(
      `booking-drafts/${current.id}/hold`,
      {
        method: "POST",
        headers: {
          "If-Match": current.etag,
          "Idempotency-Key": createPortalOperationKey("booking-hold"),
        },
        body: JSON.stringify({ windowId }),
      },
    ).catch(() => null);
    setAvailabilityLoading(false);
    if (!result?.ok) {
      setMessage(
        result?.error.message ??
          "That time could not be held. Choose another available time.",
      );
      if (result?.response.status === 409) {
        trackPartnerFunnelEvent({
          stage: "slot_contention",
          persona,
          surface: "booking",
          step: 5,
        });
        void loadAvailability();
      }
      return;
    }
    setHold(result.data.hold);
  };

  const submitBooking = async (): Promise<void> => {
    const current = draftRef.current;
    const preferredReviewReady = Boolean(form.preferredDateOne);
    if (!current || (!hold && !preferredReviewReady)) return;
    setSubmitting(true);
    setMessage(null);
    const saved = await flushPersist(form);
    const savedDraft = draftRef.current;
    if (!saved || !savedDraft) {
      setSubmitting(false);
      return;
    }
    const result = await partnerPortalFetch<{
      ok: true;
      booking: { id: string; publicStatus: string; confirmationMode: string };
    }>(`booking-drafts/${current.id}/submit`, {
      method: "POST",
      headers: {
        "If-Match": savedDraft.etag,
        "Idempotency-Key": submitOperationKeyRef.current,
      },
      body: JSON.stringify(
        hold ? { holdId: hold.id } : { submissionMode: "review" },
      ),
    }).catch(() => null);
    if (!result?.ok) {
      trackPartnerFunnelEvent({
        stage: "booking_failed",
        persona,
        surface: "booking",
        step: 6,
      });
      setSubmitting(false);
      setMessage(
        result?.error.message ??
          "The job was not submitted. Your draft is still saved.",
      );
      if (result?.response.status === 409) {
        if (hold) {
          setHold(null);
          setStep(4);
          void loadAvailability();
        }
      }
      return;
    }
    submittedRef.current = true;
    trackPartnerFunnelEvent({
      stage: "booking_submitted",
      persona,
      surface: "booking",
      step: 6,
    });
    trackPartnerFunnelEvent({
      stage:
        result.data.booking.confirmationMode === "instant" ||
        result.data.booking.publicStatus === "confirmed"
          ? "booking_confirmed"
          : "booking_review_requested",
      persona,
      surface: "booking",
      step: 6,
    });
    router.push(
      `/partners/bookings/${encodeURIComponent(result.data.booking.id)}?created=1` as Route,
    );
    router.refresh();
  };

  const location = availableLocations.find(
    (item) => item.id === form.locationId,
  );
  const service = services.find((item) => item.key === form.serviceKey);
  const selectedBaseOption = service?.baseOptions?.find(
    (option) => option.tierKey === form.tierKey,
  );
  const selectedServiceAddOns = (service?.addOns ?? []).filter(
    (addOn) => form.addOnQuantities[addOn.key] !== undefined,
  );
  const windowsByDate = React.useMemo(() => {
    const groups = new Map<string, PartnerAvailability["windows"]>();
    if (!availability?.instantConfirmationEligible) return [];
    for (const window of availability?.windows ?? []) {
      if (!window.available) continue;
      const group = groups.get(window.localDate) ?? [];
      group.push(window);
      groups.set(window.localDate, group);
    }
    return [...groups.entries()];
  }, [availability]);
  const rankedAlternatives = React.useMemo(
    () => visibleRankedPartnerAlternatives(availability?.rankedAlternatives),
    [availability?.rankedAlternatives],
  );
  const selectedTimezone =
    availability?.timezone ??
    location?.timezone ??
    form.preferredTimezone ??
    "America/New_York";
  const manualReviewMode =
    !hold && !availabilityLoading && windowsByDate.length === 0;
  const preferredDates = [
    form.preferredDateOne,
    form.preferredDateTwo,
    form.preferredDateThree,
  ].filter(Boolean);
  const preferredReviewReady =
    manualReviewMode &&
    preferredDates.length > 0 &&
    new Set(preferredDates).size === preferredDates.length;
  const preferredDateMinimum = preferredDateBoundary(selectedTimezone, 1);
  const preferredDateMaximum = preferredDateBoundary(selectedTimezone, 30);
  const holdMinutes = Math.floor(holdSeconds / 60);
  const holdRemainder = String(holdSeconds % 60).padStart(2, "0");

  return (
    <div
      className="space-y-5"
      data-partner-unsaved={hasUnsavedChanges ? "true" : undefined}
    >
      <PartnerPanel className="overflow-hidden p-0 sm:p-0">
        <div className="border-b border-slate-200 bg-slate-50 px-4 py-4 sm:px-6">
          <ol
            className="grid grid-cols-3 gap-2 sm:grid-cols-6"
            aria-label="Booking progress"
          >
            {STEPS.map((item, index) => {
              const Icon = item.icon;
              const complete = index < step;
              const active = index === step;
              const reachable = index <= furthestStep;
              const content = (
                <>
                  <span
                    className={cn(
                      "flex h-8 w-8 items-center justify-center rounded-full border",
                      active
                        ? "border-primary-700 bg-primary-700 text-white"
                        : complete
                          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                          : "border-slate-200 bg-white text-slate-400",
                    )}
                  >
                    {complete ? (
                      <Check className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <Icon className="h-4 w-4" aria-hidden="true" />
                    )}
                  </span>
                  <span
                    className={cn(
                      "text-[11px] font-semibold",
                      active ? "text-primary-900" : "text-slate-600",
                    )}
                  >
                    <span className="sm:hidden">{item.shortLabel}</span>
                    <span className="hidden sm:inline">{item.label}</span>
                  </span>
                </>
              );
              return (
                <li key={item.label} className="min-w-0">
                  {reachable ? (
                    <button
                      type="button"
                      onClick={() => editReviewStep(index)}
                      disabled={advancing || submitting || availabilityLoading}
                      aria-current={active ? "step" : undefined}
                      className="flex min-h-11 w-full flex-col items-center gap-1 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                    >
                      {content}
                    </button>
                  ) : (
                    <div
                      className="flex min-h-11 flex-col items-center gap-1"
                      aria-current={active ? "step" : undefined}
                    >
                      {content}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </div>

        <div className="p-5 sm:p-7">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary-700">
                Step {step + 1} of {STEPS.length}
              </p>
              <h2
                id="partner-book-step-heading"
                tabIndex={-1}
                className="mt-1 text-xl font-semibold tracking-tight text-slate-950 focus:outline-none sm:text-2xl"
              >
                {STEPS[step]?.label}
              </h2>
            </div>
            <div
              className="min-w-32 text-right text-xs text-slate-500"
              role="status"
              aria-live="polite"
            >
              {saveStatus === "creating" || saveStatus === "saving" ? (
                <span className="inline-flex items-center gap-1.5">
                  <LoaderCircle
                    className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                  {saveStatus === "creating" ? "Starting draft…" : "Saving…"}
                </span>
              ) : saveStatus === "saved" ? (
                <span className="inline-flex items-center gap-1.5 text-emerald-700">
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                  All changes saved
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-rose-700">
                  <CircleAlert className="h-3.5 w-3.5" aria-hidden="true" />
                  Not saved
                </span>
              )}
            </div>
          </div>

          {Object.keys(fieldErrors).length > 0 ? (
            <div
              id="partner-book-error-summary"
              className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-950 outline-none focus-visible:ring-2 focus-visible:ring-rose-600 focus-visible:ring-offset-2"
              role="alert"
              aria-labelledby="partner-book-error-summary-heading"
              tabIndex={-1}
            >
              <h3
                id="partner-book-error-summary-heading"
                className="font-semibold"
              >
                Review the highlighted details
              </h3>
              {message ? <p className="mt-1">{message}</p> : null}
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {Object.entries(fieldErrors).map(([field, error]) => {
                  const targetId = fieldElementId(field);
                  return (
                    <li key={field}>
                      <a
                        href={`#${targetId}`}
                        className="font-medium underline decoration-rose-400 underline-offset-2 hover:decoration-rose-700"
                        onClick={(event) => {
                          event.preventDefault();
                          document.getElementById(targetId)?.focus();
                        }}
                      >
                        {error}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : message ? (
            <PartnerNotice
              tone={saveStatus === "error" ? "error" : "warning"}
              className="mt-5"
            >
              {message}
            </PartnerNotice>
          ) : null}

          <div className="mt-6">
            {step === 0 ? (
              <fieldset>
                <legend className="text-base font-semibold text-slate-950">
                  Where should the crew go?
                </legend>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Choose an active location from your account. Its access
                  details remain editable on the next step.
                </p>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  {availableLocations.map((item, index) => {
                    const selected = item.id === form.locationId;
                    return (
                      <label
                        key={item.id}
                        className={cn(
                          "relative flex min-h-24 cursor-pointer gap-3 rounded-2xl border p-4 transition focus-within:ring-2 focus-within:ring-accent-500",
                          selected
                            ? "border-primary-600 bg-primary-50 ring-1 ring-primary-600"
                            : "border-slate-200 hover:border-primary-300",
                        )}
                      >
                        <input
                          id={
                            selected || (!form.locationId && index === 0)
                              ? "partner-book-location"
                              : undefined
                          }
                          type="radio"
                          name="location"
                          value={item.id}
                          checked={selected}
                          onChange={() => updateLocation(item.id)}
                          className="mt-1 h-5 w-5 shrink-0 border-slate-300 text-primary-700"
                          aria-describedby={
                            fieldErrors["locationId"]
                              ? "partner-book-location-error"
                              : undefined
                          }
                        />
                        <span className="min-w-0">
                          <span className="block font-semibold text-slate-950">
                            {item.name}
                          </span>
                          <span className="mt-1 block text-sm leading-5 text-slate-600">
                            {item.address}
                          </span>
                          {item.serviceAreaStatus &&
                          item.serviceAreaStatus !== "eligible" ? (
                            <span className="mt-2 block text-xs font-medium text-amber-800">
                              Service-area review required
                            </span>
                          ) : null}
                        </span>
                      </label>
                    );
                  })}
                </div>
                <PartnerInlineLocationForm
                  canManage={canManageLocations}
                  onCreated={(newLocation) => {
                    setAvailableLocations((current) =>
                      [...current, newLocation].sort((left, right) =>
                        left.name.localeCompare(right.name),
                      ),
                    );
                    updateLocation(newLocation.id);
                    setFieldErrors((current) => {
                      const next = { ...current };
                      delete next["locationId"];
                      return next;
                    });
                  }}
                />
                {fieldErrors["locationId"] ? (
                  <p
                    id="partner-book-location-error"
                    className="mt-3 text-sm font-medium text-rose-700"
                  >
                    {fieldErrors["locationId"]}
                  </p>
                ) : null}
              </fieldset>
            ) : null}

            {step === 1 ? (
              <div className="space-y-5">
                {showPersonaSuggestions ? (
                  <aside
                    aria-labelledby="partner-persona-scope-heading"
                    className="rounded-2xl border border-primary-100 bg-primary-50/70 p-4 sm:p-5"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="max-w-2xl">
                        <p className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-primary-700">
                          <Sparkles className="h-4 w-4" aria-hidden="true" />
                          {personaPresentation.label} scope guide
                        </p>
                        <h3
                          id="partner-persona-scope-heading"
                          className="mt-2 font-semibold text-slate-950"
                        >
                          {personaPresentation.booking.scopeHeading}
                        </h3>
                        <p className="mt-1 text-sm leading-6 text-slate-700">
                          {personaPresentation.booking.scopeLead}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setShowPersonaSuggestions(false);
                          setPersonaFeedback(null);
                        }}
                        className={cn(
                          partnerSecondaryButtonClass,
                          "min-h-11 px-3",
                        )}
                        aria-label="Dismiss persona booking suggestions"
                      >
                        <X className="h-4 w-4" aria-hidden="true" />
                        Dismiss
                      </button>
                    </div>
                    <ul className="mt-3 grid gap-x-6 gap-y-2 text-sm leading-5 text-slate-700 sm:grid-cols-2">
                      {personaPresentation.booking.scopeChecklist.map(
                        (item) => (
                          <li key={item} className="flex gap-2">
                            <Check
                              className="mt-0.5 h-4 w-4 shrink-0 text-primary-700"
                              aria-hidden="true"
                            />
                            <span>{item}</span>
                          </li>
                        ),
                      )}
                    </ul>
                    <p className="mt-3 text-xs leading-5 text-slate-600">
                      These are optional prompts only. They do not change your
                      service, account access, or saved draft.
                    </p>
                  </aside>
                ) : null}
                <label className="block" htmlFor="partner-book-service">
                  <span className="text-sm font-semibold text-slate-700">
                    Service
                  </span>
                  <select
                    id="partner-book-service"
                    value={form.serviceKey}
                    onChange={(event) => updateService(event.target.value)}
                    className={partnerFieldClass}
                    required
                    aria-invalid={Boolean(fieldErrors["serviceKey"])}
                    aria-describedby={
                      fieldErrors["serviceKey"]
                        ? "partner-book-service-error"
                        : undefined
                    }
                  >
                    <option value="">Choose a service</option>
                    {services.map((item) => (
                      <option
                        key={item.key}
                        value={item.key}
                        disabled={!item.bookable}
                      >
                        {item.label}
                        {!item.bookable ? " — configuration required" : ""}
                      </option>
                    ))}
                  </select>
                  {fieldErrors["serviceKey"] ? (
                    <span
                      id="partner-book-service-error"
                      className="mt-1 block text-sm font-medium text-rose-700"
                    >
                      {fieldErrors["serviceKey"]}
                    </span>
                  ) : null}
                </label>
                {service?.agreement ? (
                  <section
                    className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                    aria-labelledby="partner-book-agreement-heading"
                  >
                    <p className="text-xs font-semibold uppercase tracking-wide text-primary-700">
                      Current account agreement
                    </p>
                    <h3
                      id="partner-book-agreement-heading"
                      className="mt-1 font-semibold text-slate-950"
                    >
                      {service.agreement.label}
                    </h3>
                    <p className="mt-1 text-sm leading-6 text-slate-700">
                      {priceStateLabel(service.priceState)} ·{" "}
                      {service.agreement.currency} · effective{" "}
                      {formatDate(
                        service.agreement.effectiveFrom.slice(0, 10),
                        "UTC",
                      )}
                      {service.agreement.effectiveTo
                        ? ` through ${formatDate(
                            service.agreement.effectiveTo.slice(0, 10),
                            "UTC",
                          )}`
                        : " with no recorded end date"}
                    </p>
                    {service.inclusions.length > 0 ? (
                      <div className="mt-3">
                        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                          Included
                        </h4>
                        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-700">
                          {service.inclusions.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {service.exclusions.length > 0 ? (
                      <div className="mt-3">
                        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                          Excluded or separately quoted
                        </h4>
                        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-700">
                          {service.exclusions.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {service.quoteRule ? (
                      <p className="mt-3 text-sm leading-6 text-slate-700">
                        <strong>Quote rule:</strong> {service.quoteRule}
                      </p>
                    ) : null}
                    <p className="mt-3 text-xs leading-5 text-slate-600">
                      If this does not match your signed agreement, continue
                      only as a review request and contact Stonegate from Help.
                    </p>
                  </section>
                ) : null}
                {service?.baseOptions?.length ? (
                  <label className="block" htmlFor="partner-book-base-option">
                    <span className="text-sm font-semibold text-slate-700">
                      Base service option
                    </span>
                    <select
                      id="partner-book-base-option"
                      value={form.tierKey}
                      onChange={(event) =>
                        update("tierKey", event.target.value)
                      }
                      className={partnerFieldClass}
                      required
                      aria-invalid={Boolean(fieldErrors["tierKey"])}
                      aria-describedby={
                        fieldErrors["tierKey"]
                          ? "partner-book-base-option-error"
                          : undefined
                      }
                    >
                      <option value="">Choose a base option</option>
                      {service.baseOptions.map((option) => (
                        <option key={option.tierKey} value={option.tierKey}>
                          {option.label}
                          {option.price
                            ? ` — ${formatMoney(option.price)}`
                            : ""}
                        </option>
                      ))}
                    </select>
                    {fieldErrors["tierKey"] ? (
                      <span
                        id="partner-book-base-option-error"
                        className="mt-1 block text-sm font-medium text-rose-700"
                      >
                        {fieldErrors["tierKey"]}
                      </span>
                    ) : null}
                  </label>
                ) : null}
                {service?.addOns?.length ? (
                  <fieldset
                    className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                    aria-describedby={
                      fieldErrors["selectedAddOns"]
                        ? "partner-book-add-ons-error"
                        : "partner-book-add-ons-help"
                    }
                  >
                    <legend className="px-1 text-sm font-semibold text-slate-800">
                      Optional add-ons
                    </legend>
                    <p
                      id="partner-book-add-ons-help"
                      className="mt-1 text-sm leading-6 text-slate-600"
                    >
                      Select the exact quantity needed. Your contracted unit
                      price is shown when your role can view account rates.
                    </p>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      {service.addOns.map((addOn) => {
                        const quantity = form.addOnQuantities[addOn.key];
                        const selected = quantity !== undefined;
                        return (
                          <div
                            key={addOn.key}
                            className={cn(
                              "rounded-xl border bg-white p-4",
                              selected
                                ? "border-primary-500 ring-1 ring-primary-200"
                                : "border-slate-200",
                            )}
                          >
                            <label className="flex min-h-11 cursor-pointer items-start gap-3">
                              <input
                                type="checkbox"
                                checked={selected}
                                onChange={(event) =>
                                  updateAddOn(
                                    addOn,
                                    event.target.checked,
                                    addOn.minimumQuantity,
                                  )
                                }
                                className="mt-0.5 h-5 w-5 rounded border-slate-300 text-primary-700"
                              />
                              <span className="min-w-0 flex-1">
                                <span className="block font-semibold text-slate-950">
                                  {addOn.label}
                                </span>
                                {addOn.detail ? (
                                  <span className="mt-1 block text-sm leading-5 text-slate-600">
                                    {addOn.detail}
                                  </span>
                                ) : null}
                                <span className="mt-1 block text-xs font-semibold text-slate-700">
                                  {addOn.unitPrice
                                    ? `${formatMoney(addOn.unitPrice)} per ${addOn.unitLabel}`
                                    : "Price confirmed during review"}
                                  {addOn.requiresReview
                                    ? " · Staff review required"
                                    : ""}
                                </span>
                              </span>
                            </label>
                            {selected ? (
                              <label
                                className="mt-3 block"
                                htmlFor={`partner-book-add-on-${addOn.key}`}
                              >
                                <span className="text-xs font-semibold text-slate-700">
                                  Quantity ({addOn.unitLabel})
                                </span>
                                <input
                                  id={`partner-book-add-on-${addOn.key}`}
                                  type="number"
                                  min={addOn.minimumQuantity}
                                  max={addOn.maximumQuantity}
                                  step="1"
                                  inputMode="numeric"
                                  value={quantity}
                                  onChange={(event) =>
                                    updateAddOn(
                                      addOn,
                                      true,
                                      Number(event.target.value),
                                    )
                                  }
                                  className={cn(partnerFieldClass, "mt-1")}
                                />
                              </label>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                    {fieldErrors["selectedAddOns"] ? (
                      <p
                        id="partner-book-add-ons-error"
                        className="mt-3 text-sm font-medium text-rose-700"
                      >
                        {fieldErrors["selectedAddOns"]}
                      </p>
                    ) : null}
                  </fieldset>
                ) : null}
                <label className="block" htmlFor="partner-book-description">
                  <span className="text-sm font-semibold text-slate-700">
                    {personaPresentation.booking.descriptionLabel}
                  </span>
                  <textarea
                    id="partner-book-description"
                    value={form.description}
                    onChange={(event) =>
                      update("description", event.target.value)
                    }
                    rows={5}
                    maxLength={4_000}
                    className={partnerFieldClass}
                    placeholder={
                      personaPresentation.booking.descriptionPlaceholder
                    }
                    required
                    aria-invalid={Boolean(fieldErrors["description"])}
                    aria-describedby={
                      fieldErrors["description"]
                        ? "partner-book-description-error"
                        : "partner-book-description-help"
                    }
                  />
                  <span
                    id="partner-book-description-help"
                    className="mt-1 block text-xs text-slate-500"
                  >
                    Clear detail helps us confirm the right crew, equipment, and
                    arrival window.
                  </span>
                  {fieldErrors["description"] ? (
                    <span
                      id="partner-book-description-error"
                      className="mt-1 block text-sm font-medium text-rose-700"
                    >
                      {fieldErrors["description"]}
                    </span>
                  ) : null}
                </label>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label htmlFor="partner-book-item-count">
                    <span className="text-sm font-semibold text-slate-700">
                      Approximate item count{" "}
                      <span className="font-normal text-slate-500">
                        (optional)
                      </span>
                    </span>
                    <input
                      id="partner-book-item-count"
                      type="number"
                      min="0"
                      inputMode="numeric"
                      value={form.itemCount}
                      onChange={(event) =>
                        update("itemCount", event.target.value)
                      }
                      className={partnerFieldClass}
                    />
                  </label>
                  <label htmlFor="partner-book-volume">
                    <span className="text-sm font-semibold text-slate-700">
                      Estimated cubic yards{" "}
                      <span className="font-normal text-slate-500">
                        (optional)
                      </span>
                    </span>
                    <input
                      id="partner-book-volume"
                      type="number"
                      min="0"
                      step="0.5"
                      inputMode="decimal"
                      value={form.volume}
                      onChange={(event) => update("volume", event.target.value)}
                      className={partnerFieldClass}
                    />
                  </label>
                </div>
                <fieldset className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4">
                  <legend className="px-1 text-sm font-semibold text-slate-900">
                    Scope that needs Stonegate review
                  </legend>
                  <p className="mt-1 text-sm leading-6 text-slate-700">
                    Check anything that may need special planning. This does not
                    reject the request—it sends the saved scope to Stonegate for
                    confirmation before a time is promised.
                  </p>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label className="flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border border-amber-200 bg-white p-3">
                      <input
                        type="checkbox"
                        checked={form.restrictedItems}
                        onChange={(event) =>
                          update("restrictedItems", event.target.checked)
                        }
                        className="mt-0.5 h-5 w-5 rounded border-slate-300 text-primary-700"
                      />
                      <span>
                        <span className="block text-sm font-semibold text-slate-950">
                          Potentially restricted or special-handling material
                        </span>
                        <span className="mt-1 block text-xs leading-5 text-slate-600">
                          Examples include chemicals, paint, fuel, batteries,
                          pressurized containers, or unknown material.
                        </span>
                      </span>
                    </label>
                    <label className="flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border border-amber-200 bg-white p-3">
                      <input
                        type="checkbox"
                        checked={form.nonStandard}
                        onChange={(event) =>
                          update("nonStandard", event.target.checked)
                        }
                        className="mt-0.5 h-5 w-5 rounded border-slate-300 text-primary-700"
                      />
                      <span>
                        <span className="block text-sm font-semibold text-slate-950">
                          Oversized, unusually heavy, or non-standard work
                        </span>
                        <span className="mt-1 block text-xs leading-5 text-slate-600">
                          Select this when access, equipment, lifting,
                          demolition, or scope is outside a typical pickup.
                        </span>
                      </span>
                    </label>
                  </div>
                  <div className="mt-5 grid gap-5 lg:grid-cols-2">
                    <fieldset>
                      <legend className="text-sm font-semibold text-slate-900">
                        Material disclosures
                      </legend>
                      <p className="mt-1 text-xs leading-5 text-slate-600">
                        Select every category that may be present. Unknown
                        material should be disclosed rather than guessed.
                      </p>
                      <div className="mt-2 grid gap-2">
                        {PARTNER_HAZARD_OPTIONS.map((option) => (
                          <label
                            key={option.key}
                            className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-amber-200 bg-white px-3 py-2"
                          >
                            <input
                              type="checkbox"
                              checked={form.hazardCategories.includes(
                                option.key,
                              )}
                              onChange={(event) =>
                                update(
                                  "hazardCategories",
                                  event.target.checked
                                    ? [...form.hazardCategories, option.key]
                                    : form.hazardCategories.filter(
                                        (key) => key !== option.key,
                                      ),
                                )
                              }
                              className="h-5 w-5 rounded border-slate-300 text-primary-700"
                            />
                            <span className="text-sm text-slate-800">
                              {option.label}
                            </span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                    <fieldset>
                      <legend className="text-sm font-semibold text-slate-900">
                        Access or equipment needs
                      </legend>
                      <p className="mt-1 text-xs leading-5 text-slate-600">
                        This helps Stonegate assign the correct crew, vehicle,
                        and equipment before confirming the request.
                      </p>
                      <div className="mt-2 grid gap-2">
                        {PARTNER_EQUIPMENT_OPTIONS.map((option) => (
                          <label
                            key={option.key}
                            className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-amber-200 bg-white px-3 py-2"
                          >
                            <input
                              type="checkbox"
                              checked={form.equipmentNeeds.includes(option.key)}
                              onChange={(event) =>
                                update(
                                  "equipmentNeeds",
                                  event.target.checked
                                    ? [...form.equipmentNeeds, option.key]
                                    : form.equipmentNeeds.filter(
                                        (key) => key !== option.key,
                                      ),
                                )
                              }
                              className="h-5 w-5 rounded border-slate-300 text-primary-700"
                            />
                            <span className="text-sm text-slate-800">
                              {option.label}
                            </span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  </div>
                  <div className="mt-5 grid gap-4 sm:grid-cols-2">
                    <label htmlFor="partner-book-required-date">
                      <span className="text-sm font-semibold text-slate-800">
                        Must be completed by date{" "}
                        <span className="font-normal text-slate-600">
                          (optional)
                        </span>
                      </span>
                      <input
                        id="partner-book-required-date"
                        type="date"
                        value={form.requiredCompletionDate}
                        onChange={(event) =>
                          update("requiredCompletionDate", event.target.value)
                        }
                        className={partnerFieldClass}
                      />
                    </label>
                    <label htmlFor="partner-book-required-time">
                      <span className="text-sm font-semibold text-slate-800">
                        Required completion time{" "}
                        <span className="font-normal text-slate-600">
                          (optional)
                        </span>
                      </span>
                      <input
                        id="partner-book-required-time"
                        type="time"
                        value={form.requiredCompletionTime}
                        onChange={(event) =>
                          update("requiredCompletionTime", event.target.value)
                        }
                        disabled={!form.requiredCompletionDate}
                        className={partnerFieldClass}
                      />
                    </label>
                  </div>
                  <label className="mt-4 flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border border-amber-200 bg-white p-3">
                    <input
                      type="checkbox"
                      checked={form.multiStop}
                      onChange={(event) =>
                        update("multiStop", event.target.checked)
                      }
                      className="mt-0.5 h-5 w-5 rounded border-slate-300 text-primary-700"
                    />
                    <span>
                      <span className="block text-sm font-semibold text-slate-950">
                        This request has more than one pickup or service stop
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-slate-600">
                        Multi-stop work is reviewed before a time is promised.
                      </span>
                    </span>
                  </label>
                  {form.multiStop ? (
                    <label
                      className="mt-3 block"
                      htmlFor="partner-book-multi-stop-details"
                    >
                      <span className="text-sm font-semibold text-slate-800">
                        Stops and sequence
                      </span>
                      <textarea
                        id="partner-book-multi-stop-details"
                        value={form.multiStopDetails}
                        onChange={(event) =>
                          update("multiStopDetails", event.target.value)
                        }
                        rows={3}
                        maxLength={1_000}
                        className={partnerFieldClass}
                        placeholder="List each stop, address or site name, and the required order."
                      />
                    </label>
                  ) : null}
                </fieldset>
                <div className="grid gap-4 sm:grid-cols-3">
                  <label htmlFor="partner-book-po">
                    <span className="text-sm font-semibold text-slate-700">
                      PO / work order{" "}
                      <span className="font-normal text-slate-500">
                        (optional)
                      </span>
                    </span>
                    <input
                      id="partner-book-po"
                      value={form.poNumber}
                      onChange={(event) =>
                        update("poNumber", event.target.value)
                      }
                      maxLength={500}
                      className={partnerFieldClass}
                    />
                  </label>
                  <label htmlFor="partner-book-cost-center">
                    <span className="text-sm font-semibold text-slate-700">
                      Cost center{" "}
                      <span className="font-normal text-slate-500">
                        (optional)
                      </span>
                    </span>
                    <input
                      id="partner-book-cost-center"
                      value={form.costCenter}
                      onChange={(event) =>
                        update("costCenter", event.target.value)
                      }
                      maxLength={500}
                      className={partnerFieldClass}
                    />
                  </label>
                  <label htmlFor="partner-book-project">
                    <span className="text-sm font-semibold text-slate-700">
                      Project / listing{" "}
                      <span className="font-normal text-slate-500">
                        (optional)
                      </span>
                    </span>
                    <input
                      id="partner-book-project"
                      value={form.projectReference}
                      onChange={(event) =>
                        update("projectReference", event.target.value)
                      }
                      maxLength={500}
                      className={partnerFieldClass}
                    />
                  </label>
                </div>
                <fieldset className="rounded-2xl border border-slate-200 p-4">
                  <legend className="px-1 text-sm font-semibold text-slate-900">
                    Billing contact{" "}
                    <span className="font-normal text-slate-500">
                      (optional)
                    </span>
                  </legend>
                  <p className="mt-1 text-xs leading-5 text-slate-500">
                    Add both fields when invoices or receipts for this job
                    should go to a specific person.
                  </p>
                  <div className="mt-3 grid gap-4 sm:grid-cols-2">
                    <label htmlFor="partner-book-billing-name">
                      <span className="text-sm font-semibold text-slate-700">
                        Name
                      </span>
                      <input
                        id="partner-book-billing-name"
                        value={form.billingContactName}
                        onChange={(event) =>
                          update("billingContactName", event.target.value)
                        }
                        maxLength={200}
                        autoComplete="name"
                        className={partnerFieldClass}
                        aria-invalid={Boolean(fieldErrors["billingContact"])}
                        aria-describedby={
                          fieldErrors["billingContact"]
                            ? "partner-book-billing-error"
                            : undefined
                        }
                      />
                    </label>
                    <label htmlFor="partner-book-billing-email">
                      <span className="text-sm font-semibold text-slate-700">
                        Email
                      </span>
                      <input
                        id="partner-book-billing-email"
                        type="email"
                        inputMode="email"
                        autoComplete="email"
                        value={form.billingContactEmail}
                        onChange={(event) =>
                          update("billingContactEmail", event.target.value)
                        }
                        maxLength={320}
                        className={partnerFieldClass}
                        aria-invalid={Boolean(fieldErrors["billingContact"])}
                        aria-describedby={
                          fieldErrors["billingContact"]
                            ? "partner-book-billing-error"
                            : undefined
                        }
                      />
                    </label>
                  </div>
                  {fieldErrors["billingContact"] ? (
                    <p
                      id="partner-book-billing-error"
                      className="mt-3 text-sm font-medium text-rose-700"
                    >
                      {fieldErrors["billingContact"]}
                    </p>
                  ) : null}
                </fieldset>
              </div>
            ) : null}

            {step === 2 ? (
              <div className="space-y-5">
                <div className="grid gap-4 sm:grid-cols-2">
                  <label
                    className="sm:col-span-2"
                    htmlFor="partner-book-contact-name"
                  >
                    <span className="text-sm font-semibold text-slate-700">
                      On-site contact name
                    </span>
                    <input
                      id="partner-book-contact-name"
                      autoComplete="name"
                      value={form.contactName}
                      onChange={(event) =>
                        update("contactName", event.target.value)
                      }
                      className={partnerFieldClass}
                      required
                      aria-invalid={Boolean(fieldErrors["onSiteContact"])}
                      aria-describedby={
                        fieldErrors["onSiteContact"]
                          ? "partner-book-contact-name-error"
                          : undefined
                      }
                    />
                  </label>
                  <label htmlFor="partner-book-contact-phone">
                    <span className="text-sm font-semibold text-slate-700">
                      Mobile phone
                    </span>
                    <input
                      id="partner-book-contact-phone"
                      type="tel"
                      autoComplete="tel"
                      inputMode="tel"
                      value={form.contactPhone}
                      onChange={(event) =>
                        update("contactPhone", event.target.value)
                      }
                      className={partnerFieldClass}
                      aria-invalid={Boolean(fieldErrors["contactMethod"])}
                      aria-describedby={
                        fieldErrors["contactMethod"]
                          ? "partner-book-contact-method-error"
                          : undefined
                      }
                    />
                  </label>
                  <label htmlFor="partner-book-contact-email">
                    <span className="text-sm font-semibold text-slate-700">
                      Email
                    </span>
                    <input
                      id="partner-book-contact-email"
                      type="email"
                      autoComplete="email"
                      inputMode="email"
                      value={form.contactEmail}
                      onChange={(event) =>
                        update("contactEmail", event.target.value)
                      }
                      className={partnerFieldClass}
                      aria-invalid={Boolean(fieldErrors["contactMethod"])}
                      aria-describedby={
                        fieldErrors["contactMethod"]
                          ? "partner-book-contact-method-error"
                          : undefined
                      }
                    />
                  </label>
                </div>
                {fieldErrors["onSiteContact"] ? (
                  <p
                    id="partner-book-contact-name-error"
                    className="text-sm font-medium text-rose-700"
                  >
                    {fieldErrors["onSiteContact"]}
                  </p>
                ) : null}
                {fieldErrors["contactMethod"] ? (
                  <p
                    id="partner-book-contact-method-error"
                    className="text-sm font-medium text-rose-700"
                  >
                    {fieldErrors["contactMethod"]}
                  </p>
                ) : null}
                <fieldset className="rounded-2xl border border-slate-200 p-4">
                  <legend className="px-1 text-sm font-semibold text-slate-900">
                    Alternate on-site contact{" "}
                    <span className="font-normal text-slate-500">
                      (optional)
                    </span>
                  </legend>
                  <p className="mt-1 text-xs leading-5 text-slate-500">
                    Add a backup person when the primary contact may not be
                    available at arrival.
                  </p>
                  <div className="mt-3 grid gap-4 sm:grid-cols-3">
                    <label htmlFor="partner-book-alternate-name">
                      <span className="text-sm font-semibold text-slate-700">
                        Name
                      </span>
                      <input
                        id="partner-book-alternate-name"
                        autoComplete="name"
                        value={form.alternateContactName}
                        onChange={(event) =>
                          update("alternateContactName", event.target.value)
                        }
                        maxLength={200}
                        className={partnerFieldClass}
                      />
                    </label>
                    <label htmlFor="partner-book-alternate-phone">
                      <span className="text-sm font-semibold text-slate-700">
                        Phone
                      </span>
                      <input
                        id="partner-book-alternate-phone"
                        type="tel"
                        autoComplete="tel"
                        inputMode="tel"
                        value={form.alternateContactPhone}
                        onChange={(event) =>
                          update("alternateContactPhone", event.target.value)
                        }
                        maxLength={50}
                        className={partnerFieldClass}
                      />
                    </label>
                    <label htmlFor="partner-book-alternate-email">
                      <span className="text-sm font-semibold text-slate-700">
                        Email
                      </span>
                      <input
                        id="partner-book-alternate-email"
                        type="email"
                        autoComplete="email"
                        inputMode="email"
                        value={form.alternateContactEmail}
                        onChange={(event) =>
                          update("alternateContactEmail", event.target.value)
                        }
                        maxLength={320}
                        className={partnerFieldClass}
                      />
                    </label>
                  </div>
                </fieldset>
                <label className="block" htmlFor="partner-book-access">
                  <span className="text-sm font-semibold text-slate-700">
                    Access, parking, gate, or loading details{" "}
                    <span className="font-normal text-slate-500">
                      (optional)
                    </span>
                  </span>
                  <textarea
                    id="partner-book-access"
                    value={form.accessDetails}
                    onChange={(event) =>
                      update("accessDetails", event.target.value)
                    }
                    rows={4}
                    maxLength={4_000}
                    className={partnerFieldClass}
                    placeholder="Gate code handoff, lockbox process, loading dock, elevator, parking, tenant notice, pets, or access hours."
                  />
                </label>
                <label
                  className="block"
                  htmlFor="partner-book-crew-instructions"
                >
                  <span className="text-sm font-semibold text-slate-700">
                    Crew instructions{" "}
                    <span className="font-normal text-slate-500">
                      (optional)
                    </span>
                  </span>
                  <textarea
                    id="partner-book-crew-instructions"
                    value={form.crewInstructions}
                    onChange={(event) =>
                      update("crewInstructions", event.target.value)
                    }
                    rows={3}
                    maxLength={4_000}
                    className={partnerFieldClass}
                    placeholder="Anything the crew should do, avoid, verify, or document on site."
                  />
                </label>
              </div>
            ) : null}

            {step === 3 ? (
              <fieldset>
                <legend className="text-base font-semibold text-slate-950">
                  What completion evidence do you need?
                </legend>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  These requirements travel with the job so the team knows what
                  to capture. You can also attach current-condition or reference
                  photos to this request.
                </p>
                {showPersonaSuggestions ? (
                  <aside
                    aria-labelledby="partner-persona-proof-heading"
                    className="mt-4 rounded-2xl border border-primary-100 bg-primary-50/70 p-4"
                  >
                    <h3
                      id="partner-persona-proof-heading"
                      className="font-semibold text-slate-950"
                    >
                      {personaPresentation.booking.proofHeading}
                    </h3>
                    <p className="mt-1 text-sm leading-6 text-slate-700">
                      {personaPresentation.booking.proofLead}
                    </p>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      {personaPresentation.booking.proofPresets.map(
                        (preset) => {
                          const selected =
                            form.proofBefore === preset.before > 0 &&
                            form.proofBeforeCount ===
                              Math.max(1, preset.before) &&
                            form.proofAfter === preset.after > 0 &&
                            form.proofAfterCount ===
                              Math.max(1, preset.after) &&
                            form.proofPackage === preset.package;
                          return (
                            <button
                              key={preset.id}
                              type="button"
                              onClick={() => applyProofPreset(preset)}
                              aria-pressed={selected}
                              className={cn(
                                "min-h-11 rounded-xl border bg-white p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500",
                                selected
                                  ? "border-primary-600 ring-1 ring-primary-200"
                                  : "border-slate-200 hover:border-primary-300",
                              )}
                            >
                              <span className="block font-semibold text-slate-950">
                                Apply {preset.label}
                              </span>
                              <span className="mt-1 block text-sm leading-5 text-slate-600">
                                {preset.description}
                              </span>
                            </button>
                          );
                        },
                      )}
                    </div>
                    <p className="mt-3 text-xs leading-5 text-slate-600">
                      Nothing is applied until you choose a preset. The controls
                      below always override the suggestion.
                    </p>
                    {personaFeedback ? (
                      <p
                        className="mt-2 text-sm font-medium text-primary-900"
                        role="status"
                        aria-live="polite"
                      >
                        {personaFeedback}
                      </p>
                    ) : null}
                  </aside>
                ) : null}
                <div className="mt-5 grid gap-3 sm:grid-cols-3">
                  {[
                    {
                      key: "proofBefore" as const,
                      countKey: "proofBeforeCount" as const,
                      title: "Before photos",
                      detail: "Document the starting condition.",
                    },
                    {
                      key: "proofAfter" as const,
                      countKey: "proofAfterCount" as const,
                      title: "After photos",
                      detail: "Document the completed work.",
                    },
                    {
                      key: "proofPackage" as const,
                      countKey: null,
                      title: "Formal proof package",
                      detail: "Request a shareable completion record.",
                    },
                  ].map((item) => (
                    <div
                      key={item.key}
                      className={cn(
                        "min-h-32 rounded-2xl border p-4",
                        form[item.key]
                          ? "border-primary-500 bg-primary-50"
                          : "border-slate-200",
                      )}
                    >
                      <label className="flex cursor-pointer items-start gap-3">
                        <input
                          type="checkbox"
                          checked={form[item.key]}
                          onChange={(event) =>
                            update(item.key, event.target.checked)
                          }
                          className="mt-0.5 h-5 w-5 rounded border-slate-300 text-primary-700"
                        />
                        <span>
                          <span className="block font-semibold text-slate-950">
                            {item.title}
                          </span>
                          <span className="mt-1 block text-sm leading-5 text-slate-600">
                            {item.detail}
                          </span>
                        </span>
                      </label>
                      {item.countKey && form[item.key] ? (
                        <label className="mt-3 block text-xs font-semibold text-slate-700">
                          Minimum images
                          <input
                            type="number"
                            min={1}
                            max={40}
                            step={1}
                            inputMode="numeric"
                            value={form[item.countKey]}
                            onChange={(event) =>
                              update(
                                item.countKey,
                                Math.min(
                                  40,
                                  Math.max(1, Number(event.target.value) || 1),
                                ),
                              )
                            }
                            className={cn(partnerFieldClass, "mt-1")}
                          />
                        </label>
                      ) : null}
                    </div>
                  ))}
                </div>
                {draft ? (
                  <div className="mt-5">
                    <PartnerDraftPhotoUpload
                      draftId={draft.id}
                      canUpload={canUploadPhotos}
                      onCountChange={setDraftPhotoCount}
                      persona={persona}
                    />
                  </div>
                ) : (
                  <PartnerNotice tone="info" className="mt-5">
                    The photo uploader will appear as soon as this saved draft
                    is ready.
                  </PartnerNotice>
                )}
              </fieldset>
            ) : null}

            {step === 4 ? (
              <div>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h3 className="font-semibold text-slate-950">
                      Live service availability
                    </h3>
                    <p className="mt-1 text-sm leading-6 text-slate-600">
                      Select a two-hour arrival window. Stonegate keeps the
                      exact planned crew start internal. Windows are shown in{" "}
                      {selectedTimezone.replace(/_/gu, " ")}.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void loadAvailability()}
                    disabled={availabilityLoading}
                    className={partnerSecondaryButtonClass}
                  >
                    <RefreshCw
                      className={cn(
                        "h-4 w-4",
                        availabilityLoading &&
                          "animate-spin motion-reduce:animate-none",
                      )}
                      aria-hidden="true"
                    />
                    Refresh
                  </button>
                </div>
                {availability?.calendar.state !== "current" ? (
                  <PartnerNotice tone="warning" className="mt-4">
                    The connected calendar is{" "}
                    {availability?.calendar.state ?? "not available"}. Available
                    windows may require staff review before confirmation.
                  </PartnerNotice>
                ) : null}
                {availabilityLoading ? (
                  <div
                    className="mt-6 flex min-h-48 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-sm text-slate-600"
                    role="status"
                  >
                    <LoaderCircle
                      className="mr-2 h-5 w-5 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                    Checking live availability…
                  </div>
                ) : null}
                {!availabilityLoading && windowsByDate.length === 0 ? (
                  <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50/60 p-5 sm:p-6">
                    <div className="flex items-start gap-3">
                      <CalendarClock
                        className="mt-0.5 h-6 w-6 shrink-0 text-amber-700"
                        aria-hidden="true"
                      />
                      <div>
                        <h3 className="font-semibold text-slate-950">
                          Request a reviewed schedule
                        </h3>
                        <p className="mt-1 text-sm leading-6 text-slate-700">
                          Live confirmation is unavailable for this request.
                          Choose up to three preferred dates. Stonegate will
                          review the scope and contact you before any arrival
                          window is confirmed or capacity is reserved.
                        </p>
                      </div>
                    </div>
                    <fieldset className="mt-5">
                      <legend className="text-sm font-semibold text-slate-900">
                        Preferred dates
                      </legend>
                      {rankedAlternatives.length ? (
                        <div className="mt-3 rounded-xl border border-amber-200 bg-white p-3">
                          <p className="text-sm font-semibold text-slate-900">
                            Suggested dates from current capacity
                          </p>
                          <p className="mt-1 text-xs leading-5 text-slate-600">
                            These are ranked alternatives for review only. They
                            do not reserve a crew, truck, or arrival window.
                          </p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {rankedAlternatives.map((window) => (
                              <button
                                key={`review-alternative-${window.id}`}
                                type="button"
                                onClick={() =>
                                  update("preferredDateOne", window.localDate)
                                }
                                aria-pressed={
                                  form.preferredDateOne === window.localDate
                                }
                                className="min-h-11 rounded-lg border border-amber-300 bg-white px-3 py-2 text-left text-sm font-semibold text-slate-800 transition hover:border-amber-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                              >
                                {formatDate(window.localDate, selectedTimezone)}
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      <div className="mt-3 grid gap-4 sm:grid-cols-3">
                        {(
                          [
                            ["preferredDateOne", "First choice", true],
                            ["preferredDateTwo", "Second choice", false],
                            ["preferredDateThree", "Third choice", false],
                          ] as const
                        ).map(([key, label, required], index) => (
                          <label
                            key={key}
                            htmlFor={`partner-book-preferred-date-${index + 1}`}
                          >
                            <span className="text-sm font-semibold text-slate-700">
                              {label}
                              {!required ? (
                                <span className="font-normal text-slate-500">
                                  {" "}
                                  (optional)
                                </span>
                              ) : null}
                            </span>
                            <input
                              id={`partner-book-preferred-date-${index + 1}`}
                              type="date"
                              min={preferredDateMinimum}
                              max={preferredDateMaximum}
                              required={required}
                              value={form[key]}
                              onChange={(event) =>
                                update(key, event.target.value)
                              }
                              className={partnerFieldClass}
                              aria-invalid={Boolean(
                                fieldErrors["preferredWindows"],
                              )}
                              aria-describedby={
                                fieldErrors["preferredWindows"]
                                  ? "partner-book-preferred-error"
                                  : undefined
                              }
                            />
                          </label>
                        ))}
                      </div>
                      <label
                        className="mt-4 block sm:max-w-sm"
                        htmlFor="partner-book-preferred-time"
                      >
                        <span className="text-sm font-semibold text-slate-700">
                          General time preference
                        </span>
                        <select
                          id="partner-book-preferred-time"
                          value={form.preferredTimeOfDay}
                          onChange={(event) =>
                            update(
                              "preferredTimeOfDay",
                              event.target
                                .value as WizardForm["preferredTimeOfDay"],
                            )
                          }
                          className={partnerFieldClass}
                        >
                          <option value="anytime">Any time that day</option>
                          <option value="morning">Morning preferred</option>
                          <option value="afternoon">Afternoon preferred</option>
                        </select>
                      </label>
                      {fieldErrors["preferredWindows"] ? (
                        <p
                          id="partner-book-preferred-error"
                          className="mt-3 text-sm font-medium text-rose-700"
                        >
                          {fieldErrors["preferredWindows"]}
                        </p>
                      ) : null}
                      <p className="mt-3 text-xs leading-5 text-slate-600">
                        Preferences are shown in{" "}
                        {selectedTimezone.replace(/_/gu, " ")} and are not a
                        reservation.
                      </p>
                    </fieldset>
                    <fieldset className="mt-5 border-t border-amber-200 pt-5">
                      <legend className="text-sm font-semibold text-slate-900">
                        Scheduling follow-up
                      </legend>
                      <p className="mt-1 text-sm leading-6 text-slate-700">
                        Choose whether this request should enter Stonegate’s
                        scheduling queue after you send it.
                      </p>
                      <div className="mt-3 grid gap-2">
                        {PARTNER_SCHEDULE_ASSISTANCE_OPTIONS.map(
                          ({ value, label, detail }) => (
                            <label
                              key={value}
                              className="flex min-h-14 cursor-pointer items-start gap-3 rounded-xl border border-amber-200 bg-white px-4 py-3 text-sm transition hover:border-amber-400 focus-within:ring-2 focus-within:ring-accent-500"
                            >
                              <input
                                type="radio"
                                name="partner-book-schedule-assistance"
                                value={value}
                                checked={
                                  form.scheduleAssistancePreference === value
                                }
                                onChange={() =>
                                  update("scheduleAssistancePreference", value)
                                }
                                className="mt-1 h-4 w-4 accent-primary-700"
                              />
                              <span>
                                <span className="block font-semibold text-slate-950">
                                  {label}
                                </span>
                                <span className="mt-0.5 block leading-5 text-slate-600">
                                  {detail}
                                </span>
                              </span>
                            </label>
                          ),
                        )}
                      </div>
                      <p className="mt-4 text-sm leading-6 text-slate-700">
                        Need urgent scheduling help?{" "}
                        <a
                          href={`tel:${supportPhoneE164}`}
                          className="inline-flex min-h-11 items-center font-semibold text-primary-800 underline underline-offset-4"
                        >
                          Call {supportPhoneDisplay}
                        </a>
                        . Calling does not reserve capacity.
                      </p>
                    </fieldset>
                  </div>
                ) : null}
                {!availabilityLoading && windowsByDate.length > 0 ? (
                  <div className="mt-6 space-y-5">
                    {rankedAlternatives.length ? (
                      <section
                        aria-labelledby="partner-book-recommended-windows"
                        className="rounded-2xl border border-primary-200 bg-primary-50/60 p-4"
                      >
                        <h3
                          id="partner-book-recommended-windows"
                          className="text-sm font-semibold text-slate-950"
                        >
                          Recommended available windows
                        </h3>
                        <p className="mt-1 text-sm leading-6 text-slate-600">
                          Ranked by your preferred dates, earliest availability,
                          and remaining capacity.
                        </p>
                        <div className="mt-3 grid gap-2 sm:grid-cols-3">
                          {rankedAlternatives.map((window) => {
                            const selected =
                              hold?.arrivalWindowStartAt === window.startAt &&
                              hold.arrivalWindowEndAt === window.endAt;
                            return (
                              <button
                                key={`recommended-${window.id}`}
                                type="button"
                                onClick={() => void chooseWindow(window.id)}
                                disabled={availabilityLoading}
                                aria-pressed={selected}
                                className={cn(
                                  "min-h-14 rounded-xl border px-3 py-2 text-left text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500",
                                  selected
                                    ? "border-primary-700 bg-primary-700 text-white"
                                    : "border-primary-200 bg-white text-slate-700 hover:border-primary-500",
                                )}
                              >
                                <span className="block font-semibold">
                                  {formatDate(
                                    window.localDate,
                                    selectedTimezone,
                                  )}
                                </span>
                                <span className="mt-0.5 block">
                                  {formatTime(window.startAt, selectedTimezone)}
                                  –{formatTime(window.endAt, selectedTimezone)}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </section>
                    ) : null}
                    {windowsByDate.map(([date, windows]) => (
                      <fieldset
                        key={date}
                        className="rounded-2xl border border-slate-200 p-4"
                      >
                        <legend className="px-1 text-sm font-semibold text-slate-950">
                          {formatDate(date, selectedTimezone)}
                        </legend>
                        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                          {windows.map((window) => {
                            const selected =
                              hold?.arrivalWindowStartAt === window.startAt &&
                              hold.arrivalWindowEndAt === window.endAt;
                            return (
                              <button
                                key={window.id}
                                type="button"
                                onClick={() => void chooseWindow(window.id)}
                                disabled={availabilityLoading}
                                aria-pressed={selected}
                                aria-label={`${formatTime(window.startAt, selectedTimezone)} to ${formatTime(window.endAt, selectedTimezone)} arrival window`}
                                className={cn(
                                  "min-h-12 rounded-xl border px-3 py-2 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500",
                                  selected
                                    ? "border-primary-700 bg-primary-700 text-white"
                                    : "border-slate-300 bg-white text-slate-700 hover:border-primary-400 hover:bg-primary-50",
                                )}
                              >
                                {formatTime(window.startAt, selectedTimezone)}–
                                {formatTime(window.endAt, selectedTimezone)}
                              </button>
                            );
                          })}
                        </div>
                      </fieldset>
                    ))}
                  </div>
                ) : null}
                {hold ? (
                  <PartnerNotice tone="success" className="mt-5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        <strong>Arrival window held:</strong>{" "}
                        {formatDate(
                          hold.arrivalWindowStartAt.slice(0, 10),
                          selectedTimezone,
                        )}{" "}
                        at{" "}
                        {formatTime(
                          hold.arrivalWindowStartAt,
                          selectedTimezone,
                        )}
                        –{formatTime(hold.arrivalWindowEndAt, selectedTimezone)}
                      </span>
                      <span
                        className="inline-flex items-center gap-1 font-semibold tabular-nums"
                        aria-hidden="true"
                      >
                        <Clock3 className="h-4 w-4" aria-hidden="true" />
                        {holdMinutes}:{holdRemainder}
                      </span>
                      <span className="sr-only">
                        This temporary hold expires at{" "}
                        {formatTime(hold.expiresAt, selectedTimezone)}.
                      </span>
                    </div>
                  </PartnerNotice>
                ) : null}
              </div>
            ) : null}

            {step === 5 ? (
              <div className="space-y-5">
                <PartnerNotice tone="info">
                  {hold
                    ? "Review the request before sending it. Submission will use the live arrival window currently held for this draft."
                    : "Review the request before sending it. This is a review request only: preferred dates will be sent without reserving capacity or promising an arrival window."}
                </PartnerNotice>
                <nav aria-label="Edit booking sections">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Edit before sending
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {[
                      [0, "Location"],
                      [1, "Service & scope"],
                      [2, "Contact & access"],
                      [3, "Photos & proof"],
                      [4, "Schedule"],
                    ].map(([target, label]) => (
                      <button
                        key={label}
                        type="button"
                        onClick={() => editReviewStep(Number(target))}
                        className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:border-primary-400 hover:bg-primary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                      >
                        Edit {label}
                      </button>
                    ))}
                  </div>
                </nav>
                <dl className="grid gap-4 sm:grid-cols-2">
                  <div className="rounded-xl border border-slate-200 p-4">
                    <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Location
                    </dt>
                    <dd className="mt-1 font-semibold text-slate-950">
                      {location?.name ?? "Not selected"}
                    </dd>
                    <dd className="mt-1 text-sm text-slate-600">
                      {location?.address}
                    </dd>
                  </div>
                  <div className="rounded-xl border border-slate-200 p-4">
                    <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Service
                    </dt>
                    <dd className="mt-1 font-semibold text-slate-950">
                      {service?.label ?? form.serviceKey}
                    </dd>
                    {selectedBaseOption ? (
                      <dd className="mt-1 text-sm font-medium text-slate-700">
                        {selectedBaseOption.label}
                      </dd>
                    ) : null}
                    <dd className="mt-1 text-sm text-slate-600">
                      {form.description}
                    </dd>
                    {selectedServiceAddOns.length ? (
                      <dd className="mt-3 border-t border-slate-200 pt-3 text-sm text-slate-700">
                        <span className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                          Add-ons
                        </span>
                        <ul className="mt-1 space-y-1">
                          {selectedServiceAddOns.map((addOn) => (
                            <li key={addOn.key}>
                              {addOn.label} × {form.addOnQuantities[addOn.key]}
                            </li>
                          ))}
                        </ul>
                      </dd>
                    ) : null}
                    {form.restrictedItems || form.nonStandard ? (
                      <dd className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-950">
                        <span className="block font-semibold">
                          Stonegate review requested
                        </span>
                        <ul className="mt-1 list-disc space-y-1 pl-5">
                          {form.restrictedItems ? (
                            <li>
                              Potentially restricted or special-handling
                              material
                            </li>
                          ) : null}
                          {form.nonStandard ? (
                            <li>
                              Oversized, unusually heavy, or non-standard work
                            </li>
                          ) : null}
                        </ul>
                      </dd>
                    ) : null}
                  </div>
                  {availability?.pricing ? (
                    <div className="rounded-xl border border-slate-200 p-4 sm:col-span-2">
                      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        {service
                          ? priceStateLabel(service.priceState)
                          : "Account price"}
                      </dt>
                      {availability.pricing.total ? (
                        <dd className="mt-2 space-y-2 text-sm text-slate-700">
                          {availability.pricing.baseAmount ? (
                            <span className="flex justify-between gap-3">
                              <span>{service?.label ?? "Base service"}</span>
                              <span className="font-semibold text-slate-950">
                                {formatMoney(availability.pricing.baseAmount)}
                              </span>
                            </span>
                          ) : null}
                          {availability.pricing.addOns.map((addOn) => (
                            <span
                              key={addOn.key}
                              className="flex justify-between gap-3"
                            >
                              <span>
                                {addOn.label} × {addOn.quantity}
                              </span>
                              <span className="font-semibold text-slate-950">
                                {addOn.lineTotal
                                  ? formatMoney(addOn.lineTotal)
                                  : "Review"}
                              </span>
                            </span>
                          ))}
                          <span className="flex justify-between gap-3 border-t border-slate-200 pt-2 text-base font-semibold text-slate-950">
                            <span>Total</span>
                            <span>
                              {formatMoney(availability.pricing.total)}
                            </span>
                          </span>
                        </dd>
                      ) : (
                        <dd className="mt-2 text-sm leading-6 text-slate-700">
                          {availability.pricing.status === "hidden"
                            ? "Your role can submit this scope, but account pricing is available only to authorized billing and rate users."
                            : availability.pricing.status === "quote_required"
                              ? "This entitled service requires a Quote V2. Stonegate will review the request and issue a proposal before any price becomes final."
                              : "Stonegate will confirm the complete service and add-on price during review before it becomes final."}
                        </dd>
                      )}
                      {availability.pricing.total &&
                      availability.pricing.status !== "contracted" ? (
                        <dd className="mt-2 rounded-lg bg-amber-50 p-3 text-sm leading-6 text-amber-950">
                          This amount is{" "}
                          {humanizePriceState(availability.pricing.status)} and
                          is not a final contracted price. Stonegate will
                          confirm or issue a quote during review.
                        </dd>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="rounded-xl border border-slate-200 p-4">
                    <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      On-site contact
                    </dt>
                    <dd className="mt-1 font-semibold text-slate-950">
                      {form.contactName}
                    </dd>
                    <dd className="mt-1 text-sm text-slate-600">
                      {form.contactPhone || form.contactEmail}
                    </dd>
                  </div>
                  <div className="rounded-xl border border-slate-200 p-4">
                    <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      {hold ? "Held arrival window" : "Preferred schedule"}
                    </dt>
                    <dd className="mt-1 font-semibold text-slate-950">
                      {hold
                        ? `${formatTime(hold.arrivalWindowStartAt, selectedTimezone)}–${formatTime(hold.arrivalWindowEndAt, selectedTimezone)}`
                        : `${preferredDates.length} preferred date${preferredDates.length === 1 ? "" : "s"}`}
                    </dd>
                    <dd className="mt-1 text-sm text-slate-600">
                      {hold
                        ? formatDate(
                            hold.arrivalWindowStartAt.slice(0, 10),
                            selectedTimezone,
                          )
                        : preferredDates
                            .map((date) => formatDate(date, selectedTimezone))
                            .join(" · ")}
                    </dd>
                    {!hold ? (
                      <dd className="mt-1 text-xs font-medium text-amber-800">
                        {form.preferredTimeOfDay === "morning"
                          ? "Morning preferred"
                          : form.preferredTimeOfDay === "afternoon"
                            ? "Afternoon preferred"
                            : "Any time on those dates"}
                        {" — not reserved"}
                      </dd>
                    ) : null}
                    {!hold &&
                    scheduleAssistanceSummary(
                      form.scheduleAssistancePreference,
                    ) ? (
                      <dd className="mt-2 text-sm font-semibold text-slate-800">
                        {scheduleAssistanceSummary(
                          form.scheduleAssistancePreference,
                        )}
                      </dd>
                    ) : null}
                  </div>
                  {form.poNumber ||
                  form.costCenter ||
                  form.projectReference ||
                  form.billingContactName ? (
                    <div className="rounded-xl border border-slate-200 p-4 sm:col-span-2">
                      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Commercial references
                      </dt>
                      <dd className="mt-2 grid gap-3 text-sm text-slate-700 sm:grid-cols-3">
                        {form.poNumber ? (
                          <span>
                            <span className="block text-xs font-semibold text-slate-500">
                              PO / work order
                            </span>
                            <span className="mt-1 block font-semibold text-slate-950">
                              {form.poNumber}
                            </span>
                          </span>
                        ) : null}
                        {form.costCenter ? (
                          <span>
                            <span className="block text-xs font-semibold text-slate-500">
                              Cost center
                            </span>
                            <span className="mt-1 block font-semibold text-slate-950">
                              {form.costCenter}
                            </span>
                          </span>
                        ) : null}
                        {form.projectReference ? (
                          <span>
                            <span className="block text-xs font-semibold text-slate-500">
                              Project / listing
                            </span>
                            <span className="mt-1 block font-semibold text-slate-950">
                              {form.projectReference}
                            </span>
                          </span>
                        ) : null}
                        {form.billingContactName ? (
                          <span>
                            <span className="block text-xs font-semibold text-slate-500">
                              Billing contact
                            </span>
                            <span className="mt-1 block font-semibold text-slate-950">
                              {form.billingContactName}
                            </span>
                            <span className="block text-slate-600">
                              {form.billingContactEmail}
                            </span>
                          </span>
                        ) : null}
                      </dd>
                    </div>
                  ) : null}
                  <div className="rounded-xl border border-slate-200 p-4 sm:col-span-2">
                    <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Photos &amp; proof
                    </dt>
                    <dd className="mt-1 text-sm text-slate-700">
                      {[
                        form.proofBefore
                          ? `${form.proofBeforeCount} before photo${form.proofBeforeCount === 1 ? "" : "s"}`
                          : null,
                        form.proofAfter
                          ? `${form.proofAfterCount} after photo${form.proofAfterCount === 1 ? "" : "s"}`
                          : null,
                        form.proofPackage ? "Formal package" : null,
                      ]
                        .filter(Boolean)
                        .join(", ") || "No specific proof requested"}
                    </dd>
                    <dd className="mt-1 text-xs text-slate-500">
                      {draftPhotoCount} reference photo
                      {draftPhotoCount === 1 ? "" : "s"} attached to this
                      request
                    </dd>
                  </div>
                </dl>
                <section
                  id="partner-book-cancellation-terms"
                  aria-labelledby="partner-book-cancellation-terms-title"
                  className="rounded-xl border border-slate-300 bg-slate-50 p-4"
                >
                  <h3
                    id="partner-book-cancellation-terms-title"
                    className="text-sm font-semibold text-slate-950"
                  >
                    Cancellation and schedule-change terms
                  </h3>
                  <p className="mt-1 text-sm leading-6 text-slate-700">
                    {cancellationPolicy.directCancellationEnabled
                      ? "Once confirmed, this account may cancel or move a job directly until " +
                        formatCancellationNotice(
                          cancellationPolicy.minimumNoticeMinutes,
                        ) +
                        " before the promised arrival window."
                      : "Once confirmed, this account requires Stonegate staff review for cancellation and schedule-change requests."}{" "}
                    Requests at or after the effective cutoff keep the existing
                    job scheduled while Stonegate reviews the requested change.
                  </p>
                  <p className="mt-1 text-sm font-medium leading-6 text-slate-800">
                    No cancellation fee is applied automatically. The current
                    account policy is rechecked when a cancellation or schedule
                    change is requested.
                  </p>
                  {cancellationPolicy.source === "unconfigured" ? (
                    <p className="mt-2 text-sm font-medium text-amber-900">
                      This account’s persisted policy is unavailable, so
                      confirmed-job changes default to staff review.
                    </p>
                  ) : null}
                  <p className="mt-2 text-sm leading-6 text-slate-700">
                    Review Stonegate’s{" "}
                    <Link
                      href="/terms"
                      className="font-semibold text-primary-800 underline underline-offset-4"
                    >
                      terms
                    </Link>{" "}
                    and{" "}
                    <Link
                      href="/service-agreement"
                      className="font-semibold text-primary-800 underline underline-offset-4"
                    >
                      service agreement
                    </Link>
                    .
                  </p>
                </section>
                {availability?.reviewReasons.length || !hold ? (
                  <PartnerNotice tone="warning">
                    This request will be sent to Stonegate for review. Any time
                    or date shown as a preference remains unreserved until staff
                    confirms it, and you’ll see the current status immediately
                    after sending.
                  </PartnerNotice>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="mt-8 flex flex-col-reverse gap-3 border-t border-slate-200 pt-5 sm:flex-row sm:items-center sm:justify-between">
            <button
              type="button"
              onClick={() => editReviewStep(Math.max(0, step - 1))}
              disabled={step === 0 || submitting || advancing}
              className={cn(partnerSecondaryButtonClass, "w-full sm:w-auto")}
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Back
            </button>
            {step < 5 ? (
              <button
                type="button"
                onClick={() => void goNext()}
                data-partner-analytics="booking_step_continue"
                disabled={
                  !draft ||
                  saveStatus === "creating" ||
                  advancing ||
                  availabilityLoading ||
                  (step === 4 && !hold && !preferredReviewReady)
                }
                className={cn(partnerPrimaryButtonClass, "w-full sm:w-auto")}
              >
                {advancing ? "Saving step…" : "Continue"}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void submitBooking()}
                data-partner-analytics="booking_submit"
                aria-describedby="partner-book-cancellation-terms"
                disabled={
                  submitting ||
                  (hold ? holdSeconds <= 0 : !preferredReviewReady)
                }
                className={cn(partnerPrimaryButtonClass, "w-full sm:w-auto")}
              >
                {submitting ? (
                  <>
                    <LoaderCircle
                      className="h-4 w-4 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                    Sending request…
                  </>
                ) : (
                  <>
                    Send service request
                    <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </PartnerPanel>
    </div>
  );
}
