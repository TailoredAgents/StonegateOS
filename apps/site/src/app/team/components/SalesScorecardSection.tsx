import React from "react";
import { cookies } from "next/headers";
import { ADMIN_SESSION_COOKIE, getAdminKey } from "@/lib/admin-session";
import { callAdminApi } from "../lib/api";
import { SalesHqClient } from "./SalesHqClient";
import type { CallCoachingPayload, QueuePayload, ScorecardPayload, TeamMemberPayload } from "./sales.types";

export async function SalesScorecardSection(): Promise<React.ReactElement> {
  const rangeDays = 7;
  let scorecard: ScorecardPayload | null = null;
  let queue: QueuePayload | null = null;
  let teamMembers: TeamMemberPayload["members"] = [];
  let callCoaching: CallCoachingPayload | null = null;
  let error: string | null = null;

  const adminKey = getAdminKey();
  const jar = await cookies();
  const isOwnerSession = Boolean(adminKey && jar.get(ADMIN_SESSION_COOKIE)?.value === adminKey);

  try {
    const [scoreRes, queueRes, membersRes] = await Promise.all([
      callAdminApi(`/api/admin/sales/scorecard?rangeDays=${rangeDays}`),
      callAdminApi(`/api/admin/sales/queue`),
      callAdminApi(`/api/admin/team/members`)
    ]);

    if (scoreRes.ok) scorecard = (await scoreRes.json()) as ScorecardPayload;
    if (queueRes.ok) queue = (await queueRes.json()) as QueuePayload;
    if (membersRes.ok) {
      const payload = (await membersRes.json()) as TeamMemberPayload;
      teamMembers = payload.members ?? [];
    }

    if (!scoreRes.ok) error = `Scorecard unavailable (HTTP ${scoreRes.status})`;
    if (!queueRes.ok) error = error ?? `Queue unavailable (HTTP ${queueRes.status})`;
  } catch {
    error = "Sales HQ unavailable.";
  }

  const activeMemberId = scorecard?.memberId ?? queue?.memberId ?? null;
  if (!error && activeMemberId) {
    try {
      const coachingRes = await callAdminApi(
        `/api/admin/calls/coaching?rangeDays=${rangeDays}&memberId=${encodeURIComponent(activeMemberId)}`
      );
      if (coachingRes.ok) {
        callCoaching = (await coachingRes.json()) as CallCoachingPayload;
      }
    } catch {
      // optional
    }
  }

  const memberLabel =
    teamMembers?.find((member) => member.id === scorecard?.memberId)?.name ??
    teamMembers?.find((member) => member.id === queue?.memberId)?.name ??
    null;

  const trackingStartAt = typeof scorecard?.config?.trackingStartAt === "string" ? scorecard?.config?.trackingStartAt : null;

  return (
    <SalesHqClient
      rangeDays={rangeDays}
      memberLabel={memberLabel}
      trackingStartAt={trackingStartAt}
      scorecard={scorecard}
      queue={queue}
      teamMembers={teamMembers}
      callCoaching={callCoaching}
      error={error}
      isOwnerSession={isOwnerSession}
    />
  );
}

