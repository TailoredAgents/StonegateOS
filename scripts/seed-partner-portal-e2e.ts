import crypto from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type * as DbModule from "../apps/api/src/db";
import type * as PropertyWriteModule from "../apps/api/src/lib/property-write";

export const PARTNER_PORTAL_E2E_MATRIX_VERSION = "partner-portal-v2-2026-08";

/** Local/disposable E2E credential only. Never use this outside the E2E seed. */
export const PARTNER_PORTAL_E2E_PASSWORD = "E2E-partner-only-2026!";

export const PARTNER_PORTAL_E2E_MEMBER_MATRIX = [
  {
    key: "admin",
    roleKey: "admin",
    persona: "property_manager",
    account: "primary",
    status: "active",
    mfaRequired: true,
  },
  {
    key: "scheduler",
    roleKey: "scheduler",
    persona: "contractor",
    account: "primary",
    status: "active",
    mfaRequired: false,
  },
  {
    key: "requester",
    roleKey: "requester",
    persona: "real_estate_agent",
    account: "primary",
    status: "active",
    mfaRequired: false,
  },
  {
    key: "approver",
    roleKey: "approver",
    persona: "commercial_client",
    account: "primary",
    status: "active",
    mfaRequired: true,
  },
  {
    key: "billing",
    roleKey: "billing",
    persona: "commercial_client",
    account: "primary",
    status: "active",
    mfaRequired: true,
  },
  {
    key: "viewer",
    roleKey: "viewer",
    persona: "property_manager",
    account: "secondary",
    status: "active",
    mfaRequired: false,
  },
  {
    key: "suspended",
    roleKey: "viewer",
    persona: "real_estate_agent",
    account: "primary",
    status: "suspended",
    mfaRequired: false,
  },
  {
    key: "limited",
    roleKey: "applicant",
    persona: "contractor",
    account: "limited",
    status: "active",
    mfaRequired: false,
  },
] as const;

export const PARTNER_PORTAL_E2E_JOB_STATES = [
  "requested",
  "approval_needed",
  "under_review",
  "confirmed",
  "en_route",
  "in_progress",
  "completed",
  "canceled",
  "declined",
] as const;

export const PARTNER_PORTAL_E2E_INVOICE_STATES = [
  "issued",
  "partially_paid",
  "paid",
  "overdue",
] as const;

const SYSTEM_ROLE_IDS = {
  admin: "f0000000-0000-4000-8000-000000000002",
  scheduler: "f0000000-0000-4000-8000-000000000003",
  approver: "f0000000-0000-4000-8000-000000000004",
  billing: "f0000000-0000-4000-8000-000000000005",
  viewer: "f0000000-0000-4000-8000-000000000006",
} as const;

const REQUESTER_CAPABILITIES = [
  "portal.session.read",
  "portal.session.switch_account",
  "account.read",
  "bookings.read",
  "bookings.create",
  "properties.read",
  "jobs.read",
  "media.read",
  "media.upload",
  "proof.read",
  "proof.request",
  "rates.read",
  "documents.read",
  "messages.read",
  "messages.send",
] as const;

const LIMITED_CAPABILITIES = [
  "portal.session.read",
  "portal.session.switch_account",
  "account.read",
  "bookings.read",
  "bookings.create",
  "properties.read",
  "properties.manage",
  "media.read",
  "media.upload",
  "proof.request",
] as const;

type MatrixMemberKey = (typeof PARTNER_PORTAL_E2E_MEMBER_MATRIX)[number]["key"];
type MatrixAccountKey = "primary" | "secondary" | "limited";

export type PartnerPortalE2ESeedSummary = {
  matrixVersion: typeof PARTNER_PORTAL_E2E_MATRIX_VERSION;
  accountIds: Record<MatrixAccountKey, string>;
  userIds: Record<MatrixMemberKey, string>;
  membershipIds: Record<MatrixMemberKey | "admin_secondary", string>;
  locationIds: string[];
  jobIds: Record<(typeof PARTNER_PORTAL_E2E_JOB_STATES)[number], string>;
  invoiceIds: Record<
    (typeof PARTNER_PORTAL_E2E_INVOICE_STATES)[number],
    string
  >;
  localCredentialEmails: Record<MatrixMemberKey, string>;
};

function runSlug(runId: string): string {
  const readable =
    runId
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 32) || "local";
  const suffix = crypto
    .createHash("sha256")
    .update(runId)
    .digest("hex")
    .slice(0, 8);
  return `${readable}-${suffix}`;
}

function fixtureEmail(runId: string, key: MatrixMemberKey): string {
  return `e2e+portal-${key}-${runSlug(runId)}@mystos.test`;
}

export function partnerPortalFixtureEmails(runId: string): string[] {
  return PARTNER_PORTAL_E2E_MEMBER_MATRIX.map((member) =>
    fixtureEmail(runId, member.key),
  );
}

export function partnerPortalSessionToken(
  runId: string,
  key: MatrixMemberKey,
): string {
  return crypto
    .createHash("sha256")
    .update(`stonegate-partner-portal-e2e-session\0${runId}\0${key}`)
    .digest("base64url");
}

function sessionHash(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("base64url");
}

function passwordHash(password: string, label: string): string {
  const salt = crypto
    .createHash("sha256")
    .update(`e2e-password-salt\0${label}`)
    .digest()
    .subarray(0, 16);
  const derived = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

function hexHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function phoneFor(
  runId: string,
  key: MatrixMemberKey,
): { phone: string; phoneE164: string } {
  const seed = hexHash(`${runId}:${key}`).slice(0, 4);
  const digits = Array.from(seed, (character) =>
    String(Number.parseInt(character, 16) % 10),
  ).join("");
  return { phone: `470555${digits}`, phoneE164: `+1470555${digits}` };
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.values(value).every(
        (entry) => typeof entry === "string" && entry.length > 0,
      ),
  );
}

export function readPartnerPortalE2ESeedSummary(
  value: unknown,
): PartnerPortalE2ESeedSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record["matrixVersion"] !== PARTNER_PORTAL_E2E_MATRIX_VERSION ||
    !isStringRecord(record["accountIds"]) ||
    !isStringRecord(record["userIds"]) ||
    !isStringRecord(record["membershipIds"]) ||
    !Array.isArray(record["locationIds"]) ||
    !record["locationIds"].every((entry) => typeof entry === "string") ||
    !isStringRecord(record["jobIds"]) ||
    !isStringRecord(record["invoiceIds"]) ||
    !isStringRecord(record["localCredentialEmails"])
  )
    return null;
  const accountIds = record["accountIds"] as Record<string, string>;
  const userIds = record["userIds"] as Record<string, string>;
  const membershipIds = record["membershipIds"] as Record<string, string>;
  const locationIds = record["locationIds"] as string[];
  const jobIds = record["jobIds"] as Record<string, string>;
  const invoiceIds = record["invoiceIds"] as Record<string, string>;
  const localCredentialEmails = record["localCredentialEmails"] as Record<
    string,
    string
  >;
  const requiredMemberKeys = PARTNER_PORTAL_E2E_MEMBER_MATRIX.map(
    (member) => member.key,
  );
  const hasMembers = requiredMemberKeys.every((key) =>
    Boolean(userIds[key] && membershipIds[key] && localCredentialEmails[key]),
  );
  const hasAccounts = (["primary", "secondary", "limited"] as const).every(
    (key) => Boolean(accountIds[key]),
  );
  const hasJobs = PARTNER_PORTAL_E2E_JOB_STATES.every((state) =>
    Boolean(jobIds[state]),
  );
  const hasInvoices = PARTNER_PORTAL_E2E_INVOICE_STATES.every((state) =>
    Boolean(invoiceIds[state]),
  );
  if (
    !hasMembers ||
    !hasAccounts ||
    !hasJobs ||
    !hasInvoices ||
    locationIds.length < 3
  )
    return null;
  return record as PartnerPortalE2ESeedSummary;
}

export async function assertPartnerPortalE2EMatrix(
  db: typeof DbModule,
  summary: PartnerPortalE2ESeedSummary,
): Promise<void> {
  const database = db.getDb();
  const membershipIds = Object.values(summary.membershipIds);
  const memberships = await database
    .select({
      id: db.partnerAccountMemberships.id,
      accountId: db.partnerAccountMemberships.partnerAccountId,
      userId: db.partnerAccountMemberships.partnerUserId,
      roleKey: db.partnerAccountMemberships.roleKey,
      persona: db.partnerAccountMemberships.persona,
      status: db.partnerAccountMemberships.status,
    })
    .from(db.partnerAccountMemberships)
    .where(inArray(db.partnerAccountMemberships.id, membershipIds));
  const requiredRoles = new Set([
    "admin",
    "scheduler",
    "requester",
    "approver",
    "billing",
    "viewer",
  ]);
  const seededRoles = new Set(
    memberships
      .filter((row) => row.status === "active")
      .map((row) => row.roleKey),
  );
  const seededPersonas = new Set<string>(memberships.map((row) => row.persona));
  const adminAccounts = new Set(
    memberships
      .filter(
        (row) =>
          row.userId === summary.userIds.admin && row.status === "active",
      )
      .map((row) => row.accountId),
  );
  if (
    memberships.length !== membershipIds.length ||
    ![...requiredRoles].every((role) => seededRoles.has(role)) ||
    ![
      "contractor",
      "real_estate_agent",
      "property_manager",
      "commercial_client",
    ].every((persona) => seededPersonas.has(persona)) ||
    !memberships.some((row) => row.status === "suspended") ||
    !memberships.some(
      (row) => row.roleKey === "applicant" && row.status === "active",
    ) ||
    adminAccounts.size < 2
  ) {
    throw new Error(
      "The reusable E2E partner access/persona/role matrix is incomplete. Recreate the isolated E2E database.",
    );
  }

  const mfaUserIds = [
    summary.userIds.admin,
    summary.userIds.approver,
    summary.userIds.billing,
  ];
  const mfaUsers = await database
    .select({
      id: db.partnerUsers.id,
      required: db.partnerUsers.mfaRequired,
      enrolledAt: db.partnerUsers.mfaEnrolledAt,
      methodId: db.partnerMfaMethods.id,
    })
    .from(db.partnerUsers)
    .leftJoin(
      db.partnerMfaMethods,
      and(
        eq(db.partnerMfaMethods.partnerUserId, db.partnerUsers.id),
        eq(db.partnerMfaMethods.enabled, true),
      ),
    )
    .where(inArray(db.partnerUsers.id, mfaUserIds));
  if (
    mfaUsers.length !== mfaUserIds.length ||
    mfaUsers.some((row) => !row.required || !row.enrolledAt || !row.methodId)
  ) {
    throw new Error(
      "The reusable E2E partner MFA matrix is incomplete. Recreate the isolated E2E database.",
    );
  }

  const bookings = await database
    .select({
      id: db.partnerBookings.id,
      status: db.partnerBookings.publicStatus,
    })
    .from(db.partnerBookings)
    .where(inArray(db.partnerBookings.id, Object.values(summary.jobIds)));
  const jobStates = new Set(bookings.map((row) => row.status));
  if (
    bookings.length !== PARTNER_PORTAL_E2E_JOB_STATES.length ||
    !PARTNER_PORTAL_E2E_JOB_STATES.every((state) => jobStates.has(state))
  ) {
    throw new Error(
      "The reusable E2E partner job-state matrix is incomplete. Recreate the isolated E2E database.",
    );
  }

  const invoices = await database
    .select({
      id: db.partnerInvoices.id,
      status: db.partnerInvoices.status,
    })
    .from(db.partnerInvoices)
    .where(inArray(db.partnerInvoices.id, Object.values(summary.invoiceIds)));
  const invoiceStates = new Set(invoices.map((row) => row.status));
  if (
    invoices.length !== PARTNER_PORTAL_E2E_INVOICE_STATES.length ||
    !PARTNER_PORTAL_E2E_INVOICE_STATES.every((state) =>
      invoiceStates.has(state),
    )
  ) {
    throw new Error(
      "The reusable E2E partner billing-state matrix is incomplete. Recreate the isolated E2E database.",
    );
  }
}

export async function seedPartnerPortalE2E(
  db: typeof DbModule,
  propertyWrite: typeof PropertyWriteModule,
  runId: string,
): Promise<PartnerPortalE2ESeedSummary> {
  const database = db.getDb();
  const slug = runSlug(runId);
  const now = new Date();
  const memberRecords = Object.fromEntries(
    PARTNER_PORTAL_E2E_MEMBER_MATRIX.map((member) => [
      member.key,
      {
        ...member,
        email: fixtureEmail(runId, member.key),
        ...phoneFor(runId, member.key),
      },
    ]),
  ) as Record<
    MatrixMemberKey,
    (typeof PARTNER_PORTAL_E2E_MEMBER_MATRIX)[number] & {
      email: string;
      phone: string;
      phoneE164: string;
    }
  >;

  return database.transaction(async (tx) => {
    const contactIds = {} as Record<MatrixMemberKey, string>;
    for (const member of PARTNER_PORTAL_E2E_MEMBER_MATRIX) {
      const fixture = memberRecords[member.key];
      const [contact] = await tx
        .insert(db.contacts)
        .values({
          firstName: "E2E",
          lastName: member.key.replaceAll("_", " "),
          company: `E2E Partner Portal ${member.account}`,
          email: fixture.email,
          phone: fixture.phone,
          phoneE164: fixture.phoneE164,
          preferredContactMethod: "email",
          source: `e2e_partner_portal_${slug}`,
          partnerStatus: "partner",
          partnerType: member.persona,
          partnerSince: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: db.contacts.id });
      if (!contact)
        throw new Error(`Unable to seed E2E partner contact ${member.key}.`);
      contactIds[member.key] = contact.id;
    }

    const accountContacts: Record<MatrixAccountKey, string> = {
      primary: contactIds.admin,
      secondary: contactIds.viewer,
      limited: contactIds.limited,
    };
    const accountIds = {} as Record<MatrixAccountKey, string>;
    for (const accountKey of ["primary", "secondary", "limited"] as const) {
      const [account] = await tx
        .insert(db.partnerAccounts)
        .values({
          name: `E2E Portal ${accountKey} ${slug}`,
          normalizedName: `e2e portal ${accountKey} ${slug}`,
          domain:
            accountKey === "limited"
              ? null
              : `${accountKey}-${slug}.mystos.test`,
          segment:
            accountKey === "limited" ? "contractor" : "commercial_client",
          status: accountKey === "limited" ? "trial_partner" : "portal_partner",
          source: "e2e_partner_portal_matrix",
          portalContactId: accountContacts[accountKey],
          portalAccessEnabled: true,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: db.partnerAccounts.id });
      if (!account)
        throw new Error(`Unable to seed E2E partner account ${accountKey}.`);
      accountIds[accountKey] = account.id;
    }
    for (const member of PARTNER_PORTAL_E2E_MEMBER_MATRIX) {
      await tx
        .update(db.contacts)
        .set({
          partnerAccountId: accountIds[member.account],
          updatedAt: now,
        })
        .where(eq(db.contacts.id, contactIds[member.key]));
    }

    const userIds = {} as Record<MatrixMemberKey, string>;
    for (const member of PARTNER_PORTAL_E2E_MEMBER_MATRIX) {
      const fixture = memberRecords[member.key];
      const [user] = await tx
        .insert(db.partnerUsers)
        .values({
          orgContactId: contactIds[member.key],
          email: fixture.email,
          phone: fixture.phone,
          phoneE164: fixture.phoneE164,
          name: `E2E Portal ${member.key}`,
          active: true,
          passwordHash: passwordHash(
            PARTNER_PORTAL_E2E_PASSWORD,
            `${runId}:${member.key}`,
          ),
          passwordSetAt: now,
          mfaRequired: member.mfaRequired,
          mfaEnrolledAt: member.mfaRequired ? now : null,
          securityVersion: 1,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: db.partnerUsers.id });
      if (!user)
        throw new Error(`Unable to seed E2E partner user ${member.key}.`);
      userIds[member.key] = user.id;
    }

    const [requesterRole] = await tx
      .insert(db.partnerRoleTemplates)
      .values({
        partnerAccountId: accountIds.primary,
        key: "requester",
        name: "Requester",
        description:
          "Create service requests and collaborate on assigned work without administrative authority.",
        capabilities: [...REQUESTER_CAPABILITIES],
        isSystem: false,
        active: true,
        createdByPartnerUserId: userIds.admin,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: db.partnerRoleTemplates.id });
    const [applicantRole] = await tx
      .insert(db.partnerRoleTemplates)
      .values({
        partnerAccountId: accountIds.limited,
        key: "applicant",
        name: "Applicant",
        description:
          "Limited workspace access while Stonegate reviews this partner application.",
        capabilities: [...LIMITED_CAPABILITIES],
        isSystem: false,
        active: true,
        createdByPartnerUserId: userIds.limited,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: db.partnerRoleTemplates.id });
    if (!requesterRole || !applicantRole)
      throw new Error("Unable to seed E2E partner role templates.");

    const membershipIds = {} as Record<
      MatrixMemberKey | "admin_secondary",
      string
    >;
    for (const member of PARTNER_PORTAL_E2E_MEMBER_MATRIX) {
      const roleTemplateId =
        member.roleKey === "requester"
          ? requesterRole.id
          : member.roleKey === "applicant"
            ? applicantRole.id
            : SYSTEM_ROLE_IDS[member.roleKey as keyof typeof SYSTEM_ROLE_IDS];
      const isSuspended = member.status === "suspended";
      const [membership] = await tx
        .insert(db.partnerAccountMemberships)
        .values({
          partnerAccountId: accountIds[member.account],
          partnerUserId: userIds[member.key],
          roleTemplateId,
          roleKey: member.roleKey,
          status: member.status,
          persona: member.persona,
          accessLevel: "account",
          accessScope: {},
          preferences: {
            timezone: "America/New_York",
            locale: "en-US",
            notificationChannels: ["email", "in_portal"],
          },
          isDefault: member.status === "active",
          invitedAt: new Date(now.getTime() - 7 * 24 * 60 * 60_000),
          acceptedAt: new Date(now.getTime() - 6 * 24 * 60 * 60_000),
          suspendedAt: isSuspended ? now : null,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: db.partnerAccountMemberships.id });
      if (!membership)
        throw new Error(`Unable to seed E2E partner membership ${member.key}.`);
      membershipIds[member.key] = membership.id;
    }
    const [adminSecondary] = await tx
      .insert(db.partnerAccountMemberships)
      .values({
        partnerAccountId: accountIds.secondary,
        partnerUserId: userIds.admin,
        roleTemplateId: SYSTEM_ROLE_IDS.viewer,
        roleKey: "viewer",
        status: "active",
        persona: "property_manager",
        accessLevel: "account",
        accessScope: {},
        preferences: { timezone: "America/New_York", locale: "en-US" },
        isDefault: false,
        invitedAt: now,
        acceptedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: db.partnerAccountMemberships.id });
    if (!adminSecondary)
      throw new Error("Unable to seed E2E multi-account membership.");
    membershipIds.admin_secondary = adminSecondary.id;

    for (const memberKey of ["admin", "approver", "billing"] as const) {
      await tx.insert(db.partnerMfaMethods).values({
        partnerUserId: userIds[memberKey],
        methodType: "webauthn",
        label: "E2E authenticator metadata",
        credentialIdHash: hexHash(
          `e2e-credential:${runId}:${memberKey}:${userIds[memberKey]}`,
        ),
        credentialReference: `e2e-test-only:${slug}:${memberKey}`,
        enabled: true,
        enrolledAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }

    for (const member of PARTNER_PORTAL_E2E_MEMBER_MATRIX) {
      const hasActiveMembership = member.status === "active";
      const mfaVerified = member.mfaRequired ? now : null;
      await tx.insert(db.partnerSessions).values({
        partnerUserId: userIds[member.key],
        activePartnerAccountId: hasActiveMembership
          ? accountIds[member.account]
          : null,
        activeMembershipId: hasActiveMembership
          ? membershipIds[member.key]
          : null,
        sessionHash: sessionHash(partnerPortalSessionToken(runId, member.key)),
        authMethod: member.mfaRequired ? "mfa_step_up" : "password",
        assuranceLevel: member.mfaRequired ? "aal2" : "aal1",
        mfaVerifiedAt: mfaVerified,
        securityVersion: 1,
        deviceName: `E2E ${member.key}`,
        accountSelectedAt: hasActiveMembership ? now : null,
        ip: "127.0.0.1",
        userAgent: "Stonegate Partner Portal E2E",
        expiresAt: new Date(now.getTime() + 24 * 60 * 60_000),
        createdAt: now,
        lastSeenAt: now,
      });
    }

    const primaryProperty = await propertyWrite.resolveOrCreateContactProperty(
      tx,
      {
        contactId: contactIds.admin,
        addressLine1: "2100 E2E Commerce Drive",
        city: "Atlanta",
        state: "GA",
        postalCode: "30318",
        gated: false,
      },
    );
    const primaryPropertyTwo =
      await propertyWrite.resolveOrCreateContactProperty(tx, {
        contactId: contactIds.admin,
        addressLine1: "2200 E2E Commerce Drive",
        city: "Atlanta",
        state: "GA",
        postalCode: "30318",
        gated: false,
      });
    const secondaryProperty =
      await propertyWrite.resolveOrCreateContactProperty(tx, {
        contactId: contactIds.viewer,
        addressLine1: "3100 E2E Portfolio Way",
        city: "Decatur",
        state: "GA",
        postalCode: "30030",
        gated: false,
      });
    const locationDefinitions = [
      {
        accountId: accountIds.primary,
        propertyId: primaryProperty.property.id,
        creatorId: membershipIds.admin,
        siteName: "E2E Midtown Portfolio",
        externalPropertyId: `E2E-MIDTOWN-${slug}`,
        addressLine1: "2100 E2E Commerce Drive",
        city: "Atlanta",
        postalCode: "30318",
        latitude: "33.793000",
        longitude: "-84.430000",
      },
      {
        accountId: accountIds.primary,
        propertyId: primaryPropertyTwo.property.id,
        creatorId: membershipIds.admin,
        siteName: "E2E Westside Portfolio",
        externalPropertyId: `E2E-WESTSIDE-${slug}`,
        addressLine1: "2200 E2E Commerce Drive",
        city: "Atlanta",
        postalCode: "30318",
        latitude: "33.790000",
        longitude: "-84.440000",
      },
      {
        accountId: accountIds.secondary,
        propertyId: secondaryProperty.property.id,
        creatorId: membershipIds.viewer,
        siteName: "E2E Secondary Portfolio",
        externalPropertyId: `E2E-SECONDARY-${slug}`,
        addressLine1: "3100 E2E Portfolio Way",
        city: "Decatur",
        postalCode: "30030",
        latitude: "33.774800",
        longitude: "-84.296300",
      },
    ];
    const locationIds: string[] = [];
    for (const location of locationDefinitions) {
      const [created] = await tx
        .insert(db.partnerAccountLocations)
        .values({
          partnerAccountId: location.accountId,
          propertyId: location.propertyId,
          siteName: location.siteName,
          externalPropertyId: location.externalPropertyId,
          addressLine1: location.addressLine1,
          city: location.city,
          state: "GA",
          postalCode: location.postalCode,
          timezone: "America/New_York",
          locale: "en-US",
          latitude: location.latitude,
          longitude: location.longitude,
          geocodeStatus: "verified",
          serviceAreaStatus: "eligible",
          parkingInstructions: "Use the marked commercial loading area.",
          loadingInstructions:
            "Check in with the on-site contact before service.",
          onSiteContact: { name: "E2E Site Contact", phone: "+14705550199" },
          active: true,
          createdByMembershipId: location.creatorId,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: db.partnerAccountLocations.id });
      if (!created)
        throw new Error(
          `Unable to seed E2E partner location ${location.siteName}.`,
        );
      locationIds.push(created.id);
    }

    await tx
      .update(db.partnerServiceCatalog)
      .set({
        active: true,
        instantBookable: true,
        requiredScopeFields: ["description", "location", "onSiteContact"],
        defaultProofRequirements: { before: 1, after: 1 },
        updatedAt: now,
      })
      .where(eq(db.partnerServiceCatalog.key, "junk_removal_primary"));
    await tx
      .update(db.partnerSchedulingProfiles)
      .set({
        supportedTerritories: ["GA"],
        requiredScopeFields: ["description", "location", "onSiteContact"],
        pricingEligibility: { amountMinor: 27500, currency: "USD" },
        proofDefaults: { before: 1, after: 1 },
        instantConfirmationEnabled: true,
        active: true,
        updatedAt: now,
      })
      .where(
        and(
          eq(db.partnerSchedulingProfiles.serviceKey, "junk_removal_primary"),
          eq(db.partnerSchedulingProfiles.version, 1),
        ),
      );

    const [rateCard] = await tx
      .insert(db.partnerRateCards)
      .values({
        orgContactId: contactIds.admin,
        partnerAccountId: accountIds.primary,
        currency: "USD",
        active: true,
        version: 1,
        effectiveFrom: new Date(now.getTime() - 24 * 60 * 60_000),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: db.partnerRateCards.id });
    if (!rateCard) throw new Error("Unable to seed E2E partner rate card.");
    await tx.insert(db.partnerRateItems).values({
      rateCardId: rateCard.id,
      serviceKey: "junk_removal_primary",
      tierKey: "standard",
      label: "E2E contracted standard service",
      amountCents: 27500,
      sortOrder: 10,
      createdAt: now,
    });
    await tx.insert(db.partnerEvidenceRequirements).values([
      {
        partnerAccountId: accountIds.primary,
        category: "before",
        minimumCount: 1,
        required: true,
        source: "account_default",
        createdAt: now,
        updatedAt: now,
      },
      {
        partnerAccountId: accountIds.primary,
        category: "after",
        minimumCount: 1,
        required: true,
        source: "account_default",
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const jobIds = {} as PartnerPortalE2ESeedSummary["jobIds"];
    const jobOffsets: Record<
      (typeof PARTNER_PORTAL_E2E_JOB_STATES)[number],
      number
    > = {
      requested: 1,
      approval_needed: 2,
      under_review: 3,
      confirmed: 4,
      en_route: 0,
      in_progress: 0,
      completed: -4,
      canceled: 5,
      declined: 6,
    };
    for (const [
      index,
      publicStatus,
    ] of PARTNER_PORTAL_E2E_JOB_STATES.entries()) {
      const startsAt = new Date(
        now.getTime() +
          jobOffsets[publicStatus] * 24 * 60 * 60_000 +
          index * 30 * 60_000,
      );
      const scheduled = !["requested", "under_review", "declined"].includes(
        publicStatus,
      );
      const arrivalStart = scheduled ? startsAt : null;
      const arrivalEnd = scheduled
        ? new Date(startsAt.getTime() + 2 * 60 * 60_000)
        : null;
      const appointmentStatus =
        publicStatus === "completed"
          ? ("completed" as const)
          : publicStatus === "canceled" || publicStatus === "declined"
            ? ("canceled" as const)
            : ["confirmed", "en_route", "in_progress"].includes(publicStatus)
              ? ("confirmed" as const)
              : ("requested" as const);
      const [appointment] = await tx
        .insert(db.appointments)
        .values({
          contactId: contactIds.admin,
          propertyId:
            index % 2 === 0
              ? primaryProperty.property.id
              : primaryPropertyTwo.property.id,
          type: "junk_removal",
          startAt: startsAt,
          durationMinutes: 120,
          status: appointmentStatus,
          quotedTotalCents: 27500,
          finalTotalCents: publicStatus === "completed" ? 27500 : null,
          bookingDetails: {
            serviceType: "junk_removal",
            source: { type: "website" },
            pricing: {
              mode: "exact",
              rangeMinCents: 27500,
              rangeMaxCents: 27500,
            },
          },
          completedAt:
            publicStatus === "completed"
              ? new Date(startsAt.getTime() + 120 * 60_000)
              : null,
          rescheduleToken: hexHash(`e2e-reschedule:${runId}:${publicStatus}`),
          travelBufferMinutes: 30,
          partnerAccountId: accountIds.primary,
          capacityPoolKey: "field_service",
          capacityUnits: 1,
          promisedArrivalStartAt: arrivalStart,
          promisedArrivalEndAt: arrivalEnd,
          schedulePolicyRevision: "e2e-matrix-v1",
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: db.appointments.id });
      if (!appointment)
        throw new Error(`Unable to seed E2E ${publicStatus} appointment.`);
      const [booking] = await tx
        .insert(db.partnerBookings)
        .values({
          orgContactId: contactIds.admin,
          partnerAccountId: accountIds.primary,
          requestedByMembershipId: membershipIds.requester,
          partnerUserId: userIds.requester,
          propertyId:
            index % 2 === 0
              ? primaryProperty.property.id
              : primaryPropertyTwo.property.id,
          appointmentId: appointment.id,
          serviceKey: "junk_removal_primary",
          tierKey: "standard",
          amountCents: 27500,
          currency: "USD",
          publicStatus,
          confirmationMode:
            publicStatus === "approval_needed"
              ? "approval"
              : ["requested", "under_review", "declined"].includes(publicStatus)
                ? "review"
                : "instant",
          arrivalWindowStartAt: arrivalStart,
          arrivalWindowEndAt: arrivalEnd,
          scopeSnapshot: {
            description: `E2E ${publicStatus.replaceAll("_", " ")} commercial pickup`,
            locationId: locationIds[index % 2],
            onSiteContact: { name: "E2E Site Contact", phone: "+14705550199" },
          },
          rateSnapshot: {
            serviceKey: "junk_removal_primary",
            tierKey: "standard",
            amountCents: 27500,
            currency: "USD",
            rateCardVersion: 1,
          },
          proofRequirementsSnapshot: { before: 1, after: 1 },
          poNumber: `E2E-PO-${index + 1}`,
          costCenter: index % 2 === 0 ? "E2E-FACILITIES" : "E2E-TURNS",
          projectReference: `E2E-JOB-${publicStatus.toUpperCase()}`,
          billingContactSnapshot: {
            name: "E2E Portal billing",
            email: memberRecords.billing.email,
          },
          requestedReviewReasons:
            publicStatus === "under_review" ? ["e2e_scope_review"] : [],
          version: 1,
          canceledAt: publicStatus === "canceled" ? now : null,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: db.partnerBookings.id });
      if (!booking)
        throw new Error(`Unable to seed E2E ${publicStatus} partner job.`);
      jobIds[publicStatus] = booking.id;
      await tx.insert(db.partnerJobEvents).values({
        partnerAccountId: accountIds.primary,
        partnerBookingId: booking.id,
        eventType: `job.${publicStatus}`,
        publicLabel: publicStatus
          .replaceAll("_", " ")
          .replace(/^./u, (letter) => letter.toUpperCase()),
        publicDetail: "Deterministic local E2E job-state fixture.",
        effectiveAt:
          publicStatus === "completed"
            ? new Date(startsAt.getTime() + 120 * 60_000)
            : now,
        actorType: "system",
        metadata: {
          fixture: true,
          matrixVersion: PARTNER_PORTAL_E2E_MATRIX_VERSION,
        },
        createdAt: now,
      });
    }

    const [approvalRule] = await tx
      .insert(db.partnerApprovalRules)
      .values({
        partnerAccountId: accountIds.primary,
        name: "E2E approval over $250",
        conditions: { minimumAmountCents: 25000 },
        requiredApproverRoleKeys: ["approver"],
        requiredDecisionCount: 1,
        active: true,
        version: 1,
        createdByMembershipId: membershipIds.admin,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: db.partnerApprovalRules.id });
    if (!approvalRule)
      throw new Error("Unable to seed E2E partner approval rule.");
    await tx.insert(db.partnerApprovalRequests).values({
      partnerAccountId: accountIds.primary,
      partnerBookingId: jobIds.approval_needed,
      requestedByMembershipId: membershipIds.requester,
      state: "pending",
      ruleSnapshot: [
        { id: approvalRule.id, name: "E2E approval over $250", version: 1 },
      ],
      requestSnapshot: {
        amountCents: 27500,
        currency: "USD",
        serviceKey: "junk_removal_primary",
      },
      requiredDecisionCount: 1,
      expiresAt: new Date(now.getTime() + 30 * 60_000),
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });

    const invoiceIds = {} as PartnerPortalE2ESeedSummary["invoiceIds"];
    const invoiceJobStates = [
      "confirmed",
      "in_progress",
      "completed",
      "en_route",
    ] as const;
    for (const [index, status] of PARTNER_PORTAL_E2E_INVOICE_STATES.entries()) {
      const totalCents = 27500 + index * 2500;
      const paidCents =
        status === "paid"
          ? totalCents
          : status === "partially_paid"
            ? 10000
            : 0;
      const dueAt = new Date(
        now.getTime() + (status === "overdue" ? -7 : 14) * 24 * 60 * 60_000,
      );
      const [invoice] = await tx
        .insert(db.partnerInvoices)
        .values({
          partnerAccountId: accountIds.primary,
          partnerBookingId: jobIds[invoiceJobStates[index] ?? "confirmed"],
          invoiceNumber: `E2E-${slug.toUpperCase()}-${index + 1}`,
          status,
          currency: "USD",
          subtotalCents: totalCents,
          taxCents: 0,
          discountCents: 0,
          depositCents: status === "partially_paid" ? 10000 : 0,
          totalCents,
          paidCents,
          balanceCents: totalCents - paidCents,
          poNumber: `E2E-PO-BILL-${index + 1}`,
          costCenter: index % 2 === 0 ? "E2E-FACILITIES" : "E2E-TURNS",
          billingContact: {
            name: "E2E Portal billing",
            email: memberRecords.billing.email,
          },
          terms: "Local E2E fixture — not payable.",
          dueDate: dateOnly(dueAt),
          issuedAt: new Date(now.getTime() - 2 * 24 * 60 * 60_000),
          paidAt: status === "paid" ? now : null,
          provider: null,
          hostedPaymentUrl: null,
          version: 1,
          createdAt: new Date(now.getTime() - index * 60_000),
          updatedAt: now,
        })
        .returning({ id: db.partnerInvoices.id });
      if (!invoice) throw new Error(`Unable to seed E2E ${status} invoice.`);
      invoiceIds[status] = invoice.id;
      await tx.insert(db.partnerInvoiceLines).values({
        partnerInvoiceId: invoice.id,
        lineNumber: 1,
        kind: "service",
        description: `E2E ${status.replaceAll("_", " ")} junk-removal service`,
        quantity: "1.000",
        unitAmountCents: totalCents,
        lineTotalCents: totalCents,
        metadata: {
          fixture: true,
          matrixVersion: PARTNER_PORTAL_E2E_MATRIX_VERSION,
        },
        createdAt: now,
      });
    }

    await tx.insert(db.partnerAccessApplications).values({
      identityHash: hexHash(memberRecords.limited.email),
      email: memberRecords.limited.email,
      normalizedEmail: memberRecords.limited.email,
      name: "E2E Portal limited",
      phone: memberRecords.limited.phone,
      phoneE164: memberRecords.limited.phoneE164,
      companyName: `E2E Limited Applicant ${slug}`,
      partnerType: "contractor",
      serviceAreas: ["Atlanta, GA"],
      requestedNeeds: ["pickup scheduling", "before and after proof"],
      status: "submitted",
      applicantPartnerUserId: userIds.limited,
      bootstrapPartnerAccountId: accountIds.limited,
      emailVerifiedAt: now,
      termsAcceptedAt: now,
      privacyAcceptedAt: now,
      submittedAt: now,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });

    const summary: PartnerPortalE2ESeedSummary = {
      matrixVersion: PARTNER_PORTAL_E2E_MATRIX_VERSION,
      accountIds,
      userIds,
      membershipIds,
      locationIds,
      jobIds,
      invoiceIds,
      localCredentialEmails: Object.fromEntries(
        PARTNER_PORTAL_E2E_MEMBER_MATRIX.map((member) => [
          member.key,
          memberRecords[member.key].email,
        ]),
      ) as Record<MatrixMemberKey, string>,
    };
    return summary;
  });
}
