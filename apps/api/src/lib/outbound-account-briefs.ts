import { and, desc, eq } from "drizzle-orm";
import { contacts, crmTasks, getDb, partnerAccounts } from "@/db";

export type OutboundAccountBrief = {
  summary: string;
  whyFit: string;
  serviceAngle: string;
  bestOpener: string;
  likelyObjections: string[];
  recommendedNextMove: string;
  partnerFit: "portal_first" | "managed_direct" | "hybrid" | "not_a_fit";
  fitScore: number;
  fitReason: string;
  provider: "openai" | "fallback";
  model: string | null;
  updatedAt: string;
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

function cleanText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function clampText(value: string, maxLen: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, maxLen - 3).trimEnd()}...`;
}

function safeArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 4);
}

function chooseServiceAngle(segment: string | null, campaign: string | null): string {
  const normalizedSegment = segment?.trim().toLowerCase() ?? "";
  const normalizedCampaign = campaign?.trim().toLowerCase() ?? "";

  if (normalizedSegment.includes("property")) {
    return "unit cleanouts, turnover haul-off, and bulk pickup for vacant units";
  }
  if (normalizedSegment.includes("realtor") || normalizedSegment.includes("real estate")) {
    return "listing cleanups, pre-sale haul-off, and seller cleanout help";
  }
  if (normalizedSegment.includes("estate")) {
    return "estate cleanouts, donation-load support, and last-minute haul-off";
  }
  if (normalizedSegment.includes("contractor")) {
    return "jobsite debris removal, final cleanouts, and light demo haul-off";
  }
  if (normalizedSegment.includes("investor") || normalizedSegment.includes("flipper")) {
    return "flip cleanouts, debris removal, and fast turnaround between projects";
  }
  if (normalizedCampaign.includes("property")) {
    return "cleanouts, tenant-turn haul-off, and bulk pickup";
  }

  return "haul-off, cleanouts, and fast local pickup support";
}

function fallbackBrief(input: {
  accountName: string;
  segment: string | null;
  campaign: string | null;
  city: string | null;
  state: string | null;
  contacts: Array<{ name: string; email: string | null; phone: string | null }>;
}): OutboundAccountBrief {
  const location = [input.city, input.state].filter(Boolean).join(", ");
  const primaryContact = input.contacts[0]?.name ?? "their team";
  const serviceAngle = chooseServiceAngle(input.segment, input.campaign);
  const audience =
    input.segment?.trim().length
      ? input.segment.trim().replace(/_/g, " ")
      : "local referral partner";

  return {
    summary: clampText(
      `${input.accountName} looks like a ${audience}${location ? ` in ${location}` : ""}. Start with a practical referral conversation, not a hard pitch.`,
      220,
    ),
    whyFit: clampText(
      `They could send recurring cleanup or pickup work if they regularly handle properties, listings, or transitions.`,
      180,
    ),
    serviceAngle: clampText(
      `Lead with ${serviceAngle}. Keep it local and make fast scheduling feel easy.`,
      180,
    ),
    bestOpener: clampText(
      `Hi ${primaryContact} - this is Stonegate Junk Removal. Do you ever need help with ${serviceAngle} on short notice?`,
      180,
    ),
    likelyObjections: [
      "We already have someone.",
      "We do not have enough volume right now.",
      "Email me your info.",
    ],
    recommendedNextMove: clampText(
      "Call first if a phone number exists, then send a short follow-up with one clear question and a simple referral angle.",
      180,
    ),
    partnerFit: "managed_direct",
    fitScore: 64,
    fitReason: clampText(
      "This looks more like a relationship to develop directly first, then move into portal use if they start sending repeat work.",
      180,
    ),
    provider: "fallback",
    model: null,
    updatedAt: new Date().toISOString(),
  };
}

function parseStoredBrief(value: unknown): OutboundAccountBrief | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const summary = cleanText(typeof record["summary"] === "string" ? record["summary"] : null);
  const whyFit = cleanText(typeof record["whyFit"] === "string" ? record["whyFit"] : null);
  const serviceAngle = cleanText(
    typeof record["serviceAngle"] === "string" ? record["serviceAngle"] : null,
  );
  const bestOpener = cleanText(
    typeof record["bestOpener"] === "string" ? record["bestOpener"] : null,
  );
  const recommendedNextMove = cleanText(
    typeof record["recommendedNextMove"] === "string"
      ? record["recommendedNextMove"]
      : null,
  );
  const partnerFitRaw =
    typeof record["partnerFit"] === "string" ? record["partnerFit"] : null;
  const partnerFit =
    partnerFitRaw === "portal_first" ||
    partnerFitRaw === "managed_direct" ||
    partnerFitRaw === "hybrid" ||
    partnerFitRaw === "not_a_fit"
      ? partnerFitRaw
      : null;
  const fitScoreRaw =
    typeof record["fitScore"] === "number"
      ? record["fitScore"]
      : typeof record["fitScore"] === "string"
        ? Number(record["fitScore"])
        : null;
  const fitScore =
    typeof fitScoreRaw === "number" && Number.isFinite(fitScoreRaw)
      ? Math.max(0, Math.min(100, Math.round(fitScoreRaw)))
      : null;
  const fitReason = cleanText(
    typeof record["fitReason"] === "string" ? record["fitReason"] : null,
  );
  const provider =
    record["provider"] === "openai"
      ? "openai"
      : record["provider"] === "fallback"
        ? "fallback"
        : null;
  const updatedAt = cleanText(
    typeof record["updatedAt"] === "string" ? record["updatedAt"] : null,
  );

  if (
    !summary ||
    !whyFit ||
    !serviceAngle ||
    !bestOpener ||
    !recommendedNextMove ||
    !partnerFit ||
    fitScore === null ||
    !fitReason ||
    !provider ||
    !updatedAt
  ) {
    return null;
  }

  return {
    summary,
    whyFit,
    serviceAngle,
    bestOpener,
    likelyObjections: safeArray(record["likelyObjections"]),
    recommendedNextMove,
    partnerFit,
    fitScore,
    fitReason,
    provider,
    model: cleanText(typeof record["model"] === "string" ? record["model"] : null),
    updatedAt,
  };
}

function isFreshBrief(brief: OutboundAccountBrief | null): boolean {
  if (!brief) return false;
  const parsed = Date.parse(brief.updatedAt);
  if (Number.isNaN(parsed)) return false;
  return Date.now() - parsed < 1000 * 60 * 60 * 24 * 7;
}

async function generateOpenAiBrief(input: {
  accountName: string;
  segment: string | null;
  campaign: string | null;
  sourceListName: string | null;
  city: string | null;
  state: string | null;
  notes: string | null;
  status: string;
  lastDisposition: string | null;
  lastTouchAt: string | null;
  nextTouchAt: string | null;
  contacts: Array<{ name: string; email: string | null; phone: string | null }>;
}): Promise<OutboundAccountBrief | null> {
  const apiKey = readEnvString("OPENAI_API_KEY");
  if (!apiKey) return null;

  const model = resolveModel();
  const payload: Record<string, unknown> = {
    model,
    input: [
      {
        role: "system",
        content:
          "You are an outbound partner-development copilot for a local junk removal company. " +
          "Write a short prep brief for a human rep. Keep it practical, local, and relationship-first. " +
          "Do not sound corporate. Output only JSON.",
      },
      {
        role: "user",
        content: [
          `Account: ${input.accountName}`,
          input.segment ? `Segment: ${input.segment}` : null,
          input.campaign ? `Campaign: ${input.campaign}` : null,
          input.sourceListName ? `Source list: ${input.sourceListName}` : null,
          input.city || input.state
            ? `Location: ${[input.city, input.state].filter(Boolean).join(", ")}`
            : null,
          `Status: ${input.status}`,
          input.lastDisposition ? `Last disposition: ${input.lastDisposition}` : null,
          input.lastTouchAt ? `Last touch: ${input.lastTouchAt}` : null,
          input.nextTouchAt ? `Next touch: ${input.nextTouchAt}` : null,
          input.notes ? `Notes: ${input.notes}` : null,
          input.contacts.length
            ? `Known contacts: ${input.contacts
                .map((contact) =>
                  [
                    contact.name,
                    contact.email ? `email ${contact.email}` : null,
                    contact.phone ? `phone ${contact.phone}` : null,
                  ]
                    .filter(Boolean)
                    .join(", "),
                )
                .join(" | ")}`
            : "Known contacts: none",
          "Return JSON with keys: summary, whyFit, serviceAngle, bestOpener, likelyObjections, recommendedNextMove.",
          "Also return partnerFit, fitScore, fitReason.",
          "partnerFit must be one of: portal_first, managed_direct, hybrid, not_a_fit.",
          "fitScore must be an integer 0 to 100.",
          "Each field should be concise. likelyObjections should be an array of 2 to 4 short strings.",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
    max_output_tokens: 360,
    text: {
      verbosity: "low",
      format: {
        type: "json_schema",
        name: "outbound_account_brief",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            summary: { type: "string" },
            whyFit: { type: "string" },
            serviceAngle: { type: "string" },
            bestOpener: { type: "string" },
            likelyObjections: {
              type: "array",
              items: { type: "string" },
              minItems: 2,
              maxItems: 4,
            },
            recommendedNextMove: { type: "string" },
            partnerFit: {
              type: "string",
              enum: ["portal_first", "managed_direct", "hybrid", "not_a_fit"],
            },
            fitScore: { type: "integer", minimum: 0, maximum: 100 },
            fitReason: { type: "string" },
          },
          required: [
            "summary",
            "whyFit",
            "serviceAngle",
            "bestOpener",
            "likelyObjections",
            "recommendedNextMove",
            "partnerFit",
            "fitScore",
            "fitReason",
          ],
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
      console.warn("[outbound.account_briefs] openai_failed", {
        model,
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
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return null;
      }
    })();

    if (!parsed) return null;

    const summary = cleanText(typeof parsed["summary"] === "string" ? parsed["summary"] : null);
    const whyFit = cleanText(typeof parsed["whyFit"] === "string" ? parsed["whyFit"] : null);
    const serviceAngle = cleanText(
      typeof parsed["serviceAngle"] === "string" ? parsed["serviceAngle"] : null,
    );
    const bestOpener = cleanText(
      typeof parsed["bestOpener"] === "string" ? parsed["bestOpener"] : null,
    );
    const recommendedNextMove = cleanText(
      typeof parsed["recommendedNextMove"] === "string"
        ? parsed["recommendedNextMove"]
        : null,
    );
    const partnerFitRaw =
      typeof parsed["partnerFit"] === "string" ? parsed["partnerFit"] : null;
    const partnerFit =
      partnerFitRaw === "portal_first" ||
      partnerFitRaw === "managed_direct" ||
      partnerFitRaw === "hybrid" ||
      partnerFitRaw === "not_a_fit"
        ? partnerFitRaw
        : null;
    const fitScoreRaw =
      typeof parsed["fitScore"] === "number"
        ? parsed["fitScore"]
        : typeof parsed["fitScore"] === "string"
          ? Number(parsed["fitScore"])
          : null;
    const fitScore =
      typeof fitScoreRaw === "number" && Number.isFinite(fitScoreRaw)
        ? Math.max(0, Math.min(100, Math.round(fitScoreRaw)))
        : null;
    const fitReason = cleanText(
      typeof parsed["fitReason"] === "string" ? parsed["fitReason"] : null,
    );
    const likelyObjections = safeArray(parsed["likelyObjections"]);

    if (
      !summary ||
      !whyFit ||
      !serviceAngle ||
      !bestOpener ||
      !recommendedNextMove ||
      !partnerFit ||
      fitScore === null ||
      !fitReason ||
      likelyObjections.length < 2
    ) {
      return null;
    }

    return {
      summary: clampText(summary, 220),
      whyFit: clampText(whyFit, 180),
      serviceAngle: clampText(serviceAngle, 180),
      bestOpener: clampText(bestOpener, 180),
      likelyObjections: likelyObjections.map((item) => clampText(item, 100)),
      recommendedNextMove: clampText(recommendedNextMove, 180),
      partnerFit,
      fitScore,
      fitReason: clampText(fitReason, 180),
      provider: "openai",
      model,
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.warn("[outbound.account_briefs] openai_error", {
      model,
      error: String(error),
    });
    return null;
  }
}

export async function ensureOutboundAccountBrief(input: {
  partnerAccountId: string;
}): Promise<OutboundAccountBrief | null> {
  const db = getDb();

  const [account] = await db
    .select({
      id: partnerAccounts.id,
      name: partnerAccounts.name,
      segment: partnerAccounts.segment,
      status: partnerAccounts.status,
      sourceCampaign: partnerAccounts.sourceCampaign,
      sourceListName: partnerAccounts.sourceListName,
      city: partnerAccounts.city,
      state: partnerAccounts.state,
      portalFit: partnerAccounts.portalFit,
      fitScore: partnerAccounts.fitScore,
      lastDisposition: partnerAccounts.lastDisposition,
      lastTouchAt: partnerAccounts.lastTouchAt,
      nextTouchAt: partnerAccounts.nextTouchAt,
      notes: partnerAccounts.notes,
      aiAccountBrief: partnerAccounts.aiAccountBrief,
    })
    .from(partnerAccounts)
    .where(eq(partnerAccounts.id, input.partnerAccountId))
    .limit(1);

  if (!account?.id) return null;

  const storedBrief = parseStoredBrief(account.aiAccountBrief);
  if (isFreshBrief(storedBrief)) return storedBrief;

  const contactRows = await db
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      phoneE164: contacts.phoneE164,
      phone: contacts.phone,
    })
    .from(contacts)
    .where(eq(contacts.partnerAccountId, account.id))
    .limit(5);

  const taskRows = await db
    .select({
      title: crmTasks.title,
      notes: crmTasks.notes,
      dueAt: crmTasks.dueAt,
      createdAt: crmTasks.createdAt,
    })
    .from(crmTasks)
    .where(and(eq(crmTasks.partnerAccountId, account.id), eq(crmTasks.status, "open")))
    .orderBy(desc(crmTasks.dueAt), desc(crmTasks.createdAt))
    .limit(3);

  const briefInput = {
    accountName: account.name,
    segment: cleanText(account.segment),
    campaign: cleanText(account.sourceCampaign),
    sourceListName: cleanText(account.sourceListName),
    city: cleanText(account.city),
    state: cleanText(account.state),
    notes: cleanText(
      [cleanText(account.notes), ...taskRows.map((task) => cleanText(task.notes))]
        .filter(Boolean)
        .join(" | "),
    ),
    status: account.status,
    lastDisposition: cleanText(account.lastDisposition),
    lastTouchAt:
      account.lastTouchAt instanceof Date ? account.lastTouchAt.toISOString() : null,
    nextTouchAt:
      account.nextTouchAt instanceof Date ? account.nextTouchAt.toISOString() : null,
    contacts: contactRows.map((contact) => ({
      name:
        [cleanText(contact.firstName), cleanText(contact.lastName)]
          .filter(Boolean)
          .join(" ")
          .trim() || "Contact",
      email: cleanText(contact.email),
      phone: cleanText(contact.phoneE164) ?? cleanText(contact.phone),
    })),
  };

  const brief =
    (await generateOpenAiBrief(briefInput)) ??
    fallbackBrief({
      accountName: briefInput.accountName,
      segment: briefInput.segment,
      campaign: briefInput.campaign,
      city: briefInput.city,
      state: briefInput.state,
      contacts: briefInput.contacts,
    });

  await db
    .update(partnerAccounts)
    .set({
      portalFit: brief.partnerFit,
      fitScore: brief.fitScore,
      aiAccountBrief: brief,
      updatedAt: new Date(),
    })
    .where(eq(partnerAccounts.id, account.id));

  return brief;
}
