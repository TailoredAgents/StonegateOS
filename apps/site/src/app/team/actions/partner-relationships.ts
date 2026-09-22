"use server";

import { revalidatePath } from "next/cache";
import {
  hasTeamPermission,
  requireCurrentTeamPrincipal,
} from "@/lib/team-principal";
import { callAdminApiAs } from "../lib/api";
import {
  readTeamMutationError,
  readTeamMutationSuccess,
} from "../lib/mutation-feedback";

export type RelationshipChoice = { id: string; label: string };
export type RelationshipWorkflow = {
  tools: {
    templates: boolean;
    recurring: boolean;
    bulk: boolean;
    reports: boolean;
    portfolio: boolean;
    approvals: boolean;
  };
  requestableServiceKeys: string[];
  disabledServiceKeys: string[];
  partialPayments: boolean;
};
export type RelationshipContext = {
  account: {
    id: string;
    name: string;
    enabled: boolean;
    lifecycle: string;
    setupStatus: "complete" | "rates_required";
    contactName: string | null;
    contactEmail: string | null;
  };
  config: RelationshipWorkflow;
  version: string;
  locations: RelationshipChoice[];
  costCenters: RelationshipChoice[];
  services: { key: string; label: string }[];
};
export type RelationshipFeedback = {
  ok: boolean;
  message: string;
  accountId?: string;
  version?: string;
};
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u;

export async function managePartnerRelationshipInvitation(input: {
  accountId: string;
  invitationId: string;
  action: "resend" | "revoke";
  etag: string;
  operationKey: string;
}): Promise<RelationshipFeedback> {
  const principal = await requireCurrentTeamPrincipal();
  if (
    !input ||
    !UUID.test(input.accountId) ||
    !UUID.test(input.invitationId) ||
    !["resend", "revoke"].includes(input.action) ||
    !KEY.test(input.operationKey) ||
    typeof input.etag !== "string" ||
    !/^"[^"\r\n]{1,250}"$/u.test(input.etag)
  )
    return {
      ok: false,
      message: "Refresh the invitation before trying again.",
    };
  if (
    !hasTeamPermission(
      principal,
      input.action === "resend"
        ? "partners.invitations.send"
        : "partners.invitations.revoke",
    )
  )
    return {
      ok: false,
      message: "Your role cannot make this invitation change.",
    };
  try {
    const response = await callAdminApiAs(
      principal,
      "/api/admin/partner-management/v1/invitations/" + input.action,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": input.operationKey,
          "If-Match": input.etag,
        },
        body: JSON.stringify({
          accountId: input.accountId,
          invitationId: input.invitationId,
          action: input.action,
        }),
      },
    );
    if (!response.ok)
      return {
        ok: false,
        message: await readTeamMutationError(
          response,
          "The invitation could not be changed.",
        ),
      };
    const success = await readTeamMutationSuccess<{ invitationId: string }>(
      response,
    );
    if (success?.data.invitationId !== input.invitationId)
      return {
        ok: false,
        message: "The result could not be verified. Refresh before retrying.",
      };
    revalidatePath("/team/partners");
    return {
      ok: true,
      message:
        input.action === "resend"
          ? "New invitation queued. All earlier invitation and unfinished setup links are invalid."
          : "Invitation and unfinished setup revoked. Existing active members were not changed.",
    };
  } catch {
    return {
      ok: false,
      message:
        "The change could not be confirmed. Retry to check the same operation.",
    };
  }
}

export async function searchPartnerRelationshipCompanies(
  query: string,
  cursor: string | null = null,
): Promise<
  | { ok: true; choices: RelationshipChoice[]; nextCursor: string | null }
  | { ok: false; message: string }
> {
  const principal = await requireCurrentTeamPrincipal();
  if (!hasTeamPermission(principal, "partners.accounts.read"))
    return {
      ok: false,
      message: "Company lookup is not available for this role.",
    };
  if (
    typeof query !== "string" ||
    query.length > 160 ||
    (cursor !== null && (typeof cursor !== "string" || cursor.length > 1200))
  )
    return { ok: false, message: "Use a shorter company search." };
  const params = new URLSearchParams({ limit: "100" });
  if (query.trim()) params.set("q", query.trim());
  if (cursor) params.set("cursor", cursor);
  try {
    const response = await callAdminApiAs(
      principal,
      "/api/admin/partner-management/v1/accounts?" + params.toString(),
      { timeoutMs: 10_000 },
    );
    const payload = response.ok
      ? ((await response.json()) as {
          ok?: boolean;
          items?: { id?: unknown; name?: unknown }[];
          page?: { nextCursor?: unknown };
        })
      : null;
    if (!payload?.ok || !Array.isArray(payload.items))
      return {
        ok: false,
        message: "Companies could not be loaded. Try again.",
      };
    const choices = payload.items.flatMap((row) =>
      typeof row.id === "string" &&
      UUID.test(row.id) &&
      typeof row.name === "string"
        ? [{ id: row.id, label: row.name }]
        : [],
    );
    return {
      ok: true,
      choices,
      nextCursor:
        typeof payload.page?.nextCursor === "string"
          ? payload.page.nextCursor
          : null,
    };
  } catch {
    return { ok: false, message: "Companies could not be loaded. Try again." };
  }
}

export async function loadPartnerRelationshipContext(
  accountId: string,
): Promise<
  { ok: true; context: RelationshipContext } | { ok: false; message: string }
> {
  const principal = await requireCurrentTeamPrincipal();
  if (
    !hasTeamPermission(principal, "partners.accounts.read") ||
    !UUID.test(accountId)
  )
    return { ok: false, message: "Choose a company you can manage." };
  try {
    const response = await callAdminApiAs(
      principal,
      "/api/admin/partner-management/v1/accounts/" + accountId + "/workflow",
      { timeoutMs: 10_000 },
    );
    const payload = response.ok
      ? ((await response.json()) as RelationshipContext & { ok?: boolean })
      : null;
    if (
      !payload?.ok ||
      payload.account?.id !== accountId ||
      !payload.config?.tools ||
      !Array.isArray(payload.locations) ||
      !Array.isArray(payload.costCenters) ||
      !Array.isArray(payload.services)
    )
      return {
        ok: false,
        message: "Company settings could not be loaded. Nothing was changed.",
      };
    return { ok: true, context: payload };
  } catch {
    return {
      ok: false,
      message: "Company settings could not be loaded. Try again.",
    };
  }
}

export async function savePartnerRelationship(
  kind: "create" | "invite" | "workflow" | "enable",
  body: unknown,
  operationKey: string,
  accountId?: string,
  version?: string,
): Promise<RelationshipFeedback> {
  const principal = await requireCurrentTeamPrincipal();
  if (
    !["create", "invite", "workflow", "enable"].includes(kind) ||
    !KEY.test(operationKey)
  )
    return { ok: false, message: "Refresh before trying this action again." };
  const required =
    kind === "create"
      ? ["partners.accounts.manage", "partners.invitations.send"]
      : kind === "invite"
        ? ["partners.invitations.send"]
        : ["partners.accounts.manage"];
  if (!required.every((permission) => hasTeamPermission(principal, permission)))
    return { ok: false, message: "Your role cannot make this change." };
  if (
    (kind === "workflow" || kind === "enable") &&
    (!accountId ||
      !UUID.test(accountId) ||
      !version ||
      !/^[1-9][0-9]*$/u.test(version))
  )
    return { ok: false, message: "Reload this company before saving." };
  let serialized: string;
  try {
    serialized = JSON.stringify(body);
  } catch {
    return { ok: false, message: "Check the form details." };
  }
  if (typeof serialized !== "string" || serialized.length > 32_768)
    return {
      ok: false,
      message: "The form is too large. Use fewer selections.",
    };
  const path =
    kind === "create"
      ? "/api/admin/partner-management/v1/accounts"
      : kind === "invite"
        ? "/api/admin/partner-management/v1/invitations"
        : "/api/admin/partner-management/v1/accounts/" +
          accountId +
          (kind === "enable" ? "/enable" : "/workflow");
  try {
    const response = await callAdminApiAs(principal, path, {
      method: "POST",
      headers: {
        "Idempotency-Key": operationKey,
        ...(version ? { "If-Match": '"' + version + '"' } : {}),
      },
      body: serialized,
    });
    if (!response.ok)
      return {
        ok: false,
        message: await readTeamMutationError(
          response,
          "The change could not be completed.",
        ),
      };
    const success = await readTeamMutationSuccess<{
      accountId: string;
      version?: string;
      deliveryStatus?: string;
      setupStatus?: string;
    }>(response);
    if (!success || !UUID.test(success.data.accountId))
      return {
        ok: false,
        message:
          "The result could not be verified. Refresh before trying again.",
      };
    revalidatePath("/team/partners");
    return {
      ok: true,
      accountId: success.data.accountId,
      ...(success.data.version ? { version: success.data.version } : {}),
      message:
        kind === "enable"
          ? success.data.deliveryStatus === "queued"
            ? "Company activated and Administrator invitation queued."
            : "Company access approved. Now explicitly invite the first Administrator."
          : kind === "workflow"
            ? "Company tools saved."
            : success.data.deliveryStatus === "unchanged"
              ? "No new invitation was created. Check current invitations and company access before retrying."
              : kind === "create"
                ? "Company details saved. Set its service rates before activating access or sending an invitation."
                : "Invitation queued. Delivery status is shown in Invitations.",
    };
  } catch {
    return {
      ok: false,
      message:
        "The change could not be confirmed. Retry with this form or refresh to check its current state.",
    };
  }
}
