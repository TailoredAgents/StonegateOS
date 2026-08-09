import crypto, { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import { assertSafeAuditSeedDatabase } from "./db-safety";
import {
  readQuietHoursChannel,
  type QuietHoursChannel,
  type QuietHoursWindow,
} from "./policy-evidence";

type SqlClient = ReturnType<typeof postgres>;
type SerializableJson = Parameters<SqlClient["json"]>[0];

export type AuditActor = {
  memberId: string;
  name: string;
  email: string;
};

export type CustomerFixture = {
  marker: string;
  contactId: string;
  propertyId: string;
  leadId: string | null;
  name: string;
  email: string;
  phone: string;
  phoneE164: string;
  address: string;
};

export type AuthMatrixFixture = {
  memberId: string;
  roleId: string;
  email: string;
  password: string;
  validToken: string;
  expiredToken: string;
  startedAt: Date;
};

export type ConversationFixture = CustomerFixture & {
  threadId: string;
  draftMessageId: string;
  taskId: string | null;
};

export type SettingSnapshot = {
  kind: "policy" | "automation";
  key: string;
  existed: boolean;
  value: Record<string, unknown> | string | null;
  updatedBy: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
};

export type AuditEventRow = {
  id: string;
  action: string;
  entityId: string | null;
  actorId: string | null;
  actorLabel: string | null;
  outcome: string;
  meta: Record<string, unknown> | null;
  createdAt: Date;
};

let cachedSql: SqlClient | null = null;

function sqlClient(): SqlClient {
  if (cachedSql) return cachedSql;
  assertSafeAuditSeedDatabase();
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) {
    throw new Error("DATABASE_URL must be set for team audit journeys.");
  }
  const useSsl =
    process.env["DATABASE_SSL"] === "true" ||
    /render\.com|sslmode=require/u.test(connectionString);
  cachedSql = postgres(connectionString, {
    prepare: false,
    max: 5,
    idle_timeout: 20,
    ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });
  return cachedSql;
}

function passwordHash(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("base64url");
}

export function auditMarker(label: string): string {
  return `audit-${label}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function uniquePhone(): { phone: string; phoneE164: string } {
  const phone = `470${crypto.randomInt(1_000_000, 9_999_999)}`;
  return { phone, phoneE164: `+1${phone}` };
}

export async function getAuditActor(
  email = "audit-owner@mystos.test",
): Promise<AuditActor> {
  const sql = sqlClient();
  const rows = await sql<AuditActor[]>`
    SELECT id AS "memberId", name, email
    FROM team_members
    WHERE email_normalized = lower(${email}) OR lower(email) = lower(${email})
    LIMIT 1
  `;
  const actor = rows[0];
  if (!actor?.memberId || !actor.email) {
    throw new Error(`Required audit actor ${email} was not seeded.`);
  }
  return actor;
}

export async function createAuthMatrixFixture(): Promise<AuthMatrixFixture> {
  const sql = sqlClient();
  const marker = auditMarker("auth");
  const email = `${marker}@mystos.test`;
  const password = `Audit-${randomUUID()}-Pass!`;
  const validToken = crypto.randomBytes(32).toString("base64url");
  const expiredToken = crypto.randomBytes(32).toString("base64url");
  const startedAt = new Date();

  return sql.begin(async (tx) => {
    const roleRows = await tx<{ id: string }[]>`
      INSERT INTO team_roles (name, slug, permissions)
      VALUES (${`Audit auth ${marker}`}, ${marker}, ${["*"]}::text[])
      RETURNING id
    `;
    const roleId = roleRows[0]?.id;
    if (!roleId) throw new Error("Unable to create auth audit role.");

    const memberRows = await tx<{ id: string }[]>`
      INSERT INTO team_members (
        name, email, email_normalized, email_identity_status, role_id,
        permissions_grant, permissions_deny, active, password_hash,
        password_set_at, created_at, updated_at
      ) VALUES (
        ${`Audit Auth ${marker}`}, ${email}, ${email}, 'ready', ${roleId},
        ${[]}::text[], ${[]}::text[], true, ${passwordHash(password)},
        ${startedAt}, ${startedAt}, ${startedAt}
      )
      RETURNING id
    `;
    const memberId = memberRows[0]?.id;
    if (!memberId) throw new Error("Unable to create auth audit member.");

    await tx`
      INSERT INTO team_login_tokens (
        team_member_id, token_hash, expires_at, created_at, requested_ip, user_agent
      ) VALUES
        (${memberId}, ${tokenHash(validToken)}, ${new Date(startedAt.getTime() + 20 * 60_000)}, ${startedAt}, '127.0.0.1', 'team-audit'),
        (${memberId}, ${tokenHash(expiredToken)}, ${new Date(startedAt.getTime() - 60_000)}, ${startedAt}, '127.0.0.1', 'team-audit')
    `;

    return {
      memberId,
      roleId,
      email,
      password,
      validToken,
      expiredToken,
      startedAt,
    };
  });
}

export async function getAuthMatrixState(memberId: string): Promise<{
  activeTokens: number;
  sessions: number;
  activeSessions: number;
}> {
  const sql = sqlClient();
  const rows = await sql<
    Array<{
      activeTokens: number | string;
      sessions: number | string;
      activeSessions: number | string;
    }>
  >`
    SELECT
      (SELECT count(*) FROM team_login_tokens WHERE team_member_id = ${memberId} AND expires_at > now()) AS "activeTokens",
      (SELECT count(*) FROM team_sessions WHERE team_member_id = ${memberId}) AS sessions,
      (SELECT count(*) FROM team_sessions WHERE team_member_id = ${memberId} AND revoked_at IS NULL AND expires_at > now()) AS "activeSessions"
  `;
  const row = rows[0];
  return {
    activeTokens: Number(row?.activeTokens ?? 0),
    sessions: Number(row?.sessions ?? 0),
    activeSessions: Number(row?.activeSessions ?? 0),
  };
}

export async function cleanupAuthMatrixFixture(
  fixture: AuthMatrixFixture,
): Promise<void> {
  const sql = sqlClient();
  await sql.begin(async (tx) => {
    await tx`DELETE FROM team_sessions WHERE team_member_id = ${fixture.memberId}`;
    await tx`DELETE FROM team_login_tokens WHERE team_member_id = ${fixture.memberId}`;
    await tx`DELETE FROM team_members WHERE id = ${fixture.memberId}`;
    await tx`DELETE FROM team_roles WHERE id = ${fixture.roleId}`;
  });
}

export function storageStateForToken(baseURL: string, token: string) {
  const url = new URL(baseURL);
  return {
    cookies: [
      {
        name: "myst-team-session",
        value: token,
        domain: url.hostname,
        path: "/",
        expires: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        httpOnly: true,
        secure: url.protocol === "https:",
        sameSite: "Lax" as const,
      },
    ],
    origins: [],
  };
}

export async function createTeamSessionRecordForMember(
  memberId: string,
): Promise<{
  token: string;
  sessionId: string;
}> {
  const sql = sqlClient();
  const token = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  const rows = await sql<Array<{ id: string }>>`
    INSERT INTO team_sessions (
      team_member_id, session_hash, auth_method, expires_at, created_at, last_seen_at
    ) VALUES (
      ${memberId}, ${tokenHash(token)}, 'team_session',
      ${new Date(now.getTime() + 30 * 24 * 60 * 60_000)}, ${now}, ${now}
    )
    RETURNING id
  `;
  const sessionId = rows[0]?.id;
  if (!sessionId)
    throw new Error("The Access audit session was not persisted.");
  return { token, sessionId };
}

export async function createTeamSessionForMember(
  memberId: string,
): Promise<string> {
  return (await createTeamSessionRecordForMember(memberId)).token;
}

export async function auditTeamApiAsSession(
  token: string,
  apiPath: string,
  options: {
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    data?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<{
  status: number;
  headers: Headers;
  body: Record<string, unknown> | null;
}> {
  const apiBase = (
    process.env["API_BASE_URL"] ?? "http://localhost:3001"
  ).replace(/\/$/u, "");
  const adminKey = process.env["ADMIN_API_KEY"];
  if (!adminKey) {
    throw new Error("ADMIN_API_KEY is required for team-session API checks.");
  }
  const response = await fetch(
    `${apiBase}${apiPath.startsWith("/") ? apiPath : `/${apiPath}`}`,
    {
      method: options.method ?? (options.data === undefined ? "GET" : "POST"),
      headers: {
        "x-api-key": adminKey,
        Authorization: `Bearer ${token}`,
        Origin: new URL(apiBase).origin,
        ...(options.data === undefined
          ? {}
          : { "Content-Type": "application/json" }),
        ...options.headers,
      },
      ...(options.data === undefined
        ? {}
        : { body: JSON.stringify(options.data) }),
    },
  );
  const text = await response.text();
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = text ? (JSON.parse(text) as unknown) : null;
    body =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
  } catch {
    body = null;
  }
  return { status: response.status, headers: response.headers, body };
}

export async function getVerifiedTeamSessionSnapshot(token: string): Promise<{
  status: number;
  ok: boolean;
  memberId: string | null;
  permissions: string[];
}> {
  const apiBase = (
    process.env["API_BASE_URL"] ?? "http://localhost:3001"
  ).replace(/\/$/u, "");
  const response = await fetch(`${apiBase}/api/public/team/session`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  const payload = (await response.json().catch(() => null)) as {
    ok?: unknown;
    teamMember?: { id?: unknown; permissions?: unknown };
  } | null;
  return {
    status: response.status,
    ok: payload?.ok === true,
    memberId:
      typeof payload?.teamMember?.id === "string"
        ? payload.teamMember.id
        : null,
    permissions: Array.isArray(payload?.teamMember?.permissions)
      ? payload.teamMember.permissions.filter(
          (permission): permission is string => typeof permission === "string",
        )
      : [],
  };
}

async function readSessionToken(storageFile: string): Promise<string> {
  const raw = await readFile(path.resolve(process.cwd(), storageFile), "utf8");
  const state = JSON.parse(raw) as {
    cookies?: Array<{ name?: string; value?: string }>;
  };
  const token = state.cookies?.find(
    (cookie) => cookie.name === "myst-team-session",
  )?.value;
  if (!token) throw new Error(`No team session in ${storageFile}.`);
  return token;
}

export async function auditOwnerApi<T>(
  apiPath: string,
  options: {
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    data?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<T> {
  const apiBase = (
    process.env["API_BASE_URL"] ?? "http://localhost:3001"
  ).replace(/\/$/u, "");
  const adminKey = process.env["ADMIN_API_KEY"];
  if (!adminKey)
    throw new Error("ADMIN_API_KEY is required for audit API calls.");
  const sessionToken = await readSessionToken(
    "tests/e2e/storage/audit-owner.json",
  );
  const response = await fetch(
    `${apiBase}${apiPath.startsWith("/") ? apiPath : `/${apiPath}`}`,
    {
      method: options.method ?? (options.data === undefined ? "GET" : "POST"),
      headers: {
        "x-api-key": adminKey,
        Authorization: `Bearer ${sessionToken}`,
        Origin: new URL(apiBase).origin,
        ...(options.data === undefined
          ? {}
          : { "Content-Type": "application/json" }),
        ...options.headers,
      },
      ...(options.data === undefined
        ? {}
        : { body: JSON.stringify(options.data) }),
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Audit owner API ${apiPath} failed ${response.status}: ${text}`,
    );
  }
  return (text ? JSON.parse(text) : {}) as T;
}

async function createCustomerBase(
  label: string,
  options: { lead?: boolean; pipelineStage?: string; source?: string } = {},
): Promise<CustomerFixture> {
  const sql = sqlClient();
  const marker = auditMarker(label);
  const email = `${marker}@mystos.test`;
  const { phone, phoneE164 } = uniquePhone();
  const name = `Audit ${label} ${marker.slice(-8)}`;
  const [firstName, ...lastParts] = name.split(" ");
  const lastName = lastParts.join(" ");
  const address = `${crypto.randomInt(100, 9999)} ${marker} Lane`;

  return sql.begin(async (tx) => {
    const contactRows = await tx<{ id: string }[]>`
      INSERT INTO contacts (
        first_name, last_name, email, phone, phone_e164, source,
        preferred_contact_method, created_at, updated_at
      ) VALUES (
        ${firstName}, ${lastName}, ${email}, ${phone}, ${phoneE164},
        ${options.source ?? "team_audit"}, 'phone', now(), now()
      ) RETURNING id
    `;
    const contactId = contactRows[0]?.id;
    if (!contactId) throw new Error("Unable to seed audit contact.");

    const propertyRows = await tx<{ id: string }[]>`
      INSERT INTO properties (
        contact_id, address_key, address_line1, city, state, postal_code,
        gated, created_at, updated_at
      ) VALUES (
        ${contactId}, ${marker}, ${address}, 'Roswell', 'GA', '30075',
        false, now(), now()
      ) RETURNING id
    `;
    const propertyId = propertyRows[0]?.id;
    if (!propertyId) throw new Error("Unable to seed audit property.");
    await tx`
      INSERT INTO contact_properties (contact_id, property_id, relationship)
      VALUES (${contactId}, ${propertyId}, 'customer')
    `;

    if (options.pipelineStage) {
      await tx`
        INSERT INTO crm_pipeline (contact_id, stage, created_at, updated_at)
        VALUES (${contactId}, ${options.pipelineStage}, now(), now())
      `;
    }

    let leadId: string | null = null;
    if (options.lead) {
      const leadRows = await tx<{ id: string }[]>`
        INSERT INTO leads (
          contact_id, property_id, services_requested, status, source,
          notes, created_at, updated_at
        ) VALUES (
          ${contactId}, ${propertyId}, ${["furniture"]}::text[], 'new',
          ${options.source ?? "team_audit"}, ${marker}, now(), now()
        ) RETURNING id
      `;
      leadId = leadRows[0]?.id ?? null;
    }

    return {
      marker,
      contactId,
      propertyId,
      leadId,
      name,
      email,
      phone,
      phoneE164,
      address,
    };
  });
}

export async function createInstantQuoteFixture(): Promise<
  CustomerFixture & { instantQuoteId: string }
> {
  const base = await createCustomerBase("instant", {
    lead: false,
    pipelineStage: "new",
    source: "google_ads",
  });
  const sql = sqlClient();
  const result = await sql.begin(async (tx) => {
    const quoteRows = await tx<{ id: string }[]>`
      INSERT INTO instant_quotes (
        contact_id, property_id, source, contact_name, contact_phone,
        timeframe, zip, job_types, perceived_size, notes, photo_urls,
        ai_result, created_at
      ) VALUES (
        ${base.contactId}, ${base.propertyId}, 'google_ads', ${base.name},
        ${base.phoneE164}, 'this_week', '30075', ${["furniture"]}::text[],
        'half', ${`Fixture ${base.marker}`}, ${[]}::text[],
        ${tx.json({
          loadFractionEstimate: 0.5,
          priceLow: 300,
          priceHigh: 450,
          displayTierLabel: "Half load",
          reasonSummary: "Deterministic audit fixture",
          needsInPersonEstimate: false,
        })}, now()
      ) RETURNING id
    `;
    const instantQuoteId = quoteRows[0]?.id;
    if (!instantQuoteId) throw new Error("Unable to seed instant quote.");
    const leadRows = await tx<{ id: string }[]>`
      INSERT INTO leads (
        contact_id, property_id, services_requested, status, source,
        instant_quote_id, notes, created_at, updated_at
      ) VALUES (
        ${base.contactId}, ${base.propertyId}, ${["furniture"]}::text[],
        'new', 'google_ads', ${instantQuoteId}, ${base.marker}, now(), now()
      ) RETURNING id
    `;
    const leadId = leadRows[0]?.id;
    if (!leadId) throw new Error("Unable to seed instant-quote lead.");
    return { instantQuoteId, leadId };
  });
  return { ...base, ...result };
}

export async function createDayOfServiceFixture(): Promise<
  CustomerFixture & { appointmentId: string; calendarDay: string }
> {
  const base = await createCustomerBase("service-day", {
    lead: true,
    pipelineStage: "qualified",
  });
  const owner = await getAuditActor();
  const startAt = new Date(Date.now() + 24 * 60 * 60_000);
  startAt.setUTCHours(16, 0, 0, 0);
  const sql = sqlClient();
  const rows = await sql<{ id: string }[]>`
    INSERT INTO appointments (
      contact_id, property_id, lead_id, type, start_at, duration_min, status,
      quoted_total_cents, quoted_scope_text, booking_details,
      sold_by_member_id, reschedule_token, created_at, updated_at
    ) VALUES (
      ${base.contactId}, ${base.propertyId}, ${base.leadId}, 'job', ${startAt},
      90, 'confirmed', 72500, 'Remove the staged furniture and debris.',
      ${sql.json({
        serviceType: "junk_removal",
        source: { type: "google" },
        pricing: { mode: "exact" },
        loadSize: { kind: "half_to_three_quarters", customLoads: null },
      })}, ${owner.memberId}, ${randomUUID().replace(/-/gu, "")}, now(), now()
    ) RETURNING id
  `;
  const appointmentId = rows[0]?.id;
  if (!appointmentId)
    throw new Error("Unable to seed service-day appointment.");
  return {
    ...base,
    appointmentId,
    calendarDay: easternDayKey(startAt),
  };
}

function easternDayKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values["year"]}-${values["month"]}-${values["day"]}`;
}

export async function createConversationFixture(
  label: string,
  options: { withSalesTask?: boolean; assignedTo?: string } = {},
): Promise<ConversationFixture> {
  const base = await createCustomerBase(label, {
    lead: true,
    pipelineStage: "new",
  });
  if (!base.leadId) throw new Error("Conversation fixture requires a lead.");
  const sql = sqlClient();
  const result = await sql.begin(async (tx) => {
    let taskId: string | null = null;
    if (options.withSalesTask) {
      const taskRows = await tx<{ id: string }[]>`
        INSERT INTO crm_tasks (
          contact_id, title, due_at, assigned_to, status, notes,
          created_at, updated_at
        ) VALUES (
          ${base.contactId}, 'Auto: Audit lead (5 min SLA)',
          ${new Date(Date.now() - 60_000)}, ${options.assignedTo ?? null},
          'open', ${`[auto] leadId=${base.leadId} kind=speed_to_lead ${base.marker}`},
          now(), now()
        ) RETURNING id
      `;
      taskId = taskRows[0]?.id ?? null;
    }

    const threadRows = await tx<{ id: string }[]>`
      INSERT INTO conversation_threads (
        lead_id, contact_id, property_id, status, state, channel, subject,
        last_message_preview, last_message_at, assigned_to,
        created_at, updated_at, state_updated_at
      ) VALUES (
        ${base.leadId}, ${base.contactId}, ${base.propertyId}, 'open',
        'qualifying', 'sms', ${base.marker}, 'Can you help this week?', now(),
        ${options.assignedTo ?? null}, now(), now(), now()
      ) RETURNING id
    `;
    const threadId = threadRows[0]?.id;
    if (!threadId) throw new Error("Unable to seed audit thread.");
    const participantRows = await tx<{ id: string }[]>`
      INSERT INTO conversation_participants (
        thread_id, participant_type, contact_id, external_address, display_name
      ) VALUES (${threadId}, 'contact', ${base.contactId}, ${base.phoneE164}, ${base.name})
      RETURNING id
    `;
    const participantId = participantRows[0]?.id;
    await tx`
      INSERT INTO conversation_messages (
        thread_id, participant_id, direction, channel, body, from_address,
        delivery_status, received_at, metadata, created_at
      ) VALUES (
        ${threadId}, ${participantId ?? null}, 'inbound', 'sms',
        'Can you help this week?', ${base.phoneE164}, 'delivered', now(),
        ${tx.json({ auditMarker: base.marker })}, now()
      )
    `;
    const draftRows = await tx<{ id: string }[]>`
      INSERT INTO conversation_messages (
        thread_id, direction, channel, body, to_address, delivery_status,
        metadata, created_at
      ) VALUES (
        ${threadId}, 'outbound', 'sms',
        ${`Yes — I can help. This is the reviewed ${base.marker} draft.`},
        ${base.phoneE164}, 'queued',
        ${tx.json({
          draft: true,
          aiSuggested: true,
          auditMarker: base.marker,
          agentPlanner: {
            actionType: "reply_now",
            priority: "high",
            summary: "Reply to the customer",
            reason: "Customer is waiting",
          },
        })}, now()
      ) RETURNING id
    `;
    const draftMessageId = draftRows[0]?.id;
    if (!draftMessageId) throw new Error("Unable to seed audit draft.");
    return { threadId, draftMessageId, taskId };
  });
  return { ...base, ...result };
}

export async function snapshotPolicySetting(
  key: string,
): Promise<SettingSnapshot> {
  const sql = sqlClient();
  const rows = await sql<
    Array<{
      value: Record<string, unknown>;
      updatedBy: string | null;
      createdAt: Date;
      updatedAt: Date;
    }>
  >`
    SELECT value, updated_by AS "updatedBy", created_at AS "createdAt", updated_at AS "updatedAt"
    FROM policy_settings WHERE key = ${key} LIMIT 1
  `;
  const row = rows[0];
  return {
    kind: "policy",
    key,
    existed: Boolean(row),
    value: row?.value ?? null,
    updatedBy: row?.updatedBy ?? null,
    createdAt: row?.createdAt ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

export async function setSalesDefaultAssignee(
  memberId: string,
): Promise<SettingSnapshot> {
  const snapshot = await snapshotPolicySetting("sales_scorecard");
  const current =
    snapshot.value && typeof snapshot.value === "object" ? snapshot.value : {};
  const sql = sqlClient();
  await sql`
    INSERT INTO policy_settings (key, value, updated_by, created_at, updated_at)
    VALUES ('sales_scorecard', ${sql.json({ ...current, defaultAssigneeMemberId: memberId })}, ${memberId}, now(), now())
    ON CONFLICT (key) DO UPDATE SET
      value = excluded.value,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at
  `;
  return snapshot;
}

export async function snapshotAutomationSetting(
  channel: string,
): Promise<SettingSnapshot> {
  const sql = sqlClient();
  const rows = await sql<
    Array<{ mode: string; updatedBy: string | null; updatedAt: Date }>
  >`
    SELECT mode, updated_by AS "updatedBy", updated_at AS "updatedAt"
    FROM automation_settings WHERE channel = ${channel} LIMIT 1
  `;
  const row = rows[0];
  return {
    kind: "automation",
    key: channel,
    existed: Boolean(row),
    value: row?.mode ?? null,
    updatedBy: row?.updatedBy ?? null,
    createdAt: null,
    updatedAt: row?.updatedAt ?? null,
  };
}

export async function restoreSettings(
  snapshots: readonly SettingSnapshot[],
): Promise<void> {
  const sql = sqlClient();
  const identities = snapshots.map(
    (snapshot) => `${snapshot.kind}:${snapshot.key}`,
  );
  if (new Set(identities).size !== identities.length) {
    throw new Error("Setting restore snapshots must be unique.");
  }

  await sql.begin(async (tx) => {
    for (const snapshot of snapshots) {
      if (snapshot.kind === "policy") {
        if (!snapshot.existed) {
          await tx`DELETE FROM policy_settings WHERE key = ${snapshot.key}`;
          continue;
        }
        await tx`
          INSERT INTO policy_settings (key, value, updated_by, created_at, updated_at)
          VALUES (
            ${snapshot.key}, ${tx.json(snapshot.value as SerializableJson)},
            ${snapshot.updatedBy}, ${snapshot.createdAt}, ${snapshot.updatedAt}
          ) ON CONFLICT (key) DO UPDATE SET
            value = excluded.value,
            updated_by = excluded.updated_by,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at
        `;
        continue;
      }
      if (!snapshot.existed) {
        await tx`DELETE FROM automation_settings WHERE channel = ${snapshot.key}`;
        continue;
      }
      await tx`
        INSERT INTO automation_settings (channel, mode, updated_by, updated_at)
        VALUES (${snapshot.key}, ${snapshot.value as string}, ${snapshot.updatedBy}, ${snapshot.updatedAt})
        ON CONFLICT (channel) DO UPDATE SET
          mode = excluded.mode,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      `;
    }
  });
}

export async function restoreSetting(snapshot: SettingSnapshot): Promise<void> {
  await restoreSettings([snapshot]);
}

export async function getSettingValues(): Promise<{
  autopilotMode: string | null;
  dmMode: string | null;
  emailMode: string | null;
  quietHours: Record<string, unknown> | null;
  smsMode: string | null;
}> {
  const sql = sqlClient();
  const rows = await sql<
    Array<{
      autopilotMode: string | null;
      dmMode: string | null;
      emailMode: string | null;
      quietHours: Record<string, unknown> | null;
      smsMode: string | null;
    }>
  >`
    SELECT
      (SELECT value->>'mode' FROM policy_settings WHERE key = 'sales_autopilot') AS "autopilotMode",
      (SELECT mode::text FROM automation_settings WHERE channel = 'dm') AS "dmMode",
      (SELECT mode::text FROM automation_settings WHERE channel = 'email') AS "emailMode",
      (SELECT value FROM policy_settings WHERE key = 'quiet_hours') AS "quietHours",
      (SELECT mode::text FROM automation_settings WHERE channel = 'sms') AS "smsMode"
  `;
  return (
    rows[0] ?? {
      autopilotMode: null,
      dmMode: null,
      emailMode: null,
      quietHours: null,
      smsMode: null,
    }
  );
}

export async function getQuietHoursChannel(
  channel: QuietHoursChannel,
): Promise<QuietHoursWindow | null> {
  const quietHours = (await getSettingValues()).quietHours;
  return readQuietHoursChannel(quietHours, channel);
}

export async function getContactEffectCounts(contactId: string): Promise<{
  appointments: number;
  audits: number;
  dispatches: number;
  instantQuotes: number;
  leads: number;
  messages: number;
  outbox: number;
  pipelineRows: number;
  quotes: number;
  tasks: number;
  threads: number;
}> {
  const sql = sqlClient();
  const rows = await sql<
    Array<{
      appointments: number | string;
      audits: number | string;
      dispatches: number | string;
      instantQuotes: number | string;
      leads: number | string;
      messages: number | string;
      outbox: number | string;
      pipelineRows: number | string;
      quotes: number | string;
      tasks: number | string;
      threads: number | string;
    }>
  >`
    SELECT
      (SELECT count(*) FROM appointments WHERE contact_id = ${contactId}) AS appointments,
      (SELECT count(*) FROM audit_logs
        WHERE entity_id = ${contactId}
           OR meta->>'contactId' = ${contactId}
           OR entity_id IN (SELECT id::text FROM leads WHERE contact_id = ${contactId})
           OR entity_id IN (SELECT id::text FROM conversation_threads WHERE contact_id = ${contactId})
           OR entity_id IN (
             SELECT m.id::text FROM conversation_messages m
             JOIN conversation_threads t ON t.id = m.thread_id
             WHERE t.contact_id = ${contactId}
           )) AS audits,
      (SELECT count(*) FROM external_message_dispatches WHERE contact_id = ${contactId}) AS dispatches,
      (SELECT count(*) FROM instant_quotes WHERE contact_id = ${contactId}) AS "instantQuotes",
      (SELECT count(*) FROM leads WHERE contact_id = ${contactId}) AS leads,
      (SELECT count(*) FROM conversation_messages m JOIN conversation_threads t ON t.id = m.thread_id WHERE t.contact_id = ${contactId}) AS messages,
      (SELECT count(*) FROM outbox_events
        WHERE payload->>'contactId' = ${contactId}
           OR payload->>'leadId' IN (
             SELECT id::text FROM leads WHERE contact_id = ${contactId}
           )
           OR payload->>'messageId' IN (
             SELECT m.id::text FROM conversation_messages m
             JOIN conversation_threads t ON t.id = m.thread_id
             WHERE t.contact_id = ${contactId}
           )
           OR payload->>'taskId' IN (
             SELECT id::text FROM crm_tasks WHERE contact_id = ${contactId}
           )) AS outbox,
      (SELECT count(*) FROM crm_pipeline WHERE contact_id = ${contactId}) AS "pipelineRows",
      (SELECT count(*) FROM quotes WHERE contact_id = ${contactId}) AS quotes,
      (SELECT count(*) FROM crm_tasks WHERE contact_id = ${contactId}) AS tasks,
      (SELECT count(*) FROM conversation_threads WHERE contact_id = ${contactId}) AS threads
  `;
  const row = rows[0];
  return {
    appointments: Number(row?.appointments ?? 0),
    audits: Number(row?.audits ?? 0),
    dispatches: Number(row?.dispatches ?? 0),
    instantQuotes: Number(row?.instantQuotes ?? 0),
    leads: Number(row?.leads ?? 0),
    messages: Number(row?.messages ?? 0),
    outbox: Number(row?.outbox ?? 0),
    pipelineRows: Number(row?.pipelineRows ?? 0),
    quotes: Number(row?.quotes ?? 0),
    tasks: Number(row?.tasks ?? 0),
    threads: Number(row?.threads ?? 0),
  };
}

export async function findContactByEmail(
  email: string,
): Promise<CustomerFixture | null> {
  const sql = sqlClient();
  const rows = await sql<
    Array<{
      contactId: string;
      propertyId: string;
      leadId: string | null;
      firstName: string;
      lastName: string;
      email: string;
      phone: string;
      phoneE164: string;
      address: string;
    }>
  >`
    SELECT c.id AS "contactId", p.id AS "propertyId", l.id AS "leadId",
      c.first_name AS "firstName", c.last_name AS "lastName", c.email,
      c.phone, c.phone_e164 AS "phoneE164", p.address_line1 AS address
    FROM contacts c
    JOIN contact_properties cp ON cp.contact_id = c.id
    JOIN properties p ON p.id = cp.property_id
    LEFT JOIN leads l ON l.contact_id = c.id AND l.property_id = p.id
    WHERE lower(c.email) = lower(${email})
    ORDER BY l.created_at DESC NULLS LAST
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    marker: email.split("@")[0] ?? email,
    contactId: row.contactId,
    propertyId: row.propertyId,
    leadId: row.leadId,
    name: `${row.firstName} ${row.lastName}`.trim(),
    email: row.email,
    phone: row.phone,
    phoneE164: row.phoneE164,
    address: row.address,
  };
}

export async function getLatestAppointmentForContact(
  contactId: string,
): Promise<{
  id: string;
  leadId: string | null;
  propertyId: string;
  status: string;
  quotedTotalCents: number | null;
  finalTotalCents: number | null;
  bookingDetails: Record<string, unknown> | null;
  soldByMemberId: string | null;
} | null> {
  const sql = sqlClient();
  const rows = await sql<
    Array<{
      id: string;
      leadId: string | null;
      propertyId: string;
      status: string;
      quotedTotalCents: number | null;
      finalTotalCents: number | null;
      bookingDetails: Record<string, unknown> | null;
      soldByMemberId: string | null;
    }>
  >`
    SELECT id, lead_id AS "leadId", property_id AS "propertyId", status,
      quoted_total_cents AS "quotedTotalCents", final_total_cents AS "finalTotalCents",
      booking_details AS "bookingDetails", sold_by_member_id AS "soldByMemberId"
    FROM appointments WHERE contact_id = ${contactId}
    ORDER BY created_at DESC LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function getInstantQuoteBookingSnapshot(
  instantQuoteId: string,
): Promise<{
  leadId: string;
  appointmentId: string;
  contactId: string;
  propertyId: string;
  status: string;
} | null> {
  const sql = sqlClient();
  const rows = await sql<
    Array<{
      leadId: string;
      appointmentId: string;
      contactId: string;
      propertyId: string;
      status: string;
    }>
  >`
    SELECT l.id AS "leadId", a.id AS "appointmentId",
      a.contact_id AS "contactId", a.property_id AS "propertyId",
      a.status::text AS status
    FROM leads l
    JOIN appointments a ON a.lead_id = l.id
    WHERE l.instant_quote_id = ${instantQuoteId}
    ORDER BY a.created_at DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function getLeadJourneySnapshot(contactId: string): Promise<{
  quoteStatus: string | null;
  pipelineStage: string | null;
  appointmentId: string | null;
  appointmentStatus: string | null;
}> {
  const sql = sqlClient();
  const rows = await sql<
    Array<{
      quoteStatus: string | null;
      pipelineStage: string | null;
      appointmentId: string | null;
      appointmentStatus: string | null;
    }>
  >`
    SELECT
      (SELECT status::text FROM quotes WHERE contact_id = ${contactId} ORDER BY created_at DESC LIMIT 1) AS "quoteStatus",
      (SELECT stage::text FROM crm_pipeline WHERE contact_id = ${contactId}) AS "pipelineStage",
      (SELECT id FROM appointments WHERE contact_id = ${contactId} ORDER BY created_at DESC LIMIT 1) AS "appointmentId",
      (SELECT status::text FROM appointments WHERE contact_id = ${contactId} ORDER BY created_at DESC LIMIT 1) AS "appointmentStatus"
  `;
  return (
    rows[0] ?? {
      quoteStatus: null,
      pipelineStage: null,
      appointmentId: null,
      appointmentStatus: null,
    }
  );
}

export async function getDayOfServiceSnapshot(appointmentId: string): Promise<{
  status: string;
  finalTotalCents: number | null;
  version: string;
  notes: string[];
  crewMemberIds: string[];
  commissionCount: number;
  payment: {
    id: string;
    jobAmountCents: number | null;
    tipCents: number;
    initiatedBy: string | null;
  } | null;
}> {
  const sql = sqlClient();
  const rows = await sql<
    Array<{
      status: string;
      finalTotalCents: number | null;
      updatedAt: Date;
    }>
  >`
    SELECT status, final_total_cents AS "finalTotalCents", updated_at AS "updatedAt"
    FROM appointments WHERE id = ${appointmentId} LIMIT 1
  `;
  const notes = await sql<Array<{ body: string }>>`
    SELECT body FROM appointment_notes WHERE appointment_id = ${appointmentId} ORDER BY created_at
  `;
  const crew = await sql<Array<{ memberId: string }>>`
    SELECT member_id AS "memberId" FROM appointment_crew_members WHERE appointment_id = ${appointmentId}
  `;
  const commissions = await sql<Array<{ count: number | string }>>`
    SELECT count(*) AS count FROM appointment_commissions WHERE appointment_id = ${appointmentId}
  `;
  const payments = await sql<
    Array<{
      id: string;
      jobAmountCents: number | null;
      tipCents: number;
      initiatedBy: string | null;
    }>
  >`
    SELECT id, job_amount_cents AS "jobAmountCents", tip_cents AS "tipCents",
      initiated_by_member_id AS "initiatedBy"
    FROM payments WHERE appointment_id = ${appointmentId} ORDER BY created_at DESC LIMIT 1
  `;
  const appointment = rows[0];
  if (!appointment) throw new Error("Service-day appointment disappeared.");
  return {
    status: appointment.status,
    finalTotalCents: appointment.finalTotalCents,
    version: new Date(appointment.updatedAt).toISOString(),
    notes: notes.map((row) => row.body),
    crewMemberIds: crew.map((row) => row.memberId),
    commissionCount: Number(commissions[0]?.count ?? 0),
    payment: payments[0] ?? null,
  };
}

export async function getConversationSnapshot(
  fixture: ConversationFixture,
): Promise<{
  auditCount: number;
  dispatchCount: number;
  dispatchState: string | null;
  draft: boolean;
  deliveryStatus: string;
  outboxCount: number;
  providerRequestKey: string | null;
  taskStatus: string | null;
  pipelineStage: string | null;
}> {
  const sql = sqlClient();
  const rows = await sql<
    Array<{
      auditCount: number | string;
      dispatchCount: number | string;
      dispatchState: string | null;
      draft: boolean;
      deliveryStatus: string;
      outboxCount: number | string;
      providerRequestKey: string | null;
      taskStatus: string | null;
      pipelineStage: string | null;
    }>
  >`
    SELECT
      (SELECT count(*) FROM audit_logs WHERE action = 'message.retry' AND entity_id = ${fixture.draftMessageId}) AS "auditCount",
      (SELECT count(*) FROM external_message_dispatches WHERE message_id = ${fixture.draftMessageId}) AS "dispatchCount",
      (SELECT state::text FROM external_message_dispatches WHERE message_id = ${fixture.draftMessageId} ORDER BY created_at DESC, id DESC LIMIT 1) AS "dispatchState",
      coalesce((SELECT (metadata->>'draft')::boolean FROM conversation_messages WHERE id = ${fixture.draftMessageId}), false) AS draft,
      (SELECT delivery_status::text FROM conversation_messages WHERE id = ${fixture.draftMessageId}) AS "deliveryStatus",
      (SELECT count(*) FROM outbox_events WHERE payload->>'messageId' = ${fixture.draftMessageId}) AS "outboxCount",
      (SELECT provider_request_key FROM external_message_dispatches WHERE message_id = ${fixture.draftMessageId} ORDER BY created_at DESC, id DESC LIMIT 1) AS "providerRequestKey",
      ${fixture.taskId ? sql`(SELECT status::text FROM crm_tasks WHERE id = ${fixture.taskId})` : sql`NULL::text`} AS "taskStatus",
      (SELECT stage::text FROM crm_pipeline WHERE contact_id = ${fixture.contactId}) AS "pipelineStage"
  `;
  const row = rows[0];
  if (!row) throw new Error("Conversation audit snapshot unavailable.");
  return {
    auditCount: Number(row.auditCount),
    dispatchCount: Number(row.dispatchCount),
    dispatchState: row.dispatchState,
    draft: row.draft,
    deliveryStatus: row.deliveryStatus,
    outboxCount: Number(row.outboxCount),
    providerRequestKey: row.providerRequestKey,
    taskStatus: row.taskStatus,
    pipelineStage: row.pipelineStage,
  };
}

export async function getContactReminderSnapshot(
  contactId: string,
  title: string,
): Promise<{
  assignedTo: string | null;
  dueAt: Date;
  id: string;
  outboxCount: number;
  status: string;
  title: string;
  updatedAt: Date;
} | null> {
  const sql = sqlClient();
  const rows = await sql<
    Array<{
      assignedTo: string | null;
      dueAt: Date;
      id: string;
      outboxCount: number | string;
      status: string;
      title: string;
      updatedAt: Date;
    }>
  >`
    SELECT task.id, task.title, task.status::text AS status,
      task.due_at AS "dueAt", task.assigned_to AS "assignedTo",
      task.updated_at AS "updatedAt",
      (SELECT count(*) FROM outbox_events event
        WHERE event.type = 'crm.reminder.sms'
          AND event.payload->>'taskId' = task.id::text) AS "outboxCount"
    FROM crm_tasks task
    WHERE task.contact_id = ${contactId} AND task.title = ${title}
    ORDER BY task.created_at DESC, task.id DESC
    LIMIT 1
  `;
  const row = rows[0];
  return row
    ? {
        ...row,
        outboxCount: Number(row.outboxCount),
      }
    : null;
}

export async function findOutboundByEmail(email: string): Promise<{
  contactId: string;
  accountId: string;
  taskId: string;
  taskStatus: string;
  assignedToMemberId: string | null;
  dueAt: Date | null;
  openOutboundTaskCount: number;
  pendingReminderCount: number;
  partnerStatus: string;
  accountStatus: string;
} | null> {
  const sql = sqlClient();
  const rows = await sql<
    Array<{
      contactId: string;
      accountId: string;
      taskId: string;
      taskStatus: string;
      assignedToMemberId: string | null;
      dueAt: Date | null;
      openOutboundTaskCount: number | string;
      pendingReminderCount: number | string;
      partnerStatus: string;
      accountStatus: string;
    }>
  >`
    SELECT c.id AS "contactId", pa.id AS "accountId", t.id AS "taskId",
      t.status::text AS "taskStatus", t.assigned_to AS "assignedToMemberId",
      t.due_at AS "dueAt", c.partner_status::text AS "partnerStatus",
      pa.status::text AS "accountStatus",
      (SELECT count(*) FROM crm_tasks open_task
        WHERE open_task.contact_id = c.id
          AND open_task.partner_account_id = pa.id
          AND open_task.status = 'open'
          AND open_task.notes ~* '(^|\n)kind=outbound(\n|$)') AS "openOutboundTaskCount",
      (SELECT count(*) FROM outbox_events reminder
        WHERE reminder.type = 'crm.reminder.sms'
          AND reminder.processed_at IS NULL
          AND reminder.quarantined_at IS NULL
          AND reminder.payload->>'taskId' = t.id::text) AS "pendingReminderCount"
    FROM contacts c
    JOIN partner_accounts pa ON pa.id = c.partner_account_id
    JOIN crm_tasks t ON t.contact_id = c.id AND t.partner_account_id = pa.id
      AND t.notes ~* '(^|\n)kind=outbound(\n|$)'
    WHERE lower(c.email) = lower(${email})
    ORDER BY (t.status = 'open') DESC, t.updated_at DESC, t.created_at DESC, t.id DESC
    LIMIT 1
  `;
  const row = rows[0];
  return row
    ? {
        ...row,
        openOutboundTaskCount: Number(row.openOutboundTaskCount),
        pendingReminderCount: Number(row.pendingReminderCount),
      }
    : null;
}

export async function getPartnerInvite(email: string): Promise<{
  userId: string;
  orgContactId: string;
  tokenCount: number;
  rateItemCount: number;
} | null> {
  const sql = sqlClient();
  const rows = await sql<
    Array<{
      userId: string;
      orgContactId: string;
      tokenCount: number | string;
      rateItemCount: number | string;
    }>
  >`
    SELECT pu.id AS "userId", pu.org_contact_id AS "orgContactId",
      (SELECT count(*) FROM partner_login_tokens plt WHERE plt.partner_user_id = pu.id) AS "tokenCount",
      (SELECT count(*) FROM partner_rate_items pri JOIN partner_rate_cards prc ON prc.id = pri.rate_card_id WHERE prc.org_contact_id = pu.org_contact_id) AS "rateItemCount"
    FROM partner_users pu WHERE lower(pu.email) = lower(${email}) LIMIT 1
  `;
  const row = rows[0];
  return row
    ? {
        ...row,
        tokenCount: Number(row.tokenCount),
        rateItemCount: Number(row.rateItemCount),
      }
    : null;
}

export async function createMoneyCloseFixture(): Promise<
  CustomerFixture & {
    appointmentId: string;
    crewMemberId: string;
  }
> {
  const base = await createCustomerBase("money-close", {
    lead: true,
    pipelineStage: "won",
  });
  const crew = await getAuditActor("audit-crew@mystos.test");
  const sql = sqlClient();
  const appointmentRows = await sql<Array<{ id: string }>>`
    INSERT INTO appointments (
      contact_id, property_id, lead_id, type, start_at, status,
      quoted_total_cents, final_total_cents, quoted_scope_text,
      booking_details, completed_at, reschedule_token, created_at, updated_at
    ) VALUES (
      ${base.contactId}, ${base.propertyId}, ${base.leadId}, 'job', now(),
      'completed', 90000, 90000, 'Completed audit money-close job.',
      ${sql.json({
        serviceType: "junk_removal",
        source: { type: "google" },
        pricing: { mode: "exact" },
        loadSize: { kind: "three_quarters_to_full", customLoads: null },
      })}, now(), ${randomUUID().replace(/-/gu, "")}, now(), now()
    ) RETURNING id
  `;
  const appointment = appointmentRows[0];
  const appointmentId = appointment?.id;
  if (!appointmentId)
    throw new Error("Unable to seed money-close appointment.");
  await sql`
    INSERT INTO appointment_crew_members (appointment_id, member_id, split_bps)
    VALUES (${appointmentId}, ${crew.memberId}, 10000)
  `;
  return {
    ...base,
    appointmentId,
    crewMemberId: crew.memberId,
  };
}

export async function assertNoCurrentCanonicalPayout(): Promise<void> {
  const sql = sqlClient();
  const rows = await sql<Array<{ id: string }>>`
    SELECT id FROM payout_runs
    WHERE period_canonical = true AND period_start <= now() AND period_end > now()
    LIMIT 1
  `;
  if (rows[0]) {
    throw new Error(
      `The audit database is not isolated: current canonical payout ${rows[0].id} already exists.`,
    );
  }
}

export async function findExpenseByVendor(vendor: string): Promise<{
  id: string;
  lifecycleStatus: string;
  amount: number;
  version: number;
  postedAt: Date | null;
  postedBy: string | null;
} | null> {
  const sql = sqlClient();
  const rows = await sql<
    Array<{
      id: string;
      lifecycleStatus: string;
      amount: number;
      version: number;
      postedAt: Date | null;
      postedBy: string | null;
    }>
  >`
    SELECT id, lifecycle_status::text AS "lifecycleStatus", amount_cents AS amount,
      version, posted_at AS "postedAt", posted_by AS "postedBy"
    FROM expenses WHERE vendor = ${vendor} ORDER BY created_at DESC LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function findPayoutForAppointment(
  appointmentId: string,
  since: Date,
): Promise<{
  id: string;
  status: string;
  version: string;
} | null> {
  const sql = sqlClient();
  const rows = await sql<
    Array<{ id: string; status: string; updatedAt: Date }>
  >`
    SELECT pr.id, pr.status::text AS status, pr.updated_at AS "updatedAt"
    FROM payout_runs pr
    JOIN appointments appointment ON appointment.id = ${appointmentId}
      AND appointment.completed_at >= pr.period_start
      AND appointment.completed_at < pr.period_end
    WHERE pr.period_canonical = true AND pr.created_at >= ${since}
    ORDER BY pr.created_at DESC, pr.id DESC LIMIT 1
  `;
  const row = rows[0];
  return row
    ? {
        id: row.id,
        status: row.status,
        version: new Date(row.updatedAt).toISOString(),
      }
    : null;
}

export async function getMoneyCloseSnapshot(
  payoutRunId: string,
  appointmentId: string,
  paymentId: string,
): Promise<{
  status: string;
  version: string;
  lockedAt: Date | null;
  paidAt: Date | null;
  payrollExpenseCount: number;
  payrollExpenseId: string | null;
  payrollExpenseAmount: number | null;
  payrollExpenseLifecycle: string | null;
  payrollExpenseVersion: number | null;
  payrollExpensePaidAt: Date | null;
  payrollExpensePostedAt: Date | null;
  payrollExpensePostedBy: string | null;
  payrollExpenseMemo: string | null;
  lineCount: number;
  lineTotalCents: number;
  periodCommissionCount: number;
  periodCommissionTotalCents: number;
  payoutAdjustmentTotalCents: number;
  payoutReimbursementTotalCents: number;
  appointmentCommissionCount: number;
  appointmentCommissionTotalCents: number;
  crewCommissionRecipientIds: string[];
  paymentCount: number;
  paymentAmountCents: number | null;
  paymentStatus: string | null;
  paymentActorId: string | null;
  last30RevenueTotalCents: number;
  last30ExpenseTotalCents: number;
  last30ProfitTotalCents: number;
}> {
  const sql = sqlClient();
  const rows = await sql<
    Array<{
      status: string;
      updatedAt: Date;
      lockedAt: Date | null;
      paidAt: Date | null;
      payrollExpenseCount: number | string;
      payrollExpenseId: string | null;
      payrollExpenseAmount: number | null;
      payrollExpenseLifecycle: string | null;
      payrollExpenseVersion: number | null;
      payrollExpensePaidAt: Date | null;
      payrollExpensePostedAt: Date | null;
      payrollExpensePostedBy: string | null;
      payrollExpenseMemo: string | null;
      lineCount: number | string;
      lineTotalCents: number | string;
      periodCommissionCount: number | string;
      periodCommissionTotalCents: number | string;
      payoutAdjustmentTotalCents: number | string;
      payoutReimbursementTotalCents: number | string;
      appointmentCommissionCount: number | string;
      appointmentCommissionTotalCents: number | string;
      crewCommissionRecipientIds: string[] | null;
      paymentCount: number | string;
      paymentAmountCents: number | null;
      paymentStatus: string | null;
      paymentActorId: string | null;
      last30RevenueTotalCents: number | string;
      last30ExpenseTotalCents: number | string;
    }>
  >`
    SELECT pr.status::text AS status, pr.updated_at AS "updatedAt",
      pr.locked_at AS "lockedAt", pr.paid_at AS "paidAt",
      (SELECT count(*) FROM expenses e WHERE e.payout_run_id = pr.id AND e.source = 'payout_run') AS "payrollExpenseCount",
      payroll.id AS "payrollExpenseId",
      payroll.amount_cents AS "payrollExpenseAmount",
      payroll.lifecycle_status::text AS "payrollExpenseLifecycle",
      payroll.version AS "payrollExpenseVersion",
      payroll.paid_at AS "payrollExpensePaidAt",
      payroll.posted_at AS "payrollExpensePostedAt",
      payroll.posted_by AS "payrollExpensePostedBy",
      payroll.memo AS "payrollExpenseMemo",
      (SELECT count(*) FROM payout_run_lines l WHERE l.payout_run_id = pr.id) AS "lineCount",
      (SELECT coalesce(sum(l.total_cents), 0) FROM payout_run_lines l WHERE l.payout_run_id = pr.id) AS "lineTotalCents",
      (SELECT count(*) FROM appointment_commissions c
        JOIN appointments appointment ON appointment.id = c.appointment_id
        WHERE appointment.status = 'completed'
          AND appointment.completed_at >= pr.period_start
          AND appointment.completed_at < pr.period_end
          AND c.member_id IS NOT NULL) AS "periodCommissionCount",
      (SELECT coalesce(sum(c.amount_cents), 0) FROM appointment_commissions c
        JOIN appointments appointment ON appointment.id = c.appointment_id
        WHERE appointment.status = 'completed'
          AND appointment.completed_at >= pr.period_start
          AND appointment.completed_at < pr.period_end
          AND c.member_id IS NOT NULL) AS "periodCommissionTotalCents",
      (SELECT coalesce(sum(adjustment.amount_cents), 0) FROM payout_run_adjustments adjustment
        WHERE adjustment.payout_run_id = pr.id
          AND adjustment.member_id IS NOT NULL) AS "payoutAdjustmentTotalCents",
      (SELECT coalesce(sum(adjustment.amount_cents), 0) FROM payout_run_adjustments adjustment
        WHERE adjustment.payout_run_id = pr.id
          AND adjustment.kind = 'reimbursement') AS "payoutReimbursementTotalCents",
      (SELECT count(*) FROM appointment_commissions c WHERE c.appointment_id = ${appointmentId}) AS "appointmentCommissionCount",
      (SELECT coalesce(sum(c.amount_cents), 0) FROM appointment_commissions c WHERE c.appointment_id = ${appointmentId}) AS "appointmentCommissionTotalCents",
      (SELECT coalesce(array_agg(DISTINCT c.member_id ORDER BY c.member_id) FILTER (WHERE c.role = 'crew'), ARRAY[]::uuid[])
        FROM appointment_commissions c WHERE c.appointment_id = ${appointmentId}) AS "crewCommissionRecipientIds",
      (SELECT count(*) FROM payments p WHERE p.id = ${paymentId} AND p.appointment_id = ${appointmentId}) AS "paymentCount",
      payment.total_amount_cents AS "paymentAmountCents",
      payment.canonical_status::text AS "paymentStatus",
      payment.initiated_by_member_id AS "paymentActorId",
      (SELECT coalesce(sum(appointment.final_total_cents), 0) FROM appointments appointment
        WHERE appointment.status = 'completed'
          AND appointment.start_at IS NOT NULL
          AND appointment.final_total_cents IS NOT NULL
          AND appointment.start_at >= now() - interval '30 days'
          AND appointment.start_at < now()) AS "last30RevenueTotalCents",
      (SELECT coalesce(sum(e.amount_cents), 0) FROM expenses e
        WHERE e.lifecycle_status <> 'draft'
          AND e.paid_at >= now() - interval '30 days'
          AND e.paid_at < now()) AS "last30ExpenseTotalCents"
    FROM payout_runs pr
    LEFT JOIN expenses payroll ON payroll.payout_run_id = pr.id
    LEFT JOIN payments payment ON payment.id = ${paymentId}
    WHERE pr.id = ${payoutRunId} LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new Error("Payout run disappeared during audit.");
  const last30RevenueTotalCents = Number(row.last30RevenueTotalCents);
  const last30ExpenseTotalCents = Number(row.last30ExpenseTotalCents);
  return {
    status: row.status,
    version: new Date(row.updatedAt).toISOString(),
    lockedAt: row.lockedAt,
    paidAt: row.paidAt,
    payrollExpenseCount: Number(row.payrollExpenseCount),
    payrollExpenseId: row.payrollExpenseId,
    payrollExpenseAmount: row.payrollExpenseAmount,
    payrollExpenseLifecycle: row.payrollExpenseLifecycle,
    payrollExpenseVersion: row.payrollExpenseVersion,
    payrollExpensePaidAt: row.payrollExpensePaidAt,
    payrollExpensePostedAt: row.payrollExpensePostedAt,
    payrollExpensePostedBy: row.payrollExpensePostedBy,
    payrollExpenseMemo: row.payrollExpenseMemo,
    lineCount: Number(row.lineCount),
    lineTotalCents: Number(row.lineTotalCents),
    periodCommissionCount: Number(row.periodCommissionCount),
    periodCommissionTotalCents: Number(row.periodCommissionTotalCents),
    payoutAdjustmentTotalCents: Number(row.payoutAdjustmentTotalCents),
    payoutReimbursementTotalCents: Number(row.payoutReimbursementTotalCents),
    appointmentCommissionCount: Number(row.appointmentCommissionCount),
    appointmentCommissionTotalCents: Number(
      row.appointmentCommissionTotalCents,
    ),
    crewCommissionRecipientIds: row.crewCommissionRecipientIds ?? [],
    paymentCount: Number(row.paymentCount),
    paymentAmountCents: row.paymentAmountCents,
    paymentStatus: row.paymentStatus,
    paymentActorId: row.paymentActorId,
    last30RevenueTotalCents,
    last30ExpenseTotalCents,
    last30ProfitTotalCents: last30RevenueTotalCents - last30ExpenseTotalCents,
  };
}

export async function getMutationEvidence(
  idempotencyKey: string,
  action: string,
): Promise<{
  status: string;
  attemptCount: number;
  responseStatus: number | null;
  responseBody: Record<string, unknown> | null;
  operationId: string;
  correlationId: string;
  auditEventId: string | null;
  actorId: string | null;
  outcome: string | null;
  entityId: string | null;
  requiredPermissions: string[] | null;
  authMethod: string | null;
  idempotencyKeyHash: string | null;
} | null> {
  const keyHash = crypto
    .createHash("sha256")
    .update(idempotencyKey, "utf8")
    .digest("hex");
  const sql = sqlClient();
  const rows = await sql<
    Array<{
      status: string;
      attemptCount: number;
      responseStatus: number | null;
      responseBody: Record<string, unknown> | null;
      operationId: string;
      correlationId: string;
      auditEventId: string | null;
      actorId: string | null;
      outcome: string | null;
      entityId: string | null;
      requiredPermissions: string[] | null;
      authMethod: string | null;
      idempotencyKeyHash: string | null;
    }>
  >`
    SELECT idem.status, idem.attempt_count AS "attemptCount",
      idem.response_status AS "responseStatus", idem.response_body AS "responseBody",
      idem.operation_id AS "operationId", idem.correlation_id AS "correlationId",
      audit.id AS "auditEventId", audit.actor_id AS "actorId",
      audit.outcome, audit.entity_id AS "entityId",
      audit.required_permissions AS "requiredPermissions",
      audit.auth_method AS "authMethod",
      audit.idempotency_key_hash AS "idempotencyKeyHash"
    FROM team_mutation_idempotency idem
    LEFT JOIN audit_logs audit ON audit.correlation_id = idem.correlation_id
      AND audit.action = ${action}
    WHERE idem.key_hash = ${keyHash} AND idem.action = ${action}
    ORDER BY audit.created_at DESC NULLS LAST LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function findRoleAndMember(
  slug: string,
  email: string,
): Promise<{
  roleId: string;
  memberId: string;
  active: boolean;
  permissions: string[];
  permissionsGrant: string[];
  permissionsDeny: string[];
  updatedAt: string;
} | null> {
  const sql = sqlClient();
  const rows = await sql<
    Array<{
      roleId: string;
      memberId: string;
      active: boolean;
      permissions: string[];
      permissionsGrant: string[];
      permissionsDeny: string[];
      updatedAt: Date;
    }>
  >`
    SELECT r.id AS "roleId", m.id AS "memberId", m.active, r.permissions,
      m.permissions_grant AS "permissionsGrant",
      m.permissions_deny AS "permissionsDeny", m.updated_at AS "updatedAt"
    FROM team_roles r JOIN team_members m ON m.role_id = r.id
    WHERE r.slug = ${slug} AND m.email_normalized = lower(${email}) LIMIT 1
  `;
  const row = rows[0];
  return row
    ? {
        ...row,
        updatedAt: row.updatedAt.toISOString(),
      }
    : null;
}

export async function findRoleBySlug(slug: string): Promise<{
  id: string;
  permissions: string[];
} | null> {
  const sql = sqlClient();
  const rows = await sql<Array<{ id: string; permissions: string[] }>>`
    SELECT id, permissions FROM team_roles WHERE slug = ${slug} LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function getAccessRevocationSnapshot(memberId: string): Promise<{
  active: boolean;
  activeSessions: number;
}> {
  const sql = sqlClient();
  const rows = await sql<
    Array<{ active: boolean; activeSessions: number | string }>
  >`
    SELECT m.active,
      (SELECT count(*) FROM team_sessions s WHERE s.team_member_id = m.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS "activeSessions"
    FROM team_members m WHERE m.id = ${memberId} LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new Error("Access audit member disappeared.");
  return { active: row.active, activeSessions: Number(row.activeSessions) };
}

export async function getAuditEventsSince(
  since: Date,
  actions: readonly string[],
): Promise<AuditEventRow[]> {
  const sql = sqlClient();
  return sql<AuditEventRow[]>`
    SELECT id, action, entity_id AS "entityId", actor_id AS "actorId",
      actor_label AS "actorLabel", outcome, meta, created_at AS "createdAt"
    FROM audit_logs
    WHERE created_at >= ${since} AND action = ANY(${[...actions]}::text[])
    ORDER BY created_at ASC
  `;
}

export async function cleanupPayoutRun(
  payoutRunId: string | null,
  manualExpenseId: string | null,
): Promise<"cleaned" | "retained_for_shard_reset"> {
  if (manualExpenseId) {
    // Manual ledger entries are deliberately append-only, including during
    // tests. A failed journey must never gain a cleanup-only deletion path
    // that production users do not have. The disposable shard reset owns this
    // financial fixture and its related payout evidence.
    return "retained_for_shard_reset";
  }
  const sql = sqlClient();
  return sql.begin(async (tx) => {
    const statuses = payoutRunId
      ? await tx<Array<{ status: string }>>`
          SELECT status::text AS status FROM payout_runs
          WHERE id = ${payoutRunId} FOR UPDATE
        `
      : [];
    const status = statuses[0]?.status ?? null;
    if (status === "locked" || status === "paid") {
      // Finalized financial evidence is intentionally immutable. The isolated
      // E2E shard reset owns its removal; per-test cleanup must not bypass the
      // same guards the journey is proving.
      return "retained_for_shard_reset" as const;
    }
    if (payoutRunId) {
      await tx`DELETE FROM payout_run_lines WHERE payout_run_id = ${payoutRunId}`;
      await tx`DELETE FROM payout_run_adjustments WHERE payout_run_id = ${payoutRunId}`;
      await tx`DELETE FROM expenses WHERE payout_run_id = ${payoutRunId}`;
      await tx`DELETE FROM payout_runs WHERE id = ${payoutRunId}`;
    }
    return "cleaned" as const;
  });
}

export async function cleanupAccessFixture(
  roleId: string | null,
  memberId: string | null,
): Promise<void> {
  const sql = sqlClient();
  await sql.begin(async (tx) => {
    if (memberId) {
      await tx`DELETE FROM team_sessions WHERE team_member_id = ${memberId}`;
      await tx`DELETE FROM team_login_tokens WHERE team_member_id = ${memberId}`;
      await tx`DELETE FROM team_members WHERE id = ${memberId}`;
    }
    if (roleId) await tx`DELETE FROM team_roles WHERE id = ${roleId}`;
  });
}

export async function cleanupCustomerFixture(contactId: string): Promise<void> {
  const sql = sqlClient();
  await sql.begin(async (tx) => {
    const propertyRows = await tx<Array<{ id: string }>>`
      SELECT property_id AS id FROM contact_properties WHERE contact_id = ${contactId}
      UNION SELECT id FROM properties WHERE contact_id = ${contactId}
    `;
    const propertyIds = propertyRows.map((row) => row.id);
    const appointmentRows = await tx<Array<{ id: string }>>`
      SELECT id FROM appointments WHERE contact_id = ${contactId}
    `;
    const appointmentIds = appointmentRows.map((row) => row.id);
    const messageRows = await tx<Array<{ id: string }>>`
      SELECT m.id FROM conversation_messages m
      JOIN conversation_threads t ON t.id = m.thread_id
      WHERE t.contact_id = ${contactId}
    `;
    const messageIds = messageRows.map((row) => row.id);
    const accountRows = await tx<Array<{ id: string }>>`
      SELECT partner_account_id AS id FROM contacts
      WHERE id = ${contactId} AND partner_account_id IS NOT NULL
    `;
    const accountIds = accountRows.map((row) => row.id);

    await tx`DELETE FROM external_message_dispatches WHERE contact_id = ${contactId}`;
    if (messageIds.length) {
      await tx`DELETE FROM outbox_events WHERE payload->>'messageId' = ANY(${messageIds}::text[])`;
    }
    if (appointmentIds.length) {
      await tx`DELETE FROM payments WHERE appointment_id = ANY(${appointmentIds}::uuid[])`;
      await tx`DELETE FROM payment_attempts WHERE appointment_id = ANY(${appointmentIds}::uuid[])`;
    }
    await tx`
      DELETE FROM outbox_events
      WHERE payload->>'contactId' = ${contactId}
         OR payload->>'leadId' IN (SELECT id::text FROM leads WHERE contact_id = ${contactId})
         OR payload->>'quoteId' IN (SELECT id::text FROM quotes WHERE contact_id = ${contactId})
         OR payload->>'appointmentId' IN (SELECT id::text FROM appointments WHERE contact_id = ${contactId})
         OR payload->>'taskId' IN (SELECT id::text FROM crm_tasks WHERE contact_id = ${contactId})
    `;
    await tx`DELETE FROM appointment_holds WHERE contact_id = ${contactId}`;
    await tx`DELETE FROM instant_quotes WHERE contact_id = ${contactId}`;
    // A completed public quote mutation has an intentionally immutable replay
    // receipt. Revoke the public capability and redact its linked address, but
    // retain the quote/property graph until the disposable shard is reset.
    await tx`
      UPDATE quotes
      SET share_token = NULL, updated_at = statement_timestamp()
      WHERE contact_id = ${contactId}
    `;
    // Per-journey cleanup must not bypass the production purge boundary.
    // Unique PII is scrubbed and the otherwise-empty contact stays in its
    // 30-day recovery state until the disposable shard database is reset.
    await tx`
      UPDATE contacts
      SET
        email = NULL,
        phone = NULL,
        phone_e164 = NULL,
        deleted_at = statement_timestamp(),
        deleted_by = NULL,
        purge_eligible_at = statement_timestamp() + interval '30 days',
        updated_at = statement_timestamp()
      WHERE id = ${contactId}
    `;
    if (propertyIds.length) {
      await tx`
        UPDATE properties
        SET
          address_key = 'audit-fixture-redacted|' || id::text,
          address_line1 = '[Audit fixture address redacted ' || left(id::text, 8) || ']',
          address_line2 = NULL,
          city = 'Redacted',
          state = 'NA',
          postal_code = '00000',
          lat = NULL,
          lng = NULL,
          gated = false,
          updated_at = statement_timestamp()
        WHERE id = ANY(${propertyIds}::uuid[])
      `;
    }
    if (accountIds.length) {
      await tx`DELETE FROM partner_accounts WHERE id = ANY(${accountIds}::uuid[])`;
    }
  });
}

export async function closeJourneyFixtures(): Promise<void> {
  const sql = cachedSql;
  cachedSql = null;
  if (sql) await sql.end({ timeout: 5 });
}
