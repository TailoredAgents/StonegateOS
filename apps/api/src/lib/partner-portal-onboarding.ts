import { createHash } from "node:crypto";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import {
  auditLogs,
  contacts,
  getDb,
  partnerAccessApplications,
  partnerAccountMemberships,
  partnerAccounts,
  partnerCompanyJoinRequests,
  partnerRoleTemplates,
  partnerUsers,
  type PartnerAccessApplicationStatus,
  type PartnerCompanyJoinRequestStatus,
  type PartnerPersona,
} from "@/db";
import { normalizeEmail, normalizePhoneE164 } from "@/lib/partner-portal-auth";
import {
  isPortalV2Uuid,
  normalizeCompanyDomain,
  normalizedEmailDomain,
} from "@/lib/partner-portal-v2-security";

export const PARTNER_TERMS_VERSION = "v1-2026-08-30";
export const PARTNER_PRIVACY_VERSION = "v1-2026-08-30";
export const ACTIVE_PARTNER_REQUEST_STATES = [
  "submitted",
  "under_review",
  "needs_information",
] as const;
export const PARTNER_LIMITED_ACCESS_CAPABILITIES = [
  "account.read",
  "bookings.read",
  "bookings.create",
  "properties.read",
  "properties.manage",
  "jobs.read",
  "media.read",
  "media.upload",
  "proof.read",
  "proof.request",
  "messages.read",
  "messages.send",
] as const;

const PERSONAS = new Set<PartnerPersona>([
  "contractor",
  "real_estate_agent",
  "property_manager",
  "commercial_client",
  "other",
]);
const PUBLIC_EMAIL_DOMAINS = new Set([
  "aol.com",
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "mail.com",
  "outlook.com",
  "proton.me",
  "protonmail.com",
  "yahoo.com",
]);

export type PartnerAccessApplicationInput = {
  email: string;
  name: string;
  phone: string | null;
  phoneE164: string | null;
  companyName: string;
  website: string | null;
  companyDomain: string | null;
  partnerType: PartnerPersona;
  serviceAreas: string[];
  requestedNeeds: string[];
  termsVersion: string;
  privacyVersion: string;
};

export type PartnerApplicationRecord = {
  id: string;
  status: PartnerAccessApplicationStatus;
  version: number;
  informationRequest: string | null;
  emailVerifiedAt: Date | null;
  submittedAt: Date;
  updatedAt: Date;
};

export type PartnerJoinRequestRecord = {
  id: string;
  accountId: string;
  accountName: string;
  requestedRoleKey: string;
  message: string | null;
  status: PartnerCompanyJoinRequestStatus;
  version: number;
  requestedAt: Date;
  updatedAt: Date;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(
  value: unknown,
  minimum: number,
  maximum: number,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  const hasControlCharacter = [...normalized].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
  return normalized.length >= minimum &&
    normalized.length <= maximum &&
    !hasControlCharacter
    ? normalized
    : null;
}

function optionalText(
  value: unknown,
  maximum: number,
): string | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  return boundedText(value, 1, maximum) ?? undefined;
}

function boundedStringArray(
  value: unknown,
  maximumItems: number,
  maximumItemLength: number,
): string[] | null {
  if (!Array.isArray(value) || value.length > maximumItems) return null;
  const normalized = value.map((item) =>
    boundedText(item, 1, maximumItemLength),
  );
  if (normalized.some((item) => item === null)) return null;
  return [...new Set(normalized as string[])];
}

function normalizedWebsite(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 500) return undefined;
  try {
    const url = new URL(value.trim());
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      !normalizeCompanyDomain(url.hostname)
    ) {
      return undefined;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

export function parsePartnerAccessApplication(
  value: unknown,
): PartnerAccessApplicationInput | null {
  if (!isRecord(value)) return null;
  const allowed = new Set([
    "email",
    "name",
    "phone",
    "companyName",
    "website",
    "partnerType",
    "serviceAreas",
    "requestedNeeds",
    "termsAccepted",
    "termsVersion",
    "privacyAccepted",
    "privacyVersion",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;

  const email = normalizeEmail(value["email"]);
  const name = boundedText(value["name"], 2, 120);
  const companyName = boundedText(value["companyName"], 2, 160);
  const rawPhone = optionalText(value["phone"], 32);
  const website = normalizedWebsite(value["website"]);
  const serviceAreas = boundedStringArray(value["serviceAreas"], 20, 100);
  const requestedNeeds = boundedStringArray(value["requestedNeeds"], 20, 100);
  const partnerType = value["partnerType"];
  if (
    !email ||
    email.length > 254 ||
    !normalizedEmailDomain(email) ||
    email.indexOf("@") !== email.lastIndexOf("@") ||
    email.slice(0, email.indexOf("@")).length > 64 ||
    /\s/u.test(email) ||
    !name ||
    !companyName ||
    rawPhone === undefined ||
    website === undefined ||
    !serviceAreas ||
    !requestedNeeds ||
    typeof partnerType !== "string" ||
    !PERSONAS.has(partnerType as PartnerPersona) ||
    value["termsAccepted"] !== true ||
    value["termsVersion"] !== PARTNER_TERMS_VERSION ||
    value["privacyAccepted"] !== true ||
    value["privacyVersion"] !== PARTNER_PRIVACY_VERSION
  ) {
    return null;
  }
  const phoneE164 = rawPhone ? normalizePhoneE164(rawPhone) : null;
  if (rawPhone && !phoneE164) return null;
  const companyDomain = website
    ? normalizeCompanyDomain(new URL(website).hostname)
    : normalizedEmailDomain(email);
  return {
    email,
    name,
    phone: rawPhone,
    phoneE164,
    companyName,
    website,
    companyDomain:
      companyDomain && !PUBLIC_EMAIL_DOMAINS.has(companyDomain)
        ? companyDomain
        : null,
    partnerType: partnerType as PartnerPersona,
    serviceAreas,
    requestedNeeds,
    termsVersion: PARTNER_TERMS_VERSION,
    privacyVersion: PARTNER_PRIVACY_VERSION,
  };
}

export function partnerApplicationIdentityHash(email: string): string {
  return createHash("sha256")
    .update(`partner-access-application\0${email}`, "utf8")
    .digest("hex");
}

function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.split(" ");
  return {
    firstName: parts[0] ?? "Partner",
    lastName: parts.slice(1).join(" ") || "Applicant",
  };
}

export async function bootstrapPartnerAccessApplication(input: {
  application: PartnerAccessApplicationInput;
  idempotencyKeyHash: string;
  correlationId: string;
}): Promise<{
  application: PartnerApplicationRecord;
  partnerUserId: string | null;
}> {
  const db = getDb();
  const identityHash = partnerApplicationIdentityHash(input.application.email);
  const now = new Date();
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`partner-application:${identityHash}`}))`,
    );
    const [existing] = await tx
      .select({
        id: partnerAccessApplications.id,
        status: partnerAccessApplications.status,
        version: partnerAccessApplications.version,
        informationRequest: partnerAccessApplications.reviewNote,
        emailVerifiedAt: partnerAccessApplications.emailVerifiedAt,
        submittedAt: partnerAccessApplications.submittedAt,
        updatedAt: partnerAccessApplications.updatedAt,
        partnerUserId: partnerAccessApplications.applicantPartnerUserId,
      })
      .from(partnerAccessApplications)
      .where(
        and(
          eq(partnerAccessApplications.identityHash, identityHash),
          or(
            eq(partnerAccessApplications.status, "submitted"),
            eq(partnerAccessApplications.status, "under_review"),
            eq(partnerAccessApplications.status, "needs_information"),
          ),
        ),
      )
      .limit(1);
    if (existing) {
      return {
        application: {
          id: existing.id,
          status: existing.status,
          version: existing.version,
          informationRequest: existing.informationRequest,
          emailVerifiedAt: existing.emailVerifiedAt,
          submittedAt: existing.submittedAt,
          updatedAt: existing.updatedAt,
        },
        partnerUserId: existing.partnerUserId,
      };
    }

    const [existingUser] = await tx
      .select({ id: partnerUsers.id, active: partnerUsers.active })
      .from(partnerUsers)
      .where(
        sql`lower(btrim(${partnerUsers.email})) = ${input.application.email}`,
      )
      .limit(1);

    let partnerUserId: string | null = existingUser?.active
      ? existingUser.id
      : null;
    let bootstrapAccountId: string | null = null;
    if (!existingUser || existingUser.active) {
      const [account] = await tx
        .insert(partnerAccounts)
        .values({
          name: input.application.companyName,
          normalizedName: input.application.companyName.toLowerCase(),
          domain: input.application.companyDomain,
          website: input.application.website,
          segment: input.application.partnerType,
          status: "trial_partner",
          source: "partner_portal_access_application",
          portalFit: "application_pending",
          portalAccessEnabled: true,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: partnerAccounts.id });
      if (!account) throw new Error("partner_application_account_not_created");
      bootstrapAccountId = account.id;
      const names = splitName(input.application.name);
      const [contact] = await tx
        .insert(contacts)
        .values({
          firstName: names.firstName,
          lastName: names.lastName,
          company: input.application.companyName,
          partnerAccountId: account.id,
          partnerStatus: "partner",
          partnerType: input.application.partnerType,
          partnerSince: now,
          preferredContactMethod: "email",
          source: "partner_portal_access_application",
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: contacts.id });
      if (!contact) throw new Error("partner_application_contact_not_created");
      await tx
        .update(partnerAccounts)
        .set({ portalContactId: contact.id, updatedAt: now })
        .where(eq(partnerAccounts.id, account.id));

      if (!partnerUserId) {
        const [user] = await tx
          .insert(partnerUsers)
          .values({
            orgContactId: contact.id,
            email: input.application.email,
            name: input.application.name,
            active: true,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: partnerUsers.id });
        if (!user) throw new Error("partner_application_user_not_created");
        partnerUserId = user.id;
      }

      const [role] = await tx
        .insert(partnerRoleTemplates)
        .values({
          partnerAccountId: account.id,
          key: "applicant",
          name: "Applicant",
          description:
            "Limited access while Stonegate reviews the partner application.",
          capabilities: [...PARTNER_LIMITED_ACCESS_CAPABILITIES],
          isSystem: false,
          active: true,
          createdByPartnerUserId: partnerUserId,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: partnerRoleTemplates.id });
      if (!role || !partnerUserId) {
        throw new Error("partner_application_role_not_created");
      }
      const [defaultMembership] = await tx
        .select({ id: partnerAccountMemberships.id })
        .from(partnerAccountMemberships)
        .where(
          and(
            eq(partnerAccountMemberships.partnerUserId, partnerUserId),
            eq(partnerAccountMemberships.status, "active"),
            eq(partnerAccountMemberships.isDefault, true),
          ),
        )
        .limit(1);
      await tx.insert(partnerAccountMemberships).values({
        partnerAccountId: account.id,
        partnerUserId,
        roleTemplateId: role.id,
        roleKey: "applicant",
        status: "active",
        persona: input.application.partnerType,
        accessLevel: "account",
        accessScope: {},
        preferences: {
          timezone: "America/New_York",
          notificationChannels: ["email", "in_portal"],
        },
        isDefault: !defaultMembership,
        acceptedAt: now,
        invitedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }

    const [application] = await tx
      .insert(partnerAccessApplications)
      .values({
        identityHash,
        email: input.application.email,
        normalizedEmail: input.application.email,
        name: input.application.name,
        phone: input.application.phone,
        phoneE164: input.application.phoneE164,
        companyName: input.application.companyName,
        website: input.application.website,
        partnerType: input.application.partnerType,
        serviceAreas: input.application.serviceAreas,
        requestedNeeds: input.application.requestedNeeds,
        status: "submitted",
        applicantPartnerUserId: partnerUserId,
        bootstrapPartnerAccountId: bootstrapAccountId,
        termsAcceptedAt: now,
        privacyAcceptedAt: now,
        submittedAt: now,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning({
        id: partnerAccessApplications.id,
        status: partnerAccessApplications.status,
        version: partnerAccessApplications.version,
        informationRequest: partnerAccessApplications.reviewNote,
        emailVerifiedAt: partnerAccessApplications.emailVerifiedAt,
        submittedAt: partnerAccessApplications.submittedAt,
        updatedAt: partnerAccessApplications.updatedAt,
      });
    if (!application) throw new Error("partner_application_not_created");
    await tx.insert(auditLogs).values({
      actorType: "system",
      actorLabel: "public_partner_applicant",
      correlationId: input.correlationId,
      outcome: "succeeded",
      surface: "partner_portal_v2",
      idempotencyKeyHash: input.idempotencyKeyHash,
      action: "partner.access_application.submitted",
      entityType: "partner_access_application",
      entityId: application.id,
      meta: {
        bootstrapAccountId,
        termsVersion: input.application.termsVersion,
        privacyVersion: input.application.privacyVersion,
        limitedAccess: true,
      },
      createdAt: now,
    });
    return { application, partnerUserId };
  });
}

export async function listPartnerAccessApplications(
  partnerUserId: string,
): Promise<PartnerApplicationRecord[]> {
  return getDb()
    .select({
      id: partnerAccessApplications.id,
      status: partnerAccessApplications.status,
      version: partnerAccessApplications.version,
      informationRequest: partnerAccessApplications.reviewNote,
      emailVerifiedAt: partnerAccessApplications.emailVerifiedAt,
      submittedAt: partnerAccessApplications.submittedAt,
      updatedAt: partnerAccessApplications.updatedAt,
    })
    .from(partnerAccessApplications)
    .where(eq(partnerAccessApplications.applicantPartnerUserId, partnerUserId))
    .orderBy(desc(partnerAccessApplications.submittedAt));
}

export async function findPartnerAccessApplication(
  partnerUserId: string,
  applicationId: string,
): Promise<PartnerApplicationRecord | null> {
  const [row] = await getDb()
    .select({
      id: partnerAccessApplications.id,
      status: partnerAccessApplications.status,
      version: partnerAccessApplications.version,
      informationRequest: partnerAccessApplications.reviewNote,
      emailVerifiedAt: partnerAccessApplications.emailVerifiedAt,
      submittedAt: partnerAccessApplications.submittedAt,
      updatedAt: partnerAccessApplications.updatedAt,
    })
    .from(partnerAccessApplications)
    .where(
      and(
        eq(partnerAccessApplications.id, applicationId),
        eq(partnerAccessApplications.applicantPartnerUserId, partnerUserId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function withdrawPartnerAccessApplication(input: {
  partnerUserId: string;
  applicationId: string;
  expectedVersion: number;
  sessionId: string;
  correlationId: string;
  idempotencyKeyHash: string;
}): Promise<PartnerApplicationRecord | null> {
  const db = getDb();
  const now = new Date();
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(partnerAccessApplications)
      .set({
        status: "withdrawn",
        version: sql`${partnerAccessApplications.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(partnerAccessApplications.id, input.applicationId),
          eq(
            partnerAccessApplications.applicantPartnerUserId,
            input.partnerUserId,
          ),
          eq(partnerAccessApplications.version, input.expectedVersion),
          or(
            eq(partnerAccessApplications.status, "submitted"),
            eq(partnerAccessApplications.status, "under_review"),
            eq(partnerAccessApplications.status, "needs_information"),
          ),
        ),
      )
      .returning({
        id: partnerAccessApplications.id,
        status: partnerAccessApplications.status,
        version: partnerAccessApplications.version,
        informationRequest: partnerAccessApplications.reviewNote,
        emailVerifiedAt: partnerAccessApplications.emailVerifiedAt,
        submittedAt: partnerAccessApplications.submittedAt,
        updatedAt: partnerAccessApplications.updatedAt,
      });
    if (!updated) return null;
    await tx.insert(auditLogs).values({
      actorType: "human",
      actorId: input.partnerUserId,
      sessionId: input.sessionId,
      authMethod: "partner_session",
      correlationId: input.correlationId,
      outcome: "succeeded",
      surface: "partner_portal_v2",
      idempotencyKeyHash: input.idempotencyKeyHash,
      action: "partner.access_application.withdrawn",
      entityType: "partner_access_application",
      entityId: input.applicationId,
      createdAt: now,
    });
    return updated;
  });
}

export function parsePartnerJoinRequest(value: unknown): {
  accountId: string;
  requestedRoleKey: string;
  message: string | null;
} | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (
    keys.some(
      (key) => !["accountId", "requestedRoleKey", "message"].includes(key),
    )
  )
    return null;
  const accountId = boundedText(value["accountId"], 36, 36);
  const requestedRoleKey = boundedText(
    value["requestedRoleKey"] ?? "member",
    2,
    64,
  );
  const message = optionalText(value["message"], 1_000);
  if (
    !accountId ||
    !isPortalV2Uuid(accountId) ||
    !requestedRoleKey ||
    !/^[a-z][a-z0-9_]{1,63}$/u.test(requestedRoleKey) ||
    message === undefined
  )
    return null;
  return { accountId: accountId.toLowerCase(), requestedRoleKey, message };
}

export async function createVerifiedDomainJoinRequest(input: {
  partnerUserId: string;
  email: string;
  accountId: string;
  requestedRoleKey: string;
  message: string | null;
  sessionId: string;
  correlationId: string;
  idempotencyKeyHash: string;
}): Promise<
  PartnerJoinRequestRecord | "domain_mismatch" | "already_member" | null
> {
  const emailDomain = normalizedEmailDomain(input.email);
  if (!emailDomain || PUBLIC_EMAIL_DOMAINS.has(emailDomain))
    return "domain_mismatch";
  const db = getDb();
  const now = new Date();
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`partner-join:${input.partnerUserId}:${input.accountId}`}))`,
    );
    const [account] = await tx
      .select({
        id: partnerAccounts.id,
        name: partnerAccounts.name,
        domain: partnerAccounts.domain,
      })
      .from(partnerAccounts)
      .where(
        and(
          eq(partnerAccounts.id, input.accountId),
          eq(partnerAccounts.portalAccessEnabled, true),
        ),
      )
      .limit(1);
    if (!account || normalizeCompanyDomain(account.domain) !== emailDomain) {
      return "domain_mismatch" as const;
    }
    const [membership] = await tx
      .select({ id: partnerAccountMemberships.id })
      .from(partnerAccountMemberships)
      .where(
        and(
          eq(partnerAccountMemberships.partnerUserId, input.partnerUserId),
          eq(partnerAccountMemberships.partnerAccountId, account.id),
          eq(partnerAccountMemberships.status, "active"),
        ),
      )
      .limit(1);
    if (membership) return "already_member" as const;
    const [existing] = await tx
      .select({
        id: partnerCompanyJoinRequests.id,
        accountId: partnerCompanyJoinRequests.partnerAccountId,
        requestedRoleKey: partnerCompanyJoinRequests.requestedRoleKey,
        message: partnerCompanyJoinRequests.message,
        status: partnerCompanyJoinRequests.status,
        version: partnerCompanyJoinRequests.version,
        requestedAt: partnerCompanyJoinRequests.requestedAt,
        updatedAt: partnerCompanyJoinRequests.updatedAt,
      })
      .from(partnerCompanyJoinRequests)
      .where(
        and(
          eq(partnerCompanyJoinRequests.partnerUserId, input.partnerUserId),
          eq(partnerCompanyJoinRequests.partnerAccountId, account.id),
          or(
            eq(partnerCompanyJoinRequests.status, "submitted"),
            eq(partnerCompanyJoinRequests.status, "under_review"),
            eq(partnerCompanyJoinRequests.status, "needs_information"),
          ),
        ),
      )
      .limit(1);
    if (existing) return { ...existing, accountName: account.name };
    const [created] = await tx
      .insert(partnerCompanyJoinRequests)
      .values({
        partnerUserId: input.partnerUserId,
        partnerAccountId: account.id,
        requestedRoleKey: input.requestedRoleKey,
        message: input.message,
        status: "submitted",
        requestedAt: now,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning({
        id: partnerCompanyJoinRequests.id,
        accountId: partnerCompanyJoinRequests.partnerAccountId,
        requestedRoleKey: partnerCompanyJoinRequests.requestedRoleKey,
        message: partnerCompanyJoinRequests.message,
        status: partnerCompanyJoinRequests.status,
        version: partnerCompanyJoinRequests.version,
        requestedAt: partnerCompanyJoinRequests.requestedAt,
        updatedAt: partnerCompanyJoinRequests.updatedAt,
      });
    if (!created) return null;
    await tx.insert(auditLogs).values({
      actorType: "human",
      actorId: input.partnerUserId,
      sessionId: input.sessionId,
      authMethod: "partner_session",
      correlationId: input.correlationId,
      outcome: "succeeded",
      surface: "partner_portal_v2",
      idempotencyKeyHash: input.idempotencyKeyHash,
      action: "partner.company_join_request.submitted",
      entityType: "partner_company_join_request",
      entityId: created.id,
      meta: { verifiedDomain: emailDomain, accountId: account.id },
      createdAt: now,
    });
    return { ...created, accountName: account.name };
  });
}

export async function listPartnerJoinRequests(
  partnerUserId: string,
): Promise<PartnerJoinRequestRecord[]> {
  return getDb()
    .select({
      id: partnerCompanyJoinRequests.id,
      accountId: partnerCompanyJoinRequests.partnerAccountId,
      accountName: partnerAccounts.name,
      requestedRoleKey: partnerCompanyJoinRequests.requestedRoleKey,
      message: partnerCompanyJoinRequests.message,
      status: partnerCompanyJoinRequests.status,
      version: partnerCompanyJoinRequests.version,
      requestedAt: partnerCompanyJoinRequests.requestedAt,
      updatedAt: partnerCompanyJoinRequests.updatedAt,
    })
    .from(partnerCompanyJoinRequests)
    .innerJoin(
      partnerAccounts,
      eq(partnerCompanyJoinRequests.partnerAccountId, partnerAccounts.id),
    )
    .where(eq(partnerCompanyJoinRequests.partnerUserId, partnerUserId))
    .orderBy(desc(partnerCompanyJoinRequests.requestedAt));
}

export async function listVerifiedDomainJoinAccounts(input: {
  partnerUserId: string;
  email: string;
}): Promise<Array<{ id: string; name: string; domain: string }>> {
  const emailDomain = normalizedEmailDomain(input.email);
  if (!emailDomain || PUBLIC_EMAIL_DOMAINS.has(emailDomain)) return [];
  const rows = await getDb()
    .select({
      id: partnerAccounts.id,
      name: partnerAccounts.name,
      domain: partnerAccounts.domain,
      membershipId: partnerAccountMemberships.id,
      membershipStatus: partnerAccountMemberships.status,
    })
    .from(partnerAccounts)
    .leftJoin(
      partnerAccountMemberships,
      and(
        eq(partnerAccountMemberships.partnerAccountId, partnerAccounts.id),
        eq(partnerAccountMemberships.partnerUserId, input.partnerUserId),
      ),
    )
    .where(
      and(
        eq(partnerAccounts.portalAccessEnabled, true),
        sql`lower(regexp_replace(split_part(regexp_replace(btrim(${partnerAccounts.domain}), '^https?://', ''), '/', 1), '^www\\.', '')) = ${emailDomain}`,
      ),
    )
    .orderBy(partnerAccounts.name)
    .limit(50);
  return rows.flatMap((row) => {
    const domain = normalizeCompanyDomain(row.domain);
    return domain === emailDomain && row.membershipStatus !== "active"
      ? [{ id: row.id, name: row.name, domain }]
      : [];
  });
}

export async function findPartnerJoinRequest(
  partnerUserId: string,
  requestId: string,
): Promise<PartnerJoinRequestRecord | null> {
  const [row] = await getDb()
    .select({
      id: partnerCompanyJoinRequests.id,
      accountId: partnerCompanyJoinRequests.partnerAccountId,
      accountName: partnerAccounts.name,
      requestedRoleKey: partnerCompanyJoinRequests.requestedRoleKey,
      message: partnerCompanyJoinRequests.message,
      status: partnerCompanyJoinRequests.status,
      version: partnerCompanyJoinRequests.version,
      requestedAt: partnerCompanyJoinRequests.requestedAt,
      updatedAt: partnerCompanyJoinRequests.updatedAt,
    })
    .from(partnerCompanyJoinRequests)
    .innerJoin(
      partnerAccounts,
      eq(partnerCompanyJoinRequests.partnerAccountId, partnerAccounts.id),
    )
    .where(
      and(
        eq(partnerCompanyJoinRequests.id, requestId),
        eq(partnerCompanyJoinRequests.partnerUserId, partnerUserId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function withdrawPartnerJoinRequest(input: {
  partnerUserId: string;
  requestId: string;
  expectedVersion: number;
  sessionId: string;
  correlationId: string;
  idempotencyKeyHash: string;
}): Promise<PartnerJoinRequestRecord | null> {
  const db = getDb();
  const now = new Date();
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(partnerCompanyJoinRequests)
      .set({
        status: "withdrawn",
        version: sql`${partnerCompanyJoinRequests.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(partnerCompanyJoinRequests.id, input.requestId),
          eq(partnerCompanyJoinRequests.partnerUserId, input.partnerUserId),
          eq(partnerCompanyJoinRequests.version, input.expectedVersion),
          or(
            eq(partnerCompanyJoinRequests.status, "submitted"),
            eq(partnerCompanyJoinRequests.status, "under_review"),
            eq(partnerCompanyJoinRequests.status, "needs_information"),
          ),
        ),
      )
      .returning({
        id: partnerCompanyJoinRequests.id,
        accountId: partnerCompanyJoinRequests.partnerAccountId,
        requestedRoleKey: partnerCompanyJoinRequests.requestedRoleKey,
        message: partnerCompanyJoinRequests.message,
        status: partnerCompanyJoinRequests.status,
        version: partnerCompanyJoinRequests.version,
        requestedAt: partnerCompanyJoinRequests.requestedAt,
        updatedAt: partnerCompanyJoinRequests.updatedAt,
      });
    if (!updated) return null;
    const [account] = await tx
      .select({ name: partnerAccounts.name })
      .from(partnerAccounts)
      .where(eq(partnerAccounts.id, updated.accountId))
      .limit(1);
    await tx.insert(auditLogs).values({
      actorType: "human",
      actorId: input.partnerUserId,
      sessionId: input.sessionId,
      authMethod: "partner_session",
      correlationId: input.correlationId,
      outcome: "succeeded",
      surface: "partner_portal_v2",
      idempotencyKeyHash: input.idempotencyKeyHash,
      action: "partner.company_join_request.withdrawn",
      entityType: "partner_company_join_request",
      entityId: input.requestId,
      createdAt: now,
    });
    return { ...updated, accountName: account?.name ?? "Partner account" };
  });
}

export async function markPartnerEmailVerified(
  partnerUserId: string,
): Promise<void> {
  await getDb()
    .update(partnerAccessApplications)
    .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(partnerAccessApplications.applicantPartnerUserId, partnerUserId),
        isNull(partnerAccessApplications.emailVerifiedAt),
      ),
    );
}
