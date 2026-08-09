import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { isControlledProviderTestRuntime } from "@myst-os/sdk";
import nodemailer from "nodemailer";

export type EmailDeliveryCertainty = "accepted" | "rejected" | "ambiguous";

export type EmailProviderAttachment = {
  filename: string;
  content: string;
  contentType: string;
};

export type EmailProviderMessage = {
  to: string | readonly string[];
  subject: string;
  text: string;
  idempotencyKey?: string | null;
  attachments?: readonly EmailProviderAttachment[];
};

export type EmailProviderResult = {
  ok: boolean;
  deliveryCertainty: EmailDeliveryCertainty;
  providerMessageId: string | null;
  acceptedRecipientCount: number;
  rejectedRecipientCount: number;
  detail: string | null;
};

type EmailEnvironment = Readonly<Record<string, string | undefined>>;

export type EmailProviderConfiguration = {
  host: string;
  port: number;
  secure: boolean;
  requireTls: boolean;
  user: string | null;
  pass: string | null;
  from: string;
  timeoutMs: number;
};

const MAX_RECIPIENTS = 10;
const MAX_RECIPIENT_LENGTH = 320;
const MAX_SUBJECT_BYTES = 998;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_ATTACHMENT_COUNT = 4;
const MAX_ATTACHMENT_BYTES = 250_000;
const MAX_ESTIMATED_WIRE_BYTES = 512 * 1024;
const MIME_BASE_OVERHEAD_BYTES = 8 * 1024;
const MIME_ATTACHMENT_OVERHEAD_BYTES = 2 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30_000;
const EMAIL_PATTERN = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/u;
const SAFE_IDEMPOTENCY_KEY = /^[a-zA-Z0-9._:-]{1,240}$/u;

let cachedTransport:
  | { fingerprint: string; transporter: nodemailer.Transporter }
  | undefined;

function isTruthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

export function isLoopbackEmailHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "");
  if (
    normalized === "localhost" ||
    normalized === "::1" ||
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

function parseTimeout(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_TIMEOUT_MS ||
    parsed > MAX_TIMEOUT_MS
  ) {
    throw new Error(
      `SMTP_TIMEOUT_MS must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}.`,
    );
  }
  return parsed;
}

function parseMailbox(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512 || /[\r\n\0]/u.test(trimmed)) {
    throw new Error(`${field} is invalid.`);
  }
  const angleAddress = trimmed.match(/<([^<>]+)>\s*$/u)?.[1] ?? trimmed;
  if (!EMAIL_PATTERN.test(angleAddress.trim())) {
    throw new Error(`${field} is invalid.`);
  }
  return trimmed;
}

export function getEmailProviderConfiguration(
  environment: EmailEnvironment = process.env,
): EmailProviderConfiguration | null {
  const host = environment["SMTP_HOST"]?.trim() ?? "";
  const portValue = environment["SMTP_PORT"]?.trim() ?? "";
  const fromValue = environment["SMTP_FROM"]?.trim() ?? "";
  const user = environment["SMTP_USER"]?.trim() || null;
  const pass = environment["SMTP_PASS"]?.trim() || null;

  if (!host && !portValue && !fromValue && !user && !pass) return null;
  if (!host || !portValue || !fromValue) {
    throw new Error(
      "SMTP_HOST, SMTP_PORT, and SMTP_FROM must be set together.",
    );
  }
  const unwrappedHost = host.replace(/^\[|\]$/gu, "");
  const dnsHost =
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/iu;
  if (
    /[\r\n\0]/u.test(host) ||
    host.length > 253 ||
    (isIP(unwrappedHost) === 0 && !dnsHost.test(host))
  ) {
    throw new Error("SMTP_HOST is invalid.");
  }
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("SMTP_PORT must be an integer between 1 and 65535.");
  }
  if (Boolean(user) !== Boolean(pass)) {
    throw new Error(
      "SMTP_USER and SMTP_PASS must either both be set or both be blank.",
    );
  }

  const production =
    environment["NODE_ENV"]?.trim().toLowerCase() === "production";
  const loopback = isLoopbackEmailHostname(host);
  const controlledTestMode = isControlledProviderTestRuntime(environment);
  if (production && loopback && !controlledTestMode) {
    throw new Error("SMTP_HOST cannot target loopback in production.");
  }
  if (controlledTestMode && !loopback) {
    throw new Error(
      "SMTP_HOST must target a loopback service during E2E or CRM audit runs.",
    );
  }

  const secure = isTruthy(environment["SMTP_SECURE"]) || port === 465;
  return {
    host,
    port,
    secure,
    requireTls: !loopback && !secure,
    user,
    pass,
    from: parseMailbox(fromValue, "SMTP_FROM"),
    timeoutMs: parseTimeout(environment["SMTP_TIMEOUT_MS"]),
  };
}

function transportFor(
  configuration: EmailProviderConfiguration,
): nodemailer.Transporter {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(configuration))
    .digest("hex");
  if (cachedTransport?.fingerprint === fingerprint) {
    return cachedTransport.transporter;
  }

  const transporter = nodemailer.createTransport({
    host: configuration.host,
    port: configuration.port,
    secure: configuration.secure,
    requireTLS: configuration.requireTls,
    connectionTimeout: configuration.timeoutMs,
    greetingTimeout: configuration.timeoutMs,
    socketTimeout: configuration.timeoutMs,
    ...(configuration.user && configuration.pass
      ? {
          auth: {
            user: configuration.user,
            pass: configuration.pass,
          },
        }
      : {}),
  });
  cachedTransport = { fingerprint, transporter };
  return transporter;
}

function normalizedRecipients(value: string | readonly string[]): string[] {
  const values: readonly string[] = typeof value === "string" ? [value] : value;
  const recipients = values.map((entry) =>
    parseMailbox(entry, "email recipient"),
  );
  if (recipients.length < 1 || recipients.length > MAX_RECIPIENTS) {
    throw new Error(
      `email recipient count must be between 1 and ${MAX_RECIPIENTS}.`,
    );
  }
  if (recipients.some((recipient) => recipient.length > MAX_RECIPIENT_LENGTH)) {
    throw new Error("email recipient is too long.");
  }
  return Array.from(new Set(recipients));
}

function checkedMessage(input: EmailProviderMessage): {
  recipients: string[];
  attachments: EmailProviderAttachment[];
  messageId?: string;
} {
  const recipients = normalizedRecipients(input.to);
  if (
    !input.subject.trim() ||
    /[\r\n\0]/u.test(input.subject) ||
    Buffer.byteLength(input.subject, "utf8") > MAX_SUBJECT_BYTES
  ) {
    throw new Error("email subject is invalid or too large.");
  }
  if (
    /\0/u.test(input.text) ||
    Buffer.byteLength(input.text, "utf8") > MAX_TEXT_BYTES
  ) {
    throw new Error("email text is invalid or too large.");
  }

  const attachments = [...(input.attachments ?? [])];
  if (attachments.length > MAX_ATTACHMENT_COUNT) {
    throw new Error("email has too many attachments.");
  }
  const subjectBytes = Buffer.byteLength(input.subject, "utf8");
  const textBytes = Buffer.byteLength(input.text, "utf8");
  // Text may be quoted-printable (up to 3x) and attachments are base64
  // encoded (4/3), so raw content bytes cannot be compared to SMTP SIZE.
  let estimatedWireBytes =
    MIME_BASE_OVERHEAD_BYTES + subjectBytes * 3 + textBytes * 3;
  for (const attachment of attachments) {
    const contentBytes = Buffer.byteLength(attachment.content, "utf8");
    estimatedWireBytes +=
      Math.ceil(contentBytes / 3) * 4 + MIME_ATTACHMENT_OVERHEAD_BYTES;
    if (
      !attachment.filename ||
      attachment.filename.length > 160 ||
      /[\r\n\0/\\]/u.test(attachment.filename) ||
      !/^text\/calendar(?:;|$)/iu.test(attachment.contentType) ||
      contentBytes > MAX_ATTACHMENT_BYTES
    ) {
      throw new Error("email attachment is invalid or too large.");
    }
  }
  if (estimatedWireBytes > MAX_ESTIMATED_WIRE_BYTES) {
    throw new Error("email message is too large.");
  }

  const key = input.idempotencyKey?.trim() || null;
  if (key && !SAFE_IDEMPOTENCY_KEY.test(key)) {
    throw new Error("email idempotency key is invalid.");
  }
  const messageId = key
    ? `<${createHash("sha256").update(key).digest("hex")}@dispatch.stonegate.local>`
    : undefined;
  return { recipients, attachments, messageId };
}

function stringValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export function sanitizeEmailProviderMessageId(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > 512 ||
    !/^<[^<>\s@]+@[^<>\s@]+>$/u.test(value)
  ) {
    return null;
  }
  const hasControlCharacter = Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  return hasControlCharacter ? null : value;
}

type SmtpErrorShape = {
  accepted?: unknown;
  responseCode?: unknown;
  rejected?: unknown;
};

export function classifyEmailProviderError(
  error: unknown,
): EmailProviderResult {
  const smtpError = (error ?? {}) as SmtpErrorShape;
  const accepted = stringValues(smtpError.accepted);
  const rejected = stringValues(smtpError.rejected);
  if (accepted.length > 0) {
    return {
      ok: false,
      deliveryCertainty: "ambiguous",
      providerMessageId: null,
      acceptedRecipientCount: accepted.length,
      rejectedRecipientCount: rejected.length,
      detail: "email_partial_acceptance",
    };
  }
  const responseCode =
    typeof smtpError.responseCode === "number" ? smtpError.responseCode : null;
  const explicitRejection =
    responseCode !== null && responseCode >= 400 && responseCode <= 599;
  if (explicitRejection) {
    return {
      ok: false,
      deliveryCertainty: "rejected",
      providerMessageId: null,
      acceptedRecipientCount: 0,
      rejectedRecipientCount: rejected.length,
      detail:
        responseCode !== null && responseCode >= 500
          ? "email_rejected:permanent"
          : "email_rejected:temporary",
    };
  }

  return {
    ok: false,
    deliveryCertainty: "ambiguous",
    providerMessageId: null,
    acceptedRecipientCount: 0,
    rejectedRecipientCount: 0,
    detail: "email_delivery_ambiguous",
  };
}

function invalidResult(detail: string): EmailProviderResult {
  return {
    ok: false,
    deliveryCertainty: "rejected",
    providerMessageId: null,
    acceptedRecipientCount: 0,
    rejectedRecipientCount: 0,
    detail,
  };
}

/**
 * A single bounded SMTP boundary for all Stonegate server-side email. This
 * reports provider acceptance, not mailbox delivery. Partial acceptance and
 * any post-DATA transport uncertainty are quarantined as ambiguous.
 */
export async function sendEmailThroughProvider(
  input: EmailProviderMessage,
  environment: EmailEnvironment = process.env,
): Promise<EmailProviderResult> {
  let configuration: EmailProviderConfiguration | null;
  let message: ReturnType<typeof checkedMessage>;
  try {
    configuration = getEmailProviderConfiguration(environment);
    if (!configuration) return invalidResult("email_not_configured");
    message = checkedMessage(input);
  } catch {
    return invalidResult("email_request_invalid");
  }

  try {
    const info = (await transportFor(configuration).sendMail({
      from: configuration.from,
      to: message.recipients,
      subject: input.subject,
      text: input.text,
      attachments: message.attachments,
      disableFileAccess: true,
      disableUrlAccess: true,
      ...(message.messageId
        ? {
            messageId: message.messageId,
            headers: { "X-Stonegate-Dispatch": "present" },
          }
        : {}),
    })) as {
      accepted?: unknown;
      rejected?: unknown;
      pending?: unknown;
      messageId?: unknown;
    };
    const accepted = stringValues(info.accepted);
    const rejected = stringValues(info.rejected);
    const pending = stringValues(info.pending);
    const providerMessageId = sanitizeEmailProviderMessageId(info.messageId);

    if (
      accepted.length === message.recipients.length &&
      rejected.length === 0 &&
      pending.length === 0
    ) {
      return {
        ok: true,
        deliveryCertainty: "accepted",
        providerMessageId,
        acceptedRecipientCount: accepted.length,
        rejectedRecipientCount: 0,
        detail: null,
      };
    }
    if (accepted.length === 0 && pending.length === 0) {
      return {
        ok: false,
        deliveryCertainty: "rejected",
        providerMessageId: null,
        acceptedRecipientCount: 0,
        rejectedRecipientCount: rejected.length,
        detail: "email_rejected:permanent",
      };
    }
    return {
      ok: false,
      deliveryCertainty: "ambiguous",
      providerMessageId,
      acceptedRecipientCount: accepted.length,
      rejectedRecipientCount: rejected.length,
      detail: "email_partial_acceptance",
    };
  } catch (error) {
    return classifyEmailProviderError(error);
  }
}

export function resetEmailProviderTransportForTests(): void {
  cachedTransport = undefined;
}
