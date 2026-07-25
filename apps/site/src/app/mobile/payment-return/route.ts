import { NextResponse } from "next/server";
import { callAdminApi } from "@/app/team/lib/api";
import {
  shouldRedirectToSquareSetup,
  type SquareReturnResult,
} from "./routing";

const returnStatuses = new Set([
  "verified",
  "pending_verification",
  "canceled",
  "failed",
  "needs_review",
]);

function collectQuery(
  searchParams: URLSearchParams,
): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of searchParams.entries()) {
    const current = query[key];
    if (current === undefined) query[key] = value;
    else if (Array.isArray(current)) current.push(value);
    else query[key] = [current, value];
  }
  return query;
}

export async function GET(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);
  let result: SquareReturnResult = {
    ok: false,
    status: "pending_verification",
  };

  try {
    const upstream = await callAdminApi("/api/payments/square/return", {
      method: "POST",
      body: JSON.stringify({ query: collectQuery(requestUrl.searchParams) }),
      timeoutMs: 30_000,
    });
    const payload = (await upstream.json().catch(() => null)) as
      | SquareReturnResult
      | null;
    if (payload) result = payload;
  } catch {
    // Reconciliation and webhooks can still verify the payment after a
    // transient return-path failure.
  }

  const status =
    typeof result.status === "string" && returnStatuses.has(result.status)
      ? result.status
      : "pending_verification";
  const destination = new URL("/mobile", requestUrl.origin);
  destination.searchParams.set("screen", "myday");
  destination.searchParams.set("payment", status);
  if (result.attemptId) {
    destination.searchParams.set("paymentAttempt", result.attemptId);
  }
  if (result.errorCode) {
    destination.searchParams.set("paymentError", result.errorCode);
  }
  if (shouldRedirectToSquareSetup(result)) {
    const setup = new URL("/mobile/square-setup", requestUrl.origin);
    setup.searchParams.set("reason", result.errorCode!);
    if (result.attemptId) {
      setup.searchParams.set("paymentAttempt", result.attemptId);
    }
    return NextResponse.redirect(setup, 303);
  }
  return NextResponse.redirect(destination, 303);
}
