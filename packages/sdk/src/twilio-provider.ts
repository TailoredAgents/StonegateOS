import { isControlledProviderTestRuntime } from "./provider-test-runtime";

export type TwilioProviderEnvironment = Readonly<
  Record<string, string | undefined>
>;

export type TwilioRecordingFormat = "mp3" | "wav";

export type TwilioApiEndpoint =
  | { kind: "messages"; accountSid: string }
  | { kind: "calls"; accountSid: string }
  | { kind: "recordings.list"; accountSid: string; callSid: string }
  | {
      kind: "recordings.download";
      accountSid: string;
      recordingSid: string;
      format: TwilioRecordingFormat;
    }
  | { kind: "recordings.delete"; accountSid: string; recordingSid: string };

export const DEFAULT_TWILIO_API_BASE_URL = "https://api.twilio.com";

const TWILIO_SID_PATTERNS = {
  account: /^AC[0-9a-f]{32}$/iu,
  call: /^CA[0-9a-f]{32}$/iu,
  message: /^SM[0-9a-f]{32}$/iu,
  recording: /^RE[0-9a-f]{32}$/iu,
} as const;

export function isLoopbackTwilioHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "");
  if (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    /^::ffff:127(?:\.\d{1,3}){3}$/u.test(normalized) ||
    /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/u.test(normalized) ||
    normalized.endsWith(".localhost")
  ) {
    return true;
  }

  const parts = normalized.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every(
      (part) => /^\d{1,3}$/u.test(part) && Number.parseInt(part, 10) <= 255,
    )
  );
}

function normalizedBasePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/u, "");
  return trimmed === "/" ? "" : trimmed;
}

/**
 * Resolve the only allowed Twilio REST base. Provider credentials are always
 * request headers and may never be embedded in this URL.
 */
export function getTwilioApiBaseUrl(
  environment: TwilioProviderEnvironment,
): URL {
  let url: URL;
  try {
    url = new URL(
      environment["TWILIO_API_BASE_URL"]?.trim() || DEFAULT_TWILIO_API_BASE_URL,
    );
  } catch {
    throw new Error("TWILIO_API_BASE_URL must be a valid absolute URL.");
  }

  if (
    !url.hostname ||
    url.username ||
    url.password ||
    normalizedBasePath(url.pathname) ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "TWILIO_API_BASE_URL must be an origin without credentials, a path, query parameters, or a fragment.",
    );
  }

  const loopback = isLoopbackTwilioHostname(url.hostname);
  const controlledTestMode = isControlledProviderTestRuntime(environment);
  if (controlledTestMode) {
    if (!loopback) {
      throw new Error(
        "TWILIO_API_BASE_URL must target a loopback service during E2E or CRM audit runs.",
      );
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error(
        "TWILIO_API_BASE_URL must use HTTP or HTTPS for a controlled loopback service.",
      );
    }
  } else if (url.origin !== DEFAULT_TWILIO_API_BASE_URL) {
    throw new Error(
      "TWILIO_API_BASE_URL must use the official Twilio API origin outside a controlled provider-test runtime.",
    );
  }

  url.pathname = "/";
  return url;
}

function requireTwilioSid(
  value: string,
  kind: keyof typeof TWILIO_SID_PATTERNS,
): string {
  const normalized = value.trim();
  if (!TWILIO_SID_PATTERNS[kind].test(normalized)) {
    throw new Error(`Twilio ${kind} SID is invalid.`);
  }
  return normalized;
}

export function isTwilioAccountSid(value: unknown): value is string {
  return (
    typeof value === "string" && TWILIO_SID_PATTERNS.account.test(value.trim())
  );
}

export function isTwilioCallSid(value: unknown): value is string {
  return (
    typeof value === "string" && TWILIO_SID_PATTERNS.call.test(value.trim())
  );
}

export function isTwilioMessageSid(value: unknown): value is string {
  return (
    typeof value === "string" && TWILIO_SID_PATTERNS.message.test(value.trim())
  );
}

export function isTwilioRecordingSid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    TWILIO_SID_PATTERNS.recording.test(value.trim())
  );
}

export function requireTwilioAccountSid(value: string): string {
  return requireTwilioSid(value, "account");
}

export function requireTwilioCallSid(value: string): string {
  return requireTwilioSid(value, "call");
}

export function requireTwilioMessageSid(value: string): string {
  return requireTwilioSid(value, "message");
}

export function requireTwilioRecordingSid(value: string): string {
  return requireTwilioSid(value, "recording");
}

export function resolveTwilioApiEndpoint(
  endpoint: TwilioApiEndpoint,
  environment: TwilioProviderEnvironment,
): string {
  const base = getTwilioApiBaseUrl(environment);
  const basePath = normalizedBasePath(base.pathname);
  const accountSid = encodeURIComponent(
    requireTwilioAccountSid(endpoint.accountSid),
  );
  let suffix: string;

  switch (endpoint.kind) {
    case "messages":
      suffix = `/2010-04-01/Accounts/${accountSid}/Messages.json`;
      break;
    case "calls":
      suffix = `/2010-04-01/Accounts/${accountSid}/Calls.json`;
      break;
    case "recordings.list":
      suffix = `/2010-04-01/Accounts/${accountSid}/Calls/${encodeURIComponent(
        requireTwilioCallSid(endpoint.callSid),
      )}/Recordings.json`;
      break;
    case "recordings.download":
      suffix = `/2010-04-01/Accounts/${accountSid}/Recordings/${encodeURIComponent(
        requireTwilioRecordingSid(endpoint.recordingSid),
      )}.${endpoint.format}`;
      break;
    case "recordings.delete":
      suffix = `/2010-04-01/Accounts/${accountSid}/Recordings/${encodeURIComponent(
        requireTwilioRecordingSid(endpoint.recordingSid),
      )}.json`;
      break;
  }

  base.pathname = `${basePath}${suffix}`.replace(/\/{2,}/gu, "/");
  return base.toString();
}
