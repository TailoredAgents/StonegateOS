import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import {
  simulateFacebookSalesChatTurn,
  type SimulatedSalesChatMessage,
} from "@/lib/facebook-sales-autopilot";
import { loadOmniLeadContext } from "@/lib/omni-lead-context";
import {
  getSalesAutopilotPolicy,
  type SalesAutopilotPolicy,
} from "@/lib/policy";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceMessages(value: unknown): SimulatedSalesChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): SimulatedSalesChatMessage | null => {
      if (!isRecord(item)) return null;
      const role =
        item["role"] === "agent"
          ? "agent"
          : item["role"] === "customer"
            ? "customer"
            : null;
      const body = typeof item["body"] === "string" ? item["body"].trim() : "";
      const mediaUrls = Array.isArray(item["mediaUrls"])
        ? item["mediaUrls"].filter(
            (url): url is string =>
              typeof url === "string" && url.trim().length > 0,
          )
        : [];
      if (!role || (!body && mediaUrls.length === 0)) return null;
      return {
        role,
        body,
        mediaUrls,
        createdAt:
          typeof item["createdAt"] === "string" ? item["createdAt"] : null,
      };
    })
    .filter((message): message is SimulatedSalesChatMessage => Boolean(message))
    .slice(-40);
}

function coerceQuoteRange(value: unknown): {
  lowCents: number;
  highCents: number;
  confidence: "low" | "medium" | "high";
} | null {
  if (!isRecord(value)) return null;
  const lowCents = Number(value["lowCents"]);
  const highCents = Number(value["highCents"]);
  if (!Number.isFinite(lowCents) || !Number.isFinite(highCents)) return null;
  const confidence: "low" | "medium" | "high" =
    value["confidence"] === "high" || value["confidence"] === "medium"
      ? value["confidence"]
      : "low";
  return {
    lowCents: Math.round(lowCents),
    highCents: Math.round(highCents),
    confidence,
  };
}

function coerceOfferedSlots(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!isRecord(item)) return null;
      const label =
        typeof item["label"] === "string" ? item["label"].trim() : "";
      const startAt =
        typeof item["startAt"] === "string" ? item["startAt"].trim() : "";
      if (!label || !startAt) return null;
      return {
        label,
        startAt,
        endAt: typeof item["endAt"] === "string" ? item["endAt"] : null,
      };
    })
    .filter(
      (
        slot,
      ): slot is { label: string; startAt: string; endAt: string | null } =>
        Boolean(slot),
    )
    .slice(-6);
}

function coerceSimulationMode(
  value: unknown,
): SalesAutopilotPolicy["facebookCloser"]["mode"] | null {
  if (
    value === "off" ||
    value === "shadow" ||
    value === "assist" ||
    value === "auto"
  ) {
    return value;
  }
  return null;
}

function coerceContactId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      trimmed,
    )
  ) {
    return trimmed;
  }
  return null;
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "messages.send");
  if (permissionError) return permissionError;

  const payload = (await request.json().catch(() => null)) as unknown;
  if (!isRecord(payload)) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const messages = coerceMessages(payload["messages"]);
  if (!messages.some((message) => message.role === "customer")) {
    return NextResponse.json(
      { error: "customer_message_required" },
      { status: 400 },
    );
  }

  const db = getDb();
  const policy = await getSalesAutopilotPolicy(db);
  const contactId = coerceContactId(payload["contactId"]);
  const contactContext = contactId
    ? await loadOmniLeadContext(db, {
        contactId,
        includeQuotePrice: true,
        messageLimit: 60,
      })
    : null;
  if (contactId && !contactContext) {
    return NextResponse.json(
      { error: "contact_context_not_found" },
      { status: 404 },
    );
  }
  const simulationMode = coerceSimulationMode(payload["simulationMode"]);
  const simulationPolicy = simulationMode
    ? {
        ...policy,
        facebookCloser: {
          ...policy.facebookCloser,
          mode: simulationMode,
          emergencyStop:
            simulationMode === "off" ? policy.facebookCloser.emergencyStop : false,
        },
      }
    : policy;
  const result = simulateFacebookSalesChatTurn({
    channel: payload["channel"] === "sms" ? "sms" : "dm",
    messages,
    policy: simulationPolicy,
    context: contactContext
      ? {
          latestLead: contactContext.latestLead,
          instantQuote: contactContext.instantQuote,
          derived: contactContext.derived,
          recentMessages: contactContext.recentMessages,
        }
      : null,
    previousQuoteRange: coerceQuoteRange(payload["previousQuoteRange"]),
    previousOfferedSlots: coerceOfferedSlots(payload["previousOfferedSlots"]),
  });

  return NextResponse.json({ ok: true, result });
}
