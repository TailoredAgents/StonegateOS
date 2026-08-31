import { and, desc, eq, ilike, inArray, or, type SQL } from "drizzle-orm";
import {
  getDb,
  partnerAccessApplications,
  partnerAccounts,
  partnerUsers,
} from "@/db";
import type { PartnerAccessApplicationStatus } from "@/db";
import { TeamMutationFailure } from "@/lib/team-mutation";

const ACTIVE_APPLICATION_STATUSES = [
  "submitted",
  "under_review",
  "needs_information",
] as const satisfies readonly PartnerAccessApplicationStatus[];
const APPLICATION_STATUSES = [
  ...ACTIVE_APPLICATION_STATUSES,
  "approved",
  "declined",
  "withdrawn",
] as const satisfies readonly PartnerAccessApplicationStatus[];
const STATUS_SET = new Set<string>(APPLICATION_STATUSES);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type StaffAccessApplicationListQuery = {
  status: PartnerAccessApplicationStatus | "active" | "all";
  q: string | null;
  limit: number;
};

export type StaffAccessApplicationDecision =
  | {
      action: "needs_information";
      note: string;
      confirmation: "REQUEST INFORMATION";
    }
  | {
      action: "approve";
      note: string | null;
      confirmation: "APPROVE";
    }
  | {
      action: "decline";
      note: string;
      confirmation: "DECLINE";
    };

type StaffApplicationRow = {
  id: string;
  status: PartnerAccessApplicationStatus;
  version: number;
  name: string;
  email: string;
  phone: string | null;
  companyName: string;
  website: string | null;
  partnerType: string;
  serviceAreas: string[];
  requestedNeeds: string[];
  applicantPartnerUserId: string | null;
  bootstrapPartnerAccountId: string | null;
  approvedPartnerAccountId: string | null;
  emailVerifiedAt: Date | null;
  termsAcceptedAt: Date;
  privacyAcceptedAt: Date;
  reviewNote: string | null;
  reviewedAt: Date | null;
  reviewedByMemberId: string | null;
  submittedAt: Date;
  updatedAt: Date;
  accountName: string | null;
  accountStatus: string | null;
  accountPortalAccessEnabled: boolean | null;
  userActive: boolean | null;
  userMfaRequired: boolean | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim();
  if (
    normalized.length === 0 ||
    normalized.length > maximum ||
    normalized.includes("\u0000")
  ) {
    return null;
  }
  return normalized;
}

function escapedSearchPattern(value: string): string {
  return `%${value
    .replace(/\\/gu, "\\\\")
    .replace(/[%_]/gu, "\\$&")
    .replace(/\s+/gu, "%")}%`;
}

export function isStaffAccessApplicationId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function parseStaffAccessApplicationListQuery(
  searchParams: URLSearchParams,
): StaffAccessApplicationListQuery {
  const allowedKeys = new Set(["limit", "q", "status"]);
  for (const key of searchParams.keys()) {
    if (!allowedKeys.has(key) || searchParams.getAll(key).length !== 1) {
      throw new TeamMutationFailure(
        "invalid",
        "The access-application filters are invalid.",
        { status: 422, fieldErrors: { [key]: "Remove this filter." } },
      );
    }
  }
  const rawStatus = (searchParams.get("status") ?? "active")
    .normalize("NFKC")
    .trim()
    .toLowerCase();
  if (
    rawStatus !== "active" &&
    rawStatus !== "all" &&
    !STATUS_SET.has(rawStatus)
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "Choose a valid application status.",
      { status: 422, fieldErrors: { status: "Choose a listed status." } },
    );
  }
  const rawLimit = searchParams.get("limit") ?? "50";
  if (!/^\d{1,3}$/u.test(rawLimit)) {
    throw new TeamMutationFailure("invalid", "Choose a valid page size.", {
      status: 422,
      fieldErrors: { limit: "Use a whole number from 1 through 100." },
    });
  }
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TeamMutationFailure("invalid", "Choose a valid page size.", {
      status: 422,
      fieldErrors: { limit: "Use a whole number from 1 through 100." },
    });
  }
  const rawQ = searchParams.get("q");
  const q =
    rawQ === null || rawQ.trim() === "" ? null : normalizedText(rawQ, 120);
  if (rawQ !== null && rawQ.trim() !== "" && q === null) {
    throw new TeamMutationFailure("invalid", "The search text is invalid.", {
      status: 422,
      fieldErrors: { q: "Use 120 characters or fewer." },
    });
  }
  return {
    status: rawStatus as StaffAccessApplicationListQuery["status"],
    q,
    limit,
  };
}

export function parseStaffAccessApplicationDecision(
  value: unknown,
): StaffAccessApplicationDecision {
  if (!isRecord(value)) {
    throw new TeamMutationFailure("invalid", "Send one complete decision.", {
      fieldErrors: { request: "A JSON object is required." },
    });
  }
  const allowedKeys = new Set(["action", "confirmation", "note"]);
  if (
    !("action" in value) ||
    !("confirmation" in value) ||
    !("note" in value) ||
    Object.keys(value).some((key) => !allowedKeys.has(key))
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "The decision is incomplete or contains unsupported fields.",
      {
        fieldErrors: {
          request: "Send exactly action, note, and confirmation.",
        },
      },
    );
  }
  const action = value["action"];
  const confirmation = value["confirmation"];
  const rawNote = value["note"];
  if (action === "approve") {
    const note =
      rawNote === null || rawNote === ""
        ? null
        : normalizedText(rawNote, 1_000);
    if (
      confirmation !== "APPROVE" ||
      (rawNote !== null && rawNote !== "" && !note)
    ) {
      throw new TeamMutationFailure("invalid", "Confirm this approval.", {
        fieldErrors: {
          ...(confirmation !== "APPROVE"
            ? { confirmation: "Enter APPROVE exactly." }
            : {}),
          ...(rawNote !== null && rawNote !== "" && !note
            ? { note: "Use 1,000 characters or fewer." }
            : {}),
        },
      });
    }
    return { action, confirmation, note };
  }
  if (action === "needs_information") {
    const note = normalizedText(rawNote, 2_000);
    if (confirmation !== "REQUEST INFORMATION" || !note || note.length < 2) {
      throw new TeamMutationFailure(
        "invalid",
        "Explain what information the applicant must provide.",
        {
          fieldErrors: {
            ...(confirmation !== "REQUEST INFORMATION"
              ? { confirmation: "Enter REQUEST INFORMATION exactly." }
              : {}),
            ...(!note || note.length < 2
              ? { note: "Enter 2–2,000 characters." }
              : {}),
          },
        },
      );
    }
    return { action, confirmation, note };
  }
  if (action === "decline") {
    const note = normalizedText(rawNote, 2_000);
    if (confirmation !== "DECLINE" || !note || note.length < 2) {
      throw new TeamMutationFailure("invalid", "Explain this decline.", {
        fieldErrors: {
          ...(confirmation !== "DECLINE"
            ? { confirmation: "Enter DECLINE exactly." }
            : {}),
          ...(!note || note.length < 2
            ? { note: "Enter 2–2,000 characters." }
            : {}),
        },
      });
    }
    return { action, confirmation, note };
  }
  throw new TeamMutationFailure("invalid", "Choose a valid decision.", {
    fieldErrors: { action: "Choose request information, approve, or decline." },
  });
}

export function isActiveStaffAccessApplicationStatus(
  status: PartnerAccessApplicationStatus,
): boolean {
  return ACTIVE_APPLICATION_STATUSES.includes(
    status as (typeof ACTIVE_APPLICATION_STATUSES)[number],
  );
}

function applicationSelection() {
  return {
    id: partnerAccessApplications.id,
    status: partnerAccessApplications.status,
    version: partnerAccessApplications.version,
    name: partnerAccessApplications.name,
    email: partnerAccessApplications.email,
    phone: partnerAccessApplications.phone,
    companyName: partnerAccessApplications.companyName,
    website: partnerAccessApplications.website,
    partnerType: partnerAccessApplications.partnerType,
    serviceAreas: partnerAccessApplications.serviceAreas,
    requestedNeeds: partnerAccessApplications.requestedNeeds,
    applicantPartnerUserId: partnerAccessApplications.applicantPartnerUserId,
    bootstrapPartnerAccountId:
      partnerAccessApplications.bootstrapPartnerAccountId,
    approvedPartnerAccountId:
      partnerAccessApplications.approvedPartnerAccountId,
    emailVerifiedAt: partnerAccessApplications.emailVerifiedAt,
    termsAcceptedAt: partnerAccessApplications.termsAcceptedAt,
    privacyAcceptedAt: partnerAccessApplications.privacyAcceptedAt,
    reviewNote: partnerAccessApplications.reviewNote,
    reviewedAt: partnerAccessApplications.reviewedAt,
    reviewedByMemberId: partnerAccessApplications.reviewedByMemberId,
    submittedAt: partnerAccessApplications.submittedAt,
    updatedAt: partnerAccessApplications.updatedAt,
    accountName: partnerAccounts.name,
    accountStatus: partnerAccounts.status,
    accountPortalAccessEnabled: partnerAccounts.portalAccessEnabled,
    userActive: partnerUsers.active,
    userMfaRequired: partnerUsers.mfaRequired,
  };
}

function serializeApplication(
  row: StaffApplicationRow,
): Record<string, unknown> {
  const active = isActiveStaffAccessApplicationStatus(row.status);
  const tenantBound = Boolean(
    row.bootstrapPartnerAccountId &&
      row.applicantPartnerUserId &&
      row.accountName &&
      row.userActive,
  );
  return {
    id: row.id,
    status: row.status,
    version: String(row.version),
    applicant: {
      name: row.name,
      email: row.email,
      phone: row.phone,
      identityActive: row.userActive === true,
      emailVerifiedAt: row.emailVerifiedAt?.toISOString() ?? null,
      mfaRequired: row.userMfaRequired === true,
    },
    company: {
      name: row.companyName,
      website: row.website,
      persona: row.partnerType,
      serviceAreas: row.serviceAreas,
      requestedNeeds: row.requestedNeeds,
    },
    account: row.bootstrapPartnerAccountId
      ? {
          id: row.bootstrapPartnerAccountId,
          name: row.accountName,
          status: row.accountStatus,
          portalAccessEnabled: row.accountPortalAccessEnabled === true,
        }
      : null,
    review: {
      note: row.reviewNote,
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
    },
    acceptedAt: {
      terms: row.termsAcceptedAt.toISOString(),
      privacy: row.privacyAcceptedAt.toISOString(),
    },
    submittedAt: row.submittedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    allowedActions: active
      ? tenantBound
        ? ["needs_information", "approve", "decline"]
        : ["needs_information"]
      : [],
    decisionBlockedReason:
      active && !tenantBound
        ? "The generated account binding requires staff reconciliation before approval or decline."
        : null,
  };
}

function joinedApplications() {
  return getDb()
    .select(applicationSelection())
    .from(partnerAccessApplications)
    .leftJoin(
      partnerAccounts,
      eq(
        partnerAccessApplications.bootstrapPartnerAccountId,
        partnerAccounts.id,
      ),
    )
    .leftJoin(
      partnerUsers,
      eq(partnerAccessApplications.applicantPartnerUserId, partnerUsers.id),
    );
}

export async function listStaffAccessApplications(
  query: StaffAccessApplicationListQuery,
): Promise<Record<string, unknown>[]> {
  const filters: SQL[] = [];
  if (query.status === "active") {
    filters.push(
      inArray(partnerAccessApplications.status, [
        ...ACTIVE_APPLICATION_STATUSES,
      ]),
    );
  } else if (query.status !== "all") {
    filters.push(eq(partnerAccessApplications.status, query.status));
  }
  if (query.q) {
    const search = escapedSearchPattern(query.q);
    filters.push(
      or(
        ilike(partnerAccessApplications.name, search),
        ilike(partnerAccessApplications.email, search),
        ilike(partnerAccessApplications.companyName, search),
      )!,
    );
  }
  const rows = await joinedApplications()
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(
      desc(partnerAccessApplications.submittedAt),
      desc(partnerAccessApplications.id),
    )
    .limit(query.limit);
  return rows.map((row) => serializeApplication(row as StaffApplicationRow));
}

export async function findStaffAccessApplication(
  applicationId: string,
): Promise<Record<string, unknown> | null> {
  const [row] = await joinedApplications()
    .where(eq(partnerAccessApplications.id, applicationId))
    .limit(1);
  return row ? serializeApplication(row as StaffApplicationRow) : null;
}
