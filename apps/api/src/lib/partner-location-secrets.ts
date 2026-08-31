import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const ENVELOPE_VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export class PartnerLocationSecretConfigurationError extends Error {
  constructor(message = "Partner location secret encryption is unavailable.") {
    super(message);
    this.name = "PartnerLocationSecretConfigurationError";
  }
}

type Keyring = {
  currentVersion: number;
  keys: Map<number, Buffer>;
};

function positiveKeyVersion(value: string | undefined): number {
  const parsed = Number(value ?? "1");
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2_147_483_647) {
    throw new PartnerLocationSecretConfigurationError();
  }
  return parsed;
}

function decodeKey(value: unknown): Buffer {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PartnerLocationSecretConfigurationError();
  }
  const key = Buffer.from(value.trim(), "base64");
  if (key.length !== 32) {
    throw new PartnerLocationSecretConfigurationError();
  }
  return key;
}

function loadKeyring(): Keyring {
  const currentVersion = positiveKeyVersion(
    process.env["PARTNER_LOCATION_SECRET_KEY_VERSION"],
  );
  const keys = new Map<number, Buffer>();
  const serialized = process.env["PARTNER_LOCATION_SECRET_KEYS_JSON"]?.trim();
  if (serialized) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized) as unknown;
    } catch {
      throw new PartnerLocationSecretConfigurationError();
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new PartnerLocationSecretConfigurationError();
    }
    for (const [rawVersion, rawKey] of Object.entries(parsed)) {
      const version = positiveKeyVersion(rawVersion);
      keys.set(version, decodeKey(rawKey));
    }
  } else {
    const singleKey = process.env["PARTNER_LOCATION_SECRET_KEY_BASE64"];
    if (singleKey) keys.set(currentVersion, decodeKey(singleKey));
  }
  if (!keys.has(currentVersion)) {
    throw new PartnerLocationSecretConfigurationError();
  }
  return { currentVersion, keys };
}

function aad(keyVersion: number): Buffer {
  return Buffer.from(
    `stonegate-partner-location-secret\0${keyVersion}`,
    "utf8",
  );
}

export function encryptPartnerLocationSecret(plaintext: string): {
  ciphertext: string;
  keyVersion: number;
} {
  if (
    typeof plaintext !== "string" ||
    plaintext.length < 1 ||
    plaintext.length > 2_000
  ) {
    throw new TypeError("The partner location secret is invalid.");
  }
  const keyring = loadKeyring();
  const key = keyring.keys.get(keyring.currentVersion);
  if (!key) throw new PartnerLocationSecretConfigurationError();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_BYTES,
  });
  cipher.setAAD(aad(keyring.currentVersion));
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: [
      ENVELOPE_VERSION,
      iv.toString("base64url"),
      tag.toString("base64url"),
      encrypted.toString("base64url"),
    ].join("."),
    keyVersion: keyring.currentVersion,
  };
}

export function decryptPartnerLocationSecret(input: {
  ciphertext: string;
  keyVersion: number;
}): string {
  const parts = input.ciphertext.split(".");
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
    throw new TypeError("The partner location secret envelope is invalid.");
  }
  const keyring = loadKeyring();
  const key = keyring.keys.get(input.keyVersion);
  if (!key) throw new PartnerLocationSecretConfigurationError();
  const iv = Buffer.from(parts[1] ?? "", "base64url");
  const tag = Buffer.from(parts[2] ?? "", "base64url");
  const encrypted = Buffer.from(parts[3] ?? "", "base64url");
  if (iv.length !== IV_BYTES || tag.length !== AUTH_TAG_BYTES) {
    throw new TypeError("The partner location secret envelope is invalid.");
  }
  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_BYTES,
  });
  decipher.setAAD(aad(input.keyVersion));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString("utf8");
}
