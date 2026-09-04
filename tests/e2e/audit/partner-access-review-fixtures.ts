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
  applicationFlowVersion: number;
  emailVerified: boolean;
  applicantSessionId: string;
  applicantSessionActive: boolean;
  verificationChallengeStatus: string;
  bootstrapAccountId: string | null;
  requestedAccountId: string | null;
  approvedAccountId: string | null;
  authorityAccountCount: number;
  accountStatus: string | null;
  accountPortalFit: string | null;
  portalAccessEnabled: boolean | null;
  accountPortalContactId: string | null;
  partnerUserId: string | null;
  canonicalIdentityCount: number;
  identityActive: boolean | null;
  identityStatus: string | null;
  identityOrgContactId: string | null;
  passwordSet: boolean;
  membershipId: string | null;
  membershipCount: number;
  membershipStatus: string | null;
  membershipAccepted: boolean;
  membershipRoleKey: string | null;
  membershipAccessLevel: string | null;
  membershipIsDefault: boolean | null;
  roleTemplateKey: string | null;
  roleTemplateAccountId: string | null;
  roleTemplateIsSystem: boolean | null;
  crmContactCount: number;
  portalSessionCount: number;
  activationChallengeCount: number;
  activationChallengeStatus: string | null;
  activationDeliveryStatus: string | null;
  activationDeliveryQueued: boolean;
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
      applicationFlowVersion: number;
      emailVerified: boolean;
      applicantSessionId: string;
      applicantSessionActive: boolean;
      verificationChallengeStatus: string;
      bootstrapAccountId: string | null;
      requestedAccountId: string | null;
      approvedAccountId: string | null;
      authorityAccountCount: number | string;
      accountStatus: string | null;
      accountPortalFit: string | null;
      portalAccessEnabled: boolean | null;
      accountPortalContactId: string | null;
      partnerUserId: string | null;
      canonicalIdentityCount: number | string;
      identityActive: boolean | null;
      identityStatus: string | null;
      identityOrgContactId: string | null;
      passwordSet: boolean;
      membershipId: string | null;
      membershipCount: number | string;
      membershipStatus: string | null;
      membershipAccepted: boolean;
      membershipRoleKey: string | null;
      membershipAccessLevel: string | null;
      membershipIsDefault: boolean | null;
      roleTemplateKey: string | null;
      roleTemplateAccountId: string | null;
      roleTemplateIsSystem: boolean | null;
      crmContactCount: number | string;
      portalSessionCount: number | string;
      activationChallengeCount: number | string;
      activationChallengeStatus: string | null;
      activationDeliveryStatus: string | null;
      activationDeliveryQueued: boolean;
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
      application.flow_version AS "applicationFlowVersion",
      application.email_verified_at IS NOT NULL AS "emailVerified",
      application.applicant_session_id AS "applicantSessionId",
      applicant_session.revoked_at IS NULL
        AND applicant_session.expires_at > statement_timestamp()
        AS "applicantSessionActive",
      verification_challenge.status AS "verificationChallengeStatus",
      application.bootstrap_partner_account_id AS "bootstrapAccountId",
      application.requested_partner_account_id AS "requestedAccountId",
      application.approved_partner_account_id AS "approvedAccountId",
      (
        SELECT count(DISTINCT authority_account.id)
        FROM unnest(ARRAY[
          application.bootstrap_partner_account_id,
          application.requested_partner_account_id,
          application.approved_partner_account_id
        ]::uuid[]) AS authority_account(id)
        WHERE authority_account.id IS NOT NULL
      ) AS "authorityAccountCount",
      account.status AS "accountStatus",
      account.portal_fit AS "accountPortalFit",
      account.portal_access_enabled AS "portalAccessEnabled",
      account.portal_contact_id AS "accountPortalContactId",
      partner_user.id AS "partnerUserId",
      (
        SELECT count(*)
        FROM partner_users AS canonical_identity
        WHERE canonical_identity.normalized_email = application.normalized_email
      ) AS "canonicalIdentityCount",
      partner_user.active AS "identityActive",
      partner_user.identity_status AS "identityStatus",
      partner_user.org_contact_id AS "identityOrgContactId",
      partner_user.password_hash IS NOT NULL
        AND partner_user.password_set_at IS NOT NULL AS "passwordSet",
      membership.id AS "membershipId",
      (
        SELECT count(*)
        FROM partner_account_memberships AS user_membership
        WHERE user_membership.partner_user_id = partner_user.id
      ) AS "membershipCount",
      membership.status AS "membershipStatus",
      membership.accepted_at IS NOT NULL AS "membershipAccepted",
      membership.role_key AS "membershipRoleKey",
      membership.access_level AS "membershipAccessLevel",
      membership.is_default AS "membershipIsDefault",
      role_template.key AS "roleTemplateKey",
      role_template.partner_account_id AS "roleTemplateAccountId",
      role_template.is_system AS "roleTemplateIsSystem",
      (
        SELECT count(*)
        FROM contacts AS crm_contact
        WHERE lower(btrim(crm_contact.email)) = application.normalized_email
           OR crm_contact.id = partner_user.org_contact_id
           OR crm_contact.partner_account_id = account.id
      ) AS "crmContactCount",
      (
        SELECT count(*)
        FROM partner_sessions AS portal_session
        WHERE portal_session.partner_user_id = partner_user.id
          AND portal_session.revoked_at IS NULL
          AND portal_session.expires_at > statement_timestamp()
      ) AS "portalSessionCount",
      (
        SELECT count(*)
        FROM partner_auth_challenges AS activation_count
        WHERE activation_count.application_id = application.id
          AND activation_count.purpose = 'account_activation'
      ) AS "activationChallengeCount",
      activation_challenge.status AS "activationChallengeStatus",
      activation_challenge.delivery_status AS "activationDeliveryStatus",
      activation_challenge.delivery_outbox_event_id IS NOT NULL
        AS "activationDeliveryQueued",
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
    INNER JOIN partner_applicant_sessions AS applicant_session
      ON applicant_session.id = application.applicant_session_id
    INNER JOIN partner_auth_challenges AS verification_challenge
      ON verification_challenge.id = application.email_verification_challenge_id
     AND verification_challenge.purpose = 'email_verification'
    LEFT JOIN partner_accounts AS account
      ON account.id = application.approved_partner_account_id
    LEFT JOIN partner_users AS partner_user
      ON partner_user.id = application.applicant_partner_user_id
    LEFT JOIN partner_account_memberships AS membership
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
    LEFT JOIN LATERAL (
      SELECT challenge.status,
             challenge.delivery_status,
             challenge.delivery_outbox_event_id
      FROM partner_auth_challenges AS challenge
      WHERE challenge.application_id = application.id
        AND challenge.purpose = 'account_activation'
      ORDER BY challenge.generation DESC, challenge.created_at DESC
      LIMIT 1
    ) AS activation_challenge ON true
    WHERE application.normalized_email = ${email}
    ORDER BY application.created_at DESC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    ...row,
    authorityAccountCount: Number(row.authorityAccountCount),
    canonicalIdentityCount: Number(row.canonicalIdentityCount),
    membershipCount: Number(row.membershipCount),
    crmContactCount: Number(row.crmContactCount),
    portalSessionCount: Number(row.portalSessionCount),
    activationChallengeCount: Number(row.activationChallengeCount),
    rateCardCount: Number(row.rateCardCount),
    rateItemCount: Number(row.rateItemCount),
    decisionAuditCount: Number(row.decisionAuditCount),
  };
}

export async function resetPartnerAccessReviewRateLimits(): Promise<void> {
  await sqlClient()`
    DELETE FROM team_auth_rate_limits
    WHERE split_part(bucket, ':', 1) = ANY(${[
      "partner_email_verification_request",
      "partner_email_verification_consume",
      "partner_access_application",
      "partner_application_mutation",
      "partner_activation",
    ]}::text[])
  `;
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
        identityContactId: string | null;
        accountContactId: string | null;
      }>
    >`
      SELECT application.id AS "applicationId",
             CASE
               WHEN account.source = 'partner_portal_access_application'
                 THEN account.id
               ELSE NULL
             END AS "accountId",
             application.applicant_partner_user_id AS "partnerUserId",
             partner_user.org_contact_id AS "identityContactId",
             account.portal_contact_id AS "accountContactId"
      FROM partner_access_applications AS application
      LEFT JOIN partner_accounts AS account
        ON account.id = application.approved_partner_account_id
      LEFT JOIN partner_users AS partner_user
        ON partner_user.id = application.applicant_partner_user_id
      WHERE application.normalized_email = ${email}
      FOR UPDATE OF application
    `;
    const applicationIds = fixtures.map((row) => row.applicationId);
    const accountIds = fixtures
      .map((row) => row.accountId)
      .filter((value): value is string => Boolean(value));
    const partnerUserIds = fixtures
      .map((row) => row.partnerUserId)
      .filter((value): value is string => Boolean(value));
    const contactIds = fixtures
      .flatMap((row) => [row.identityContactId, row.accountContactId])
      .filter((value): value is string => Boolean(value));

    // Auth-delivery outbox records and audit rows are immutable production
    // evidence. Revoke live authority and redact only mutable fixture records;
    // never delete or rewrite those append-only ledgers.
    await tx`
      UPDATE partner_auth_challenges
      SET status = 'revoked',
          token_hash = NULL,
          revoked_at = statement_timestamp(),
          updated_at = statement_timestamp()
      WHERE normalized_email = ${email}
        AND purpose IN ('email_verification', 'account_activation')
        AND status = 'pending'
    `;
    await tx`
      UPDATE partner_applicant_sessions
      SET revoked_at = coalesce(revoked_at, statement_timestamp()),
          draft_payload = '{}'::jsonb,
          updated_at = statement_timestamp()
      WHERE normalized_email = ${email}
    `;
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
            normalized_email = 'archived+' || id::text || '@mystos.test',
            identity_status = 'disabled',
            org_contact_id = NULL,
            phone = NULL,
            phone_e164 = NULL,
            name = 'Archived E2E portal applicant',
            password_hash = NULL,
            password_set_at = NULL,
            security_version = security_version + 1,
            updated_at = statement_timestamp()
        WHERE id = ANY(${partnerUserIds}::uuid[])
      `;
    }
    if (accountIds.length) {
      await tx`
        UPDATE partner_account_memberships
        SET status = 'removed',
            is_default = false,
            removed_at = coalesce(removed_at, statement_timestamp()),
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
    if (applicationIds.length) {
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
    }
  });

  const remaining = await sql<
    Array<{
      applicationCount: number | string;
      activeApplicantSessionCount: number | string;
      activeChallengeCount: number | string;
      activePortalSessionCount: number | string;
    }>
  >`
    SELECT
      (
        SELECT count(*)
        FROM partner_access_applications
        WHERE normalized_email = ${email}
      ) AS "applicationCount",
      (
        SELECT count(*)
        FROM partner_applicant_sessions
        WHERE normalized_email = ${email}
          AND revoked_at IS NULL
          AND expires_at > statement_timestamp()
      ) AS "activeApplicantSessionCount",
      (
        SELECT count(*)
        FROM partner_auth_challenges
        WHERE normalized_email = ${email}
          AND status = 'pending'
      ) AS "activeChallengeCount",
      (
        SELECT count(*)
        FROM partner_sessions AS session
        INNER JOIN partner_users AS identity
          ON identity.id = session.partner_user_id
        WHERE identity.normalized_email = ${email}
          AND session.revoked_at IS NULL
          AND session.expires_at > statement_timestamp()
      ) AS "activePortalSessionCount"
  `;
  const residue = remaining[0];
  if (
    Number(residue?.applicationCount ?? 0) !== 0 ||
    Number(residue?.activeApplicantSessionCount ?? 0) !== 0 ||
    Number(residue?.activeChallengeCount ?? 0) !== 0 ||
    Number(residue?.activePortalSessionCount ?? 0) !== 0
  ) {
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
