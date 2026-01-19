import { z } from "zod";

export type CallCoachingRubric = "inbound" | "outbound";

export type CallCoachingResult = {
  model: string;
  scoreOverall: number;
  scoreBreakdown: Record<string, number> | null;
  wins: string[];
  improvements: string[];
};

function readEnvString(key: string): string | null {
  const value = process.env[key];
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function supportsReasoningEffort(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized.startsWith("gpt-5") || normalized.startsWith("o");
}

const CoachingSchema = z.object({
  score_overall: z.number().min(0).max(100),
  score_breakdown: z.record(z.number().min(0).max(100)).nullable().optional(),
  wins: z.array(z.string().min(3).max(220)).min(1).max(5),
  improvements: z.array(z.string().min(3).max(220)).max(5).optional()
});

type BreakdownKeys = "vibe" | "qualifying" | "pricing_clarity" | "booking_push" | "professionalism" | "next_steps";
const REQUIRED_BREAKDOWN_KEYS: BreakdownKeys[] = [
  "vibe",
  "qualifying",
  "pricing_clarity",
  "booking_push",
  "professionalism",
  "next_steps"
];

function getBreakdownValue(breakdown: Record<string, number> | null | undefined, key: BreakdownKeys): number | null {
  if (!breakdown) return null;
  const value = breakdown[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function computeOverallFromBreakdown(breakdown: Record<string, number> | null | undefined): number | null {
  const vibe = getBreakdownValue(breakdown, "vibe");
  const qualifying = getBreakdownValue(breakdown, "qualifying");
  const pricing = getBreakdownValue(breakdown, "pricing_clarity");
  const bookingPush = getBreakdownValue(breakdown, "booking_push");
  const professionalism = getBreakdownValue(breakdown, "professionalism");
  const nextSteps = getBreakdownValue(breakdown, "next_steps");

  if (
    vibe === null ||
    qualifying === null ||
    pricing === null ||
    bookingPush === null ||
    professionalism === null ||
    nextSteps === null
  ) {
    return null;
  }

  const bucketsAverage = (qualifying + pricing + bookingPush + professionalism + nextSteps) / 5;
  const overall = 0.4 * vibe + 0.6 * bucketsAverage;
  const rounded = Math.max(0, Math.min(100, Math.round(overall)));

  // Calibration guardrail:
  // - 70–85 = "good" typical call
  // - 86–89 = strong
  // - 90+ = near-perfect and should be rare
  // Enforce that high scores require consistently strong buckets (especially vibe).
  if (rounded >= 95) {
    const ok =
      vibe >= 94 &&
      qualifying >= 92 &&
      pricing >= 92 &&
      bookingPush >= 92 &&
      professionalism >= 94 &&
      nextSteps >= 92;
    return ok ? rounded : 94;
  }

  if (rounded >= 90) {
    const ok =
      vibe >= 90 &&
      qualifying >= 88 &&
      pricing >= 85 &&
      bookingPush >= 85 &&
      professionalism >= 90 &&
      nextSteps >= 88;
    return ok ? rounded : 89;
  }

  return rounded;
}

function normalizeCoachingOutput(raw: z.infer<typeof CoachingSchema>): Omit<CallCoachingResult, "model"> {
  const computedOverall = computeOverallFromBreakdown(raw.score_breakdown ?? null);
  const scoreOverall = computedOverall ?? Math.max(0, Math.min(100, Math.round(raw.score_overall)));

  const wins = raw.wins.slice(0, 3);
  const maxFixes = scoreOverall >= 90 ? 0 : scoreOverall >= 80 ? 1 : 3;
  const improvements = (raw.improvements ?? []).slice(0, maxFixes);

  if (scoreOverall >= 90 && wins.length === 0) {
    wins.push("Great job - keep doing what you're doing.");
  }

  const scoreBreakdown = raw.score_breakdown ?? null;
  return {
    scoreOverall,
    scoreBreakdown,
    wins,
    improvements
  };
}

function buildRubricPrompt(rubric: CallCoachingRubric): { rubricLabel: string; rubricCriteria: string } {
  if (rubric === "outbound") {
    return {
      rubricLabel: "Outbound cold call (B2B) coaching rubric",
      rubricCriteria: [
        "Score the salesperson's performance for cold outbound commercial outreach.",
        "Focus on: opener + permission to talk, value proposition, qualifying questions, handling objections/gatekeeper, clear next step (meeting/callback), professionalism and brevity.",
        "Do NOT judge based on whether the prospect was interested; judge the rep's process.",
        "A perfect call is concise, confident, and ends with a clear next step.",
        "",
        "Scoring calibration (be strict):",
        "- 70–85 = good, typical call that does the job but has minor friction.",
        "- 86–89 = strong call with only minor rough edges.",
        "- 90+ = near-perfect and should be rare (smooth flow, no rambling, crisp value, clean objection handling, clear next step).",
        "- 95+ = exceptional and extremely rare."
      ].join("\n")
    };
  }

  return {
    rubricLabel: "Inbound lead call (hot lead) coaching rubric",
    rubricCriteria: [
      "Score the salesperson's performance for an inbound lead calling for junk removal / services.",
      "Focus on: fast qualification (items, access, timeframe, ZIP), clear pricing/anchoring, booking push, handling objections, and setting the next step.",
      "Do NOT judge based on whether the customer booked; judge the rep's process.",
      "A perfect call ends with a scheduled appointment or a clear follow-up time with a reason.",
      "",
      "Scoring calibration (be strict):",
      "- 70–85 = good, typical call that gets the basics but has minor friction.",
      "- 86–89 = strong call with only minor rough edges.",
      "- 90+ = near-perfect and should be rare (smooth flow, no awkwardness, no repeating, clear anchor, confident booking push, clean next steps).",
      "- 95+ = exceptional and extremely rare."
    ].join("\n")
  };
}

export async function scoreCallTranscript(input: {
  transcript: string;
  agentName: string;
  businessName: string;
  rubric: CallCoachingRubric;
}): Promise<CallCoachingResult | null> {
  const apiKey = readEnvString("OPENAI_API_KEY");
  if (!apiKey) return null;

  const configuredModel = readEnvString("OPENAI_CALL_COACHING_MODEL");
  const model = configuredModel ?? "gpt-4.1-mini";

  const { rubricLabel, rubricCriteria } = buildRubricPrompt(input.rubric);

  const bucketDefinitions =
    input.rubric === "outbound"
      ? [
          "vibe: Overall confidence, tone, and control of the call.",
          "qualifying: Identified decision maker / fit (type of property, volume/frequency, current vendor, needs).",
          "pricing_clarity: Clear offer/value framing (not necessarily price), avoids rambling, sets expectations.",
          "booking_push: For outbound, this means asking for the next step (meeting/callback/email intro) at the right time.",
          "professionalism: Polite, concise, handles objections without arguing, respects time.",
          "next_steps: Ends with a concrete next step and timeframe (e.g., 'Can I call you Tuesday at 2pm?' or 'I'll email X and follow up tomorrow')."
        ].join("\n")
      : [
          "vibe: Overall confidence, friendliness, and control of the call.",
          "qualifying: Captures the essentials quickly (items, access, timeframe, ZIP/location).",
          "pricing_clarity: Gives a clear anchor/range and what it's based on; avoids confusing or contradictory pricing.",
          "booking_push: Appropriately moves toward booking when possible (offers slots or asks a booking question).",
          "professionalism: Polite, concise, doesn't repeat, listens and responds to what was said.",
          "next_steps: Ends with either a booked appointment OR a specific follow-up time + reason."
        ].join("\n");

  const systemPrompt = [
    "You are a strict call coach for a CRM.",
    "Return JSON only (no prose).",
    "",
    rubricLabel,
    rubricCriteria,
    "",
    "Scorecard buckets (required):",
    bucketDefinitions,
    "",
    "Important: Penalize roughness inside the vibe bucket.",
    "- Lower 'vibe' when the flow isn't smooth: awkward transitions, talking over, rambling, unclear phrasing, filler, repeating, or missing empathy.",
    "- Even if the rep collects all info, a rough delivery should not earn 90+.",
    "",
    "Output rules:",
    "- score_overall: integer 0-100",
    `- score_breakdown: required object with EXACTLY these keys: ${REQUIRED_BREAKDOWN_KEYS.join(", ")} (0-100 each)`,
    "- score_overall should be consistent with the breakdown (roughly a weighted blend of the buckets).",
    "- wins: 1-3 short bullets (what went well)",
    "- improvements: 0-3 short bullets (only if score_overall < 90)",
    "- Do not include any personally identifying info beyond first names."
  ].join("\n");

  const userPrompt = [
    `Business: ${input.businessName}`,
    `Salesperson: ${input.agentName}`,
    "",
    "Transcript:",
    input.transcript
  ].join("\n");

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      score_overall: { type: "number" },
      score_breakdown: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            properties: {
              vibe: { type: "number" },
              qualifying: { type: "number" },
              pricing_clarity: { type: "number" },
              booking_push: { type: "number" },
              professionalism: { type: "number" },
              next_steps: { type: "number" }
            },
            required: REQUIRED_BREAKDOWN_KEYS
          },
          { type: "null" }
        ]
      },
      wins: { type: "array", items: { type: "string" } },
      improvements: { type: "array", items: { type: "string" } }
    },
    required: ["score_overall", "score_breakdown", "wins", "improvements"]
  };

  const payload: Record<string, unknown> = {
    model,
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    max_output_tokens: 700,
    text: {
      verbosity: "medium",
      format: {
        type: "json_schema",
        name: "call_coaching",
        strict: true,
        schema
      }
    }
  };

  if (supportsReasoningEffort(model)) {
    payload["reasoning"] = { effort: "low" };
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    console.warn("[call.coaching] openai_failed", { model, status: response.status, bodyText: bodyText.slice(0, 240) });
    return null;
  }

  const data = (await response.json().catch(() => null)) as
    | { output_text?: unknown; output?: Array<{ content?: Array<{ text?: unknown }> }> }
    | null;

  const raw =
    (typeof data?.output_text === "string" ? data?.output_text : null) ??
    data?.output
      ?.flatMap((item) => item.content ?? [])
      .find((chunk) => typeof chunk.text === "string")
      ?.text ??
    null;

  if (typeof raw !== "string" || !raw.trim()) {
    console.warn("[call.coaching] empty_output", { model });
    return null;
  }

  let parsedJson: unknown = null;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    console.warn("[call.coaching] parse_failed", { model });
    return null;
  }

  const parsed = CoachingSchema.safeParse(parsedJson);
  if (!parsed.success) {
    console.warn("[call.coaching] schema_mismatch", { issues: parsed.error.issues.slice(0, 3) });
    return null;
  }

  const normalized = normalizeCoachingOutput(parsed.data);
  return { model, ...normalized };
}
