import { eq } from "drizzle-orm";
import { getDb, partnerAccounts } from "@/db";

export const PARTNER_TOOL_KEYS = [
  "templates",
  "recurring",
  "bulk",
  "reports",
  "portfolio",
  "approvals",
] as const;
export type PartnerToolKey = (typeof PARTNER_TOOL_KEYS)[number];
export type PartnerAccountWorkflow = {
  tools: Record<PartnerToolKey, boolean>;
  requestableServiceKeys: string[];
  disabledServiceKeys: string[];
  partialPayments: boolean;
};

/** Staff configuration narrows product availability; it never grants a role permission. */
export function normalizePartnerAccountWorkflow(
  value: unknown,
): PartnerAccountWorkflow {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const tools =
    record["tools"] &&
    typeof record["tools"] === "object" &&
    !Array.isArray(record["tools"])
      ? (record["tools"] as Record<string, unknown>)
      : {};
  const keys = (input: unknown) =>
    Array.isArray(input)
      ? [
          ...new Set(
            input.filter(
              (key): key is string =>
                typeof key === "string" && /^[a-z][a-z0-9_-]{1,79}$/u.test(key),
            ),
          ),
        ].slice(0, 100)
      : [];
  return {
    tools: Object.fromEntries(
      PARTNER_TOOL_KEYS.map((key) => [key, tools[key] === true]),
    ) as Record<PartnerToolKey, boolean>,
    requestableServiceKeys: keys(record["requestableServiceKeys"]),
    disabledServiceKeys: keys(record["disabledServiceKeys"]),
    partialPayments: record["partialPayments"] === true,
  };
}

export async function getPartnerAccountWorkflow(
  accountId: string,
): Promise<PartnerAccountWorkflow> {
  const [account] = await getDb()
    .select({ config: partnerAccounts.portalWorkflowConfig })
    .from(partnerAccounts)
    .where(eq(partnerAccounts.id, accountId))
    .limit(1);
  return normalizePartnerAccountWorkflow(account?.config);
}

export async function isPartnerToolEnabled(
  accountId: string,
  tool: PartnerToolKey,
): Promise<boolean> {
  return (await getPartnerAccountWorkflow(accountId)).tools[tool];
}
