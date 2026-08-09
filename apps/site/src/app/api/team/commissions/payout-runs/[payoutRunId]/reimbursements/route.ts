import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireTeamPrincipal } from "@/app/api/team/auth";
import { callAdminApiAs } from "@/app/team/lib/api";
import { getSafeRedirectUrl } from "@/app/api/team/redirects";

export const dynamic = "force-dynamic";

type MutationPayload = {
  ok?: boolean;
  code?: string;
  error?: string;
  message?: string;
};

function formString(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function mutationKey(form: FormData, action: string): string {
  return (
    formString(form, "idempotencyKey") ||
    `commissions:reimbursement:${action}:${randomUUID()}`
  );
}

async function readMutationFeedback(
  response: Response,
  fallback: string,
): Promise<{ ok: boolean; message: string }> {
  const payload = (await response
    .json()
    .catch(() => null)) as MutationPayload | null;
  if (!response.ok || payload?.ok !== true) {
    return {
      ok: false,
      message:
        payload?.message?.trim() ||
        payload?.error?.replace(/_/g, " ") ||
        payload?.code?.replace(/_/g, " ") ||
        fallback,
    };
  }
  return { ok: true, message: "" };
}

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
  const auth = await requireTeamPrincipal(request, {
    permissions: "commissions.manage",
    redirectTo: new URL("/team?tab=commissions", request.url),
  });
  if (!auth.ok) return auth.response;

  const redirectTo = getSafeRedirectUrl(request, "/team?tab=commissions");
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
  const action = formString(form, "action");
  const expectedVersion = formString(form, "expectedVersion");

  if (action === "delete") {
    const adjustmentId = form.get("adjustmentId");
    const apiResponse = await callAdminApiAs(
      auth.principal,
      `/api/admin/commissions/payout-runs/${payoutRunId}/reimbursements`,
      {
        method: "DELETE",
        headers: {
          "Idempotency-Key": mutationKey(form, "delete"),
          ...(expectedVersion ? { "If-Match": `"${expectedVersion}"` } : {}),
        },
        body: JSON.stringify({ adjustmentId }),
      },
    );

    const response = NextResponse.redirect(redirectTo, 303);
    const feedback = await readMutationFeedback(
      apiResponse,
      "Unable to delete reimbursement",
    );
    if (!feedback.ok) {
      response.cookies.set({
        name: "myst-flash-error",
        value: feedback.message,
        path: "/",
      });
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

  const apiResponse = await callAdminApiAs(
    auth.principal,
    `/api/admin/commissions/payout-runs/${payoutRunId}/reimbursements`,
    {
      method: "POST",
      headers: {
        "Idempotency-Key": mutationKey(form, "create"),
        ...(expectedVersion ? { "If-Match": `"${expectedVersion}"` } : {}),
      },
      body: requestBody,
    },
  );

  const response = NextResponse.redirect(redirectTo, 303);
  const feedback = await readMutationFeedback(
    apiResponse,
    "Unable to save reimbursement",
  );
  if (!feedback.ok) {
    response.cookies.set({
      name: "myst-flash-error",
      value: feedback.message,
      path: "/",
    });
    return response;
  }

  response.cookies.set({
    name: "myst-flash",
    value: "Reimbursement saved",
    path: "/",
  });
  return response;
}
