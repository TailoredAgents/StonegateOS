"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import {
  hasTeamPermission,
  requireCurrentTeamPrincipal,
} from "@/lib/team-principal";
import { callAdminApiAs } from "../lib/api";
import {
  readTeamMutationError,
  readTeamMutationException,
  readTeamMutationSuccess,
} from "../lib/mutation-feedback";

const PARTNER_ADMIN_PATH = "/team/partners";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u;
const SERVICE_KEY_PATTERN = /^[a-z][a-z0-9_-]{1,79}$/u;
const ROLE_KEYS = new Set([
  "administrator",
  "operations",
  "billing_approver",
  "viewer",
]);

function value(formData: FormData, key: string): string {
  const raw = formData.get(key);
  return typeof raw === "string" ? raw.normalize("NFKC").trim() : "";
}

function values(formData: FormData, key: string): string[] {
  return [
    ...new Set(
      formData
        .getAll(key)
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.normalize("NFKC").trim())
        .filter(Boolean),
    ),
  ];
}

function boundedInteger(
  raw: string,
  minimum: number,
  maximum: number,
): number | null {
  if (!/^(?:0|[1-9][0-9]{0,8})$/u.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : null;
}

function optionalUsdMinor(raw: string): number | null | undefined {
  if (!raw) return undefined;
  const match = /^(0|[1-9][0-9]{0,10})(?:\.([0-9]{1,2}))?$/u.exec(raw);
  if (!match) return null;
  const whole = Number(match[1]);
  const fractional = (match[2] ?? "").padEnd(2, "0");
  const minor = whole * 100 + Number(fractional || "0");
  return Number.isSafeInteger(minor) ? minor : null;
}

function presence(raw: string): "present" | "missing" | undefined | null {
  if (!raw) return undefined;
  return raw === "present" || raw === "missing" ? raw : null;
}

function parseRuleForm(formData: FormData): {
  name: string;
  conditions: Record<string, unknown>;
  requiredDecisionCount: number;
  active: boolean;
  reason: string;
  confirmation: string;
} | null {
  const name = value(formData, "name").replace(/\s+/gu, " ");
  const serviceKeys = values(formData, "serviceKeys");
  const locationIds = values(formData, "locationIds").map((item) =>
    item.toLowerCase(),
  );
  const requesterRoleKeys = values(formData, "requesterRoleKeys");
  const minimumAmountMinor = optionalUsdMinor(value(formData, "minimumAmount"));
  const maximumAmountMinor = optionalUsdMinor(value(formData, "maximumAmount"));
  const poNumberState = presence(value(formData, "poNumberState"));
  const costCenterState = presence(value(formData, "costCenterState"));
  const requiredDecisionCount = boundedInteger(
    value(formData, "requiredDecisionCount"),
    1,
    20,
  );
  const reason = value(formData, "reason");
  const confirmation = value(formData, "confirmation");
  if (
    name.length < 1 ||
    name.length > 160 ||
    serviceKeys.length > 50 ||
    serviceKeys.some((key) => !SERVICE_KEY_PATTERN.test(key)) ||
    locationIds.length > 100 ||
    locationIds.some((id) => !UUID_PATTERN.test(id)) ||
    requesterRoleKeys.length > 4 ||
    requesterRoleKeys.some((role) => !ROLE_KEYS.has(role)) ||
    minimumAmountMinor === null ||
    maximumAmountMinor === null ||
    (minimumAmountMinor !== undefined &&
      maximumAmountMinor !== undefined &&
      maximumAmountMinor < minimumAmountMinor) ||
    poNumberState === null ||
    costCenterState === null ||
    requiredDecisionCount === null ||
    reason.length < 12 ||
    reason.length > 1_000
  ) {
    return null;
  }
  return {
    name,
    conditions: {
      ...(serviceKeys.length ? { serviceKeys } : {}),
      ...(locationIds.length ? { locationIds } : {}),
      ...(minimumAmountMinor !== undefined ? { minimumAmountMinor } : {}),
      ...(maximumAmountMinor !== undefined ? { maximumAmountMinor } : {}),
      ...(requesterRoleKeys.length ? { requesterRoleKeys } : {}),
      ...(poNumberState ? { poNumberState } : {}),
      ...(costCenterState ? { costCenterState } : {}),
    },
    requiredDecisionCount,
    active: values(formData, "active").includes("true"),
    reason,
    confirmation,
  };
}

async function flash(ok: boolean, message: string): Promise<void> {
  const jar = await cookies();
  jar.set({
    name: ok ? "myst-flash" : "myst-flash-error",
    value: message,
    path: "/",
  });
}

async function reject(message: string): Promise<void> {
  await flash(false, message);
  revalidatePath(PARTNER_ADMIN_PATH);
}

async function perform(input: {
  path: string;
  method: "POST" | "PATCH";
  idempotencyKey: string;
  expectedVersion?: string;
  body: Record<string, unknown>;
  accountId: string;
  expectedRuleId?: string;
  successMessage: string;
}): Promise<void> {
  const principal = await requireCurrentTeamPrincipal();
  if (!hasTeamPermission(principal, "partners.commercial.manage")) {
    return reject("Commercial management permission is required.");
  }
  try {
    const response = await callAdminApiAs(principal, input.path, {
      method: input.method,
      headers: {
        "Idempotency-Key": input.idempotencyKey,
        ...(input.expectedVersion ? { "If-Match": input.expectedVersion } : {}),
      },
      body: JSON.stringify(input.body),
    });
    if (!response.ok) {
      await flash(
        false,
        await readTeamMutationError(
          response,
          "Unable to save the approval rule",
        ),
      );
      return;
    }
    const success = await readTeamMutationSuccess<{
      partnerAccountId?: unknown;
      rule?: { id?: unknown; revision?: unknown };
    }>(response);
    if (
      !success ||
      success.data.partnerAccountId !== input.accountId ||
      typeof success.data.rule?.id !== "string" ||
      (input.expectedRuleId && success.data.rule.id !== input.expectedRuleId) ||
      typeof success.data.rule.revision !== "number"
    ) {
      await flash(
        false,
        "The service returned an unreadable approval-rule receipt. No success is being claimed; refresh before retrying.",
      );
      return;
    }
    await flash(true, input.successMessage);
  } catch (error) {
    await flash(
      false,
      readTeamMutationException(error, "Unable to save the approval rule"),
    );
  } finally {
    revalidatePath(PARTNER_ADMIN_PATH);
  }
}

export async function partnerApprovalRuleCreateAction(
  formData: FormData,
): Promise<void> {
  const accountId = value(formData, "accountId").toLowerCase();
  const idempotencyKey = value(formData, "idempotencyKey");
  const rule = parseRuleForm(formData);
  if (
    !UUID_PATTERN.test(accountId) ||
    !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey) ||
    !rule ||
    rule.confirmation !== "CREATE APPROVAL RULE"
  ) {
    return reject(
      "The approval rule is incomplete, invalid, or not confirmed. Review every condition and try again.",
    );
  }
  return perform({
    path: `/api/admin/partner-management/v1/accounts/${encodeURIComponent(accountId)}/approval-rules`,
    method: "POST",
    idempotencyKey,
    body: rule,
    accountId,
    successMessage:
      "Approval rule created. New matching requests will capture this version; existing requests are unchanged.",
  });
}

export async function partnerApprovalRuleUpdateAction(
  formData: FormData,
): Promise<void> {
  const accountId = value(formData, "accountId").toLowerCase();
  const ruleId = value(formData, "ruleId").toLowerCase();
  const expectedVersion = value(formData, "expectedVersion");
  const idempotencyKey = value(formData, "idempotencyKey");
  const rule = parseRuleForm(formData);
  if (
    !UUID_PATTERN.test(accountId) ||
    !UUID_PATTERN.test(ruleId) ||
    !/^[1-9][0-9]{0,9}$/u.test(expectedVersion) ||
    !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey) ||
    !rule ||
    rule.confirmation !== "UPDATE APPROVAL RULE"
  ) {
    return reject(
      "The approval-rule update is incomplete, stale, invalid, or not confirmed. Refresh and try again.",
    );
  }
  return perform({
    path: `/api/admin/partner-management/v1/accounts/${encodeURIComponent(accountId)}/approval-rules/${encodeURIComponent(ruleId)}`,
    method: "PATCH",
    expectedVersion,
    idempotencyKey,
    body: rule,
    accountId,
    expectedRuleId: ruleId,
    successMessage: rule.active
      ? "Approval rule updated. Existing approval requests retain their captured rule version."
      : "Approval rule deactivated without deleting its history. Existing approval requests remain unchanged.",
  });
}
