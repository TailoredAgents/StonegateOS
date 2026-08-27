import { NextResponse } from "next/server";
import { ExpenseReceiptCaptureError } from "@/lib/expense-receipt-captures";

export function expenseReceiptCaptureErrorResponse(
  error: unknown,
): NextResponse {
  if (error instanceof ExpenseReceiptCaptureError) {
    return NextResponse.json(
      { error: error.code, message: error.message },
      {
        status: error.status,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
  const detail = error instanceof Error ? error.message : String(error);
  if (detail === "media_storage_credentials_missing") {
    return NextResponse.json(
      { error: "expense_receipt_storage_not_configured" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  console.error("[expense.receipt] request_failed", {
    errorName: error instanceof Error ? error.name : "UnknownError",
    errorCode: /^[a-z0-9_]{1,160}$/u.test(detail) ? detail : "unknown",
  });
  return NextResponse.json(
    {
      error: "expense_receipt_capture_failed",
      message: "The receipt could not be processed. Try again.",
    },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  );
}

export function requireExpenseCaptureActorId(
  value: string | null | undefined,
): string {
  const normalized = value?.trim() ?? "";
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      normalized,
    )
  ) {
    throw new ExpenseReceiptCaptureError(
      "expense_receipt_actor_unavailable",
      403,
    );
  }
  return normalized;
}

export function permissionListIncludes(
  permissions: readonly string[],
  required: string,
): boolean {
  return permissions.some(
    (permission) =>
      permission === "*" ||
      permission === required ||
      (permission.endsWith(".*") &&
        required.startsWith(permission.slice(0, -1))),
  );
}
