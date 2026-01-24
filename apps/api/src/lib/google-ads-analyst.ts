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
import { getGoogleAdsConfiguredIds } from "@/lib/google-ads-insights";
import { getGoogleAdsAnalystPolicy } from "@/lib/policy";
import { getCompanyProfilePolicy } from "@/lib/policy";

type ConversionClass = "call" | "booking" | "other";
type NegativeTier = "A" | "B";
type NegativeMatchType = "broad" | "phrase" | "exact";
type NegativeRisk = "low" | "medium" | "high";

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

const NEGATIVE_DO_NOT_BLOCK_PHRASES = [
  "junk removal",
  "junk pickup",
  "haul away",
  "haul-away",
  "trash removal",
  "bulk pickup",
  "bulk trash",
  "estate cleanout",
  "estate clean out",
  "garage cleanout",
  "garage clean out",
  "appliance removal",
  "mattress removal",
  "furniture removal",
  "yard waste removal",
  "construction debris removal"
];

const NEGATIVE_DO_NOT_BLOCK_TOKENS = [
  "junk",
  "removal",
  "pickup",
  "cleanout",
  "clean-out",
  "haul",
  "away",
  "mattress",
  "box spring",
  "appliance",
  "furniture",
  "couch",
  "sofa",
  "hot tub",
  "debris",
  "yard",
  "brush"
];

function inferNegativeMatchType(term: string, tier: NegativeTier): NegativeMatchType {
  const normalized = term.trim();
  if (tier === "A" && /\s/.test(normalized)) return "phrase";
  if (tier === "A" && normalized.length <= 25 && !/\s/.test(normalized)) return "broad";
  if (/\s/.test(normalized)) return "phrase";
  return "broad";
}

function normalizeForOverlap(input: string): string {
  let term = input.trim().toLowerCase();
  if (term.startsWith("[") && term.endsWith("]")) term = term.slice(1, -1).trim();
  if (term.startsWith("\"") && term.endsWith("\"")) term = term.slice(1, -1).trim();
  term = term.replace(/\s+/g, " ");
  return term;
}

function assessNegativeRisk(input: {
  term: string;
  matchType: NegativeMatchType;
}): { risk: NegativeRisk; reason: string | null } {
  const term = normalizeForOverlap(input.term);
  if (!term) return { risk: "medium", reason: "Empty term" };

  for (const phrase of NEGATIVE_DO_NOT_BLOCK_PHRASES) {
    const normalizedPhrase = normalizeForOverlap(phrase);
    if (normalizedPhrase && term.includes(normalizedPhrase)) {
      return { risk: "high", reason: `Overlaps whitelist phrase \"${normalizedPhrase}\"` };
    }
  }

  if (input.matchType === "broad") {
    for (const token of NEGATIVE_DO_NOT_BLOCK_TOKENS) {
      const normalizedToken = normalizeForOverlap(token);
      if (!normalizedToken) continue;
      if (
        term === normalizedToken ||
        term.includes(` ${normalizedToken} `) ||
        term.startsWith(`${normalizedToken} `) ||
        term.endsWith(` ${normalizedToken}`)
      ) {
        return { risk: "high", reason: `Broad negative overlaps core token \"${normalizedToken}\"` };
      }
    }
  }

  if (term.length <= 3 && input.matchType === "broad") {
    return { risk: "medium", reason: "Very short broad negative can over-block" };
  }

  return { risk: "low", reason: null };
}

function computeConfidence(input: {
  tier: NegativeTier;
  risk: NegativeRisk;
  dataSufficiency: "red" | "yellow" | "green";
  impactClicks: number;
  impactCost: number;
}): number {
  const base = input.tier === "A" ? 0.92 : 0.55;
  const suff =
    input.dataSufficiency === "green" ? 1 : input.dataSufficiency === "yellow" ? 0.85 : 0.6;
  const evidenceBoost =
    input.impactClicks >= 12 || input.impactCost >= 25 ? 0.25 : input.impactClicks >= 3 ? 0.1 : 0;
  const riskPenalty = input.risk === "high" ? 0.4 : input.risk === "medium" ? 0.15 : 0;
  const score = base * suff + evidenceBoost - riskPenalty;
  return Math.max(0.01, Math.min(0.99, score));
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
    const textChunks: string[] = [];
    for (const chunk of content) {
      if (chunk?.json && typeof chunk.json === "object") {
        try {
          return JSON.stringify(chunk.json);
        } catch {
          // ignore
        }
      }
      if (typeof chunk?.text === "string" && chunk.text.trim()) textChunks.push(chunk.text);
    }
    const combined = textChunks.join("").trim();
    if (combined) return combined;
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
                  "Output ONLY the JSON object that matches the schema. Keep it concise (prefer 5-7 top actions). No markdown, no extra commentary, no code fences."
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

  const { customerId } = getGoogleAdsConfiguredIds();
  if (!customerId) {
    return { ok: false, error: "google_ads_not_configured" };
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
        customerId: googleAdsInsightsDaily.customerId,
        campaignId: googleAdsInsightsDaily.campaignId,
        campaignName: sql<string>`max(${googleAdsInsightsDaily.campaignName})`,
        impressions: sql<number>`coalesce(sum(${googleAdsInsightsDaily.impressions}), 0)`.mapWith(Number),
        clicks: sql<number>`coalesce(sum(${googleAdsInsightsDaily.clicks}), 0)`.mapWith(Number),
        cost: sql<string>`coalesce(sum(${googleAdsInsightsDaily.cost}), 0)::text`,
        conversions: sql<string>`coalesce(sum(${googleAdsInsightsDaily.conversions}), 0)::text`,
        conversionValue: sql<string>`coalesce(sum(${googleAdsInsightsDaily.conversionValue}), 0)::text`
      })
      .from(googleAdsInsightsDaily)
      .where(
        and(
          eq(googleAdsInsightsDaily.customerId, customerId),
          gte(googleAdsInsightsDaily.dateStart, since),
          lte(googleAdsInsightsDaily.dateStart, until)
        )
      )
      .groupBy(googleAdsInsightsDaily.customerId, googleAdsInsightsDaily.campaignId)
      .orderBy(desc(sql`sum(${googleAdsInsightsDaily.cost})`))
      .limit(25),
    db
      .select({
        customerId: googleAdsSearchTermsDaily.customerId,
        searchTerm: googleAdsSearchTermsDaily.searchTerm,
        campaignId: googleAdsSearchTermsDaily.campaignId,
        impressions: sql<number>`coalesce(sum(${googleAdsSearchTermsDaily.impressions}), 0)`.mapWith(Number),
        clicks: sql<number>`coalesce(sum(${googleAdsSearchTermsDaily.clicks}), 0)`.mapWith(Number),
        cost: sql<string>`coalesce(sum(${googleAdsSearchTermsDaily.cost}), 0)::text`,
        conversions: sql<string>`coalesce(sum(${googleAdsSearchTermsDaily.conversions}), 0)::text`
      })
      .from(googleAdsSearchTermsDaily)
      .where(
        and(
          eq(googleAdsSearchTermsDaily.customerId, customerId),
          gte(googleAdsSearchTermsDaily.dateStart, since),
          lte(googleAdsSearchTermsDaily.dateStart, until)
        )
      )
      .groupBy(googleAdsSearchTermsDaily.customerId, googleAdsSearchTermsDaily.searchTerm, googleAdsSearchTermsDaily.campaignId)
      .orderBy(desc(sql`sum(${googleAdsSearchTermsDaily.cost})`))
      .limit(75),
    db
      .select({
        customerId: googleAdsConversionActions.customerId,
        actionId: googleAdsConversionActions.actionId,
        name: googleAdsConversionActions.name,
        category: googleAdsConversionActions.category,
        type: googleAdsConversionActions.type
      })
      .from(googleAdsConversionActions)
      .where(eq(googleAdsConversionActions.customerId, customerId))
      .orderBy(desc(googleAdsConversionActions.fetchedAt))
      .limit(200),
    db
      .select({
        customerId: googleAdsCampaignConversionsDaily.customerId,
        campaignId: googleAdsCampaignConversionsDaily.campaignId,
        actionId: googleAdsCampaignConversionsDaily.conversionActionId,
        actionName: sql<string>`max(${googleAdsCampaignConversionsDaily.conversionActionName})`,
        conversions: sql<string>`coalesce(sum(${googleAdsCampaignConversionsDaily.conversions}), 0)::text`,
        conversionValue: sql<string>`coalesce(sum(${googleAdsCampaignConversionsDaily.conversionValue}), 0)::text`
      })
      .from(googleAdsCampaignConversionsDaily)
      .where(
        and(
          eq(googleAdsCampaignConversionsDaily.customerId, customerId),
          gte(googleAdsCampaignConversionsDaily.dateStart, since),
          lte(googleAdsCampaignConversionsDaily.dateStart, until)
        )
      )
      .groupBy(
        googleAdsCampaignConversionsDaily.customerId,
        googleAdsCampaignConversionsDaily.campaignId,
        googleAdsCampaignConversionsDaily.conversionActionId
      )
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
    "- Prefer 5-7 top actions unless 3 is sufficient."
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
    const dataSufficiency = totalClicks >= 50 ? "green" : totalClicks >= 15 ? "yellow" : "red";
    const campaignNameById = new Map<string, string>();
    for (const campaign of campaignTotals) {
      if (!campaign.campaignId) continue;
      const name =
        typeof campaign.campaignName === "string" && campaign.campaignName.trim().length
          ? campaign.campaignName.trim()
          : campaign.campaignId;
      campaignNameById.set(campaign.campaignId, name);
    }

    const recRows: Array<{
      reportId: string;
      kind: string;
      status: string;
      payload: Record<string, unknown>;
      decidedBy: string | null;
      decidedAt: Date | null;
      appliedAt: Date | null;
    }> = [];

    const negativeIndexByKey = new Map<string, number>();

    const pushNegativeRec = (input: {
      term: string;
      tier: NegativeTier;
      matchType?: NegativeMatchType | null;
      reason: string;
      campaignId?: string | null;
      impressions?: number | null;
      clicks?: number | null;
      cost?: number | null;
      callConversions?: number | null;
      bookingConversions?: number | null;
      origin?: string | null;
      exampleSearchTerm?: string | null;
    }): void => {
      const matchType = input.matchType ?? inferNegativeMatchType(input.term, input.tier);
      const formatted = formatNegativeTerm(input.term, matchType);
      const key = normalizeNegativeKey(formatted, matchType);
      if (!formatted) return;

      const campaignId = typeof input.campaignId === "string" ? input.campaignId.trim() : "";
      const campaignName = campaignId ? (campaignNameById.get(campaignId) ?? campaignId) : "";

      const impactImpressions = Number.isFinite(input.impressions ?? NaN) ? Number(input.impressions) : 0;
      const impactClicks = Number.isFinite(input.clicks ?? NaN) ? Number(input.clicks) : 0;
      const impactCost = Number.isFinite(input.cost ?? NaN) ? Number(input.cost) : 0;

      const assessed = assessNegativeRisk({ term: formatted, matchType });
      const confidence = computeConfidence({
        tier: input.tier,
        risk: assessed.risk,
        dataSufficiency,
        impactClicks,
        impactCost
      });

      const existingIndex = negativeIndexByKey.get(key);
      if (typeof existingIndex === "number") {
        const existing = recRows[existingIndex];
        if (!existing) {
          negativeIndexByKey.delete(key);
        } else {
        const payload = existing.payload;

        const existingTier = String(payload["tier"] ?? "").toUpperCase();
        const resolvedTier: NegativeTier = existingTier === "A" || input.tier === "A" ? "A" : "B";

        const mergeArray = (field: string, value: string): string[] => {
          const current = Array.isArray(payload[field]) ? (payload[field] as string[]) : [];
          if (!value) return current;
          if (!current.includes(value)) current.push(value);
          return current;
        };

        const campaignIds = campaignId ? mergeArray("campaignIds", campaignId) : (Array.isArray(payload["campaignIds"]) ? (payload["campaignIds"] as string[]) : []);
        const campaignNames = campaignName ? mergeArray("campaignNames", campaignName) : (Array.isArray(payload["campaignNames"]) ? (payload["campaignNames"] as string[]) : []);
        const origins = input.origin ? mergeArray("origins", input.origin) : (Array.isArray(payload["origins"]) ? (payload["origins"] as string[]) : []);
        const reasons = input.reason ? mergeArray("reasons", input.reason) : (Array.isArray(payload["reasons"]) ? (payload["reasons"] as string[]) : []);
        const examples =
          input.exampleSearchTerm && input.exampleSearchTerm.trim().length
            ? (() => {
                const cur = Array.isArray(payload["examples"]) ? (payload["examples"] as string[]) : [];
                if (!cur.includes(input.exampleSearchTerm) && cur.length < 5) cur.push(input.exampleSearchTerm);
                return cur;
              })()
            : Array.isArray(payload["examples"])
              ? (payload["examples"] as string[])
              : [];

        const mergedImpactImpressions = Number(payload["impactImpressions"] ?? 0) + impactImpressions;
        const mergedImpactClicks = Number(payload["impactClicks"] ?? 0) + impactClicks;
        const mergedImpactCost = Number(payload["impactCost"] ?? 0) + impactCost;

        const existingRisk = String(payload["risk"] ?? "low") as NegativeRisk;
        const mergedRisk: NegativeRisk =
          existingRisk === "high" || assessed.risk === "high"
            ? "high"
            : existingRisk === "medium" || assessed.risk === "medium"
              ? "medium"
              : "low";

        const mergedConfidence = computeConfidence({
          tier: resolvedTier,
          risk: mergedRisk,
          dataSufficiency,
          impactClicks: mergedImpactClicks,
          impactCost: mergedImpactCost
        });

        existing.payload = {
          ...payload,
          tier: resolvedTier,
          origin: payload["origin"] ?? input.origin ?? null,
          origins,
          reason: payload["reason"] ?? input.reason,
          reasons,
          campaignId: (payload["campaignId"] as string) ?? (campaignId || null),
          campaignName: (payload["campaignName"] as string) ?? (campaignName || null),
          campaignIds,
          campaignNames,
          examples,
          impactImpressions: mergedImpactImpressions,
          impactClicks: mergedImpactClicks,
          impactCost: Number(mergedImpactCost.toFixed(2)),
          clicks: mergedImpactClicks,
          cost: Number(mergedImpactCost.toFixed(2)),
          risk: mergedRisk,
          riskReason: (payload["riskReason"] as string) ?? assessed.reason ?? null,
          confidence: Number(mergedConfidence.toFixed(2))
        };
        return;
        }
      }

      negativeIndexByKey.set(key, recRows.length);

      recRows.push({
        reportId,
        kind: "negative_keyword",
        status: "proposed",
        payload: {
          term: formatted,
          tier: input.tier,
          matchType,
          origin: input.origin ?? null,
          origins: input.origin ? [input.origin] : [],
          reason: input.reason,
          reasons: input.reason ? [input.reason] : [],
          campaignId: campaignId || null,
          campaignName: campaignName || null,
          campaignIds: campaignId ? [campaignId] : [],
          campaignNames: campaignName ? [campaignName] : [],
          examples: input.exampleSearchTerm ? [input.exampleSearchTerm] : [],
          impactImpressions,
          impactClicks,
          impactCost: Number(impactCost.toFixed(2)),
          clicks: impactClicks,
          cost: Number(impactCost.toFixed(2)),
          callConversions: input.callConversions ?? null,
          bookingConversions: input.bookingConversions ?? null,
          risk: assessed.risk,
          riskReason: assessed.reason ?? null,
          confidence: Number(confidence.toFixed(2))
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
          origin: "hard_block",
          campaignId: termRow.campaignId,
          impressions: termRow.impressions,
          clicks: termRow.clicks,
          cost: Number(termRow.cost),
          exampleSearchTerm: termRow.searchTerm
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
        origin: "threshold",
        exampleSearchTerm: candidate.searchTerm
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
        origin: "ai",
        exampleSearchTerm: term
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
