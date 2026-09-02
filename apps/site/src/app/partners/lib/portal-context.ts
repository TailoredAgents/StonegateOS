import { cache } from "react";
import { callPartnerApi } from "./api";

export type PartnerCapability =
  | "overview"
  | "schedule"
  | "jobs"
  | "approvals"
  | "locations"
  | "proof"
  | "billing"
  | "reports"
  | "help"
  | "settings";

export type PartnerCapabilities = Record<PartnerCapability, boolean>;

export type PartnerPortalPermissions = {
  scheduleJobs: boolean;
  updateJobs: boolean;
  cancelJobs: boolean;
  manageLocations: boolean;
  exportOperationalReports: boolean;
  uploadMedia: boolean;
  shareProof: boolean;
  readMessages: boolean;
  sendMessages: boolean;
};

export type PartnerPortalAccount = {
  id: string;
  membershipId: string;
  name: string;
  roleKey: string;
  current: boolean;
  defaultAccount: boolean;
};

export type PartnerPortalContext = {
  status: "authenticated";
  accountId: string;
  membershipId: string;
  accountLabel: string;
  accounts: PartnerPortalAccount[];
  partnerType: string | null;
  user: {
    name: string;
    email: string;
    passwordSet: boolean;
  };
  capabilities: PartnerCapabilities;
  permissions: PartnerPortalPermissions;
};

export type PartnerPortalContextResult =
  | PartnerPortalContext
  | { status: "unauthenticated" }
  | { status: "unavailable" };

type V2MePayload = {
  ok: true;
  partnerUser: {
    id: string;
    email: string;
    name: string;
    passwordSet: boolean;
  };
  account: {
    id: string;
    name: string;
  };
  membership: {
    id: string;
    roleKey: string;
    capabilities: string[];
    persona: string | null;
  };
  accounts: Array<{
    id: string;
    name: string;
    membershipId: string;
    roleKey: string;
    persona: string | null;
    capabilities: string[];
    current: boolean;
    defaultAccount: boolean;
  }>;
};

type PartnerApiCaller = typeof callPartnerApi;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximumLength
  );
}

function sameCapabilitySet(left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length) return false;
  const values = new Set(left);
  return (
    values.size === left.length && right.every((value) => values.has(value))
  );
}

function parseV2MePayload(value: unknown): V2MePayload | null {
  if (!isRecord(value) || value["ok"] !== true) return null;
  const partnerUser = value["partnerUser"];
  const account = value["account"];
  const membership = value["membership"];
  const accounts = value["accounts"];
  if (
    !isRecord(partnerUser) ||
    !isRecord(account) ||
    !isRecord(membership) ||
    !Array.isArray(accounts)
  ) {
    return null;
  }
  const partnerUserId = partnerUser["id"];
  const email = partnerUser["email"];
  const name = partnerUser["name"];
  const passwordSet = partnerUser["passwordSet"];
  const accountId = account["id"];
  const accountName = account["name"];
  const membershipId = membership["id"];
  const roleKey = membership["roleKey"];
  const capabilities = membership["capabilities"];
  const persona = membership["persona"];
  if (
    !isUuid(partnerUserId) ||
    !isBoundedText(email, 320) ||
    !isBoundedText(name, 160) ||
    typeof passwordSet !== "boolean" ||
    !isUuid(accountId) ||
    !isBoundedText(accountName, 200) ||
    !isUuid(membershipId) ||
    !isBoundedText(roleKey, 80) ||
    !Array.isArray(capabilities) ||
    capabilities.length > 128 ||
    !capabilities.every((capability) => isBoundedText(capability, 120)) ||
    !(persona === null || (typeof persona === "string" && persona.length <= 80))
  ) {
    return null;
  }

  const accountRows = accounts.flatMap((candidate) => {
    if (!isRecord(candidate)) {
      return [];
    }
    const id = candidate["id"];
    const candidateName = candidate["name"];
    const candidateMembershipId = candidate["membershipId"];
    const candidateRoleKey = candidate["roleKey"];
    const candidatePersona = candidate["persona"];
    const candidateCapabilities = candidate["capabilities"];
    const current = candidate["current"];
    const defaultAccount = candidate["defaultAccount"];
    if (
      !isUuid(id) ||
      !isBoundedText(candidateName, 200) ||
      !isUuid(candidateMembershipId) ||
      !isBoundedText(candidateRoleKey, 80) ||
      !(
        candidatePersona === null ||
        (typeof candidatePersona === "string" && candidatePersona.length <= 80)
      ) ||
      !Array.isArray(candidateCapabilities) ||
      candidateCapabilities.length > 128 ||
      !candidateCapabilities.every((capability) =>
        isBoundedText(capability, 120),
      ) ||
      typeof current !== "boolean" ||
      typeof defaultAccount !== "boolean"
    ) {
      return [];
    }
    return [
      {
        id,
        name: candidateName,
        membershipId: candidateMembershipId,
        roleKey: candidateRoleKey,
        persona: candidatePersona,
        capabilities: candidateCapabilities,
        current,
        defaultAccount,
      },
    ];
  });
  if (accountRows.length !== accounts.length) return null;

  const currentAccounts = accountRows.filter((candidate) => candidate.current);
  if (
    currentAccounts.length !== 1 ||
    currentAccounts[0]?.id !== accountId ||
    currentAccounts[0]?.name.trim() !== accountName.trim() ||
    currentAccounts[0]?.membershipId !== membershipId ||
    currentAccounts[0]?.roleKey !== roleKey ||
    currentAccounts[0]?.persona !== persona ||
    !sameCapabilitySet(currentAccounts[0]?.capabilities ?? [], capabilities)
  ) {
    return null;
  }

  return {
    ok: true,
    partnerUser: {
      id: partnerUserId,
      email,
      name,
      passwordSet,
    },
    account: {
      id: accountId,
      name: accountName,
    },
    membership: {
      id: membershipId,
      roleKey,
      capabilities,
      persona,
    },
    accounts: accountRows,
  };
}

function navigationCapabilities(
  rawCapabilities: readonly string[],
): PartnerCapabilities {
  const capabilities = new Set(
    rawCapabilities.map((value) => value.trim().toLowerCase()),
  );
  const hasAny = (...values: string[]) =>
    values.some((value) => capabilities.has(value));
  return {
    overview: hasAny("account.read", "bookings.read", "jobs.read"),
    schedule: hasAny("bookings.create"),
    jobs: hasAny("bookings.read", "jobs.read"),
    approvals: hasAny("approvals.read", "approvals.decide"),
    locations: hasAny("properties.read", "properties.manage"),
    proof: hasAny("media.read", "proof.read", "proof.request"),
    billing: hasAny("rates.read", "invoices.read", "documents.financial.read"),
    reports: hasAny(
      "reports.operational.read",
      "reports.operational.export",
      "reports.financial.read",
      "reports.financial.export",
    ),
    help: true,
    settings: hasAny("portal.session.read", "account.read"),
  };
}

function actionPermissions(
  rawCapabilities: readonly string[],
): PartnerPortalPermissions {
  const capabilities = new Set(
    rawCapabilities.map((value) => value.trim().toLowerCase()),
  );
  return {
    scheduleJobs: capabilities.has("bookings.create"),
    updateJobs: capabilities.has("bookings.update"),
    cancelJobs: capabilities.has("bookings.cancel"),
    manageLocations: capabilities.has("properties.manage"),
    exportOperationalReports: capabilities.has("reports.operational.export"),
    uploadMedia: capabilities.has("media.upload"),
    shareProof: capabilities.has("proof.request"),
    readMessages: capabilities.has("messages.read"),
    sendMessages: capabilities.has("messages.send"),
  };
}

/**
 * Builds a frontend context only from the account-scoped V2 principal. A
 * legacy contact identity is not an authorization fallback: an unavailable or
 * malformed V2 response leaves the protected shell unavailable.
 */
export async function resolvePartnerPortalContext(
  partnerApi: PartnerApiCaller,
): Promise<PartnerPortalContextResult> {
  let response: Response;
  try {
    response = await partnerApi("/api/portal/v2/me", { timeoutMs: 12_000 });
  } catch {
    return { status: "unavailable" };
  }
  if (response.status === 401 || response.status === 403) {
    return { status: "unauthenticated" };
  }
  if (!response.ok) return { status: "unavailable" };

  const payload = parseV2MePayload(
    (await response.json().catch(() => null)) as unknown,
  );
  if (!payload) return { status: "unavailable" };

  const email = payload.partnerUser.email.trim();
  const rawCapabilities = payload.membership.capabilities;
  return {
    status: "authenticated",
    accountId: payload.account.id,
    membershipId: payload.membership.id,
    accountLabel: payload.account.name.trim(),
    accounts: payload.accounts.map((account) => ({
      id: account.id,
      membershipId: account.membershipId,
      name: account.name.trim(),
      roleKey: account.roleKey,
      current: account.current,
      defaultAccount: account.defaultAccount,
    })),
    partnerType: payload.membership.persona?.trim() || null,
    user: {
      name: payload.partnerUser.name.trim() || email,
      email,
      passwordSet: payload.partnerUser.passwordSet,
    },
    capabilities: navigationCapabilities(rawCapabilities),
    permissions: actionPermissions(rawCapabilities),
  };
}

export const getPartnerPortalContext = cache(
  async (): Promise<PartnerPortalContextResult> =>
    resolvePartnerPortalContext(callPartnerApi),
);

export function partnerPersonaLabel(partnerType: string | null): string {
  const normalized = partnerType?.trim().toLowerCase() ?? "";
  if (normalized.includes("property")) return "Property management";
  if (normalized.includes("real") || normalized.includes("agent")) {
    return "Real estate";
  }
  if (normalized.includes("commercial")) return "Commercial services";
  if (normalized.includes("contract")) return "Contractor services";
  return "Partner services";
}
