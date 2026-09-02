import { scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import {
  hash as hashArgon2,
  parseOptions as parseArgon2Options,
  verify as verifyArgon2,
} from "@node-rs/argon2";
import type { Algorithm, Version } from "@node-rs/argon2";

const scrypt = promisify(nodeScrypt);

const ARGON2ID_ALGORITHM = 2 as Algorithm;
const ARGON2_VERSION_19 = 1 as Version;
const ARGON2_POLICY = Object.freeze({
  algorithm: ARGON2ID_ALGORITHM,
  version: ARGON2_VERSION_19,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
});
const LEGACY_SCRYPT_KEY_BYTES = 64;
const MAX_ACCEPTED_ARGON2_MEMORY_KIB = 262_144;
const MAX_ACCEPTED_ARGON2_TIME_COST = 10;
const MAX_ACCEPTED_ARGON2_PARALLELISM = 8;

export const PARTNER_PASSWORD_HASH_VERSION_ARGON2ID = 2;

export type PartnerPasswordVerification = Readonly<{
  valid: boolean;
  needsRehash: boolean;
  hashVersion: 1 | 2 | null;
}>;

export async function hashPartnerPassword(password: string): Promise<string> {
  return hashArgon2(password, ARGON2_POLICY);
}

function parseLegacyScryptHash(
  encoded: string,
): { salt: Buffer; digest: Buffer } | null {
  const parts = encoded.split("$");
  if (
    parts.length !== 3 ||
    parts[0] !== "scrypt" ||
    !/^[A-Za-z0-9_-]{8,128}$/u.test(parts[1] ?? "") ||
    !/^[A-Za-z0-9_-]{80,128}$/u.test(parts[2] ?? "")
  ) {
    return null;
  }
  const salt = Buffer.from(parts[1]!, "base64url");
  const digest = Buffer.from(parts[2]!, "base64url");
  if (
    salt.length < 8 ||
    salt.length > 64 ||
    digest.length !== LEGACY_SCRYPT_KEY_BYTES
  ) {
    return null;
  }
  return { salt, digest };
}

async function verifyLegacyScrypt(
  password: string,
  encoded: string,
): Promise<boolean> {
  const parsed = parseLegacyScryptHash(encoded);
  if (!parsed) return false;
  try {
    const derived = (await scrypt(
      password,
      parsed.salt,
      LEGACY_SCRYPT_KEY_BYTES,
    )) as Buffer;
    return timingSafeEqual(parsed.digest, derived);
  } catch {
    return false;
  }
}

function argon2ParametersAreAcceptable(encoded: string): boolean {
  try {
    const parsed = parseArgon2Options(encoded);
    return (
      parsed.algorithm === ARGON2ID_ALGORITHM &&
      parsed.version === ARGON2_VERSION_19 &&
      parsed.memoryCost >= 8_192 &&
      parsed.memoryCost <= MAX_ACCEPTED_ARGON2_MEMORY_KIB &&
      parsed.timeCost >= 1 &&
      parsed.timeCost <= MAX_ACCEPTED_ARGON2_TIME_COST &&
      parsed.parallelism >= 1 &&
      parsed.parallelism <= MAX_ACCEPTED_ARGON2_PARALLELISM &&
      parsed.outputLen >= 16 &&
      parsed.outputLen <= 64 &&
      parsed.saltLen >= 8 &&
      parsed.saltLen <= 64
    );
  } catch {
    return false;
  }
}

function argon2NeedsRehash(encoded: string): boolean {
  try {
    const parsed = parseArgon2Options(encoded);
    return (
      parsed.algorithm !== ARGON2_POLICY.algorithm ||
      parsed.version !== ARGON2_POLICY.version ||
      parsed.memoryCost < ARGON2_POLICY.memoryCost ||
      parsed.timeCost < ARGON2_POLICY.timeCost ||
      parsed.parallelism < ARGON2_POLICY.parallelism ||
      parsed.outputLen < ARGON2_POLICY.outputLen ||
      parsed.saltLen < 16
    );
  } catch {
    return true;
  }
}

export async function verifyPartnerPassword(
  password: string,
  encoded: string,
): Promise<PartnerPasswordVerification> {
  if (encoded.startsWith("scrypt$")) {
    return {
      valid: await verifyLegacyScrypt(password, encoded),
      needsRehash: true,
      hashVersion: 1,
    };
  }
  if (
    !encoded.startsWith("$argon2id$") ||
    !argon2ParametersAreAcceptable(encoded)
  ) {
    return { valid: false, needsRehash: false, hashVersion: null };
  }
  try {
    const valid = await verifyArgon2(encoded, password);
    return {
      valid,
      needsRehash: valid && argon2NeedsRehash(encoded),
      hashVersion: 2,
    };
  } catch {
    return { valid: false, needsRehash: false, hashVersion: null };
  }
}

let dummyHashPromise: Promise<string> | null = null;

export function getPartnerDummyPasswordHash(): Promise<string> {
  dummyHashPromise ??= hashPartnerPassword(
    "stonegate-ineligible-partner-password-sentinel",
  );
  return dummyHashPromise;
}
