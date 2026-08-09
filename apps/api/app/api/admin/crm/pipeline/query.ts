import { PIPELINE_STAGE_SET, type PipelineStage } from "./stages";

export const PIPELINE_DEFAULT_PAGE_SIZE = 50;
export const PIPELINE_MAX_PAGE_SIZE = 100;
export const PIPELINE_MAX_OFFSET = 100_000;
export const PIPELINE_MAX_SEARCH_LENGTH = 120;

export type PipelineQuery = {
  q: string;
  stage: PipelineStage | null;
  offset: number;
  limit: number;
  excludeOutbound: boolean;
};

function boundedInteger(
  value: string | null,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === null || value.trim().length === 0) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

export function parsePipelineQuery(input: string | URL): PipelineQuery {
  const url = input instanceof URL ? input : new URL(input);
  const rawStage = url.searchParams.get("stage")?.trim().toLowerCase() ?? "";
  const stage = PIPELINE_STAGE_SET.has(rawStage)
    ? (rawStage as PipelineStage)
    : null;

  return {
    q: (url.searchParams.get("q") ?? "")
      .trim()
      .replace(/\s+/gu, " ")
      .slice(0, PIPELINE_MAX_SEARCH_LENGTH),
    stage,
    offset: boundedInteger(
      url.searchParams.get("offset"),
      0,
      0,
      PIPELINE_MAX_OFFSET,
    ),
    limit: boundedInteger(
      url.searchParams.get("limit"),
      PIPELINE_DEFAULT_PAGE_SIZE,
      1,
      PIPELINE_MAX_PAGE_SIZE,
    ),
    excludeOutbound: url.searchParams.get("excludeOutbound") === "1",
  };
}

export function pipelinePageWindow(
  total: number,
  offset: number,
  limit: number,
): {
  offset: number;
  limit: number;
  total: number;
  hasPrevious: boolean;
  hasNext: boolean;
} {
  const safeTotal = Math.max(0, Math.floor(total));
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(1, Math.floor(limit));
  return {
    offset: safeOffset,
    limit: safeLimit,
    total: safeTotal,
    hasPrevious: safeOffset > 0,
    hasNext: safeOffset + safeLimit < safeTotal,
  };
}
