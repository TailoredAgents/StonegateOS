import type { Metadata } from "next";
import {
  Camera,
  CheckCircle2,
  Clock3,
  Download,
  ExternalLink,
  FileArchive,
  FileText,
  ShieldCheck,
} from "lucide-react";
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
    location: {
      name: string | null;
      city: string | null;
      state: string | null;
    };
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

const PROOF_SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/iu;

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedString(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength
  );
}

function boundedNullableString(
  value: unknown,
  maximumLength: number,
): value is string | null {
  return value === null || boundedString(value, maximumLength);
}

function validTimestamp(value: unknown): value is string {
  return boundedString(value, 64) && Number.isFinite(new Date(value).getTime());
}

function validNullableTimestamp(value: unknown): value is string | null {
  return value === null || validTimestamp(value);
}

function safeSignedWebUrl(value: unknown): value is string {
  if (!boundedString(value, 4_096)) return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "https:") return true;
    return (
      parsed.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function nullableSafeSignedWebUrl(value: unknown): value is string | null {
  return value === null || safeSignedWebUrl(value);
}

function nullableNonNegativeInteger(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  );
}

function isSharedDownload(value: unknown): value is SharedDownload {
  const download = objectRecord(value);
  return Boolean(
    download &&
      safeSignedWebUrl(download["url"]) &&
      boundedString(download["filename"], 255) &&
      boundedString(download["contentType"], 128) &&
      typeof download["byteSize"] === "number" &&
      Number.isSafeInteger(download["byteSize"]) &&
      download["byteSize"] >= 0 &&
      boundedString(download["checksumSha256"], 64) &&
      SHA256_PATTERN.test(download["checksumSha256"]) &&
      validTimestamp(download["expiresAt"]),
  );
}

function isSharedEvidence(value: unknown): value is SharedEvidence {
  const evidence = objectRecord(value);
  const media = objectRecord(evidence?.["media"]);
  return Boolean(
    evidence &&
      media &&
      boundedString(evidence["category"], 64) &&
      boundedNullableString(evidence["caption"], 2_000) &&
      validTimestamp(evidence["capturedAt"]) &&
      boundedNullableString(evidence["contentType"], 128) &&
      nullableNonNegativeInteger(evidence["byteSize"]) &&
      nullableNonNegativeInteger(evidence["width"]) &&
      nullableNonNegativeInteger(evidence["height"]) &&
      (evidence["sha256"] === null ||
        (boundedString(evidence["sha256"], 64) &&
          SHA256_PATTERN.test(evidence["sha256"]))) &&
      nullableSafeSignedWebUrl(media["thumbnailUrl"]) &&
      nullableSafeSignedWebUrl(media["displayUrl"]) &&
      nullableSafeSignedWebUrl(media["originalUrl"]) &&
      validTimestamp(media["expiresAt"]),
  );
}

function isSharedPackage(value: unknown): value is SharedProofPackage {
  const proof = objectRecord(value);
  const job = objectRecord(proof?.["job"]);
  const location = objectRecord(job?.["location"]);
  const downloads = objectRecord(proof?.["downloads"]);
  const service = job?.["service"];
  const promisedWindow = job?.["promisedArrivalWindow"];
  const evidence = proof?.["evidence"];
  const requirements = proof?.["requirements"];
  const pdf = downloads?.["pdf"];
  const originalMediaZip = downloads?.["originalMediaZip"];

  return Boolean(
    proof &&
      job &&
      location &&
      downloads &&
      typeof proof["version"] === "number" &&
      Number.isSafeInteger(proof["version"]) &&
      proof["version"] > 0 &&
      boundedString(proof["checksumSha256"], 64) &&
      SHA256_PATTERN.test(proof["checksumSha256"]) &&
      validTimestamp(proof["generatedAt"]) &&
      validTimestamp(proof["expiresAt"]) &&
      boundedNullableString(job["status"], 64) &&
      (service === null || objectRecord(service)) &&
      boundedNullableString(location["name"], 200) &&
      boundedNullableString(location["city"], 120) &&
      boundedNullableString(location["state"], 120) &&
      (promisedWindow === null || objectRecord(promisedWindow)) &&
      validNullableTimestamp(job["completedAt"]) &&
      Array.isArray(requirements) &&
      requirements.length <= 100 &&
      requirements.every((item) => Boolean(objectRecord(item))) &&
      Array.isArray(evidence) &&
      evidence.length <= 40 &&
      evidence.every(isSharedEvidence) &&
      (pdf === null || isSharedDownload(pdf)) &&
      (originalMediaZip === null || isSharedDownload(originalMediaZip)),
  );
}

function recordString(
  record: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = record?.[key];
  return boundedString(value, 200) ? value : null;
}

function humanize(value: string | null): string {
  if (!value) return "Service";
  return value
    .replace(/[-_]+/gu, " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function formatDate(value: string | null): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Not recorded";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "long",
    timeStyle: "short",
  }).format(date);
}

export default async function PartnerSharedProofPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!PROOF_SHARE_TOKEN_PATTERN.test(token)) {
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
          title="We couldn’t open this completion record"
          description="Try the link again shortly, or ask the sender for a new one."
        />
      </div>
    );
  }

  const payload = (await response.json().catch(() => null)) as {
    proofPackage?: unknown;
  } | null;
  if (!isSharedPackage(payload?.proofPackage)) {
    return (
      <div className="mx-auto max-w-2xl">
        <PartnerErrorState
          title="This completion record is incomplete"
          description="Ask the sender to create a new completion-proof link."
        />
      </div>
    );
  }

  const proof = payload.proofPackage;
  const serviceKey = recordString(proof.job.service, "key");
  const locationName =
    proof.job.location.name ||
    [proof.job.location.city, proof.job.location.state]
      .filter(Boolean)
      .join(", ") ||
    "Service location";
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
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent-200">
                Verified service record
              </p>
              <h1 className="mt-2 break-words text-2xl font-semibold tracking-tight sm:text-3xl">
                Service proof for {locationName}
              </h1>
              <p className="mt-2 text-sm text-primary-100">
                {humanize(serviceKey)} · completed{" "}
                {formatDate(proof.job.completedAt)}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2 rounded-xl bg-white/10 px-3 py-2 text-sm">
              <ShieldCheck
                className="h-5 w-5 text-accent-200"
                aria-hidden="true"
              />
              Package v{proof.version}
            </div>
          </div>
        </div>
        <div className="grid gap-4 px-5 py-5 text-sm sm:grid-cols-3 sm:px-8">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Job status
            </p>
            <div className="mt-2">
              <PartnerStatusBadge status={proof.job.status ?? "completed"} />
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Package generated
            </p>
            <p className="mt-2 font-semibold text-slate-950">
              {formatDate(proof.generatedAt)}
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Link expires
            </p>
            <p className="mt-2 inline-flex items-center gap-2 font-semibold text-slate-950">
              <Clock3
                className="h-4 w-4 shrink-0 text-slate-400"
                aria-hidden="true"
              />
              {formatDate(proof.expiresAt)}
            </p>
          </div>
        </div>
      </header>

      <PartnerNotice tone="info">
        This private, read-only link shows only this completed job. It cannot
        open the partner account or any other jobs.
      </PartnerNotice>

      {proof.downloads.pdf || proof.downloads.originalMediaZip ? (
        <PartnerPanel>
          <div className="flex items-start gap-3">
            <Download
              className="mt-0.5 h-5 w-5 shrink-0 text-primary-700"
              aria-hidden="true"
            />
            <div>
              <h2 className="font-semibold text-slate-950">
                Download completion records
              </h2>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                Download links are private and expire after five minutes.
                Refresh this page if a link has expired.
              </p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            {proof.downloads.pdf ? (
              <a
                href={proof.downloads.pdf.url}
                target="_blank"
                rel="noreferrer"
                referrerPolicy="no-referrer"
                className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-primary-800 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-primary-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2"
              >
                <FileText className="h-4 w-4" aria-hidden="true" />
                Download PDF summary
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            ) : null}
            {proof.downloads.originalMediaZip ? (
              <a
                href={proof.downloads.originalMediaZip.url}
                target="_blank"
                rel="noreferrer"
                referrerPolicy="no-referrer"
                className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-900 shadow-sm transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2"
              >
                <FileArchive className="h-4 w-4" aria-hidden="true" />
                Download original photos (ZIP)
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            ) : null}
          </div>
        </PartnerPanel>
      ) : null}

      {proof.evidence.length ? (
        [...evidenceGroups.entries()].map(([category, evidence]) => (
          <PartnerPanel key={category}>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-50 text-primary-700">
                <Camera className="h-5 w-5" aria-hidden="true" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                  Service photos
                </p>
                <h2 className="mt-0.5 text-lg font-semibold text-slate-950">
                  {humanize(category)}
                </h2>
              </div>
            </div>
            <ul className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {evidence.map((item, index) => {
                const preview =
                  item.media.displayUrl ?? item.media.thumbnailUrl;
                return (
                  <li
                    key={`${item.sha256 ?? item.capturedAt}-${index}`}
                    className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-slate-50"
                  >
                    <div className="flex aspect-[4/3] items-center justify-center bg-slate-100">
                      {preview ? (
                        // Signed media origins are intentionally not sent through image optimization.
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={preview}
                          alt={
                            item.caption?.trim() ||
                            `${humanize(item.category)} completion photo`
                          }
                          className="h-full w-full object-cover"
                          loading="lazy"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <Camera
                          className="h-10 w-10 text-slate-400"
                          aria-hidden="true"
                        />
                      )}
                    </div>
                    <div className="min-w-0 p-4">
                      {item.caption ? (
                        <p className="break-words text-sm leading-6 text-slate-700">
                          {item.caption}
                        </p>
                      ) : (
                        <p className="text-sm text-slate-500">No caption</p>
                      )}
                      <p className="mt-2 text-xs text-slate-500">
                        Captured {formatDate(item.capturedAt)}
                      </p>
                      {item.media.originalUrl ? (
                        <a
                          href={item.media.originalUrl}
                          target="_blank"
                          rel="noreferrer"
                          referrerPolicy="no-referrer"
                          className="mt-3 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-primary-800 underline underline-offset-4"
                        >
                          Open full size
                          <ExternalLink
                            className="h-4 w-4"
                            aria-hidden="true"
                          />
                          <span className="sr-only"> (opens in a new tab)</span>
                        </a>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </PartnerPanel>
        ))
      ) : (
        <PartnerPanel>
          <PartnerEmptyState
            title="No service photos were included"
            description="Ask the sender to check the proof requirements and create a new completion record."
            icon={<Camera className="h-6 w-6" aria-hidden="true" />}
          />
        </PartnerPanel>
      )}

      <PartnerPanel>
        <div className="flex items-start gap-3">
          <CheckCircle2
            className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <h2 className="font-semibold text-slate-950">
              Record verification
            </h2>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              Checksum:{" "}
              <code className="break-all rounded bg-slate-100 px-1 py-0.5 text-xs">
                {proof.checksumSha256}
              </code>
            </p>
            <p className="mt-2 text-xs leading-5 text-slate-500">
              This code identifies the fixed record created for this job. Photo
              links are short-lived; refresh the page if one expires.
            </p>
          </div>
        </div>
      </PartnerPanel>
    </div>
  );
}

function ExpiredProofState() {
  return (
    <div className="mx-auto max-w-2xl">
      <PartnerPanel>
        <PartnerEmptyState
          title="This completion link is no longer available"
          description="It may have expired, been turned off, or been copied incorrectly. Ask the sender for a new private link."
          icon={<ShieldCheck className="h-6 w-6" aria-hidden="true" />}
        />
      </PartnerPanel>
    </div>
  );
}
