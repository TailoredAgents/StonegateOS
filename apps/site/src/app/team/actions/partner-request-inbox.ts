"use server";
import {
  parsePartnerRequestInbox,
  parsePartnerRequestInboxDetail,
  PARTNER_REQUEST_KINDS,
  PARTNER_REQUEST_STAGES,
} from "@myst-os/sdk";
import { requireCurrentTeamPrincipal } from "@/lib/team-principal";
import { callAdminApiAs } from "../lib/api";

const BASE = "/api/admin/partner-management/v1";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export async function loadPartnerRequestInbox(
  input: {
    status?: string;
    kind?: string;
    accountId?: string;
    q?: string;
    cursor?: string;
    alertGroupId?: string;
    limit?: number;
  } = {},
) {
  const principal = await requireCurrentTeamPrincipal();
  const query = new URLSearchParams({ limit: String(input.limit ?? 25) });
  if (input.status && PARTNER_REQUEST_STAGES.includes(input.status as never))
    query.set("status", input.status);
  if (input.kind && PARTNER_REQUEST_KINDS.includes(input.kind as never))
    query.set("kind", input.kind);
  for (const key of ["accountId", "alertGroupId"] as const)
    if (input[key]) {
      if (!UUID.test(input[key]))
        return {
          ok: false as const,
          message:
            "This request link is invalid. Return to Requests and try again.",
        };
      query.set(key, input[key]);
    }
  if (input.q) query.set("q", input.q.slice(0, 100));
  if (input.cursor) query.set("cursor", input.cursor.slice(0, 4000));
  try {
    const response = await callAdminApiAs(
      principal,
      `${BASE}/request-inbox?${query}`,
      { timeoutMs: 10_000 },
    );
    const data = response.ok
      ? parsePartnerRequestInbox(await response.json())
      : null;
    return data
      ? { ok: true as const, data }
      : {
          ok: false as const,
          message:
            response.status === 403
              ? "Your role cannot view these requests."
              : "Requests could not be refreshed. Try again; your current work is unchanged.",
        };
  } catch {
    return {
      ok: false as const,
      message: "Requests are temporarily unavailable. Try again.",
    };
  }
}
export async function loadPartnerRequestDetail(
  key: string,
  accountId?: string,
) {
  const principal = await requireCurrentTeamPrincipal();
  const [kind, id, extra] = key.split(":");
  if (
    extra ||
    !PARTNER_REQUEST_KINDS.includes(kind as never) ||
    !id ||
    !UUID.test(id) ||
    (accountId && !UUID.test(accountId))
  )
    return { ok: false as const, message: "This request link is invalid." };
  try {
    const query = accountId
      ? `?accountId=${encodeURIComponent(accountId)}`
      : "";
    const response = await callAdminApiAs(
      principal,
      `${BASE}/request-inbox/${kind}/${id}${query}`,
      { timeoutMs: 10_000 },
    );
    const data = response.ok
      ? parsePartnerRequestInboxDetail(await response.json())
      : null;
    return data &&
      data.request.key === key &&
      (!accountId || data.request.accountId === accountId) &&
      (["service", "reschedule"].includes(data.request.kind) ||
        (data.record?.["id"] === id &&
          Number.isSafeInteger(data.record?.["revision"]) &&
          Number(data.record?.["revision"]) > 0 &&
          typeof data.record?.["state"] === "string"))
      ? { ok: true as const, data }
      : {
          ok: false as const,
          message:
            "This request could not be loaded. It may no longer be available to your role. Try again.",
        };
  } catch {
    return {
      ok: false as const,
      message: "This request is temporarily unavailable. Try again.",
    };
  }
}
export async function markPartnerRequestOpened(input: {
  groupId?: string;
  bookingId?: string;
}) {
  const principal = await requireCurrentTeamPrincipal();
  const id = input.groupId ?? input.bookingId;
  if (!id || !UUID.test(id)) return false;
  try {
    const response = await callAdminApiAs(
      principal,
      `${BASE}/owner-alerts/${input.groupId ? "groups" : "requests"}/${id}/opened`,
      { method: "POST", body: "{}" },
    );
    const data: unknown = await response.json().catch(() => null);
    return (
      response.ok &&
      !!data &&
      typeof data === "object" &&
      "ok" in data &&
      data.ok === true &&
      "opened" in data &&
      data.opened === true
    );
  } catch {
    return false;
  }
}
