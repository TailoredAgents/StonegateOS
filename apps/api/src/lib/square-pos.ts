import crypto from "node:crypto";

const STATE_VERSION = 1;
const STATE_TTL_SECONDS = 30 * 60;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type SquarePosStatePayload = {
  v: typeof STATE_VERSION;
  attemptId: string;
  nonce: string;
  exp: number;
  b?: string;
};

export type VerifiedSquarePosState = {
  attemptId: string;
  nonce: string;
  expiresAt: Date;
  bindingHash?: string;
};

export type SquarePosPlatform = "ios" | "android";

export type SquarePosCallback = {
  platform: SquarePosPlatform;
  state: string | null;
  transactionId: string | null;
  clientTransactionId: string | null;
  status: "ok" | "error" | "unknown";
  errorCode: string | null;
  errorDescription: string | null;
};

const RETRYABLE_SQUARE_POS_ERROR_CODES = new Set([
  "disabled",
  "illegal_location_id",
  "no_employee_logged_in",
  "not_logged_in",
  "payment_canceled",
  "transaction_canceled",
  "user_id_mismatch",
  "user_not_activated",
  "user_not_active",
  "user_not_logged_in",
]);

export function isRetryableSquarePosError(
  errorCode: string | null | undefined,
): boolean {
  return RETRYABLE_SQUARE_POS_ERROR_CODES.has(
    errorCode?.trim().toLowerCase() ?? "",
  );
}

function requiredString(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is not set`);
  return normalized;
}

function sign(encodedPayload: string, secret: string): Buffer {
  return crypto.createHmac("sha256", secret).update(encodedPayload).digest();
}

export function createSquarePosState(input: {
  attemptId: string;
  secret: string;
  nonce?: string;
  bindingHash?: string;
  now?: Date;
  ttlSeconds?: number;
}): string {
  if (!UUID_PATTERN.test(input.attemptId)) {
    throw new Error("invalid_attempt_id");
  }
  const secret = requiredString(input.secret, "Square POS state secret");
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("square_state_secret_too_short");
  }
  const now = input.now ?? new Date();
  const ttlSeconds = input.ttlSeconds ?? STATE_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error("invalid_state_ttl");
  }
  const nonce = input.nonce ?? crypto.randomBytes(18).toString("base64url");
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
    throw new Error("invalid_state_nonce");
  }
  const payload: SquarePosStatePayload = {
    v: STATE_VERSION,
    attemptId: input.attemptId,
    nonce,
    exp: Math.floor(now.getTime() / 1000) + ttlSeconds,
    ...(input.bindingHash ? { b: input.bindingHash } : {}),
  };
  if (input.bindingHash && !/^[0-9a-f]{64}$/u.test(input.bindingHash)) {
    throw new Error("invalid_state_binding_hash");
  }
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return `${encoded}.${sign(encoded, secret).toString("base64url")}`;
}

export function verifySquarePosState(input: {
  state: string;
  secret: string;
  now?: Date;
}): VerifiedSquarePosState | null {
  const [encoded, encodedSignature, extra] = input.state.split(".");
  if (!encoded || !encodedSignature || extra) return null;
  const secret = input.secret.trim();
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) return null;

  let provided: Buffer;
  try {
    provided = Buffer.from(encodedSignature, "base64url");
  } catch {
    return null;
  }
  const expected = sign(encoded, secret);
  if (
    provided.length !== expected.length ||
    !crypto.timingSafeEqual(provided, expected)
  ) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (
    record["v"] !== STATE_VERSION ||
    typeof record["attemptId"] !== "string" ||
    !UUID_PATTERN.test(record["attemptId"]) ||
    typeof record["nonce"] !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(record["nonce"]) ||
    typeof record["exp"] !== "number" ||
    !Number.isInteger(record["exp"]) ||
    (record["b"] !== undefined &&
      (typeof record["b"] !== "string" || !/^[0-9a-f]{64}$/u.test(record["b"])))
  ) {
    return null;
  }
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (record["exp"] < nowSeconds) return null;

  return {
    attemptId: record["attemptId"],
    nonce: record["nonce"],
    expiresAt: new Date(record["exp"] * 1000),
    ...(typeof record["b"] === "string" ? { bindingHash: record["b"] } : {}),
  };
}

function assertHttpsUrl(value: string, field: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`${field}_must_be_https`);
  return url.toString();
}

function escapeIntentValue(value: string): string {
  return encodeURIComponent(value);
}

export function buildSquarePosLaunchUrl(input: {
  platform: SquarePosPlatform;
  amountCents: number;
  currency?: "USD";
  applicationId: string;
  locationId: string;
  callbackUrl: string;
  fallbackUrl: string;
  state: string;
  note: string;
}): string {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error("invalid_payment_amount");
  }
  const currency = input.currency ?? "USD";
  const applicationId = requiredString(
    input.applicationId,
    "Square application ID",
  );
  const locationId = requiredString(input.locationId, "Square location ID");
  const callbackUrl = assertHttpsUrl(input.callbackUrl, "callback_url");
  const fallbackUrl = assertHttpsUrl(input.fallbackUrl, "fallback_url");
  const note = input.note.trim().slice(0, 500);

  if (input.platform === "ios") {
    const data = {
      amount_money: {
        amount: String(input.amountCents),
        currency_code: currency,
      },
      callback_url: callbackUrl,
      client_id: applicationId,
      version: "1.3",
      location_id: locationId,
      state: input.state,
      notes: note,
      options: {
        supported_tender_types: ["CREDIT_CARD"],
        clear_default_fees: true,
        auto_return: true,
        skip_receipt: false,
      },
    };
    return `square-commerce-v1://payment/create?data=${encodeURIComponent(
      JSON.stringify(data),
    )}`;
  }

  const values = [
    "intent:#Intent",
    "action=com.squareup.pos.action.CHARGE",
    "package=com.squareup",
    `S.browser_fallback_url=${escapeIntentValue(fallbackUrl)}`,
    `S.com.squareup.pos.WEB_CALLBACK_URI=${escapeIntentValue(callbackUrl)}`,
    `S.com.squareup.pos.CLIENT_ID=${escapeIntentValue(applicationId)}`,
    `S.com.squareup.pos.LOCATION_ID=${escapeIntentValue(locationId)}`,
    "S.com.squareup.pos.API_VERSION=v2.0",
    `i.com.squareup.pos.TOTAL_AMOUNT=${input.amountCents}`,
    `S.com.squareup.pos.CURRENCY_CODE=${currency}`,
    "S.com.squareup.pos.TENDER_TYPES=com.squareup.pos.TENDER_CARD",
    `S.com.squareup.pos.NOTE=${escapeIntentValue(note)}`,
    `S.com.squareup.pos.REQUEST_METADATA=${escapeIntentValue(input.state)}`,
    "l.com.squareup.pos.AUTO_RETURN_TIMEOUT_MS=3200",
    "end",
  ];
  return `${values.join(";")}`;
}

function readParam(params: URLSearchParams, key: string): string | null {
  const value = params.get(key)?.trim();
  return value ? value : null;
}

export function parseSquarePosCallback(
  params: URLSearchParams,
): SquarePosCallback | null {
  const iosData = params.get("data");
  if (iosData) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(iosData) as unknown;
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    const read = (key: string) =>
      typeof record[key] === "string" && record[key].trim()
        ? record[key].trim()
        : null;
    const rawStatus = read("status")?.toLowerCase();
    const errorCode = read("error_code");
    return {
      platform: "ios",
      state: read("state"),
      transactionId: read("transaction_id"),
      clientTransactionId: read("client_transaction_id"),
      status:
        rawStatus === "ok"
          ? "ok"
          : rawStatus === "error" || errorCode
            ? "error"
            : "unknown",
      errorCode,
      errorDescription: read("error_description"),
    };
  }

  const androidPrefix = "com.squareup.pos.";
  const transactionId = readParam(
    params,
    `${androidPrefix}SERVER_TRANSACTION_ID`,
  );
  const errorCode = readParam(params, `${androidPrefix}ERROR_CODE`);
  const state = readParam(params, `${androidPrefix}REQUEST_METADATA`);
  if (!transactionId && !errorCode && !state) return null;

  return {
    platform: "android",
    state,
    transactionId,
    clientTransactionId: readParam(
      params,
      `${androidPrefix}CLIENT_TRANSACTION_ID`,
    ),
    status: errorCode ? "error" : transactionId ? "ok" : "unknown",
    errorCode,
    errorDescription: readParam(params, `${androidPrefix}ERROR_DESCRIPTION`),
  };
}

export function squareAttemptNote(input: {
  appointmentId: string;
  attemptId: string;
}): string {
  return `Stonegate appointment ${input.appointmentId}; attempt ${input.attemptId}`;
}

export function extractSquareAttemptIdFromOrder(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const order = value as Record<string, unknown>;
  const candidates: string[] = [];
  const addString = (raw: unknown) => {
    if (typeof raw === "string") candidates.push(raw);
  };
  addString(order["note"]);
  if (Array.isArray(order["line_items"])) {
    for (const item of order["line_items"]) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      addString(record["note"]);
      addString(record["name"]);
    }
  }
  if (Array.isArray(order["tenders"])) {
    for (const tender of order["tenders"]) {
      if (!tender || typeof tender !== "object") continue;
      addString((tender as Record<string, unknown>)["note"]);
    }
  }
  for (const candidate of candidates) {
    const match = /\battempt\s+([0-9a-f-]{36})\b/i.exec(candidate);
    if (match?.[1] && UUID_PATTERN.test(match[1])) return match[1];
  }
  return null;
}

export function verifySquareWebhookSignature(input: {
  rawBody: string;
  signature: string | null;
  signatureKey: string;
  notificationUrl: string;
}): boolean {
  if (
    !input.signature ||
    !input.signatureKey.trim() ||
    !input.notificationUrl.trim()
  ) {
    return false;
  }
  const expected = crypto
    .createHmac("sha256", input.signatureKey)
    .update(`${input.notificationUrl}${input.rawBody}`)
    .digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(input.signature, "base64");
  } catch {
    return false;
  }
  return (
    provided.length === expected.length &&
    crypto.timingSafeEqual(provided, expected)
  );
}
