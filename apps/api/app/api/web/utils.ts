import type { NextRequest } from "next/server";
import { parsePhoneNumberFromString } from "libphonenumber-js";

export interface NormalizedPhone {
  raw: string;
  e164: string;
}

export function normalizeName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  const firstName = parts.shift() ?? "Stonegate";
  const lastName = parts.join(" ") || "Customer";
  return { firstName, lastName };
}

export function normalizePhone(input: string): NormalizedPhone {
  const phone = parsePhoneNumberFromString(input, "US");
  if (!phone) {
    throw new Error("Invalid phone number");
  }
  return {
    raw: input,
    e164: phone.number
  };
}

export function resolveClientIp(request: NextRequest): string {
  const candidates = [
    request.headers.get("x-forwarded-for"),
    request.headers.get("x-real-ip"),
    request.headers.get("cf-connecting-ip"),
    request.headers.get("x-client-ip")
  ];

  for (const value of candidates) {
    if (!value) continue;
    const ip = value
      .split(",")
      .map((part) => part.trim())
      .find((part) => part.length > 0);
    if (ip) {
      return ip;
    }
  }

  return "unknown";
}

