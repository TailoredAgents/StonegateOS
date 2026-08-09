const API_BASE_URL = (
  process.env["API_BASE_URL"] ??
  process.env["NEXT_PUBLIC_API_BASE_URL"] ??
  "http://localhost:3001"
).replace(/\/$/, "");
const ADMIN_API_KEY = process.env["ADMIN_API_KEY"];

/**
 * Public chat has one narrowly-scoped internal service identity for the
 * contact/property/availability/booking handoff. The API owns the permission
 * allowlist; the internal key alone never authorizes these requests.
 */
export async function callPublicChatBookingApi(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  if (!ADMIN_API_KEY) {
    throw new Error("ADMIN_API_KEY must be set");
  }

  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  headers.set("x-api-key", ADMIN_API_KEY);
  headers.set("x-actor-type", "worker");
  headers.set("x-actor-label", "public-chat-booking");

  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    headers.set("Origin", new URL(API_BASE_URL).origin);
  }

  return fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers,
    cache: "no-store",
  });
}
