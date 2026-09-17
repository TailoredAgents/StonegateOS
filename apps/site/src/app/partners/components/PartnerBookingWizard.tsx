"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  CalendarClock,
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
  X,
} from "lucide-react";
import { cn } from "@myst-os/ui";
import { usePartnerUnsavedChanges } from "../lib/use-partner-unsaved-changes";
import {
  createPortalOperationKey,
  partnerPortalFetch,
  portalSupportReferenceFromResponse,
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
import {
  PartnerDraftPhotoUpload,
  type DraftPhotoUploadPhase,
} from "./PartnerDraftPhotoUpload";
import { PartnerBookingDetailsRow } from "./PartnerBookingDetailsRow";
import {
  PartnerWorkQuestions,
  PartnerAccessQuestions,
  PartnerMaterialsQuestion,
  PartnerCompletionDeadline,
  PartnerAdditionalAddresses,
  type PartnerRequestScopeValues,
} from "./PartnerRequestQuestions";
import { PartnerSavedScopeDetails } from "./PartnerSavedScopeDetails";
import {
  bookingFieldStep,
  bookingFieldElementId,
  bookingErrorSection,
  focusBookingField,
} from "../lib/booking-field-focus";
import { PartnerSavedRequests } from "./PartnerSavedRequests";
import { PartnerInlineLocationForm } from "./PartnerInlineLocationForm";
import {
  sortBookingLocations,
  toBookingLocation,
  isPartnerLocation,
  type BookingLocation,
} from "../lib/booking-location";
import type { PartnerLocation } from "../lib/portal-v2";
import {
  parseBookingAvailability,
  parseBookingDraft,
  parseBookingValidation,
} from "../lib/booking-page-data";

export type BookingWizardLocation = BookingLocation;

export type BookingWizardService = {
  key: string;
  label: string;
  detail?: string;
  pricingStatus?: "contracted" | "review_required" | "hidden";
  bookable: boolean;
  requiredScopeFields?: readonly string[];
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

type WizardForm = PartnerRequestScopeValues & {
  locationId: string;
  serviceKey: string;
  tierKey: string;
  addOnQuantities: Record<string, number>;
  description: string;
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
  { label: "Service address", shortLabel: "Address", icon: MapPin },
  { label: "Service details", shortLabel: "Details", icon: Truck },
  {
    label: "Scheduling",
    shortLabel: "Scheduling",
    icon: CalendarClock,
  },
  { label: "Review and submit", shortLabel: "Review", icon: ShieldCheck },
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
    serviceKey: draft.serviceKey ?? "",
    tierKey: draft.tierKey ?? "",
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
    // A saved blank is intentional; do not restore location instructions the
    // client already removed from this request.
    accessDetails: draft.accessDetails ?? "",
    contactName: draft.onSiteContact
      ? recordString(draft.onSiteContact, "name")
      : (defaults.contactName ?? ""),
    contactPhone: draft.onSiteContact
      ? recordString(draft.onSiteContact, "phone")
      : (defaults.contactPhone ?? ""),
    contactEmail: draft.onSiteContact
      ? recordString(draft.onSiteContact, "email")
      : (defaults.contactEmail ?? ""),
    proofBefore:
      typeof draft.proofRequirements["before"] === "number"
        ? draft.proofRequirements["before"] > 0
        : draft.proofRequirements["before"] !== false,
    proofBeforeCount:
      typeof draft.proofRequirements["before"] === "number" &&
      Number.isSafeInteger(draft.proofRequirements["before"]) &&
      draft.proofRequirements["before"] >= 0 &&
      draft.proofRequirements["before"] <= 20
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
      draft.proofRequirements["after"] <= 20
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

function localErrorsForStep(
  step: number,
  form: WizardForm,
  service?: BookingWizardService,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (step === 0 && !form.locationId)
    errors["locationId"] = "Enter a service address or choose a saved address.";
  if (step === 0 && form.multiStop && !form.multiStopDetails.trim())
    errors["scope.multiStopDetails"] =
      "Add the other service addresses and the order of the stops.";
  if (step === 2 && form.requiredCompletionTime && !form.requiredCompletionDate)
    errors["scope.requiredCompletion.localDate"] =
      "Add a completion date for the time you entered, or clear the time.";
  if (step === 1) {
    const required = new Set(
      (service?.requiredScopeFields ?? []).map((field) =>
        field.replace(/^scope\./u, ""),
      ),
    );
    if (required.has("itemCount") && !form.itemCount.trim())
      errors["scope.itemCount"] =
        "Enter the item count required for this service.";
    if (required.has("volumeCubicYards") && !form.volume.trim())
      errors["scope.volumeCubicYards"] =
        "Enter the estimated volume required for this service.";
    if (!form.serviceKey) errors["serviceKey"] = "Choose a service.";
    else if (!service || !service.bookable) {
      errors["serviceKey"] =
        "This service is no longer available. Choose another service to continue.";
    }
    if ((service?.baseOptions?.length ?? 0) > 0 && !form.tierKey) {
      errors["tierKey"] = "Choose a base service option.";
    }
    if (!form.description.trim())
      errors["description"] = "Describe the work to be completed.";
    if (
      form.itemCount.trim() &&
      (!Number.isSafeInteger(Number(form.itemCount)) ||
        Number(form.itemCount) < 0)
    ) {
      errors["scope.itemCount"] = "Enter a whole item count of zero or more.";
    }
    if (
      form.volume.trim() &&
      (!Number.isFinite(Number(form.volume)) || Number(form.volume) < 0)
    ) {
      errors["scope.volumeCubicYards"] = "Enter a volume of zero or more.";
    }
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
  if (step === 1) {
    if (!form.contactName.trim())
      errors["onSiteContact"] = "Add the on-site contact’s name.";
    if (!form.contactPhone.trim() && !form.contactEmail.trim()) {
      errors["contactMethod"] =
        "Add a phone number or email for the on-site contact.";
    }
  }
  return errors;
}

export function PartnerBookingWizard(
  props: React.ComponentProps<typeof PartnerBookingWizardSession>,
) {
  // Resource changes must reset every state/ref, including upload and hold state.
  return (
    <PartnerBookingWizardSession
      key={props.initialDraft?.id ?? "new"}
      {...props}
    />
  );
}

function PartnerBookingWizardSession({
  locations,
  services,
  initialDraft = null,
  defaultLocationId = "",
  defaultServiceKey = "",
  canUploadPhotos = false,
  instantConfirmationAvailable = false,
  canManageLocations = false,
  defaultProofRequirements = { before: 1, after: 1 },
  cancellationPolicy,
  persona,
  supportPhoneE164,
  supportPhoneDisplay,
  requesterContact,
  canDiscardDrafts = false,
}: {
  locations: BookingWizardLocation[];
  services: BookingWizardService[];
  initialDraft?: PartnerDraft | null;
  defaultLocationId?: string;
  defaultServiceKey?: string;
  canUploadPhotos?: boolean;
  instantConfirmationAvailable?: boolean;
  canManageLocations?: boolean;
  defaultProofRequirements?: { before: number; after: number };
  cancellationPolicy: BookingWizardCancellationPolicy;
  persona: string | null;
  supportPhoneE164: string;
  supportPhoneDisplay: string;
  requesterContact?: { name: string; phone: string; email: string };
  canDiscardDrafts?: boolean;
}) {
  const router = useRouter();
  const personaPresentation = getPartnerPersonaPresentation(persona);
  const initialLocation = locations.find(
    (item) => item.id === (initialDraft?.locationId || defaultLocationId),
  );
  const initialContact = initialLocation?.contact?.name
    ? initialLocation.contact
    : requesterContact;
  const defaultSelectedServiceKey =
    defaultServiceKey ||
    (services.length === 1 && services[0]?.bookable ? services[0].key : "");
  const defaultSelectedService = services.find(
    (service) => service.key === defaultSelectedServiceKey,
  );
  const [form, setForm] = React.useState<WizardForm>(() =>
    formFromDraft(initialDraft, {
      locationId: defaultLocationId,
      contactName: initialContact?.name ?? "",
      contactPhone: initialContact?.phone ?? "",
      contactEmail: initialContact?.email ?? "",
      accessDetails: initialLocation?.accessDetails ?? "",
      preferredTimezone:
        locations.find(
          (location) =>
            location.id === (initialDraft?.locationId || defaultLocationId),
        )?.timezone ?? "America/New_York",
      serviceKey: defaultSelectedServiceKey,
      proofBefore: defaultProofRequirements.before > 0,
      proofBeforeCount: Math.max(1, defaultProofRequirements.before),
      proofAfter: defaultProofRequirements.after > 0,
      proofAfterCount: Math.max(1, defaultProofRequirements.after),
      tierKey:
        defaultSelectedService?.baseOptions?.length === 1
          ? defaultSelectedService.baseOptions[0]?.tierKey
          : "",
    }),
  );
  const [draft, setDraft] = React.useState<PartnerDraft | null>(initialDraft);
  const [draftCreationAttempt, setDraftCreationAttempt] = React.useState(0);
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
  const [submissionUncertain, setSubmissionUncertain] = React.useState(false);
  const submissionAttemptRef = React.useRef<{
    draftId: string;
    etag: string;
    holdId: string | null;
  } | null>(null);
  const [advancing, setAdvancing] = React.useState(false);
  const [draftPhotoCount, setDraftPhotoCount] = React.useState<number | null>(
    null,
  );
  const [errorFocusRequest, setErrorFocusRequest] = React.useState(0);
  const errorSummaryRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (errorFocusRequest > 0) errorSummaryRef.current?.focus();
  }, [errorFocusRequest]);
  const [pendingPhotos, setPendingPhotos] = React.useState(false);
  const [photoPhase, setPhotoPhase] =
    React.useState<DraftPhotoUploadPhase>("idle");
  const photosInProgress = [
    "preparing",
    "starting",
    "uploading",
    "saving",
  ].includes(photoPhase);
  const [showPersonaSuggestions, setShowPersonaSuggestions] =
    React.useState(false);
  const [personaFeedback, setPersonaFeedback] = React.useState<string | null>(
    null,
  );
  const [availableLocations, setAvailableLocations] =
    React.useState<BookingWizardLocation[]>(locations);
  const [addressEntryMode, setAddressEntryMode] = React.useState<
    "new" | "saved"
  >(canManageLocations ? "new" : "saved");
  const [addressSaving, setAddressSaving] = React.useState(false);
  const [addressDirty, setAddressDirty] = React.useState(false);
  const addressFormId = React.useId();
  const [locationSearch, setLocationSearch] = React.useState("");
  const [locationSearching, setLocationSearching] = React.useState(false);
  const [locationSearchError, setLocationSearchError] = React.useState<
    string | null
  >(null);
  const [locationSearchResults, setLocationSearchResults] = React.useState<
    BookingWizardLocation[] | null
  >(null);
  const [selectedDate, setSelectedDate] = React.useState("");
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
  const latestFormRef = React.useRef(form);
  latestFormRef.current = form;
  const createDraftOperationRef = React.useRef(
    createPortalOperationKey("booking-draft"),
  );
  const progressLoadedRef = React.useRef(false);
  React.useEffect(() => {
    if (progressLoadedRef.current || !initialDraft?.id) return;
    progressLoadedRef.current = true;
    try {
      const saved = Number(
        sessionStorage.getItem(`partner-request-step:${initialDraft.id}`),
      );
      // Time choices are always rechecked, never restored as an unverified promise.
      if (Number.isInteger(saved) && saved > 0) {
        setStep(1);
        setFurthestStep(1);
      }
    } catch {
      /* Storage can be unavailable in private browsing. */
    }
  }, [initialDraft?.id]);
  React.useEffect(() => {
    if (!draft?.id) return;
    try {
      sessionStorage.setItem(`partner-request-step:${draft.id}`, String(step));
    } catch {
      /* Saving the server draft does not depend on browser storage. */
    }
  }, [draft?.id, step]);

  React.useEffect(() => {
    setShowPersonaSuggestions(false);
    setPersonaFeedback(null);
  }, [personaPresentation.key]);

  React.useEffect(() => {
    if (!locationSearch.trim()) {
      setLocationSearchResults(null);
      setLocationSearchError(null);
      setLocationSearching(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLocationSearching(true);
      setLocationSearchError(null);
      void partnerPortalFetch<{ ok: true; locations: PartnerLocation[] }>(
        `locations?active=true&limit=100&search=${encodeURIComponent(locationSearch.trim())}`,
        { signal: controller.signal },
      )
        .then((result) => {
          if (controller.signal.aborted) return;
          if (!result.ok) {
            setLocationSearchError(result.error.message);
            return;
          }
          if (
            !Array.isArray(result.data.locations) ||
            !result.data.locations.every(isPartnerLocation)
          ) {
            setLocationSearchError(
              withPortalSupportReference(
                "Locations could not be searched. Please try again.",
                portalSupportReferenceFromResponse(result.response),
              ),
            );
            return;
          }
          const found = result.data.locations.map(toBookingLocation);
          setLocationSearchResults(sortBookingLocations(found));
          setAvailableLocations((current) => [
            ...new Map(
              [...current, ...found].map((item) => [item.id, item]),
            ).values(),
          ]);
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setLocationSearchError(
              "Locations could not be searched. Please try again.",
            );
        })
        .finally(() => {
          if (!controller.signal.aborted) setLocationSearching(false);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [locationSearch]);

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
          "Idempotency-Key": createDraftOperationRef.current,
        },
        body: JSON.stringify(draftMutation(initialFormRef.current)),
      }).catch(() => null);
      if (!active) return;
      if (!result?.ok) {
        setSaveStatus("error");
        setMessage(
          result?.error.message ??
            "We couldn’t start your saved request. Try again or contact Stonegate.",
        );
        return;
      }
      const createdDraft = parseBookingDraft(result.data);
      if (!createdDraft) {
        setSaveStatus("error");
        setMessage(
          withPortalSupportReference(
            "We couldn’t check whether your saved request was started. Try again to safely recover the same request.",
            portalSupportReferenceFromResponse(result.response),
          ),
        );
        return;
      }
      setCurrentDraft(createdDraft);
      const savedUrl = new URL(window.location.href);
      savedUrl.searchParams.set("draftId", createdDraft.id);
      window.history.replaceState(window.history.state, "", savedUrl);
      setSaveStatus("saved");
      setMessage(null);
    };
    void createDraft();
    return () => {
      active = false;
    };
  }, [initialDraft, setCurrentDraft, draftCreationAttempt]);

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
          keepalive: true,
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
        const savedDraft = parseBookingDraft(result.data);
        if (!savedDraft || savedDraft.id !== current.id) {
          setSaveStatus("error");
          setMessage(
            withPortalSupportReference(
              "Your changes are still on this screen, but we couldn’t confirm they were saved. Try saving again before continuing.",
              portalSupportReferenceFromResponse(result.response),
            ),
          );
          return false;
        }
        setCurrentDraft(savedDraft);
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

  const hasUnsavedDraftChanges =
    saveStatus !== "saved" && !submittedRef.current;
  const hasUnsavedAddress =
    step === 0 &&
    canManageLocations &&
    addressEntryMode === "new" &&
    !form.locationId &&
    addressDirty;
  const hasUnsavedChanges =
    hasUnsavedDraftChanges || hasUnsavedAddress || pendingPhotos;

  usePartnerUnsavedChanges(hasUnsavedChanges);
  const unsavedRef = React.useRef(hasUnsavedDraftChanges);
  unsavedRef.current = hasUnsavedDraftChanges;
  React.useEffect(() => {
    // History navigation cannot reliably be canceled. Flush into this draft's
    // serialized save queue instead; no sensitive scope is stored in the browser.
    const flushOnLeave = () => {
      if (
        !draftRef.current ||
        !unsavedRef.current ||
        submittedRef.current ||
        submissionAttemptRef.current
      )
        return;
      cancelPendingAutosave();
      void persist(latestFormRef.current);
    };
    window.addEventListener("popstate", flushOnLeave);
    window.addEventListener("pagehide", flushOnLeave);
    return () => {
      window.removeEventListener("popstate", flushOnLeave);
      window.removeEventListener("pagehide", flushOnLeave);
      flushOnLeave();
    };
  }, [cancelPendingAutosave, persist]);

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
      if (seconds === 0 && !submissionAttemptRef.current) {
        setHold(null);
        setMessage(
          "That arrival-window hold expired. Your job details are saved; choose another window.",
        );
        // An expired hold must not unmount selected photos on Service details.
        if (stepRef.current !== 1) setStep(2);
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
    setFurthestStep((current) => Math.min(current, 2));
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
    if (message === "Add the highlighted details to continue.")
      setMessage(null);
    if (String(key).startsWith("proof")) setPersonaFeedback(null);
    if (key === "requiredCompletionDate" || key === "requiredCompletionTime")
      setAvailability(null);
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
      const scopeField: Partial<
        Record<keyof PartnerRequestScopeValues, string>
      > = {
        itemCount: "itemCount",
        volume: "volumeCubicYards",
        nonStandard: "nonStandard",
        restrictedItems: "restrictedItems",
        equipmentNeeds: "equipmentNeeds",
        hazardCategories: "hazardCategories",
        requiredCompletionDate: "requiredCompletion",
        requiredCompletionTime: "requiredCompletion",
        multiStop: "multiStop",
        multiStopDetails: "multiStopDetails",
      };
      const scopeRoot = scopeField[key as keyof PartnerRequestScopeValues];
      if (scopeRoot)
        for (const field of Object.keys(next)) {
          const path = field.replace(/\[(\d+)\]/gu, ".$1");
          if (
            path === `scope.${scopeRoot}` ||
            path.startsWith(`scope.${scopeRoot}.`)
          )
            delete next[field];
        }
      return next;
    });
  };
  const updateScope = <K extends keyof PartnerRequestScopeValues>(
    key: K,
    value: PartnerRequestScopeValues[K],
  ): void => update<keyof PartnerRequestScopeValues>(key, value);

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

  const focusAddressEntry = (mode: "new" | "saved"): void => {
    window.requestAnimationFrame(() => {
      if (mode === "new") {
        document
          .getElementById(addressFormId)
          ?.querySelector<HTMLInputElement>('[role="combobox"]')
          ?.focus();
      } else {
        document.getElementById("partner-location-chooser-search")?.focus();
      }
    });
  };

  const updateLocation = (
    locationId: string,
    createdLocation?: BookingWizardLocation,
  ): WizardForm => {
    releaseHeldTimeAfterEdit();
    const selected =
      createdLocation ??
      availableLocations.find((item) => item.id === locationId);
    const nextForm: WizardForm = {
      ...latestFormRef.current,
      locationId,
      preferredTimezone: selected?.timezone ?? "America/New_York",
      contactName: selected?.contact?.name || requesterContact?.name || "",
      contactPhone: selected?.contact?.phone || requesterContact?.phone || "",
      contactEmail: selected?.contact?.email || requesterContact?.email || "",
      accessDetails: selected?.accessDetails ?? "",
    };
    latestFormRef.current = nextForm;
    setForm(nextForm);
    setFieldErrors((current) => {
      const next = { ...current };
      delete next["locationId"];
      delete next["preferredWindows"];
      return next;
    });
    return nextForm;
  };

  const updateService = (serviceKey: string): void => {
    if (serviceKey === form.serviceKey) return;
    releaseHeldTimeAfterEdit();
    // A manual-review request has no hold, but its previous price and time
    // choices still belong to the old service and must be checked again.
    setAvailability(null);
    setSelectedDate("");
    setFurthestStep((current) => Math.min(current, 1));
    const validationFields = Object.keys(fieldErrors);
    if (
      saveStatus !== "error" &&
      validationFields.length > 0 &&
      validationFields.every((field) =>
        ["serviceKey", "tierKey", "selectedAddOns"].includes(field),
      )
    ) {
      setMessage(null);
    }
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
      // Focus after React commits the error summary, including async server
      // validation. A browser animation frame can run before that commit.
      setErrorFocusRequest((current) => current + 1);
    },
    [],
  );

  const loadAvailability = React.useCallback(async (): Promise<{
    availability: PartnerAvailability | null;
  } | null> => {
    const current = draftRef.current;
    if (!current) return null;
    setAvailabilityLoading(true);
    setMessage(null);
    trackPartnerFunnelEvent({
      stage: "availability_requested",
      persona,
      surface: "booking",
      step: 3,
    });
    const saved = await flushPersist(form);
    const savedDraft = draftRef.current;
    if (!saved || !savedDraft) {
      setAvailabilityLoading(false);
      return null;
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
        validated?.error.message ?? "We couldn’t check this saved request.",
      );
      if (Object.keys(errors).length) {
        const targetStep = Math.min(
          ...Object.keys(errors).map(bookingFieldStep),
        );
        setStep(targetStep);
        focusErrorSummary(errors);
      }
      return null;
    }
    const validationResult = parseBookingValidation(validated.data);
    if (!validationResult || validationResult.draft.id !== savedDraft.id) {
      setAvailabilityLoading(false);
      setMessage(
        withPortalSupportReference(
          "We couldn’t check this saved request. Your details are still on this screen. Please try again.",
          portalSupportReferenceFromResponse(validated.response),
        ),
      );
      return null;
    }
    setCurrentDraft(validationResult.draft);
    if (!validationResult.validation.valid) {
      const errors = validationResult.validation.fieldErrors;
      setAvailabilityLoading(false);
      setFieldErrors(errors);
      setMessage(
        "Add the highlighted details so we can show the right arrival windows.",
      );
      const targetStep = Math.min(...Object.keys(errors).map(bookingFieldStep));
      setStep(Number.isFinite(targetStep) ? targetStep : 1);
      focusErrorSummary(errors);
      return null;
    }
    setFieldErrors({});

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
    const nextAvailability = result?.ok
      ? parseBookingAvailability(result.data)
      : null;
    if (
      !result?.ok ||
      !nextAvailability ||
      nextAvailability.draft.id !== savedDraft.id
    ) {
      trackPartnerFunnelEvent({
        stage: "availability_degraded",
        persona,
        surface: "booking",
        step: 3,
      });
      setAvailability(null);
      setMessage(
        withPortalSupportReference(
          "This request needs a schedule review. Your details are saved; choose preferred dates and Stonegate will review them without reserving a slot.",
          result?.ok
            ? portalSupportReferenceFromResponse(result.response)
            : result?.error.correlationId,
        ),
      );
      return { availability: null };
    }
    trackPartnerFunnelEvent({
      stage: !nextAvailability.instantConfirmationEligible
        ? "availability_review_only"
        : nextAvailability.windows.some((window) => window.available)
          ? "availability_available"
          : "availability_slot_full",
      persona,
      surface: "booking",
      step: 3,
    });
    setCurrentDraft(nextAvailability.draft);
    setAvailability(nextAvailability);
    setForm((current) =>
      current.preferredTimezone === nextAvailability.timezone
        ? current
        : {
            ...current,
            preferredTimezone: nextAvailability.timezone,
          },
    );
    return { availability: nextAvailability };
  }, [flushPersist, focusErrorSummary, form, persona, setCurrentDraft]);

  const goNext = async (snapshot: WizardForm = form): Promise<void> => {
    if (advancingRef.current) return;
    advancingRef.current = true;
    setAdvancing(true);
    try {
      const localErrors = localErrorsForStep(
        step,
        snapshot,
        services.find((service) => service.key === snapshot.serviceKey),
      );
      if (Object.keys(localErrors).length) {
        setFieldErrors(localErrors);
        setMessage("Add the highlighted details to continue.");
        focusErrorSummary(localErrors);
        return;
      }
      setFieldErrors({});
      if (step === 1 && pendingPhotos) {
        showPendingPhotos();
        return;
      }
      if (step === 2 && !hold) {
        const preferredDates = [
          snapshot.preferredDateOne,
          snapshot.preferredDateTwo,
          snapshot.preferredDateThree,
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
      if (step === 1 || (step === 2 && !hold)) {
        const loaded = await loadAvailability();
        if (!loaded) return;
        if (
          step === 2 &&
          loaded.availability?.instantConfirmationEligible &&
          loaded.availability.windows.some((window) => window.available)
        ) {
          const errors = {
            preferredWindows: "Choose one of the available arrival windows.",
          };
          setFieldErrors(errors);
          setMessage(errors.preferredWindows);
          focusErrorSummary(errors);
          return;
        }
      } else if (!(await flushPersist(snapshot))) {
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
    if (submissionUncertain) {
      setMessage(
        "Retry sending to check whether this request was received before editing it. The same request will not create a duplicate job.",
      );
      return;
    }
    if (step === 1 && target !== step && pendingPhotos) {
      showPendingPhotos();
      return;
    }
    setStep(target);
    window.requestAnimationFrame(() =>
      document.getElementById("partner-book-step-heading")?.focus(),
    );
  };

  function showPendingPhotos(): void {
    setMessage(
      "Attach your selected photos, or clear the selection, before leaving Service details.",
    );
    window.requestAnimationFrame(() =>
      document.getElementById("partner-book-photos")?.focus(),
    );
  }

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
          step: 3,
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
    if (
      !current ||
      (!submissionAttemptRef.current && !hold && !preferredReviewReady)
    )
      return;
    setSubmitting(true);
    setMessage(null);
    if (!submissionAttemptRef.current) {
      const saved = await flushPersist(form);
      const savedDraft = draftRef.current;
      if (!saved || !savedDraft) {
        setSubmitting(false);
        return;
      }
      submissionAttemptRef.current = {
        draftId: savedDraft.id,
        etag: savedDraft.etag,
        holdId: hold?.id ?? null,
      };
    }
    const attempt = submissionAttemptRef.current;
    const result = await partnerPortalFetch<{
      ok: true;
      booking: { id: string; publicStatus: string; confirmationMode: string };
    }>(`booking-drafts/${attempt.draftId}/submit`, {
      method: "POST",
      headers: {
        "If-Match": attempt.etag,
        "Idempotency-Key": submitOperationKeyRef.current,
      },
      body: JSON.stringify(
        attempt.holdId
          ? { holdId: attempt.holdId }
          : { submissionMode: "review" },
      ),
    }).catch(() => null);
    if (!result?.ok) {
      trackPartnerFunnelEvent({
        stage: "booking_failed",
        persona,
        surface: "booking",
        step: 4,
      });
      setSubmitting(false);
      const uncertain = !result || result.response.status >= 500;
      setSubmissionUncertain(uncertain);
      if (!uncertain) submissionAttemptRef.current = null;
      setMessage(
        uncertain
          ? "We could not verify whether your request was received. Retry sending to check safely; this will not create a duplicate job."
          : (result?.error.message ??
              "The job was not submitted. Your request is still saved."),
      );
      if (result?.response.status === 409) {
        if (hold) {
          setHold(null);
          setStep(2);
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
      step: 4,
    });
    trackPartnerFunnelEvent({
      stage:
        result.data.booking.confirmationMode === "instant" ||
        result.data.booking.publicStatus === "confirmed"
          ? "booking_confirmed"
          : "booking_review_requested",
      persona,
      surface: "booking",
      step: 4,
    });
    router.push(
      `/partners/bookings/${encodeURIComponent(result.data.booking.id)}?created=1` as Route,
    );
    router.refresh();
  };

  const hasDetailsError = (
    section: ReturnType<typeof bookingErrorSection>,
  ): boolean =>
    Object.keys(fieldErrors).some(
      (field) => bookingErrorSection(field) === section,
    );
  const contactDetailsSummary = form.contactName.trim()
    ? [
        form.contactName.trim(),
        form.contactPhone.trim() || form.contactEmail.trim(),
        form.equipmentNeeds.includes("stairs") ? "Stairs" : "",
        form.equipmentNeeds.includes("elevator") ? "Elevator" : "",
        form.equipmentNeeds.includes("loading_dock") ? "Loading dock" : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "Add the person our crew should contact";
  const commercialDetailsSummary =
    [form.poNumber, form.projectReference, form.costCenter]
      .filter(Boolean)
      .join(" · ") ||
    (form.billingContactName
      ? `Billing contact: ${form.billingContactName}`
      : "Add a reference or billing contact if needed");
  const proofDetailsSummary =
    [
      form.proofBefore ? `Before photos: ${form.proofBeforeCount}` : "",
      form.proofAfter ? `After photos: ${form.proofAfterCount}` : "",
      form.proofPackage ? "Completion report" : "",
    ]
      .filter(Boolean)
      .join(" · ") || "Set the photos you want from the crew";

  const location = availableLocations.find(
    (item) => item.id === form.locationId,
  );
  const enteringNewAddress =
    step === 0 &&
    canManageLocations &&
    addressEntryMode === "new" &&
    !form.locationId;
  const service = services.find((item) => item.key === form.serviceKey);
  const serviceError =
    fieldErrors["serviceKey"] ??
    (form.serviceKey && (!service || !service.bookable)
      ? "Your saved service is no longer available. Choose another service. Your other request details have been kept."
      : null);
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
  const visibleDate = windowsByDate.some(([date]) => date === selectedDate)
    ? selectedDate
    : (windowsByDate[0]?.[0] ?? "");
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
      data-booking-step={step}
    >
      <PartnerPanel className="overflow-hidden p-0 sm:p-0">
        <div className="border-b border-slate-200 bg-slate-50 px-4 py-4 sm:px-6">
          <ol
            className="grid grid-cols-4 gap-2"
            aria-label="Service request progress"
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
                      disabled={
                        advancing ||
                        addressSaving ||
                        submitting ||
                        availabilityLoading
                      }
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

        <div className={cn("p-5 sm:p-7", step === 1 && "sm:px-8 sm:py-6")}>
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
              {step === 1 ? (
                <p className="mt-1 text-sm text-slate-500">
                  Describe the work and add any helpful photos.
                </p>
              ) : null}
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
                  {saveStatus === "creating" ? "Starting request…" : "Saving…"}
                </span>
              ) : saveStatus === "saved" && hasUnsavedAddress ? (
                <span className="inline-flex items-center gap-1.5 text-amber-800">
                  <CircleAlert className="h-3.5 w-3.5" aria-hidden="true" />
                  Address not saved
                </span>
              ) : saveStatus === "saved" && pendingPhotos ? (
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5",
                    photosInProgress ? "text-primary-700" : "text-amber-800",
                  )}
                >
                  {photosInProgress ? (
                    <LoaderCircle
                      className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  ) : (
                    <CircleAlert className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {photoPhase === "preparing"
                    ? "Preparing photos…"
                    : photoPhase === "starting"
                      ? "Starting photo upload…"
                      : photoPhase === "uploading"
                        ? "Uploading photos…"
                        : photoPhase === "saving"
                          ? "Saving photos…"
                          : photoPhase === "error"
                            ? "Photos need attention"
                            : "Photos ready to attach"}
                </span>
              ) : saveStatus === "saved" ? (
                <span className="inline-flex items-center gap-1.5 text-emerald-700">
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                  Saved
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
              ref={errorSummaryRef}
              className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-950 outline-none focus-visible:ring-2 focus-visible:ring-rose-600 focus-visible:ring-offset-2"
              role="alert"
              aria-labelledby="partner-book-error-summary-heading"
              tabIndex={-1}
            >
              <h3
                id="partner-book-error-summary-heading"
                className="font-semibold"
              >
                Check the highlighted details
              </h3>
              {message ? <p className="mt-1">{message}</p> : null}
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {Object.entries(fieldErrors).map(([field, error]) => {
                  const targetId = bookingFieldElementId(field);
                  return (
                    <li key={field}>
                      <a
                        href={`#${targetId}`}
                        className="font-medium underline decoration-rose-400 underline-offset-2 hover:decoration-rose-700"
                        onClick={(event) => {
                          event.preventDefault();
                          setStep(bookingFieldStep(field));
                          window.requestAnimationFrame(() =>
                            focusBookingField(field),
                          );
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

          {saveStatus === "error" ? (
            <button
              type="button"
              className={cn(partnerSecondaryButtonClass, "mt-3")}
              onClick={() => {
                if (draftRef.current) void flushPersist(form);
                else {
                  setSaveStatus("creating");
                  setDraftCreationAttempt((attempt) => attempt + 1);
                }
              }}
            >
              Try saving again
            </button>
          ) : null}

          <fieldset
            className="mt-6 min-w-0"
            disabled={
              advancing || availabilityLoading || submitting || addressSaving
            }
          >
            <legend className="sr-only">{STEPS[step]?.label}</legend>
            {step === 0 ? (
              <fieldset
                id="partner-book-location"
                tabIndex={-1}
                className="min-w-0 focus:outline-none"
              >
                <legend className="sr-only">Service address details</legend>
                <p className="text-sm leading-6 text-slate-600">
                  {location
                    ? "Service will be requested at the address below."
                    : canManageLocations && addressEntryMode === "new"
                      ? "Enter the address where service is needed. Select Continue to save this address and proceed."
                      : "Select an address saved to your company account."}
                </p>

                {location ? (
                  <div
                    id="partner-book-selected-address"
                    tabIndex={-1}
                    data-selected-location-id={location.id}
                    className="mt-4 rounded-xl border border-primary-200 bg-primary-50/40 p-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                  >
                    <p className="flex items-center gap-2 text-sm font-semibold text-primary-900">
                      <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                      Selected service address
                    </p>
                    <p className="mt-2 break-words font-semibold text-slate-950">
                      {location.address}
                    </p>
                    {location.name !== location.address ? (
                      <p className="mt-1 text-sm text-slate-600">
                        {location.name}
                      </p>
                    ) : null}
                    {location.serviceAreaStatus &&
                    location.serviceAreaStatus !== "eligible" ? (
                      <p className="mt-2 text-sm text-amber-800">
                        Stonegate will review this address before confirming
                        service.
                      </p>
                    ) : null}
                    <button
                      type="button"
                      className={cn(partnerSecondaryButtonClass, "mt-3")}
                      disabled={addressSaving || advancing}
                      onClick={() => {
                        updateLocation("");
                        const nextMode = canManageLocations ? "new" : "saved";
                        setAddressEntryMode(nextMode);
                        setLocationSearch("");
                        focusAddressEntry(nextMode);
                      }}
                    >
                      Change address
                    </button>
                  </div>
                ) : null}

                {canManageLocations ? (
                  <div hidden={Boolean(location) || addressEntryMode !== "new"}>
                    <PartnerInlineLocationForm
                      embedded
                      formId={addressFormId}
                      canManage
                      disabled={
                        advancing || saveStatus === "creating" || !draft
                      }
                      onPendingChange={setAddressSaving}
                      onUnsavedChange={setAddressDirty}
                      onCreated={async (newLocation) => {
                        setAvailableLocations((current) =>
                          sortBookingLocations([
                            ...current.filter(
                              (item) => item.id !== newLocation.id,
                            ),
                            newLocation,
                          ]),
                        );
                        const snapshot = updateLocation(
                          newLocation.id,
                          newLocation,
                        );
                        await goNext(snapshot);
                      }}
                    />
                  </div>
                ) : null}

                {!location &&
                addressEntryMode === "new" &&
                availableLocations.length > 0 ? (
                  <button
                    type="button"
                    className={cn(partnerSecondaryButtonClass, "mt-4")}
                    disabled={addressSaving || advancing}
                    onClick={() => {
                      setAddressEntryMode("saved");
                      focusAddressEntry("saved");
                    }}
                  >
                    Use a saved address
                  </button>
                ) : null}

                {!location && addressEntryMode === "saved" ? (
                  <div className="mt-4 space-y-3">
                    {canManageLocations ? (
                      <button
                        type="button"
                        className={partnerSecondaryButtonClass}
                        disabled={addressSaving || advancing}
                        onClick={() => {
                          setAddressEntryMode("new");
                          setLocationSearch("");
                          focusAddressEntry("new");
                        }}
                      >
                        Enter a new address
                      </button>
                    ) : null}
                    <label
                      className="block text-sm font-semibold text-slate-700"
                      htmlFor="partner-location-chooser-search"
                    >
                      Search saved addresses
                      <input
                        id="partner-location-chooser-search"
                        type="search"
                        value={locationSearch}
                        maxLength={100}
                        onChange={(event) =>
                          setLocationSearch(event.target.value)
                        }
                        className={partnerFieldClass}
                        placeholder="Address or location label"
                      />
                    </label>
                    {locationSearching ? (
                      <p role="status" className="text-sm text-slate-600">
                        Searching saved addresses…
                      </p>
                    ) : null}
                    {locationSearchError ? (
                      <PartnerNotice tone="error">
                        {locationSearchError}
                      </PartnerNotice>
                    ) : null}
                    {(locationSearchResults ?? availableLocations).length ===
                    0 ? (
                      <p role="status" className="text-sm text-slate-600">
                        No saved addresses match. Try another search
                        {canManageLocations ? " or enter a new address" : ""}.
                      </p>
                    ) : null}
                    <div className="grid max-h-96 gap-3 overflow-y-auto p-1 md:grid-cols-2">
                      {(
                        locationSearchResults ??
                        sortBookingLocations(availableLocations)
                      ).map((item) => (
                        <label
                          key={item.id}
                          className="flex min-h-24 cursor-pointer gap-3 rounded-xl border border-slate-200 p-4 transition hover:border-primary-300 focus-within:ring-2 focus-within:ring-accent-500"
                        >
                          <input
                            type="radio"
                            name="location"
                            value={item.id}
                            checked={item.id === form.locationId}
                            onChange={() => {
                              updateLocation(item.id);
                              setLocationSearch("");
                              window.requestAnimationFrame(() =>
                                document
                                  .getElementById(
                                    "partner-book-selected-address",
                                  )
                                  ?.focus(),
                              );
                            }}
                            className="mt-1 h-5 w-5 shrink-0 border-slate-300 text-primary-700"
                            aria-describedby={
                              fieldErrors["locationId"]
                                ? "partner-book-location-error"
                                : undefined
                            }
                          />
                          <span className="min-w-0">
                            <span className="block break-words font-semibold text-slate-950">
                              {item.address}
                            </span>
                            <span className="mt-1 block text-sm text-slate-600">
                              {item.name}
                            </span>
                            {item.serviceAreaStatus &&
                            item.serviceAreaStatus !== "eligible" ? (
                              <span className="mt-2 block text-xs text-amber-800">
                                Service-area review required
                              </span>
                            ) : null}
                          </span>
                        </label>
                      ))}
                    </div>
                    {!canManageLocations ? (
                      <p className="text-sm text-slate-600">
                        To use a new address, ask your company administrator to
                        add it.
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {fieldErrors["locationId"] ? (
                  <p
                    id="partner-book-location-error"
                    className="mt-3 text-sm font-medium text-rose-700"
                  >
                    {fieldErrors["locationId"]}
                  </p>
                ) : null}
                <div className="mt-6">
                  <PartnerAdditionalAddresses
                    value={form}
                    onChange={updateScope}
                    fieldErrors={fieldErrors}
                  />
                </div>
              </fieldset>
            ) : null}

            {step === 1 ? (
              <div
                className="grid gap-7 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] xl:gap-8"
                data-service-details
              >
                <div className="min-w-0 space-y-6">
                  <div
                    className={cn(
                      "grid gap-5",
                      service?.baseOptions?.length
                        ? "sm:grid-cols-2"
                        : "sm:max-w-md",
                    )}
                  >
                    <label className="block" htmlFor="partner-book-service">
                      <span className="text-sm font-semibold text-slate-700">
                        Service type
                      </span>
                      <select
                        id="partner-book-service"
                        value={form.serviceKey}
                        onChange={(event) => updateService(event.target.value)}
                        className={partnerFieldClass}
                        required
                        disabled={
                          advancing || availabilityLoading || submitting
                        }
                        aria-invalid={Boolean(serviceError)}
                        aria-describedby={
                          serviceError
                            ? "partner-book-service-error"
                            : undefined
                        }
                      >
                        <option value="">Choose a service</option>
                        {form.serviceKey && !service ? (
                          <option value={form.serviceKey} disabled>
                            Previously selected service — unavailable
                          </option>
                        ) : null}
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
                      {serviceError ? (
                        <span
                          id="partner-book-service-error"
                          className="mt-1 block text-sm font-medium text-rose-700"
                        >
                          {serviceError}
                        </span>
                      ) : null}
                    </label>
                    {service?.baseOptions?.length ? (
                      <label
                        className="block"
                        htmlFor="partner-book-base-option"
                      >
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
                  </div>
                  <label className="block" htmlFor="partner-book-description">
                    <span className="text-sm font-semibold text-slate-700">
                      Job description
                    </span>
                    <textarea
                      id="partner-book-description"
                      value={form.description}
                      onChange={(event) =>
                        update("description", event.target.value)
                      }
                      rows={4}
                      maxLength={4_000}
                      className={partnerFieldClass}
                      placeholder="Example: Remove 12 empty pallets and two shelving units from the loading area."
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
                      Include the items, approximate quantity, and work to be
                      completed.
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
                  <PartnerWorkQuestions
                    value={form}
                    onChange={updateScope}
                    fieldErrors={fieldErrors}
                  />
                  <PartnerMaterialsQuestion
                    value={form}
                    onChange={updateScope}
                    fieldErrors={fieldErrors}
                  />
                  <PartnerSavedScopeDetails
                    value={form}
                    onChange={updateScope}
                    fieldErrors={fieldErrors}
                    initialValue={initialFormRef.current}
                    requiredFields={service?.requiredScopeFields}
                  />
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
                        Use this checklist if it saves time. It does not change
                        your service, account access, or saved request.
                      </p>
                    </aside>
                  ) : null}
                </div>
                <fieldset
                  id="partner-book-photos"
                  tabIndex={-1}
                  disabled={advancing || availabilityLoading || submitting}
                  className="min-w-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                >
                  {draft ? (
                    <PartnerDraftPhotoUpload
                      compact
                      draftId={draft.id}
                      canUpload={canUploadPhotos}
                      onCountChange={setDraftPhotoCount}
                      onPendingChange={setPendingPhotos}
                      onPhaseChange={setPhotoPhase}
                      persona={persona}
                    />
                  ) : (
                    <PartnerNotice tone="info">
                      Photos will be available once your request is ready.
                    </PartnerNotice>
                  )}
                </fieldset>
                <div
                  className="min-w-0 border-t border-slate-200 xl:col-span-2"
                  aria-label="Additional request details"
                >
                  <PartnerBookingDetailsRow
                    title="Contact and access"
                    summary={contactDetailsSummary}
                    validationErrors={fieldErrors}
                    reveal={
                      !form.contactName.trim() ||
                      (!form.contactPhone.trim() &&
                        !form.contactEmail.trim()) ||
                      hasDetailsError("contact")
                    }
                  >
                    <div className="space-y-5">
                      <div className="grid gap-4 sm:grid-cols-3">
                        <label htmlFor="partner-book-contact-name">
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
                      <fieldset className="border-t border-slate-100 pt-4">
                        <legend className="px-1 text-sm font-semibold text-slate-900">
                          Alternate on-site contact{" "}
                          <span className="font-normal text-slate-500">
                            (optional)
                          </span>
                        </legend>
                        <p className="mt-1 text-xs leading-5 text-slate-500">
                          Add a backup person when the primary contact may not
                          be available at arrival.
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
                                update(
                                  "alternateContactName",
                                  event.target.value,
                                )
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
                                update(
                                  "alternateContactPhone",
                                  event.target.value,
                                )
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
                                update(
                                  "alternateContactEmail",
                                  event.target.value,
                                )
                              }
                              maxLength={320}
                              className={partnerFieldClass}
                            />
                          </label>
                        </div>
                      </fieldset>
                      <PartnerAccessQuestions
                        value={form}
                        onChange={updateScope}
                        fieldErrors={fieldErrors}
                      />
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
                          rows={2}
                          maxLength={4_000}
                          className={partnerFieldClass}
                          placeholder="Parking, loading access, entry instructions, or access hours."
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
                  </PartnerBookingDetailsRow>
                  <PartnerBookingDetailsRow
                    title="Work order and billing"
                    summary={commercialDetailsSummary}
                    validationErrors={fieldErrors}
                    reveal={hasDetailsError("commercial")}
                  >
                    <div className="space-y-4">
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
                      <fieldset className="border-t border-slate-100 pt-4">
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
                              aria-invalid={Boolean(
                                fieldErrors["billingContact"],
                              )}
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
                                update(
                                  "billingContactEmail",
                                  event.target.value,
                                )
                              }
                              maxLength={320}
                              className={partnerFieldClass}
                              aria-invalid={Boolean(
                                fieldErrors["billingContact"],
                              )}
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
                  </PartnerBookingDetailsRow>
                  <PartnerBookingDetailsRow
                    title="Completion photos"
                    summary={proofDetailsSummary}
                    validationErrors={fieldErrors}
                    reveal={hasDetailsError("proof")}
                    id="partner-book-proof"
                  >
                    <div className="grid gap-3 sm:grid-cols-3">
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
                          title: "Completion report",
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
                              Number of photos
                              <input
                                type="number"
                                min={1}
                                max={20}
                                step={1}
                                inputMode="numeric"
                                value={form[item.countKey]}
                                onChange={(event) =>
                                  update(
                                    item.countKey,
                                    Math.min(
                                      20,
                                      Math.max(
                                        1,
                                        Number(event.target.value) || 1,
                                      ),
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
                          Nothing is applied until you choose a preset. Use one
                          to fill these options quickly.{" "}
                          {"The controls below always override the suggestion."}
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
                  </PartnerBookingDetailsRow>{" "}
                  {service?.addOns?.length ? (
                    <PartnerBookingDetailsRow
                      title="Additional services"
                      summary={
                        Object.keys(form.addOnQuantities).length
                          ? `${Object.keys(form.addOnQuantities).length} selected`
                          : "Add to this request if needed"
                      }
                      validationErrors={fieldErrors}
                      reveal={hasDetailsError("addons")}
                      id="partner-book-add-ons"
                    >
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
                    </PartnerBookingDetailsRow>
                  ) : null}
                  {service?.agreement ? (
                    <PartnerBookingDetailsRow
                      title="Service and pricing"
                      summary={service.agreement.label}
                      validationErrors={fieldErrors}
                      reveal={false}
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
                        only as a review request and contact Stonegate from
                        Help.
                      </p>
                    </PartnerBookingDetailsRow>
                  ) : null}
                </div>
              </div>
            ) : null}

            {step === 2 ? (
              <div>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h3 className="font-semibold text-slate-950">
                      {instantConfirmationAvailable
                        ? "Choose a service window"
                        : "Choose your preferred dates"}
                    </h3>
                    <p className="mt-1 text-sm leading-6 text-slate-600">
                      {instantConfirmationAvailable
                        ? "Pick a two-hour arrival window that works for you. The exact crew start is planned inside that window."
                        : "Tell us which dates work for you. Stonegate will review the request and confirm your service time."}{" "}
                      Times are shown in {selectedTimezone.replace(/_/gu, " ")}.
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
                {instantConfirmationAvailable &&
                availability?.calendar.state !== "current" ? (
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
                          Tell us which dates work
                        </h3>
                        <p className="mt-1 text-sm leading-6 text-slate-700">
                          This request needs a schedule review. Choose up to
                          three preferred dates and Stonegate will follow up
                          before any arrival window is confirmed.
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
                            Dates worth considering
                          </p>
                          <p className="mt-1 text-xs leading-5 text-slate-600">
                            These dates may help us review the request, but they
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
                        Choose how you would like Stonegate to help after you
                        send this request.
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
                          Based on your preferred dates, earliest availability,
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
                    <label
                      className="block text-sm font-semibold text-slate-700"
                      htmlFor="partner-book-available-date"
                    >
                      Service date
                      <select
                        id="partner-book-available-date"
                        className={partnerFieldClass}
                        value={visibleDate}
                        onChange={(event) =>
                          setSelectedDate(event.target.value)
                        }
                      >
                        {windowsByDate.map(([date]) => (
                          <option key={date} value={date}>
                            {formatDate(date, selectedTimezone)}
                          </option>
                        ))}
                      </select>
                    </label>
                    {windowsByDate
                      .filter(([date]) => date === visibleDate)
                      .map(([date, windows]) => (
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
                                  {formatTime(window.startAt, selectedTimezone)}
                                  –{formatTime(window.endAt, selectedTimezone)}
                                </button>
                              );
                            })}
                          </div>
                        </fieldset>
                      ))}
                  </div>
                ) : null}
                <div className="mt-6">
                  <PartnerCompletionDeadline
                    value={form}
                    onChange={updateScope}
                    fieldErrors={fieldErrors}
                  />
                </div>
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

            {step === 3 ? (
              <div className="space-y-5">
                <PartnerNotice tone="info">
                  {hold
                    ? "Check the details below, then send your request with the arrival window currently held for you."
                    : "Check the details below, then send your preferred dates for review. No arrival window is reserved yet."}
                </PartnerNotice>
                <nav aria-label="Edit booking sections">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Need to change something?
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {[
                      [0, "Location"],
                      [1, "Service & scope"],
                      [1, "Contact & photos"],
                      [2, "Schedule"],
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
                    <dd className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-600">
                      {form.description}
                    </dd>
                    {form.itemCount || form.volume ? (
                      <dd className="mt-3 text-sm text-slate-700">
                        {[
                          form.itemCount ? `${form.itemCount} items` : null,
                          form.volume ? `${form.volume} cubic yards` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </dd>
                    ) : null}
                    {form.hazardCategories.length > 0 ||
                    form.equipmentNeeds.length > 0 ||
                    form.requiredCompletionDate ||
                    (form.multiStop && form.multiStopDetails) ? (
                      <dd className="mt-3 space-y-2 border-t border-slate-200 pt-3 text-sm text-slate-700">
                        {form.hazardCategories.length > 0 ? (
                          <p>
                            <strong>Materials: </strong>
                            {PARTNER_HAZARD_OPTIONS.filter((option) =>
                              form.hazardCategories.includes(option.key),
                            )
                              .map((option) => option.label)
                              .join(", ")}
                          </p>
                        ) : null}
                        {form.equipmentNeeds.length > 0 ? (
                          <p>
                            <strong>Equipment and access: </strong>
                            {PARTNER_EQUIPMENT_OPTIONS.filter((option) =>
                              form.equipmentNeeds.includes(option.key),
                            )
                              .map((option) => option.label)
                              .join(", ")}
                          </p>
                        ) : null}
                        {form.requiredCompletionDate ? (
                          <p>
                            <strong>Completion deadline requested: </strong>
                            {formatDate(
                              form.requiredCompletionDate,
                              selectedTimezone,
                            )}
                            {form.requiredCompletionTime
                              ? ` at ${form.requiredCompletionTime}`
                              : ""}{" "}
                            ({selectedTimezone})
                          </p>
                        ) : null}
                        {form.multiStop && form.multiStopDetails ? (
                          <p className="whitespace-pre-wrap break-words">
                            <strong>Stops and sequence: </strong>
                            {form.multiStopDetails}
                          </p>
                        ) : null}
                      </dd>
                    ) : null}
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
                            <li>Handling review requested</li>
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
                              ? "This service needs a written quote. Stonegate will review the request and send one before the price becomes final."
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
                      {form.contactPhone}
                    </dd>
                    {form.contactEmail ? (
                      <dd className="mt-1 break-words text-sm text-slate-600">
                        {form.contactEmail}
                      </dd>
                    ) : null}
                    {form.alternateContactName ||
                    form.alternateContactPhone ||
                    form.alternateContactEmail ? (
                      <dd className="mt-3 border-t border-slate-200 pt-3 text-sm text-slate-700">
                        <span className="block font-semibold">
                          Alternate contact
                        </span>
                        <span className="block">
                          {form.alternateContactName}
                        </span>
                        <span className="block">
                          {form.alternateContactPhone}
                        </span>
                        <span className="block break-words">
                          {form.alternateContactEmail}
                        </span>
                      </dd>
                    ) : null}
                    {form.accessDetails ? (
                      <dd className="mt-3 whitespace-pre-wrap break-words border-t border-slate-200 pt-3 text-sm text-slate-700">
                        <strong className="block">Access instructions</strong>
                        {form.accessDetails}
                      </dd>
                    ) : null}
                    {form.crewInstructions ? (
                      <dd className="mt-3 whitespace-pre-wrap break-words text-sm text-slate-700">
                        <strong className="block">Crew instructions</strong>
                        {form.crewInstructions}
                      </dd>
                    ) : null}
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
                      {draftPhotoCount === null
                        ? "Photo attachments could not be checked. Return to Service details to try again."
                        : `${draftPhotoCount} reference photo${draftPhotoCount === 1 ? "" : "s"} attached to this request`}
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
                      This account’s saved policy is unavailable, so Stonegate
                      must review changes to confirmed jobs.
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
          </fieldset>

          <div className="mt-8 flex flex-col-reverse gap-3 border-t border-slate-200 pt-5 sm:flex-row sm:items-center sm:justify-between">
            <button
              type="button"
              onClick={() => editReviewStep(Math.max(0, step - 1))}
              disabled={
                step === 0 || submitting || advancing || availabilityLoading
              }
              className={cn(partnerSecondaryButtonClass, "w-full sm:w-auto")}
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Back
            </button>
            {step < 3 ? (
              <button
                type={enteringNewAddress ? "submit" : "button"}
                form={enteringNewAddress ? addressFormId : undefined}
                onClick={enteringNewAddress ? undefined : () => void goNext()}
                data-partner-analytics="booking_step_continue"
                disabled={
                  !draft ||
                  saveStatus === "creating" ||
                  advancing ||
                  addressSaving ||
                  availabilityLoading ||
                  (step === 2 && !hold && !preferredReviewReady)
                }
                className={cn(partnerPrimaryButtonClass, "w-full sm:w-auto")}
              >
                {addressSaving
                  ? "Saving address…"
                  : advancing
                    ? "Saving step…"
                    : step === 1
                      ? "Continue to scheduling"
                      : "Continue"}
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
                  (!submissionUncertain &&
                    (hold ? holdSeconds <= 0 : !preferredReviewReady))
                }
                className={cn(partnerPrimaryButtonClass, "w-full sm:w-auto")}
              >
                {submitting ? (
                  <>
                    <LoaderCircle
                      className="h-4 w-4 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                    Sending…
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
      {step === 0 ? (
        <PartnerSavedRequests
          currentDraftId={draft?.id}
          canDiscard={canDiscardDrafts}
        />
      ) : null}
    </div>
  );
}
