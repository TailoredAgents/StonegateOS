import { createHmac, timingSafeEqual } from "node:crypto";
import {
  isControlledProviderTestRuntime,
  isLoopbackTwilioHostname,
} from "@myst-os/sdk";

const TWILIO_SIGNATURE_HEADER = "x-twilio-signature";
const TWILIO_WEBHOOK_BASE_ENV = "TWILIO_WEBHOOK_PUBLIC_BASE_URL";
const MAX_TWILIO_FORM_BYTES = 256 * 1024;

type TwilioWebhookEnvironment =
  | NodeJS.ProcessEnv
  | Record<string, string | undefined>;

type TwilioFormParameters = Record<string, string | string[]>;

export type VerifiedTwilioWebhookRequest =
  | {
      ok: true;
      externalUrl: string;
      formData: FormData;
      publicBaseUrl: string;
    }
  | { ok: false; response: Response };

export class TwilioWebhookConfigurationError extends Error {
  constructor() {
    super("twilio_webhook_configuration_unavailable");
    this.name = "TwilioWebhookConfigurationError";
  }
}

/**
 * Returns the exact externally configured origin used by Twilio when signing
 * callbacks. It intentionally never falls back to Host or forwarded headers.
 */
export function getTwilioWebhookPublicBaseUrl(
  environment: TwilioWebhookEnvironment = process.env,
): string {
  const raw = environment[TWILIO_WEBHOOK_BASE_ENV]?.trim();
  if (!raw) throw new TwilioWebhookConfigurationError();

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TwilioWebhookConfigurationError();
  }

  const production = environment["NODE_ENV"] === "production";
  let controlledTestMode: boolean;
  try {
    controlledTestMode = isControlledProviderTestRuntime(environment);
  } catch {
    throw new TwilioWebhookConfigurationError();
  }
  const loopback = isLoopbackTwilioHostname(parsed.hostname);
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.pathname !== "/" ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    (parsed.protocol === "http:" && !loopback) ||
    (controlledTestMode && !loopback) ||
    (production && !controlledTestMode && loopback)
  ) {
    throw new TwilioWebhookConfigurationError();
  }

  // URL canonicalization is shared by callback generation and verification so
  // the configured external URL and the signed URL cannot drift.
  return parsed.origin;
}

export function buildTwilioWebhookUrl(
  pathAndSearch: string,
  publicBaseUrl = getTwilioWebhookPublicBaseUrl(),
): URL {
  if (!pathAndSearch.startsWith("/")) {
    throw new TwilioWebhookConfigurationError();
  }
  const url = new URL(pathAndSearch, `${publicBaseUrl}/`);
  if (url.origin !== new URL(publicBaseUrl).origin) {
    throw new TwilioWebhookConfigurationError();
  }
  return url;
}

function getTwilioWebhookAuthToken(
  environment: TwilioWebhookEnvironment,
): string {
  const token = environment["TWILIO_AUTH_TOKEN"]?.trim();
  if (!token) throw new TwilioWebhookConfigurationError();
  return token;
}

function formDataToTwilioParameters(formData: FormData): TwilioFormParameters {
  const parameters: TwilioFormParameters = {};
  formData.forEach((value, name) => {
    if (typeof value !== "string") {
      throw new TypeError("twilio_webhook_form_must_contain_strings");
    }

    const current = parameters[name];
    if (current === undefined) {
      parameters[name] = value;
    } else if (Array.isArray(current)) {
      current.push(value);
    } else {
      parameters[name] = [current, value];
    }
  });
  return parameters;
}

function appendTwilioParameter(name: string, value: string | string[]): string {
  if (!Array.isArray(value)) return `${name}${value}`;
  return [...new Set(value)]
    .sort()
    .map((entry) => `${name}${entry}`)
    .join("");
}

/**
 * Deterministic signing helper matching twilio-node's form webhook semantics.
 * This is also used by tests; there is deliberately no validation bypass.
 */
export function createTwilioWebhookSignature(input: {
  authToken: string;
  externalUrl: string;
  formData?: FormData;
}): string {
  const parameters = input.formData
    ? formDataToTwilioParameters(input.formData)
    : {};
  const data = Object.keys(parameters)
    .sort()
    .reduce(
      (result, name) =>
        `${result}${appendTwilioParameter(name, parameters[name]!)}`,
      input.externalUrl,
    );

  return createHmac("sha1", input.authToken)
    .update(Buffer.from(data, "utf8"))
    .digest("base64");
}

function signaturesMatch(provided: string, expected: string): boolean {
  const providedBytes = Buffer.from(provided, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (providedBytes.length !== expectedBytes.length) {
    // Keep the rejection path on a timing-safe primitive without accepting a
    // differently sized value.
    timingSafeEqual(expectedBytes, Buffer.alloc(expectedBytes.length));
    return false;
  }
  return timingSafeEqual(providedBytes, expectedBytes);
}

function safeRoutePath(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return "/api/webhooks/twilio/invalid";
  }
}

function rejectionResponse(
  request: Request,
  input: {
    reason:
      | "configuration_unavailable"
      | "invalid_form"
      | "invalid_signature"
      | "missing_signature";
    status: 400 | 403 | 503;
  },
): Response {
  // Query strings, form values, signatures, tokens, phone numbers, and provider
  // identifiers are intentionally excluded from unauthenticated request logs.
  console.warn("[twilio.webhook_auth] rejected", {
    method: request.method,
    path: safeRoutePath(request),
    reason: input.reason,
  });
  return new Response(
    input.status === 400
      ? "invalid_request"
      : input.status === 403
        ? "forbidden"
        : "service_unavailable",
    {
      status: input.status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
      },
    },
  );
}

function exactExternalUrl(request: Request, publicBaseUrl: string): string {
  const incoming = new URL(request.url);
  return `${publicBaseUrl}${incoming.pathname}${incoming.search}`;
}

async function readBoundedUrlEncodedForm(request: Request): Promise<FormData> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 0 ||
      parsedLength > MAX_TWILIO_FORM_BYTES
    ) {
      throw new TypeError("twilio_webhook_form_too_large");
    }
  }
  const contentEncoding = request.headers
    .get("content-encoding")
    ?.trim()
    .toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    throw new TypeError("twilio_webhook_content_encoding_not_supported");
  }

  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_TWILIO_FORM_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new TypeError("twilio_webhook_form_too_large");
      }
      chunks.push(result.value);
    }
  }

  const raw = new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
  );
  const parameters = new URLSearchParams(raw);
  const formData = new FormData();
  parameters.forEach((value, name) => formData.append(name, value));
  return formData;
}

/**
 * Authenticates a Twilio GET or form POST and returns the already-parsed body.
 * Callers must invoke this before any database, policy, or TwiML lookup.
 */
export async function verifyTwilioWebhookRequest(
  request: Request,
  environment: TwilioWebhookEnvironment = process.env,
): Promise<VerifiedTwilioWebhookRequest> {
  let authToken: string;
  let publicBaseUrl: string;
  try {
    authToken = getTwilioWebhookAuthToken(environment);
    publicBaseUrl = getTwilioWebhookPublicBaseUrl(environment);
  } catch {
    return {
      ok: false,
      response: rejectionResponse(request, {
        reason: "configuration_unavailable",
        status: 503,
      }),
    };
  }

  const signature = request.headers.get(TWILIO_SIGNATURE_HEADER)?.trim();
  if (!signature) {
    return {
      ok: false,
      response: rejectionResponse(request, {
        reason: "missing_signature",
        status: 403,
      }),
    };
  }

  let formData = new FormData();
  if (request.method.toUpperCase() === "POST") {
    const contentType =
      request.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase() ?? "";
    if (contentType !== "application/x-www-form-urlencoded") {
      return {
        ok: false,
        response: rejectionResponse(request, {
          reason: "invalid_form",
          status: 400,
        }),
      };
    }
    try {
      formData = await readBoundedUrlEncodedForm(request);
      // Validate every entry before calculating the signature.
      formDataToTwilioParameters(formData);
    } catch {
      return {
        ok: false,
        response: rejectionResponse(request, {
          reason: "invalid_form",
          status: 400,
        }),
      };
    }
  }

  let externalUrl: string;
  let expectedSignature: string;
  try {
    externalUrl = exactExternalUrl(request, publicBaseUrl);
    expectedSignature = createTwilioWebhookSignature({
      authToken,
      externalUrl,
      formData,
    });
  } catch {
    return {
      ok: false,
      response: rejectionResponse(request, {
        reason: "invalid_form",
        status: 400,
      }),
    };
  }

  if (!signaturesMatch(signature, expectedSignature)) {
    return {
      ok: false,
      response: rejectionResponse(request, {
        reason: "invalid_signature",
        status: 403,
      }),
    };
  }

  return { ok: true, externalUrl, formData, publicBaseUrl };
}
