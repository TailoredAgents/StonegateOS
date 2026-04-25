import { cookies } from "next/headers";
import { TEAM_SESSION_COOKIE } from "@/lib/team-session";

const API_BASE_URL =
  process.env["API_BASE_URL"] ??
  process.env["NEXT_PUBLIC_API_BASE_URL"] ??
  "http://localhost:3001";

export type MobileTeamMember = {
  id: string;
  name: string;
  email: string | null;
  roleSlug: string | null;
  passwordSet: boolean;
  permissions: string[];
};

export type MobileSession = {
  teamMember: MobileTeamMember;
  allowedScreens: string[];
  isOwner: boolean;
};

type TeamSessionApiResponse = {
  ok?: boolean;
  teamMember?: {
    id?: string;
    name?: string;
    email?: string | null;
    roleSlug?: string | null;
    passwordSet?: boolean;
    permissions?: string[];
  };
};

function permissionMatches(granted: string, required: string): boolean {
  if (granted === "*") return true;
  if (required === "read") return granted === "read";
  if (granted === "read") return required === "read" || required.endsWith(".read");
  if (granted.endsWith(".*")) {
    const prefix = granted.slice(0, -2);
    return required.startsWith(prefix);
  }
  return granted === required;
}

export function hasMobilePermission(permissions: string[], required: string): boolean {
  return permissions.some((permission) => permissionMatches(permission, required));
}

export function buildAllowedMobileScreens(member: MobileTeamMember): string[] {
  const permissions = member.permissions ?? [];
  const isOwner = member.roleSlug === "owner" || hasMobilePermission(permissions, "*");
  const screens = new Set<string>(["settings"]);

  if (hasMobilePermission(permissions, "messages.read") || hasMobilePermission(permissions, "messages.send")) {
    screens.add("inbox");
  }
  if (hasMobilePermission(permissions, "appointments.read")) {
    screens.add("myday");
    screens.add("calendar");
  }
  if (hasMobilePermission(permissions, "bookings.manage")) {
    screens.add("contacts");
    screens.add("calendar");
  }
  if (
    hasMobilePermission(permissions, "quotes.read") ||
    hasMobilePermission(permissions, "quotes.write") ||
    hasMobilePermission(permissions, "quotes.send") ||
    hasMobilePermission(permissions, "quotes.update")
  ) {
    screens.add("quotes");
  }
  if (isOwner) {
    screens.add("owner");
    screens.add("access");
  }

  return Array.from(screens);
}

export async function resolveMobileSessionFromToken(sessionToken: string): Promise<MobileSession | null> {
  const token = sessionToken.trim();
  if (!token) return null;

  const base = API_BASE_URL.replace(/\/$/, "");
  const res = await fetch(`${base}/api/public/team/session`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store"
  });

  if (!res.ok) return null;
  const payload = (await res.json().catch(() => null)) as TeamSessionApiResponse | null;
  const row = payload?.teamMember;
  if (!payload?.ok || !row?.id || !row.name) return null;

  const teamMember: MobileTeamMember = {
    id: row.id,
    name: row.name,
    email: row.email ?? null,
    roleSlug: row.roleSlug ?? null,
    passwordSet: Boolean(row.passwordSet),
    permissions: Array.isArray(row.permissions) ? row.permissions : []
  };

  return {
    teamMember,
    allowedScreens: buildAllowedMobileScreens(teamMember),
    isOwner: teamMember.roleSlug === "owner" || hasMobilePermission(teamMember.permissions, "*")
  };
}

export async function resolveMobileSessionFromCookies(): Promise<MobileSession | null> {
  const jar = await cookies();
  const token = jar.get(TEAM_SESSION_COOKIE)?.value ?? "";
  return resolveMobileSessionFromToken(token);
}
