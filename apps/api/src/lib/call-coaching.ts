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

function normalizeCoachingOutput(raw: z.infer<typeof CoachingSchema>): Omit<CallCoachingResult, "model"> {
  const scoreOverall = Math.max(0, Math.min(100, Math.round(raw.score_overall)));

  const wins = raw.wins.slice(0, 3);
  const maxFixes = scoreOverall >= 90 ? 0 : scoreOverall >= 80 ? 1 : 3;
  const improvements = (raw.improvements ?? []).slice(0, maxFixes);

  if (scoreOverall >= 90 && wins.length === 0) {
    wins.push("Great job — keep doing what you're doing.");
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
        "A perfect call is concise, confident, and ends with a clear next step."
      ].join("\n")
    };
  }

  return {
    rubricLabel: "Inbound lead call (hot lead) coaching rubric",
    rubricCriteria: [
      "Score the salesperson's performance for an inbound lead calling for junk removal / services.",
      "Focus on: fast qualification (items, access, timeframe, ZIP), clear pricing/anchoring, booking push, handling objections, and setting the next step.",
      "Do NOT judge based on whether the customer booked; judge the rep's process.",
      "A perfect call ends with a scheduled appointment or a clear follow-up time with a reason."
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

  const systemPrompt = [
    "You are a strict call coach for a CRM.",
    "Return JSON only (no prose).",
    "",
    rubricLabel,
    rubricCriteria,
    "",
    "Output rules:",
    "- score_overall: integer 0-100",
    "- score_breakdown: 4-6 categories with 0-100 scores (optional)",
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
            additionalProperties: { type: "number" }
          },
          { type: "null" }
        ]
      },
      wins: { type: "array", items: { type: "string" } },
      improvements: { type: "array", items: { type: "string" } }
    },
    required: ["score_overall", "wins", "improvements"]
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

