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
  reviewReasons: string[];
  validation: Record<string, unknown>;
  revision: number;
  expiresAt: string | null;
  submittedAt: string | null;
  createdAt: string;
  updatedAt: string;
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
    status: "contracted" | "review_required" | "hidden";
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
  serviceArea: { status: string; reason: string | null };
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
  quoteNumber: string | null;
  version: number;
  status: string;
  bookingId: string | null;
  bookingDraftId: string | null;
  amounts: {
    subtotal: PartnerMoney;
    tax: PartnerMoney;
    discount: PartnerMoney;
    total: PartnerMoney;
  };
  lineCount: number;
  expiresAt: string | null;
  sentAt: string | null;
  acceptedAt: string | null;
  declinedAt: string | null;
  supersededAt: string | null;
  documentId: string | null;
  createdAt: string;
  updatedAt: string;
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
    consequence: {
      code: string;
      label: string;
      automaticFeeMinor: null;
    };
    policySource: "launch_default" | "configured";
  };
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
  return {
    ok: false,
    response,
    error: {
      ok: false,
      error:
        typeof record["error"] === "string"
          ? record["error"]
          : "service_unavailable",
      message:
        typeof record["message"] === "string"
          ? record["message"]
          : "The partner service is temporarily unavailable.",
      ...(typeof record["correlationId"] === "string"
        ? { correlationId: record["correlationId"] }
        : {}),
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
  const response = await fetch(
    `/api/partners/portal/${path.replace(/^\/+|\/+$/gu, "")}`,
    {
      ...init,
      cache: "no-store",
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    },
  );
  return readPortalV2Response<T>(response);
}

export function createPortalOperationKey(prefix: string): string {
  return `${prefix}:${globalThis.crypto.randomUUID()}`;
}

export function portalUnavailableStatus(status: number): boolean {
  return status === 404 || status === 409 || status === 501 || status === 503;
}
