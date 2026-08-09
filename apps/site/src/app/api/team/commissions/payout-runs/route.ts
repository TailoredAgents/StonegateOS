import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireTeamPrincipal } from "@/app/api/team/auth";
import { getSafeRedirectUrl } from "@/app/api/team/redirects";
import {
  isTeamMutationSuccessEnvelope,
  readTeamMutationError,
  readTeamMutationException,
  type TeamMutationSuccessEnvelope,
} from "@/app/team/lib/mutation-feedback";
import { callAdminApiAs } from "@/app/team/lib/api";

export const dynamic = "force-dynamic";

type PayoutAction = "create" | "lock" | "paid";
type PayoutMutationData = {
  payoutRunId: string;
  status: "draft" | "locked" | "paid";
  version: string;
  created?: boolean;
  changed?: boolean;
};

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formString(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.normalize("NFKC").trim() : "";
}

function validVersion(value: string): boolean {
  const timestamp = new Date(value);
  return (
    value.length > 0 &&
    !Number.isNaN(timestamp.getTime()) &&
    timestamp.toISOString() === value
  );
}

function flashRedirect(
  redirectTo: URL,
  message: string,
  ok: boolean,
): NextResponse {
  const response = NextResponse.redirect(redirectTo, 303);
  response.cookies.set({
    name: ok ? "myst-flash" : "myst-flash-error",
    value: message.slice(0, 500),
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: redirectTo.protocol === "https:",
  });
  return response;
}

function validMutationData(
  value: unknown,
  expected: {
    action: PayoutAction;
    payoutRunId: string | null;
    actorId: string;
  },
): value is TeamMutationSuccessEnvelope<PayoutMutationData> {
  if (!isTeamMutationSuccessEnvelope<PayoutMutationData>(value)) return false;
  const data = value.data;
  if (
    !isRecord(data) ||
    typeof data["payoutRunId"] !== "string" ||
    !UUID_PATTERN.test(data["payoutRunId"]) ||
    (expected.payoutRunId !== null &&
      data["payoutRunId"] !== expected.payoutRunId) ||
    typeof data["version"] !== "string" ||
    !validVersion(data["version"]) ||
    (data["status"] !== "draft" &&
      data["status"] !== "locked" &&
      data["status"] !== "paid")
  ) {
    return false;
  }
  if (expected.action === "create") {
    if (typeof data["created"] !== "boolean") return false;
  } else {
    const requiredStatus = expected.action === "lock" ? "locked" : "paid";
    if (
      data["status"] !== requiredStatus ||
      typeof data["changed"] !== "boolean"
    ) {
      return false;
    }
  }

  const receipt = value.receipt;
  return (
    receipt.actorId === expected.actorId &&
    UUID_PATTERN.test(receipt.operationId) &&
    validVersion(receipt.committedAt) &&
    receipt.entityType === "payout_run" &&
    receipt.entityId === data["payoutRunId"] &&
    receipt.version === data["version"] &&
    typeof receipt.auditEventId === "string" &&
    UUID_PATTERN.test(receipt.auditEventId)
  );
}

async function payoutMutationFeedback(
  response: Response,
  expected: {
    action: PayoutAction;
    payoutRunId: string | null;
    actorId: string;
    success: string;
    failure: string;
  },
): Promise<{ ok: boolean; message: string }> {
  if (!response.ok) {
    return {
      ok: false,
      message: await readTeamMutationError(response, expected.failure),
    };
  }
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!validMutationData(payload, expected)) {
    return {
      ok: false,
      message: `${expected.failure}. The service returned an unreadable financial receipt, so no success is being claimed. Refresh before retrying.`,
    };
  }
  const data = payload.data;
  if (expected.action === "create" && data.created === false) {
    return {
      ok: true,
      message:
        data.status === "draft"
          ? "Current draft payout run refreshed."
          : `The current payout run is already ${data.status}; no financial state changed.`,
    };
  }
  if (expected.action !== "create" && data.changed === false) {
    return {
      ok: true,
      message:
        expected.action === "lock"
          ? "This payout run was already locked; no duplicate transition occurred."
          : "This payout run was already paid; no duplicate expense was posted.",
    };
  }
  return { ok: true, message: expected.success };
}

export async function POST(request: NextRequest): Promise<Response> {
  const fallback = new URL("/team/admin/commissions", request.url);
  const auth = await requireTeamPrincipal(request, {
    permissions: ["commissions.manage", "commissions.pay"],
    permissionMode: "any",
    redirectTo: fallback,
  });
  if (!auth.ok) return auth.response;

  const redirectTo = getSafeRedirectUrl(request, "/team/admin/commissions");
  const formData = await request.formData();
  const action = formString(formData, "action") as PayoutAction;
  const payoutRunId = formString(formData, "payoutRunId");
  const expectedVersion = formString(formData, "expectedVersion");
  const idempotencyKey = formString(formData, "idempotencyKey");

  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return flashRedirect(
      redirectTo,
      "This payout form expired. Refresh Commissions and try again; no financial change was reported.",
      false,
    );
  }
  if (action !== "create" && action !== "lock" && action !== "paid") {
    return flashRedirect(redirectTo, "Unknown payout action.", false);
  }
  if (action !== "create") {
    if (!UUID_PATTERN.test(payoutRunId) || !validVersion(expectedVersion)) {
      return flashRedirect(
        redirectTo,
        "This payout form is stale. Refresh Commissions and try again.",
        false,
      );
    }
    if (formString(formData, "confirmation") !== "reviewed") {
      return flashRedirect(
        redirectTo,
        "Review and confirm this financial transition before continuing.",
        false,
      );
    }
  }

  const targetPath =
    action === "create"
      ? "/api/admin/commissions/payout-runs"
      : action === "lock"
        ? `/api/admin/commissions/payout-runs/${payoutRunId}/lock`
        : `/api/admin/commissions/payout-runs/${payoutRunId}/mark-paid`;
  const success =
    action === "create"
      ? "Payout run created."
      : action === "lock"
        ? "Payout run locked."
        : "Payout run marked paid and posted to expenses.";
  const failure =
    action === "create"
      ? "Unable to create the payout run"
      : action === "lock"
        ? "Unable to lock the payout run"
        : "Unable to mark the payout run paid";

  try {
    const response = await callAdminApiAs(auth.principal, targetPath, {
      method: "POST",
      headers: {
        "Idempotency-Key": idempotencyKey,
        ...(action !== "create" ? { "If-Match": expectedVersion } : {}),
      },
    });
    const feedback = await payoutMutationFeedback(response, {
      action,
      payoutRunId: action === "create" ? null : payoutRunId,
      actorId: auth.principal.memberId,
      success,
      failure,
    });
    return flashRedirect(redirectTo, feedback.message, feedback.ok);
  } catch (error) {
    return flashRedirect(
      redirectTo,
      readTeamMutationException(error, failure),
      false,
    );
  }
}
