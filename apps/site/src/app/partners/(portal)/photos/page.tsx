import type { Metadata, Route } from "next";
import Link from "next/link";
import { Camera, MapPin, ShieldCheck } from "lucide-react";
import { callPartnerApi } from "@/app/partners/lib/api";
import { getPartnerPortalContext } from "@/app/partners/lib/portal-context";
import { PartnerProofWorkspace } from "@/app/partners/components/PartnerProofWorkspace";
import type {
  PartnerJobSummary,
  PartnerProof,
} from "@/app/partners/lib/portal-v2";
import {
  PartnerEmptyState,
  PartnerErrorState,
  PartnerNotice,
  PartnerPageHeader,
  PartnerPanel,
  PartnerStatusBadge,
} from "@/app/partners/components/PartnerPortalUi";

export const metadata: Metadata = { title: "Photos & proof" };

function isJobSummary(value: unknown): value is PartnerJobSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["id"] === "string" && typeof record["status"] === "string"
  );
}

function isProof(value: unknown): value is PartnerProof {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record["media"]) &&
    Array.isArray(record["packages"]) &&
    Array.isArray(record["requirements"])
  );
}

function jobLabel(job: PartnerJobSummary): string {
  if (job.location.name?.trim()) return job.location.name;
  if (job.location.address)
    return `${job.location.address.line1}, ${job.location.address.city}`;
  return `Job ${job.id.slice(0, 8)}`;
}

function formatServiceDate(job: PartnerJobSummary): string {
  const value = job.schedule.arrivalWindow?.startAt;
  if (!value) return "Date pending";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Date pending";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: job.schedule.arrivalWindow?.timezone ?? "America/New_York",
    dateStyle: "medium",
  }).format(date);
}

export default async function PartnerPhotosPage({
  searchParams,
}: {
  searchParams?: Promise<{ jobId?: string; search?: string; cursor?: string }>;
}) {
  const params = (await searchParams) ?? {};
  const requestedJobId =
    typeof params.jobId === "string" ? params.jobId.trim() : "";
  const search =
    typeof params.search === "string" ? params.search.trim().slice(0, 100) : "";
  const cursor =
    typeof params.cursor === "string"
      ? params.cursor.trim().slice(0, 2048)
      : "";
  const query = new URLSearchParams({ limit: "25" });
  if (search) query.set("search", search);
  if (cursor) query.set("cursor", cursor);
  const photosHref = (values: { jobId?: string; cursor?: string } = {}) =>
    `/partners/photos?${new URLSearchParams({
      ...(search ? { search } : {}),
      ...(values.jobId ? { jobId: values.jobId } : {}),
      ...(values.cursor ? { cursor: values.cursor } : {}),
    }).toString()}` as Route;
  const [jobsResponse, portalContext, requestedResponse] = await Promise.all([
    callPartnerApi(`/api/portal/v2/jobs?${query}`).catch(() => null),
    getPartnerPortalContext(),
    requestedJobId
      ? callPartnerApi(
          `/api/portal/v2/jobs/${encodeURIComponent(requestedJobId)}`,
        ).catch(() => null)
      : Promise.resolve(null),
  ]);
  const requestedPayload = requestedResponse?.ok
    ? ((await requestedResponse.json().catch(() => null)) as {
        job?: PartnerJobSummary;
      } | null)
    : null;
  if (requestedJobId && !isJobSummary(requestedPayload?.job)) {
    return (
      <PartnerErrorState
        title="This job could not be opened"
        description="No other job has been selected. Open My jobs or contact Stonegate for help."
        retryHref={`/partners/photos?jobId=${encodeURIComponent(requestedJobId)}`}
      />
    );
  }
  if (!jobsResponse?.ok) {
    const unavailable = [404, 409, 501, 503].includes(
      jobsResponse?.status ?? 503,
    );
    return unavailable ? (
      <div className="space-y-5 sm:space-y-6">
        <PartnerPageHeader
          eyebrow="Job photos in one place"
          title="Photos & proof"
          description="Add job photos, see what proof is still needed, and keep the finished record easy to find."
          breadcrumbs={[
            { label: "Overview", href: "/partners/overview" },
            { label: "Photos & proof", href: "/partners/photos" },
          ]}
        />
        <PartnerPanel>
          <PartnerEmptyState
            title="Photo and proof tools are not available right now"
            description="No photos were uploaded or shared. Contact Stonegate and include the job you need documentation for."
            action={{ href: "/partners/help", label: "Ask for job documents" }}
            icon={<Camera className="h-6 w-6" aria-hidden="true" />}
          />
        </PartnerPanel>
      </div>
    ) : (
      <PartnerErrorState
        title="We couldn’t load Photos & proof"
        description="Your existing job media is unchanged. Try again in a moment."
        retryHref="/partners/photos"
      />
    );
  }
  const jobsPayload = (await jobsResponse.json().catch(() => null)) as {
    jobs?: unknown[];
    page?: { hasMore?: boolean; nextCursor?: string | null };
  } | null;
  const nextCursor = jobsPayload?.page?.hasMore
    ? jobsPayload.page.nextCursor
    : null;
  const jobs = (jobsPayload?.jobs ?? []).filter(isJobSummary);
  const selectedJob = requestedJobId
    ? requestedPayload!.job!
    : (jobs[0] ?? null);
  if (selectedJob && !jobs.some((job) => job.id === selectedJob.id))
    jobs.unshift(selectedJob);

  let proof: PartnerProof | null = null;
  let detailActions: string[] = [];
  let proofUnavailable = false;
  if (selectedJob) {
    const [proofResponse, detailResponse] = await Promise.all([
      callPartnerApi(
        `/api/portal/v2/jobs/${encodeURIComponent(selectedJob.id)}/proof`,
      ).catch(() => null),
      callPartnerApi(
        `/api/portal/v2/jobs/${encodeURIComponent(selectedJob.id)}`,
      ).catch(() => null),
    ]);
    if (proofResponse?.ok) {
      const payload = (await proofResponse.json().catch(() => null)) as {
        proof?: unknown;
      } | null;
      proof = isProof(payload?.proof) ? payload.proof : null;
    } else {
      proofUnavailable = [404, 409, 501, 503].includes(
        proofResponse?.status ?? 503,
      );
    }
    if (detailResponse?.ok) {
      const payload = (await detailResponse.json().catch(() => null)) as {
        job?: { allowedActions?: unknown };
      } | null;
      detailActions = Array.isArray(payload?.job?.allowedActions)
        ? payload.job.allowedActions.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
    }
  }

  return (
    <div className="space-y-5 sm:space-y-6">
      <PartnerPageHeader
        eyebrow="Job photos in one place"
        title="Photos & proof"
        description="Add job photos, see what proof is still needed, and download or share the finished record from one place."
        breadcrumbs={[
          { label: "Overview", href: "/partners/overview" },
          { label: "Photos & proof", href: "/partners/photos" },
        ]}
      >
        <div className="flex items-start gap-2 text-xs leading-5 text-slate-600">
          <ShieldCheck
            className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700"
            aria-hidden="true"
          />
          Job media remains private to authorized account members unless an
          expiring proof link is deliberately created.
        </div>
      </PartnerPageHeader>

      <PartnerPanel>
        <form
          action="/partners/photos"
          method="get"
          role="search"
          className="flex flex-wrap items-end gap-3"
        >
          {requestedJobId ? (
            <input type="hidden" name="jobId" value={requestedJobId} />
          ) : null}
          <label
            htmlFor="partner-proof-search"
            className="min-w-0 flex-1 text-sm font-medium text-slate-700"
          >
            Find a job
            <input
              id="partner-proof-search"
              name="search"
              type="search"
              defaultValue={search}
              maxLength={100}
              placeholder="Location or job reference"
              className="mt-1 block min-h-11 w-full rounded-lg border border-slate-300 px-3 text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-700"
            />
          </label>
          <button
            type="submit"
            className="min-h-11 rounded-lg bg-primary-900 px-4 text-sm font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-700"
          >
            Search jobs
          </button>
          {search || cursor ? (
            <Link
              href="/partners/photos"
              className="inline-flex min-h-11 items-center px-3 text-sm font-semibold text-primary-700"
            >
              Clear search
            </Link>
          ) : null}
        </form>
      </PartnerPanel>

      {!selectedJob ? (
        <PartnerPanel>
          <PartnerEmptyState
            title={search ? "No matching jobs" : "No job photos yet"}
            description={
              search
                ? "Try a different location or reference, or clear the search."
                : "Your job photos and completion records will appear here once available."
            }
            action={
              portalContext.status === "authenticated" &&
              portalContext.capabilities.schedule
                ? { href: "/partners/book", label: "Request service" }
                : { href: "/partners/bookings", label: "My jobs" }
            }
            icon={<Camera className="h-6 w-6" aria-hidden="true" />}
          />
        </PartnerPanel>
      ) : (
        <div className="grid gap-5 xl:grid-cols-[18rem_minmax(0,1fr)]">
          <PartnerPanel className="h-fit xl:sticky xl:top-24">
            <h2 className="font-semibold text-slate-950">
              Choose a job to view
            </h2>
            <nav
              aria-label="Jobs with proof"
              className="mt-3 max-h-[60vh] space-y-2 overflow-y-auto pr-1"
            >
              {jobs.map((job) => {
                const active = job.id === selectedJob.id;
                return (
                  <Link
                    key={job.id}
                    href={photosHref({ jobId: job.id, cursor })}
                    aria-current={active ? "page" : undefined}
                    className={`block rounded-xl border p-3 text-sm transition ${active ? "border-primary-500 bg-primary-50" : "border-slate-200 hover:border-primary-300"}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-semibold text-slate-950">
                        {jobLabel(job)}
                      </span>
                      <PartnerStatusBadge status={job.status} />
                    </div>
                    <span className="mt-1 flex items-center gap-1.5 text-xs text-slate-600">
                      <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                      {formatServiceDate(job)}
                    </span>
                  </Link>
                );
              })}
            </nav>
            <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-200 pt-3">
              {cursor ? (
                <Link
                  href={photosHref({ jobId: requestedJobId })}
                  className="inline-flex min-h-11 items-center px-2 text-sm font-semibold text-primary-700"
                >
                  Newest jobs
                </Link>
              ) : null}
              {nextCursor ? (
                <Link
                  href={photosHref({
                    jobId: selectedJob.id,
                    cursor: nextCursor,
                  })}
                  className="inline-flex min-h-11 items-center px-2 text-sm font-semibold text-primary-700"
                >
                  More jobs
                </Link>
              ) : null}
            </div>
          </PartnerPanel>

          <PartnerPanel>
            <div className="mb-5 border-b border-slate-200 pb-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary-700">
                    Selected job
                  </p>
                  <h2 className="mt-1 text-xl font-semibold text-slate-950">
                    {jobLabel(selectedJob)}
                  </h2>
                  <p className="mt-1 text-sm text-slate-600">
                    {formatServiceDate(selectedJob)}
                  </p>
                </div>
                <PartnerStatusBadge status={selectedJob.status} />
              </div>
            </div>
            {proof ? (
              <PartnerProofWorkspace
                accountId={
                  portalContext.status === "authenticated"
                    ? portalContext.accountId
                    : undefined
                }
                jobId={selectedJob.id}
                initialProof={proof}
                canUpload={
                  detailActions.includes("upload_media") &&
                  portalContext.status === "authenticated" &&
                  portalContext.permissions.uploadMedia
                }
                canShare={
                  detailActions.includes("create_proof_share") &&
                  portalContext.status === "authenticated" &&
                  portalContext.permissions.shareProof
                }
                persona={
                  portalContext.status === "authenticated"
                    ? portalContext.partnerType
                    : null
                }
              />
            ) : proofUnavailable ? (
              <PartnerEmptyState
                title="Photo and proof tools are unavailable for this job"
                description="No upload or share action was attempted, and the job record is unchanged. Open the job for its current details or contact Stonegate for help."
                action={{
                  href: `/partners/bookings/${selectedJob.id}`,
                  label: "Open job details",
                }}
                icon={<Camera className="h-6 w-6" aria-hidden="true" />}
              />
            ) : (
              <PartnerNotice tone="error">
                The proof response was incomplete. Refresh this page before
                uploading or sharing anything.
              </PartnerNotice>
            )}
          </PartnerPanel>
        </div>
      )}
    </div>
  );
}
