const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type RelatedPartnerJob = {
  id: string;
  status: string;
  serviceKey: string | null;
  createdAt: string;
};
export type PartnerAdditionalServicePage = {
  ok: true;
  originalJob: RelatedPartnerJob | null;
  jobs: RelatedPartnerJob[];
  page: { nextCursor: string | null; hasMore: boolean; limit: number };
};

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function relatedJob(value: unknown): value is RelatedPartnerJob {
  return (
    record(value) &&
    typeof value["id"] === "string" &&
    UUID.test(value["id"]) &&
    typeof value["status"] === "string" &&
    /^[a-z_]{1,80}$/u.test(value["status"]) &&
    (value["serviceKey"] === null ||
      (typeof value["serviceKey"] === "string" &&
        /^[a-z0-9_-]{1,120}$/u.test(value["serviceKey"]))) &&
    typeof value["createdAt"] === "string" &&
    Number.isFinite(Date.parse(value["createdAt"]))
  );
}

export function parseAdditionalServicePage(
  value: unknown,
  currentJobId: string,
): PartnerAdditionalServicePage | null {
  if (
    !record(value) ||
    value["ok"] !== true ||
    !record(value["page"]) ||
    !(value["originalJob"] === null || relatedJob(value["originalJob"])) ||
    !Array.isArray(value["jobs"]) ||
    value["jobs"].length > 25 ||
    !value["jobs"].every(relatedJob)
  )
    return null;
  const jobs = value["jobs"];
  const page = value["page"];
  const cursor = page["nextCursor"];
  if (
    !Number.isSafeInteger(page["limit"]) ||
    Number(page["limit"]) < 1 ||
    Number(page["limit"]) > 25 ||
    jobs.length > Number(page["limit"]) ||
    typeof page["hasMore"] !== "boolean" ||
    !(
      cursor === null ||
      (typeof cursor === "string" &&
        cursor.length > 0 &&
        cursor.length <= 4_000)
    ) ||
    page["hasMore"] !== (cursor !== null) ||
    new Set(jobs.map((job) => job.id)).size !== jobs.length ||
    jobs.some((job) => job.id === currentJobId) ||
    value["originalJob"]?.id === currentJobId
  )
    return null;
  return {
    ok: true,
    originalJob: value["originalJob"],
    jobs,
    page: {
      nextCursor: cursor,
      hasMore: page["hasMore"],
      limit: Number(page["limit"]),
    },
  };
}

export function additionalServiceDraftId(
  value: unknown,
  sourceJobId: string,
): string | null {
  if (!record(value) || value["ok"] !== true || !record(value["draft"]))
    return null;
  const draft = value["draft"];
  return typeof draft["id"] === "string" &&
    UUID.test(draft["id"]) &&
    draft["additionalServiceFromJobId"] === sourceJobId
    ? draft["id"]
    : null;
}
