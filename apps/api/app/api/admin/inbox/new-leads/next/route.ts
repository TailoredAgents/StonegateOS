import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { loadInboxNewLeadFeed } from "@/lib/inbox-new-lead-acknowledgements";
import { requirePermission } from "@/lib/permissions";
import { getVerifiedRequestActor } from "@/lib/verified-actor-context";
import { isAdminRequest } from "../../../../web/admin";

function noStoreJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return noStoreJson({ error: "unauthorized" }, 401);
  }
  const permissionError = await requirePermission(request, "messages.read");
  if (permissionError) return permissionError;

  const actor = getVerifiedRequestActor(request);
  if (
    actor?.type !== "human" ||
    !actor.id ||
    !actor.sessionId ||
    (actor.authMethod !== "team_session" && actor.authMethod !== "break_glass")
  ) {
    return noStoreJson(
      {
        ok: false,
        code: "forbidden",
        message: "A verified human team session is required.",
        retryable: false,
      },
      403,
    );
  }

  // The feed is deliberately fixed and bounded. Unknown controls must not
  // silently change its eligibility or exact-total semantics.
  if (request.nextUrl.search.length > 0) {
    return noStoreJson(
      {
        ok: false,
        code: "invalid",
        message: "This feed does not accept query parameters.",
        retryable: false,
      },
      422,
    );
  }

  try {
    const feed = await loadInboxNewLeadFeed(getDb(), actor.id, new Date());
    return noStoreJson(feed);
  } catch (error) {
    console.error("[inbox-new-leads] feed_unavailable", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    // A failed read is never represented as an empty list or a zero total.
    return noStoreJson(
      {
        ok: false,
        code: "internal",
        message:
          "New-lead status is temporarily unavailable. Refresh before relying on this queue.",
        retryable: true,
      },
      500,
    );
  }
}
