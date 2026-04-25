import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { TEAM_SESSION_COOKIE, teamSessionCookieOptions } from "../../../apps/site/src/lib/team-session";

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

type TeamStorageInput = {
  filename: string;
  name: string;
  email: string;
  role: "owner" | "sales";
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
    ...(shouldUseSsl ? { ssl: { rejectUnauthorized: false } } : {})
  });

  return cachedClient;
}

function randomToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function sha256Base64Url(value: string): string {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

function parseSameSite(value: string | boolean | undefined): "Strict" | "Lax" | "None" | undefined {
  if (!value || typeof value !== "string") return undefined;
  const normalized = value.toLowerCase();
  if (normalized === "strict") return "Strict";
  if (normalized === "none") return "None";
  if (normalized === "lax") return "Lax";
  return undefined;
}

async function upsertRole(role: "owner" | "sales"): Promise<string> {
  const sql = getSql();
  const name = role === "owner" ? "Owner" : "Sales";
  const permissions = role === "owner" ? ["*"] : [];
  const rows = await sql<{ id: string }[]>`
    INSERT INTO team_roles (name, slug, permissions)
    VALUES (${name}, ${role}, ${permissions}::text[])
    ON CONFLICT (slug) DO UPDATE
    SET name = EXCLUDED.name,
        permissions = EXCLUDED.permissions,
        updated_at = now()
    RETURNING id
  `;

  const id = rows[0]?.id;
  if (!id) throw new Error(`Unable to upsert ${role} role.`);
  return id;
}

async function upsertMember(input: Omit<TeamStorageInput, "filename" | "siteBase">, roleId: string): Promise<string> {
  const sql = getSql();
  const existing = await sql<{ id: string }[]>`
    SELECT id
    FROM team_members
    WHERE lower(email) = lower(${input.email})
    ORDER BY created_at DESC
    LIMIT 1
  `;

  const existingId = existing[0]?.id;
  if (existingId) {
    await sql`
      UPDATE team_members
      SET name = ${input.name},
          role_id = ${roleId},
          active = true,
          permissions_grant = ARRAY[]::text[],
          permissions_deny = ARRAY[]::text[],
          updated_at = now()
      WHERE id = ${existingId}
    `;
    return existingId;
  }

  const inserted = await sql<{ id: string }[]>`
    INSERT INTO team_members (name, email, role_id, permissions_grant, permissions_deny, active)
    VALUES (${input.name}, ${input.email}, ${roleId}, ARRAY[]::text[], ARRAY[]::text[], true)
    RETURNING id
  `;

  const id = inserted[0]?.id;
  if (!id) throw new Error(`Unable to create ${input.email}.`);
  return id;
}

async function createSession(teamMemberId: string): Promise<string> {
  const sql = getSql();
  const token = randomToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  await sql`
    INSERT INTO team_sessions (team_member_id, session_hash, expires_at, created_at, last_seen_at)
    VALUES (${teamMemberId}, ${sha256Base64Url(token)}, ${expiresAt}, ${now}, ${now})
  `;

  return token;
}

async function writeStorageState(filename: string, siteBase: string, sessionToken: string): Promise<void> {
  const cookieOptions = teamSessionCookieOptions();
  const url = new URL(siteBase);
  const now = Math.floor(Date.now() / 1000);
  const expires = cookieOptions.maxAge ? now + cookieOptions.maxAge : now + 60 * 60 * 24 * 30;
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
        sameSite: parseSameSite(cookieOptions.sameSite) ?? "Lax"
      }
    ],
    origins: []
  };

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2));
}

export async function bootstrapTeamStorage(input: TeamStorageInput): Promise<void> {
  const roleId = await upsertRole(input.role);
  const memberId = await upsertMember(input, roleId);
  const sessionToken = await createSession(memberId);
  await writeStorageState(input.filename, input.siteBase, sessionToken);
}
