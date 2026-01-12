import { cookies } from "next/headers";
import { ADMIN_SESSION_COOKIE } from "@/lib/admin-session";
import { CREW_SESSION_COOKIE } from "@/lib/crew-session";
import { TEAM_TIME_ZONE } from "./timezone";

const TEAM_ACTOR_ID_COOKIE = "myst-team-actor-id";
const TEAM_ACTOR_LABEL_COOKIE = "myst-team-actor-label";
const FALLBACK_DEVON_MEMBER_ID = "b45988bb-7417-48c5-af6d-fcdf71088282";

const API_BASE_URL =
  process.env["API_BASE_URL"] ??
  process.env["NEXT_PUBLIC_API_BASE_URL"] ??
  "http://localhost:3001";
const ADMIN_API_KEY = process.env["ADMIN_API_KEY"];
const DEFAULT_ACTOR_ID =
  process.env["TEAM_DEFAULT_ACTOR_ID"] ??
  process.env["SALES_DEFAULT_ASSIGNEE_ID"] ??
  FALLBACK_DEVON_MEMBER_ID;

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

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

async function resolveActorIdentity(): Promise<{ actorId: string | null; actorLabel: string | null }> {
  try {
    const jar = await cookies();
    const rawId = jar.get(TEAM_ACTOR_ID_COOKIE)?.value ?? "";
    const rawLabel = jar.get(TEAM_ACTOR_LABEL_COOKIE)?.value ?? "";

    const actorId = rawId.trim();
    const actorLabel = rawLabel.trim();

    if (actorId && isUuid(actorId)) {
      return { actorId, actorLabel: actorLabel.length ? actorLabel : null };
    }
  } catch {
    // ignore cookie access in non-request contexts
  }

  return { actorId: DEFAULT_ACTOR_ID, actorLabel: null };
}

export async function callAdminApi(path: string, init?: RequestInit): Promise<Response> {
  if (!ADMIN_API_KEY) {
    throw new Error("ADMIN_API_KEY must be set");
  }

  const actorRole = await resolveActorRole();
  const { actorId, actorLabel } = await resolveActorIdentity();
  const base = API_BASE_URL.replace(/\/$/, "");
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ADMIN_API_KEY,
      "x-actor-type": "human",
      ...(actorId ? { "x-actor-id": actorId } : {}),
      "x-actor-label": actorLabel ?? "team-console",
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
    timeZone: TEAM_TIME_ZONE,
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
