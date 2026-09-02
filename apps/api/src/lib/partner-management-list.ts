import { createHash } from "node:crypto";

export const PARTNER_MANAGEMENT_DEFAULT_LIMIT = 50;
export const PARTNER_MANAGEMENT_MAX_LIMIT = 100;

export type PartnerManagementResource =
  | "account-merges"
  | "accounts"
  | "applications"
  | "billing-disputes"
  | "cancellation-requests"
  | "change-requests"
  | "commercial"
  | "domains"
  | "invitations"
  | "join-requests"
  | "location-reviews"
  | "memberships"
  | "people"
  | "quarantine"
  | "security";

export type PartnerManagementListQuery = {
  accountId: string | null;
  cursor: PartnerManagementCursor | null;
  filterHash: string;
  limit: number;
  q: string | null;
  resource: PartnerManagementResource;
  status: string | null;
  userId: string | null;
};

type PartnerManagementCursor = {
  createdAt: string;
  filterHash: string;
  id: string;
  resource: PartnerManagementResource;
  version: 1;
};

export class PartnerManagementListInputError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "PartnerManagementListInputError";
    this.field = field;
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_CURSOR_LENGTH = 1_200;
const ALLOWED_KEYS = new Set([
  "accountId",
  "cursor",
  "limit",
  "q",
  "status",
  "userId",
]);

const RESOURCE_STATUSES: Record<
  PartnerManagementResource,
  ReadonlySet<string>
> = {
  "account-merges": new Set([
    "needs_reconciliation",
    "ready",
    "completed",
    "cancelled",
  ]),
  accounts: new Set([
    "imported",
    "ready_for_first_touch",
    "attempting_contact",
    "conversation_active",
    "qualified_partner",
    "trial_partner",
    "active_partner",
    "portal_partner",
    "managed_partner",
    "dormant",
    "not_a_fit",
  ]),
  applications: new Set([
    "submitted",
    "under_review",
    "needs_information",
    "approved",
    "declined",
    "withdrawn",
  ]),
  "billing-disputes": new Set([
    "pending",
    "information_provided",
    "adjustment_required",
    "refund_review",
    "declined",
  ]),
  "cancellation-requests": new Set(["pending", "approved", "declined"]),
  "change-requests": new Set([
    "pending",
    "approved",
    "declined",
    "change_order_required",
  ]),
  commercial: new Set(["ready", "attention_required", "unconfigured"]),
  domains: new Set(["pending", "verified", "revoked"]),
  invitations: new Set(["pending", "accepted", "revoked", "expired"]),
  "join-requests": new Set([
    "submitted",
    "under_review",
    "needs_information",
    "approved",
    "declined",
    "withdrawn",
  ]),
  "location-reviews": new Set([
    "pending",
    "verified",
    "correction_required",
    "dismissed",
  ]),
  memberships: new Set(["invited", "active", "suspended", "removed"]),
  people: new Set([
    "pending_activation",
    "active",
    "suspended",
    "disabled",
    "quarantined",
  ]),
  quarantine: new Set(["contained", "reconciliation_required", "resolved"]),
  security: new Set(["active", "expired", "revoked"]),
};

function singleValue(params: URLSearchParams, key: string): string | null {
  const values = params.getAll(key);
  if (values.length > 1) {
    throw new PartnerManagementListInputError(
      key,
      `${key} may only be provided once.`,
    );
  }
  return values[0] ?? null;
}

function normalizedText(
  params: URLSearchParams,
  key: string,
  maximum: number,
): string | null {
  const raw = singleValue(params, key);
  if (raw === null) return null;
  const value = raw.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (
    value.length === 0 ||
    value.length > maximum ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new PartnerManagementListInputError(
      key,
      `${key} must contain 1–${maximum} safe characters.`,
    );
  }
  return value;
}

function normalizedUuid(params: URLSearchParams, key: string): string | null {
  const raw = singleValue(params, key);
  if (raw === null) return null;
  const value = raw.trim().toLowerCase();
  if (!UUID_PATTERN.test(value)) {
    throw new PartnerManagementListInputError(key, `Choose a valid ${key}.`);
  }
  return value;
}

function filterHash(input: {
  accountId: string | null;
  limit: number;
  q: string | null;
  resource: PartnerManagementResource;
  status: string | null;
  userId: string | null;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, ...input }), "utf8")
    .digest("hex");
}

function isExactInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function encodeCursor(cursor: PartnerManagementCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): PartnerManagementCursor | null {
  if (
    !value ||
    value.length > MAX_CURSOR_LENGTH ||
    !BASE64URL_PATTERN.test(value)
  ) {
    return null;
  }
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.byteLength > 900) return null;
    const parsed = JSON.parse(decoded.toString("utf8")) as Record<
      string,
      unknown
    >;
    if (
      Object.keys(parsed).sort().join(",") !==
        "createdAt,filterHash,id,resource,version" ||
      parsed["version"] !== 1 ||
      typeof parsed["resource"] !== "string" ||
      !(parsed["resource"] in RESOURCE_STATUSES) ||
      typeof parsed["filterHash"] !== "string" ||
      !HASH_PATTERN.test(parsed["filterHash"]) ||
      typeof parsed["id"] !== "string" ||
      !UUID_PATTERN.test(parsed["id"]) ||
      !isExactInstant(parsed["createdAt"])
    ) {
      return null;
    }
    const cursor = parsed as PartnerManagementCursor;
    return encodeCursor(cursor) === value ? cursor : null;
  } catch {
    return null;
  }
}

export function parsePartnerManagementListQuery(
  params: URLSearchParams,
  resource: PartnerManagementResource,
): PartnerManagementListQuery {
  for (const key of params.keys()) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new PartnerManagementListInputError(
        key,
        `Unsupported ${resource} list parameter: ${key}.`,
      );
    }
  }

  const q = params.has("q") ? normalizedText(params, "q", 160) : null;
  const accountId = normalizedUuid(params, "accountId");
  const userId = normalizedUuid(params, "userId");
  const rawStatus = singleValue(params, "status");
  const status = rawStatus?.trim().toLowerCase() || null;
  if (status && !RESOURCE_STATUSES[resource].has(status)) {
    throw new PartnerManagementListInputError(
      "status",
      `Choose a supported ${resource} status.`,
    );
  }

  const rawLimit = singleValue(params, "limit") ?? "50";
  if (!/^[1-9]\d{0,2}$/u.test(rawLimit)) {
    throw new PartnerManagementListInputError(
      "limit",
      "limit must be a positive whole number.",
    );
  }
  const limit = Number(rawLimit);
  if (limit > PARTNER_MANAGEMENT_MAX_LIMIT) {
    throw new PartnerManagementListInputError(
      "limit",
      `limit must be between 1 and ${PARTNER_MANAGEMENT_MAX_LIMIT}.`,
    );
  }

  const supportsAccountFilter = new Set<PartnerManagementResource>([
    "account-merges",
    "applications",
    "billing-disputes",
    "cancellation-requests",
    "change-requests",
    "commercial",
    "domains",
    "invitations",
    "join-requests",
    "location-reviews",
    "memberships",
    "quarantine",
    "security",
  ]);
  const supportsUserFilter = new Set<PartnerManagementResource>([
    "applications",
    "join-requests",
    "memberships",
    "people",
    "quarantine",
    "security",
  ]);
  if (accountId && !supportsAccountFilter.has(resource)) {
    throw new PartnerManagementListInputError(
      "accountId",
      `accountId is not supported by the ${resource} directory.`,
    );
  }
  if (userId && !supportsUserFilter.has(resource)) {
    throw new PartnerManagementListInputError(
      "userId",
      `userId is not supported by the ${resource} directory.`,
    );
  }

  const resolvedFilterHash = filterHash({
    accountId,
    limit,
    q: q?.toLowerCase() ?? null,
    resource,
    status,
    userId,
  });
  const rawCursor = singleValue(params, "cursor");
  const cursor = rawCursor ? decodeCursor(rawCursor) : null;
  if (rawCursor !== null && !cursor) {
    throw new PartnerManagementListInputError(
      "cursor",
      "The cursor is invalid. Return to the first page and try again.",
    );
  }
  if (
    cursor &&
    (cursor.resource !== resource || cursor.filterHash !== resolvedFilterHash)
  ) {
    throw new PartnerManagementListInputError(
      "cursor",
      "The cursor belongs to a different list or filter set.",
    );
  }

  return {
    accountId,
    cursor,
    filterHash: resolvedFilterHash,
    limit,
    q,
    resource,
    status,
    userId,
  };
}

export function buildPartnerManagementPage<
  T extends { createdAt: Date; id: string },
>(
  rows: readonly T[],
  query: PartnerManagementListQuery,
): {
  items: T[];
  page: {
    hasMore: boolean;
    limit: number;
    nextCursor: string | null;
    returned: number;
  };
} {
  const hasMore = rows.length > query.limit;
  const items = rows.slice(0, query.limit);
  const last = items.at(-1) ?? null;
  return {
    items,
    page: {
      hasMore,
      limit: query.limit,
      nextCursor:
        hasMore && last
          ? encodeCursor({
              createdAt: last.createdAt.toISOString(),
              filterHash: query.filterHash,
              id: last.id,
              resource: query.resource,
              version: 1,
            })
          : null,
      returned: items.length,
    },
  };
}

export function escapedPartnerManagementSearch(value: string): string {
  return `%${value
    .replace(/\\/gu, "\\\\")
    .replace(/[%_]/gu, "\\$&")
    .replace(/\s+/gu, "%")}%`;
}
