"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { LoaderCircle, Plus } from "lucide-react";
import {
  additionalServiceDraftId,
  parseAdditionalServicePage,
  type PartnerAdditionalServicePage,
} from "../lib/additional-service";
import {
  findPartnerJobAction,
  type PartnerJobActionAvailability,
} from "../lib/job-action-availability";
import { createPortalOperationKey, partnerPortalFetch } from "../lib/portal-v2";
import {
  PartnerNotice,
  PartnerStatusBadge,
  partnerPrimaryButtonClass,
  partnerSecondaryButtonClass,
} from "./PartnerPortalUi";

type Props = {
  accountId: string;
  membershipId: string;
  jobId: string;
  allowedActions: readonly string[];
  actionAvailability: readonly PartnerJobActionAvailability[];
};

/** A new resource identity remounts state before old responses can affect this job. */
export function PartnerAdditionalService(props: Props) {
  return (
    <AdditionalService
      key={`${props.accountId}:${props.membershipId}:${props.jobId}`}
      {...props}
    />
  );
}

function AdditionalService({
  accountId,
  membershipId,
  jobId,
  allowedActions,
  actionAvailability,
}: Props) {
  const router = useRouter();
  const canRequest =
    allowedActions.includes("request_additional_service") &&
    findPartnerJobAction(actionAvailability, "request_additional_service")
      ?.allowed === true;
  const [relationships, setRelationships] =
    React.useState<PartnerAdditionalServicePage | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  const [sendError, setSendError] = React.useState<string | null>(null);
  const mounted = React.useRef(false);
  const sendingRef = React.useRef(false);
  const controllers = React.useRef(new Set<AbortController>());
  const generation = React.useRef(0);
  const operationKey = React.useRef<string | null>(null);
  const storageKey = `partner-additional-service:${accountId}:${membershipId}:${jobId}`;

  const load = React.useCallback(
    async (cursor: string | null = null) => {
      const current = ++generation.current;
      setLoading(true);
      setLoadError(null);
      const controller = new AbortController();
      controllers.current.add(controller);
      const timeout = setTimeout(() => controller.abort(), 12_000);
      try {
        const params = new URLSearchParams({
          limit: "25",
          ...(cursor ? { cursor } : {}),
        });
        const result = await partnerPortalFetch<unknown>(
          `jobs/${encodeURIComponent(jobId)}/additional-service?${params}`,
          { signal: controller.signal },
        );
        if (!mounted.current || generation.current !== current) return;
        const page = result.ok
          ? parseAdditionalServicePage(result.data, jobId)
          : null;
        if (!page) {
          setLoadError(
            "Related jobs could not be loaded. Your jobs are unchanged.",
          );
          return;
        }
        setRelationships((previous) =>
          cursor && previous
            ? {
                ...page,
                jobs: [
                  ...previous.jobs,
                  ...page.jobs.filter(
                    (job) =>
                      !previous.jobs.some((entry) => entry.id === job.id),
                  ),
                ],
              }
            : page,
        );
      } catch {
        if (mounted.current && generation.current === current)
          setLoadError(
            "Related jobs could not be loaded. Your jobs are unchanged.",
          );
      } finally {
        clearTimeout(timeout);
        controllers.current.delete(controller);
        if (mounted.current && generation.current === current)
          setLoading(false);
      }
    },
    [jobId],
  );

  React.useEffect(() => {
    mounted.current = true;
    void load();
    const activeControllers = controllers.current;
    return () => {
      mounted.current = false;
      for (const controller of activeControllers) controller.abort();
    };
  }, [load]);

  async function requestAdditionalService() {
    if (!canRequest || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setSendError(null);
    const controller = new AbortController();
    controllers.current.add(controller);
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      if (!operationKey.current) {
        const stored = sessionStorage.getItem(storageKey);
        operationKey.current =
          stored && /^additional-service:[0-9a-f-]{36}$/iu.test(stored)
            ? stored
            : createPortalOperationKey("additional-service");
      }
      // Refuse to send unless retries can recover this operation after reload.
      sessionStorage.setItem(storageKey, operationKey.current);
      const result = await partnerPortalFetch<unknown>(
        `jobs/${encodeURIComponent(jobId)}/additional-service`,
        {
          method: "POST",
          signal: controller.signal,
          headers: { "Idempotency-Key": operationKey.current },
          body: JSON.stringify({}),
        },
      );
      if (!mounted.current) return;
      const draftId = result.ok
        ? additionalServiceDraftId(result.data, jobId)
        : null;
      if (!draftId) {
        setSendError(
          result.ok
            ? "The new request could not be verified. Try again to recover the same request."
            : result.error.message,
        );
        return;
      }
      // Retain the same key if the response is uncertain, including across reloads.
      sessionStorage.removeItem(storageKey);
      router.push(
        `/partners/book?draftId=${encodeURIComponent(draftId)}` as Route,
      );
    } catch {
      if (mounted.current)
        setSendError(
          "We couldn’t safely open the request. Keep this page open and try again, or contact Stonegate. The original job is unchanged.",
        );
    } finally {
      clearTimeout(timeout);
      controllers.current.delete(controller);
      if (mounted.current) {
        sendingRef.current = false;
        setSending(false);
      }
    }
  }

  if (
    !canRequest &&
    !relationships?.originalJob &&
    !relationships?.jobs.length &&
    !loading &&
    !loadError
  )
    return null;
  return (
    <section
      aria-label="Additional service and related jobs"
      className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 sm:p-5"
    >
      {canRequest ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold text-slate-950">
              Need more work at this location?
            </h2>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              Start a separate job. The original bill and payment stay
              unchanged.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void requestAdditionalService()}
            disabled={sending}
            className={partnerPrimaryButtonClass}
          >
            {sending ? (
              <LoaderCircle
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <Plus className="h-4 w-4" aria-hidden="true" />
            )}
            {sending ? "Opening request…" : "Request additional service"}
          </button>
        </div>
      ) : null}
      {sendError ? (
        <PartnerNotice tone="error">
          {sendError} Try again using the same button to retry the same request.
        </PartnerNotice>
      ) : null}
      {relationships?.originalJob ? (
        <p className="text-sm leading-6 text-slate-700">
          Additional service for{" "}
          <Link
            href={`/partners/bookings/${relationships.originalJob.id}` as Route}
            className="inline-flex min-h-11 items-center font-semibold text-primary-800 underline underline-offset-2"
          >
            original job{" "}
            {relationships.originalJob.id.slice(0, 8).toUpperCase()}
          </Link>
          . This job has its own schedule and billing; the original bill and
          payment stay unchanged.
        </p>
      ) : null}
      {relationships?.jobs.length ? (
        <div>
          <h2 className="font-semibold text-slate-950">
            Additional service jobs
          </h2>
          <ul className="mt-2 divide-y divide-slate-200">
            {relationships.jobs.map((job) => (
              <li
                key={job.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <Link
                  href={`/partners/bookings/${job.id}` as Route}
                  className="inline-flex min-h-11 items-center font-semibold text-primary-800 underline underline-offset-2"
                >
                  {job.serviceKey?.replaceAll("_", " ") ?? "Service request"} ·{" "}
                  {job.id.slice(0, 8).toUpperCase()}
                </Link>
                <PartnerStatusBadge status={job.status} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {loading ? (
        <p role="status" className="text-sm text-slate-600">
          Loading related jobs…
        </p>
      ) : null}
      {loadError ? (
        <PartnerNotice tone="warning">{loadError}</PartnerNotice>
      ) : null}
      {loadError || relationships?.page.hasMore ? (
        <button
          type="button"
          disabled={loading}
          className={partnerSecondaryButtonClass}
          onClick={() => void load(relationships?.page.nextCursor ?? null)}
        >
          {loadError ? "Try related jobs again" : "Load more additional jobs"}
        </button>
      ) : null}
    </section>
  );
}
