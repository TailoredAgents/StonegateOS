import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import {
  TEAM_OWNER_ONLY_PERMISSION_CATALOG,
  TEAM_ROLE_PERMISSION_TEMPLATES,
} from "../../../packages/sdk/src";
import {
  TEAM_SESSION_COOKIE,
  teamSessionCookieOptions,
} from "../../../apps/site/src/lib/team-session";

type SqlClient = ReturnType<typeof postgres>;

type StorageState = {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite?: "Strict" | "Lax" | "None";
  }>;
  origins: [];
};

type TeamRole =
  | "owner"
  | "office"
  | "sales"
  | "crew"
  | "read_only"
  | "custom_audit";

const AUDIT_TEAM_EMAILS = [
  "audit-owner@mystos.test",
  "audit-office@mystos.test",
  "audit-sales@mystos.test",
  "audit-crew@mystos.test",
  "audit-read-only@mystos.test",
  "audit-custom-grant@mystos.test",
  "audit-custom-deny@mystos.test",
  "audit-inactive@mystos.test",
  "audit-expired@mystos.test",
] as const;

const AUDIT_STORAGE_FILES = [
  "tests/e2e/storage/audit-owner.json",
  "tests/e2e/storage/audit-office.json",
  "tests/e2e/storage/audit-sales.json",
  "tests/e2e/storage/audit-crew.json",
  "tests/e2e/storage/audit-read-only.json",
  "tests/e2e/storage/audit-custom-grant.json",
  "tests/e2e/storage/audit-custom-deny.json",
  "tests/e2e/storage/audit-inactive.json",
  "tests/e2e/storage/audit-expired.json",
] as const;

type TeamStorageInput = {
  filename: string;
  name: string;
  email: string;
  phoneE164?: string;
  role: TeamRole;
  permissionsGrant?: string[];
  permissionsDeny?: string[];
  active?: boolean;
  sessionExpiresInMinutes?: number;
  siteBase: string;
};

let cachedClient: SqlClient | null = null;

function getSql(): SqlClient {
  if (cachedClient) return cachedClient;

  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) {
    throw new Error("DATABASE_URL must be set for E2E team auth helpers.");
  }

  const shouldUseSsl =
    process.env["DATABASE_SSL"] === "true" ||
    /render\.com/.test(connectionString) ||
    /sslmode=require/.test(connectionString);

  cachedClient = postgres(connectionString, {
    prepare: false,
    max: 5,
    idle_timeout: 20,
    ...(shouldUseSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  return cachedClient;
}

function randomToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function sha256Base64Url(value: string): string {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

function retainedAuditMemberName(email: string): string {
  return `Retired E2E team fixture ${sha256Base64Url(email.trim().toLowerCase()).slice(0, 12)}`;
}

function parseSameSite(
  value: string | boolean | undefined,
): "Strict" | "Lax" | "None" | undefined {
  if (!value || typeof value !== "string") return undefined;
  const normalized = value.toLowerCase();
  if (normalized === "strict") return "Strict";
  if (normalized === "none") return "None";
  if (normalized === "lax") return "Lax";
  return undefined;
}

async function upsertRole(role: TeamRole): Promise<string> {
  const sql = getSql();
  const nameByRole: Record<TeamRole, string> = {
    owner: "Owner",
    office: "Office",
    sales: "Sales",
    crew: "Crew",
    read_only: "Read only",
    custom_audit: "Custom audit",
  };
  const name = nameByRole[role];
  const permissionsByRole: Record<TeamRole, readonly string[]> = {
    owner: ["*", ...TEAM_OWNER_ONLY_PERMISSION_CATALOG],
    office: TEAM_ROLE_PERMISSION_TEMPLATES.office.permissions,
    sales: TEAM_ROLE_PERMISSION_TEMPLATES.sales.permissions,
    crew: TEAM_ROLE_PERMISSION_TEMPLATES.crew.permissions,
    read_only: TEAM_ROLE_PERMISSION_TEMPLATES.read_only.permissions,
    custom_audit: [],
  };
  const permissions = [...permissionsByRole[role]];
  const inserted = await sql<{ id: string }[]>`
    INSERT INTO team_roles (name, slug, permissions)
    VALUES (${name}, ${role}, ${permissions}::text[])
    ON CONFLICT (slug) DO UPDATE
    SET name = EXCLUDED.name,
        permissions = EXCLUDED.permissions,
        updated_at = now()
    RETURNING id
  `;

  const id = inserted[0]?.id;
  if (!id) throw new Error(`Unable to upsert ${role} role.`);
  return id;
}

async function upsertMember(
  input: Omit<TeamStorageInput, "filename" | "siteBase">,
  roleId: string,
): Promise<string> {
  const sql = getSql();
  const permissionsGrant = input.permissionsGrant ?? [];
  const permissionsDeny = input.permissionsDeny ?? [];
  const active = input.active ?? true;
  const normalizedEmail = input.email.trim().toLowerCase();
  const retainedName = retainedAuditMemberName(normalizedEmail);
  const existing = await sql<{ id: string }[]>`
    SELECT id
    FROM team_members
    WHERE lower(email) = ${normalizedEmail}
       OR (email IS NULL AND name = ${retainedName})
    ORDER BY created_at DESC
    LIMIT 1
  `;

  const existingId = existing[0]?.id;
  if (existingId) {
    await sql`
      UPDATE team_members
      SET name = ${input.name},
          email = ${normalizedEmail},
          email_normalized = ${normalizedEmail},
          email_identity_status = 'ready',
          role_id = ${roleId},
          active = ${active},
          phone_e164 = ${input.phoneE164 ?? null},
          permissions_grant = ${permissionsGrant}::text[],
          permissions_deny = ${permissionsDeny}::text[],
          updated_at = now()
      WHERE id = ${existingId}
    `;
    return existingId;
  }

  const inserted = await sql<{ id: string }[]>`
    INSERT INTO team_members (
      name, email, email_normalized, email_identity_status, phone_e164,
      role_id, permissions_grant, permissions_deny, active
    ) VALUES (
      ${input.name}, ${normalizedEmail}, ${normalizedEmail}, 'ready',
      ${input.phoneE164 ?? null}, ${roleId}, ${permissionsGrant}::text[],
      ${permissionsDeny}::text[], ${active}
    )
    RETURNING id
  `;

  const id = inserted[0]?.id;
  if (!id) throw new Error(`Unable to create ${input.email}.`);
  return id;
}

async function createSession(
  teamMemberId: string,
  expiresInMinutes = 30 * 24 * 60,
): Promise<string> {
  const sql = getSql();
  const token = randomToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresInMinutes * 60 * 1000);

  await sql`
    INSERT INTO team_sessions (team_member_id, session_hash, expires_at, created_at, last_seen_at)
    VALUES (${teamMemberId}, ${sha256Base64Url(token)}, ${expiresAt}, ${now}, ${now})
  `;

  return token;
}

async function writeStorageState(
  filename: string,
  siteBase: string,
  sessionToken: string,
): Promise<void> {
  const cookieOptions = teamSessionCookieOptions();
  const url = new URL(siteBase);
  const now = Math.floor(Date.now() / 1000);
  const expires = cookieOptions.maxAge
    ? now + cookieOptions.maxAge
    : now + 60 * 60 * 24 * 30;
  const filePath = path.resolve(process.cwd(), filename);

  const state: StorageState = {
    cookies: [
      {
        name: TEAM_SESSION_COOKIE,
        value: sessionToken,
        domain: url.hostname,
        path: cookieOptions.path ?? "/",
        expires,
        httpOnly: cookieOptions.httpOnly ?? true,
        secure: cookieOptions.secure ?? url.protocol === "https:",
        sameSite: parseSameSite(cookieOptions.sameSite) ?? "Lax",
      },
    ],
    origins: [],
  };

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2));
}

export async function bootstrapTeamStorage(
  input: TeamStorageInput,
): Promise<void> {
  const roleId = await upsertRole(input.role);
  const memberId = await upsertMember(input, roleId);
  const sessionToken = await createSession(
    memberId,
    input.sessionExpiresInMinutes,
  );
  await writeStorageState(input.filename, input.siteBase, sessionToken);
}

export async function cleanupAuditTeamStorage(): Promise<void> {
  try {
    const sql = getSql();
    const auditEmails = [...AUDIT_TEAM_EMAILS];
    const retainedNames = auditEmails.map(retainedAuditMemberName);
    const ownerRetainedName = retainedAuditMemberName(
      "audit-owner@mystos.test",
    );
    const ownerPermissions = ["*", ...TEAM_OWNER_ONLY_PERMISSION_CATALOG];

    await sql.begin(async (transaction) => {
      await transaction`
        DELETE FROM team_sessions
        WHERE team_member_id IN (
          SELECT id
          FROM team_members
          WHERE lower(email) = ANY(${auditEmails}::text[])
             OR name = ANY(${retainedNames}::text[])
        )
      `;
      await transaction`
        DELETE FROM team_login_tokens
        WHERE team_member_id IN (
          SELECT id
          FROM team_members
          WHERE lower(email) = ANY(${auditEmails}::text[])
             OR name = ANY(${retainedNames}::text[])
        )
      `;

      // Restore the reusable owner before retiring any other fixture member.
      // This satisfies the database's last-Access-administrator invariant even
      // after a test has edited the owner's effective permission inputs.
      await transaction`
        UPDATE team_roles
        SET name = 'Owner',
            permissions = ${ownerPermissions}::text[],
            updated_at = now()
        WHERE slug = 'owner'
      `;
      await transaction`
        UPDATE team_members AS member
        SET name = ${ownerRetainedName},
            email = NULL,
            email_normalized = NULL,
            email_identity_status = 'none',
            role_id = (
              SELECT id
              FROM team_roles
              WHERE slug = 'owner'
            ),
            active = true,
            phone_e164 = NULL,
            password_hash = NULL,
            password_set_at = NULL,
            default_crew_split_bps = NULL,
            permissions_grant = ARRAY[]::text[],
            permissions_deny = ARRAY[]::text[],
            updated_at = now()
        WHERE lower(member.email) = 'audit-owner@mystos.test'
           OR member.name = ${ownerRetainedName}
      `;

      // A test actor can become part of durable business evidence. The current
      // schema deliberately RESTRICTs deletion for crew attribution,
      // commission configuration, and reconciled partner operations. Retire
      // those synthetic identities in place so cleanup never destroys the
      // evidence (or fails midway through teardown).
      await transaction`
        UPDATE team_members AS member
        SET name = fixture.retained_name,
            email = NULL,
            email_normalized = NULL,
            email_identity_status = 'none',
            role_id = NULL,
            active = false,
            phone_e164 = NULL,
            password_hash = NULL,
            password_set_at = NULL,
            default_crew_split_bps = NULL,
            permissions_grant = ARRAY[]::text[],
            permissions_deny = ARRAY[]::text[],
            updated_at = now()
        FROM unnest(
          ${auditEmails}::text[],
          ${retainedNames}::text[]
        ) AS fixture(email, retained_name)
        WHERE (
            lower(member.email) = fixture.email
            OR member.name = fixture.retained_name
          )
          AND fixture.email <> 'audit-owner@mystos.test'
          AND (
            EXISTS (
              SELECT 1
              FROM appointment_crew_members AS appointment_crew
              WHERE appointment_crew.member_id = member.id
            )
            OR EXISTS (
              SELECT 1
              FROM commission_management_splits AS management_split
              WHERE management_split.member_id = member.id
            )
            OR EXISTS (
              SELECT 1
              FROM commission_crew_split_rules AS crew_split_rule
              WHERE crew_split_rule.member_id = member.id
            )
            OR EXISTS (
              SELECT 1
              FROM partner_invite_operations AS invite_operation
              WHERE invite_operation.resolved_by = member.id
            )
          )
      `;

      await transaction`
        DELETE FROM team_members AS member
        WHERE (
            lower(member.email) = ANY(${auditEmails}::text[])
            OR member.name = ANY(${retainedNames}::text[])
          )
          AND coalesce(lower(member.email), '') <> 'audit-owner@mystos.test'
          AND member.name <> ${ownerRetainedName}
          AND NOT EXISTS (
            SELECT 1
            FROM appointment_crew_members AS appointment_crew
            WHERE appointment_crew.member_id = member.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM commission_management_splits AS management_split
            WHERE management_split.member_id = member.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM commission_crew_split_rules AS crew_split_rule
            WHERE crew_split_rule.member_id = member.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM partner_invite_operations AS invite_operation
            WHERE invite_operation.resolved_by = member.id
          )
      `;

      await transaction`
        DELETE FROM team_roles AS role
        WHERE role.slug = 'custom_audit'
          AND NOT EXISTS (
            SELECT 1
            FROM team_members AS member
            WHERE member.role_id = role.id
          )
      `;
    });
  } finally {
    await Promise.all(
      AUDIT_STORAGE_FILES.map((filename) =>
        fs.rm(path.resolve(process.cwd(), filename), { force: true }),
      ),
    );
  }
}

export async function closeTeamAuthStorage(): Promise<void> {
  const client = cachedClient;
  cachedClient = null;
  if (client) {
    await client.end({ timeout: 5 });
  }
}
