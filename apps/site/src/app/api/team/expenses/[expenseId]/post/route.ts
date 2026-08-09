import type { NextRequest } from "next/server";
import { requireTeamPrincipal } from "@/app/api/team/auth";
import { getSafeRedirectUrl } from "@/app/api/team/redirects";
import { callAdminApiAs } from "@/app/team/lib/api";
import {
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
    permissions: "expenses.write",
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
  const { expenseId } = await context.params;

  try {
    const apiResponse = await callAdminApiAs(
      auth.principal,
      `/api/admin/expenses/${encodeURIComponent(expenseId)}/post`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey,
          "If-Match": version,
        },
        body: JSON.stringify({}),
      },
    );
    const outcome = await readExpenseMutationResponse(
      apiResponse,
      "Expense posted and included in financial totals.",
      { actorId: auth.principal.memberId, expenseId },
    );
    return expenseFlashRedirect(redirectTo, outcome.message, outcome.ok);
  } catch {
    return expenseFlashRedirect(
      redirectTo,
      "The expense service could not be reached. The expense was not reported as posted.",
      false,
    );
  }
}
