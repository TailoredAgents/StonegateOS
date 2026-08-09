import React from "react";
import {
  hasTeamPermission,
  requireCurrentTeamPrincipal,
} from "@/lib/team-principal";
import { callAdminApiAs } from "../lib/api";
import { teamSurfaceHref } from "../surface-registry";
import { SalesHqClient } from "./SalesHqClient";
import {
  CallReconciliationPanel,
  isCallReconciliationPayload,
  type CallReconciliationPayload,
} from "./CallReconciliationPanel";
import type {
  CallCoachingPayload,
  QueuePayload,
  SalesHqResourceErrors,
  SalesSupervisorPayload,
  ScorecardPayload,
  TeamMemberPayload,
} from "./sales.types";

type ResourceResult<T> = { data: T | null; error: string | null };

async function loadJsonResource<T>({
  label,
  request,
  isValid,
}: {
  label: string;
  request: () => Promise<Response>;
  isValid: (value: unknown) => value is T;
}): Promise<ResourceResult<T>> {
  try {
    const response = await request();
    if (!response.ok) {
      return {
        data: null,
        error: `${label} is unavailable (HTTP ${response.status}).`,
      };
    }
    const payload: unknown = await response.json().catch(() => null);
    if (!isValid(payload)) {
      return {
        data: null,
        error: `${label} returned an incomplete response. This is not an empty result.`,
      };
    }
    return { data: payload, error: null };
  } catch {
    return {
      data: null,
      error: `${label} is unavailable because the service could not be reached.`,
    };
  }
}

export async function SalesScorecardSection(): Promise<React.ReactElement> {
  const principal = await requireCurrentTeamPrincipal();
  const rangeDays = 7;
  let scorecard: ScorecardPayload | null = null;
  let queue: QueuePayload | null = null;
  let teamMembers: TeamMemberPayload["members"] = [];
  let callCoaching: CallCoachingPayload | null = null;
  let supervisor: SalesSupervisorPayload | null = null;
  let callReconciliation: CallReconciliationPayload | null = null;
  let callReconciliationError: string | null = null;
  const resourceErrors: SalesHqResourceErrors = {};

  const isOwnerSession = hasTeamPermission(principal, "sales.reset");
  const canPlaceCalls = hasTeamPermission(principal, "calls.place");
  const canReconcileCalls = hasTeamPermission(principal, "calls.reconcile");

  const [scoreResult, queueResult, membersResult] = await Promise.all([
    loadJsonResource<ScorecardPayload>({
      label: "Scorecard",
      request: () =>
        callAdminApiAs(
          principal,
          `/api/admin/sales/scorecard?rangeDays=${rangeDays}`,
        ),
      isValid: (value): value is ScorecardPayload =>
        Boolean(
          value &&
            typeof value === "object" &&
            (value as { ok?: unknown }).ok === true &&
            (value as { score?: unknown }).score,
        ),
    }),
    loadJsonResource<QueuePayload>({
      label: "Queue",
      request: () => callAdminApiAs(principal, "/api/admin/sales/queue"),
      isValid: (value): value is QueuePayload =>
        Boolean(
          value &&
            typeof value === "object" &&
            (value as { ok?: unknown }).ok === true &&
            Array.isArray((value as { items?: unknown }).items),
        ),
    }),
    loadJsonResource<TeamMemberPayload>({
      label: "Team member directory",
      request: () => callAdminApiAs(principal, "/api/admin/team/members"),
      isValid: (value): value is TeamMemberPayload =>
        Boolean(
          value &&
            typeof value === "object" &&
            Array.isArray((value as { members?: unknown }).members),
        ),
    }),
  ]);

  scorecard = scoreResult.data;
  queue = queueResult.data;
  teamMembers = membersResult.data?.members ?? [];
  if (scoreResult.error) resourceErrors.scorecard = scoreResult.error;
  if (queueResult.error) resourceErrors.queue = queueResult.error;
  if (membersResult.error) resourceErrors.teamMembers = membersResult.error;

  const activeMemberId = scorecard?.memberId ?? queue?.memberId ?? null;
  if (activeMemberId) {
    const [coachingResult, activityResult] = await Promise.all([
      loadJsonResource<CallCoachingPayload>({
        label: "Call coaching",
        request: () =>
          callAdminApiAs(
            principal,
            `/api/admin/calls/coaching?rangeDays=${rangeDays}&memberId=${encodeURIComponent(activeMemberId)}`,
          ),
        isValid: (value): value is CallCoachingPayload =>
          Boolean(
            value &&
              typeof value === "object" &&
              (value as { ok?: unknown }).ok === true &&
              Array.isArray((value as { items?: unknown }).items),
          ),
      }),
      loadJsonResource<{ supervisor: SalesSupervisorPayload }>({
        label: "Supervisor insights",
        request: () =>
          callAdminApiAs(
            principal,
            `/api/admin/sales/activity?rangeDays=${rangeDays}&limit=50&memberId=${encodeURIComponent(activeMemberId)}`,
          ),
        isValid: (value): value is { supervisor: SalesSupervisorPayload } =>
          Boolean(
            value &&
              typeof value === "object" &&
              (value as { supervisor?: unknown }).supervisor,
          ),
      }),
    ]);
    callCoaching = coachingResult.data;
    supervisor = activityResult.data?.supervisor ?? null;
    if (coachingResult.error) resourceErrors.coaching = coachingResult.error;
    if (activityResult.error) resourceErrors.supervisor = activityResult.error;
  } else {
    resourceErrors.coaching =
      "Call coaching cannot load until the queue or scorecard identifies an owner.";
    resourceErrors.supervisor =
      "Supervisor insights cannot load until the queue or scorecard identifies an owner.";
  }

  const memberLabel =
    teamMembers?.find((member) => member.id === scorecard?.memberId)?.name ??
    teamMembers?.find((member) => member.id === queue?.memberId)?.name ??
    null;

  const trackingStartAt =
    typeof scorecard?.config?.trackingStartAt === "string"
      ? scorecard?.config?.trackingStartAt
      : null;
  const salesHqHref = teamSurfaceHref("sales-hq");

  if (canReconcileCalls) {
    const reconciliationResult =
      await loadJsonResource<CallReconciliationPayload>({
        label: "Call reconciliation",
        request: () =>
          callAdminApiAs(principal, "/api/admin/calls/reconciliation"),
        isValid: isCallReconciliationPayload,
      });
    callReconciliation = reconciliationResult.data;
    callReconciliationError = reconciliationResult.error;
  }

  return (
    <section className="space-y-4">
      <nav
        aria-label="Sales HQ views"
        className="flex flex-wrap gap-2 rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-2"
      >
        <a
          href={`${salesHqHref}#sales-hq-queue`}
          className="inline-flex min-h-[44px] items-center rounded-xl bg-primary-50 px-4 py-2 text-sm font-semibold text-primary-800"
        >
          Queue
        </a>
        <a
          href={`${salesHqHref}#sales-hq-coaching`}
          className="inline-flex min-h-[44px] items-center rounded-xl px-4 py-2 text-sm font-semibold text-[color:var(--team-text-muted)] hover:bg-[color:var(--team-surface-muted)] hover:text-[color:var(--team-text)]"
        >
          Coaching
        </a>
        <a
          href={teamSurfaceHref("sales-log")}
          className="inline-flex min-h-[44px] items-center rounded-xl px-4 py-2 text-sm font-semibold text-[color:var(--team-text-muted)] hover:bg-[color:var(--team-surface-muted)] hover:text-[color:var(--team-text)]"
        >
          Activity
        </a>
      </nav>
      {canReconcileCalls ? (
        <CallReconciliationPanel
          data={callReconciliation}
          error={callReconciliationError}
        />
      ) : null}
      <SalesHqClient
        rangeDays={rangeDays}
        memberLabel={memberLabel}
        trackingStartAt={trackingStartAt}
        scorecard={scorecard}
        queue={queue}
        teamMembers={teamMembers}
        callCoaching={callCoaching}
        supervisor={supervisor}
        resourceErrors={resourceErrors}
        isOwnerSession={isOwnerSession}
        canPlaceCalls={canPlaceCalls}
      />
    </section>
  );
}
