"use server";
import { revalidatePath } from "next/cache";
import { requireCurrentTeamPrincipal } from "@/lib/team-principal";
import { callAdminApiAs } from "../../lib/api";

export async function integrationAction(
  _previous: { message: string; token?: string },
  form: FormData,
): Promise<{ message: string; token?: string }> {
  const principal = await requireCurrentTeamPrincipal();
  if (principal.roleSlug !== "owner")
    return { message: "Owner access required" };
  const field = (name: string): string => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  const action = field("action");
  const command =
    action === "create"
      ? { action, name: field("name"), days: 30 }
      : action === "revoke" || action === "enable_individual_sms"
        ? { action, id: field("id") }
        : {
            action,
            id: field("id"),
            payloadHash: field("payloadHash"),
          };
  try {
    const response = await callAdminApiAs(
      principal,
      "/api/admin/agent-integrations",
      { method: "POST", body: JSON.stringify(command) },
    );
    const result = (await response.json()) as {
      token?: unknown;
      error?: unknown;
    };
    revalidatePath("/team/tools/integrations");
    return response.ok
      ? {
          message:
            action === "approve"
              ? "Approved. The connected agent can now execute this exact action."
              : action === "create"
                ? "Connection created. Save the token now; it is shown only once."
                : "Updated.",
          ...(typeof result.token === "string" ? { token: result.token } : {}),
        }
      : {
          message:
            typeof result.error === "string" ? result.error : "Action failed",
        };
  } catch {
    return {
      message:
        "Unable to update the integration. Refresh and check its status before retrying.",
    };
  }
}
