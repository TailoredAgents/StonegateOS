import type { NextRequest } from "next/server";
import { requireTeamPrincipal } from "@/app/api/team/auth";
import { getSafeRedirectUrl } from "@/app/api/team/redirects";
import { callAdminApiAs } from "@/app/team/lib/api";
import {
  buildExpenseFormBody,
  expenseFlashRedirect,
  readExpenseMutationResponse,
  readExpectedVersion,
  readIdempotencyKey,
} from "../../form-utils";

type RouteContext = { params: Promise<{ expenseId: string }> };

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const fallback = new URL("/team/expenses", request.url);
  const auth = await requireTeamPrincipal(request, {
    permissions: "expenses.approve",
    redirectTo: fallback,
  });
  if (!auth.ok) return auth.response;
  const redirectTo = getSafeRedirectUrl(request, "/team/expenses");
  const form = await request.formData();
  const version = readExpectedVersion(form);
  const idempotencyKey = readIdempotencyKey(form);
  if (!version || !idempotencyKey) {
    return expenseFlashRedirect(
      redirectTo,
      "This expense form is stale. Refresh and try again.",
      false,
    );
  }
  const parsed = buildExpenseFormBody(form, {
    requireReason: true,
    includeReceipt: false,
  });
  if (!parsed.ok) {
    return expenseFlashRedirect(redirectTo, parsed.message, false);
  }
  const { expenseId } = await context.params;

  try {
    const apiResponse = await callAdminApiAs(
      auth.principal,
      `/api/admin/expenses/${encodeURIComponent(expenseId)}/correct`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey,
          "If-Match": version,
        },
        body: parsed.body,
      },
    );
    const outcome = await readExpenseMutationResponse(
      apiResponse,
      "Expense corrected with a linked reversal and replacement.",
      { actorId: auth.principal.memberId, expenseId },
    );
    return expenseFlashRedirect(redirectTo, outcome.message, outcome.ok);
  } catch {
    return expenseFlashRedirect(
      redirectTo,
      "The expense service could not be reached. No correction was reported as saved.",
      false,
    );
  }
}
