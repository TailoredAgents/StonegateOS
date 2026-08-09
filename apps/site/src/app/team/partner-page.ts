export type PartnerRow = {
  id: string;
  company: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  partnerStatus: "partner" | "prospect" | "contacted" | "inactive" | "none";
  partnerType: string | null;
  partnerOwnerMemberId: string | null;
  partnerOwnerName: string | null;
  partnerSince: string | null;
  partnerLastTouchAt: string | null;
  partnerNextTouchAt: string | null;
  partnerReferralCount: number;
  partnerLastReferralAt: string | null;
  version: string;
};

export type PartnerPage = {
  version: 1;
  complete: true;
  order: "next_touch_ascending";
  position: "start" | "history";
  limit: number;
  returned: number;
  totalAtSnapshot: number;
  asOf: string;
  hasPrevious: boolean;
  hasNext: boolean;
  previousCursor: string | null;
  nextCursor: string | null;
};

export type PartnersResponse = {
  ok: true;
  total: number;
  limit: number;
  page: PartnerPage;
  partners: PartnerRow[];
};

export type PartnerRateItem = {
  id: string;
  serviceKey: string;
  tierKey: string;
  label: string | null;
  amountCents: number;
  sortOrder: number;
  createdAt: string;
};

export type PartnerRatesResponse = {
  ok: true;
  orgContactId: string;
  currency: "USD";
  active: boolean;
  version: string;
  precedence: {
    booking: "exact_partner_service_and_tier";
    missingRate: "no_quoted_amount";
  };
  items: PartnerRateItem[];
};

export type PartnerPortalUserRow = {
  id: string;
  orgContactId: string;
  email: string;
  phone: string | null;
  phoneE164: string | null;
  name: string;
  active: boolean;
  passwordSetAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PartnerPortalUsersResponse = {
  ok: true;
  organization: {
    id: string;
    partnerStatus: PartnerRow["partnerStatus"];
    version: string;
  };
  users: PartnerPortalUserRow[];
};

export type PartnerInviteChannel = "email" | "sms";

export type PartnerInviteSuccess = {
  data: {
    user: {
      id: string;
      orgContactId: string;
      email: string;
      phone: string | null;
      phoneE164: string | null;
      name: string;
      active: true;
      createdAt: string;
    };
    delivery: {
      state: "succeeded";
      acceptedChannels: PartnerInviteChannel[];
      failedChannels: PartnerInviteChannel[];
      uncertainChannels: [];
      providerOperationIds: string[];
      providerExactlyOnceClaimed: false;
    };
  };
  receipt: {
    operationId: string;
    correlationId: string;
    actorId: string;
    committedAt: string;
    auditEventId: string;
    entityType: "partner_user";
    entityId: string;
    providerOperationId?: string;
  };
};

export type PartnerPortalAccessChangeData = {
  userId: string;
  orgContactId: string;
  active: boolean;
  version: string;
  sessionsRevoked: number;
  tokensInvalidated: number;
};

export type PartnerPortalAccessChangeSuccess = {
  data: PartnerPortalAccessChangeData;
  receipt: {
    operationId: string;
    correlationId: string;
    actorId: string;
    committedAt: string;
    auditEventId: string;
    entityType: "partner_user";
    entityId: string;
    version: string;
  };
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const E164_PATTERN = /^\+[1-9][0-9]{7,14}$/u;
const STATUSES = new Set([
  "partner",
  "prospect",
  "contacted",
  "inactive",
  "none",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSafeCount(value: unknown, maximum = 100_000_000): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= maximum
  );
}

function isInstant(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_INSTANT_PATTERN.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isNullableInstant(value: unknown): value is string | null {
  return value === null || isInstant(value);
}

function isNullableText(
  value: unknown,
  maximum: number,
): value is string | null {
  return (
    value === null || (typeof value === "string" && value.length <= maximum)
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function isPartnerInviteChannelArray(
  value: unknown,
  options: { maximum?: number; allowEmpty?: boolean } = {},
): value is PartnerInviteChannel[] {
  if (!Array.isArray(value) || value.length > (options.maximum ?? 2)) {
    return false;
  }
  if (options.allowEmpty !== true && value.length === 0) return false;
  const channels = value.filter(
    (channel): channel is PartnerInviteChannel =>
      channel === "email" || channel === "sms",
  );
  return (
    channels.length === value.length && new Set(channels).size === value.length
  );
}

function isCursor(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      value.length > 0 &&
      value.length <= 1_600 &&
      BASE64URL_PATTERN.test(value))
  );
}

function isPartnerRow(value: unknown): value is PartnerRow {
  if (!isRecord(value)) return false;
  const status = value["partnerStatus"];
  return (
    typeof value["id"] === "string" &&
    UUID_PATTERN.test(value["id"]) &&
    isNullableText(value["company"], 2_000) &&
    typeof value["name"] === "string" &&
    value["name"].length > 0 &&
    value["name"].length <= 2_000 &&
    isNullableText(value["email"], 320) &&
    isNullableText(value["phone"], 64) &&
    typeof status === "string" &&
    STATUSES.has(status) &&
    isNullableText(value["partnerType"], 256) &&
    (value["partnerOwnerMemberId"] === null ||
      (typeof value["partnerOwnerMemberId"] === "string" &&
        UUID_PATTERN.test(value["partnerOwnerMemberId"]))) &&
    isNullableText(value["partnerOwnerName"], 512) &&
    isNullableInstant(value["partnerSince"]) &&
    isNullableInstant(value["partnerLastTouchAt"]) &&
    isNullableInstant(value["partnerNextTouchAt"]) &&
    isSafeCount(value["partnerReferralCount"]) &&
    isNullableInstant(value["partnerLastReferralAt"]) &&
    isInstant(value["version"])
  );
}

function isPartnerPage(value: unknown): value is PartnerPage {
  if (!isRecord(value)) return false;
  const limit = value["limit"];
  const returned = value["returned"];
  const total = value["totalAtSnapshot"];
  const hasPrevious = value["hasPrevious"];
  const hasNext = value["hasNext"];
  const previousCursor = value["previousCursor"];
  const nextCursor = value["nextCursor"];
  return (
    value["version"] === 1 &&
    value["complete"] === true &&
    value["order"] === "next_touch_ascending" &&
    (value["position"] === "start" || value["position"] === "history") &&
    isSafeCount(limit, 100) &&
    limit >= 1 &&
    isSafeCount(returned, 100) &&
    returned <= limit &&
    isSafeCount(total) &&
    returned <= total &&
    isInstant(value["asOf"]) &&
    typeof hasPrevious === "boolean" &&
    typeof hasNext === "boolean" &&
    isCursor(previousCursor) &&
    isCursor(nextCursor) &&
    (hasPrevious ? previousCursor !== null : previousCursor === null) &&
    (hasNext ? nextCursor !== null : nextCursor === null) &&
    (value["position"] === "history" || !hasPrevious) &&
    (returned > 0 ||
      (value["position"] === "start" &&
        total === 0 &&
        !hasPrevious &&
        !hasNext))
  );
}

export function parsePartnersResponse(
  value: unknown,
  expected?: {
    limit: number;
    status: string;
    ownerId: string | null;
    type: string | null;
  },
): PartnersResponse | null {
  if (!isRecord(value) || value["ok"] !== true) return null;
  const partners = value["partners"];
  const page = value["page"];
  if (!Array.isArray(partners) || !isPartnerPage(page)) return null;
  if (
    partners.length !== page.returned ||
    partners.length > page.limit ||
    !partners.every(isPartnerRow) ||
    new Set(partners.map((partner) => partner.id)).size !== partners.length ||
    value["total"] !== page.totalAtSnapshot ||
    value["limit"] !== page.limit ||
    (expected !== undefined &&
      (page.limit !== expected.limit ||
        partners.some(
          (partner) =>
            partner.partnerStatus !== expected.status.toLowerCase() ||
            (expected.ownerId !== null &&
              partner.partnerOwnerMemberId !==
                expected.ownerId.toLowerCase()) ||
            (expected.type !== null &&
              partner.partnerType?.normalize("NFKC").trim().toLowerCase() !==
                expected.type.normalize("NFKC").trim().toLowerCase()),
        )))
  ) {
    return null;
  }
  return value as PartnersResponse;
}

export function parsePartnerPortalUsersResponse(
  value: unknown,
  expectedOrgContactId: string,
): PartnerPortalUsersResponse | null {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "ok,organization,users" ||
    value["ok"] !== true ||
    !isRecord(value["organization"]) ||
    !Array.isArray(value["users"]) ||
    value["users"].length > 100
  ) {
    return null;
  }
  const organization = value["organization"];
  if (
    Object.keys(organization).sort().join(",") !== "id,partnerStatus,version" ||
    typeof organization["id"] !== "string" ||
    !UUID_PATTERN.test(organization["id"]) ||
    organization["id"].toLowerCase() !== expectedOrgContactId.toLowerCase() ||
    typeof organization["partnerStatus"] !== "string" ||
    !STATUSES.has(organization["partnerStatus"]) ||
    !isInstant(organization["version"])
  ) {
    return null;
  }

  const ids = new Set<string>();
  const emails = new Set<string>();
  const phones = new Set<string>();
  for (const user of value["users"]) {
    if (
      !isRecord(user) ||
      Object.keys(user).sort().join(",") !==
        "active,createdAt,email,id,name,orgContactId,passwordSetAt,phone,phoneE164,updatedAt" ||
      typeof user["id"] !== "string" ||
      !UUID_PATTERN.test(user["id"]) ||
      typeof user["orgContactId"] !== "string" ||
      user["orgContactId"].toLowerCase() !==
        expectedOrgContactId.toLowerCase() ||
      typeof user["email"] !== "string" ||
      user["email"].length < 3 ||
      user["email"].length > 320 ||
      !EMAIL_PATTERN.test(user["email"]) ||
      !isNullableText(user["phone"], 64) ||
      (user["phoneE164"] !== null &&
        (typeof user["phoneE164"] !== "string" ||
          !E164_PATTERN.test(user["phoneE164"]))) ||
      typeof user["name"] !== "string" ||
      user["name"].trim().length < 1 ||
      user["name"].length > 200 ||
      typeof user["active"] !== "boolean" ||
      !isNullableInstant(user["passwordSetAt"]) ||
      !isInstant(user["createdAt"]) ||
      !isInstant(user["updatedAt"]) ||
      new Date(user["updatedAt"]).getTime() <
        new Date(user["createdAt"]).getTime()
    ) {
      return null;
    }
    const id = user["id"].toLowerCase();
    const email = user["email"].trim().toLowerCase();
    const phone =
      typeof user["phoneE164"] === "string" ? user["phoneE164"] : null;
    if (ids.has(id) || emails.has(email) || (phone && phones.has(phone))) {
      return null;
    }
    ids.add(id);
    emails.add(email);
    if (phone) phones.add(phone);
  }
  return value as PartnerPortalUsersResponse;
}

export function parsePartnerInviteSuccess(
  value: unknown,
  expected: {
    orgContactId: string;
    email: string;
    requestedChannels: readonly PartnerInviteChannel[];
  },
): PartnerInviteSuccess | null {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "data,ok,receipt" ||
    value["ok"] !== true ||
    !isRecord(value["data"]) ||
    !isRecord(value["receipt"])
  ) {
    return null;
  }
  const data = value["data"];
  const receipt = value["receipt"];
  if (
    Object.keys(data).sort().join(",") !== "delivery,user" ||
    !isRecord(data["user"]) ||
    !isRecord(data["delivery"])
  ) {
    return null;
  }
  const user = data["user"];
  const delivery = data["delivery"];
  if (
    Object.keys(user).sort().join(",") !==
      "active,createdAt,email,id,name,orgContactId,phone,phoneE164" ||
    typeof user["id"] !== "string" ||
    !UUID_PATTERN.test(user["id"]) ||
    typeof user["orgContactId"] !== "string" ||
    user["orgContactId"].toLowerCase() !==
      expected.orgContactId.toLowerCase() ||
    typeof user["email"] !== "string" ||
    user["email"].trim().toLowerCase() !==
      expected.email.trim().toLowerCase() ||
    !EMAIL_PATTERN.test(user["email"]) ||
    !isNullableText(user["phone"], 64) ||
    (user["phoneE164"] !== null &&
      (typeof user["phoneE164"] !== "string" ||
        !E164_PATTERN.test(user["phoneE164"]))) ||
    typeof user["name"] !== "string" ||
    user["name"].trim().length < 1 ||
    user["name"].length > 200 ||
    user["active"] !== true ||
    !isInstant(user["createdAt"])
  ) {
    return null;
  }
  if (
    Object.keys(delivery).sort().join(",") !==
      "acceptedChannels,failedChannels,providerExactlyOnceClaimed,providerOperationIds,state,uncertainChannels" ||
    delivery["state"] !== "succeeded" ||
    delivery["providerExactlyOnceClaimed"] !== false ||
    !isPartnerInviteChannelArray(delivery["acceptedChannels"]) ||
    !isPartnerInviteChannelArray(delivery["failedChannels"], {
      allowEmpty: true,
    }) ||
    !Array.isArray(delivery["uncertainChannels"]) ||
    delivery["uncertainChannels"].length !== 0 ||
    !Array.isArray(delivery["providerOperationIds"]) ||
    delivery["providerOperationIds"].length > 10 ||
    !delivery["providerOperationIds"].every(
      (id) =>
        typeof id === "string" && id.trim().length > 0 && id.length <= 256,
    ) ||
    new Set(delivery["providerOperationIds"]).size !==
      delivery["providerOperationIds"].length
  ) {
    return null;
  }
  const observedChannels = [
    ...delivery["acceptedChannels"],
    ...delivery["failedChannels"],
  ].sort();
  const requestedChannels = Array.from(
    new Set(expected.requestedChannels),
  ).sort();
  if (
    observedChannels.length !== requestedChannels.length ||
    observedChannels.some(
      (channel, index) => channel !== requestedChannels[index],
    )
  ) {
    return null;
  }
  const receiptKeys = [
    "actorId",
    "auditEventId",
    "committedAt",
    "correlationId",
    "entityId",
    "entityType",
    "operationId",
    "providerOperationId",
  ] as const;
  if (
    !hasOnlyKeys(receipt, receiptKeys) ||
    typeof receipt["operationId"] !== "string" ||
    !UUID_PATTERN.test(receipt["operationId"]) ||
    typeof receipt["correlationId"] !== "string" ||
    receipt["correlationId"].trim().length < 8 ||
    receipt["correlationId"].length > 128 ||
    typeof receipt["actorId"] !== "string" ||
    !UUID_PATTERN.test(receipt["actorId"]) ||
    !isInstant(receipt["committedAt"]) ||
    typeof receipt["auditEventId"] !== "string" ||
    !UUID_PATTERN.test(receipt["auditEventId"]) ||
    receipt["entityType"] !== "partner_user" ||
    receipt["entityId"] !== user["id"] ||
    (receipt["providerOperationId"] !== undefined &&
      (typeof receipt["providerOperationId"] !== "string" ||
        receipt["providerOperationId"].trim().length === 0 ||
        receipt["providerOperationId"].length > 256))
  ) {
    return null;
  }
  return { data, receipt } as PartnerInviteSuccess;
}

export function parsePartnerPortalAccessChangeData(
  value: unknown,
  expected: { userId: string; orgContactId: string; active: boolean },
): PartnerPortalAccessChangeData | null {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "active,orgContactId,sessionsRevoked,tokensInvalidated,userId,version" ||
    typeof value["userId"] !== "string" ||
    value["userId"].toLowerCase() !== expected.userId.toLowerCase() ||
    typeof value["orgContactId"] !== "string" ||
    value["orgContactId"].toLowerCase() !==
      expected.orgContactId.toLowerCase() ||
    value["active"] !== expected.active ||
    !isInstant(value["version"]) ||
    !isSafeCount(value["sessionsRevoked"], 100_000) ||
    !isSafeCount(value["tokensInvalidated"], 100_000) ||
    (expected.active &&
      (value["sessionsRevoked"] !== 0 || value["tokensInvalidated"] !== 0))
  ) {
    return null;
  }
  return value as PartnerPortalAccessChangeData;
}

export function parsePartnerPortalAccessChangeSuccess(
  value: unknown,
  expected: {
    userId: string;
    orgContactId: string;
    active: boolean;
    actorId: string;
  },
): PartnerPortalAccessChangeSuccess | null {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "data,ok,receipt" ||
    value["ok"] !== true ||
    !isRecord(value["receipt"])
  ) {
    return null;
  }
  const data = parsePartnerPortalAccessChangeData(value["data"], expected);
  const receipt = value["receipt"];
  if (
    !data ||
    Object.keys(receipt).sort().join(",") !==
      "actorId,auditEventId,committedAt,correlationId,entityId,entityType,operationId,version" ||
    typeof receipt["operationId"] !== "string" ||
    !UUID_PATTERN.test(receipt["operationId"]) ||
    typeof receipt["correlationId"] !== "string" ||
    receipt["correlationId"].trim().length < 8 ||
    receipt["correlationId"].length > 128 ||
    typeof receipt["actorId"] !== "string" ||
    receipt["actorId"].toLowerCase() !== expected.actorId.toLowerCase() ||
    !UUID_PATTERN.test(receipt["actorId"]) ||
    typeof receipt["auditEventId"] !== "string" ||
    !UUID_PATTERN.test(receipt["auditEventId"]) ||
    receipt["entityType"] !== "partner_user" ||
    typeof receipt["entityId"] !== "string" ||
    receipt["entityId"].toLowerCase() !== expected.userId.toLowerCase() ||
    receipt["committedAt"] !== data.version ||
    receipt["version"] !== data.version ||
    !isInstant(receipt["committedAt"]) ||
    new Date(receipt["committedAt"]).getTime() > Date.now() + 5 * 60 * 1000
  ) {
    return null;
  }
  return { data, receipt } as PartnerPortalAccessChangeSuccess;
}

export function parsePartnerRatesResponse(
  value: unknown,
  expectedOrgContactId: string,
): PartnerRatesResponse | null {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "active,currency,items,ok,orgContactId,precedence,version" ||
    value["ok"] !== true ||
    typeof value["orgContactId"] !== "string" ||
    value["orgContactId"].toLowerCase() !==
      expectedOrgContactId.toLowerCase() ||
    !UUID_PATTERN.test(value["orgContactId"]) ||
    value["currency"] !== "USD" ||
    typeof value["active"] !== "boolean" ||
    (value["version"] !== "none" && !isInstant(value["version"])) ||
    !Array.isArray(value["items"]) ||
    value["items"].length > 100
  ) {
    return null;
  }
  const precedence = value["precedence"];
  if (
    !isRecord(precedence) ||
    Object.keys(precedence).sort().join(",") !== "booking,missingRate" ||
    precedence["booking"] !== "exact_partner_service_and_tier" ||
    precedence["missingRate"] !== "no_quoted_amount"
  ) {
    return null;
  }
  const identities = new Set<string>();
  for (const item of value["items"]) {
    if (
      !isRecord(item) ||
      Object.keys(item).sort().join(",") !==
        "amountCents,createdAt,id,label,serviceKey,sortOrder,tierKey" ||
      typeof item["id"] !== "string" ||
      !UUID_PATTERN.test(item["id"]) ||
      typeof item["serviceKey"] !== "string" ||
      item["serviceKey"].length < 1 ||
      item["serviceKey"].length > 100 ||
      !isPartnerAllowedServiceKey(item["serviceKey"]) ||
      typeof item["tierKey"] !== "string" ||
      item["tierKey"].length < 1 ||
      item["tierKey"].length > 100 ||
      !isPartnerTierKeyForService(item["serviceKey"], item["tierKey"]) ||
      !isNullableText(item["label"], 120) ||
      !isSafeCount(item["amountCents"], 10_000_000) ||
      item["amountCents"] < 1 ||
      !isSafeCount(item["sortOrder"], 99) ||
      !isInstant(item["createdAt"])
    ) {
      return null;
    }
    const identity = `${item["serviceKey"]}:${item["tierKey"]}`;
    if (identities.has(identity)) return null;
    identities.add(identity);
  }
  if (
    value["version"] === "none" &&
    (value["active"] || value["items"].length !== 0)
  ) {
    return null;
  }
  return value as PartnerRatesResponse;
}
import {
  isPartnerAllowedServiceKey,
  isPartnerTierKeyForService,
} from "@myst-os/pricing";
