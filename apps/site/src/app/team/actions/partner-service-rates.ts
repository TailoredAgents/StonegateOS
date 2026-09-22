"use server";

import { revalidatePath } from "next/cache";
import {
  PartnerServiceRateEditorSchema,
  PartnerServiceRateWriteSchema,
  type PartnerServiceRateEditorData,
  type PartnerServiceRateWrite,
} from "@myst-os/pricing";
import {
  hasTeamPermission,
  requireCurrentTeamPrincipal,
} from "@/lib/team-principal";
import { callAdminApiAs } from "../lib/api";
import {
  readTeamMutationError,
  readTeamMutationSuccess,
} from "../lib/mutation-feedback";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
type Failure = {
  ok: false;
  message: string;
  fieldErrors?: Record<string, string>;
};
export async function loadPartnerServiceRates(
  accountId: string,
): Promise<{ ok: true; data: PartnerServiceRateEditorData } | Failure> {
  const principal = await requireCurrentTeamPrincipal();
  if (
    !UUID.test(accountId) ||
    !hasTeamPermission(principal, "partners.accounts.read") ||
    !hasTeamPermission(principal, "partners.commercial.read")
  )
    return {
      ok: false,
      message: "Your role cannot view this company's rates.",
    };
  try {
    const response = await callAdminApiAs(
      principal,
      `/api/admin/partner-management/v1/accounts/${accountId}/service-rates`,
      { timeoutMs: 10_000 },
    );
    if (!response.ok)
      return {
        ok: false,
        message: await readTeamMutationError(
          response,
          "The service rates could not be loaded.",
        ),
      };
    const parsed = PartnerServiceRateEditorSchema.safeParse(
      await response.json(),
    );
    if (!parsed.success || parsed.data.accountId !== accountId)
      return {
        ok: false,
        message:
          "The service rates returned incomplete information. Refresh before editing.",
      };
    return { ok: true, data: parsed.data };
  } catch {
    return {
      ok: false,
      message: "The service rates could not be loaded. Try again.",
    };
  }
}
export async function savePartnerServiceRates(input: {
  accountId: string;
  revision: string;
  operationKey: string;
  change: PartnerServiceRateWrite;
}): Promise<
  { ok: true; revision: string; publishedVersionId: string | null } | Failure
> {
  const principal = await requireCurrentTeamPrincipal();
  if (
    !hasTeamPermission(principal, "partners.accounts.manage") ||
    !hasTeamPermission(principal, "partners.rates")
  )
    return { ok: false, message: "Your role cannot change partner rates." };
  const parsed = PartnerServiceRateWriteSchema.safeParse(input.change);
  if (
    !UUID.test(input.accountId) ||
    !/^[1-9][0-9]*$/u.test(input.revision) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u.test(input.operationKey) ||
    !parsed.success
  )
    return {
      ok: false,
      message: "Check the service rates and reload the company if needed.",
    };
  try {
    const response = await callAdminApiAs(
      principal,
      `/api/admin/partner-management/v1/accounts/${input.accountId}/service-rates`,
      {
        method: "PATCH",
        headers: {
          "If-Match": '"' + input.revision + '"',
          "Idempotency-Key": input.operationKey,
        },
        body: JSON.stringify(parsed.data),
      },
    );
    if (!response.ok) {
      const raw = (await response
        .clone()
        .json()
        .catch(() => null)) as { fieldErrors?: unknown } | null;
      const fieldErrors =
        raw?.fieldErrors &&
        typeof raw.fieldErrors === "object" &&
        !Array.isArray(raw.fieldErrors)
          ? Object.fromEntries(
              Object.entries(raw.fieldErrors).filter(
                (entry): entry is [string, string] =>
                  typeof entry[1] === "string",
              ),
            )
          : {};
      return {
        ok: false,
        message: await readTeamMutationError(
          response,
          "The rates could not be saved.",
        ),
        fieldErrors,
      };
    }
    const success = await readTeamMutationSuccess<{
      accountId: string;
      revision: string;
      publishedVersionId: string | null;
    }>(response);
    if (
      !success ||
      success.data.accountId !== input.accountId ||
      !/^[1-9][0-9]*$/u.test(success.data.revision) ||
      (success.data.publishedVersionId !== null &&
        !UUID.test(success.data.publishedVersionId))
    )
      return {
        ok: false,
        message:
          "The save could not be confirmed. Try again to check the same operation.",
      };
    revalidatePath("/team/partners");
    return {
      ok: true,
      revision: success.data.revision,
      publishedVersionId: success.data.publishedVersionId,
    };
  } catch {
    return {
      ok: false,
      message:
        "The save could not be confirmed. Try again with the same entries.",
    };
  }
}
