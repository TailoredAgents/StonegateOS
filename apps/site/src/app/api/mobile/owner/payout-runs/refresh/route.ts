import { NextResponse } from "next/server";
import { callAdminApi } from "@/app/team/lib/api";
import { resolveMobileSessionFromCookies } from "@/app/mobile/lib/session";

export const dynamic = "force-dynamic";

type PayoutRefreshResponse = {
  ok?: boolean;
  payoutRunId?: string;
  reportGeneratedAt?: string | null;
  error?: string;
  message?: string;
};

async function readUpstreamError(response: Response): Promise<string> {
  const payload = (await response
    .json()
    .catch(() => null)) as PayoutRefreshResponse | null;
  return (
    payload?.message?.trim() ||
    payload?.error?.trim() ||
    "The payout could not be refreshed."
  );
}

export async function POST(): Promise<Response> {
  const session = await resolveMobileSessionFromCookies();

  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!session.isOwner) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const response = await callAdminApi("/api/admin/commissions/payout-runs", {
      method: "POST",
      timeoutMs: 90_000,
    });

    if (!response.ok) {
      return NextResponse.json(
        {
          error: "payout_refresh_failed",
          message: await readUpstreamError(response),
        },
        { status: response.status >= 400 ? response.status : 502 },
      );
    }

    const payload = (await response
      .json()
      .catch(() => null)) as PayoutRefreshResponse | null;
    if (!payload?.ok || !payload.payoutRunId) {
      return NextResponse.json(
        {
          error: "invalid_payout_refresh_response",
          message:
            "The payout finished processing, but StonegateOS could not confirm the result.",
        },
        { status: 502 },
      );
    }

    return NextResponse.json({
      ok: true,
      payoutRunId: payload.payoutRunId,
      reportGeneratedAt: payload.reportGeneratedAt ?? null,
    });
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "Payout refresh took longer than 90 seconds. It may still finish; wait a moment, then try again."
        : "StonegateOS could not reach the payout service. Please try again.";
    return NextResponse.json(
      { error: "payout_refresh_failed", message },
      { status: 502 },
    );
  }
}
