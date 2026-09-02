export type PortalV2Error = {
  ok: false;
  error: string;
  message: string;
  correlationId?: string;
  retryable?: boolean;
  fieldErrors?: Record<string, string>;
  alternatives?: Array<{ action: string; label: string; href?: string }>;
};

export type PartnerDraft = {
  id: string;
  rescheduleFromJobId: string | null;
  state: string;
  locationId: string | null;
  serviceKey: string | null;
  tierKey: string | null;
  selectedAddOns: Array<{ key: string; quantity: number }>;
  scope: Record<string, unknown>;
  description: string | null;
  crewInstructions: string | null;
  accessDetails: string | null;
  onSiteContact: Record<string, unknown> | null;
  proofRequirements: Record<string, unknown>;
  commercial: Record<string, unknown>;
  preferredWindows: Array<Record<string, unknown>>;
  scheduleAssistancePreference: "none" | "waitlist" | "callback";
  reviewReasons: string[];
  validation: Record<string, unknown>;
  revision: number;
  expiresAt: string | null;
  submittedAt: string | null;
  createdAt: string;
  updatedAt: string;
  etag: string;
};

export type PartnerLocationImportRowResult = {
  rowNumber: number;
  status: "valid" | "invalid";
  values: Record<string, string>;
  errors: Array<{ code: string; field: string; message: string }>;
};

export type PartnerLocationImport = {
  id: string;
  state: "validated" | "invalid" | "committed" | "expired";
  directoryVersion: number;
  rowCount: number;
  validRowCount: number;
  invalidRowCount: number;
  rows: PartnerLocationImportRowResult[];
  canCommit: boolean;
  correctionsUrl: string;
  expiresAt: string;
  purgeAfter: string;
  committedAt: string | null;
  revision: number;
  etag: string;
};

export type PartnerRescheduleResult = {
  mode: "instant" | "review";
  jobId: string;
  requestId: string | null;
  publicStatus: string;
  arrivalWindowStartAt: string;
  arrivalWindowEndAt: string;
  reviewReasons: string[];
  version: number;
  updatedAt: string;
  etag: string;
  consequence: {
    existingScheduleRemainsInPlace: boolean;
    automaticFeeMinor: null;
    label: string;
  };
};

export type PartnerAvailability = {
  draft: PartnerDraft;
  timezone: string;
  calendar: {
    state: "current" | "stale" | "unconfigured";
  };
  reviewReasons: string[];
  instantConfirmationEligible: boolean;
  pricing: {
    status:
      | "contracted"
      | "estimate"
      | "quote_required"
      | "standard_rate"
      | "review_required"
      | "hidden";
    currency: string | null;
    baseAmount: PartnerMoney | null;
    addOnTotal: PartnerMoney | null;
    total: PartnerMoney | null;
    addOns: Array<{
      key: string;
      label: string;
      unitLabel: string;
      quantity: number;
      requiresReview: boolean;
      unitAmount: PartnerMoney | null;
      lineTotal: PartnerMoney | null;
    }>;
  };
  windows: Array<{
    id: string;
    localDate: string;
    startAt: string;
    endAt: string;
    label: string;
    available: boolean;
  }>;
  rankedAlternatives: Array<{
    id: string;
    localDate: string;
    startAt: string;
    endAt: string;
    label: string;
    available: boolean;
    rank: number;
    reason: "preferred_date" | "soonest_available" | "more_capacity";
  }>;
};

export type PartnerHold = {
  id: string;
  draftId: string;
  status: string;
  arrivalWindowStartAt: string;
  arrivalWindowEndAt: string;
  expiresAt: string;
};

export type PartnerLocation = {
  id: string;
  siteName: string | null;
  externalPropertyId: string | null;
  address: {
    line1: string;
    line2: string | null;
    city: string;
    state: string;
    postalCode: string;
  };
  timezone?: string;
  locale?: string;
  access: {
    details: string | null;
    parking: string | null;
    loading: string | null;
    hasSecret?: boolean;
  };
  onSiteContact: Record<string, unknown> | null;
  portfolio: {
    isDefault: boolean;
    isFavorite: boolean;
    parentLocationId: string | null;
    childCount: number;
    directoryVersion: number | null;
    mergedIntoLocationId: string | null;
    mergedAt: string | null;
  };
  addressVerification: {
    status: string;
    provider: string;
    confidence: number | null;
    suggestedAddress: {
      line1: string | null;
      line2: string | null;
      city: string | null;
      state: string | null;
      postalCode: string | null;
    } | null;
    verifiedAt: string | null;
  };
  serviceArea: {
    status: string;
    geocodeStatus?: string;
    reason: string | null;
  };
  active: boolean;
  revision: number;
  etag: string;
  updatedAt: string;
};

export type PartnerMoney = {
  amountMinor: number;
  currency: string;
  minorUnit: number;
};

export type PartnerQuote = {
  id: string;
  authority: "legacy_snapshot" | "quote_v2";
  actionable: boolean;
  notice: string | null;
  quoteNumber: string | null;
  version: number;
  status: string;
  projectName: string | null;
  bookingId: string | null;
  bookingDraftId: string | null;
  locationId: string | null;
  amounts:
    | {
        subtotal: PartnerMoney;
        tax: PartnerMoney;
        discount: PartnerMoney;
        total: PartnerMoney;
      }
    | {
        subtotalMin: PartnerMoney;
        subtotalMax: PartnerMoney;
        discountMin: PartnerMoney;
        discountMax: PartnerMoney;
        totalMin: PartnerMoney;
        totalMax: PartnerMoney;
        deposit: PartnerMoney;
      }
    | null;
  lineCount: number | null;
  expiresAt: string | null;
  issuedAt: string | null;
  documentId: string | null;
  allowedActions: string[];
  etag: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PartnerQuoteLineItem = {
  id: string;
  name: string;
  description: string | null;
  quantity: number;
  unit: string;
  unitPriceMinCents: number;
  unitPriceMaxCents: number | null;
  optionGroupId: string | null;
  selectedByDefault: boolean;
};

export type PartnerQuoteOptionGroup = {
  id: string;
  label: string;
  mode: "single" | "multiple";
  minimumSelections: number;
  maximumSelections: number;
};

export type PartnerQuoteDetail = PartnerQuote & {
  legacyTerms: string | null;
  document: {
    documentType: string;
    schedulingMode: string;
    parties: {
      customerName: string;
      companyName: string | null;
      serviceAddress: string;
      projectName: string | null;
      purchaseOrder: string | null;
      reference: string | null;
    };
    issuer: { displayName: string; email: string; phoneE164: string };
    scope: string;
    inclusions: string[];
    exclusions: string[];
    assumptions: string[];
    pricing: {
      currency: string;
      lineItems: PartnerQuoteLineItem[];
      optionGroups: PartnerQuoteOptionGroup[];
    };
    terms: {
      terms: string;
      paymentTerms: string;
      changeOrderRules: string;
      consentVersion: string;
    };
    estimatedDurationMinutes: number;
  } | null;
  proposalDocument: {
    id: string;
    filename: string | null;
    byteSize: number;
    sha256: string;
  } | null;
  response: {
    id: string;
    decision: "accepted" | "declined";
    respondedAt: string;
  } | null;
  history: Array<{
    id: string;
    version: number;
    state: string;
    issuedAt: string | null;
    expiresAt: string | null;
    current: boolean;
  }>;
};

export type PartnerInvoice = {
  id: string;
  invoiceNumber: string | null;
  status: string;
  bookingId: string | null;
  poNumber: string | null;
  costCenter: string | null;
  amounts: {
    subtotal: PartnerMoney;
    tax: PartnerMoney;
    discount: PartnerMoney;
    deposit: PartnerMoney;
    total: PartnerMoney;
    paid: PartnerMoney;
    balance: PartnerMoney;
  };
  dueDate: string | null;
  issuedAt: string | null;
  paidAt: string | null;
  voidedAt: string | null;
  documentId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type PartnerStatement = {
  id: string;
  periodStart: string;
  periodEnd: string;
  amounts: {
    openingBalance: PartnerMoney;
    invoices: PartnerMoney;
    payments: PartnerMoney;
    refunds: PartnerMoney;
    credits: PartnerMoney;
    closingBalance: PartnerMoney;
  };
  documentId: string | null;
  generatedAt: string;
};

export type PartnerDocument = {
  id: string;
  bookingId: string | null;
  documentType: string | null;
  version: number;
  filename: string;
  contentType: string | null;
  byteSize: number;
  generatedAt: string;
};

export type PartnerReportSummary = {
  currency: string;
  invoiceCount: number;
  total: PartnerMoney;
  paid: PartnerMoney;
  balance: PartnerMoney;
};

export type PartnerJobSummary = {
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
    }>;
  };
  schedule: {
    arrivalWindow: { startAt: string; endAt: string; timezone: string } | null;
    completedAt: string | null;
  };
  location: {
    id: string | null;
    name: string | null;
    address: {
      line1: string;
      city: string;
      state: string;
      postalCode: string;
    } | null;
  };
  references: {
    poNumber: string | null;
    costCenter: string | null;
    project: string | null;
  };
  financial: PartnerMoney | null;
  cancellation: {
    action: "cancel" | "request_cancellation_review" | null;
    reason: { code: string; label: string };
    deadlineAt: string | null;
    timezone: string;
    cutoffMinutes: number;
    directCancellationEnabled: boolean;
    lateCancellationDisposition: "staff_review";
    consequence: {
      code: string;
      label: string;
      automaticFeeMinor: null;
    };
    policySource: "launch_default" | "configured" | "unconfigured";
    policyRevision: number | null;
  };
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
    createdAt: string | null;
    consequence: string;
  } | null;
  allowedActions: string[];
  createdAt: string;
  updatedAt: string;
};

export type PartnerProofMedia = {
  id: string;
  category: string;
  caption: string | null;
  sortOrder: number;
  status: string;
  filename: string | null;
  contentType: string | null;
  byteSize: number | null;
  width: number | null;
  height: number | null;
  sha256: string | null;
  createdAt: string;
  readyAt: string | null;
  downloadIntent: {
    thumbnailUrl: string | null;
    displayUrl: string | null;
    originalUrl: string | null;
    expiresAt: string;
  } | null;
  error: string | null;
};

export type PartnerProof = {
  status: string;
  requirements: Array<{
    category: string;
    required: boolean;
    minimumCount: number;
    readyCount: number;
    satisfied: boolean;
    source: string;
  }>;
  outstanding: string[];
  media: PartnerProofMedia[];
  packages: Array<{
    id: string;
    version: number;
    checksumSha256: string;
    documents: { pdfId: string | null; originalMediaZipId: string | null };
    generatedAt: string;
  }>;
  shareLinks: Array<{
    id: string;
    proofPackageId: string;
    expiresAt: string;
    revokedAt: string | null;
    accessCount: number;
    createdAt: string;
  }>;
};

export type PortalV2Result<T> =
  | { ok: true; data: T; response: Response }
  | { ok: false; error: PortalV2Error; response: Response };

const PORTAL_CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

export function portalSupportReference(
  value: string | null | undefined,
): string | null {
  const candidate = value?.trim() ?? "";
  return PORTAL_CORRELATION_ID_PATTERN.test(candidate) ? candidate : null;
}

export function portalSupportReferenceFromResponse(
  response: Pick<Response, "headers"> | null | undefined,
): string | null {
  return portalSupportReference(response?.headers.get("x-correlation-id"));
}

export function withPortalSupportReference(
  message: string,
  correlationId: string | null | undefined,
): string {
  const baseMessage = message.trim() || "The partner service is unavailable.";
  const reference = portalSupportReference(correlationId);
  if (!reference || /\bsupport reference\s*:/iu.test(baseMessage)) {
    return baseMessage;
  }
  return `${baseMessage} Support reference: ${reference}.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readPortalV2Response<T>(
  response: Response,
): Promise<PortalV2Result<T>> {
  const payload = (await response.json().catch(() => null)) as unknown;
  if (response.ok && isRecord(payload) && payload["ok"] === true) {
    return { ok: true, data: payload as T, response };
  }
  const record = isRecord(payload) ? payload : {};
  const correlationId =
    portalSupportReferenceFromResponse(response) ??
    portalSupportReference(
      typeof record["correlationId"] === "string"
        ? record["correlationId"]
        : null,
    );
  const baseMessage =
    typeof record["message"] === "string"
      ? record["message"].trim()
      : "The partner service is temporarily unavailable.";
  return {
    ok: false,
    response,
    error: {
      ok: false,
      error:
        typeof record["error"] === "string"
          ? record["error"]
          : "service_unavailable",
      message: withPortalSupportReference(baseMessage, correlationId),
      ...(correlationId ? { correlationId } : {}),
      ...(typeof record["retryable"] === "boolean"
        ? { retryable: record["retryable"] }
        : {}),
      ...(isRecord(record["fieldErrors"])
        ? { fieldErrors: record["fieldErrors"] as Record<string, string> }
        : {}),
    },
  };
}

export async function partnerPortalFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<PortalV2Result<T>> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) {
    headers.set("Content-Type", "application/json");
  }
  const correlationId =
    portalSupportReference(headers.get("x-correlation-id")) ??
    `portal_${globalThis.crypto.randomUUID().replace(/-/gu, "")}`;
  headers.set("x-correlation-id", correlationId);

  const response = await fetch(
    `/api/partners/portal/${path.replace(/^\/+|\/+$/gu, "")}`,
    {
      ...init,
      cache: "no-store",
      headers,
    },
  ).catch(
    () =>
      new Response(
        JSON.stringify({
          ok: false,
          error: "service_unavailable",
          message:
            "The partner service could not be reached. Try again shortly.",
          retryable: true,
          correlationId,
        }),
        {
          status: 503,
          headers: {
            "content-type": "application/json",
            "x-correlation-id": correlationId,
          },
        },
      ),
  );
  return readPortalV2Response<T>(response);
}

export function createPortalOperationKey(prefix: string): string {
  return `${prefix}:${globalThis.crypto.randomUUID()}`;
}

export function portalUnavailableStatus(status: number): boolean {
  return status === 404 || status === 409 || status === 501 || status === 503;
}
