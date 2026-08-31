import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const ENVELOPE_VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export class PartnerMfaConfigurationError extends Error {
  constructor(message = "Partner multi-factor authentication is unavailable.") {
    super(message);
    this.name = "PartnerMfaConfigurationError";
  }
}

type Keyring = {
  currentVersion: number;
  keys: Map<number, Buffer>;
};

function parseKeyVersion(value: string | undefined): number {
  const parsed = Number(value ?? "1");
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2_147_483_647) {
    throw new PartnerMfaConfigurationError();
  }
  return parsed;
}

function decodeKey(value: unknown): Buffer {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PartnerMfaConfigurationError();
  }
  const key = Buffer.from(value.trim(), "base64");
  if (key.length !== 32) throw new PartnerMfaConfigurationError();
  return key;
}

function loadKeyring(): Keyring {
  const currentVersion = parseKeyVersion(
    process.env["PARTNER_MFA_SECRET_KEY_VERSION"],
  );
  const keys = new Map<number, Buffer>();
  const serialized = process.env["PARTNER_MFA_SECRET_KEYS_JSON"]?.trim();
  if (serialized) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized) as unknown;
    } catch {
      throw new PartnerMfaConfigurationError();
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new PartnerMfaConfigurationError();
    }
    for (const [rawVersion, rawKey] of Object.entries(parsed)) {
      const version = parseKeyVersion(rawVersion);
      keys.set(version, decodeKey(rawKey));
    }
  } else {
    const singleKey = process.env["PARTNER_MFA_SECRET_KEY_BASE64"];
    if (singleKey) keys.set(currentVersion, decodeKey(singleKey));
  }
  if (!keys.has(currentVersion)) throw new PartnerMfaConfigurationError();
  return { currentVersion, keys };
}

function encodeBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(value: string): Buffer {
  const normalized = value.trim().toUpperCase().replace(/=+$/u, "");
  if (!/^[A-Z2-7]{16,128}$/u.test(normalized)) {
    throw new TypeError("The TOTP secret is invalid.");
  }
  let bits = 0;
  let accumulator = 0;
  const bytes: number[] = [];
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new TypeError("The TOTP secret is invalid.");
    accumulator = (accumulator << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((accumulator >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const decoded = Buffer.from(bytes);
  if (encodeBase32(decoded) !== normalized) {
    throw new TypeError("The TOTP secret is not canonical.");
  }
  return decoded;
}

function totpCounter(at: Date): number {
  const millis = at.getTime();
  if (!Number.isFinite(millis) || millis < 0) {
    throw new TypeError("The TOTP time is invalid.");
  }
  return Math.floor(millis / 1_000 / TOTP_PERIOD_SECONDS);
}

function codeForCounter(secret: string, counter: number): string {
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new TypeError("The TOTP counter is invalid.");
  }
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", decodeBase32(secret))
    .update(counterBytes)
    .digest();
  const offset = (digest.at(-1) ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    ((digest[offset + 1] ?? 0) << 16) |
    ((digest[offset + 2] ?? 0) << 8) |
    (digest[offset + 3] ?? 0);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

function exactCodeMatch(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "ascii");
  const rightBuffer = Buffer.from(right, "ascii");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function encryptionAad(partnerUserId: string, keyVersion: number): Buffer {
  return Buffer.from(
    `stonegate-partner-mfa\0${partnerUserId}\0${keyVersion}`,
    "utf8",
  );
}

function normalizeRecoveryCode(value: string): string {
  const normalized = value.toUpperCase().replace(/[^A-Z2-7]/gu, "");
  if (!/^[A-Z2-7]{16}$/u.test(normalized)) {
    throw new TypeError("The recovery code is invalid.");
  }
  return normalized;
}

function recoveryDigest(input: {
  normalizedCode: string;
  partnerUserId: string;
  methodId: string;
  keyVersion: number;
  key: Buffer;
}): string {
  return createHmac("sha256", input.key)
    .update(
      `stonegate-partner-mfa-recovery\0${input.keyVersion}\0${input.partnerUserId}\0${input.methodId}\0${input.normalizedCode}`,
      "utf8",
    )
    .digest("hex");
}

export function generatePartnerTotpSecret(): string {
  return encodeBase32(randomBytes(20));
}

export function createPartnerTotpUri(input: {
  email: string;
  secret: string;
  issuer?: string;
}): string {
  decodeBase32(input.secret);
  const issuer = (input.issuer ?? "Stonegate Partner Portal").trim();
  const email = input.email.trim().toLowerCase();
  if (!issuer || issuer.length > 80 || !email || email.length > 254) {
    throw new TypeError("The TOTP account label is invalid.");
  }
  const label = `${issuer}:${email}`;
  const query = new URLSearchParams({
    secret: input.secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${query.toString()}`;
}

export function partnerTotpCodeAt(secret: string, at: Date): string {
  return codeForCounter(secret, totpCounter(at));
}

export function verifyPartnerTotp(input: {
  secret: string;
  code: string;
  at?: Date;
  window?: number;
  lastAcceptedCounter?: number | null;
}): number | null {
  const code = input.code.trim();
  if (!/^\d{6}$/u.test(code)) return null;
  const window = input.window ?? 1;
  if (!Number.isSafeInteger(window) || window < 0 || window > 2) {
    throw new TypeError("The TOTP verification window is invalid.");
  }
  const currentCounter = totpCounter(input.at ?? new Date());
  for (let offset = -window; offset <= window; offset += 1) {
    const counter = currentCounter + offset;
    if (counter < 0 || counter <= (input.lastAcceptedCounter ?? -1)) continue;
    if (exactCodeMatch(codeForCounter(input.secret, counter), code)) {
      return counter;
    }
  }
  return null;
}

export function encryptPartnerTotpSecret(input: {
  partnerUserId: string;
  secret: string;
}): { ciphertext: string; keyVersion: number } {
  decodeBase32(input.secret);
  const keyring = loadKeyring();
  const key = keyring.keys.get(keyring.currentVersion);
  if (!key) throw new PartnerMfaConfigurationError();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_BYTES,
  });
  cipher.setAAD(encryptionAad(input.partnerUserId, keyring.currentVersion));
  const encrypted = Buffer.concat([
    cipher.update(input.secret, "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext: [
      ENVELOPE_VERSION,
      iv.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      encrypted.toString("base64url"),
    ].join("."),
    keyVersion: keyring.currentVersion,
  };
}

export function decryptPartnerTotpSecret(input: {
  partnerUserId: string;
  ciphertext: string;
  keyVersion: number;
}): string {
  const parts = input.ciphertext.split(".");
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
    throw new TypeError("The TOTP secret envelope is invalid.");
  }
  const keyring = loadKeyring();
  const key = keyring.keys.get(input.keyVersion);
  if (!key) throw new PartnerMfaConfigurationError();
  const iv = Buffer.from(parts[1] ?? "", "base64url");
  const tag = Buffer.from(parts[2] ?? "", "base64url");
  const encrypted = Buffer.from(parts[3] ?? "", "base64url");
  if (iv.length !== IV_BYTES || tag.length !== AUTH_TAG_BYTES) {
    throw new TypeError("The TOTP secret envelope is invalid.");
  }
  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_BYTES,
  });
  decipher.setAAD(encryptionAad(input.partnerUserId, input.keyVersion));
  decipher.setAuthTag(tag);
  const secret = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString("utf8");
  decodeBase32(secret);
  return secret;
}

export function generatePartnerMfaRecoveryCodes(count = 10): string[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > 20) {
    throw new TypeError("The recovery-code count is invalid.");
  }
  const unique = new Set<string>();
  while (unique.size < count) {
    const raw = encodeBase32(randomBytes(10));
    unique.add(raw.match(/.{1,4}/gu)?.join("-") ?? raw);
  }
  return [...unique];
}

export function hashPartnerMfaRecoveryCode(input: {
  code: string;
  partnerUserId: string;
  methodId: string;
  keyVersion?: number;
}): { hash: string; keyVersion: number } {
  const keyring = loadKeyring();
  const keyVersion = input.keyVersion ?? keyring.currentVersion;
  const key = keyring.keys.get(keyVersion);
  if (!key) throw new PartnerMfaConfigurationError();
  return {
    hash: recoveryDigest({
      normalizedCode: normalizeRecoveryCode(input.code),
      partnerUserId: input.partnerUserId,
      methodId: input.methodId,
      keyVersion,
      key,
    }),
    keyVersion,
  };
}

export function verifyPartnerMfaRecoveryCode(input: {
  code: string;
  expectedHash: string;
  partnerUserId: string;
  methodId: string;
  keyVersion: number;
}): boolean {
  if (!/^[0-9a-f]{64}$/u.test(input.expectedHash)) return false;
  let calculated: string;
  try {
    calculated = hashPartnerMfaRecoveryCode({
      code: input.code,
      partnerUserId: input.partnerUserId,
      methodId: input.methodId,
      keyVersion: input.keyVersion,
    }).hash;
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
  return timingSafeEqual(
    Buffer.from(calculated, "hex"),
    Buffer.from(input.expectedHash, "hex"),
  );
}
