import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, mediaJobAnalyses } from "@/db";
import type { OmniLeadContext } from "@/lib/omni-lead-context";

type DatabaseClient = ReturnType<typeof getDb>;
type TransactionExecutor =
  Parameters<DatabaseClient["transaction"]>[0] extends (tx: infer Tx) => Promise<unknown>
    ? Tx
    : never;
type DbExecutor = DatabaseClient | TransactionExecutor;

export type VolumeBucket =
  | "under_quarter"
  | "quarter"
  | "quarter_to_half"
  | "half"
  | "half_to_three_quarters"
  | "three_quarters"
  | "three_quarters_to_full"
  | "full"
  | "full_plus"
  | "unknown";

type SceneGroupRecord = {
  id: string;
  label: string;
  mediaCount: number;
  mediaUrls: string[];
  notes: string[];
};

type StatedScopeRecord = {
  perceivedSize: string | null;
  jobTypes: string[];
  notes: string | null;
  sourceHints: string[];
  unpicturedScopeSignals: string[];
  addOnHints: {
    mattresses: number;
    paintCans: number;
    tires: number;
  };
};

export type MediaJobAnalysisRecord = {
  sourceChannel: string | null;
  mediaCount: number;
  videoCount: number;
  visibleVolumeBucket: VolumeBucket;
  visibleVolumeRange: VolumeBucket;
  mergedVolumeBucket: VolumeBucket;
  mergedVolumeRange: VolumeBucket;
  visibleMattressCount: number;
  visiblePaintCanCount: number;
  visibleTireCount: number;
  sceneGroupsJson: SceneGroupRecord[] | null;
  statedScopeJson: StatedScopeRecord;
  riskFlags: string[];
  missingViews: string[];
  confidence: "low" | "medium" | "high";
  summary: string;
  rawModelOutputJson: Record<string, unknown>;
  source: string;
};

const VOLUME_ORDER = [
  "under_quarter",
  "quarter",
  "quarter_to_half",
  "half",
  "half_to_three_quarters",
  "three_quarters",
  "three_quarters_to_full",
  "full",
  "full_plus",
  "unknown",
] as const satisfies readonly VolumeBucket[];

const VisionSceneGroupSchema = z.object({
  label: z.string().min(1).max(120),
  image_indices: z.array(z.number().int().min(1).max(12)).min(1).max(12),
  notes: z.array(z.string().min(1).max(220)).max(4).default([]),
});

const VisionAnalysisSchema = z.object({
  visible_volume_bucket: z.enum(VOLUME_ORDER),
  visible_volume_range: z.enum(VOLUME_ORDER),
  visible_mattress_count: z.number().int().min(0).max(20),
  visible_paint_can_count: z.number().int().min(0).max(60),
  visible_tire_count: z.number().int().min(0).max(20),
  scene_groups: z.array(VisionSceneGroupSchema).max(8).default([]),
  risk_flags: z.array(z.string().min(1).max(160)).max(8).default([]),
  missing_views: z.array(z.string().min(1).max(200)).max(6).default([]),
  confidence: z.enum(["low", "medium", "high"]),
  summary: z.string().min(20).max(900),
});

type VisionAnalysisResult = z.infer<typeof VisionAnalysisSchema>;

function dedupe(items: Array<string | null | undefined>): string[] {
  return [...new Set(items.filter((item): item is string => typeof item === "string" && item.trim().length > 0))];
}

function compactText(value: string | null | undefined, maxLen = 240): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLen - 3))}...`;
}

function readEnvString(key: string): string | null {
  const value = process.env[key];
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function supportsReasoningEffort(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized.startsWith("gpt-5") || normalized.startsWith("o");
}

function getMediaAnalyzerConfig(): { apiKey: string; model: string } | null {
  const apiKey = readEnvString("OPENAI_API_KEY");
  if (!apiKey) return null;
  return {
    apiKey,
    model: readEnvString("OPENAI_MEDIA_ANALYSIS_MODEL") ?? "gpt-4.1-mini",
  };
}

function mapPerceivedSizeToVolume(perceivedSize: string | null | undefined): {
  bucket: VolumeBucket;
  range: VolumeBucket;
} {
  switch ((perceivedSize ?? "").toLowerCase()) {
    case "single_item":
    case "few_items":
      return { bucket: "under_quarter", range: "under_quarter" };
    case "min_pickup":
      return { bucket: "quarter", range: "quarter" };
    case "small_area":
      return { bucket: "quarter_to_half", range: "quarter_to_half" };
    case "half_trailer":
      return { bucket: "half", range: "half" };
    case "one_room_or_half_garage":
      return { bucket: "half_to_three_quarters", range: "half_to_three_quarters" };
    case "three_quarter_trailer":
      return { bucket: "three_quarters", range: "three_quarters_to_full" };
    case "big_cleanout":
      return { bucket: "full_plus", range: "full_plus" };
    case "not_sure":
    default:
      return { bucket: "unknown", range: "unknown" };
  }
}

function widenVolumeRange(range: VolumeBucket): VolumeBucket {
  switch (range) {
    case "under_quarter":
      return "quarter";
    case "quarter":
      return "quarter_to_half";
    case "quarter_to_half":
      return "half";
    case "half":
      return "half_to_three_quarters";
    case "half_to_three_quarters":
      return "three_quarters";
    case "three_quarters":
      return "three_quarters_to_full";
    case "three_quarters_to_full":
      return "full";
    case "full":
      return "full_plus";
    default:
      return range;
  }
}

function bucketFromRange(range: VolumeBucket): VolumeBucket {
  switch (range) {
    case "quarter_to_half":
      return "half";
    case "half_to_three_quarters":
      return "three_quarters";
    case "three_quarters_to_full":
      return "full";
    default:
      return range;
  }
}

function volumeRank(value: VolumeBucket): number {
  const index = VOLUME_ORDER.indexOf(value);
  return index === -1 ? VOLUME_ORDER.length : index;
}

function maxVolume(left: VolumeBucket, right: VolumeBucket): VolumeBucket {
  return volumeRank(left) >= volumeRank(right) ? left : right;
}

function countKeyword(text: string, patterns: string[]): number {
  let best = 0;
  for (const pattern of patterns) {
    const regex = new RegExp(`(\\d+)\\s+${pattern}`, "gi");
    for (const match of text.matchAll(regex)) {
      const count = Number(match[1]);
      if (Number.isFinite(count) && count > best) best = count;
    }
  }

  if (best > 0) return best;
  return patterns.some((pattern) => new RegExp(`\\b${pattern}\\b`, "i").test(text)) ? 1 : 0;
}

function extractScopeSignals(messages: OmniLeadContext["recentMessages"], notes: string | null): {
  unpicturedScopeSignals: string[];
  sourceHints: string[];
  addOnHints: { mattresses: number; paintCans: number; tires: number };
} {
  const inboundText = messages
    .filter((message) => message.direction === "inbound")
    .map((message) => message.body)
    .join("\n");
  const sourceText = [notes, inboundText].filter(Boolean).join("\n").toLowerCase();
  const unpicturedScopeSignals = dedupe([
    /\b(also|plus|and also)\b/.test(sourceText) ? "Customer mentioned additional items beyond the main visible pile." : null,
    /\b(not pictured|not shown|didn'?t photo|didnt photo)\b/.test(sourceText)
      ? "Customer indicated some items are not shown in the media."
      : null,
    /\b(garage|basement|attic|upstairs|downstairs|backyard|shed|another room|other room|multiple rooms)\b/.test(sourceText)
      ? "Text suggests junk may be spread across additional areas."
      : null,
  ]);

  const sourceHints = dedupe([
    notes ? `Lead/quote notes: ${compactText(notes, 140)}` : null,
    inboundText ? `Recent inbound scope text captured from ${messages.filter((message) => message.direction === "inbound").length} message(s).` : null,
  ]);

  return {
    unpicturedScopeSignals,
    sourceHints,
    addOnHints: {
      mattresses: countKeyword(sourceText, ["mattress(?:es)?", "box\\s*springs?"]),
      paintCans: countKeyword(sourceText, ["paint\\s*cans?", "cans?\\s+of\\s+paint", "paint"]),
      tires: countKeyword(sourceText, ["tires?"]),
    },
  };
}

function buildScaffoldSceneGroups(mediaUrls: string[]): SceneGroupRecord[] | null {
  if (mediaUrls.length === 0) return null;
  return [
    {
      id: "uploaded_media_set",
      label: "Uploaded media set",
      mediaCount: mediaUrls.length,
      mediaUrls,
      notes: [
        "Scaffold grouping only. Model-based scene deduping was unavailable for this run.",
      ],
    },
  ];
}

function getCollectedMedia(context: OmniLeadContext): {
  mediaUrls: string[];
  photoUrls: string[];
  videoUrls: string[];
} {
  const mediaUrls = dedupe([
    ...(context.instantQuote?.photoUrls ?? []),
    ...context.recentMessages.flatMap((message) => message.mediaUrls ?? []),
  ]);
  const videoUrls = mediaUrls.filter((url) => /\.(mp4|mov|m4v|webm)(?:\?|#|$)/i.test(url));
  const photoUrls = mediaUrls.filter((url) => !videoUrls.includes(url));
  return { mediaUrls, photoUrls, videoUrls };
}

function buildStatedScope(context: OmniLeadContext, scopeSignals: ReturnType<typeof extractScopeSignals>): StatedScopeRecord {
  const notes = context.latestLead?.notes ?? context.instantQuote?.notes ?? null;
  return {
    perceivedSize: context.instantQuote?.perceivedSize ?? null,
    jobTypes: context.instantQuote?.jobTypes ?? context.latestLead?.servicesRequested ?? [],
    notes: compactText(notes, 500),
    sourceHints: scopeSignals.sourceHints,
    unpicturedScopeSignals: scopeSignals.unpicturedScopeSignals,
    addOnHints: scopeSignals.addOnHints,
  };
}

function buildScaffoldAnalysis(
  context: OmniLeadContext,
  options?: { reason?: string | null; modelOutput?: Record<string, unknown> | null },
): MediaJobAnalysisRecord {
  const { mediaUrls, photoUrls, videoUrls } = getCollectedMedia(context);
  const notes = context.latestLead?.notes ?? context.instantQuote?.notes ?? null;
  const statedVolume = mapPerceivedSizeToVolume(context.instantQuote?.perceivedSize ?? null);
  const scopeSignals = extractScopeSignals(context.recentMessages, notes);
  const shouldWidenForUnpicturedScope = scopeSignals.unpicturedScopeSignals.length > 0 && statedVolume.range !== "unknown";
  const mergedRange = shouldWidenForUnpicturedScope ? widenVolumeRange(statedVolume.range) : statedVolume.range;
  const mergedBucket = bucketFromRange(mergedRange);
  const riskFlags = dedupe([
    photoUrls.length === 0 && videoUrls.length === 0 ? "no_media_on_file" : null,
    photoUrls.length > 0 ? "awaiting_model_media_analysis" : null,
    videoUrls.length > 0 ? "video_frame_analysis_not_enabled_yet" : null,
    scopeSignals.unpicturedScopeSignals.length > 0 ? "stated_scope_exceeds_visible_media" : null,
    scopeSignals.addOnHints.mattresses > 0 || scopeSignals.addOnHints.paintCans > 0 || scopeSignals.addOnHints.tires > 0
      ? "add_on_counts_from_text_only"
      : null,
    options?.reason ? `vision_fallback:${options.reason}` : null,
  ]);
  const missingViews = dedupe([
    photoUrls.length === 0 && videoUrls.length === 0 ? "Add 2-4 photos or a quick walkthrough video to tighten the estimate." : null,
    scopeSignals.unpicturedScopeSignals.length > 0
      ? "Add one wide photo of any remaining rooms, garage, or areas not already shown."
      : null,
  ]);
  const confidence: "low" | "medium" | "high" =
    photoUrls.length === 0 && videoUrls.length === 0
      ? "low"
      : scopeSignals.unpicturedScopeSignals.length > 0
        ? "low"
        : "medium";

  const summaryParts = dedupe([
    mediaUrls.length > 0
      ? `Media on file: ${mediaUrls.length} item(s) (${photoUrls.length} photo${photoUrls.length === 1 ? "" : "s"}${videoUrls.length > 0 ? `, ${videoUrls.length} video${videoUrls.length === 1 ? "" : "s"}` : ""}).`
      : "No media on file yet.",
    statedVolume.range !== "unknown"
      ? `Stated size currently maps to ${statedVolume.range.replace(/_/g, " ")}.`
      : "Customer-selected size is not specific enough to map to a clear trailer range yet.",
    shouldWidenForUnpicturedScope
      ? `Text suggests more junk than the uploaded media may show, so the merged range is widened to ${mergedRange.replace(/_/g, " ")}.`
      : mergedRange !== "unknown"
        ? `Current merged range is ${mergedRange.replace(/_/g, " ")}.`
        : null,
    scopeSignals.addOnHints.mattresses > 0
      ? `Text hints at ${scopeSignals.addOnHints.mattresses} mattress${scopeSignals.addOnHints.mattresses === 1 ? "" : "es"}.`
      : null,
    scopeSignals.addOnHints.paintCans > 0
      ? `Text hints at ${scopeSignals.addOnHints.paintCans} paint can${scopeSignals.addOnHints.paintCans === 1 ? "" : "s"}.`
      : null,
    options?.reason ? `Vision analysis fallback reason: ${options.reason}.` : "Photo/video model reasoning is not available for this run, so this record is a merged scaffold from stated scope plus media presence.",
  ]);

  return {
    sourceChannel: context.derived.channelPreference,
    mediaCount: mediaUrls.length,
    videoCount: videoUrls.length,
    visibleVolumeBucket: "unknown",
    visibleVolumeRange: "unknown",
    mergedVolumeBucket: mergedBucket,
    mergedVolumeRange: mergedRange,
    visibleMattressCount: 0,
    visiblePaintCanCount: 0,
    visibleTireCount: 0,
    sceneGroupsJson: buildScaffoldSceneGroups(mediaUrls),
    statedScopeJson: buildStatedScope(context, scopeSignals),
    riskFlags,
    missingViews,
    confidence,
    summary: summaryParts.join(" "),
    rawModelOutputJson: {
      scaffold: true,
      fallbackReason: options?.reason ?? null,
      mediaUrls,
      photoUrls,
      videoUrls,
      statedVolume,
      scopeSignals,
      modelOutput: options?.modelOutput ?? null,
    },
    source: options?.reason ? "vision_fallback_scaffold_v1" : "scaffold_v1",
  };
}

function buildVisionPrompt(context: OmniLeadContext, photoUrls: string[]): { systemPrompt: string; userPrompt: string } {
  const notes = context.latestLead?.notes ?? context.instantQuote?.notes ?? null;
  const scopeSignals = extractScopeSignals(context.recentMessages, notes);
  const statedScope = buildStatedScope(context, scopeSignals);
  const statedVolume = mapPerceivedSizeToVolume(context.instantQuote?.perceivedSize ?? null);

  const systemPrompt = [
    "You analyze junk-removal job photos for trailer-volume estimating.",
    "The business prices by fractions of a 7x16x4 dumpster trailer.",
    "Your job is to estimate only what is visually present across all uploaded photos, while avoiding double-counting the same pile or item from different angles.",
    "",
    "Rules:",
    "- Treat all images as one job, not separate jobs.",
    "- Some photos may show the same pile from different angles. Do not count those twice.",
    "- Use trailer volume as the primary output. Item counts are secondary and mainly for add-ons.",
    "- If mattresses, paint cans, or tires are visible, count only what is reasonably visible.",
    "- If the photos are incomplete, say so in missing_views and lower confidence.",
    "- Do not estimate price. Only return structured estimating facts.",
    "- Return JSON only.",
  ].join("\n");

  const userLines = [
    `Photo count: ${photoUrls.length}`,
    `Customer-selected size: ${context.instantQuote?.perceivedSize ?? "unknown"}`,
    `Stated size maps to: bucket=${statedVolume.bucket}, range=${statedVolume.range}`,
    statedScope.notes ? `Notes: ${statedScope.notes}` : null,
    statedScope.jobTypes.length > 0 ? `Job types: ${statedScope.jobTypes.join(", ")}` : null,
    statedScope.unpicturedScopeSignals.length > 0
      ? `Text hints at extra unpictured scope: ${statedScope.unpicturedScopeSignals.join(" | ")}`
      : null,
    "Analyze only visible media for the visual estimate, but keep those text hints in mind when deciding confidence and missing views.",
    "For scene_groups.image_indices, use 1-based photo numbers in the order provided.",
  ].filter((line): line is string => Boolean(line));

  return {
    systemPrompt,
    userPrompt: userLines.join("\n"),
  };
}

async function callVisionAnalyzer(input: {
  apiKey: string;
  model: string;
  photoUrls: string[];
  systemPrompt: string;
  userPrompt: string;
}): Promise<{ ok: true; value: VisionAnalysisResult } | { ok: false; reason: string; detail?: string | null }> {
  const content: Array<Record<string, unknown>> = [
    { type: "input_text", text: input.userPrompt },
    ...input.photoUrls.map((url) => ({
      type: "input_image",
      image_url: url,
      detail: "high",
    })),
  ];

  const payload: Record<string, unknown> = {
    model: input.model,
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: input.systemPrompt }],
      },
      {
        role: "user",
        content,
      },
    ],
    max_output_tokens: 1400,
    text: {
      verbosity: "medium",
      format: {
        type: "json_schema",
        name: "media_job_analysis",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            visible_volume_bucket: { type: "string", enum: VOLUME_ORDER },
            visible_volume_range: { type: "string", enum: VOLUME_ORDER },
            visible_mattress_count: { type: "integer", minimum: 0, maximum: 20 },
            visible_paint_can_count: { type: "integer", minimum: 0, maximum: 60 },
            visible_tire_count: { type: "integer", minimum: 0, maximum: 20 },
            scene_groups: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  label: { type: "string" },
                  image_indices: {
                    type: "array",
                    items: { type: "integer", minimum: 1, maximum: 12 },
                  },
                  notes: {
                    type: "array",
                    items: { type: "string" },
                  },
                },
                required: ["label", "image_indices", "notes"],
              },
            },
            risk_flags: { type: "array", items: { type: "string" } },
            missing_views: { type: "array", items: { type: "string" } },
            confidence: { type: "string", enum: ["low", "medium", "high"] },
            summary: { type: "string" },
          },
          required: [
            "visible_volume_bucket",
            "visible_volume_range",
            "visible_mattress_count",
            "visible_paint_can_count",
            "visible_tire_count",
            "scene_groups",
            "risk_flags",
            "missing_views",
            "confidence",
            "summary",
          ],
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

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    console.warn("[media.analysis] openai_failed", {
      model: input.model,
      status: response.status,
      bodyText: bodyText.slice(0, 300),
    });
    return { ok: false, reason: "openai_request_failed", detail: bodyText.slice(0, 300) };
  }

  const data = (await response.json().catch(() => null)) as
    | { output_text?: unknown; output?: Array<{ content?: Array<{ text?: unknown }> }> }
    | null;

  const raw =
    (typeof data?.output_text === "string" ? data.output_text : null) ??
    data?.output
      ?.flatMap((item) => item.content ?? [])
      .find((chunk) => typeof chunk.text === "string")
      ?.text ??
    null;

  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, reason: "openai_empty_output" };
  }

  let parsedJson: unknown = null;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "openai_parse_failed", detail: raw.slice(0, 300) };
  }

  const parsed = VisionAnalysisSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "openai_schema_failed",
      detail: parsed.error.issues.slice(0, 3).map((issue) => issue.message).join(" | "),
    };
  }

  return { ok: true, value: parsed.data };
}

function mapSceneGroups(photoUrls: string[], sceneGroups: VisionAnalysisResult["scene_groups"]): SceneGroupRecord[] | null {
  if (sceneGroups.length === 0) return null;
  return sceneGroups.map((group, index) => {
    const groupUrls = dedupe(
      group.image_indices
        .map((photoIndex) => photoUrls[photoIndex - 1] ?? null),
    );
    return {
      id: `scene_${index + 1}`,
      label: group.label,
      mediaCount: groupUrls.length,
      mediaUrls: groupUrls,
      notes: group.notes,
    };
  });
}

function mergeVisionWithScope(input: {
  context: OmniLeadContext;
  photoUrls: string[];
  videoUrls: string[];
  vision: VisionAnalysisResult;
}): MediaJobAnalysisRecord {
  const scopeSignals = extractScopeSignals(
    input.context.recentMessages,
    input.context.latestLead?.notes ?? input.context.instantQuote?.notes ?? null,
  );
  const statedScope = buildStatedScope(input.context, scopeSignals);
  const statedVolume = mapPerceivedSizeToVolume(input.context.instantQuote?.perceivedSize ?? null);

  let mergedRange =
    input.vision.visible_volume_range !== "unknown"
      ? input.vision.visible_volume_range
      : statedVolume.range;

  if (
    statedVolume.range !== "unknown" &&
    volumeRank(statedVolume.range) > volumeRank(mergedRange) &&
    (scopeSignals.unpicturedScopeSignals.length > 0 || input.vision.confidence !== "high")
  ) {
    mergedRange = statedVolume.range;
  }

  if (scopeSignals.unpicturedScopeSignals.length > 0 && mergedRange !== "unknown") {
    mergedRange = widenVolumeRange(mergedRange);
  }

  const mergedBucket =
    input.vision.visible_volume_bucket !== "unknown" || mergedRange !== "unknown"
      ? maxVolume(input.vision.visible_volume_bucket, bucketFromRange(mergedRange))
      : "unknown";

  const visibleMattressCount = Math.max(input.vision.visible_mattress_count, statedScope.addOnHints.mattresses);
  const visiblePaintCanCount = Math.max(input.vision.visible_paint_can_count, statedScope.addOnHints.paintCans);
  const visibleTireCount = Math.max(input.vision.visible_tire_count, statedScope.addOnHints.tires);

  const riskFlags = dedupe([
    ...input.vision.risk_flags,
    input.videoUrls.length > 0 ? "video_frame_analysis_not_enabled_yet" : null,
    scopeSignals.unpicturedScopeSignals.length > 0 ? "stated_scope_exceeds_visible_media" : null,
    visibleMattressCount > input.vision.visible_mattress_count ||
    visiblePaintCanCount > input.vision.visible_paint_can_count ||
    visibleTireCount > input.vision.visible_tire_count
      ? "text_add_on_hints_exceed_visible_counts"
      : null,
  ]);

  const missingViews = dedupe([
    ...input.vision.missing_views,
    scopeSignals.unpicturedScopeSignals.length > 0
      ? "Add one wide photo of any remaining rooms, garage, or areas not already shown."
      : null,
  ]);

  const confidence: "low" | "medium" | "high" =
    scopeSignals.unpicturedScopeSignals.length > 0 && input.vision.confidence === "high"
      ? "medium"
      : input.vision.confidence;

  const summaryParts = dedupe([
    `Visual estimate: ${input.vision.visible_volume_range.replace(/_/g, " ")} with ${input.vision.confidence} confidence.`,
    input.context.instantQuote?.perceivedSize
      ? `Customer-selected size: ${input.context.instantQuote.perceivedSize.replace(/_/g, " ")}.`
      : null,
    mergedRange !== input.vision.visible_volume_range
      ? `Merged range widened to ${mergedRange.replace(/_/g, " ")} after combining visible junk with stated scope.`
      : `Merged range is ${mergedRange.replace(/_/g, " ")}.`,
    visibleMattressCount > 0
      ? `Mattress count used: ${visibleMattressCount}.`
      : null,
    visiblePaintCanCount > 0
      ? `Paint can count used: ${visiblePaintCanCount}.`
      : null,
    visibleTireCount > 0
      ? `Tire count used: ${visibleTireCount}.`
      : null,
    input.vision.summary,
  ]);

  return {
    sourceChannel: input.context.derived.channelPreference,
    mediaCount: input.photoUrls.length + input.videoUrls.length,
    videoCount: input.videoUrls.length,
    visibleVolumeBucket: input.vision.visible_volume_bucket,
    visibleVolumeRange: input.vision.visible_volume_range,
    mergedVolumeBucket: mergedBucket,
    mergedVolumeRange: mergedRange,
    visibleMattressCount,
    visiblePaintCanCount,
    visibleTireCount,
    sceneGroupsJson: mapSceneGroups(input.photoUrls, input.vision.scene_groups),
    statedScopeJson: statedScope,
    riskFlags,
    missingViews,
    confidence,
    summary: summaryParts.join(" "),
    rawModelOutputJson: {
      modelVision: input.vision,
      photoUrls: input.photoUrls,
      videoUrls: input.videoUrls,
      scopeSignals,
      statedVolume,
    },
    source: "vision_v1",
  };
}

export function buildMediaJobAnalysis(context: OmniLeadContext): MediaJobAnalysisRecord {
  return buildScaffoldAnalysis(context);
}

export async function buildMediaJobAnalysisWithVision(
  context: OmniLeadContext,
): Promise<MediaJobAnalysisRecord> {
  const { photoUrls, videoUrls } = getCollectedMedia(context);
  if (photoUrls.length === 0) {
    return buildScaffoldAnalysis(context, {
      reason: videoUrls.length > 0 ? "video_only_not_supported_yet" : "no_photo_media",
    });
  }

  const config = getMediaAnalyzerConfig();
  if (!config) {
    return buildScaffoldAnalysis(context, { reason: "openai_not_configured" });
  }

  const limitedPhotoUrls = photoUrls.slice(0, 8);
  const prompts = buildVisionPrompt(context, limitedPhotoUrls);
  const vision = await callVisionAnalyzer({
    apiKey: config.apiKey,
    model: config.model,
    photoUrls: limitedPhotoUrls,
    systemPrompt: prompts.systemPrompt,
    userPrompt: prompts.userPrompt,
  });

  if (!vision.ok) {
    return buildScaffoldAnalysis(context, {
      reason: vision.reason,
      modelOutput: vision.detail ? { detail: vision.detail } : null,
    });
  }

  return mergeVisionWithScope({
    context,
    photoUrls: limitedPhotoUrls,
    videoUrls,
    vision: vision.value,
  });
}

export async function getMediaJobAnalysis(db: DbExecutor, contactId: string) {
  const [row] = await db
    .select()
    .from(mediaJobAnalyses)
    .where(eq(mediaJobAnalyses.contactId, contactId))
    .limit(1);
  return row ?? null;
}

export async function upsertMediaJobAnalysis(
  db: DbExecutor,
  input: {
    contactId: string;
    leadId?: string | null;
    instantQuoteId?: string | null;
    analysis: MediaJobAnalysisRecord;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const values = {
    contactId: input.contactId,
    leadId: input.leadId ?? null,
    instantQuoteId: input.instantQuoteId ?? null,
    sourceChannel: input.analysis.sourceChannel,
    mediaCount: input.analysis.mediaCount,
    videoCount: input.analysis.videoCount,
    visibleVolumeBucket: input.analysis.visibleVolumeBucket,
    visibleVolumeRange: input.analysis.visibleVolumeRange,
    mergedVolumeBucket: input.analysis.mergedVolumeBucket,
    mergedVolumeRange: input.analysis.mergedVolumeRange,
    visibleMattressCount: input.analysis.visibleMattressCount,
    visiblePaintCanCount: input.analysis.visiblePaintCanCount,
    visibleTireCount: input.analysis.visibleTireCount,
    sceneGroupsJson: input.analysis.sceneGroupsJson,
    statedScopeJson: input.analysis.statedScopeJson,
    riskFlags: input.analysis.riskFlags,
    missingViews: input.analysis.missingViews,
    confidence: input.analysis.confidence,
    summary: input.analysis.summary,
    rawModelOutputJson: input.analysis.rawModelOutputJson,
    source: input.analysis.source,
    updatedAt: now,
    createdAt: now,
  };

  const [row] = await db
    .insert(mediaJobAnalyses)
    .values(values)
    .onConflictDoUpdate({
      target: mediaJobAnalyses.contactId,
      set: {
        leadId: values.leadId,
        instantQuoteId: values.instantQuoteId,
        sourceChannel: values.sourceChannel,
        mediaCount: values.mediaCount,
        videoCount: values.videoCount,
        visibleVolumeBucket: values.visibleVolumeBucket,
        visibleVolumeRange: values.visibleVolumeRange,
        mergedVolumeBucket: values.mergedVolumeBucket,
        mergedVolumeRange: values.mergedVolumeRange,
        visibleMattressCount: values.visibleMattressCount,
        visiblePaintCanCount: values.visiblePaintCanCount,
        visibleTireCount: values.visibleTireCount,
        sceneGroupsJson: values.sceneGroupsJson,
        statedScopeJson: values.statedScopeJson,
        riskFlags: values.riskFlags,
        missingViews: values.missingViews,
        confidence: values.confidence,
        summary: values.summary,
        rawModelOutputJson: values.rawModelOutputJson,
        source: values.source,
        updatedAt: now,
      },
    })
    .returning();

  return row ?? null;
}
