"use server";

import { revalidatePath } from "next/cache";
import {
  requireCurrentTeamPrincipal,
  hasTeamPermission,
} from "@/lib/team-principal";
import { callAdminApiAs } from "../lib/api";

export type RescheduleReview = {
  id: string;
  jobId: string;
  appointmentId?: string | null;
  accountId: string;
  state: string;
  updatedAt: string;
  createdAt: string;
  preferredWindows: { localDate?: string; timeOfDay?: string }[];
  requestedArrivalStartAt: string | null;
  requestedArrivalEndAt: string | null;
  previousArrivalStartAt?: string | null;
  previousArrivalEndAt?: string | null;
  timezone?: string;
  siteName?: string | null;
};
export type RescheduleReviewDetail = {
  request: RescheduleReview;
  candidates: { startAt: string; windowStartAt: string; windowEndAt: string }[];
  warning: string | null;
};
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function loadPartnerRescheduleReviews(
  input: { id?: string; cursor?: string } = {},
): Promise<
  | {
      ok: true;
      items: RescheduleReview[];
      nextCursor: string | null;
      detail: RescheduleReviewDetail | null;
    }
  | { ok: false; message: string }
> {
  const principal = await requireCurrentTeamPrincipal();
  if (
    !hasTeamPermission(principal, "partners.accounts.read") ||
    !hasTeamPermission(principal, "appointments.read")
  )
    return { ok: false, message: "Your role cannot view these requests." };
  if ((input.id && !UUID.test(input.id)) || (input.cursor?.length ?? 0) > 4000)
    return { ok: false, message: "Refresh the request list." };
  const path =
    "/api/admin/partner-management/v1/reschedule-requests" +
    (input.id
      ? `/${input.id}`
      : `?${new URLSearchParams({ limit: "25", ...(input.cursor ? { cursor: input.cursor } : {}) })}`);
  try {
    const response = await callAdminApiAs(principal, path, {
      timeoutMs: 10_000,
    });
    if (!response.ok)
      return {
        ok: false,
        message: "The requests could not be loaded. No schedule was changed.",
      };
    const data = (await response.json()) as {
      ok: boolean;
      requests?: RescheduleReview[];
      page?: { nextCursor: string | null };
    } & Partial<RescheduleReviewDetail>;
    if (
      !data.ok ||
      (input.id &&
        (!data.request ||
          data.request.id !== input.id ||
          !Array.isArray(data.candidates)))
    )
      return {
        ok: false,
        message: "The request response could not be verified.",
      };
    return {
      ok: true,
      items: data.requests ?? [],
      nextCursor: data.page?.nextCursor ?? null,
      detail:
        data.request && data.candidates
          ? {
              request: data.request,
              candidates: data.candidates,
              warning: data.warning ?? null,
            }
          : null,
    };
  } catch {
    return {
      ok: false,
      message: "The requests could not be loaded. Try again.",
    };
  }
}

export async function decidePartnerRescheduleReview(input: {
  id: string;
  version: string;
  decision: "accepted" | "declined";
  reason: string;
  startAt?: string;
  selectedResourceIds?: string[];
  key: string;
}): Promise<{ ok: boolean; message: string }> {
  const principal = await requireCurrentTeamPrincipal();
  if (
    !hasTeamPermission(principal, "partners.accounts.read") ||
    !hasTeamPermission(principal, "appointments.update") ||
    !UUID.test(input.id) ||
    !Number.isFinite(Date.parse(input.version)) ||
    !/^[A-Za-z0-9._:-]{16,200}$/u.test(input.key) ||
    input.reason.trim().length < 12 ||
    input.reason.length > 1000
  )
    return {
      ok: false,
      message: "Review your permission and the decision details.",
    };
  try {
    const response = await callAdminApiAs(
      principal,
      `/api/admin/partner-management/v1/reschedule-requests/${input.id}/decision`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": input.key,
          "If-Match": `"${input.version}"`,
        },
        body: JSON.stringify({
          decision: input.decision,
          reason: input.reason,
          ...(input.startAt
            ? {
                startAt: input.startAt,
                selectedResourceIds: input.selectedResourceIds,
              }
            : {}),
        }),
      },
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        message?: string;
      } | null;
      return {
        ok: false,
        message:
          body?.message ||
          "The schedule change could not be confirmed. Refresh the request before deciding again.",
      };
    }
    revalidatePath("/team/partners");
    return {
      ok: true,
      message:
        input.decision === "accepted"
          ? "Replacement schedule confirmed."
          : "Request declined. The original schedule is unchanged.",
    };
  } catch {
    return {
      ok: false,
      message:
        "The outcome could not be confirmed. Retry this same decision or refresh to check its status.",
    };
  }
}
