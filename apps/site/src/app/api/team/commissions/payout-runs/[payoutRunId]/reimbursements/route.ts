import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApi } from "@/app/team/lib/api";
import { getSafeRedirectUrl } from "@/app/api/team/redirects";

const ADMIN_COOKIE = "myst-admin-session";

export const dynamic = "force-dynamic";

function parseMoneyToCents(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/[^0-9.]/g, "");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed * 100);
}

function isoFromDateInput(dateValue: string): string | null {
  const trimmed = dateValue.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const d = new Date(`${trimmed}T12:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ payoutRunId: string }> },
): Promise<Response> {
  const jar = request.cookies;
  const hasOwner = Boolean(jar.get(ADMIN_COOKIE)?.value);
  const redirectTo = getSafeRedirectUrl(request, "/team?tab=commissions");

  if (!hasOwner) {
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({
      name: "myst-flash-error",
      value: "Owner login required.",
      path: "/",
    });
    return response;
  }

  const { payoutRunId } = await context.params;
  if (!payoutRunId) {
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({
      name: "myst-flash-error",
      value: "Payout run ID missing",
      path: "/",
    });
    return response;
  }

  const form = await request.formData();
  const action = form.get("action");

  if (action === "delete") {
    const adjustmentId = form.get("adjustmentId");
    const apiResponse = await callAdminApi(
      `/api/admin/commissions/payout-runs/${payoutRunId}/reimbursements`,
      {
        method: "DELETE",
        body: JSON.stringify({ adjustmentId }),
      },
    );

    const response = NextResponse.redirect(redirectTo, 303);
    if (!apiResponse.ok) {
      let message = "Unable to delete reimbursement";
      try {
        const data = (await apiResponse.json()) as {
          error?: string;
          message?: string;
        };
        if (typeof data.message === "string" && data.message.trim().length > 0) {
          message = data.message;
        } else if (
          typeof data.error === "string" &&
          data.error.trim().length > 0
        ) {
          message = data.error.replace(/_/g, " ");
        }
      } catch {
        // ignore
      }
      response.cookies.set({ name: "myst-flash-error", value: message, path: "/" });
      return response;
    }

    response.cookies.set({
      name: "myst-flash",
      value: "Reimbursement removed",
      path: "/",
    });
    return response;
  }

  const memberId = form.get("memberId");
  const note = form.get("note");
  const paidDate = form.get("paidDate");
  const amountCents = parseMoneyToCents(form.get("amount"));

  if (typeof memberId !== "string" || memberId.trim().length === 0) {
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({
      name: "myst-flash-error",
      value: "Select who needs the reimbursement.",
      path: "/",
    });
    return response;
  }

  if (typeof note !== "string" || note.trim().length === 0) {
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({
      name: "myst-flash-error",
      value: "What was purchased is required.",
      path: "/",
    });
    return response;
  }

  if (typeof paidDate !== "string" || paidDate.trim().length === 0) {
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({
      name: "myst-flash-error",
      value: "Purchase date is required.",
      path: "/",
    });
    return response;
  }

  const paidAt = isoFromDateInput(paidDate);
  if (!paidAt) {
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({
      name: "myst-flash-error",
      value: "Invalid purchase date.",
      path: "/",
    });
    return response;
  }

  if (amountCents === null) {
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({
      name: "myst-flash-error",
      value: "Amount is required.",
      path: "/",
    });
    return response;
  }

  const requestBody = new FormData();
  requestBody.set("memberId", memberId.trim());
  requestBody.set("amountCents", String(amountCents));
  requestBody.set("note", note.trim());
  requestBody.set("paidAt", paidAt);

  const vendor = form.get("vendor");
  if (typeof vendor === "string" && vendor.trim().length > 0) {
    requestBody.set("vendor", vendor.trim());
  }

  const receiptFile = form.get("receiptFile");
  if (receiptFile instanceof File && receiptFile.size > 0) {
    requestBody.set("receiptFile", receiptFile);
    requestBody.set("receiptFilename", receiptFile.name || "receipt");
  }

  const apiResponse = await callAdminApi(
    `/api/admin/commissions/payout-runs/${payoutRunId}/reimbursements`,
    {
      method: "POST",
      body: requestBody,
    },
  );

  const response = NextResponse.redirect(redirectTo, 303);
  if (!apiResponse.ok) {
    let message = "Unable to save reimbursement";
    try {
      const data = (await apiResponse.json()) as {
        error?: string;
        message?: string;
      };
      if (data.error === "file_too_large") {
        message = "Receipt file is too large (max 10MB).";
      } else if (
        typeof data.message === "string" &&
        data.message.trim().length > 0
      ) {
        message = data.message;
      } else if (
        typeof data.error === "string" &&
        data.error.trim().length > 0
      ) {
        message = data.error.replace(/_/g, " ");
      }
    } catch {
      // ignore
    }
    response.cookies.set({ name: "myst-flash-error", value: message, path: "/" });
    return response;
  }

  response.cookies.set({
    name: "myst-flash",
    value: "Reimbursement saved",
    path: "/",
  });
  return response;
}
