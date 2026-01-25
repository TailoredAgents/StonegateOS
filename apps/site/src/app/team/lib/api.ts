import { cookies } from "next/headers";
import { ADMIN_SESSION_COOKIE } from "@/lib/admin-session";
import { CREW_SESSION_COOKIE } from "@/lib/crew-session";
import { TEAM_SESSION_COOKIE } from "@/lib/team-session";
import { TEAM_TIME_ZONE } from "./timezone";
import { cache } from "react";

const TEAM_ACTOR_ID_COOKIE = "myst-team-actor-id";
const TEAM_ACTOR_LABEL_COOKIE = "myst-team-actor-label";

const API_BASE_URL =
  process.env["API_BASE_URL"] ??
  process.env["NEXT_PUBLIC_API_BASE_URL"] ??
  "http://localhost:3001";
const ADMIN_API_KEY = process.env["ADMIN_API_KEY"];
const DEFAULT_ACTOR_ID =
  process.env["TEAM_DEFAULT_ACTOR_ID"] ??
  process.env["SALES_DEFAULT_ASSIGNEE_ID"] ??
  null;

type CallAdminApiInit = RequestInit & { timeoutMs?: number };

type TeamSessionApiResponse = {
  ok: boolean;
  teamMember?: {
    id: string;
    name: string;
    email: string | null;
    roleSlug: string | null;
    passwordSet: boolean;
  };
};

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

const getTeamSession = cache(async (sessionToken: string): Promise<TeamSessionApiResponse["teamMember"] | null> => {
  const token = sessionToken.trim();
  if (!token) return null;

  const base = API_BASE_URL.replace(/\/$/, "");
  const res = await fetch(`${base}/api/public/team/session`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`
    },
    cache: "no-store"
  });

  if (!res.ok) return null;
  const payload = (await res.json().catch(() => null)) as TeamSessionApiResponse | null;
  if (!payload?.ok || !payload.teamMember?.id) return null;
  return payload.teamMember;
});

export async function resolveTeamMemberFromSessionCookie(): Promise<TeamSessionApiResponse["teamMember"] | null> {
  try {
    const jar = await cookies();
    const token = jar.get(TEAM_SESSION_COOKIE)?.value ?? "";
    if (!token) return null;
    return await getTeamSession(token);
  } catch {
    return null;
  }
}

async function resolveActorRole(): Promise<string | null> {
  try {
    const jar = await cookies();
    if (jar.get(ADMIN_SESSION_COOKIE)?.value) return "owner";
    if (jar.get(CREW_SESSION_COOKIE)?.value) return "crew";

    const teamSessionToken = jar.get(TEAM_SESSION_COOKIE)?.value ?? "";
    if (teamSessionToken) {
      const teamMember = await getTeamSession(teamSessionToken);
      return teamMember?.roleSlug ?? "office";
    }
  } catch {
    // ignore cookie access in non-request contexts
  }
  return null;
}

async function resolveActorIdentity(): Promise<{ actorId: string | null; actorLabel: string | null }> {
  try {
    const jar = await cookies();
    const teamSessionToken = jar.get(TEAM_SESSION_COOKIE)?.value ?? "";
    if (teamSessionToken) {
      const teamMember = await getTeamSession(teamSessionToken);
      if (teamMember) {
        return {
          actorId: teamMember.id,
          actorLabel: teamMember.name
        };
      }
    }

    const actorIdCookie = jar.get(TEAM_ACTOR_ID_COOKIE)?.value ?? null;
    const actorLabelCookie = jar.get(TEAM_ACTOR_LABEL_COOKIE)?.value ?? null;
    if (actorIdCookie && isUuid(actorIdCookie)) {
      return { actorId: actorIdCookie, actorLabel: actorLabelCookie };
    }
  } catch {
    // ignore
  }

  return { actorId: DEFAULT_ACTOR_ID, actorLabel: null };
}

export async function callAdminApi(path: string, init?: CallAdminApiInit): Promise<Response> {
  if (!ADMIN_API_KEY) {
    throw new Error("ADMIN_API_KEY must be set");
  }

  const actorRole = await resolveActorRole();
  const { actorId, actorLabel } = await resolveActorIdentity();
  const base = API_BASE_URL.replace(/\/$/, "");
  const { timeoutMs = 25_000, ...requestInit } = init ?? {};
  const isFormDataBody =
    typeof FormData !== "undefined" && requestInit?.body instanceof FormData;

  const defaultHeaders: Record<string, string> = isFormDataBody
    ? {}
    : { "Content-Type": "application/json" };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(`${base}${path}`, {
      ...requestInit,
      signal: controller.signal,
      headers: {
        ...defaultHeaders,
        "x-api-key": ADMIN_API_KEY,
        "x-actor-type": "human",
        ...(actorId ? { "x-actor-id": actorId } : {}),
        "x-actor-label": actorLabel ?? "team-console",
        ...(actorRole ? { "x-actor-role": actorRole } : {}),
        ...(requestInit?.headers ?? {})
      },
      cache: "no-store"
    });
  } finally {
    clearTimeout(timeoutId);
  }
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
