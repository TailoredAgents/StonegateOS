"use server";
import {
  requireCurrentTeamPrincipal,
  hasTeamPermission,
} from "@/lib/team-principal";
import { callAdminApiAs } from "../lib/api";
import { StaffSchedulingConfigurationSchema } from "../lib/staff-scheduling-contract";
export type StaffResourceOption = {
  id: string;
  kind: "crew" | "truck" | "equipment";
  label: string;
  capacityUnits: number;
  skillKeys: string[];
};
export type StaffResourceOptions = {
  applicable: boolean;
  appointmentId: string;
  resources: StaffResourceOption[];
  requirements: {
    kind: string;
    quantity: number;
    capacityUnits: number;
    requiredSkillKeys: string[];
  }[];
  selectedResourceIds: string[];
  warning: string | null;
};
export async function loadStaffAppointmentResources(
  appointmentId: string,
): Promise<
  { ok: true; data: StaffResourceOptions } | { ok: false; message: string }
> {
  const principal = await requireCurrentTeamPrincipal();
  if (
    !hasTeamPermission(principal, "appointments.read") ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      appointmentId,
    )
  )
    return {
      ok: false,
      message: "Resource options are not available for this appointment.",
    };
  try {
    const response = await callAdminApiAs(
      principal,
      `/api/admin/scheduling/appointments/${appointmentId}/resources`,
      { timeoutMs: 8000 },
    );
    const data = (await response.json()) as StaffResourceOptions & {
      ok: boolean;
    };
    if (
      !response.ok ||
      !data.ok ||
      data.appointmentId !== appointmentId ||
      !Array.isArray(data.resources)
    )
      return {
        ok: false,
        message:
          "Resource options could not be verified. Refresh before choosing crew or equipment.",
      };
    return { ok: true, data };
  } catch {
    return {
      ok: false,
      message:
        "Resource options could not be loaded. The schedule has not changed.",
    };
  }
}
export async function loadStaffSchedulingConfiguration() {
  const principal = await requireCurrentTeamPrincipal();
  if (!hasTeamPermission(principal, "policy.read"))
    return {
      ok: false as const,
      message: "Scheduling policy access is required.",
    };
  try {
    const response = await callAdminApiAs(
      principal,
      "/api/admin/scheduling/resources",
      { timeoutMs: 8000 },
    );
    const payload: unknown = await response.json();
    const parsed = StaffSchedulingConfigurationSchema.safeParse(payload);
    return response.ok && parsed.success
      ? { ok: true as const, data: parsed.data }
      : {
          ok: false as const,
          message: "Scheduling configuration could not be loaded.",
        };
  } catch {
    return {
      ok: false as const,
      message: "Scheduling configuration could not be loaded.",
    };
  }
}
export async function saveStaffSchedulingConfiguration(input: {
  version: string;
  key: string;
  payload: unknown;
}) {
  const principal = await requireCurrentTeamPrincipal();
  if (
    !hasTeamPermission(principal, "policy.write") ||
    !/^[0-9a-f]{64}$/u.test(input.version) ||
    !/^[A-Za-z0-9._:-]{16,200}$/u.test(input.key)
  )
    return {
      ok: false,
      message: "Refresh your permission and the current configuration.",
    };
  try {
    const response = await callAdminApiAs(
      principal,
      "/api/admin/scheduling/resources",
      {
        method: "POST",
        headers: {
          "If-Match": `"${input.version}"`,
          "Idempotency-Key": input.key,
        },
        body: JSON.stringify(input.payload),
        timeoutMs: 12000,
      },
    );
    const payload: unknown = await response.json().catch(() => null);
    const data = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : null;
    return response.ok && data?.["ok"] === true
      ? {
          ok: true,
          message:
            "Scheduling configuration saved. Review existing assignments affected by the change.",
        }
      : {
          ok: false,
          message:
            typeof data?.["message"] === "string"
              ? data["message"]
              : "The change was not confirmed. Refresh and retry the same request.",
        };
  } catch {
    return {
      ok: false,
      message:
        "The outcome could not be confirmed. Retry this same change or refresh to inspect the saved configuration.",
    };
  }
}
