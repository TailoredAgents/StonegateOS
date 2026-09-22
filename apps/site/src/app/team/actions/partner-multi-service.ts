"use server";
import { z } from "zod";
import {
  requireCurrentTeamPrincipal,
  hasTeamPermission,
} from "@/lib/team-principal";
import { callAdminApiAs } from "../lib/api";

const inputSchema = z.object({
  accountId: z.string().uuid(),
  bookingId: z.string().uuid(),
  version: z.number().int().positive(),
  key: z.string().uuid(),
  action: z.enum(["price", "visits", "visit-status", "visit-reschedule"]),
  visitId: z.string().uuid().optional(),
  body: z.record(z.unknown()),
});
export async function changePartnerServiceRequest(
  input: z.infer<typeof inputSchema>,
) {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false as const,
      message: "Refresh this request before saving.",
    };
  const principal = await requireCurrentTeamPrincipal();
  if (
    !hasTeamPermission(principal, "partners.accounts.read") ||
    !hasTeamPermission(
      principal,
      input.action === "price"
        ? "partners.commercial.manage"
        : "appointments.update",
    )
  )
    return {
      ok: false as const,
      message: "Your role cannot change this request.",
    };
  const suffix =
    input.action === "visit-status"
      ? `visits/${input.visitId}`
      : input.action === "visit-reschedule"
        ? `visits/${input.visitId}/schedule`
        : input.action;
  if (input.action.startsWith("visit-") && !input.visitId)
    return { ok: false as const, message: "Choose the visit to update." };
  try {
    const response = await callAdminApiAs(
      principal,
      `/api/admin/partner-management/v1/service-requests/${input.bookingId}/${suffix}`,
      {
        method: input.action === "visit-status" ? "PATCH" : "POST",
        headers: {
          "If-Match": `"${input.version}"`,
          "Idempotency-Key": input.key,
        },
        body: JSON.stringify({ ...input.body, accountId: input.accountId }),
        timeoutMs: 20000,
      },
    );
    const payload: unknown = await response.json().catch(() => null);
    const receipt = z
      .object({
        ok: z.literal(true),
        data: z
          .object({
            bookingId: z.string().uuid(),
            version: z.number().int().positive(),
          })
          .passthrough(),
      })
      .safeParse(payload);
    if (
      response.ok &&
      receipt.success &&
      receipt.data.data.bookingId === input.bookingId &&
      receipt.data.data.version > input.version
    )
      return { ok: true as const, data: receipt.data.data };
    const error = z.object({ message: z.string() }).safeParse(payload);
    return {
      ok: false as const,
      message: error.success
        ? error.data.message
        : "The change could not be verified. Retry the same change or refresh the request.",
    };
  } catch {
    return {
      ok: false as const,
      message:
        "The save could not be confirmed. Retry the same change or refresh to check its status.",
    };
  }
}

export async function loadPartnerVisitResources(
  accountId: string,
  bookingId: string,
) {
  if (
    !z.string().uuid().safeParse(accountId).success ||
    !z.string().uuid().safeParse(bookingId).success
  )
    return { ok: false as const, message: "Request not found." };
  const principal = await requireCurrentTeamPrincipal();
  try {
    const response = await callAdminApiAs(
      principal,
      `/api/admin/partner-management/v1/service-requests/${bookingId}/resources?accountId=${accountId}`,
      { timeoutMs: 10000 },
    );
    const parsed = z
      .object({
        ok: z.literal(true),
        resources: z.array(
          z.object({
            id: z.string().uuid(),
            label: z.string(),
            kind: z.enum(["crew", "truck", "equipment"]),
          }),
        ),
      })
      .safeParse(await response.json());
    return response.ok && parsed.success
      ? parsed.data
      : {
          ok: false as const,
          message: "Crew and equipment could not be loaded. Try again.",
        };
  } catch {
    return {
      ok: false as const,
      message: "Crew and equipment could not be loaded. Try again.",
    };
  }
}
