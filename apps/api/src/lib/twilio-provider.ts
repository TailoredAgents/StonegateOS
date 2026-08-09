import {
  getTwilioApiBaseUrl,
  isTwilioCallSid,
  isControlledProviderTestRuntime,
  isLoopbackTwilioHostname,
  isTwilioMessageSid,
  isTwilioRecordingSid,
  requireTwilioAccountSid,
  resolveTwilioApiEndpoint,
  type TwilioApiEndpoint,
  type TwilioProviderEnvironment,
  type TwilioRecordingFormat,
} from "@myst-os/sdk";
import { getTwilioWebhookPublicBaseUrl } from "@/lib/twilio-webhook-auth";

const DEFAULT_TWILIO_TIMEOUT_MS = 10_000;
const MAX_TWILIO_JSON_BYTES = 1_000_000;
const MAX_TWILIO_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_TWILIO_MEDIA_BYTES = 10 * 1024 * 1024;
const MAX_TWILIO_MEDIA_REDIRECTS = 3;
const MAX_TWILIO_RECORDINGS = 200;
const MAX_TWILIO_MESSAGE_CHARS = 1_600;
const MAX_TWILIO_MEDIA_URLS = 10;
const MAX_TWILIO_URL_CHARS = 4_096;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CALL_REQUEST_PATHS = new Set([
  "/api/webhooks/twilio/connect",
  "/api/webhooks/twilio/escalate",
]);
const CALL_STATUS_PATHS = new Set(["/api/webhooks/twilio/call-status"]);

type TwilioProviderCredentials = {
  accountSid: string;
  authToken: string;
  environment: TwilioProviderEnvironment;
};

type TwilioProviderSenderConfiguration = TwilioProviderCredentials & {
  from: string;
};

export type TwilioProviderFailureCode =
  | "not_configured"
  | "invalid_configuration"
  | "operation_disabled"
  | "invalid_input"
  | "rate_limited"
  | "provider_rejected"
  | "provider_failed"
  | "timeout"
  | "transport_error"
  | "malformed_response"
  | "response_too_large"
  | "not_found"
  | "pagination_limit";

export type TwilioProviderFailure = {
  ok: false;
  code: TwilioProviderFailureCode;
  detail: string;
  status: number | null;
  retryable: boolean;
  certainty: "not_applied" | "uncertain";
};

export type TwilioProviderRequestOptions = {
  environment?: TwilioProviderEnvironment;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export type TwilioRecording = {
  sid: string;
  durationSec: number | null;
  dateCreated: string | null;
};

export type TwilioRecordingListResult =
  | { ok: true; recordings: TwilioRecording[]; empty: boolean }
  | TwilioProviderFailure;

export type TwilioRecordingDownloadResult =
  | {
      ok: true;
      buffer: Buffer;
      contentType: "audio/mpeg" | "audio/wav";
      filename: "call.mp3" | "call.wav";
    }
  | TwilioProviderFailure;

export type TwilioRecordingDeleteResult =
  | {
      ok: true;
      deleted: boolean;
      alreadyAbsent: boolean;
      status: 200 | 204 | 404;
    }
  | TwilioProviderFailure;

export type TwilioProviderMediaResult =
  | {
      ok: true;
      buffer: Buffer;
      declaredContentType: string | null;
      filename: string | null;
    }
  | TwilioProviderFailure;

type TwilioMessageCreateResult =
  | { ok: true; messageSid: string }
  | TwilioProviderFailure;

type TwilioCallCreateResult =
  | { ok: true; callSid: string }
  | TwilioProviderFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function stableFailure(input: {
  code: TwilioProviderFailureCode;
  detail?: string;
  status?: number | null;
  retryable?: boolean;
  certainty?: "not_applied" | "uncertain";
}): TwilioProviderFailure {
  return {
    ok: false,
    code: input.code,
    detail: input.detail ?? `twilio_${input.code}`,
    status: input.status ?? null,
    retryable: input.retryable ?? false,
    certainty: input.certainty ?? "not_applied",
  };
}

function validateTimeout(timeoutMs: number | undefined): number | null {
  const candidate = timeoutMs ?? DEFAULT_TWILIO_TIMEOUT_MS;
  return Number.isInteger(candidate) && candidate >= 100 && candidate <= 60_000
    ? candidate
    : null;
}

function isE164(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/u.test(value);
}

function externalSendsDisabled(
  environment: TwilioProviderEnvironment,
): boolean {
  return ["1", "true", "on"].includes(
    environment["TEAM_KILL_EXTERNAL_SENDS"]?.trim().toLowerCase() ?? "",
  );
}

function readTwilioProviderCredentials(
  environment: TwilioProviderEnvironment,
): TwilioProviderCredentials | TwilioProviderFailure {
  const accountSidRaw = environment["TWILIO_ACCOUNT_SID"]?.trim() ?? "";
  const authToken = environment["TWILIO_AUTH_TOKEN"]?.trim() ?? "";
  if (!accountSidRaw && !authToken) {
    return stableFailure({ code: "not_configured" });
  }
  if (!accountSidRaw || !authToken) {
    return stableFailure({ code: "invalid_configuration" });
  }

  let accountSid: string;
  try {
    accountSid = requireTwilioAccountSid(accountSidRaw);
    // Resolve once during configuration so an unsafe base fails before any
    // input body, recipient, or provider work is prepared.
    resolveTwilioApiEndpoint({ kind: "messages", accountSid }, environment);
  } catch {
    return stableFailure({ code: "invalid_configuration" });
  }

  if (authToken.length > 512 || hasControlCharacter(authToken)) {
    return stableFailure({ code: "invalid_configuration" });
  }
  return { accountSid, authToken, environment };
}

function readTwilioProviderSenderConfiguration(
  environment: TwilioProviderEnvironment,
): TwilioProviderSenderConfiguration | TwilioProviderFailure {
  const credentials = readTwilioProviderCredentials(environment);
  if (!("accountSid" in credentials)) return credentials;
  const from = environment["TWILIO_FROM"]?.trim() ?? "";
  if (!isE164(from)) {
    return stableFailure({ code: "invalid_configuration" });
  }
  return { ...credentials, from };
}

export function inspectTwilioProviderConfiguration(
  environment: TwilioProviderEnvironment,
  options: { requireSender?: boolean } = {},
): { ok: true } | TwilioProviderFailure {
  const configuration =
    options.requireSender === false
      ? readTwilioProviderCredentials(environment)
      : readTwilioProviderSenderConfiguration(environment);
  return "accountSid" in configuration ? { ok: true } : configuration;
}

export function getTwilioProviderSenderNumber(
  environment: TwilioProviderEnvironment = process.env,
): string | null {
  const configuration = readTwilioProviderSenderConfiguration(environment);
  return "accountSid" in configuration ? configuration.from : null;
}

function basicAuthorization(configuration: TwilioProviderCredentials): string {
  const value = Buffer.from(
    `${configuration.accountSid}:${configuration.authToken}`,
    "utf8",
  ).toString("base64");
  return `Basic ${value}`;
}

function isTrustedTwilioMediaHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/u, "");
  if (normalized === "s3-external-1.amazonaws.com") return true;
  return ["twilio.com", "twiliocdn.com"].some(
    (domain) => normalized === domain || normalized.endsWith(`.${domain}`),
  );
}

function resolveTwilioMediaTarget(
  value: string,
  configuration: TwilioProviderCredentials,
  requireApiMediaPath: boolean,
): { url: URL; authenticated: boolean } | null {
  if (value.length < 1 || value.length > MAX_TWILIO_URL_CHARS) return null;
  let url: URL;
  let apiBase: URL;
  try {
    url = new URL(value);
    apiBase = getTwilioApiBaseUrl(configuration.environment);
  } catch {
    return null;
  }
  if (!url.hostname || url.username || url.password || url.hash) return null;

  const controlled = isControlledProviderTestRuntime(configuration.environment);
  if (controlled) {
    return url.origin === apiBase.origin ? { url, authenticated: true } : null;
  }

  if (url.origin === apiBase.origin) {
    const mediaPath = new RegExp(
      `^/2010-04-01/Accounts/${configuration.accountSid}/Messages/(?:SM|MM)[0-9a-f]{32}/Media/ME[0-9a-f]{32}(?:\\.json)?$`,
      "iu",
    );
    if (requireApiMediaPath && (!mediaPath.test(url.pathname) || url.search)) {
      return null;
    }
    if (!requireApiMediaPath && !mediaPath.test(url.pathname)) return null;
    return { url, authenticated: true };
  }

  return url.protocol === "https:" && isTrustedTwilioMediaHostname(url.hostname)
    ? { url, authenticated: false }
    : null;
}

function validateMediaUrl(
  value: string,
  environment: TwilioProviderEnvironment,
): string | null {
  if (value.length < 1 || value.length > MAX_TWILIO_URL_CHARS) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!url.hostname || url.username || url.password || url.hash) {
    return null;
  }
  const loopback = isLoopbackTwilioHostname(url.hostname);
  const controlledTestMode = isControlledProviderTestRuntime(environment);
  const production =
    environment["NODE_ENV"]?.trim().toLowerCase() === "production";
  if (controlledTestMode && !loopback) return null;
  if (production && !controlledTestMode && loopback) return null;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return null;
  }
  return url.toString();
}

function validateWebhookUrl(
  value: string,
  environment: TwilioProviderEnvironment,
  allowedPaths: ReadonlySet<string>,
  purpose: "request" | "status",
): string | null {
  if (value.length < 1 || value.length > MAX_TWILIO_URL_CHARS) return null;
  let url: URL;
  let publicOrigin: string;
  try {
    url = new URL(value);
    publicOrigin = getTwilioWebhookPublicBaseUrl(environment);
  } catch {
    return null;
  }
  if (
    url.origin !== publicOrigin ||
    url.username ||
    url.password ||
    url.hash ||
    !allowedPaths.has(url.pathname)
  ) {
    return null;
  }
  const entries = [...url.searchParams.entries()];
  if (new Set(entries.map(([name]) => name)).size !== entries.length) {
    return null;
  }
  const query = Object.fromEntries(entries);
  if (purpose === "request") {
    if (url.pathname === "/api/webhooks/twilio/connect") {
      if (
        entries.length !== 1 ||
        typeof query["requestKey"] !== "string" ||
        !UUID_PATTERN.test(query["requestKey"])
      ) {
        return null;
      }
    } else {
      if (
        entries.length !== 2 ||
        typeof query["eventKey"] !== "string" ||
        !UUID_PATTERN.test(query["eventKey"]) ||
        typeof query["operationKey"] !== "string" ||
        !UUID_PATTERN.test(query["operationKey"])
      ) {
        return null;
      }
    }
  } else {
    const requestKey = query["requestKey"];
    const eventKey = query["eventKey"];
    const manual =
      entries.length === 2 &&
      query["leg"] === "agent" &&
      typeof requestKey === "string" &&
      UUID_PATTERN.test(requestKey);
    const escalation =
      entries.length === 4 &&
      query["leg"] === "agent" &&
      query["mode"] === "sales_escalation" &&
      typeof eventKey === "string" &&
      UUID_PATTERN.test(eventKey) &&
      typeof query["operationKey"] === "string" &&
      UUID_PATTERN.test(query["operationKey"]);
    if (!manual && !escalation) return null;
  }
  return url.toString();
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

class TwilioBodyError extends Error {
  constructor(readonly code: "malformed_response" | "response_too_large") {
    super(`twilio_${code}`);
    this.name = "TwilioBodyError";
  }
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (
      !Number.isInteger(declaredLength) ||
      declaredLength < 0 ||
      declaredLength > maximumBytes
    ) {
      await cancelResponseBody(response);
      throw new TwilioBodyError("response_too_large");
    }
  }
  if (!response.body) throw new TwilioBodyError("malformed_response");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new TwilioBodyError("response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new TwilioBodyError("malformed_response");

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    await cancelResponseBody(response);
    throw new TwilioBodyError("malformed_response");
  }
  const body = await readBoundedBody(response, MAX_TWILIO_JSON_BYTES);
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(body),
    ) as unknown;
  } catch {
    throw new TwilioBodyError("malformed_response");
  }
}

function failureForStatus(
  status: number,
  effectful: boolean,
): TwilioProviderFailure {
  if (status === 429) {
    return stableFailure({
      code: "rate_limited",
      detail: "twilio_rate_limited",
      status,
      retryable: true,
    });
  }
  if (status === 408) {
    return stableFailure({
      code: "timeout",
      detail: "twilio_provider_timeout",
      status,
      retryable: true,
      certainty: effectful ? "uncertain" : "not_applied",
    });
  }
  if (status >= 500) {
    return stableFailure({
      code: "provider_failed",
      detail: `twilio_provider_failed:${status}`,
      status,
      retryable: true,
      certainty: effectful ? "uncertain" : "not_applied",
    });
  }
  return stableFailure({
    code: "provider_rejected",
    detail: `twilio_provider_rejected:${status}`,
    status,
  });
}

async function executeTwilioRequest<T>(input: {
  configuration: TwilioProviderCredentials;
  endpoint: TwilioApiEndpoint;
  init: RequestInit;
  effectful: boolean;
  options: TwilioProviderRequestOptions;
  handleResponse: (response: Response) => Promise<T | TwilioProviderFailure>;
}): Promise<T | TwilioProviderFailure> {
  const timeoutMs = validateTimeout(input.options.timeoutMs);
  if (timeoutMs === null) {
    return stableFailure({ code: "invalid_configuration" });
  }

  let endpoint: string;
  try {
    endpoint = resolveTwilioApiEndpoint(
      input.endpoint,
      input.configuration.environment,
    );
  } catch {
    return stableFailure({ code: "invalid_configuration" });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await (input.options.fetchImpl ?? fetch)(endpoint, {
      ...input.init,
      headers: {
        Authorization: basicAuthorization(input.configuration),
        ...input.init.headers,
      },
      signal: controller.signal,
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) {
      const failure = failureForStatus(response.status, input.effectful);
      await cancelResponseBody(response);
      return failure;
    }
    return await input.handleResponse(response);
  } catch (error) {
    if (error instanceof TwilioBodyError) {
      return stableFailure({
        code: error.code,
        retryable: true,
        certainty: input.effectful ? "uncertain" : "not_applied",
      });
    }
    if (controller.signal.aborted) {
      return stableFailure({
        code: "timeout",
        retryable: true,
        certainty: input.effectful ? "uncertain" : "not_applied",
      });
    }
    return stableFailure({
      code: "transport_error",
      retryable: true,
      certainty: input.effectful ? "uncertain" : "not_applied",
    });
  } finally {
    clearTimeout(timeout);
  }
}

function environmentFor(
  options: TwilioProviderRequestOptions,
): TwilioProviderEnvironment {
  return options.environment ?? process.env;
}

export async function fetchTwilioProviderMedia(
  mediaUrl: string,
  options: TwilioProviderRequestOptions = {},
): Promise<TwilioProviderMediaResult> {
  const configuration = readTwilioProviderCredentials(environmentFor(options));
  if (!("accountSid" in configuration)) return configuration;
  const timeoutMs = validateTimeout(options.timeoutMs);
  if (timeoutMs === null) {
    return stableFailure({ code: "invalid_configuration" });
  }
  let target = resolveTwilioMediaTarget(mediaUrl, configuration, true);
  if (!target) return stableFailure({ code: "invalid_input" });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    for (
      let redirectCount = 0;
      redirectCount <= MAX_TWILIO_MEDIA_REDIRECTS;
      redirectCount += 1
    ) {
      const response = await (options.fetchImpl ?? fetch)(target.url, {
        method: "GET",
        headers: target.authenticated
          ? { Authorization: basicAuthorization(configuration) }
          : undefined,
        signal: controller.signal,
        cache: "no-store",
        redirect: "manual",
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await cancelResponseBody(response);
        if (!location || redirectCount === MAX_TWILIO_MEDIA_REDIRECTS) {
          return stableFailure({
            code: "malformed_response",
            detail: "twilio_media_redirect_invalid",
            status: response.status,
          });
        }
        const next = resolveTwilioMediaTarget(
          new URL(location, target.url).toString(),
          configuration,
          false,
        );
        if (!next) {
          return stableFailure({
            code: "invalid_input",
            detail: "twilio_media_redirect_forbidden",
            status: response.status,
          });
        }
        target = next;
        continue;
      }
      if (!response.ok) {
        const failure = failureForStatus(response.status, false);
        await cancelResponseBody(response);
        return failure;
      }
      const bytes = await readBoundedBody(response, MAX_TWILIO_MEDIA_BYTES);
      return {
        ok: true,
        buffer: Buffer.from(bytes),
        declaredContentType: response.headers.get("content-type"),
        filename: target.url.pathname.split("/").at(-1) || null,
      };
    }
    return stableFailure({
      code: "malformed_response",
      detail: "twilio_media_redirect_invalid",
    });
  } catch (error) {
    if (error instanceof TwilioBodyError) {
      return stableFailure({ code: error.code, retryable: true });
    }
    if (controller.signal.aborted) {
      return stableFailure({ code: "timeout", retryable: true });
    }
    return stableFailure({ code: "transport_error", retryable: true });
  } finally {
    clearTimeout(timeout);
  }
}

export async function createTwilioProviderMessage(
  input: { to: string; body: string; mediaUrls?: readonly string[] | null },
  options: TwilioProviderRequestOptions = {},
): Promise<TwilioMessageCreateResult> {
  const environment = environmentFor(options);
  if (externalSendsDisabled(environment)) {
    return stableFailure({
      code: "operation_disabled",
      detail: "twilio_external_sends_disabled",
      retryable: true,
    });
  }
  const configuration = readTwilioProviderSenderConfiguration(environment);
  if (!("accountSid" in configuration)) return configuration;
  if (!isE164(input.to) || input.body.length > MAX_TWILIO_MESSAGE_CHARS) {
    return stableFailure({ code: "invalid_input" });
  }
  const rawMediaUrls = input.mediaUrls ?? [];
  if (rawMediaUrls.length > MAX_TWILIO_MEDIA_URLS) {
    return stableFailure({ code: "invalid_input" });
  }
  const mediaUrls: string[] = [];
  for (const candidate of rawMediaUrls) {
    const url = validateMediaUrl(candidate.trim(), configuration.environment);
    if (!url) return stableFailure({ code: "invalid_input" });
    mediaUrls.push(url);
  }

  const body = new URLSearchParams({
    From: configuration.from,
    To: input.to,
    Body: input.body,
  });
  for (const mediaUrl of mediaUrls) body.append("MediaUrl", mediaUrl);

  return executeTwilioRequest<TwilioMessageCreateResult>({
    configuration,
    endpoint: { kind: "messages", accountSid: configuration.accountSid },
    init: {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
    effectful: true,
    options,
    handleResponse: async (response) => {
      const payload = await readBoundedJson(response);
      if (!isRecord(payload) || !isTwilioMessageSid(payload["sid"])) {
        return stableFailure({
          code: "malformed_response",
          status: response.status,
          retryable: true,
          certainty: "uncertain",
        });
      }
      return { ok: true, messageSid: payload["sid"].trim() };
    },
  });
}

export async function createTwilioProviderCall(
  input: {
    to: string;
    requestUrl: string;
    statusCallbackUrl: string;
  },
  options: TwilioProviderRequestOptions = {},
): Promise<TwilioCallCreateResult> {
  const environment = environmentFor(options);
  if (externalSendsDisabled(environment)) {
    return stableFailure({
      code: "operation_disabled",
      detail: "twilio_external_sends_disabled",
      retryable: true,
    });
  }
  const configuration = readTwilioProviderSenderConfiguration(environment);
  if (!("accountSid" in configuration)) return configuration;
  const requestUrl = validateWebhookUrl(
    input.requestUrl,
    configuration.environment,
    CALL_REQUEST_PATHS,
    "request",
  );
  const statusCallbackUrl = validateWebhookUrl(
    input.statusCallbackUrl,
    configuration.environment,
    CALL_STATUS_PATHS,
    "status",
  );
  if (!isE164(input.to) || !requestUrl || !statusCallbackUrl) {
    return stableFailure({ code: "invalid_input" });
  }

  const body = new URLSearchParams({
    To: input.to,
    From: configuration.from,
    Url: requestUrl,
    Method: "POST",
    StatusCallback: statusCallbackUrl,
    StatusCallbackMethod: "POST",
  });
  for (const event of ["initiated", "ringing", "answered", "completed"]) {
    body.append("StatusCallbackEvent", event);
  }

  return executeTwilioRequest<TwilioCallCreateResult>({
    configuration,
    endpoint: { kind: "calls", accountSid: configuration.accountSid },
    init: {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
    effectful: true,
    options,
    handleResponse: async (response) => {
      const payload = await readBoundedJson(response);
      if (!isRecord(payload) || !isTwilioCallSid(payload["sid"])) {
        return stableFailure({
          code: "malformed_response",
          status: response.status,
          retryable: true,
          certainty: "uncertain",
        });
      }
      return { ok: true, callSid: payload["sid"].trim() };
    },
  });
}

function parseRecording(value: unknown): TwilioRecording | null {
  if (!isRecord(value) || !isTwilioRecordingSid(value["sid"])) return null;
  const rawDuration = value["duration"];
  let durationSec: number | null = null;
  if (rawDuration !== null && rawDuration !== undefined && rawDuration !== "") {
    const parsed =
      typeof rawDuration === "number" || typeof rawDuration === "string"
        ? Number(rawDuration)
        : Number.NaN;
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 86_400) return null;
    durationSec = parsed;
  }
  const rawDate = value["date_created"];
  let dateCreated: string | null = null;
  if (rawDate !== null && rawDate !== undefined && rawDate !== "") {
    if (
      typeof rawDate !== "string" ||
      rawDate.length > 128 ||
      Number.isNaN(Date.parse(rawDate))
    ) {
      return null;
    }
    dateCreated = new Date(rawDate).toISOString();
  }
  return { sid: value["sid"].trim(), durationSec, dateCreated };
}

export async function listTwilioProviderRecordings(
  callSid: string,
  options: TwilioProviderRequestOptions = {},
): Promise<TwilioRecordingListResult> {
  const configuration = readTwilioProviderCredentials(environmentFor(options));
  if (!("accountSid" in configuration)) return configuration;
  if (!isTwilioCallSid(callSid)) {
    return stableFailure({ code: "invalid_input" });
  }

  return executeTwilioRequest<TwilioRecordingListResult>({
    configuration,
    endpoint: {
      kind: "recordings.list",
      accountSid: configuration.accountSid,
      callSid,
    },
    init: { method: "GET" },
    effectful: false,
    options,
    handleResponse: async (response) => {
      const payload = await readBoundedJson(response);
      if (!isRecord(payload) || !Array.isArray(payload["recordings"])) {
        return stableFailure({
          code: "malformed_response",
          status: response.status,
          retryable: true,
        });
      }
      if (payload["recordings"].length > MAX_TWILIO_RECORDINGS) {
        return stableFailure({
          code: "response_too_large",
          status: response.status,
          retryable: true,
        });
      }
      const nextPage = payload["next_page_uri"];
      if (typeof nextPage === "string" && nextPage.trim().length > 0) {
        return stableFailure({
          code: "pagination_limit",
          status: response.status,
          retryable: true,
        });
      }
      if (nextPage !== undefined && nextPage !== null && nextPage !== "") {
        return stableFailure({
          code: "malformed_response",
          status: response.status,
          retryable: true,
        });
      }

      const recordings: TwilioRecording[] = [];
      const seen = new Set<string>();
      for (const raw of payload["recordings"]) {
        const recording = parseRecording(raw);
        if (!recording || seen.has(recording.sid)) {
          return stableFailure({
            code: "malformed_response",
            status: response.status,
            retryable: true,
          });
        }
        seen.add(recording.sid);
        recordings.push(recording);
      }
      return { ok: true, recordings, empty: recordings.length === 0 };
    },
  });
}

const RECORDING_FORMATS: ReadonlyArray<{
  format: TwilioRecordingFormat;
  contentTypes: readonly string[];
  contentType: "audio/mpeg" | "audio/wav";
  filename: "call.mp3" | "call.wav";
}> = [
  {
    format: "wav",
    contentTypes: ["audio/wav", "audio/x-wav"],
    contentType: "audio/wav",
    filename: "call.wav",
  },
  {
    format: "mp3",
    contentTypes: ["audio/mpeg", "audio/mp3"],
    contentType: "audio/mpeg",
    filename: "call.mp3",
  },
];

export async function downloadTwilioProviderRecording(
  recordingSid: string,
  options: TwilioProviderRequestOptions = {},
): Promise<TwilioRecordingDownloadResult> {
  const configuration = readTwilioProviderCredentials(environmentFor(options));
  if (!("accountSid" in configuration)) return configuration;
  if (!isTwilioRecordingSid(recordingSid)) {
    return stableFailure({ code: "invalid_input" });
  }

  for (const candidate of RECORDING_FORMATS) {
    const result = await executeTwilioRequest<TwilioRecordingDownloadResult>({
      configuration,
      endpoint: {
        kind: "recordings.download",
        accountSid: configuration.accountSid,
        recordingSid,
        format: candidate.format,
      },
      init: { method: "GET" },
      effectful: false,
      options,
      handleResponse: async (response) => {
        const contentType =
          response.headers
            .get("content-type")
            ?.split(";", 1)[0]
            ?.trim()
            .toLowerCase() ?? "";
        if (!candidate.contentTypes.includes(contentType)) {
          await cancelResponseBody(response);
          return stableFailure({
            code: "malformed_response",
            status: response.status,
            retryable: true,
          });
        }
        const bytes = await readBoundedBody(response, MAX_TWILIO_AUDIO_BYTES);
        return {
          ok: true,
          buffer: Buffer.from(bytes),
          contentType: candidate.contentType,
          filename: candidate.filename,
        };
      },
    });
    if (result.ok) return result;
    if (result.status !== 404) return result;
  }

  return stableFailure({
    code: "not_found",
    detail: "twilio_recording_not_found",
    status: 404,
    retryable: true,
  });
}

export async function deleteTwilioProviderRecording(
  recordingSid: string,
  options: TwilioProviderRequestOptions = {},
): Promise<TwilioRecordingDeleteResult> {
  const configuration = readTwilioProviderCredentials(environmentFor(options));
  if (!("accountSid" in configuration)) return configuration;
  if (!isTwilioRecordingSid(recordingSid)) {
    return stableFailure({ code: "invalid_input" });
  }

  const result = await executeTwilioRequest<TwilioRecordingDeleteResult>({
    configuration,
    endpoint: {
      kind: "recordings.delete",
      accountSid: configuration.accountSid,
      recordingSid,
    },
    init: { method: "DELETE" },
    effectful: true,
    options,
    handleResponse: async (response) => {
      await cancelResponseBody(response);
      if (response.status !== 200 && response.status !== 204) {
        return stableFailure({
          code: "malformed_response",
          status: response.status,
          retryable: true,
          certainty: "uncertain",
        });
      }
      return {
        ok: true,
        deleted: true,
        alreadyAbsent: false,
        status: response.status,
      };
    },
  });
  if (!result.ok && result.status === 404) {
    return { ok: true, deleted: false, alreadyAbsent: true, status: 404 };
  }
  return result;
}
