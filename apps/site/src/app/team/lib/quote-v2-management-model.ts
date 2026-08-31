export type QuoteV2ManageBucket =
  | "needs_action"
  | "drafts"
  | "awaiting_client"
  | "accepted_booked"
  | "closed";

export type QuoteV2ManageSort =
  | "next_action"
  | "updated_desc"
  | "expiry_asc"
  | "total_desc";

export type QuoteV2ManageRow = {
  id: string;
  quoteNumber: string;
  aggregateState: string;
  quoteRevision: number;
  currentVersionId: string | null;
  publishedVersionId: string | null;
  versionNumber: number | null;
  versionState: string | null;
  documentType: string | null;
  audience: string | null;
  client: { name: string | null; company: string | null };
  project: {
    name: string | null;
    purchaseOrder: string | null;
    property: {
      addressLine1: string | null;
      city: string | null;
      state: string | null;
    };
  };
  totals: {
    minimumCents: number | null;
    maximumCents: number | null;
    depositCents: number | null;
    currency: "USD";
  };
  expiresAt: string | null;
  updatedAt: string | null;
  deliveryState: string | null;
  owner: { id: string; name: string } | null;
  bucket: QuoteV2ManageBucket;
  nextAction: { code: string; label: string };
};

export type QuoteV2ManagePage = {
  quotes: QuoteV2ManageRow[];
  nextCursor: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  const values: unknown[] = value;
  return values.filter(isRecord);
}

function nullableString(value: unknown): string | null | undefined {
  return value === null || typeof value === "string" ? value : undefined;
}

function nullableSafeInteger(value: unknown): number | null | undefined {
  return value === null || (Number.isSafeInteger(value) && Number(value) >= 0)
    ? (value as number | null)
    : undefined;
}

const BUCKETS = new Set<QuoteV2ManageBucket>([
  "needs_action",
  "drafts",
  "awaiting_client",
  "accepted_booked",
  "closed",
]);

export function normalizeQuoteV2ManageRow(
  value: unknown,
): QuoteV2ManageRow | null {
  if (!isRecord(value)) return null;
  const client = value["client"];
  const project = value["project"];
  const totals = value["totals"];
  const property = isRecord(project) ? project["property"] : null;
  const nextAction = value["nextAction"];
  const owner = value["owner"];
  const bucket = value["bucket"];
  const quoteNumber = nullableString(value["quoteNumber"]);
  const currentVersionId = nullableString(value["currentVersionId"]);
  const publishedVersionId = nullableString(value["publishedVersionId"]);
  const versionNumber = nullableSafeInteger(value["versionNumber"]);
  const minimumCents = nullableSafeInteger(
    isRecord(totals) ? totals["minimumCents"] : undefined,
  );
  const maximumCents = nullableSafeInteger(
    isRecord(totals) ? totals["maximumCents"] : undefined,
  );
  const depositCents = nullableSafeInteger(
    isRecord(totals) ? totals["depositCents"] : undefined,
  );
  if (
    typeof value["id"] !== "string" ||
    !quoteNumber ||
    typeof value["aggregateState"] !== "string" ||
    !Number.isSafeInteger(value["quoteRevision"]) ||
    Number(value["quoteRevision"]) <= 0 ||
    currentVersionId === undefined ||
    publishedVersionId === undefined ||
    versionNumber === undefined ||
    !isRecord(client) ||
    nullableString(client["name"]) === undefined ||
    nullableString(client["company"]) === undefined ||
    !isRecord(project) ||
    nullableString(project["name"]) === undefined ||
    nullableString(project["purchaseOrder"]) === undefined ||
    !isRecord(property) ||
    nullableString(property["addressLine1"]) === undefined ||
    nullableString(property["city"]) === undefined ||
    nullableString(property["state"]) === undefined ||
    !isRecord(totals) ||
    totals["currency"] !== "USD" ||
    minimumCents === undefined ||
    maximumCents === undefined ||
    depositCents === undefined ||
    !BUCKETS.has(bucket as QuoteV2ManageBucket) ||
    !isRecord(nextAction) ||
    typeof nextAction["code"] !== "string" ||
    typeof nextAction["label"] !== "string" ||
    (owner !== null &&
      (!isRecord(owner) ||
        typeof owner["id"] !== "string" ||
        typeof owner["name"] !== "string"))
  ) {
    return null;
  }
  return {
    id: value["id"],
    quoteNumber,
    aggregateState: value["aggregateState"],
    quoteRevision: Number(value["quoteRevision"]),
    currentVersionId,
    publishedVersionId,
    versionNumber,
    versionState: nullableString(value["versionState"]) ?? null,
    documentType: nullableString(value["documentType"]) ?? null,
    audience: nullableString(value["audience"]) ?? null,
    client: {
      name: nullableString(client["name"]) ?? null,
      company: nullableString(client["company"]) ?? null,
    },
    project: {
      name: nullableString(project["name"]) ?? null,
      purchaseOrder: nullableString(project["purchaseOrder"]) ?? null,
      property: {
        addressLine1: nullableString(property["addressLine1"]) ?? null,
        city: nullableString(property["city"]) ?? null,
        state: nullableString(property["state"]) ?? null,
      },
    },
    totals: {
      minimumCents,
      maximumCents,
      depositCents,
      currency: "USD",
    },
    expiresAt: nullableString(value["expiresAt"]) ?? null,
    updatedAt: nullableString(value["updatedAt"]) ?? null,
    deliveryState: nullableString(value["deliveryState"]) ?? null,
    owner: owner as QuoteV2ManageRow["owner"],
    bucket: bucket as QuoteV2ManageBucket,
    nextAction: {
      code: nextAction["code"],
      label: nextAction["label"],
    },
  };
}

export function normalizeQuoteV2ManagePage(
  value: unknown,
): QuoteV2ManagePage | null {
  if (!isRecord(value) || !Array.isArray(value["quotes"])) return null;
  const quotes = value["quotes"].map(normalizeQuoteV2ManageRow);
  const nextCursor = nullableString(value["nextCursor"]);
  if (quotes.some((quote) => !quote) || nextCursor === undefined) return null;
  return {
    quotes: quotes as QuoteV2ManageRow[],
    nextCursor,
  };
}

export function quoteV2ManageAmount(row: QuoteV2ManageRow): string {
  const minimum = row.totals.minimumCents;
  const maximum = row.totals.maximumCents;
  if (minimum === null || maximum === null) return "Pricing incomplete";
  const formatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  });
  return minimum === maximum
    ? formatter.format(minimum / 100)
    : `${formatter.format(minimum / 100)}–${formatter.format(maximum / 100)}`;
}

export function isQuoteV2DetailPayload(
  value: unknown,
): value is { ok: true; quote: Record<string, unknown> } {
  return (
    isRecord(value) &&
    value["ok"] === true &&
    isRecord(value["quote"]) &&
    typeof value["quote"]["id"] === "string" &&
    Array.isArray(value["quote"]["versions"]) &&
    Array.isArray(value["quote"]["sendAttempts"]) &&
    Array.isArray(value["quote"]["responses"]) &&
    Array.isArray(value["quote"]["activity"])
  );
}

export type QuoteV2DecisionOptionChoice = {
  id: string;
  label: string;
  selectedByDefault: boolean;
};

export type QuoteV2ChangeResolutionUiState = {
  requestId: string;
  sourceVersionId: string;
  canReopenUnchanged: boolean;
  replacementVersionId: string | null;
};

export type QuoteV2LifecycleUiState = {
  quoteId: string;
  quoteRevision: number;
  aggregateState: string;
  currentVersionId: string;
  publishedVersionId: string | null;
  publishedVersionNumber: number | null;
  canRecordDecision: boolean;
  canVoid: boolean;
  canArchive: boolean;
  canNotifyCustomer: boolean;
  consentVersion: string | null;
  optionChoices: QuoteV2DecisionOptionChoice[];
  openChangeRequest: Record<string, unknown> | null;
  changeResolution: QuoteV2ChangeResolutionUiState | null;
};

function futureInstant(value: unknown, nowMs: number): boolean {
  if (typeof value !== "string") return false;
  const milliseconds = new Date(value).getTime();
  return Number.isFinite(milliseconds) && milliseconds > nowMs;
}

function matchingVersion(
  versions: Array<Record<string, unknown>>,
  versionId: string | null,
): Record<string, unknown> | null {
  return versionId
    ? (versions.find((version) => version["id"] === versionId) ?? null)
    : null;
}

export function quoteV2LifecycleUiState(
  value: unknown,
  nowMs = Date.now(),
): QuoteV2LifecycleUiState | null {
  if (!isRecord(value)) return null;
  const quoteId = trimmedString(value["id"], 80);
  const quoteRevision = Number(value["quoteRevision"]);
  const aggregateState = trimmedString(value["aggregateState"], 40);
  const currentVersionId = trimmedString(value["currentVersionId"], 80);
  const publishedVersionId = trimmedString(value["publishedVersionId"], 80);
  if (
    !quoteId ||
    !Number.isSafeInteger(quoteRevision) ||
    quoteRevision <= 0 ||
    !aggregateState ||
    !currentVersionId
  ) {
    return null;
  }
  const versions = recordArray(value["versions"]);
  const currentVersion = matchingVersion(versions, currentVersionId);
  const publishedVersion = matchingVersion(versions, publishedVersionId);
  if (!currentVersion) return null;
  const changes = recordArray(value["changeRequests"]);
  const openChangeRequest =
    changes.find(
      (change) =>
        typeof change["id"] === "string" &&
        typeof change["quoteVersionId"] === "string" &&
        (change["status"] === "open" || change["status"] === "acknowledged"),
    ) ?? null;
  const currentIsPublished =
    Boolean(publishedVersionId) && currentVersionId === publishedVersionId;
  const publishedIsActionable = Boolean(
    currentIsPublished &&
      publishedVersion?.["state"] === "issued" &&
      futureInstant(publishedVersion["expiresAt"], nowMs),
  );
  const opportunity = isRecord(value["opportunity"])
    ? value["opportunity"]
    : null;
  const canArchive =
    aggregateState === "draft" ||
    aggregateState === "declined" ||
    aggregateState === "voided" ||
    (aggregateState === "accepted" && opportunity?.["status"] === "won");

  const document = isRecord(publishedVersion?.["documentSnapshot"])
    ? publishedVersion["documentSnapshot"]
    : null;
  const terms = isRecord(document?.["terms"]) ? document["terms"] : null;
  const pricing = isRecord(document?.["pricing"]) ? document["pricing"] : null;
  const lineItems = recordArray(pricing?.["lineItems"]);
  const frozenSelections = new Set(
    Array.isArray(publishedVersion?.["selectedOptionIds"])
      ? publishedVersion["selectedOptionIds"].filter(
          (selection): selection is string => typeof selection === "string",
        )
      : [],
  );
  const optionChoices = lineItems.flatMap((line) => {
    const id = trimmedString(line["id"], 80);
    const label = trimmedString(line["name"], 240);
    const optionGroupId = trimmedString(line["optionGroupId"], 80);
    if (!id || !label || !optionGroupId) return [];
    return [
      {
        id,
        label,
        selectedByDefault:
          frozenSelections.has(id) ||
          (frozenSelections.size === 0 && line["selectedByDefault"] === true),
      },
    ];
  });

  let changeResolution: QuoteV2ChangeResolutionUiState | null = null;
  if (openChangeRequest) {
    const requestId = trimmedString(openChangeRequest["id"], 80);
    const sourceVersionId = trimmedString(
      openChangeRequest["quoteVersionId"],
      80,
    );
    const sourceVersion = matchingVersion(versions, sourceVersionId);
    if (requestId && sourceVersionId && sourceVersion) {
      const canReopenUnchanged = Boolean(
        aggregateState === "open" &&
          currentVersionId === sourceVersionId &&
          publishedVersionId === sourceVersionId &&
          sourceVersion["state"] === "issued" &&
          futureInstant(sourceVersion["expiresAt"], nowMs),
      );
      const replacement =
        aggregateState === "open" &&
        currentIsPublished &&
        publishedVersion?.["state"] === "issued" &&
        publishedVersion["supersedesVersionId"] === sourceVersionId &&
        (sourceVersion["state"] === "superseded" ||
          sourceVersion["state"] === "expired") &&
        futureInstant(publishedVersion["expiresAt"], nowMs)
          ? publishedVersionId
          : null;
      changeResolution = {
        requestId,
        sourceVersionId,
        canReopenUnchanged,
        replacementVersionId: replacement,
      };
    }
  }

  return {
    quoteId,
    quoteRevision,
    aggregateState,
    currentVersionId,
    publishedVersionId,
    publishedVersionNumber:
      publishedVersion &&
      Number.isSafeInteger(publishedVersion["versionNumber"])
        ? Number(publishedVersion["versionNumber"])
        : null,
    canRecordDecision:
      aggregateState === "open" && publishedIsActionable && !openChangeRequest,
    canVoid:
      (aggregateState === "draft" || aggregateState === "open") &&
      Boolean(currentVersion),
    canArchive,
    canNotifyCustomer: Boolean(publishedVersionId),
    consentVersion: trimmedString(terms?.["consentVersion"], 80),
    optionChoices,
    openChangeRequest,
    changeResolution,
  };
}

const ACTIVE_SEND_ATTEMPT_STATES = new Set(["requested", "processing"]);

export function quoteV2SendAttemptIsActive(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value["status"] === "string" &&
    ACTIVE_SEND_ATTEMPT_STATES.has(value["status"])
  );
}

export function quoteV2DeliveryIsRetryable(input: {
  attempt: unknown;
  delivery: unknown;
  publishedVersionId: string | null;
}): boolean {
  if (
    !input.publishedVersionId ||
    !isRecord(input.attempt) ||
    !isRecord(input.delivery)
  ) {
    return false;
  }
  return (
    input.attempt["quoteVersionId"] === input.publishedVersionId &&
    input.delivery["status"] === "failed" &&
    typeof input.delivery["id"] === "string" &&
    (input.delivery["channel"] === "email" ||
      input.delivery["channel"] === "sms")
  );
}

export type QuoteV2ResendRecipientDefaults = {
  name: string;
  email: string;
  phoneE164: string;
  emailSelected: boolean;
  smsSelected: boolean;
};

function trimmedString(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : null;
}

export function quoteV2ResendRecipientDefaults(
  detail: unknown,
  publishedVersionId: string | null,
): QuoteV2ResendRecipientDefaults {
  const quote = isRecord(detail) ? detail : null;
  const versions = Array.isArray(quote?.["versions"])
    ? quote["versions"].filter(isRecord)
    : [];
  const version = versions.find(
    (candidate) => candidate["id"] === publishedVersionId,
  );
  const document = isRecord(version?.["documentSnapshot"])
    ? version["documentSnapshot"]
    : null;
  const parties = isRecord(document?.["parties"]) ? document["parties"] : null;
  const contact = isRecord(quote?.["contact"]) ? quote["contact"] : null;
  const name =
    trimmedString(parties?.["attentionName"], 240) ??
    trimmedString(parties?.["customerName"], 240) ??
    trimmedString(contact?.["name"], 240) ??
    "";
  const partyEmail = trimmedString(parties?.["email"], 320);
  const contactEmail = trimmedString(contact?.["email"], 320);
  const email =
    partyEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(partyEmail)
      ? partyEmail
      : contactEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(contactEmail)
        ? contactEmail
        : "";
  const partyPhone = trimmedString(parties?.["phoneE164"], 32);
  const contactPhone = trimmedString(contact?.["phone"], 32);
  const phoneE164 =
    partyPhone && /^\+[1-9]\d{7,14}$/u.test(partyPhone)
      ? partyPhone
      : contactPhone && /^\+[1-9]\d{7,14}$/u.test(contactPhone)
        ? contactPhone
        : "";

  const attempts = recordArray(quote?.["sendAttempts"]);
  const latestSignerDeliveries = attempts
    .filter((attempt) => attempt["quoteVersionId"] === publishedVersionId)
    .map((attempt) =>
      recordArray(attempt["deliveries"]).filter(
        (delivery) => delivery["recipientRole"] === "signer",
      ),
    )
    .find((deliveries) => deliveries.length > 0);
  let emailSelected = Boolean(
    email &&
      latestSignerDeliveries?.some(
        (delivery) => delivery["channel"] === "email",
      ),
  );
  let smsSelected = Boolean(
    phoneE164 &&
      latestSignerDeliveries?.some((delivery) => delivery["channel"] === "sms"),
  );
  if (!emailSelected && !smsSelected) {
    emailSelected = Boolean(email);
    smsSelected = !emailSelected && Boolean(phoneE164);
  }
  return { name, email, phoneE164, emailSelected, smsSelected };
}
