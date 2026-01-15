import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApi } from "@/app/team/lib/api";
import { getSafeRedirectUrl } from "@/app/api/team/redirects";

const ADMIN_COOKIE = "myst-admin-session";
const CREW_COOKIE = "myst-crew-session";

export const dynamic = "force-dynamic";

function wantsJson(request: NextRequest): boolean {
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("application/json");
}

function makeNoteTitle(body: string): string {
  const normalized = body.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return "Note";
  const maxLen = 60;
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLen - 3))}...`;
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ noteId: string }> }
): Promise<Response> {
  const jar = request.cookies;
  const returnJson = wantsJson(request);
  const hasOwner = Boolean(jar.get(ADMIN_COOKIE)?.value);
  const hasCrew = Boolean(jar.get(CREW_COOKIE)?.value);
  const redirectTo = getSafeRedirectUrl(request, "/team?tab=contacts");

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
  const id = noteId?.trim() ?? "";
  if (!id) {
    if (returnJson) {
      return NextResponse.json({ error: "note_id_required" }, { status: 400 });
    }
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({ name: "myst-flash-error", value: "Note ID missing", path: "/" });
    return response;
  }

  const payload = (await request.json().catch(() => null)) as unknown;
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const body = typeof record?.["body"] === "string" ? record["body"].trim() : "";

  if (!body) {
    return NextResponse.json({ error: "note_body_required" }, { status: 400 });
  }

  const apiResponse = await callAdminApi(`/api/admin/crm/tasks/${id}`, {
    method: "PATCH",
    body: JSON.stringify({
      title: makeNoteTitle(body),
      notes: body
    })
  });

  if (!apiResponse.ok) {
    let message = "Unable to update note";
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
      return NextResponse.json({ error: "note_update_failed", message }, { status });
    }
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({ name: "myst-flash-error", value: message, path: "/" });
    return response;
  }

  const data = (await apiResponse.json().catch(() => null)) as unknown;
  const task = data && typeof data === "object" ? (data as Record<string, unknown>)["task"] : null;
  if (!task || typeof task !== "object") {
    return NextResponse.json({ error: "note_update_failed" }, { status: 500 });
  }
  const taskRecord = task as Record<string, unknown>;
  const updatedAt = typeof taskRecord["updatedAt"] === "string" ? taskRecord["updatedAt"] : null;

  if (returnJson) {
    return NextResponse.json(
      {
        note: {
          id,
          body,
          updatedAt
        }
      },
      { status: 200 }
    );
  }

  const response = NextResponse.redirect(redirectTo, 303);
  response.cookies.set({ name: "myst-flash", value: "Note updated", path: "/" });
  return response;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ noteId: string }> }
): Promise<Response> {
  const jar = request.cookies;
  const returnJson = wantsJson(request);
  const hasOwner = Boolean(jar.get(ADMIN_COOKIE)?.value);
  const hasCrew = Boolean(jar.get(CREW_COOKIE)?.value);
  const redirectTo = getSafeRedirectUrl(request, "/team?tab=contacts");

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
