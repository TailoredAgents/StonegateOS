import type { Metadata } from "next";
import { Camera, CheckCircle2, Clock3, Download, ExternalLink, FileArchive, FileText, ShieldCheck } from "lucide-react";
import { callPartnerPublicApi } from "@/app/partners/lib/api";
import {
  PartnerEmptyState,
  PartnerErrorState,
  PartnerNotice,
  PartnerPanel,
  PartnerStatusBadge,
} from "@/app/partners/components/PartnerPortalUi";

export const metadata: Metadata = {
  title: "Shared completion proof",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

type SharedEvidence = {
  category: string;
  caption: string | null;
  capturedAt: string;
  contentType: string | null;
  byteSize: number | null;
  width: number | null;
  height: number | null;
  sha256: string | null;
  media: {
    thumbnailUrl: string | null;
    displayUrl: string | null;
    originalUrl: string | null;
    expiresAt: string;
  };
};

type SharedProofPackage = {
  version: number;
  checksumSha256: string;
  generatedAt: string;
  expiresAt: string;
  job: {
    status: string | null;
    service: Record<string, unknown> | null;
    location: { name: string | null; city: string | null; state: string | null };
    promisedArrivalWindow: Record<string, unknown> | null;
    completedAt: string | null;
  };
  requirements: Array<Record<string, unknown>>;
  evidence: SharedEvidence[];
  downloads: {
    pdf: SharedDownload | null;
    originalMediaZip: SharedDownload | null;
  };
};

type SharedDownload = {
  url: string;
  filename: string;
  contentType: string;
  byteSize: number;
  checksumSha256: string;
  expiresAt: string;
};

function isSharedPackage(value: unknown): value is SharedProofPackage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record["version"] === "number" && Array.isArray(record["evidence"]) && typeof record["job"] === "object";
}

function recordString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}

function humanize(value: string | null): string {
  if (!value) return "Service";
  return value.replace(/[-_]+/gu, " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function formatDate(value: string | null): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Not recorded";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeStyle: "short" }).format(date);
}

export default async function PartnerSharedProofPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!token || token.length > 512) {
    return <ExpiredProofState />;
  }
  const response = await callPartnerPublicApi(
    `/api/portal/v2/proof-shares/${encodeURIComponent(token)}`,
    { timeoutMs: 20_000 },
  ).catch(() => null);
  if (!response?.ok) {
    if (response?.status === 404) return <ExpiredProofState />;
    return (
      <div className="mx-auto max-w-2xl">
        <PartnerErrorState
          title="This proof package is temporarily unavailable"
          description="The link was not changed. Try it again shortly or ask the sender for help."
        />
      </div>
    );
  }
  const payload = (await response.json().catch(() => null)) as { proofPackage?: unknown } | null;
  if (!isSharedPackage(payload?.proofPackage)) {
    return (
      <div className="mx-auto max-w-2xl">
        <PartnerErrorState
          title="This proof package was incomplete"
          description="Ask the sender to generate a new completion-proof link."
        />
      </div>
    );
  }
  const proof = payload.proofPackage;
  const serviceKey = recordString(proof.job.service, "key");
  const locationName = proof.job.location.name || [proof.job.location.city, proof.job.location.state].filter(Boolean).join(", ") || "Service location";
  const expiry = new Date(proof.expiresAt);
  const evidenceGroups = new Map<string, SharedEvidence[]>();
  for (const evidence of proof.evidence) {
    const group = evidenceGroups.get(evidence.category) ?? [];
    group.push(evidence);
    evidenceGroups.set(evidence.category, group);
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-5">
      <header className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-xl shadow-slate-200/50">
        <div className="bg-primary-900 px-5 py-6 text-white sm:px-8 sm:py-8">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
            <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent-200">Verified service record</p><h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">Completion proof for {locationName}</h1><p className="mt-2 text-sm text-primary-100">{humanize(serviceKey)} · completed {formatDate(proof.job.completedAt)}</p></div>
            <div className="flex shrink-0 items-center gap-2 rounded-xl bg-white/10 px-3 py-2 text-sm"><ShieldCheck className="h-5 w-5 text-accent-200" aria-hidden="true" />Package v{proof.version}</div>
          </div>
        </div>
        <div className="grid gap-4 px-5 py-5 text-sm sm:grid-cols-3 sm:px-8">
          <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Job status</p><div className="mt-2"><PartnerStatusBadge status={proof.job.status ?? "completed"} /></div></div>
          <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Package generated</p><p className="mt-2 font-semibold text-slate-950">{formatDate(proof.generatedAt)}</p></div>
          <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Link expires</p><p className="mt-2 inline-flex items-center gap-2 font-semibold text-slate-950"><Clock3 className="h-4 w-4 text-slate-400" aria-hidden="true" />{Number.isFinite(expiry.getTime()) ? formatDate(proof.expiresAt) : "Expiration unavailable"}</p></div>
        </div>
      </header>

      <PartnerNotice tone="info">
        This read-only link contains only the completion record selected by the sender. It does not provide access to the partner account or other jobs.
      </PartnerNotice>

      {proof.downloads?.pdf || proof.downloads?.originalMediaZip ? (
        <PartnerPanel>
          <div className="flex items-start gap-3"><Download className="mt-0.5 h-5 w-5 shrink-0 text-primary-700" aria-hidden="true" /><div><h2 className="font-semibold text-slate-950">Download completion records</h2><p className="mt-1 text-sm leading-6 text-slate-600">Download links are private and expire after five minutes. Refresh this page if a link has expired.</p></div></div>
          <div className="mt-4 flex flex-wrap gap-3">
            {proof.downloads.pdf ? <a href={proof.downloads.pdf.url} target="_blank" rel="noreferrer" referrerPolicy="no-referrer" className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-primary-800 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-primary-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2"><FileText className="h-4 w-4" aria-hidden="true" />Download PDF summary</a> : null}
            {proof.downloads.originalMediaZip ? <a href={proof.downloads.originalMediaZip.url} target="_blank" rel="noreferrer" referrerPolicy="no-referrer" className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-900 shadow-sm transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2"><FileArchive className="h-4 w-4" aria-hidden="true" />Download original photos (ZIP)</a> : null}
          </div>
        </PartnerPanel>
      ) : null}

      {proof.evidence.length ? (
        [...evidenceGroups.entries()].map(([category, evidence]) => (
          <PartnerPanel key={category}>
            <div className="flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-50 text-primary-700"><Camera className="h-5 w-5" aria-hidden="true" /></div><div><p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Photo evidence</p><h2 className="mt-0.5 text-lg font-semibold text-slate-950">{humanize(category)}</h2></div></div>
            <ul className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {evidence.map((item, index) => {
                const preview = item.media.displayUrl ?? item.media.thumbnailUrl;
                return <li key={`${item.sha256 ?? item.capturedAt}-${index}`} className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-50"><div className="flex aspect-[4/3] items-center justify-center bg-slate-100">{preview ? (
                  // Signed media origins are intentionally not sent through image optimization.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={preview} alt={item.caption?.trim() || `${humanize(item.category)} completion photo`} className="h-full w-full object-cover" loading="lazy" referrerPolicy="no-referrer" />
                ) : <Camera className="h-10 w-10 text-slate-400" aria-hidden="true" />}</div><div className="p-4">{item.caption ? <p className="text-sm leading-6 text-slate-700">{item.caption}</p> : <p className="text-sm text-slate-500">No caption</p>}<p className="mt-2 text-xs text-slate-500">Captured {formatDate(item.capturedAt)}</p>{item.media.originalUrl ? <a href={item.media.originalUrl} target="_blank" rel="noreferrer" referrerPolicy="no-referrer" className="mt-3 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-primary-800 underline underline-offset-4">Open full size<ExternalLink className="h-4 w-4" aria-hidden="true" /></a> : null}</div></li>;
              })}
            </ul>
          </PartnerPanel>
        ))
      ) : (
        <PartnerPanel><PartnerEmptyState title="No evidence is available in this package" description="Ask the sender to verify the proof requirements and generate a new package." icon={<Camera className="h-6 w-6" aria-hidden="true" />} /></PartnerPanel>
      )}

      <PartnerPanel>
        <div className="flex items-start gap-3"><CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" aria-hidden="true" /><div><h2 className="font-semibold text-slate-950">Package integrity</h2><p className="mt-1 text-sm leading-6 text-slate-600">Checksum: <code className="break-all rounded bg-slate-100 px-1 py-0.5 text-xs">{proof.checksumSha256}</code></p><p className="mt-2 text-xs leading-5 text-slate-500">The checksum identifies the immutable manifest used when this package was generated. Media links are short-lived and may need the proof page refreshed after five minutes.</p></div></div>
      </PartnerPanel>
    </div>
  );
}

function ExpiredProofState() {
  return (
    <div className="mx-auto max-w-2xl">
      <PartnerPanel>
        <PartnerEmptyState
          title="This proof link is unavailable"
          description="It may have expired, been revoked, or been copied incorrectly. Ask the sender to create a new private link."
          icon={<ShieldCheck className="h-6 w-6" aria-hidden="true" />}
        />
      </PartnerPanel>
    </div>
  );
}
