import type { NextRequest } from "next/server";
import { requireTeamPrincipal } from "@/app/api/team/auth";
import { getSafeRedirectUrl } from "@/app/api/team/redirects";
import { callAdminApiAs } from "@/app/team/lib/api";
import {
  buildExpenseFormBody,
  expenseFlashRedirect,
  readExpenseMutationResponse,
  readIdempotencyKey,
} from "./form-utils";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  const fallback = new URL("/team/expenses", request.url);
  const auth = await requireTeamPrincipal(request, {
    permissions: "expenses.write",
    redirectTo: fallback,
  });
  if (!auth.ok) return auth.response;

  const redirectTo = getSafeRedirectUrl(request, "/team/expenses");
  const form = await request.formData();
  const idempotencyKey = readIdempotencyKey(form);
  if (!idempotencyKey) {
    return expenseFlashRedirect(
      redirectTo,
      "This form expired. Refresh Expenses and try again.",
      false,
    );
  }
  const parsed = buildExpenseFormBody(form);
  if (!parsed.ok) {
    return expenseFlashRedirect(redirectTo, parsed.message, false);
  }

  try {
    const apiResponse = await callAdminApiAs(
      auth.principal,
      "/api/admin/expenses",
      {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: parsed.body,
      },
    );
    const outcome = await readExpenseMutationResponse(
      apiResponse,
      "Expense draft saved. Review it, then post it to include it in totals.",
      { actorId: auth.principal.memberId },
    );
    return expenseFlashRedirect(redirectTo, outcome.message, outcome.ok);
  } catch {
    return expenseFlashRedirect(
      redirectTo,
      "The expense service could not be reached. Nothing was reported as saved; retry with the same form.",
      false,
    );
  }
}
