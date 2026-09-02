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
  searchParams?: Promise<{ jobId?: string }>;
}) {
  const params = (await searchParams) ?? {};
  const [jobsResponse, portalContext] = await Promise.all([
    callPartnerApi("/api/portal/v2/jobs?limit=100").catch(() => null),
    getPartnerPortalContext(),
  ]);
  if (!jobsResponse?.ok) {
    const unavailable = [404, 409, 501, 503].includes(
      jobsResponse?.status ?? 503,
    );
    return unavailable ? (
      <div className="space-y-5 sm:space-y-6">
        <PartnerPageHeader
          eyebrow="Service documentation"
          title="Photos & proof"
          description="Upload private job photos, review before-and-after evidence, and manage completion packages."
          breadcrumbs={[
            { label: "Overview", href: "/partners/overview" },
            { label: "Photos & proof", href: "/partners/photos" },
          ]}
        />
        <PartnerPanel>
          <PartnerEmptyState
            title="The account proof workspace is not available yet"
            description="No photos were uploaded or shared. Contact Stonegate if you need documentation for a job."
            action={{ href: "/partners/help", label: "Request documentation" }}
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
  } | null;
  const jobs = (jobsPayload?.jobs ?? []).filter(isJobSummary);
  const requestedJobId =
    typeof params.jobId === "string" ? params.jobId.trim() : "";
  const selectedJob =
    jobs.find((job) => job.id === requestedJobId) ?? jobs[0] ?? null;

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
        eyebrow="Service documentation"
        title="Photos & proof"
        description="Upload private job photos, review evidence requirements, and create formal completion records and expiring share links."
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

      {!selectedJob ? (
        <PartnerPanel>
          <PartnerEmptyState
            title="No jobs available for proof"
            description="Schedule a job first. Its photo requirements and gallery will appear here."
            action={{ href: "/partners/book", label: "Schedule a job" }}
            icon={<Camera className="h-6 w-6" aria-hidden="true" />}
          />
        </PartnerPanel>
      ) : (
        <div className="grid gap-5 xl:grid-cols-[18rem_minmax(0,1fr)]">
          <PartnerPanel className="h-fit xl:sticky xl:top-24">
            <h2 className="font-semibold text-slate-950">Choose a job</h2>
            <nav
              aria-label="Jobs with proof"
              className="mt-3 max-h-[60vh] space-y-2 overflow-y-auto pr-1"
            >
              {jobs.map((job) => {
                const active = job.id === selectedJob.id;
                return (
                  <Link
                    key={job.id}
                    href={
                      `/partners/photos?jobId=${encodeURIComponent(job.id)}` as Route
                    }
                    aria-current={active ? "page" : undefined}
                    className={`block rounded-xl border p-3 text-sm transition ${active ? "border-primary-500 bg-primary-50" : "border-slate-200 hover:border-primary-300"}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-semibold text-slate-950">
                        {jobLabel(job)}
                      </span>
                      <PartnerStatusBadge status={job.status} />
                    </div>
                    <span className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
                      <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                      {formatServiceDate(job)}
                    </span>
                  </Link>
                );
              })}
            </nav>
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
                title="Proof service is not available for this job"
                description="No upload or share action was attempted. Existing job records are unchanged."
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
