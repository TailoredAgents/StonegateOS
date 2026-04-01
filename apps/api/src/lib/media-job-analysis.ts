import { eq } from "drizzle-orm";
import { getDb, mediaJobAnalyses } from "@/db";
import type { OmniLeadContext } from "@/lib/omni-lead-context";

type DatabaseClient = ReturnType<typeof getDb>;
type TransactionExecutor =
  Parameters<DatabaseClient["transaction"]>[0] extends (tx: infer Tx) => Promise<unknown>
    ? Tx
    : never;
type DbExecutor = DatabaseClient | TransactionExecutor;

type VolumeBucket =
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

function buildSceneGroups(mediaUrls: string[]): SceneGroupRecord[] | null {
  if (mediaUrls.length === 0) return null;
  return [
    {
      id: "uploaded_media_set",
      label: "Uploaded media set",
      mediaCount: mediaUrls.length,
      mediaUrls,
      notes: [
        "Scaffold phase groups all uploaded media together until model-based scene deduping is added.",
      ],
    },
  ];
}

export function buildMediaJobAnalysis(context: OmniLeadContext): MediaJobAnalysisRecord {
  const mediaUrls = dedupe([
    ...(context.instantQuote?.photoUrls ?? []),
    ...context.recentMessages.flatMap((message) => message.mediaUrls ?? []),
  ]);
  const videoUrls = mediaUrls.filter((url) => /\.(mp4|mov|m4v|webm)(?:\?|#|$)/i.test(url));
  const photoUrls = mediaUrls.filter((url) => !videoUrls.includes(url));
  const notes = context.latestLead?.notes ?? context.instantQuote?.notes ?? null;
  const statedVolume = mapPerceivedSizeToVolume(context.instantQuote?.perceivedSize ?? null);
  const scopeSignals = extractScopeSignals(context.recentMessages, notes);
  const shouldWidenForUnpicturedScope = scopeSignals.unpicturedScopeSignals.length > 0 && statedVolume.range !== "unknown";
  const mergedRange = shouldWidenForUnpicturedScope ? widenVolumeRange(statedVolume.range) : statedVolume.range;
  const mergedBucket = bucketFromRange(mergedRange);
  const riskFlags = dedupe([
    photoUrls.length === 0 && videoUrls.length === 0 ? "no_media_on_file" : null,
    photoUrls.length > 0 || videoUrls.length > 0 ? "awaiting_model_media_analysis" : null,
    scopeSignals.unpicturedScopeSignals.length > 0 ? "stated_scope_exceeds_visible_media" : null,
    scopeSignals.addOnHints.mattresses > 0 || scopeSignals.addOnHints.paintCans > 0 || scopeSignals.addOnHints.tires > 0
      ? "add_on_counts_from_text_only"
      : null,
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
    "Photo/video model reasoning is not wired in yet, so this record is a merged scaffold from stated scope plus media presence.",
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
    sceneGroupsJson: buildSceneGroups(mediaUrls),
    statedScopeJson: {
      perceivedSize: context.instantQuote?.perceivedSize ?? null,
      jobTypes: context.instantQuote?.jobTypes ?? context.latestLead?.servicesRequested ?? [],
      notes: compactText(notes, 500),
      sourceHints: scopeSignals.sourceHints,
      unpicturedScopeSignals: scopeSignals.unpicturedScopeSignals,
      addOnHints: scopeSignals.addOnHints,
    },
    riskFlags,
    missingViews,
    confidence,
    summary: summaryParts.join(" "),
    rawModelOutputJson: {
      scaffold: true,
      mediaUrls,
      photoUrls,
      videoUrls,
      statedVolume,
      scopeSignals,
    },
    source: "scaffold_v1",
  };
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
