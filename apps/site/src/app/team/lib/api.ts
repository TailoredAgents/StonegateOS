import { cookies } from "next/headers";
import { ADMIN_SESSION_COOKIE } from "@/lib/admin-session";
import { CREW_SESSION_COOKIE } from "@/lib/crew-session";

const API_BASE_URL =
  process.env["API_BASE_URL"] ??
  process.env["NEXT_PUBLIC_API_BASE_URL"] ??
  "http://localhost:3001";
const ADMIN_API_KEY = process.env["ADMIN_API_KEY"];

async function resolveActorRole(): Promise<string | null> {
  try {
    const jar = await cookies();
    if (jar.get(ADMIN_SESSION_COOKIE)?.value) return "owner";
    if (jar.get(CREW_SESSION_COOKIE)?.value) return "crew";
  } catch {
    // ignore cookie access in non-request contexts
  }
  return null;
}

export async function callAdminApi(path: string, init?: RequestInit): Promise<Response> {
  if (!ADMIN_API_KEY) {
    throw new Error("ADMIN_API_KEY must be set");
  }

  const actorRole = await resolveActorRole();
  const base = API_BASE_URL.replace(/\/$/, "");
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ADMIN_API_KEY,
      "x-actor-type": "human",
      "x-actor-label": "team-console",
      ...(actorRole ? { "x-actor-role": actorRole } : {}),
      ...(init?.headers ?? {})
    },
    cache: "no-store"
  });
}

export function fmtTime(iso: string | null): string {
  if (!iso) return "TBD";
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit"
  }).format(d);
}

export function fmtMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

