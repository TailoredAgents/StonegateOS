import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApi } from "@/app/team/lib/api";
import { getSafeRedirectUrl } from "@/app/api/team/redirects";

const ADMIN_COOKIE = "myst-admin-session";
const CREW_COOKIE = "myst-crew-session";

export const dynamic = "force-dynamic";

function parseMoneyToCents(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/[^0-9.]/g, "");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

function isoFromDateInput(dateValue: string): string | null {
  const trimmed = dateValue.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const d = new Date(`${trimmed}T12:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export async function POST(request: NextRequest): Promise<Response> {
  const jar = request.cookies;
  const hasOwner = Boolean(jar.get(ADMIN_COOKIE)?.value);
  const hasCrew = Boolean(jar.get(CREW_COOKIE)?.value);
  const redirectTo = getSafeRedirectUrl(request, "/team?tab=expenses");

  if (!hasOwner && !hasCrew) {
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({
      name: "myst-flash-error",
      value: "Please sign in again and retry.",
      path: "/"
    });
    return response;
  }

  const form = await request.formData();
  const paidDate = form.get("paidDate");
  const amountCents = parseMoneyToCents(form.get("amount"));

  if (typeof paidDate !== "string" || !paidDate.trim().length) {
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({ name: "myst-flash-error", value: "Date is required", path: "/" });
    return response;
  }

  const paidAt = isoFromDateInput(paidDate);
  if (!paidAt) {
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({ name: "myst-flash-error", value: "Invalid date", path: "/" });
    return response;
  }

  if (amountCents === null) {
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({ name: "myst-flash-error", value: "Amount is required", path: "/" });
    return response;
  }

  const category = form.get("category");
  const vendor = form.get("vendor");
  const memo = form.get("memo");
  const method = form.get("method");
  const coverageStartDate = form.get("coverageStartDate");
  const coverageEndDate = form.get("coverageEndDate");

  const coverageStartAt =
    typeof coverageStartDate === "string" && coverageStartDate.trim().length ? isoFromDateInput(coverageStartDate) : null;
  const coverageEndAt =
    typeof coverageEndDate === "string" && coverageEndDate.trim().length ? isoFromDateInput(coverageEndDate) : null;

  if (typeof coverageStartDate === "string" && coverageStartDate.trim().length && !coverageStartAt) {
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({ name: "myst-flash-error", value: "Invalid coverage start date", path: "/" });
    return response;
  }
  if (typeof coverageEndDate === "string" && coverageEndDate.trim().length && !coverageEndAt) {
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({ name: "myst-flash-error", value: "Invalid coverage end date", path: "/" });
    return response;
  }

  const requestBody = new FormData();
  requestBody.set("amountCents", String(amountCents));
  requestBody.set("paidAt", paidAt);
  requestBody.set("source", "manual");
  if (typeof category === "string" && category.trim().length) requestBody.set("category", category.trim());
  if (typeof vendor === "string" && vendor.trim().length) requestBody.set("vendor", vendor.trim());
  if (typeof memo === "string" && memo.trim().length) requestBody.set("memo", memo.trim());
  if (typeof method === "string" && method.trim().length) requestBody.set("method", method.trim());
  if (coverageStartAt) requestBody.set("coverageStartAt", coverageStartAt);
  if (coverageEndAt) requestBody.set("coverageEndAt", coverageEndAt);

  const receiptFile = form.get("receiptFile");
  if (receiptFile instanceof File && receiptFile.size > 0) {
    requestBody.set("receiptFile", receiptFile);
    requestBody.set("receiptFilename", receiptFile.name || "receipt");
  }

  const apiResponse = await callAdminApi("/api/admin/expenses", {
    method: "POST",
    body: requestBody
  });

  const response = NextResponse.redirect(redirectTo, 303);
  if (!apiResponse.ok) {
    let message = "Unable to save expense";
    try {
      const data = (await apiResponse.json()) as { error?: string };
      if (data.error === "file_too_large") message = "Receipt file is too large (max 10MB).";
      else if (data.error === "coverage_end_before_start") message = "Coverage end date must be after start date.";
      else if (typeof data.error === "string" && data.error.length) message = data.error.replace(/_/g, " ");
    } catch {
      // ignore
    }
    response.cookies.set({ name: "myst-flash-error", value: message, path: "/" });
    return response;
  }

  response.cookies.set({ name: "myst-flash", value: "Expense saved", path: "/" });
  return response;
}
