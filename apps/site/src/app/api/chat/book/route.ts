import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { ADMIN_SESSION_COOKIE, getAdminKey } from "@/lib/admin-session";

type BookRequest = {
  contactId?: string;
  propertyId?: string;
  startAt?: string;
  durationMinutes?: number;
  travelBufferMinutes?: number;
  services?: string[];
};

function getAdminContext() {
  const apiBase =
    process.env["API_BASE_URL"] ??
    process.env["NEXT_PUBLIC_API_BASE_URL"] ??
    "http://localhost:3001";
  const adminKey = process.env["ADMIN_API_KEY"];
  return { apiBase: apiBase.replace(/\/$/, ""), adminKey };
}

function hasOwnerSession(request: NextRequest): boolean {
  const adminKey = getAdminKey();
  if (!adminKey) return false;
  return request.cookies.get(ADMIN_SESSION_COOKIE)?.value === adminKey;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!hasOwnerSession(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = (await request.json().catch(() => null)) as BookRequest | null;
  const contactId = payload?.contactId;
  const propertyId = payload?.propertyId;
  const startAt = payload?.startAt;

  if (!contactId || !propertyId || !startAt) {
    return NextResponse.json({ error: "contactId_propertyId_startAt_required" }, { status: 400 });
  }

  const { apiBase, adminKey } = getAdminContext();
  const hdrs = await headers();
  const apiKey = adminKey ?? hdrs.get("x-api-key");
  if (!apiKey) {
    return NextResponse.json({ error: "admin_key_missing" }, { status: 401 });
  }

  const res = await fetch(`${apiBase}/api/admin/booking/book`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey
    },
    body: JSON.stringify({
      contactId,
      propertyId,
      startAt,
      durationMinutes: payload?.durationMinutes ?? 60,
      travelBufferMinutes: payload?.travelBufferMinutes ?? 30,
      services: Array.isArray(payload?.services) ? payload?.services : []
    })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return NextResponse.json(
      { error: "booking_failed", detail: text.slice(0, 300) },
      { status: res.status }
    );
  }

  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data);
}
