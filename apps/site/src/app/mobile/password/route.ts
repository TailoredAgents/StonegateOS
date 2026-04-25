import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { callTeamApi } from "../../team/login/lib/api";
import { mobileLoginRedirectUrl } from "../login/lib/redirect";

export const dynamic = "force-dynamic";

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text) as { error?: string; detail?: string; message?: string };
      return json.error ?? json.detail ?? json.message ?? fallback;
    } catch {
      return text || fallback;
    }
  } catch {
    return fallback;
  }
}

function safeNextPath(value: FormDataEntryValue | null): string {
  if (typeof value !== "string") return "/mobile?screen=settings";
  const trimmed = value.trim();
  if (!trimmed.startsWith("/mobile")) return "/mobile?screen=settings";
  return trimmed;
}

function withParam(path: string, key: string, value: string): string {
  const url = new URL(path, "https://stonegatejunkremoval.com");
  url.searchParams.set(key, value);
  return `${url.pathname}${url.search}`;
}

export async function POST(request: NextRequest): Promise<Response> {
  const formData = await request.formData();
  const nextPath = safeNextPath(formData.get("next"));
  const passwordRaw = formData.get("password");
  const confirmRaw = formData.get("confirmPassword");
  const password = typeof passwordRaw === "string" ? passwordRaw : "";
  const confirmPassword = typeof confirmRaw === "string" ? confirmRaw : "";

  if (!password || password.length < 10) {
    return NextResponse.redirect(
      mobileLoginRedirectUrl(request, withParam(nextPath, "error", "password_too_short")),
      303
    );
  }

  if (confirmPassword && password !== confirmPassword) {
    return NextResponse.redirect(
      mobileLoginRedirectUrl(request, withParam(nextPath, "error", "passwords_do_not_match")),
      303
    );
  }

  const response = await callTeamApi("/api/team/password", {
    method: "POST",
    body: JSON.stringify({ password })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "password_save_failed");
    return NextResponse.redirect(
      mobileLoginRedirectUrl(request, withParam(nextPath, "error", message)),
      303
    );
  }

  revalidatePath("/mobile");
  return NextResponse.redirect(
    mobileLoginRedirectUrl(request, withParam("/mobile?screen=settings", "password", "saved")),
    303
  );
}
