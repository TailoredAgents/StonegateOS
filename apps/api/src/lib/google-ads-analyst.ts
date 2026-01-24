import { z } from "zod";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import {
  getDb,
  googleAdsAnalystRecommendations,
  googleAdsAnalystReports,
  googleAdsCampaignConversionsDaily,
  googleAdsConversionActions,
  googleAdsInsightsDaily,
  googleAdsSearchTermsDaily
} from "@/db";
import { getGoogleAdsAnalystPolicy } from "@/lib/policy";
import { getCompanyProfilePolicy } from "@/lib/policy";

type ConversionClass = "call" | "booking" | "other";
type NegativeTier = "A" | "B";
type NegativeMatchType = "broad" | "phrase" | "exact";

export type GoogleAdsAnalystRunResult =
  | { ok: true; reportId: string; createdAt: string }
  | { ok: false; error: string; detail?: string | null };

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-5-mini";

const AnalystReportSchema = z.object({
  summary: z.string().min(20).max(1600),
  top_actions: z.array(z.string().min(5).max(220)).min(3).max(10),
  negatives_to_review: z.array(z.string().min(1).max(140)).max(50),
  pause_candidates_to_review: z.array(z.string().min(1).max(140)).max(50),
  notes: z.string().min(0).max(1200)
});

const OUT_OF_AREA_STATES = [
  "alabama",
  "alaska",
  "arizona",
  "arkansas",
  "california",
  "colorado",
  "connecticut",
  "delaware",
  "florida",
  "hawaii",
  "idaho",
  "illinois",
  "indiana",
  "iowa",
  "kansas",
  "kentucky",
  "louisiana",
  "maine",
  "maryland",
  "massachusetts",
  "michigan",
  "minnesota",
  "mississippi",
  "missouri",
  "montana",
  "nebraska",
  "nevada",
  "new hampshire",
  "new jersey",
  "new mexico",
  "new york",
  "north carolina",
  "north dakota",
  "ohio",
  "oklahoma",
  "oregon",
  "pennsylvania",
  "rhode island",
  "south carolina",
  "south dakota",
  "tennessee",
  "texas",
  "utah",
  "vermont",
  "virginia",
  "washington",
  "west virginia",
  "wisconsin",
  "wyoming"
];

function inferNegativeMatchType(term: string, tier: NegativeTier): NegativeMatchType {
  const normalized = term.trim();
  if (tier === "A" && /\s/.test(normalized)) return "phrase";
  if (tier === "A" && normalized.length <= 25 && !/\s/.test(normalized)) return "broad";
  if (/\s/.test(normalized)) return "phrase";
  return "broad";
}

function formatNegativeTerm(term: string, matchType: NegativeMatchType): string {
  const normalized = term.trim();
  if (!normalized) return "";
  if (matchType === "exact") return `[${normalized}]`;
  if (matchType === "phrase") return `"${normalized}"`;
  return normalized;
}

function normalizeNegativeKey(term: string, matchType: NegativeMatchType): string {
  let normalized = term.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) normalized = normalized.slice(1, -1).trim();
  if (normalized.startsWith("\"") && normalized.endsWith("\"")) normalized = normalized.slice(1, -1).trim();
  return `${matchType}:${normalized}`;
}

function extractOutOfAreaState(termLower: string): string | null {
  for (const state of OUT_OF_AREA_STATES) {
    if (termLower.includes(state)) return state;
  }
  return null;
}

function classifyTierANegativeFromSearchTerm(searchTerm: string): Array<{
  term: string;
  matchType: NegativeMatchType;
  reason: string;
}> {
  const termLower = searchTerm.toLowerCase();
  const out: Array<{ term: string; matchType: NegativeMatchType; reason: string }> = [];

  const outOfArea = extractOutOfAreaState(termLower);
  if (outOfArea) {
    out.push({
      term: outOfArea,
      matchType: "broad",
      reason: "Out-of-area location intent (state)."
    });
  }

  if (/\b(job|jobs|career|careers|hiring|employment|apply)\b/.test(termLower)) {
    out.push({
      term: "job",
      matchType: "broad",
      reason: "Hiring/job intent."
    });
  }

  if (/\b(donate|donation)\b/.test(termLower)) {
    out.push({
      term: "donate",
      matchType: "broad",
      reason: "Donation intent."
    });
  }

  if (/\bfree\b/.test(termLower)) {
    out.push({
      term: "free",
      matchType: "broad",
      reason: "Free/low-intent intent."
    });
  }

  if (termLower.includes("transfer station")) {
    out.push({
      term: "transfer station",
      matchType: "phrase",
      reason: "Landfill/transfer station intent."
    });
  }

  if (termLower.includes("dump hours") || termLower.includes("landfill hours")) {
    out.push({
      term: termLower.includes("landfill") ? "landfill hours" : "dump hours",
      matchType: "phrase",
      reason: "Landfill/dump hours intent."
    });
  }

  return out;
}

function normalizeWeightPair(callWeight: number, bookingWeight: number): { callWeight: number; bookingWeight: number } {
  const safeCall = Number.isFinite(callWeight) ? Math.max(0, Math.min(1, callWeight)) : 0.7;
  const safeBook = Number.isFinite(bookingWeight) ? Math.max(0, Math.min(1, bookingWeight)) : 0.3;
  const sum = safeCall + safeBook;
  if (sum <= 0) return { callWeight: 0.7, bookingWeight: 0.3 };
  return { callWeight: safeCall / sum, bookingWeight: safeBook / sum };
}

function classifyConversionAction(input: {
  name: string | null;
  category: string | null;
  type: string | null;
}): ConversionClass {
  const name = (input.name ?? "").toLowerCase();
  const category = (input.category ?? "").toLowerCase();
  const type = (input.type ?? "").toLowerCase();

  if (category.includes("phone_call") || type.includes("call") || name.includes("call")) {
    return "call";
  }

  if (
    name.includes("book") ||
    name.includes("appointment") ||
    name.includes("schedule") ||
    name.includes("booking")
  ) {
    return "booking";
  }

  return "other";
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function getOpenAIConfig(): { apiKey: string; model: string } | null {
  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) return null;
  const configured = process.env["OPENAI_MODEL"];
  const model = configured && configured.trim().length ? configured.trim() : DEFAULT_MODEL;
  return { apiKey, model };
}

function extractOutputText(data: any): string | null {
  // Prefer structured outputs if present; `output_text` can include non-JSON text in some failure modes.
  const output = Array.isArray(data?.output) ? data.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const chunk of content) {
      if (chunk?.json && typeof chunk.json === "object") {
        try {
          return JSON.stringify(chunk.json);
        } catch {
          // ignore
        }
      }
      if (typeof chunk?.text === "string" && chunk.text.trim()) return chunk.text.trim();
    }
  }
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
  return null;
}

function extractOutputObject(data: any): unknown | null {
  const output = Array.isArray(data?.output) ? data.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const chunk of content) {
      if (chunk?.json && typeof chunk.json === "object") return chunk.json;
      if (chunk?.type && typeof chunk.type === "string" && chunk.type.toLowerCase().includes("json")) {
        if (chunk?.parsed && typeof chunk.parsed === "object") return chunk.parsed;
        if (chunk?.value && typeof chunk.value === "object") return chunk.value;
      }
    }
  }
  if (data?.output_parsed && typeof data.output_parsed === "object") return data.output_parsed;
  return null;
}

function parsePossiblyWrappedJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    // Try to recover common cases like ```json ...``` or leading/trailing text.
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first >= 0 && last > first) {
      const slice = raw.slice(first, last + 1);
      try {
        return JSON.parse(slice);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function clampString(value: unknown, maxLen: number): string {
  const raw = typeof value === "string" ? value : String(value ?? "");
  return raw.trim().slice(0, maxLen);
}

function normalizeStringArray(value: unknown, maxItems: number, maxLen: number): string[] {
  const arr = Array.isArray(value) ? value : [];
  const out: string[] = [];
  for (const item of arr) {
    const s = clampString(item, maxLen);
    if (s.length === 0) continue;
    out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

async function callOpenAIAnalystJson(input: {
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
}): Promise<{ ok: true; report: z.infer<typeof AnalystReportSchema> } | { ok: false; error: string; detail?: string | null }> {
  const basePayload: Record<string, unknown> = {
    model: input.model,
    input: [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.userPrompt }
    ],
    // Keep this comfortably above the largest valid JSON output to avoid truncated JSON (which is un-parseable).
    max_output_tokens: 1600,
    text: {
      verbosity: "medium",
      format: {
        type: "json_schema",
        name: "google_ads_analyst_report",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            summary: { type: "string", minLength: 20, maxLength: 1600 },
            top_actions: {
              type: "array",
              minItems: 3,
              maxItems: 10,
              items: { type: "string", minLength: 5, maxLength: 220 }
            },
            negatives_to_review: {
              type: "array",
              maxItems: 50,
              items: { type: "string", minLength: 1, maxLength: 140 }
            },
            pause_candidates_to_review: {
              type: "array",
              maxItems: 50,
              items: { type: "string", minLength: 1, maxLength: 140 }
            },
            notes: { type: "string", maxLength: 1200 }
          },
          required: ["summary", "top_actions", "negatives_to_review", "pause_candidates_to_review", "notes"]
        }
      }
    }
  };

  if (input.model.trim().toLowerCase().startsWith("gpt-5")) {
    basePayload["reasoning"] = { effort: "low" };
  }

  const errorTrail: string[] = [];
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const payload: Record<string, unknown> = {
      ...basePayload,
      input:
        attempt === 1
          ? basePayload["input"]
          : [
              { role: "system", content: input.systemPrompt },
              {
                role: "system",
                content:
                  "Output ONLY the JSON object that matches the schema. Keep it concise (prefer 5–7 top actions). No markdown, no extra commentary, no code fences."
              },
              { role: "user", content: input.userPrompt }
            ]
    };

    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.apiKey}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      const snippet = bodyText.slice(0, 400);
      errorTrail.push(`attempt_${attempt}:openai_request_failed:${snippet}`);
      // If OpenAI returns a 4xx (except rate limits), retrying won't help.
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        return { ok: false, error: "openai_request_failed", detail: snippet };
      }
      continue;
    }

    const data = (await response.json().catch(() => ({}))) as any;

    let json: unknown = extractOutputObject(data);
    if (!json) {
      const raw = extractOutputText(data);
      if (!raw) {
        errorTrail.push(`attempt_${attempt}:openai_empty`);
        continue;
      }
      json = parsePossiblyWrappedJson(raw);
      if (!json) {
        errorTrail.push(`attempt_${attempt}:openai_parse_failed:${raw.slice(0, 240)}`);
        continue;
      }
    }

    // Clamp to reduce avoidable schema failures (the report is operator-facing suggestions).
    const normalized: Record<string, unknown> =
      json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
    const repaired = {
      summary: clampString(normalized["summary"], 1600),
      top_actions: normalizeStringArray(normalized["top_actions"], 10, 220),
      negatives_to_review: normalizeStringArray(normalized["negatives_to_review"], 50, 140),
      pause_candidates_to_review: normalizeStringArray(normalized["pause_candidates_to_review"], 50, 140),
      notes: clampString(normalized["notes"], 1200)
    };

    if (repaired.top_actions.length < 3) {
      repaired.top_actions.push(
        "Review the highest spend search terms and add obvious negatives that have 0 conversions.",
        "Tighten locations to your target cities and exclude out-of-area search terms.",
        "Test 1 new headline and 1 new description focused on fast availability and transparent pricing."
      );
      repaired.top_actions.splice(10);
    }

    const parsed = AnalystReportSchema.safeParse(repaired);
    if (!parsed.success) {
      const issues = JSON.stringify(parsed.error.issues).slice(0, 400);
      errorTrail.push(`attempt_${attempt}:schema_parse_failed:${issues}`);
      continue;
    }

    return { ok: true, report: parsed.data };
  }

  const detail = errorTrail.join(" | ").slice(0, 400);
  // Prefer a stable error key so provider health is easy to interpret.
  return { ok: false, error: detail.includes("openai_request_failed") ? "openai_request_failed" : "openai_parse_failed", detail };
}

export async function runGoogleAdsAnalystReport(input: {
  rangeDays?: number;
  since?: string;
  until?: string;
  invokedBy: "admin" | "worker";
  createdBy?: string | null;
}): Promise<GoogleAdsAnalystRunResult> {
  const config = getOpenAIConfig();
  if (!config) {
    return { ok: false, error: "openai_not_configured" };
  }

  const tz = process.env["APPOINTMENT_TIMEZONE"] ?? "America/New_York";
  const now = DateTime.now().setZone(tz);

  const rangeDays =
    typeof input.rangeDays === "number" && Number.isFinite(input.rangeDays)
      ? Math.min(Math.max(Math.floor(input.rangeDays), 1), 30)
      : 7;

  const since =
    typeof input.since === "string" && isIsoDate(input.since)
      ? input.since
      : now.minus({ days: rangeDays - 1 }).toISODate();
  const until = typeof input.until === "string" && isIsoDate(input.until) ? input.until : now.toISODate();

  if (!since || !until || since > until) {
    return { ok: false, error: "invalid_date_range" };
  }

  const policy = await getGoogleAdsAnalystPolicy();
  const weights = normalizeWeightPair(policy.callWeight, policy.bookingWeight);
  const company = await getCompanyProfilePolicy();

  const db = getDb();

  const [campaignTotals, searchTerms, conversionActions, campaignActionTotals] = await Promise.all([
    db
      .select({
        campaignId: googleAdsInsightsDaily.campaignId,
        campaignName: sql<string>`max(${googleAdsInsightsDaily.campaignName})`,
        impressions: sql<number>`coalesce(sum(${googleAdsInsightsDaily.impressions}), 0)`.mapWith(Number),
        clicks: sql<number>`coalesce(sum(${googleAdsInsightsDaily.clicks}), 0)`.mapWith(Number),
        cost: sql<string>`coalesce(sum(${googleAdsInsightsDaily.cost}), 0)::text`,
        conversions: sql<string>`coalesce(sum(${googleAdsInsightsDaily.conversions}), 0)::text`,
        conversionValue: sql<string>`coalesce(sum(${googleAdsInsightsDaily.conversionValue}), 0)::text`
      })
      .from(googleAdsInsightsDaily)
      .where(and(gte(googleAdsInsightsDaily.dateStart, since), lte(googleAdsInsightsDaily.dateStart, until)))
      .groupBy(googleAdsInsightsDaily.campaignId)
      .orderBy(desc(sql`sum(${googleAdsInsightsDaily.cost})`))
      .limit(25),
    db
      .select({
        searchTerm: googleAdsSearchTermsDaily.searchTerm,
        campaignId: googleAdsSearchTermsDaily.campaignId,
        clicks: sql<number>`coalesce(sum(${googleAdsSearchTermsDaily.clicks}), 0)`.mapWith(Number),
        cost: sql<string>`coalesce(sum(${googleAdsSearchTermsDaily.cost}), 0)::text`,
        conversions: sql<string>`coalesce(sum(${googleAdsSearchTermsDaily.conversions}), 0)::text`
      })
      .from(googleAdsSearchTermsDaily)
      .where(and(gte(googleAdsSearchTermsDaily.dateStart, since), lte(googleAdsSearchTermsDaily.dateStart, until)))
      .groupBy(googleAdsSearchTermsDaily.searchTerm, googleAdsSearchTermsDaily.campaignId)
      .orderBy(desc(sql`sum(${googleAdsSearchTermsDaily.cost})`))
      .limit(75),
    db
      .select({
        actionId: googleAdsConversionActions.actionId,
        name: googleAdsConversionActions.name,
        category: googleAdsConversionActions.category,
        type: googleAdsConversionActions.type
      })
      .from(googleAdsConversionActions)
      .orderBy(desc(googleAdsConversionActions.fetchedAt))
      .limit(200),
    db
      .select({
        campaignId: googleAdsCampaignConversionsDaily.campaignId,
        actionId: googleAdsCampaignConversionsDaily.conversionActionId,
        actionName: sql<string>`max(${googleAdsCampaignConversionsDaily.conversionActionName})`,
        conversions: sql<string>`coalesce(sum(${googleAdsCampaignConversionsDaily.conversions}), 0)::text`,
        conversionValue: sql<string>`coalesce(sum(${googleAdsCampaignConversionsDaily.conversionValue}), 0)::text`
      })
      .from(googleAdsCampaignConversionsDaily)
      .where(
        and(
          gte(googleAdsCampaignConversionsDaily.dateStart, since),
          lte(googleAdsCampaignConversionsDaily.dateStart, until)
        )
      )
      .groupBy(googleAdsCampaignConversionsDaily.campaignId, googleAdsCampaignConversionsDaily.conversionActionId)
  ]);

  const actionById = new Map<string, { name: string | null; category: string | null; type: string | null }>();
  for (const action of conversionActions) {
    actionById.set(action.actionId, {
      name: action.name ?? null,
      category: action.category ?? null,
      type: action.type ?? null
    });
  }

  const campaignConversionBreakdown = new Map<
    string,
    { call: number; booking: number; other: number; total: number }
  >();

  for (const row of campaignActionTotals) {
    const actionMeta = actionById.get(row.actionId) ?? { name: row.actionName ?? null, category: null, type: null };
    const cls = classifyConversionAction(actionMeta);
    const conversions = Number(row.conversions);
    const safeConversions = Number.isFinite(conversions) ? conversions : 0;
    const current = campaignConversionBreakdown.get(row.campaignId) ?? { call: 0, booking: 0, other: 0, total: 0 };
    current[cls] += safeConversions;
    current.total += safeConversions;
    campaignConversionBreakdown.set(row.campaignId, current);
  }

  const enrichedCampaigns = campaignTotals.map((row) => {
    const breakdown = campaignConversionBreakdown.get(row.campaignId) ?? { call: 0, booking: 0, other: 0, total: 0 };
    const cost = Number(row.cost);
    const safeCost = Number.isFinite(cost) ? cost : 0;
    const weightedConversions = breakdown.call * weights.callWeight + breakdown.booking * weights.bookingWeight;
    const cpa = weightedConversions > 0 ? safeCost / weightedConversions : null;
    return {
      campaignId: row.campaignId,
      campaignName: row.campaignName ?? row.campaignId,
      clicks: row.clicks,
      impressions: row.impressions,
      cost: safeCost,
      conversions: Number(row.conversions) || 0,
      callConversions: breakdown.call,
      bookingConversions: breakdown.booking,
      weightedConversions: Number.isFinite(weightedConversions) ? weightedConversions : 0,
      weightedCpa: cpa && Number.isFinite(cpa) ? Number(cpa.toFixed(2)) : null
    };
  });

  const totalSpend = enrichedCampaigns.reduce((sum, row) => sum + (Number.isFinite(row.cost) ? row.cost : 0), 0);
  const totalClicks = enrichedCampaigns.reduce((sum, row) => sum + (Number.isFinite(row.clicks) ? row.clicks : 0), 0);
  const hasEnoughDataForHeuristicRecs =
    totalSpend >= policy.minSpendForNegatives && totalClicks >= policy.minClicksForNegatives;

  const negativeCandidates = (hasEnoughDataForHeuristicRecs ? searchTerms : [])
    .filter((row) => {
      const cost = Number(row.cost);
      const conversions = Number(row.conversions);
      return (
        Number.isFinite(cost) &&
        cost >= policy.minSpendForNegatives &&
        (Number.isFinite(conversions) ? conversions : 0) <= 0 &&
        row.clicks >= policy.minClicksForNegatives
      );
    })
    .slice(0, 25)
    .map((row) => ({
      searchTerm: row.searchTerm,
      campaignId: row.campaignId,
      cost: Number(row.cost) || 0,
      clicks: row.clicks,
      ...(campaignConversionBreakdown.get(row.campaignId) ?? { call: 0, booking: 0, other: 0, total: 0 })
    }));

  const suggestedNegatives = negativeCandidates.map((row) => row.searchTerm);

  const pauseCandidates = (hasEnoughDataForHeuristicRecs ? enrichedCampaigns : [])
    .filter((row) => row.cost >= 150 && row.weightedConversions <= 0 && row.clicks >= 20)
    .slice(0, 10)
    .map((row) => ({
      campaignId: row.campaignId,
      campaignName: row.campaignName,
      cost: row.cost,
      clicks: row.clicks,
      callConversions: row.callConversions,
      bookingConversions: row.bookingConversions,
      weightedConversions: row.weightedConversions
    }));

  const systemPrompt = [
    "You are a Google Ads marketing analyst for a local junk removal company (Stonegate Junk Removal).",
    "Your job: read the last 7 days of ads data, then produce a short, actionable checklist to improve results.",
    "",
    "Business context:",
    `- Company: ${company.businessName}`,
    `- Primary phone: ${company.primaryPhone}`,
    `- Service area: ${company.serviceAreaSummary}`,
    "- Conversion goal priority: phone calls are the highest priority (bookings are secondary).",
    "",
    "Constraints:",
    "- Output MUST be valid JSON that matches the provided schema.",
    "- Be practical and specific. No generic advice like \"optimize targeting\" without naming what to do next.",
    "- Assume the operator will apply changes manually unless autonomous mode is enabled elsewhere.",
    "- Calls matter more than bookings. Use the provided weights and make that clear in the actions.",
    "- Keep the summary short and decisive.",
    "- Prefer 5–7 top actions unless 3 is sufficient."
  ].join("\n");

  const userPrompt = [
    `Time window: ${since} to ${until} (${rangeDays} days)`,
    `Weights: calls=${weights.callWeight.toFixed(2)} bookings=${weights.bookingWeight.toFixed(2)}`,
    `Heuristics enabled: ${hasEnoughDataForHeuristicRecs ? "yes" : "no"} (total spend=${totalSpend.toFixed(
      2
    )}, total clicks=${totalClicks})`,
    "",
    "Campaigns (sorted by spend):",
    JSON.stringify(enrichedCampaigns.slice(0, 15), null, 2),
    "",
    "Top search terms (sorted by spend):",
    JSON.stringify(searchTerms.slice(0, 25), null, 2),
    "",
    "Suggested negative keywords to review (auto-generated heuristics; only include if they make sense):",
    JSON.stringify(suggestedNegatives, null, 2),
    "",
    "Return:",
    "- 3 to 10 top actions (prioritized)",
    "- a short list of negative keywords to review (0-50)",
    "- a short list of pause candidates to review (0-50)"
  ].join("\n");

  const ai = await callOpenAIAnalystJson({
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    userPrompt
  });

  if (!ai.ok) {
    return { ok: false, error: ai.error, detail: ai.detail ?? null };
  }

  const [row] = await db
    .insert(googleAdsAnalystReports)
    .values({
      rangeDays,
      since,
      until,
      callWeight: weights.callWeight.toFixed(3),
      bookingWeight: weights.bookingWeight.toFixed(3),
      report: ai.report as unknown as Record<string, unknown>,
      createdBy: input.createdBy ?? null
    })
    .returning({ id: googleAdsAnalystReports.id, createdAt: googleAdsAnalystReports.createdAt });

  const reportId = row?.id ?? "";

  if (reportId) {
    const aiNegatives = Array.isArray(ai.report.negatives_to_review) ? ai.report.negatives_to_review : [];
    const aiPauseCandidates = Array.isArray(ai.report.pause_candidates_to_review) ? ai.report.pause_candidates_to_review : [];
    const recRows: Array<{
      reportId: string;
      kind: string;
      status: string;
      payload: Record<string, unknown>;
      decidedBy: string | null;
      decidedAt: Date | null;
      appliedAt: Date | null;
    }> = [];

    const negativeKeys = new Set<string>();

    const pushNegativeRec = (input: {
      term: string;
      tier: NegativeTier;
      matchType?: NegativeMatchType | null;
      reason: string;
      campaignId?: string | null;
      clicks?: number | null;
      cost?: number | null;
      callConversions?: number | null;
      bookingConversions?: number | null;
      origin?: string | null;
    }): void => {
      const matchType = input.matchType ?? inferNegativeMatchType(input.term, input.tier);
      const formatted = formatNegativeTerm(input.term, matchType);
      const key = normalizeNegativeKey(formatted, matchType);
      if (!formatted || negativeKeys.has(key)) return;
      negativeKeys.add(key);

      recRows.push({
        reportId,
        kind: "negative_keyword",
        status: "proposed",
        payload: {
          term: formatted,
          tier: input.tier,
          matchType,
          origin: input.origin ?? null,
          campaignId: input.campaignId ?? null,
          clicks: input.clicks ?? null,
          cost: input.cost ?? null,
          callConversions: input.callConversions ?? null,
          bookingConversions: input.bookingConversions ?? null,
          reason: input.reason
        },
        decidedBy: null,
        decidedAt: null,
        appliedAt: null
      });
    };

    // Tier A: hard-block negatives from observed search terms (no thresholds).
    for (const termRow of searchTerms.slice(0, 200)) {
      const candidates = classifyTierANegativeFromSearchTerm(termRow.searchTerm);
      for (const candidate of candidates) {
        pushNegativeRec({
          term: candidate.term,
          tier: "A",
          matchType: candidate.matchType,
          reason: candidate.reason,
          origin: "hard_block"
        });
      }
    }

    for (const candidate of negativeCandidates) {
      pushNegativeRec({
        term: candidate.searchTerm,
        tier: "B",
        reason: "High spend + clicks with 0 conversions",
        campaignId: candidate.campaignId,
        clicks: candidate.clicks,
        cost: candidate.cost,
        callConversions: candidate.call ?? 0,
        bookingConversions: candidate.booking ?? 0,
        origin: "threshold"
      });
    }

    for (const termRaw of aiNegatives) {
      const term = String(termRaw ?? "").trim();
      if (!term) continue;

      const tierA = classifyTierANegativeFromSearchTerm(term);
      if (tierA.length > 0) {
        for (const candidate of tierA) {
          pushNegativeRec({
            term: candidate.term,
            tier: "A",
            matchType: candidate.matchType,
            reason: candidate.reason,
            origin: "ai_hard_block"
          });
        }
        continue;
      }

      pushNegativeRec({
        term,
        tier: "B",
        reason: "AI suggested negative keyword",
        origin: "ai"
      });
    }

    for (const candidate of pauseCandidates) {
      recRows.push({
        reportId,
        kind: "pause_candidate",
        status: "proposed",
        payload: {
          campaignId: candidate.campaignId,
          campaignName: candidate.campaignName,
          clicks: candidate.clicks,
          cost: candidate.cost,
          callConversions: candidate.callConversions,
          bookingConversions: candidate.bookingConversions,
          weightedConversions: candidate.weightedConversions,
          reason: "High spend with 0 weighted conversions"
        },
        decidedBy: null,
        decidedAt: null,
        appliedAt: null
      });
    }

    const pauseKeys = new Set<string>();
    for (const row of recRows) {
      if (row.kind !== "pause_candidate") continue;
      const campaignIdRaw = row.payload["campaignId"];
      const campaignNameRaw = row.payload["campaignName"];
      const campaignId = typeof campaignIdRaw === "string" ? campaignIdRaw.trim() : "";
      const campaignName = typeof campaignNameRaw === "string" ? campaignNameRaw.trim() : "";
      const key = campaignId ? `id:${campaignId}` : campaignName ? `name:${campaignName.toLowerCase()}` : "";
      if (key) pauseKeys.add(key);
    }

    for (const candidateRaw of aiPauseCandidates) {
      const candidate = String(candidateRaw ?? "").trim();
      if (!candidate) continue;
      const key = `name:${candidate.toLowerCase()}`;
      if (pauseKeys.has(key)) continue;
      pauseKeys.add(key);
      recRows.push({
        reportId,
        kind: "pause_candidate",
        status: "proposed",
        payload: {
          campaignName: candidate,
          reason: "AI suggested pause candidate"
        },
        decidedBy: null,
        decidedAt: null,
        appliedAt: null
      });
    }

    if (recRows.length > 0) {
      await db.insert(googleAdsAnalystRecommendations).values(recRows);
    }
  }

  return {
    ok: true,
    reportId,
    createdAt: row?.createdAt ? row.createdAt.toISOString() : new Date().toISOString()
  };
}
