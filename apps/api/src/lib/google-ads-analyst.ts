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

type ConversionClass = "call" | "booking" | "other";

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
  const payload: Record<string, unknown> = {
    model: input.model,
    input: [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.userPrompt }
    ],
    max_output_tokens: 900,
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
    payload["reasoning"] = { effort: "low" };
  }

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
    return { ok: false, error: "openai_request_failed", detail: bodyText.slice(0, 400) };
  }

  const data = (await response.json().catch(() => ({}))) as any;

  let json: unknown = extractOutputObject(data);
  if (!json) {
    const raw = extractOutputText(data);
    if (!raw) return { ok: false, error: "openai_empty" };
    json = parsePossiblyWrappedJson(raw);
    if (!json) return { ok: false, error: "openai_parse_failed" };
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
    return { ok: false, error: "schema_parse_failed", detail: JSON.stringify(parsed.error.issues).slice(0, 400) };
  }

  return { ok: true, report: parsed.data };
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
      clicks: row.clicks
    }));

  const suggestedNegatives = negativeCandidates.map((row) => row.searchTerm);

  const pauseCandidates = (hasEnoughDataForHeuristicRecs ? enrichedCampaigns : [])
    .filter((row) => row.cost >= 150 && row.weightedConversions <= 0 && row.clicks >= 20)
    .slice(0, 10)
    .map((row) => ({
      campaignId: row.campaignId,
      campaignName: row.campaignName,
      cost: row.cost,
      clicks: row.clicks
    }));

  const systemPrompt = [
    "You are a Google Ads marketing analyst for a local junk removal company (Stonegate Junk Removal).",
    "Your job: read the last 7 days of ads data, then produce a short, actionable checklist to improve results.",
    "",
    "Constraints:",
    "- Output MUST be valid JSON that matches the provided schema.",
    "- Be practical and specific. No generic advice like \"optimize targeting\" without naming what to do next.",
    "- Assume the operator will apply changes manually unless autonomous mode is enabled elsewhere.",
    "- Calls matter more than bookings. Use the provided weights and make that clear in the actions.",
    "- Keep the summary short and decisive."
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
    const recRows: Array<{
      reportId: string;
      kind: string;
      status: string;
      payload: Record<string, unknown>;
      decidedBy: string | null;
      decidedAt: Date | null;
      appliedAt: Date | null;
    }> = [];

    for (const candidate of negativeCandidates) {
      recRows.push({
        reportId,
        kind: "negative_keyword",
        status: "proposed",
        payload: {
          term: candidate.searchTerm,
          campaignId: candidate.campaignId,
          clicks: candidate.clicks,
          cost: candidate.cost,
          reason: "High spend + clicks with 0 conversions"
        },
        decidedBy: null,
        decidedAt: null,
        appliedAt: null
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
          reason: "High spend with 0 weighted conversions"
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
