import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApi } from "@/app/team/lib/api";

const ADMIN_COOKIE = "myst-admin-session";
const CREW_COOKIE = "myst-crew-session";

export const dynamic = "force-dynamic";

function wantsJson(request: NextRequest): boolean {
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("application/json");
}

function getSafeRedirectUrl(request: NextRequest): URL {
  const fallback = new URL("/team?tab=contacts", request.url);
  const referer = request.headers.get("referer");
  if (!referer) return fallback;
  try {
    const refererUrl = new URL(referer);
    if (refererUrl.origin !== fallback.origin) return fallback;
    return refererUrl;
  } catch {
    return fallback;
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ noteId: string }> }
): Promise<Response> {
  const jar = request.cookies;
  const returnJson = wantsJson(request);
  const hasOwner = Boolean(jar.get(ADMIN_COOKIE)?.value);
  const hasCrew = Boolean(jar.get(CREW_COOKIE)?.value);
  const redirectTo = getSafeRedirectUrl(request);

  if (!hasOwner && !hasCrew) {
    if (returnJson) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({
      name: "myst-flash-error",
      value: "Please sign in again and retry.",
      path: "/"
    });
    return response;
  }

  const { noteId } = await context.params;
  if (!noteId || noteId.trim().length === 0) {
    if (returnJson) {
      return NextResponse.json({ error: "note_id_required" }, { status: 400 });
    }
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({ name: "myst-flash-error", value: "Note ID missing", path: "/" });
    return response;
  }

  const apiResponse = await callAdminApi(`/api/admin/crm/tasks/${noteId.trim()}`, { method: "DELETE" });
  if (!apiResponse.ok) {
    let message = "Unable to delete note";
    try {
      const data = (await apiResponse.json()) as { error?: string; message?: string };
      const candidate = data.message ?? data.error;
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        message = candidate.replace(/_/g, " ");
      }
    } catch {
      // ignore
    }
    if (returnJson) {
      const status = apiResponse.status >= 400 ? apiResponse.status : 500;
      return NextResponse.json({ error: "note_delete_failed", message }, { status });
    }
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({ name: "myst-flash-error", value: message, path: "/" });
    return response;
  }

  if (returnJson) {
    return NextResponse.json({ deleted: true, noteId: noteId.trim() }, { status: 200 });
  }

  const response = NextResponse.redirect(redirectTo, 303);
  response.cookies.set({ name: "myst-flash", value: "Note deleted", path: "/" });
  return response;
}
