import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  getContactMergeRecoveryAssessment,
  MergeQueueError,
} from "@/lib/merge-queue";
import { isExactContactMergeUuid } from "@/lib/contact-merge-contract";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../../web/admin";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ ledgerId?: string }> },
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "contacts.merge");
  if (permissionError) return permissionError;
  if (request.nextUrl.search.length > 0) {
    return NextResponse.json(
      { error: "unsupported_query", retryable: false },
      { status: 422 },
    );
  }

  const { ledgerId: rawLedgerId } = await context.params;
  if (!isExactContactMergeUuid(rawLedgerId)) {
    return NextResponse.json(
      { error: "invalid_recovery_ledger", retryable: false },
      { status: 422 },
    );
  }
  const ledgerId = rawLedgerId;

  try {
    const result = await getContactMergeRecoveryAssessment(ledgerId);
    return NextResponse.json(result, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    if (error instanceof MergeQueueError) {
      return NextResponse.json(
        { error: error.code, retryable: false },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: "merge_recovery_assessment_failed", retryable: true },
      { status: 500 },
    );
  }
}
