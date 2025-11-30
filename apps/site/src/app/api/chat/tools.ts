import type { NextRequest } from "next/server";
import { headers } from "next/headers";
import { callAdminApi } from "../../team/lib/api";

export type BookingSuggestion = { start: string; end: string; reason: string };

export async function getAdminContext(): Promise<{ apiBase: string; adminKey: string | null }> {
  const apiBase =
    process.env["API_BASE_URL"] ??
    process.env["NEXT_PUBLIC_API_BASE_URL"] ??
    "http://localhost:3001";
  const hdrs = await headers();
  const adminKey = process.env["ADMIN_API_KEY"] ?? hdrs.get("x-api-key");
  return { apiBase, adminKey };
}

export async function fetchBookingSuggestions(): Promise<BookingSuggestion[] | null> {
  const { apiBase, adminKey } = await getAdminContext();
  if (!adminKey) return null;
  try {
    const res = await fetch(`${apiBase.replace(/\/$/, "")}/api/admin/booking/assist`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": adminKey
      },
      body: JSON.stringify({})
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { suggestions?: Array<{ startAt?: string; endAt?: string; reason?: string }> };
    const suggestions =
      data.suggestions
        ?.slice(0, 3)
        .map((s) => ({
          start: s.startAt ? new Date(s.startAt).toLocaleString() : "TBD",
          end: s.endAt ? new Date(s.endAt).toLocaleString() : "TBD",
          reason: s.reason ?? "No conflicts"
        })) ?? [];
    return suggestions;
  } catch (error) {
    console.warn("[chat] booking_suggest_failed", { error: String(error) });
    return null;
  }
}
