import { z } from "zod";

export type CallExtracted = {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  postalCode?: string | null;
  timeframe?: string | null;
  items?: string | null;
  confidence?: Record<string, number | null> | null;
};

export type CallAnalysis = {
  summary: string;
  coaching: string[];
  extracted: CallExtracted;
};

function supportsReasoningEffort(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized.startsWith("gpt-5") || normalized.startsWith("o");
}

function readEnvString(key: string): string | null {
  const value = process.env[key];
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function getOpenAIKey(): string | null {
  const key = readEnvString("OPENAI_API_KEY");
  return key ?? null;
}

export async function transcribeAudioMp3(buffer: Buffer): Promise<string | null> {
  const apiKey = getOpenAIKey();
  if (!apiKey) return null;

  const form = new FormData();
  form.append("model", "whisper-1");
  form.append("file", new Blob([new Uint8Array(buffer)], { type: "audio/mpeg" }), "call.mp3");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: form
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.warn("[call.transcribe] openai_failed", { status: response.status, text: text.slice(0, 240) });
    return null;
  }

  const payload = (await response.json().catch(() => null)) as { text?: unknown } | null;
  const transcript = typeof payload?.text === "string" ? payload.text.trim() : "";
  return transcript.length ? transcript : null;
}

const AnalysisSchema = z.object({
  summary: z.string().min(20).max(2000),
  coaching: z.array(z.string().min(3).max(220)).min(1).max(8),
  extracted: z.object({
    firstName: z.string().min(1).max(60).nullable().optional(),
    lastName: z.string().min(1).max(60).nullable().optional(),
    email: z.string().min(3).max(120).nullable().optional(),
    postalCode: z.string().min(2).max(16).nullable().optional(),
    timeframe: z.string().min(2).max(120).nullable().optional(),
    items: z.string().min(2).max(500).nullable().optional(),
    confidence: z
      .object({
        firstName: z.number().min(0).max(1).nullable(),
        lastName: z.number().min(0).max(1).nullable(),
        email: z.number().min(0).max(1).nullable(),
        postalCode: z.number().min(0).max(1).nullable(),
        timeframe: z.number().min(0).max(1).nullable(),
        items: z.number().min(0).max(1).nullable()
      })
      .nullable()
      .optional()
  })
});

export async function analyzeCallTranscript(input: {
  transcript: string;
  agentName: string;
  businessName: string;
}): Promise<CallAnalysis | null> {
  const apiKey = getOpenAIKey();
  if (!apiKey) return null;

  const model = readEnvString("OPENAI_CALL_ANALYSIS_MODEL") ?? "gpt-5-mini";

  const systemPrompt = [
    "You are a sales call analyst for a home-services CRM.",
    "Your job is to summarize the call, extract key customer details, and give coaching to improve close rate.",
    "",
    "Return JSON only (no prose)."
  ].join("\n");

  const userPrompt = [
    `Business: ${input.businessName}`,
    `Salesperson: ${input.agentName}`,
    "",
    "Transcript:",
    input.transcript,
    "",
    "Output requirements:",
    "- summary: a tight internal summary of what happened and next step",
    "- coaching: 2 to 6 bullets (internal coaching, specific)",
    "- extracted: best-effort structured fields (nullable when unknown)",
    "- extracted.confidence: numbers 0 to 1 for fields you are confident about (e.g. firstName, lastName, email, postalCode)"
  ].join("\n");

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: { type: "string" },
      coaching: { type: "array", items: { type: "string" } },
      extracted: {
        type: "object",
        additionalProperties: false,
        properties: {
          firstName: { anyOf: [{ type: "string" }, { type: "null" }] },
          lastName: { anyOf: [{ type: "string" }, { type: "null" }] },
          email: { anyOf: [{ type: "string" }, { type: "null" }] },
          postalCode: { anyOf: [{ type: "string" }, { type: "null" }] },
          timeframe: { anyOf: [{ type: "string" }, { type: "null" }] },
          items: { anyOf: [{ type: "string" }, { type: "null" }] },
          confidence: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  firstName: { anyOf: [{ type: "number" }, { type: "null" }] },
                  lastName: { anyOf: [{ type: "number" }, { type: "null" }] },
                  email: { anyOf: [{ type: "number" }, { type: "null" }] },
                  postalCode: { anyOf: [{ type: "number" }, { type: "null" }] },
                  timeframe: { anyOf: [{ type: "number" }, { type: "null" }] },
                  items: { anyOf: [{ type: "number" }, { type: "null" }] }
                },
                required: ["firstName", "lastName", "email", "postalCode", "timeframe", "items"]
              },
              { type: "null" }
            ]
          }
        },
        required: ["firstName", "lastName", "email", "postalCode", "timeframe", "items", "confidence"]
      }
    },
    required: ["summary", "coaching", "extracted"]
  };

  const payload: Record<string, unknown> = {
    model,
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    max_output_tokens: 900,
    text: {
      verbosity: "medium",
      format: {
        type: "json_schema",
        name: "call_analysis",
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
    console.warn("[call.analysis] openai_failed", { model, status: response.status, bodyText: bodyText.slice(0, 240) });
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
    console.warn("[call.analysis] empty_output", { model });
    return null;
  }

  let parsedJson: unknown = null;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    console.warn("[call.analysis] parse_failed", { model });
    return null;
  }

  const parsed = AnalysisSchema.safeParse(parsedJson);
  if (!parsed.success) {
    console.warn("[call.analysis] schema_mismatch", { issues: parsed.error.issues.slice(0, 3) });
    return null;
  }

  return parsed.data;
}
