import { NextResponse } from "next/server";
import { getApiReadinessSnapshot } from "@/lib/readiness";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const snapshot = await getApiReadinessSnapshot();
    if (!snapshot.ok) {
      console.error("[readyz] api_not_ready", snapshot);
    }
    return NextResponse.json(snapshot, {
      status: snapshot.ok ? 200 : 503,
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error("[readyz] api_check_failed", error);
    return NextResponse.json(
      {
        ok: false,
        checkedAt: new Date().toISOString(),
        checks: { readiness: { state: "failed" } },
      },
      {
        status: 503,
        headers: { "Cache-Control": "no-store, max-age=0" },
      },
    );
  }
}
