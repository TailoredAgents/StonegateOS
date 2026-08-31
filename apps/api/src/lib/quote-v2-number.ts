import { randomBytes } from "node:crypto";

const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const MAX_QUOTE_NUMBER_ATTEMPTS = 8;

function randomSuffix(length: number): string {
  const entropy = randomBytes(length);
  let result = "";
  for (const value of entropy) {
    result += ALPHABET[value % ALPHABET.length];
  }
  return result;
}

export function generateQuoteV2Number(now = new Date()): string {
  const date = now.toISOString().slice(0, 10).replace(/-/gu, "");
  return `Q-${date}-${randomSuffix(8)}`;
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  if (candidate.code === "23505") return true;
  return candidate.cause !== error && isUniqueViolation(candidate.cause);
}

export async function withCollisionSafeQuoteNumber<T>(input: {
  write: (quoteNumber: string) => Promise<T>;
  now?: Date;
  generate?: (now: Date) => string;
}): Promise<T> {
  const now = input.now ?? new Date();
  const generate = input.generate ?? generateQuoteV2Number;
  let lastCollision: unknown;
  for (let attempt = 0; attempt < MAX_QUOTE_NUMBER_ATTEMPTS; attempt += 1) {
    try {
      return await input.write(generate(now));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      lastCollision = error;
    }
  }
  throw new Error(
    "A unique quote number could not be allocated after 8 attempts",
    {
      cause: lastCollision,
    },
  );
}
