import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import { z } from "zod";

const ALGORITHM = "aes-256-gcm";
const ENVELOPE_VERSION = "v1";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAX_PROVIDER_PAYLOAD_BYTES = 750_000;

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);

export const QuoteDeliveryProviderPayloadSchema = z
  .object({
    quoteId: z.string().uuid(),
    versionId: z.string().uuid(),
    deliveryId: z.string().uuid(),
    capabilityToken: boundedText(512),
    channel: z.enum(["email", "sms"]),
    recipient: z
      .object({
        role: z.enum(["signer", "cc", "bcc"]),
        name: boundedText(240),
        address: boundedText(320),
      })
      .strict(),
    content: z
      .object({
        subject: z.string().max(500).nullable().optional(),
        html: z.string().max(500_000).nullable().optional(),
        text: z.string().min(1).max(50_000),
        documentId: z.string().uuid().nullable().optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((payload, context) => {
    if (payload.channel === "email" && !payload.content.subject) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["content", "subject"],
        message: "Email delivery requires a subject.",
      });
    }
    if (payload.channel === "sms" && payload.content.html) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["content", "html"],
        message: "SMS delivery cannot contain HTML.",
      });
    }
  });

export type QuoteDeliveryProviderPayload = z.infer<
  typeof QuoteDeliveryProviderPayloadSchema
>;

export class QuoteDeliveryEncryptionConfigurationError extends Error {
  constructor() {
    super("Quote delivery encryption is unavailable.");
    this.name = "QuoteDeliveryEncryptionConfigurationError";
  }
}

type QuoteDeliveryKeyring = {
  currentKeyId: string;
  keys: Map<string, Buffer>;
};

function decodeEncryptionKey(value: unknown): Buffer {
  if (typeof value !== "string" || !value.trim()) {
    throw new QuoteDeliveryEncryptionConfigurationError();
  }
  const decoded = Buffer.from(value.trim(), "base64");
  if (decoded.byteLength !== 32) {
    throw new QuoteDeliveryEncryptionConfigurationError();
  }
  return decoded;
}

function validKeyId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/u.test(value)
  ) {
    throw new QuoteDeliveryEncryptionConfigurationError();
  }
  return value;
}

function loadEncryptionKeyring(): QuoteDeliveryKeyring {
  const currentKeyId = validKeyId(
    process.env["QUOTE_DELIVERY_ENCRYPTION_KEY_ID"] ?? "primary",
  );
  const serialized = process.env["QUOTE_DELIVERY_ENCRYPTION_KEYS_JSON"];
  if (!serialized?.trim()) {
    throw new QuoteDeliveryEncryptionConfigurationError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new QuoteDeliveryEncryptionConfigurationError();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new QuoteDeliveryEncryptionConfigurationError();
  }

  const keys = new Map<string, Buffer>();
  for (const [rawKeyId, rawKey] of Object.entries(parsed)) {
    keys.set(validKeyId(rawKeyId), decodeEncryptionKey(rawKey));
  }
  if (!keys.has(currentKeyId)) {
    throw new QuoteDeliveryEncryptionConfigurationError();
  }
  return { currentKeyId, keys };
}

function deliveryAad(input: {
  deliveryId: string;
  versionId: string;
  encryptionKeyId: string;
}): Buffer {
  return Buffer.from(
    `stonegate-quote-delivery\0${input.deliveryId}\0${input.versionId}\0${input.encryptionKeyId}`,
    "utf8",
  );
}

export function encryptQuoteDeliveryProviderPayload(input: {
  payload: unknown;
}): { encryptedProviderPayload: string; encryptionKeyId: string } {
  const payload = QuoteDeliveryProviderPayloadSchema.parse(input.payload);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  if (plaintext.byteLength > MAX_PROVIDER_PAYLOAD_BYTES) {
    throw new TypeError("The quote delivery payload is too large.");
  }

  const keyring = loadEncryptionKeyring();
  const key = keyring.keys.get(keyring.currentKeyId);
  if (!key) throw new QuoteDeliveryEncryptionConfigurationError();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_BYTES,
  });
  cipher.setAAD(
    deliveryAad({
      deliveryId: payload.deliveryId,
      versionId: payload.versionId,
      encryptionKeyId: keyring.currentKeyId,
    }),
  );
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    encryptedProviderPayload: [
      ENVELOPE_VERSION,
      iv.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      ciphertext.toString("base64url"),
    ].join("."),
    encryptionKeyId: keyring.currentKeyId,
  };
}

export function decryptQuoteDeliveryProviderPayload(input: {
  encryptedProviderPayload: string;
  encryptionKeyId: string;
  deliveryId: string;
  versionId: string;
}): QuoteDeliveryProviderPayload {
  const keyring = loadEncryptionKeyring();
  const key = keyring.keys.get(validKeyId(input.encryptionKeyId));
  if (!key) throw new QuoteDeliveryEncryptionConfigurationError();
  const parts = input.encryptedProviderPayload.split(".");
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
    throw new TypeError("The quote delivery payload envelope is invalid.");
  }
  const iv = Buffer.from(parts[1] ?? "", "base64url");
  const tag = Buffer.from(parts[2] ?? "", "base64url");
  const ciphertext = Buffer.from(parts[3] ?? "", "base64url");
  if (
    iv.byteLength !== IV_BYTES ||
    tag.byteLength !== AUTH_TAG_BYTES ||
    ciphertext.byteLength < 1 ||
    ciphertext.byteLength > MAX_PROVIDER_PAYLOAD_BYTES
  ) {
    throw new TypeError("The quote delivery payload envelope is invalid.");
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_BYTES,
  });
  decipher.setAAD(
    deliveryAad({
      deliveryId: input.deliveryId,
      versionId: input.versionId,
      encryptionKeyId: input.encryptionKeyId,
    }),
  );
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  if (plaintext.byteLength > MAX_PROVIDER_PAYLOAD_BYTES) {
    throw new TypeError("The quote delivery payload is too large.");
  }
  const parsed = JSON.parse(plaintext.toString("utf8")) as unknown;
  const payload = QuoteDeliveryProviderPayloadSchema.parse(parsed);
  if (
    payload.deliveryId !== input.deliveryId ||
    payload.versionId !== input.versionId
  ) {
    throw new TypeError("The quote delivery payload binding is invalid.");
  }
  return payload;
}

export function hashQuoteDeliveryRecipientAddress(input: {
  channel: "email" | "sms";
  address: string;
}): string {
  const address = input.address.trim();
  const normalized =
    input.channel === "email" ? address.toLowerCase() : address;
  if (!normalized || normalized.length > 320) {
    throw new TypeError("The quote delivery recipient is invalid.");
  }
  const rawKey = process.env["QUOTE_DELIVERY_ADDRESS_HMAC_KEY_BASE64"];
  const key = decodeEncryptionKey(rawKey);
  return createHmac("sha256", key)
    .update(
      `stonegate-quote-recipient\0${input.channel}\0${normalized}`,
      "utf8",
    )
    .digest("hex");
}
