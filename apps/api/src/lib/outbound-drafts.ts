type OutboundDraftChannel = "sms" | "email";

export type OutboundDraftContextMessage = {
  direction: string;
  channel: string;
  subject: string | null;
  body: string;
  createdAt: string;
};

export type OutboundDraft = {
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

function formatRecentContactHistory(messages: OutboundDraftContextMessage[] | null | undefined): string | null {
  if (!messages?.length) return null;

  const lines = messages.slice(-10).map((message) => {
    const subject = message.subject?.trim().length ? ` subject="${clampText(message.subject, 80)}"` : "";
    return [
      `${message.createdAt} ${message.channel} ${message.direction}${subject}:`,
      clampText(message.body.replace(/\s+/g, " "), 220),
    ].join(" ");
  });

  return ["Recent actual contact history (oldest to newest):", ...lines].join("\n");
}

function fallbackFirstTouchDraft(input: {
  channel: OutboundDraftChannel;
  recipientName: string | null;
  company: string | null;
}): OutboundDraft {
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

function fallbackFollowupDraft(input: {
  channel: OutboundDraftChannel;
  recipientName: string | null;
  company: string | null;
  disposition?: string | null;
  recap?: string | null;
}): OutboundDraft {
  const who = input.recipientName?.trim().length ? input.recipientName.trim() : "there";
  const companyLine = input.company?.trim().length ? ` at ${input.company.trim()}` : "";
  const disposition = input.disposition?.trim().toLowerCase() ?? "";

  if (input.channel === "email") {
    const body =
      disposition === "email_sent"
        ? `Hi ${who}${companyLine}, just following up in case my last note got buried. If you ever need help with cleanouts, bulk pickup, or haul-off, I can send over our info and availability.`
        : disposition === "connected"
          ? `Hi ${who}${companyLine}, good talking with you. If helpful, I can send a short overview of how we handle cleanouts and fast pickup for local properties.`
          : `Hi ${who}${companyLine}, following up on my last note. If you ever run into a property that needs haul-off or a cleanout, I’d be glad to be a backup option.`;
    return {
      provider: "fallback",
      model: null,
      subject: "Quick follow-up",
      body: clampText(body, 900),
    };
  }

  const body =
    disposition === "connected"
      ? `Good talking with you ${who}. If it helps, I can text over a quick summary of how we handle cleanouts and fast pickup when something comes up. Reply STOP to opt out.`
      : disposition === "left_voicemail"
        ? `Hi ${who}${companyLine} - just following up on my voicemail. If you ever need help with a cleanout or haul-off, I’d be glad to be a backup option. Reply STOP to opt out.`
        : disposition === "email_sent"
          ? `Hi ${who}${companyLine} - just making sure my email did not get buried. Do you ever need help with property cleanouts or haul-off? Reply STOP to opt out.`
          : `Hi ${who}${companyLine} - just following up in case you ever need help with a cleanout or haul-off. Reply STOP to opt out.`;

  const withRecap =
    input.recap?.trim().length && disposition === "connected"
      ? `${body} ${clampText(input.recap, 110)}`
      : body;

  return {
    provider: "fallback",
    model: null,
    subject: null,
    body: clampText(withRecap, 320),
  };
}

async function generateOpenAiDraft(input: {
  model: string;
  apiKey: string;
  schemaName: string;
  systemPrompt: string;
  userPrompt: string;
}): Promise<{ subject: string | null; body: string } | null> {
  const payload: Record<string, unknown> = {
    model: input.model,
    input: [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.userPrompt },
    ],
    max_output_tokens: 280,
    text: {
      verbosity: "low",
      format: {
        type: "json_schema",
        name: input.schemaName,
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

  if (supportsReasoningEffort(input.model)) {
    payload["reasoning"] = { effort: "low" };
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const bodyText = await response.text().catch(() => "");
  if (!response.ok) {
    console.warn("[outbound.drafts] openai_failed", {
      model: input.model,
      status: response.status,
      body: bodyText.slice(0, 240),
    });
    return null;
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

  if (!raw) return null;

  const parsed = (() => {
    try {
      return JSON.parse(raw) as { subject?: unknown; body?: unknown };
    } catch {
      return null;
    }
  })();

  const subjectRaw = parsed && typeof parsed.subject === "string" ? parsed.subject : null;
  const bodyRaw = parsed && typeof parsed.body === "string" ? parsed.body : null;
  if (!bodyRaw) return null;

  return { subject: subjectRaw, body: bodyRaw };
}

export async function generateOutboundFirstTouchDraft(input: {
  channel: OutboundDraftChannel;
  recipientName: string | null;
  company: string | null;
  campaign: string | null;
  attempt: number;
  notes: string | null;
  segment?: string | null;
  city?: string | null;
  state?: string | null;
  recentMessages?: OutboundDraftContextMessage[];
}): Promise<OutboundDraft> {
  const apiKey = readEnvString("OPENAI_API_KEY");
  if (!apiKey) {
    return fallbackFirstTouchDraft(input);
  }

  const model = resolveModel();
  const toneRules =
    "Constraints:\n" +
    "- Tone: friendly, direct, professional. No emojis.\n" +
    "- Keep it short (email <= 900 chars, sms <= 320 chars).\n" +
    "- Mention Stonegate Junk Removal exactly once.\n" +
    "- Do NOT include pricing unless the recipient asked.\n" +
    "- Ask one clear question that makes it easy to reply.\n" +
    "- If recent contact history exists, continue naturally from it instead of acting like this is the first contact.\n" +
    "- Do not mention internal notes, campaigns, attempts, CRM tasks, or AI.\n" +
    "- If channel is sms, end with: 'Reply STOP to opt out.'\n" +
    "- Output ONLY JSON with keys: subject, body.\n";

  const systemPrompt =
    "You write salesperson-requested outbound message suggestions for a local junk removal company.\n" +
    toneRules;

  const serviceCities =
    "Woodstock, Acworth, Kennesaw, Marietta, Canton, Roswell, Alpharetta (North Metro Atlanta, GA)";

  const userPrompt = [
    `Channel: ${input.channel}`,
    `Recipient name: ${input.recipientName ?? "Unknown"}`,
    `Recipient company: ${input.company ?? "Unknown"}`,
    input.segment ? `Account segment: ${input.segment}` : null,
    input.city || input.state
      ? `Account location: ${[input.city ?? null, input.state ?? null].filter(Boolean).join(", ")}`
      : null,
    `Campaign: ${input.campaign ?? "outbound"}`,
    `Attempt: ${input.attempt}`,
    input.notes ? `Notes: ${input.notes}` : null,
    formatRecentContactHistory(input.recentMessages),
    `Service area cities: ${serviceCities}`,
    "Goal: help the salesperson send the best next message and get a reply about whether they have properties needing haul-off / cleanouts this month.",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const generated = await generateOpenAiDraft({
      model,
      apiKey,
      schemaName: "outbound_first_touch",
      systemPrompt,
      userPrompt,
    });
    if (!generated) return fallbackFirstTouchDraft(input);

    const maxBody = input.channel === "sms" ? 320 : 900;
    return {
      provider: "openai",
      model,
      subject:
        input.channel === "email"
          ? clampText(generated.subject ?? "Quick question", 80)
          : null,
      body: clampText(generated.body, maxBody),
    };
  } catch (error) {
    console.warn("[outbound.drafts] openai_error", { model, error: String(error) });
    return fallbackFirstTouchDraft(input);
  }
}

export async function generateOutboundFollowupDraft(input: {
  channel: OutboundDraftChannel;
  recipientName: string | null;
  company: string | null;
  campaign: string | null;
  attempt: number;
  notes: string | null;
  segment?: string | null;
  city?: string | null;
  state?: string | null;
  disposition?: string | null;
  recap?: string | null;
  recentMessages?: OutboundDraftContextMessage[];
}): Promise<OutboundDraft> {
  const apiKey = readEnvString("OPENAI_API_KEY");
  if (!apiKey) {
    return fallbackFollowupDraft(input);
  }

  const model = resolveModel();
  const toneRules =
    "Constraints:\n" +
    "- Tone: friendly, direct, local, practical. No emojis.\n" +
    "- Keep it short (email <= 900 chars, sms <= 320 chars).\n" +
    "- Mention Stonegate Junk Removal exactly once.\n" +
    "- This is a follow-up after real outreach, not a cold opener.\n" +
    "- Do not sound spammy, mass-market, or overly polished.\n" +
    "- If there was a real conversation, lightly pick up from it.\n" +
    "- Ask at most one clear next-step question.\n" +
    "- Use recent contact history and the salesperson recap as the source of truth.\n" +
    "- Do not mention internal notes, campaigns, attempts, CRM tasks, or AI.\n" +
    "- If channel is sms, end with: 'Reply STOP to opt out.'\n" +
    "- Output ONLY JSON with keys: subject, body.\n";

  const systemPrompt =
    "You write short outbound follow-up messages for a local junk removal company.\n" +
    toneRules;

  const serviceCities =
    "Woodstock, Acworth, Kennesaw, Marietta, Canton, Roswell, Alpharetta (North Metro Atlanta, GA)";

  const userPrompt = [
    `Channel: ${input.channel}`,
    `Recipient name: ${input.recipientName ?? "Unknown"}`,
    `Recipient company: ${input.company ?? "Unknown"}`,
    input.segment ? `Account segment: ${input.segment}` : null,
    input.city || input.state
      ? `Account location: ${[input.city ?? null, input.state ?? null].filter(Boolean).join(", ")}`
      : null,
    `Campaign: ${input.campaign ?? "outbound"}`,
    `Attempt: ${input.attempt}`,
    input.disposition ? `Latest outcome: ${input.disposition}` : null,
    input.recap ? `Salesperson recap: ${input.recap}` : null,
    input.notes ? `Notes: ${input.notes}` : null,
    formatRecentContactHistory(input.recentMessages),
    `Service area cities: ${serviceCities}`,
    "Goal: send the right next touch after the latest outbound outcome and keep the conversation moving without sounding pushy.",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const generated = await generateOpenAiDraft({
      model,
      apiKey,
      schemaName: "outbound_follow_up",
      systemPrompt,
      userPrompt,
    });
    if (!generated) return fallbackFollowupDraft(input);

    const maxBody = input.channel === "sms" ? 320 : 900;
    return {
      provider: "openai",
      model,
      subject:
        input.channel === "email"
          ? clampText(generated.subject ?? "Quick follow-up", 80)
          : null,
      body: clampText(generated.body, maxBody),
    };
  } catch (error) {
    console.warn("[outbound.drafts] openai_error", { model, error: String(error) });
    return fallbackFollowupDraft(input);
  }
}
