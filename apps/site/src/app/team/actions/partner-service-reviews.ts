"use server";
import {
  hasTeamPermission,
  requireCurrentTeamPrincipal,
} from "@/lib/team-principal";
import { callAdminApiAs } from "../lib/api";
import {
  parsePartnerRequestDetails,
  parsePartnerRequestPhotos,
  type PartnerRequestDetails,
  type PartnerRequestPhoto,
} from "@myst-os/sdk";

export type PartnerServiceReview = {
  id: string;
  accountId: string;
  accountName: string;
  status: string;
  createdAt: string;
  service: string;
  siteName: string;
  preferredWindows: { localDate: string; timeOfDay: string }[];
  reasons: string[];
  originalJob: {
    id: string;
    status: string;
    serviceKey: string | null;
    createdAt: string;
  } | null;
  appointmentId?: string | null;
  arrivalStartAt?: string | null;
  arrivalEndAt?: string | null;
};
export type PartnerServiceReviewDetail = PartnerServiceReview & {
  partnerRequest?: PartnerRequestDetails | null;
  location: {
    name: string;
    timezone: string;
    address: {
      line1: string;
      line2: string | null;
      city: string;
      state: string;
      postalCode: string;
    };
  } | null;
  description: string;
  crewInstructions: string;
  onSiteContact: { name: string; phone: string; email: string };
  scopeFields: { label: string; value: string }[];
  proof: { before: number; after: number };
  photos: PartnerRequestPhoto[];
  appointment: {
    id: string;
    type: string | null;
    startAt: string | null;
    status: string;
    version: string;
  };
  canSchedule: boolean;
};
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export async function loadPartnerServiceReviews(
  input: {
    accountId?: string;
    id?: string;
    q?: string;
    cursor?: string;
    includeScheduled?: boolean;
  } = {},
): Promise<
  | {
      ok: true;
      items: PartnerServiceReview[];
      nextCursor: string | null;
      detail: PartnerServiceReviewDetail | null;
    }
  | { ok: false; message: string }
> {
  const principal = await requireCurrentTeamPrincipal();
  if (
    !hasTeamPermission(principal, "partners.accounts.read") ||
    !hasTeamPermission(principal, "appointments.read")
  )
    return { ok: false, message: "Your role cannot view service requests." };
  if (
    (input.id && (!UUID.test(input.id) || !input.accountId)) ||
    (input.accountId && !UUID.test(input.accountId)) ||
    (input.includeScheduled !== undefined &&
      typeof input.includeScheduled !== "boolean") ||
    (input.includeScheduled && !input.accountId) ||
    (input.q?.length ?? 0) > 100 ||
    (input.cursor?.length ?? 0) > 4000
  )
    return {
      ok: false,
      message: "Refresh the request list or shorten the search.",
    };
  const params = new URLSearchParams(
    input.id
      ? { accountId: input.accountId! }
      : {
          limit: "25",
          ...(input.q ? { q: input.q } : {}),
          ...(input.cursor ? { cursor: input.cursor } : {}),
          ...(input.accountId ? { accountId: input.accountId } : {}),
          ...(input.includeScheduled ? { includeScheduled: "true" } : {}),
        },
  );
  try {
    const response = await callAdminApiAs(
      principal,
      "/api/admin/partner-management/v1/service-requests" +
        (input.id ? "/" + input.id : "") +
        "?" +
        params.toString(),
      { timeoutMs: 10_000 },
    );
    if (!response.ok)
      return {
        ok: false,
        message: "Service requests could not be loaded. Nothing was changed.",
      };
    const data = (await response.json()) as {
      ok?: boolean;
      requests?: PartnerServiceReview[];
      page?: { nextCursor: string | null };
      request?: PartnerServiceReviewDetail;
    };
    if (
      !data.ok ||
      (input.id
        ? data.request?.id !== input.id ||
          data.request?.accountId !== input.accountId ||
          !Array.isArray(data.request.photos)
        : !Array.isArray(data.requests) ||
          (input.accountId &&
            data.requests.some((item) => item.accountId !== input.accountId)))
    )
      return {
        ok: false,
        message: "The service request response could not be verified.",
      };
    if (data.request) {
      const photos = parsePartnerRequestPhotos(data.request.photos);
      if (!photos)
        return {
          ok: false,
          message:
            "The request photos could not be verified. Refresh this request before reviewing them.",
        };
      data.request.photos = photos;
    }
    if (data.request?.partnerRequest != null) {
      const partnerRequest = parsePartnerRequestDetails(
        data.request.partnerRequest,
      );
      if (
        !partnerRequest ||
        partnerRequest.jobId !== input.id ||
        partnerRequest.accountId !== input.accountId
      ) {
        return {
          ok: false,
          message:
            "The submitted partner details could not be verified. Refresh this request before reviewing it.",
        };
      }
      data.request.partnerRequest = partnerRequest;
    }
    return {
      ok: true,
      items: data.requests ?? [],
      nextCursor: data.page?.nextCursor ?? null,
      detail: data.request ?? null,
    };
  } catch {
    return {
      ok: false,
      message: "Service requests are temporarily unavailable. Try again.",
    };
  }
}
