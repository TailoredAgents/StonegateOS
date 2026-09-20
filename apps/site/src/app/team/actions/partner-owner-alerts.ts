"use server";
import { z } from "zod";
import { requireCurrentTeamPrincipal } from "@/lib/team-principal";
import { callAdminApiAs } from "../lib/api";
const owner = z.object({
  id: z.string().uuid(),
  name: z.string(),
  phoneLastFour: z.string().nullable(),
  ready: z.boolean(),
});
const schema = z.object({
  ok: z.literal(true),
  settings: z.object({
    enabled: z.boolean(),
    ownerTeamMemberId: z.string().uuid().nullable(),
    ownerName: z.string().nullable(),
    phoneLastFour: z.string().nullable(),
    ready: z.boolean(),
    revision: z.number().int().nonnegative(),
    enabledSince: z.string().nullable(),
  }),
  canManage: z.boolean(),
  owners: z.array(owner),
  deliveryProblems: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      state: z.string(),
      detail: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
});
export type PartnerOwnerAlertPayload = z.infer<typeof schema>;
const BASE = "/api/admin/partner-management/v1/owner-alerts";
export async function loadPartnerOwnerAlerts() {
  const principal = await requireCurrentTeamPrincipal();
  try {
    const response = await callAdminApiAs(principal, `${BASE}/settings`);
    const parsed = response.ok ? schema.safeParse(await response.json()) : null;
    return parsed?.success
      ? { ok: true as const, data: parsed.data }
      : {
          ok: false as const,
          message: "Owner alert settings could not be loaded. Try again.",
        };
  } catch {
    return {
      ok: false as const,
      message: "Owner alert settings are temporarily unavailable.",
    };
  }
}
export async function savePartnerOwnerAlerts(input: {
  enabled: boolean;
  ownerTeamMemberId: string | null;
  revision: number;
  key: string;
}) {
  const principal = await requireCurrentTeamPrincipal();
  if (
    !z
      .object({
        enabled: z.boolean(),
        ownerTeamMemberId: z.string().uuid().nullable(),
        revision: z.number().int().nonnegative(),
        key: z
          .string()
          .min(16)
          .max(199)
          .regex(/^[A-Za-z0-9._:-]+$/u),
      })
      .safeParse(input).success
  )
    return {
      ok: false as const,
      message: "Review the settings and try again.",
    };
  try {
    const response = await callAdminApiAs(principal, `${BASE}/settings`, {
      method: "PATCH",
      headers: {
        "If-Match": String(input.revision),
        "Idempotency-Key": input.key,
      },
      body: JSON.stringify({
        enabled: input.enabled,
        ownerTeamMemberId: input.ownerTeamMemberId,
      }),
    });
    const body: unknown = response.ok ? await response.json() : null;
    const receipt = z
      .object({ ok: z.literal(true), data: schema })
      .safeParse(body);
    const parsed = receipt.success
      ? { success: true as const, data: receipt.data.data }
      : null;
    return parsed?.success
      ? { ok: true as const, data: parsed.data }
      : {
          ok: false as const,
          message:
            response.status === 412 || response.status === 409
              ? "These settings changed. Reload them before saving again."
              : "The settings could not be confirmed. Retry to check this same update.",
        };
  } catch {
    return {
      ok: false as const,
      message: "The update could not be confirmed. Retry this same update.",
    };
  }
}
export async function testPartnerOwnerAlert(input: {
  revision: number;
  key: string;
}) {
  const principal = await requireCurrentTeamPrincipal();
  if (
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0 ||
    !/^[A-Za-z0-9._:-]{16,199}$/u.test(input.key)
  )
    return { ok: false, message: "Reload settings before testing." };
  try {
    const response = await callAdminApiAs(principal, `${BASE}/test`, {
      method: "POST",
      headers: {
        "If-Match": String(input.revision),
        "Idempotency-Key": input.key,
      },
      body: "{}",
    });
    const data: unknown = await response.json().catch(() => null);
    const receipt = z
      .object({
        ok: z.literal(true),
        data: z.object({ operationId: z.string(), state: z.literal("queued") }),
      })
      .safeParse(data);
    return response.ok && receipt.success
      ? {
          ok: true,
          message:
            "Test message queued. This is a test, not a service request.",
        }
      : {
          ok: false,
          message:
            "The test could not be queued. Reload the settings and try again.",
        };
  } catch {
    return {
      ok: false,
      message:
        "The test result could not be confirmed. Retry to check the same test.",
    };
  }
}
