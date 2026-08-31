import postgres from "postgres";
import { assertSafeAuditSeedDatabase } from "./db-safety";

type SqlClient = ReturnType<typeof postgres>;

const ACCESS_EMAIL_PATTERN =
  /^partner-(?:e2e-access|applicant)-[a-z0-9-]+@mystos\.test$/u;

let cachedSql: SqlClient | null = null;

function sqlClient(): SqlClient {
  if (cachedSql) return cachedSql;
  assertSafeAuditSeedDatabase();
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) {
    throw new Error("DATABASE_URL must be set for access-review fixtures.");
  }
  cachedSql = postgres(connectionString, {
    prepare: false,
    max: 2,
    idle_timeout: 20,
  });
  return cachedSql;
}

function normalizedFixtureEmail(email: string): string {
  const normalized = email.normalize("NFKC").trim().toLowerCase();
  if (!ACCESS_EMAIL_PATTERN.test(normalized)) {
    throw new Error(`Refusing access-review fixture operation for ${email}.`);
  }
  return normalized;
}

export type PartnerAccessReviewSnapshot = {
  applicationId: string;
  applicationStatus: string;
  applicationVersion: number;
  emailVerified: boolean;
  bootstrapAccountId: string;
  approvedAccountId: string | null;
  accountStatus: string;
  accountPortalFit: string | null;
  portalAccessEnabled: boolean;
  partnerUserId: string;
  mfaRequired: boolean;
  mfaEnrolled: boolean;
  membershipId: string;
  membershipStatus: string;
  membershipRoleKey: string;
  membershipAccessLevel: string;
  roleTemplateKey: string;
  roleTemplateAccountId: string | null;
  roleTemplateIsSystem: boolean;
  rateCardCount: number;
  rateItemCount: number;
  decisionAuditCount: number;
  instantConfirmationGrantedDirectly: boolean | null;
  commercialConfigurationChanged: boolean | null;
};

export async function findPartnerAccessReviewSnapshot(
  rawEmail: string,
): Promise<PartnerAccessReviewSnapshot | null> {
  const email = normalizedFixtureEmail(rawEmail);
  const rows = await sqlClient()<
    Array<{
      applicationId: string;
      applicationStatus: string;
      applicationVersion: number;
      emailVerified: boolean;
      bootstrapAccountId: string;
      approvedAccountId: string | null;
      accountStatus: string;
      accountPortalFit: string | null;
      portalAccessEnabled: boolean;
      partnerUserId: string;
      mfaRequired: boolean;
      mfaEnrolled: boolean;
      membershipId: string;
      membershipStatus: string;
      membershipRoleKey: string;
      membershipAccessLevel: string;
      roleTemplateKey: string;
      roleTemplateAccountId: string | null;
      roleTemplateIsSystem: boolean;
      rateCardCount: number | string;
      rateItemCount: number | string;
      decisionAuditCount: number | string;
      instantConfirmationGrantedDirectly: boolean | null;
      commercialConfigurationChanged: boolean | null;
    }>
  >`
    SELECT
      application.id AS "applicationId",
      application.status AS "applicationStatus",
      application.version AS "applicationVersion",
      application.email_verified_at IS NOT NULL AS "emailVerified",
      application.bootstrap_partner_account_id AS "bootstrapAccountId",
      application.approved_partner_account_id AS "approvedAccountId",
      account.status AS "accountStatus",
      account.portal_fit AS "accountPortalFit",
      account.portal_access_enabled AS "portalAccessEnabled",
      partner_user.id AS "partnerUserId",
      partner_user.mfa_required AS "mfaRequired",
      partner_user.mfa_enrolled_at IS NOT NULL AS "mfaEnrolled",
      membership.id AS "membershipId",
      membership.status AS "membershipStatus",
      membership.role_key AS "membershipRoleKey",
      membership.access_level AS "membershipAccessLevel",
      role_template.key AS "roleTemplateKey",
      role_template.partner_account_id AS "roleTemplateAccountId",
      role_template.is_system AS "roleTemplateIsSystem",
      (
        SELECT count(*)
        FROM partner_rate_cards AS rate_card
        WHERE rate_card.partner_account_id = account.id
           OR rate_card.org_contact_id = account.portal_contact_id
      ) AS "rateCardCount",
      (
        SELECT count(*)
        FROM partner_rate_items AS rate_item
        INNER JOIN partner_rate_cards AS rate_card
          ON rate_card.id = rate_item.rate_card_id
        WHERE rate_card.partner_account_id = account.id
           OR rate_card.org_contact_id = account.portal_contact_id
      ) AS "rateItemCount",
      (
        SELECT count(*)
        FROM audit_logs AS audit
        WHERE audit.action = 'partner.access_application.decision'
          AND audit.entity_id = application.id::text
          AND audit.outcome = 'succeeded'
      ) AS "decisionAuditCount",
      decision_audit.meta->>'instantConfirmationGrantedDirectly' = 'true'
        AS "instantConfirmationGrantedDirectly",
      decision_audit.meta->>'commercialConfigurationChanged' = 'true'
        AS "commercialConfigurationChanged"
    FROM partner_access_applications AS application
    INNER JOIN partner_accounts AS account
      ON account.id = application.bootstrap_partner_account_id
    INNER JOIN partner_users AS partner_user
      ON partner_user.id = application.applicant_partner_user_id
    INNER JOIN partner_account_memberships AS membership
      ON membership.partner_account_id = account.id
     AND membership.partner_user_id = partner_user.id
    LEFT JOIN partner_role_templates AS role_template
      ON role_template.id = membership.role_template_id
    LEFT JOIN LATERAL (
      SELECT audit.meta
      FROM audit_logs AS audit
      WHERE audit.action = 'partner.access_application.decision'
        AND audit.entity_id = application.id::text
        AND audit.outcome = 'succeeded'
      ORDER BY audit.created_at DESC, audit.id DESC
      LIMIT 1
    ) AS decision_audit ON true
    WHERE application.normalized_email = ${email}
    ORDER BY application.created_at DESC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    ...row,
    rateCardCount: Number(row.rateCardCount),
    rateItemCount: Number(row.rateItemCount),
    decisionAuditCount: Number(row.decisionAuditCount),
  };
}

export async function partnerAccessNotificationDeliveryState(
  rawEmail: string,
): Promise<
  "delivered" | "quiet_hours_deferred" | "pending" | "failed" | "missing"
> {
  const email = normalizedFixtureEmail(rawEmail);
  const rows = await sqlClient()<
    Array<{
      processedAt: Date | null;
      lastError: string | null;
      nextAttemptAt: Date | null;
      deliveryStatus: string | null;
    }>
  >`
    SELECT event.processed_at AS "processedAt",
           event.last_error AS "lastError",
           event.next_attempt_at AS "nextAttemptAt",
           message.delivery_status AS "deliveryStatus"
    FROM outbox_events AS event
    INNER JOIN conversation_messages AS message
      ON message.id::text = event.payload->>'messageId'
    INNER JOIN conversation_threads AS thread
      ON thread.id = message.thread_id
    INNER JOIN partner_access_applications AS application
      ON application.normalized_email = ${email}
    INNER JOIN partner_accounts AS account
      ON account.id = application.bootstrap_partner_account_id
     AND account.portal_contact_id = thread.contact_id
    WHERE event.type = 'message.send'
      AND event.quarantined_at IS NULL
    ORDER BY event.created_at DESC, event.id DESC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return "missing";
  if (
    row.processedAt &&
    (row.deliveryStatus === "sent" || row.deliveryStatus === "delivered")
  ) {
    return "delivered";
  }
  if (
    !row.processedAt &&
    row.lastError === "quiet_hours" &&
    row.nextAttemptAt &&
    row.nextAttemptAt.getTime() > Date.now()
  ) {
    return "quiet_hours_deferred";
  }
  if (row.deliveryStatus === "failed") return "failed";
  return "pending";
}

export async function cleanupPartnerAccessReviewFixture(
  rawEmail: string,
): Promise<void> {
  const email = normalizedFixtureEmail(rawEmail);
  const sql = sqlClient();
  await sql.begin(async (tx) => {
    const fixtures = await tx<
      Array<{
        applicationId: string;
        accountId: string | null;
        partnerUserId: string | null;
        contactId: string | null;
      }>
    >`
      SELECT application.id AS "applicationId",
             application.bootstrap_partner_account_id AS "accountId",
             application.applicant_partner_user_id AS "partnerUserId",
             account.portal_contact_id AS "contactId"
      FROM partner_access_applications AS application
      LEFT JOIN partner_accounts AS account
        ON account.id = application.bootstrap_partner_account_id
      WHERE application.normalized_email = ${email}
      FOR UPDATE OF application
    `;
    if (fixtures.length === 0) return;
    const applicationIds = fixtures.map((row) => row.applicationId);
    const accountIds = fixtures
      .map((row) => row.accountId)
      .filter((value): value is string => Boolean(value));
    const partnerUserIds = fixtures
      .map((row) => row.partnerUserId)
      .filter((value): value is string => Boolean(value));
    const contactIds = fixtures
      .map((row) => row.contactId)
      .filter((value): value is string => Boolean(value));

    // Access-link delivery operations and their audit rows are immutable
    // production evidence. Retire and redact this synthetic identity without
    // bypassing those append-only guards.
    if (partnerUserIds.length) {
      await tx`
        UPDATE partner_sessions
        SET revoked_at = coalesce(revoked_at, statement_timestamp())
        WHERE partner_user_id = ANY(${partnerUserIds}::uuid[])
      `;
      await tx`
        UPDATE partner_login_tokens
        SET used_at = coalesce(used_at, statement_timestamp())
        WHERE partner_user_id = ANY(${partnerUserIds}::uuid[])
      `;
      await tx`
        UPDATE partner_users
        SET active = false,
            email = 'archived+' || id::text || '@mystos.test',
            phone = NULL,
            phone_e164 = NULL,
            name = 'Archived E2E portal applicant',
            updated_at = statement_timestamp()
        WHERE id = ANY(${partnerUserIds}::uuid[])
      `;
    }
    if (accountIds.length) {
      await tx`
        UPDATE partner_account_memberships
        SET status = 'suspended',
            is_default = false,
            suspended_at = coalesce(suspended_at, statement_timestamp()),
            updated_at = statement_timestamp()
        WHERE partner_account_id = ANY(${accountIds}::uuid[])
          AND status <> 'removed'
      `;
      await tx`
        UPDATE partner_role_templates
        SET active = false,
            name = 'Archived E2E applicant role',
            description = 'Retired synthetic access-review role.',
            updated_at = statement_timestamp()
        WHERE partner_account_id = ANY(${accountIds}::uuid[])
      `;
      await tx`
        UPDATE partner_accounts
        SET name = 'Archived E2E partner workspace ' || id::text,
            normalized_name = 'archived e2e partner workspace ' || id::text,
            domain = NULL,
            website = NULL,
            portal_access_enabled = false,
            updated_at = statement_timestamp()
        WHERE id = ANY(${accountIds}::uuid[])
      `;
    }
    if (contactIds.length) {
      await tx`
        UPDATE contacts
        SET first_name = 'Archived',
            last_name = 'E2E applicant',
            company = 'Archived E2E partner workspace',
            email = NULL,
            phone = NULL,
            phone_e164 = NULL,
            deleted_at = coalesce(deleted_at, statement_timestamp()),
            deleted_by = NULL,
            purge_eligible_at = statement_timestamp() + interval '30 days',
            updated_at = statement_timestamp()
        WHERE id = ANY(${contactIds}::uuid[])
      `;
    }
    await tx`
      UPDATE partner_access_applications
      SET status = CASE
            WHEN status IN ('submitted', 'under_review', 'needs_information')
              THEN 'withdrawn'
            ELSE status
          END,
          email = 'archived+' || id::text || '@mystos.test',
          normalized_email = 'archived+' || id::text || '@mystos.test',
          name = 'Archived E2E portal applicant',
          phone = NULL,
          phone_e164 = NULL,
          company_name = 'Archived E2E partner workspace',
          website = NULL,
          service_areas = ARRAY[]::text[],
          requested_needs = ARRAY[]::text[],
          review_note = NULL,
          version = version + 1,
          updated_at = statement_timestamp()
      WHERE id = ANY(${applicationIds}::uuid[])
    `;
  });

  const remaining = await sql<Array<{ count: number | string }>>`
    SELECT count(*) AS count
    FROM partner_access_applications
    WHERE normalized_email = ${email}
  `;
  if (Number(remaining[0]?.count ?? 0) !== 0) {
    throw new Error(
      `Access-review cleanup left application data for ${email}.`,
    );
  }
}

export async function closePartnerAccessReviewFixtures(): Promise<void> {
  const sql = cachedSql;
  cachedSql = null;
  if (sql) await sql.end({ timeout: 5 });
}

// Acquisition and staff-review journeys create the same limited-workspace
// graph and therefore share the same recoverable, append-only-safe teardown.
export const cleanupPartnerApplicantFixture = cleanupPartnerAccessReviewFixture;
