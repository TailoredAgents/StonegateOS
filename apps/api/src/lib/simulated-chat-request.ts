import type { SimulatedSalesChatMessage } from "@/lib/facebook-sales-autopilot";

export const MAX_SIMULATED_CHAT_REQUEST_BYTES = 96 * 1024;
export const MAX_SIMULATED_CHAT_MESSAGES = 40;
export const MAX_SIMULATED_CHAT_MESSAGE_CHARS = 2_000;

type Confidence = "low" | "medium" | "high";
type SimulationMode = "off" | "shadow" | "assist" | "auto";

export type SimulatedChatRequest = {
  channel: "dm" | "sms";
  simulationMode: SimulationMode | null;
  contactId: string | null;
  messages: SimulatedSalesChatMessage[];
  previousQuoteRange: {
    lowCents: number;
    highCents: number;
    confidence: Confidence;
  } | null;
  previousOfferedSlots: Array<{
    label: string;
    startAt: string;
    endAt: string | null;
  }>;
};

export type SimulatedChatRequestParseResult =
  | { ok: true; value: SimulatedChatRequest }
  | { ok: false; error: string; message: string };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TOP_LEVEL_KEYS = new Set([
  "channel",
  "simulationMode",
  "contactId",
  "messages",
  "previousQuoteRange",
  "previousOfferedSlots",
]);
const MESSAGE_KEYS = new Set(["role", "body", "mediaUrls", "createdAt"]);
const QUOTE_KEYS = new Set(["lowCents", "highCents", "confidence"]);
const SLOT_KEYS = new Set(["label", "startAt", "endAt"]);
const SYNTHETIC_MEDIA_URL = "simulated-photo://customer-upload";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function canonicalInstant(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
    ? value
    : null;
}

function confidence(value: unknown): Confidence | null {
  return value === "low" || value === "medium" || value === "high"
    ? value
    : null;
}

function failure(
  error: string,
  message: string,
): SimulatedChatRequestParseResult {
  return { ok: false, error, message };
}

function parseMessages(
  value: unknown,
): { ok: true; value: SimulatedSalesChatMessage[] } | { ok: false } {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_SIMULATED_CHAT_MESSAGES
  ) {
    return { ok: false };
  }

  const messages: SimulatedSalesChatMessage[] = [];
  for (const item of value) {
    if (!isRecord(item) || !hasOnlyKeys(item, MESSAGE_KEYS)) {
      return { ok: false };
    }
    const role = item["role"];
    if (role !== "customer" && role !== "agent") return { ok: false };

    const body = typeof item["body"] === "string" ? item["body"].trim() : "";
    if (body.length > MAX_SIMULATED_CHAT_MESSAGE_CHARS) return { ok: false };

    const rawMediaUrls = item["mediaUrls"] ?? [];
    if (
      !Array.isArray(rawMediaUrls) ||
      rawMediaUrls.length > 1 ||
      rawMediaUrls.some((url) => url !== SYNTHETIC_MEDIA_URL)
    ) {
      return { ok: false };
    }
    const mediaUrls = rawMediaUrls as string[];
    if (!body && mediaUrls.length === 0) return { ok: false };

    const createdAtValue = item["createdAt"];
    const createdAt =
      createdAtValue === undefined || createdAtValue === null
        ? null
        : canonicalInstant(createdAtValue);
    if (createdAtValue !== undefined && createdAtValue !== null && !createdAt) {
      return { ok: false };
    }

    messages.push({ role, body, mediaUrls, createdAt });
  }
  return { ok: true, value: messages };
}

function parseQuoteRange(
  value: unknown,
): SimulatedChatRequest["previousQuoteRange"] | undefined {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || !hasOnlyKeys(value, QUOTE_KEYS)) return undefined;
  const lowCents = value["lowCents"];
  const highCents = value["highCents"];
  const parsedConfidence = confidence(value["confidence"]);
  if (
    typeof lowCents !== "number" ||
    typeof highCents !== "number" ||
    !Number.isSafeInteger(lowCents) ||
    !Number.isSafeInteger(highCents) ||
    lowCents < 0 ||
    highCents < lowCents ||
    highCents > 10_000_000 ||
    !parsedConfidence
  ) {
    return undefined;
  }
  return {
    lowCents,
    highCents,
    confidence: parsedConfidence,
  };
}

function parseOfferedSlots(
  value: unknown,
): SimulatedChatRequest["previousOfferedSlots"] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 6) return undefined;

  const slots: SimulatedChatRequest["previousOfferedSlots"] = [];
  for (const item of value) {
    if (!isRecord(item) || !hasOnlyKeys(item, SLOT_KEYS)) return undefined;
    const label = typeof item["label"] === "string" ? item["label"].trim() : "";
    const startAt = canonicalInstant(item["startAt"]);
    const rawEndAt = item["endAt"];
    const endAt =
      rawEndAt === undefined || rawEndAt === null
        ? null
        : canonicalInstant(rawEndAt);
    if (
      !label ||
      label.length > 160 ||
      !startAt ||
      (rawEndAt !== undefined && rawEndAt !== null && !endAt) ||
      (endAt !== null && Date.parse(endAt) <= Date.parse(startAt))
    ) {
      return undefined;
    }
    slots.push({ label, startAt, endAt });
  }
  return slots;
}

export function parseSimulatedChatRequest(
  input: unknown,
): SimulatedChatRequestParseResult {
  if (!isRecord(input) || !hasOnlyKeys(input, TOP_LEVEL_KEYS)) {
    return failure(
      "invalid_payload",
      "The simulation request contains unsupported or missing fields.",
    );
  }

  const channel = input["channel"];
  if (channel !== "dm" && channel !== "sms") {
    return failure("invalid_channel", "Choose SMS or Messenger.");
  }

  const simulationMode = input["simulationMode"];
  if (
    simulationMode !== undefined &&
    simulationMode !== null &&
    simulationMode !== "off" &&
    simulationMode !== "shadow" &&
    simulationMode !== "assist" &&
    simulationMode !== "auto"
  ) {
    return failure("invalid_mode", "Choose a supported simulation mode.");
  }

  const contactId = input["contactId"];
  if (
    contactId !== undefined &&
    contactId !== null &&
    (typeof contactId !== "string" || !UUID_PATTERN.test(contactId))
  ) {
    return failure(
      "invalid_contact",
      "Choose a valid contact or run without live CRM context.",
    );
  }

  const messages = parseMessages(input["messages"]);
  if (
    !messages.ok ||
    !messages.value.some((message) => message.role === "customer")
  ) {
    return failure(
      "invalid_messages",
      `Provide 1 to ${MAX_SIMULATED_CHAT_MESSAGES} valid messages, including a customer message.`,
    );
  }

  const previousQuoteRange = parseQuoteRange(input["previousQuoteRange"]);
  if (previousQuoteRange === undefined) {
    return failure("invalid_quote_range", "The prior quote range is invalid.");
  }
  const previousOfferedSlots = parseOfferedSlots(input["previousOfferedSlots"]);
  if (previousOfferedSlots === undefined) {
    return failure(
      "invalid_offered_slots",
      "The prior offered times are invalid.",
    );
  }

  return {
    ok: true,
    value: {
      channel,
      simulationMode:
        (simulationMode as SimulationMode | null | undefined) ?? null,
      contactId: contactId ?? null,
      messages: messages.value,
      previousQuoteRange,
      previousOfferedSlots,
    },
  };
}
