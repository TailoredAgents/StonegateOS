type OutboundDraftChannel = "sms" | "email";

export type OutboundFirstTouchDraft = {
  subject: string | null;
  body: string;
  model: string | null;
  provider: "openai" | "fallback";
};

function readEnvString(key: string): string | null {
  const value = process.env[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function resolveModel(): string {
  return (
    readEnvString("OPENAI_OUTBOUND_WRITE_MODEL") ??
    readEnvString("OPENAI_MODEL") ??
    "gpt-5-mini"
  );
}

function supportsReasoningEffort(targetModel: string): boolean {
  const normalized = targetModel.trim().toLowerCase();
  return normalized.startsWith("gpt-5") || normalized.startsWith("o");
}

function clampText(value: string, maxLen: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, maxLen - 1).trimEnd() + "…";
}

function fallbackDraft(input: {
  channel: OutboundDraftChannel;
  recipientName: string | null;
  company: string | null;
}): OutboundFirstTouchDraft {
  const who = input.recipientName?.trim().length ? input.recipientName.trim() : "there";
  const companyLine = input.company?.trim().length ? ` at ${input.company.trim()}` : "";
  if (input.channel === "email") {
    return {
      provider: "fallback",
      model: null,
      subject: "Quick question about haul-off",
      body:
        `Hi ${who}${companyLine} — this is Stonegate Junk Removal.\n\n` +
        "Do you handle any properties that need unit cleanouts, bulk pickup, or haul-off this month?\n\n" +
        "If so, what’s the best way to get you our info and availability?",
    };
  }

  return {
    provider: "fallback",
    model: null,
    subject: null,
    body: clampText(
      `Hi ${who}${companyLine} — this is Stonegate Junk Removal. Do you handle any properties that need unit cleanouts or haul-off this month? Reply STOP to opt out.`,
      320
    ),
  };
}

export async function generateOutboundFirstTouchDraft(input: {
  channel: OutboundDraftChannel;
  recipientName: string | null;
  company: string | null;
  campaign: string | null;
  attempt: number;
  notes: string | null;
}): Promise<OutboundFirstTouchDraft> {
  const apiKey = readEnvString("OPENAI_API_KEY");
  if (!apiKey) {
    return fallbackDraft(input);
  }

  const model = resolveModel();
  const toneRules =
    "Constraints:\n" +
    "- Tone: friendly, direct, professional. No emojis.\n" +
    "- Keep it short (email <= 900 chars, sms <= 320 chars).\n" +
    "- Mention Stonegate Junk Removal exactly once.\n" +
    "- Do NOT include pricing unless the recipient asked.\n" +
    "- Ask one clear question that makes it easy to reply.\n" +
    "- If channel is sms, end with: 'Reply STOP to opt out.'\n" +
    "- Output ONLY JSON with keys: subject, body.\n";

  const systemPrompt =
    "You write first-touch outbound messages for a local junk removal company.\n" +
    toneRules;

  const serviceCities =
    "Woodstock, Acworth, Kennesaw, Marietta, Canton, Roswell, Alpharetta (North Metro Atlanta, GA)";

  const userPrompt = [
    `Channel: ${input.channel}`,
    `Recipient name: ${input.recipientName ?? "Unknown"}`,
    `Recipient company: ${input.company ?? "Unknown"}`,
    `Campaign: ${input.campaign ?? "outbound"}`,
    `Attempt: ${input.attempt}`,
    input.notes ? `Notes: ${input.notes}` : null,
    `Service area cities: ${serviceCities}`,
    "Goal: start a conversation and get a reply about whether they have properties needing haul-off / cleanouts this month.",
  ]
    .filter(Boolean)
    .join("\n");

  const payload: Record<string, unknown> = {
    model,
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_output_tokens: 280,
    text: {
      verbosity: "low",
      format: {
        type: "json_schema",
        name: "outbound_first_touch",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            subject: { type: ["string", "null"] },
            body: { type: "string" },
          },
          required: ["subject", "body"],
        },
      },
    },
  };

  if (supportsReasoningEffort(model)) {
    payload["reasoning"] = { effort: "low" };
  }

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    const bodyText = await response.text().catch(() => "");
    if (!response.ok) {
      console.warn("[outbound.drafts] openai_failed", {
        model,
        status: response.status,
        body: bodyText.slice(0, 240),
      });
      return fallbackDraft(input);
    }

    const data = (() => {
      try {
        return JSON.parse(bodyText) as {
          output?: Array<{ content?: Array<{ text?: string }> }>;
        };
      } catch {
        return null;
      }
    })();

    const raw =
      data?.output
        ?.flatMap((item) => item.content ?? [])
        .find((item) => typeof item.text === "string")
        ?.text ?? null;

    if (!raw) {
      return fallbackDraft(input);
    }

    const parsed = (() => {
      try {
        return JSON.parse(raw) as { subject?: unknown; body?: unknown };
      } catch {
        return null;
      }
    })();

    const subjectRaw = parsed && typeof parsed.subject === "string" ? parsed.subject : null;
    const bodyRaw = parsed && typeof parsed.body === "string" ? parsed.body : null;
    if (!bodyRaw) return fallbackDraft(input);

    const maxBody = input.channel === "sms" ? 320 : 900;
    return {
      provider: "openai",
      model,
      subject: input.channel === "email" ? clampText(subjectRaw ?? "Quick question", 80) : null,
      body: clampText(bodyRaw, maxBody),
    };
  } catch (error) {
    console.warn("[outbound.drafts] openai_error", { model, error: String(error) });
    return fallbackDraft(input);
  }
}

