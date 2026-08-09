import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { simulateFacebookSalesChatTurn } from "@/lib/facebook-sales-autopilot";
import { loadOmniLeadContext } from "@/lib/omni-lead-context";
import { getSalesAutopilotPolicy } from "@/lib/policy";
import { requirePermission } from "@/lib/permissions";
import {
  MAX_SIMULATED_CHAT_REQUEST_BYTES,
  parseSimulatedChatRequest,
} from "@/lib/simulated-chat-request";
import { isAdminRequest } from "../../../web/admin";

export const dynamic = "force-dynamic";

const PRIVATE_NO_STORE = "private, no-store, max-age=0";

function simulationError(
  status: number,
  error: string,
  message: string,
): NextResponse {
  return NextResponse.json(
    { ok: false, error, message },
    { status, headers: { "Cache-Control": PRIVATE_NO_STORE } },
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return simulationError(401, "unauthorized", "Authentication is required.");
  }
  const permissionError = await requirePermission(
    request,
    "automation.simulate",
  );
  if (permissionError) return permissionError;

  let rawPayload: unknown;
  try {
    rawPayload = await readBoundedJsonRequest(request, {
      maximumBytes: MAX_SIMULATED_CHAT_REQUEST_BYTES,
      deadlineMs: 5_000,
      rejectDuplicateObjectKeys: true,
    });
  } catch (error) {
    if (error instanceof BoundedJsonRequestError) {
      return simulationError(error.status, error.code, error.message);
    }
    return simulationError(
      400,
      "invalid_payload",
      "The simulation request could not be read.",
    );
  }

  const parsed = parseSimulatedChatRequest(rawPayload);
  if (!parsed.ok) {
    return simulationError(422, parsed.error, parsed.message);
  }
  const payload = parsed.value;

  try {
    const db = getDb();
    const snapshot = await db.transaction(async (tx) => {
      // This database-enforced boundary makes an accidental INSERT, UPDATE,
      // DELETE, or write-capable helper fail before it can affect CRM data.
      // Repeatable read also keeps the policy and optional contact context on
      // one coherent snapshot for the complete simulation turn.
      await tx.execute(
        sql`set transaction isolation level repeatable read read only`,
      );
      const policy = await getSalesAutopilotPolicy(tx);
      const contactContext = payload.contactId
        ? await loadOmniLeadContext(tx, {
            contactId: payload.contactId,
            includeQuotePrice: true,
            messageLimit: 60,
          })
        : null;
      return { policy, contactContext };
    });

    if (payload.contactId && !snapshot.contactContext) {
      return simulationError(
        404,
        "contact_context_not_found",
        "The selected contact is unavailable. Choose another contact or run without CRM context.",
      );
    }

    const simulationPolicy = payload.simulationMode
      ? {
          ...snapshot.policy,
          facebookCloser: {
            ...snapshot.policy.facebookCloser,
            mode: payload.simulationMode,
            emergencyStop:
              payload.simulationMode === "off"
                ? snapshot.policy.facebookCloser.emergencyStop
                : false,
          },
        }
      : snapshot.policy;
    const result = simulateFacebookSalesChatTurn({
      channel: payload.channel,
      messages: payload.messages,
      policy: simulationPolicy,
      context: snapshot.contactContext
        ? {
            latestLead: snapshot.contactContext.latestLead,
            instantQuote: snapshot.contactContext.instantQuote,
            derived: snapshot.contactContext.derived,
            recentMessages: snapshot.contactContext.recentMessages,
          }
        : null,
      previousQuoteRange: payload.previousQuoteRange,
      previousOfferedSlots: payload.previousOfferedSlots,
    });

    return NextResponse.json(
      { ok: true, result },
      { headers: { "Cache-Control": PRIVATE_NO_STORE } },
    );
  } catch (error) {
    console.error("[simulated-chat] read_only_simulation_failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return simulationError(
      500,
      "simulation_unavailable",
      "The simulation could not be completed. No CRM changes were made.",
    );
  }
}
