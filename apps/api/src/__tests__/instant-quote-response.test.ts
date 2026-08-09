import { z } from "zod";
import {
  instantQuoteListResponseSchema,
  parseInstantQuoteListResponse,
} from "../../../site/src/app/team/lib/instant-quote-response";

function validValue(schema: z.ZodTypeAny): unknown {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    return Object.fromEntries(
      Object.entries(shape).map(([key, child]) => [
        key,
        validValue(child),
      ]),
    );
  }
  if (schema instanceof z.ZodArray) return [];
  if (schema instanceof z.ZodNumber) return 0;
  if (schema instanceof z.ZodString) return "2026-08-08T12:00:00.000Z";
  if (schema instanceof z.ZodBoolean) return false;
  if (schema instanceof z.ZodEnum) {
    const options = schema.options as unknown[];
    return options[0];
  }
  if (schema instanceof z.ZodNullable) return null;
  if (schema instanceof z.ZodOptional) return undefined;
  throw new Error(`Unsupported test schema: ${schema.constructor.name}`);
}

function validPayload(): Record<string, unknown> {
  return validValue(instantQuoteListResponseSchema) as Record<string, unknown>;
}

function recordAt(
  value: Record<string, unknown>,
  ...path: string[]
): Record<string, unknown> {
  let current = value;
  for (const key of path) {
    const next = current[key];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      throw new Error(`Expected record at ${path.join(".")}`);
    }
    current = next as Record<string, unknown>;
  }
  return current;
}

describe("instant quote list response validation", () => {
  it("accepts a complete, finite zero-volume learning response", () => {
    const parsed = parseInstantQuoteListResponse(validPayload());
    expect(parsed.success).toBe(true);
  });

  it("rejects a missing deeply nested learning bucket", () => {
    const payload = validPayload();
    const junk = recordAt(
      payload,
      "followupSummary",
      "byServiceFamily",
      "junk",
    );
    delete junk["byDepth"];

    expect(parseInstantQuoteListResponse(payload).success).toBe(false);
  });

  it("rejects impossible rates and negative counts", () => {
    const badRate = validPayload();
    recordAt(badRate, "summary", "standard")["bookRate"] = 1.01;
    expect(parseInstantQuoteListResponse(badRate).success).toBe(false);

    const badCount = validPayload();
    recordAt(badCount, "appointmentReminderSummary")["attempts"] = -1;
    expect(parseInstantQuoteListResponse(badCount).success).toBe(false);
  });

  it("rejects malformed quote AI and media values", () => {
    const payload = validPayload();
    payload["quotes"] = [
      {
        id: "00000000-0000-4000-8000-000000000001",
        createdAt: "2026-08-08T12:00:00.000Z",
        contactName: "Sanitized Customer",
        contactPhone: "(555) 010-0000",
        timeframe: "this_week",
        zip: "00000",
        jobTypes: ["junk"],
        perceivedSize: "small",
        photoCount: 1,
        aiResult: {
          loadFractionEstimate: 0.5,
          priceLow: 100,
          priceHigh: 200,
          displayTierLabel: "Small",
          reasonSummary: "Sanitized fixture",
          needsInPersonEstimate: false,
          mediaAnalysis: { confidence: "certain" },
        },
      },
    ];

    expect(parseInstantQuoteListResponse(payload).success).toBe(false);
  });
});
