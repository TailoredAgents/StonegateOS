import type {
  QuoteV2ComposerDraft,
  QuoteV2ContactSearchResult,
  QuoteV2OptimisticTotals,
} from "./quote-v2-composer-model";
import {
  parsePositiveQuantity,
  parseUsdToCents,
  splitProposalList,
} from "./quote-v2-composer-model";

export type QuoteV2ApiError = {
  code: string;
  message: string;
  fieldErrors: Record<string, string>;
  retryable: boolean;
  correlationId: string | null;
};

export class QuoteV2ClientError extends Error {
  readonly detail: QuoteV2ApiError;

  constructor(detail: QuoteV2ApiError) {
    super(detail.message);
    this.name = "QuoteV2ClientError";
    this.detail = detail;
  }
}

export type QuoteV2DraftReceipt = {
  quoteId: string;
  versionId: string;
  quoteRevision: number;
  draftRevision: number;
  authoritativeTotals: QuoteV2OptimisticTotals | null;
  correlationId: string | null;
};

export type QuoteV2IssueReceipt = {
  quoteId: string;
  versionId: string;
  quoteNumber: string | null;
  sendAttemptId: string | null;
  overallState: string;
  correlationId: string | null;
};

export type QuoteV2StaffDecisionSource =
  | "phone"
  | "email"
  | "in_person"
  | "written_confirmation"
  | "other";

type QuoteV2StaffDecisionBase = {
  quoteId: string;
  versionId: string;
  quoteRevision: number;
  source: QuoteV2StaffDecisionSource;
  notes: string;
  signer: { name: string; title?: string; company?: string };
  notifyCustomer: boolean;
  idempotencyKey: string;
  correlationId?: string;
};

export type QuoteV2StaffDecisionInput =
  | (QuoteV2StaffDecisionBase & {
      decision: "accepted";
      signer: { name: string; title: string; company?: string };
      selectedOptionIds: string[];
      consentVersion: string;
    })
  | (QuoteV2StaffDecisionBase & {
      decision: "declined";
      category: "price" | "scope" | "timing" | "competitor" | "other";
    });

export type QuoteV2StaffDecisionReceipt = {
  quoteId: string;
  versionId: string;
  responseId: string;
  decision: "accepted" | "declined";
  quoteRevision: number;
  correlationId: string | null;
};

type QuoteV2ChangeResolutionBase = {
  quoteId: string;
  changeRequestId: string;
  quoteVersionId: string;
  quoteRevision: number;
  resolutionNote: string;
  notifyCustomer: boolean;
  idempotencyKey: string;
  correlationId?: string;
};

export type QuoteV2ChangeResolutionInput =
  | (QuoteV2ChangeResolutionBase & {
      resolution: "revision";
      replacementVersionId: string;
    })
  | (QuoteV2ChangeResolutionBase & {
      resolution: "reopen_unchanged";
    });

export type QuoteV2ChangeResolutionReceipt = {
  quoteId: string;
  changeRequestId: string;
  sourceVersionId: string;
  resultingVersionId: string;
  resolution: "revision" | "reopen_unchanged";
  quoteRevision: number;
  correlationId: string | null;
};

export type QuoteV2TerminalLifecycleInput = {
  quoteId: string;
  versionId: string;
  quoteRevision: number;
  reason: string;
  notifyCustomer: boolean;
  idempotencyKey: string;
  correlationId?: string;
};

export type QuoteV2TerminalLifecycleReceipt = {
  quoteId: string;
  versionId: string;
  state: "voided" | "archived";
  quoteRevision: number;
  correlationId: string | null;
};

export type QuoteV2AttachmentItem = {
  attachmentId: string;
  purpose:
    | "scope_evidence"
    | "site_plan"
    | "specification"
    | "terms"
    | "other"
    | "internal";
  customerVisible: boolean;
  label: string | null;
  description: string | null;
  fileName: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  position: number;
};

export type QuoteV2AttachmentUploadReceipt = {
  draft: QuoteV2DraftReceipt;
  attachment: QuoteV2AttachmentItem;
};

export type QuoteV2IssuerSnapshot = {
  legalName: string;
  displayName: string;
  address: string;
  email: string;
  phoneE164: string;
  website?: string | null;
  logoAssetId?: string | null;
  supportMessage?: string | null;
};

export type QuoteV2PartnerContext = {
  accountId: string;
  target: { type: "location" | "booking"; id: string };
  accountName: string;
  targetLabel: string;
};

type FetchLike = typeof fetch;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedString(value: unknown, maximum = 1_000): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, maximum)
    : null;
}

function responseCorrelationId(response: Response): string | null {
  return boundedString(response.headers.get("x-correlation-id"), 128);
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

function parseApiError(
  response: Response,
  payload: unknown,
  fallback: string,
): QuoteV2ApiError {
  const body = record(payload);
  const rawErrors = record(body?.["fieldErrors"]);
  const fieldErrors = Object.fromEntries(
    Object.entries(rawErrors ?? {}).flatMap(([field, message]) =>
      /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(field) &&
      typeof message === "string" &&
      message.trim()
        ? [[field, message.trim().slice(0, 500)]]
        : [],
    ),
  );
  return {
    code:
      boundedString(body?.["code"], 80) ??
      boundedString(body?.["error"], 80) ??
      `http_${response.status}`,
    message:
      boundedString(body?.["message"], 1_000) ??
      boundedString(body?.["error"], 1_000)?.replaceAll("_", " ") ??
      fallback,
    fieldErrors,
    retryable: body?.["retryable"] === true || response.status >= 500,
    correlationId:
      boundedString(body?.["correlationId"], 128) ??
      responseCorrelationId(response),
  };
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function unverifiedLifecycleReceipt(response: Response): QuoteV2ClientError {
  return new QuoteV2ClientError({
    code: "unverified_receipt",
    message:
      "The server returned an incomplete lifecycle receipt. Refresh the quote before retrying.",
    fieldErrors: {},
    retryable: true,
    correlationId: responseCorrelationId(response),
  });
}

function parseDraftReceipt(
  response: Response,
  payload: unknown,
): QuoteV2DraftReceipt | null {
  const root = record(payload);
  const data = record(root?.["data"]) ?? root;
  const quote = record(data?.["quote"]);
  const version = record(data?.["version"]);
  const quoteId = requiredString(data?.["quoteId"] ?? quote?.["id"]);
  const versionId = requiredString(data?.["versionId"] ?? version?.["id"]);
  const quoteRevision = positiveInteger(
    data?.["quoteRevision"] ?? quote?.["revision"],
  );
  const draftRevision = positiveInteger(
    data?.["draftRevision"] ??
      version?.["draftRevision"] ??
      version?.["revision"],
  );
  if (!quoteId || !versionId || !quoteRevision || !draftRevision) return null;
  const totals = record(data?.["totals"] ?? version?.["totals"]);
  const numeric = (key: string) =>
    typeof totals?.[key] === "number" && Number.isInteger(totals[key])
      ? totals[key]
      : null;
  const authoritativeTotals = totals
    ? {
        valid: true,
        subtotalMinCents: numeric("subtotalMinCents") ?? 0,
        subtotalMaxCents: numeric("subtotalMaxCents") ?? 0,
        discountMinCents: numeric("discountMinCents") ?? 0,
        discountMaxCents: numeric("discountMaxCents") ?? 0,
        feeMinCents: numeric("feeMinCents") ?? 0,
        feeMaxCents: numeric("feeMaxCents") ?? 0,
        totalMinCents: numeric("totalMinCents") ?? 0,
        totalMaxCents: numeric("totalMaxCents") ?? 0,
        depositCents: numeric("depositCents") ?? 0,
        balanceMinCents: numeric("balanceMinCents") ?? 0,
        balanceMaxCents: numeric("balanceMaxCents") ?? 0,
        errors: {},
      }
    : null;
  return {
    quoteId,
    versionId,
    quoteRevision,
    draftRevision,
    authoritativeTotals,
    correlationId: responseCorrelationId(response),
  };
}

function normalizedPhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const phone = value.trim();
  return /^\+[1-9]\d{7,14}$/u.test(phone) ? phone : null;
}

function parseContact(value: unknown): QuoteV2ContactSearchResult | null {
  const item = record(value);
  const id = requiredString(item?.["id"]);
  const name = requiredString(item?.["name"]);
  if (!id || !name) return null;
  const properties = Array.isArray(item?.["properties"])
    ? item["properties"].flatMap((candidate) => {
        const property = record(candidate);
        const propertyId = requiredString(property?.["id"]);
        if (!propertyId) return [];
        const explicitLabel = requiredString(property?.["label"]);
        const address = [
          requiredString(property?.["addressLine1"]),
          requiredString(property?.["city"]),
          requiredString(property?.["state"]),
          requiredString(property?.["postalCode"]),
        ]
          .filter(Boolean)
          .join(", ");
        return [
          {
            id: propertyId,
            label: explicitLabel ?? (address || "Saved property"),
            billingLabel: boundedString(property?.["billingLabel"], 1_000),
          },
        ];
      })
    : [];
  return {
    id,
    name,
    companyName: boundedString(item?.["companyName"], 240),
    email: boundedString(item?.["email"], 320),
    phoneE164:
      normalizedPhone(item?.["phoneE164"]) ?? normalizedPhone(item?.["phone"]),
    title: boundedString(item?.["title"], 160),
    properties,
  };
}

function parseAttachmentItem(value: unknown): QuoteV2AttachmentItem | null {
  const data = record(value);
  const attachmentId = requiredString(data?.["attachmentId"]);
  const purpose = requiredString(data?.["purpose"]);
  const fileName = requiredString(data?.["fileName"]);
  const contentType = requiredString(data?.["contentType"]);
  const sha256 = requiredString(data?.["sha256"]);
  const byteSize = positiveInteger(data?.["byteSize"]);
  const position =
    typeof data?.["position"] === "number" &&
    Number.isSafeInteger(data["position"]) &&
    data["position"] >= 0
      ? data["position"]
      : null;
  const validPurposes = new Set<QuoteV2AttachmentItem["purpose"]>([
    "scope_evidence",
    "site_plan",
    "specification",
    "terms",
    "other",
    "internal",
  ]);
  if (
    !attachmentId ||
    !purpose ||
    !validPurposes.has(purpose as QuoteV2AttachmentItem["purpose"]) ||
    !fileName ||
    !contentType ||
    !sha256 ||
    !/^[0-9a-f]{64}$/u.test(sha256) ||
    !byteSize ||
    position === null ||
    typeof data?.["customerVisible"] !== "boolean"
  ) {
    return null;
  }
  return {
    attachmentId,
    purpose: purpose as QuoteV2AttachmentItem["purpose"],
    customerVisible: data["customerVisible"],
    label: boundedString(data["label"], 240),
    description: boundedString(data["description"], 1_000),
    fileName,
    contentType,
    byteSize,
    sha256,
    position,
  };
}

function commandLine(
  line: QuoteV2ComposerDraft["lines"][number],
  index: number,
) {
  const quantity = parsePositiveQuantity(line.quantity);
  const minimum = parseUsdToCents(line.unitPriceMin);
  const maximum = line.unitPriceMax.trim()
    ? parseUsdToCents(line.unitPriceMax)
    : null;
  return {
    id: line.id,
    catalogKey: line.catalogKey.trim() || null,
    name: line.name.trim(),
    description: line.description.trim() || null,
    quantity: quantity ?? 0,
    unit: line.unit.trim(),
    unitPriceMinCents: minimum ?? -1,
    unitPriceMaxCents: maximum,
    optionGroupId: line.optionGroupId || null,
    selectedByDefault: line.selectedByDefault,
    displayOrder: index,
  };
}

export function quoteV2DraftDocument(
  draft: QuoteV2ComposerDraft,
  context: { preparerName: string; issuer: QuoteV2IssuerSnapshot },
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    documentType: draft.documentType,
    audience: draft.audience,
    schedulingMode: draft.schedulingMode,
    parties: {
      customerName: draft.contact?.name ?? "",
      companyName: draft.contact?.companyName ?? null,
      attentionName: draft.attentionName.trim() || null,
      attentionTitle: draft.attentionTitle.trim() || null,
      email: draft.contact?.email ?? null,
      phoneE164: draft.contact?.phoneE164 ?? null,
      billingAddress: draft.billingAddress.trim() || null,
      serviceAddress:
        draft.contact?.properties.find(
          (property) => property.id === draft.propertyId,
        )?.label ?? "",
      projectName: draft.projectName.trim() || null,
      purchaseOrder: draft.purchaseOrder.trim() || null,
      reference: draft.projectReference.trim() || null,
      preparerName: context.preparerName.trim(),
    },
    issuer: context.issuer,
    pricing: {
      documentType: draft.documentType,
      currency: "USD",
      lineItems: draft.lines.map(commandLine),
      optionGroups: draft.optionGroups.map((group) => ({
        id: group.id,
        label: group.label.trim(),
        mode: group.mode,
        minimumSelections: Number(group.minimumSelections),
        maximumSelections: Number(group.maximumSelections),
      })),
      adjustments: draft.adjustments.map((adjustment, index) => ({
        id: adjustment.id,
        kind: adjustment.kind,
        label: adjustment.label.trim(),
        calculation: adjustment.calculation,
        basis: "subtotal",
        eligibleLineItemIds: [],
        amountCents:
          adjustment.calculation === "fixed"
            ? (parseUsdToCents(adjustment.value) ?? -1)
            : null,
        basisPoints:
          adjustment.calculation === "percentage"
            ? Math.round(Number(adjustment.value) * 100)
            : null,
        displayOrder: index,
      })),
      deposit:
        draft.deposit.mode === "none"
          ? { mode: "none" }
          : draft.deposit.mode === "fixed"
            ? {
                mode: "fixed",
                amountCents: parseUsdToCents(draft.deposit.value) ?? -1,
              }
            : {
                mode: "percentage",
                basisPoints: Math.round(Number(draft.deposit.value) * 100),
              },
    },
    scope: draft.scope.trim(),
    inclusions: splitProposalList(draft.inclusions),
    exclusions: splitProposalList(draft.exclusions),
    assumptions: splitProposalList(draft.assumptions),
    terms: {
      templateId: null,
      templateVersion: `stonegate-${draft.audience}-v1`,
      terms: draft.terms.trim(),
      paymentTerms: draft.paymentTerms.trim(),
      changeOrderRules: draft.changeOrderRules.trim(),
      validityDays: Number(draft.validityDays),
      consentVersion: `${draft.documentType}-consent-v1`,
    },
    estimatedDurationMinutes: Number(draft.durationMinutes),
    serviceZoneId: draft.serviceZoneId.trim() || null,
    serviceZoneConfirmed: draft.serviceZoneConfirmed,
  };
}

export class QuoteV2StaffClient {
  private readonly fetcher: FetchLike;
  private readonly basePath: string;

  constructor(options: { fetcher?: FetchLike; basePath?: string } = {}) {
    this.fetcher = options.fetcher ?? ((...args) => globalThis.fetch(...args));
    this.basePath = (options.basePath ?? "/api/team/quotes/v2").replace(
      /\/$/u,
      "",
    );
  }

  async searchContacts(input: {
    query?: string;
    contactId?: string;
    signal?: AbortSignal;
  }): Promise<QuoteV2ContactSearchResult[]> {
    const query = new URLSearchParams({ limit: "20" });
    if (input.query?.trim()) query.set("q", input.query.trim().slice(0, 200));
    if (input.contactId?.trim()) query.set("contactId", input.contactId.trim());
    const response = await this.fetcher(
      `/api/team/contacts?${query.toString()}`,
      {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: input.signal,
      },
    );
    const payload = await readJson(response);
    if (!response.ok) {
      throw new QuoteV2ClientError(
        parseApiError(response, payload, "Client search is unavailable."),
      );
    }
    const body = record(payload);
    const rows = Array.isArray(body?.["contacts"]) ? body["contacts"] : [];
    return rows.flatMap((item) => {
      const parsed = parseContact(item);
      return parsed ? [parsed] : [];
    });
  }

  async quickCreateContact(
    input: {
      firstName: string;
      lastName: string;
      email: string;
      phone: string;
      addressLine1: string;
      city: string;
      state: string;
      postalCode: string;
    },
    idempotencyKey: string,
  ): Promise<QuoteV2ContactSearchResult> {
    const response = await this.fetcher(`${this.basePath}/contacts`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify({
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        email: input.email.trim() || undefined,
        phone: input.phone.trim() || undefined,
        source: "quote_workspace",
        property: {
          addressLine1: input.addressLine1.trim(),
          city: input.city.trim(),
          state: input.state.trim(),
          postalCode: input.postalCode.trim(),
        },
      }),
    });
    const payload = await readJson(response);
    if (!response.ok) {
      throw new QuoteV2ClientError(
        parseApiError(response, payload, "The client could not be created."),
      );
    }
    const root = record(payload);
    const source = record(root?.["contact"]);
    const firstName = boundedString(source?.["firstName"], 120) ?? "";
    const lastName = boundedString(source?.["lastName"], 120) ?? "";
    const property = record(source?.["property"]);
    const parsed = parseContact({
      id: source?.["id"],
      name: `${firstName} ${lastName}`.trim(),
      email: source?.["email"],
      phone: source?.["phone"],
      phoneE164: source?.["phoneE164"],
      properties: property ? [property] : [],
    });
    if (!parsed || parsed.properties.length !== 1) {
      throw new QuoteV2ClientError({
        code: "unverified_receipt",
        message:
          "The client service returned an incomplete record. Search before retrying.",
        fieldErrors: {},
        retryable: true,
        correlationId: responseCorrelationId(response),
      });
    }
    return parsed;
  }

  async createDraft(
    draft: QuoteV2ComposerDraft,
    idempotencyKey: string,
    partnerContext?: QuoteV2PartnerContext,
  ): Promise<QuoteV2DraftReceipt> {
    return this.mutateDraft(`${this.basePath}/quotes`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({
        confirmation: "create_quote_v2",
        contactId: draft.contactId,
        propertyId: draft.propertyId,
        projectName: draft.projectName.trim(),
        projectReference: draft.projectReference.trim() || null,
        audience: draft.audience,
        documentType: draft.documentType,
        schedulingMode: draft.schedulingMode,
        ...(partnerContext
          ? {
              partnerContext: {
                accountId: partnerContext.accountId,
                target: partnerContext.target,
              },
            }
          : {}),
      }),
    });
  }

  async saveDraft(input: {
    quoteId: string;
    versionId: string;
    draftRevision: number;
    draft: QuoteV2ComposerDraft;
    preparerName: string;
    issuer: QuoteV2IssuerSnapshot;
    idempotencyKey: string;
  }): Promise<QuoteV2DraftReceipt> {
    return this.mutateDraft(
      `${this.basePath}/quotes/${encodeURIComponent(input.quoteId)}/draft`,
      {
        method: "PATCH",
        headers: {
          "Idempotency-Key": input.idempotencyKey,
          "If-Match": String(input.draftRevision),
        },
        body: JSON.stringify({
          confirmation: "save_quote_draft",
          versionId: input.versionId,
          draftRevision: input.draftRevision,
          document: quoteV2DraftDocument(input.draft, {
            preparerName: input.preparerName,
            issuer: input.issuer,
          }),
          internalNotes: input.draft.internalNotes.trim() || null,
        }),
      },
    );
  }

  async uploadAttachment(input: {
    quoteId: string;
    versionId: string;
    draftRevision: number;
    file: File;
    purpose: QuoteV2AttachmentItem["purpose"];
    customerVisible: boolean;
    label?: string;
    description?: string;
    idempotencyKey: string;
  }): Promise<QuoteV2AttachmentUploadReceipt> {
    const body = new FormData();
    body.set("file", input.file, input.file.name);
    body.set("purpose", input.purpose);
    body.set("customerVisible", String(input.customerVisible));
    if (input.label?.trim()) body.set("label", input.label.trim());
    if (input.description?.trim()) {
      body.set("description", input.description.trim());
    }
    const response = await this.fetcher(
      `${this.basePath}/quote-versions/${encodeURIComponent(input.versionId)}/attachments`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Idempotency-Key": input.idempotencyKey,
          "If-Match": String(input.draftRevision),
        },
        credentials: "same-origin",
        cache: "no-store",
        body,
      },
    );
    const payload = await readJson(response);
    if (!response.ok) {
      throw new QuoteV2ClientError(
        parseApiError(response, payload, "The attachment could not be added."),
      );
    }
    const draftReceipt = parseDraftReceipt(response, payload);
    const root = record(payload);
    const data = record(root?.["data"]) ?? root;
    const attachment = parseAttachmentItem(data);
    if (
      !draftReceipt ||
      draftReceipt.quoteId !== input.quoteId ||
      draftReceipt.versionId !== input.versionId ||
      !attachment
    ) {
      throw new QuoteV2ClientError({
        code: "unverified_receipt",
        message:
          "The attachment service returned an incomplete receipt. Refresh before retrying.",
        fieldErrors: {},
        retryable: true,
        correlationId: responseCorrelationId(response),
      });
    }
    return {
      draft: draftReceipt,
      attachment,
    };
  }

  async listAttachments(versionId: string): Promise<QuoteV2AttachmentItem[]> {
    const response = await this.fetcher(
      `${this.basePath}/quote-versions/${encodeURIComponent(versionId)}/attachments`,
      {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      },
    );
    const payload = await readJson(response);
    if (!response.ok) {
      throw new QuoteV2ClientError(
        parseApiError(response, payload, "Attachments could not be loaded."),
      );
    }
    const root = record(payload);
    const rows = Array.isArray(root?.["attachments"])
      ? root["attachments"]
      : [];
    const parsed = rows.flatMap((value) => {
      const item = parseAttachmentItem(value);
      return item ? [item] : [];
    });
    if (parsed.length !== rows.length || parsed.length > 10) {
      throw new QuoteV2ClientError({
        code: "unverified_receipt",
        message: "The attachment list could not be verified.",
        fieldErrors: {},
        retryable: true,
        correlationId: responseCorrelationId(response),
      });
    }
    return parsed;
  }

  async removeAttachment(input: {
    versionId: string;
    attachmentId: string;
    draftRevision: number;
    idempotencyKey: string;
  }): Promise<QuoteV2DraftReceipt> {
    return this.mutateDraft(
      `${this.basePath}/quote-versions/${encodeURIComponent(input.versionId)}/attachments/${encodeURIComponent(input.attachmentId)}`,
      {
        method: "DELETE",
        headers: {
          "Idempotency-Key": input.idempotencyKey,
          "If-Match": String(input.draftRevision),
        },
        body: JSON.stringify({ confirmation: "remove_quote_attachment" }),
      },
    );
  }

  async finalize(input: {
    quoteId: string;
    draftRevision: number;
    idempotencyKey: string;
  }): Promise<QuoteV2DraftReceipt> {
    return this.mutateDraft(
      `${this.basePath}/quotes/${encodeURIComponent(input.quoteId)}/finalize`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": input.idempotencyKey,
          "If-Match": String(input.draftRevision),
        },
        body: JSON.stringify({
          confirmation: "finalize_quote_version",
          draftRevision: input.draftRevision,
        }),
      },
    );
  }

  async issue(input: {
    quoteId: string;
    versionId: string;
    quoteRevision: number;
    draft: QuoteV2ComposerDraft;
    idempotencyKey: string;
  }): Promise<QuoteV2IssueReceipt> {
    const recipient = input.draft.recipient;
    const commandRecipient = (
      item: QuoteV2ComposerDraft["recipient"],
      role: "signer" | "cc" | "bcc",
    ) => ({
      role,
      name: item.name.trim(),
      email: item.email.trim() || null,
      phoneE164: item.phoneE164.trim() || null,
      channels: [
        item.emailSelected ? "email" : null,
        item.smsSelected ? "sms" : null,
      ].filter((channel): channel is "email" | "sms" => channel !== null),
    });
    const response = await this.fetcher(
      `${this.basePath}/quote-versions/${encodeURIComponent(input.versionId)}/issue`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Idempotency-Key": input.idempotencyKey,
          "If-Match": String(input.quoteRevision),
        },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({
          confirmation: "issue_quote_version",
          quoteRevision: input.quoteRevision,
          recipients: [
            commandRecipient(recipient, "signer"),
            ...input.draft.additionalRecipients.map((viewer) =>
              commandRecipient(viewer, viewer.role),
            ),
          ],
          coverMessage: input.draft.coverMessage.trim() || null,
          sendNow: true,
        }),
      },
    );
    const payload = await readJson(response);
    if (!response.ok) {
      throw new QuoteV2ClientError(
        parseApiError(response, payload, "The proposal could not be issued."),
      );
    }
    const root = record(payload);
    const data = record(root?.["data"]) ?? root;
    const quoteId = requiredString(data?.["quoteId"]);
    const versionId = requiredString(data?.["versionId"]);
    if (
      !quoteId ||
      !versionId ||
      quoteId !== input.quoteId ||
      versionId !== input.versionId
    ) {
      throw new QuoteV2ClientError({
        code: "unverified_receipt",
        message:
          "The sender returned an unverified receipt. The proposal may have been queued; refresh before retrying.",
        fieldErrors: {},
        retryable: true,
        correlationId: responseCorrelationId(response),
      });
    }
    return {
      quoteId,
      versionId,
      quoteNumber: boundedString(data?.["quoteNumber"], 80),
      sendAttemptId: boundedString(data?.["sendAttemptId"], 80),
      overallState: boundedString(data?.["overallState"], 80) ?? "requested",
      correlationId: responseCorrelationId(response),
    };
  }

  async recordStaffDecision(
    input: QuoteV2StaffDecisionInput,
  ): Promise<QuoteV2StaffDecisionReceipt> {
    const signer = {
      name: input.signer.name.trim(),
      title: input.signer.title?.trim() || undefined,
      company: input.signer.company?.trim() || undefined,
      ...(input.decision === "accepted" ? { authorityAffirmed: true } : {}),
    };
    const { response, data } = await this.mutateLifecycle({
      path: `${this.basePath}/quotes/${encodeURIComponent(input.quoteId)}/decisions`,
      quoteRevision: input.quoteRevision,
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
      fallback: "The client decision could not be recorded.",
      body:
        input.decision === "accepted"
          ? {
              confirmation: "record_quote_v2_decision",
              quoteId: input.quoteId,
              versionId: input.versionId,
              quoteRevision: input.quoteRevision,
              decision: "accepted",
              source: input.source,
              notes: input.notes.trim(),
              signer,
              selectedOptionIds: [...new Set(input.selectedOptionIds)],
              consentVersion: input.consentVersion.trim(),
              consentAffirmed: true,
              notifyCustomer: input.notifyCustomer,
            }
          : {
              confirmation: "record_quote_v2_decision",
              quoteId: input.quoteId,
              versionId: input.versionId,
              quoteRevision: input.quoteRevision,
              decision: "declined",
              source: input.source,
              notes: input.notes.trim(),
              signer,
              category: input.category,
              notifyCustomer: input.notifyCustomer,
            },
    });
    const quoteId = requiredString(data["quoteId"]);
    const versionId = requiredString(data["versionId"]);
    const responseId = requiredString(data["responseId"]);
    const quoteRevision = positiveInteger(data["quoteRevision"]);
    if (
      quoteId !== input.quoteId ||
      versionId !== input.versionId ||
      !responseId ||
      data["decision"] !== input.decision ||
      !quoteRevision ||
      quoteRevision <= input.quoteRevision
    ) {
      throw unverifiedLifecycleReceipt(response);
    }
    return {
      quoteId,
      versionId,
      responseId,
      decision: input.decision,
      quoteRevision,
      correlationId: responseCorrelationId(response),
    };
  }

  async resolveChangeRequest(
    input: QuoteV2ChangeResolutionInput,
  ): Promise<QuoteV2ChangeResolutionReceipt> {
    const { response, data } = await this.mutateLifecycle({
      path: `${this.basePath}/quotes/${encodeURIComponent(input.quoteId)}/change-requests/${encodeURIComponent(input.changeRequestId)}/resolve`,
      quoteRevision: input.quoteRevision,
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
      fallback: "The change request could not be resolved.",
      body: {
        confirmation: "resolve_quote_change_request",
        quoteId: input.quoteId,
        quoteVersionId: input.quoteVersionId,
        quoteRevision: input.quoteRevision,
        resolution: input.resolution,
        ...(input.resolution === "revision"
          ? { replacementVersionId: input.replacementVersionId }
          : {}),
        resolutionNote: input.resolutionNote.trim(),
        notifyCustomer: input.notifyCustomer,
      },
    });
    const quoteId = requiredString(data["quoteId"]);
    const changeRequestId = requiredString(data["changeRequestId"]);
    const sourceVersionId = requiredString(data["sourceVersionId"]);
    const resultingVersionId = requiredString(data["resultingVersionId"]);
    const quoteRevision = positiveInteger(data["quoteRevision"]);
    if (
      quoteId !== input.quoteId ||
      changeRequestId !== input.changeRequestId ||
      sourceVersionId !== input.quoteVersionId ||
      !resultingVersionId ||
      data["resolution"] !== input.resolution ||
      !quoteRevision ||
      quoteRevision <= input.quoteRevision ||
      (input.resolution === "revision" &&
        resultingVersionId !== input.replacementVersionId) ||
      (input.resolution === "reopen_unchanged" &&
        resultingVersionId !== input.quoteVersionId)
    ) {
      throw unverifiedLifecycleReceipt(response);
    }
    return {
      quoteId,
      changeRequestId,
      sourceVersionId,
      resultingVersionId,
      resolution: input.resolution,
      quoteRevision,
      correlationId: responseCorrelationId(response),
    };
  }

  async voidQuote(
    input: QuoteV2TerminalLifecycleInput,
  ): Promise<QuoteV2TerminalLifecycleReceipt> {
    return this.mutateTerminalLifecycle(input, "voided");
  }

  async archiveQuote(
    input: QuoteV2TerminalLifecycleInput,
  ): Promise<QuoteV2TerminalLifecycleReceipt> {
    return this.mutateTerminalLifecycle(input, "archived");
  }

  private async mutateTerminalLifecycle(
    input: QuoteV2TerminalLifecycleInput,
    state: "voided" | "archived",
  ): Promise<QuoteV2TerminalLifecycleReceipt> {
    const action = state === "voided" ? "void" : "archive";
    const { response, data } = await this.mutateLifecycle({
      path: `${this.basePath}/quotes/${encodeURIComponent(input.quoteId)}/${action}`,
      quoteRevision: input.quoteRevision,
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
      fallback: `The quote could not be ${state}.`,
      body: {
        confirmation: `${action}_quote_v2`,
        versionId: input.versionId,
        quoteRevision: input.quoteRevision,
        reason: input.reason.trim(),
        notifyCustomer: input.notifyCustomer,
      },
    });
    const quoteId = requiredString(data["quoteId"]);
    const versionId = requiredString(data["versionId"]);
    const quoteRevision = positiveInteger(data["quoteRevision"]);
    if (
      quoteId !== input.quoteId ||
      versionId !== input.versionId ||
      data["state"] !== state ||
      !quoteRevision ||
      quoteRevision <= input.quoteRevision
    ) {
      throw unverifiedLifecycleReceipt(response);
    }
    return {
      quoteId,
      versionId,
      state,
      quoteRevision,
      correlationId: responseCorrelationId(response),
    };
  }

  private async mutateLifecycle(input: {
    path: string;
    quoteRevision: number;
    idempotencyKey: string;
    correlationId?: string;
    body: Record<string, unknown>;
    fallback: string;
  }): Promise<{ response: Response; data: Record<string, unknown> }> {
    const headers = new Headers({
      Accept: "application/json",
      "Content-Type": "application/json",
      "Idempotency-Key": input.idempotencyKey,
      "If-Match": String(input.quoteRevision),
    });
    if (input.correlationId?.trim()) {
      headers.set("x-correlation-id", input.correlationId.trim());
    }
    const response = await this.fetcher(input.path, {
      method: "POST",
      headers,
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify(input.body),
    });
    const payload = await readJson(response);
    if (!response.ok) {
      throw new QuoteV2ClientError(
        parseApiError(response, payload, input.fallback),
      );
    }
    const root = record(payload);
    const data = record(root?.["data"]);
    if (!data) throw unverifiedLifecycleReceipt(response);
    return { response, data };
  }

  private async mutateDraft(
    path: string,
    init: RequestInit,
  ): Promise<QuoteV2DraftReceipt> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    headers.set("Content-Type", "application/json");
    const response = await this.fetcher(path, {
      ...init,
      headers,
      credentials: "same-origin",
      cache: "no-store",
    });
    const payload = await readJson(response);
    if (!response.ok) {
      throw new QuoteV2ClientError(
        parseApiError(response, payload, "The quote draft could not be saved."),
      );
    }
    const receipt = parseDraftReceipt(response, payload);
    if (!receipt) {
      throw new QuoteV2ClientError({
        code: "unverified_receipt",
        message:
          "The server did not return a complete quote receipt. Keep this page open and refresh before retrying.",
        fieldErrors: {},
        retryable: true,
        correlationId: responseCorrelationId(response),
      });
    }
    return receipt;
  }
}
