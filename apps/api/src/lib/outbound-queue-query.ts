import { sql, type SQL } from "drizzle-orm";
import { DateTime } from "luxon";
import type { DatabaseClient } from "@/db";
import {
  encodeOutboundQueueCursor,
  escapedOutboundSearchPattern,
  outboundQueueFilterFingerprint,
  OUTBOUND_QUEUE_TIME_ZONE,
  type OutboundQueueRequest,
} from "@/lib/outbound-queue-pagination";

const MAX_PAGE_TASK_ROWS = 2_500;
const MAX_FACET_VALUES = 1_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type OutboundQueueExecutor = Pick<DatabaseClient, "execute">;

type RawRecord = Record<string, unknown>;

/**
 * Raw Drizzle SQL fragments do not attach the timestamp encoder that a schema
 * column normally supplies. Passing a Date directly therefore reaches
 * postgres.js as a Date after PostgreSQL resolves the parameter as
 * timestamptz, which postgres.js cannot serialize for that resolved type.
 * Bind an exact ISO instant and cast it explicitly at every raw-SQL boundary.
 */
function timestamptzParam(value: Date | string): SQL {
  const instant = value instanceof Date ? value.toISOString() : value;
  return sql`${instant}::timestamptz`;
}

type PageAccountRow = {
  accountKey: string;
  accountCreatedAt: Date;
  primaryTaskId: string;
};

type DetailRow = {
  taskId: string;
  taskVersion: Date;
  title: string | null;
  dueAt: Date | null;
  attempt: number;
  campaign: string | null;
  lastDisposition: string | null;
  company: string | null;
  noteSnippet: string | null;
  startedAt: Date | null;
  assignedTo: string;
  createdAt: Date;
  contactId: string;
  contactName: string;
  contactEmail: string | null;
  contactPhone: string | null;
  contactSource: string | null;
  contactDoNotContact: boolean;
  contactDoNotContactAt: Date | null;
  contactDoNotContactReason: string | null;
  accountKey: string;
  accountId: string;
  accountName: string;
  accountStatus: string | null;
  accountSegment: string | null;
  accountPortalFit: string | null;
  accountFitScore: number | null;
  accountLastTouchAt: Date | null;
  accountNextTouchAt: Date | null;
};

export type OutboundQueueAccount = {
  id: string;
  key: string;
  name: string;
  status: string | null;
  segment: string | null;
  portalFit: string | null;
  fitScore: number | null;
  campaign: string | null;
  primaryTaskId: string;
  primaryTaskVersion: string;
  primaryContactId: string;
  title: string | null;
  dueAt: string | null;
  overdue: boolean;
  minutesUntilDue: number | null;
  attempt: number;
  lastDisposition: string | null;
  company: string | null;
  noteSnippet: string | null;
  startedAt: string | null;
  reminderAt: string | null;
  assignedToMemberId: string;
  lastTouchAt: string | null;
  nextTouchAt: string | null;
  contacts: Array<{
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    source: string | null;
    doNotContact: boolean;
    doNotContactAt: string | null;
    doNotContactReason: string | null;
  }>;
  tasks: Array<{
    id: string;
    version: string;
    title: string | null;
    dueAt: string | null;
    attempt: number;
    lastDisposition: string | null;
    contactId: string;
    contactName: string;
    doNotContact: boolean;
  }>;
  taskIds: string[];
};

export type OutboundQueueQueryResult = {
  snapshotAt: string;
  total: number;
  offset: number;
  limit: number;
  nextOffset: number | null;
  nextCursor: string | null;
  previousCursor: string | null;
  summary: {
    dueNow: number;
    overdue: number;
    callbacksToday: number;
    notStarted: number;
    scoreboard: {
      accountsTouched: number;
      conversationsStarted: number;
      qualifiedPartners: number;
      activePartners: number;
      avgFitScore: number | null;
      partnerPathMix: {
        portalFirst: number;
        managedDirect: number;
        hybrid: number;
        notAFit: number;
      };
    };
  };
  facets: {
    campaigns: string[];
    dispositions: string[];
    attempts: string[];
  };
  items: OutboundQueueAccount[];
};

export class OutboundQueueDataLimitError extends Error {
  readonly code = "outbound_queue_data_limit";

  constructor(message: string) {
    super(message);
    this.name = "OutboundQueueDataLimitError";
  }
}

/**
 * Resolve a selection-only deep link to the assignee that owns its open queue
 * task. The optional account binding prevents a stale or hand-edited pair of
 * IDs from selecting a different account's task.
 */
export async function resolveOutboundSelectedTaskMemberId(
  db: OutboundQueueExecutor,
  input: { taskId: string; accountId: string | null },
): Promise<string | null> {
  const accountCondition = input.accountId
    ? sql`AND coalesce(account."id", contact."id")::text = ${input.accountId}`
    : sql``;
  const result = await db.execute(sql`
    SELECT task."assigned_to"::text AS "memberId"
    FROM "crm_tasks" AS task
    INNER JOIN "contacts" AS contact
      ON contact."id" = task."contact_id"
     AND contact."deleted_at" IS NULL
    LEFT JOIN "partner_accounts" AS account
      ON account."id" = coalesce(task."partner_account_id", contact."partner_account_id")
    WHERE task."id" = ${input.taskId}::uuid
      AND task."status" = 'open'
      AND task."assigned_to" IS NOT NULL
      AND (
        task."outbound_is_outbound" IS TRUE
        OR (
          task."outbound_projection_version" IS DISTINCT FROM 1
          AND lower(coalesce("crm_task_note_field"(task."notes", 'kind'), '')) = 'outbound'
        )
      )
      ${accountCondition}
    LIMIT 1
  `);
  const row = asRecordArray(result)[0];
  const memberId = row?.["memberId"];
  return typeof memberId === "string" && UUID_PATTERN.test(memberId)
    ? memberId.toLowerCase()
    : null;
}

function asRecordArray(value: unknown): RawRecord[] {
  if (!Array.isArray(value)) {
    throw new Error("Outbound queue database result was not an array.");
  }
  return value.filter(
    (row): row is RawRecord =>
      typeof row === "object" && row !== null && !Array.isArray(row),
  );
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.length) {
    throw new Error(`Outbound queue row is missing ${field}.`);
  }
  return value;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function asInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Outbound queue row has an invalid ${field}.`);
  }
  return parsed;
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asDate(value: unknown, field: string): Date {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Outbound queue row has an invalid ${field}.`);
  }
  return parsed;
}

function asNullableDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (
    !(value instanceof Date) &&
    typeof value !== "string" &&
    typeof value !== "number"
  ) {
    return null;
  }
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function asStringArray(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new Error(`Outbound queue metadata has an invalid ${field}.`);
  }
  return value;
}

function baseTasksCte(query: OutboundQueueRequest): SQL {
  return sql`
    WITH "base_tasks" AS (
      SELECT
        task."id" AS "taskId",
        task."updated_at" AS "taskVersion",
        task."title" AS "title",
        task."due_at" AS "dueAt",
        (task."outbound_projection_version" = 1) AS "projectionReady",
        coalesce(
          task."outbound_attempt",
          CASE
            WHEN "crm_task_note_field"(task."notes", 'attempt') ~ '^[1-9][0-9]{0,8}$'
              THEN "crm_task_note_field"(task."notes", 'attempt')::integer
            ELSE 1
          END
        ) AS "attempt",
        task."outbound_attempt" AS "attemptProjection",
        CASE
          WHEN task."outbound_projection_version" = 1 THEN NULL
          WHEN "crm_task_note_field"(task."notes", 'attempt') ~ '^[1-9][0-9]{0,8}$'
            THEN "crm_task_note_field"(task."notes", 'attempt')::integer
          ELSE 1
        END AS "attemptLegacy",
        CASE
          WHEN task."outbound_projection_version" = 1
            THEN task."outbound_campaign"
          ELSE coalesce(
            task."outbound_campaign",
            "crm_task_note_field"(task."notes", 'campaign')
          )
        END AS "campaign",
        lower(task."outbound_campaign") AS "campaignProjection",
        CASE
          WHEN task."outbound_projection_version" IS DISTINCT FROM 1
            THEN lower("crm_task_note_field"(task."notes", 'campaign'))
          ELSE NULL
        END AS "campaignLegacy",
        lower(CASE
          WHEN task."outbound_projection_version" = 1
            THEN task."outbound_last_disposition"
          ELSE coalesce(
            task."outbound_last_disposition",
            "crm_task_note_field"(task."notes", 'lastDisposition')
          )
        END) AS "lastDisposition",
        lower(task."outbound_last_disposition") AS "dispositionProjection",
        CASE
          WHEN task."outbound_projection_version" IS DISTINCT FROM 1
            THEN lower("crm_task_note_field"(task."notes", 'lastDisposition'))
          ELSE NULL
        END AS "dispositionLegacy",
        CASE
          WHEN task."outbound_projection_version" = 1
            THEN task."outbound_company"
          ELSE coalesce(task."outbound_company", "crm_task_note_field"(task."notes", 'company'))
        END AS "company",
        CASE
          WHEN task."outbound_projection_version" = 1
            THEN task."outbound_note_snippet"
          ELSE coalesce(task."outbound_note_snippet", "crm_task_note_field"(task."notes", 'notes'))
        END AS "noteSnippet",
        lower(
          coalesce(task."outbound_company", '') || ' ' ||
          coalesce(task."outbound_note_snippet", '')
        ) AS "outboundSearchText",
        (
          task."outbound_projection_version" IS DISTINCT FROM 1
        ) AS "outboundProjectionIncomplete",
        CASE
          WHEN task."outbound_projection_version" IS DISTINCT FROM 1
          THEN lower(
            coalesce(
              task."outbound_company",
              "crm_task_note_field"(task."notes", 'company'),
              ''
            ) || ' ' ||
            coalesce(
              task."outbound_note_snippet",
              "crm_task_note_field"(task."notes", 'notes'),
              ''
            )
          )
          ELSE ''
        END AS "legacyOutboundSearchText",
        CASE
          WHEN task."outbound_projection_version" = 1
            THEN task."outbound_started_at"
          ELSE coalesce(
            task."outbound_started_at",
            "crm_task_note_timestamptz"(task."notes", 'startedAt')
          )
        END AS "startedAt",
        task."assigned_to" AS "assignedTo",
        task."created_at" AS "createdAt",
        contact."id" AS "contactId",
        coalesce(
          nullif(btrim(concat_ws(' ', contact."first_name", contact."last_name")), ''),
          'Contact'
        ) AS "contactName",
        contact."email" AS "contactEmail",
        coalesce(contact."phone_e164", contact."phone") AS "contactPhone",
        lower(
          coalesce(contact."first_name", '') || ' ' ||
          coalesce(contact."last_name", '') || ' ' ||
          coalesce(contact."email", '') || ' ' ||
          coalesce(contact."phone", '') || ' ' ||
          coalesce(contact."phone_e164", '')
        ) AS "contactSearchText",
        contact."source" AS "contactSource",
        contact."do_not_contact" AS "contactDoNotContact",
        contact."do_not_contact_at" AS "contactDoNotContactAt",
        contact."do_not_contact_reason" AS "contactDoNotContactReason",
        CASE
          WHEN coalesce(task."partner_account_id", contact."partner_account_id") IS NOT NULL
            THEN 'account:' || coalesce(task."partner_account_id", contact."partner_account_id")::text
          ELSE 'contact:' || contact."id"::text
        END AS "accountKey",
        coalesce(account."id", contact."id")::text AS "accountId",
        coalesce(
          account."name",
          task."outbound_company",
          CASE
            WHEN task."outbound_projection_version" IS DISTINCT FROM 1
              THEN "crm_task_note_field"(task."notes", 'company')
            ELSE NULL
          END,
          nullif(btrim(concat_ws(' ', contact."first_name", contact."last_name")), ''),
          'Contact'
        ) AS "accountName",
        lower(coalesce(account."name", '')) AS "accountSearchText",
        account."status"::text AS "accountStatus",
        account."segment" AS "accountSegment",
        account."portal_fit" AS "accountPortalFit",
        account."fit_score" AS "accountFitScore",
        account."last_touch_at" AS "accountLastTouchAt",
        account."next_touch_at" AS "accountNextTouchAt",
        coalesce(account."created_at", contact."created_at") AS "accountCreatedAt"
      FROM "crm_tasks" AS task
      INNER JOIN "contacts" AS contact
        ON contact."id" = task."contact_id"
       AND contact."deleted_at" IS NULL
      LEFT JOIN "partner_accounts" AS account
        ON account."id" = coalesce(task."partner_account_id", contact."partner_account_id")
      WHERE task."status" = 'open'
        AND task."assigned_to" = ${query.memberId}
        AND task."contact_id" IS NOT NULL
        AND task."created_at" <= ${timestamptzParam(query.snapshotAt)}
        AND (
          task."outbound_is_outbound" IS TRUE
          OR (
            task."outbound_projection_version" IS DISTINCT FROM 1
            AND lower(coalesce("crm_task_note_field"(task."notes", 'kind'), '')) = 'outbound'
          )
        )
    )
  `;
}

function matchingConditions(query: OutboundQueueRequest): SQL[] {
  const conditions: SQL[] = [];
  const { filters } = query;
  const now = query.snapshotAt;
  const localNow = DateTime.fromJSDate(now, {
    zone: OUTBOUND_QUEUE_TIME_ZONE,
  });

  if (filters.due === "not_started") {
    conditions.push(sql`"dueAt" IS NULL`);
  } else if (filters.due === "overdue") {
    conditions.push(
      sql`"dueAt" IS NOT NULL AND "dueAt" < ${timestamptzParam(now)}`,
    );
  } else if (filters.due === "due_now") {
    conditions.push(
      sql`"dueAt" IS NOT NULL AND "dueAt" <= ${timestamptzParam(now)}`,
    );
  } else if (filters.due === "today") {
    const start = localNow.startOf("day").toUTC().toJSDate();
    const endExclusive = localNow
      .plus({ days: 1 })
      .startOf("day")
      .toUTC()
      .toJSDate();
    conditions.push(
      sql`"dueAt" >= ${timestamptzParam(start)} AND "dueAt" < ${timestamptzParam(endExclusive)}`,
    );
  }

  if (filters.campaign) {
    conditions.push(sql`(
      "campaignProjection" = ${filters.campaign}
      OR (
        "projectionReady" IS NOT TRUE
        AND "campaignLegacy" = ${filters.campaign}
      )
    )`);
  }
  if (filters.attempt !== null) {
    conditions.push(sql`(
      "attemptProjection" = ${filters.attempt}
      OR (
        "projectionReady" IS NOT TRUE
        AND "attemptLegacy" = ${filters.attempt}
      )
    )`);
  }
  if (filters.disposition) {
    conditions.push(sql`(
      "dispositionProjection" = ${filters.disposition}
      OR (
        "projectionReady" IS NOT TRUE
        AND "dispositionLegacy" = ${filters.disposition}
      )
    )`);
  }
  if (filters.has === "phone") {
    conditions.push(
      sql`nullif(btrim(coalesce("contactPhone", '')), '') IS NOT NULL`,
    );
  } else if (filters.has === "email") {
    conditions.push(
      sql`nullif(btrim(coalesce("contactEmail", '')), '') IS NOT NULL`,
    );
  } else if (filters.has === "both") {
    conditions.push(
      sql`nullif(btrim(coalesce("contactPhone", '')), '') IS NOT NULL`,
      sql`nullif(btrim(coalesce("contactEmail", '')), '') IS NOT NULL`,
    );
  }

  if (filters.q) {
    const pattern = escapedOutboundSearchPattern(filters.q);
    conditions.push(sql`(
      "contactSearchText" LIKE ${pattern} ESCAPE '!'
      OR "accountSearchText" LIKE ${pattern} ESCAPE '!'
      OR "outboundSearchText" LIKE ${pattern} ESCAPE '!'
      OR (
        "outboundProjectionIncomplete"
        AND "legacyOutboundSearchText" LIKE ${pattern} ESCAPE '!'
      )
    )`);
  }

  return conditions;
}

function matchingTasksCte(query: OutboundQueueRequest): SQL {
  const conditions = matchingConditions(query);
  const localDay = DateTime.fromJSDate(query.snapshotAt, {
    zone: OUTBOUND_QUEUE_TIME_ZONE,
  });
  const localDayStart = localDay.startOf("day").toUTC().toJSDate();
  const localDayEnd = localDay
    .plus({ days: 1 })
    .startOf("day")
    .toUTC()
    .toJSDate();
  return sql`
    ${baseTasksCte(query)},
    "matching_tasks" AS MATERIALIZED (
      SELECT *
      FROM "base_tasks"
      ${conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``}
    ),
    "account_rollup" AS MATERIALIZED (
      SELECT
        "accountKey",
        min("accountCreatedAt") AS "accountCreatedAt",
        min("dueAt") AS "primaryDueAt",
        (array_agg(
          "taskId"
          ORDER BY ("dueAt" IS NULL), "dueAt", "createdAt" DESC, "taskId"
        ))[1] AS "primaryTaskId",
        bool_or(
          (
            lower(coalesce("title", '')) LIKE '%callback%'
            OR "lastDisposition" = 'callback_requested'
          )
          AND "dueAt" >= ${timestamptzParam(localDayStart)}
          AND "dueAt" < ${timestamptzParam(localDayEnd)}
        ) AS "callbackToday"
      FROM "matching_tasks"
      GROUP BY "accountKey"
    )
  `;
}

function parsePageAccount(row: RawRecord): PageAccountRow {
  return {
    accountKey: asString(row["accountKey"], "accountKey"),
    accountCreatedAt: asDate(row["accountCreatedAt"], "accountCreatedAt"),
    primaryTaskId: asString(row["primaryTaskId"], "primaryTaskId"),
  };
}

function parseDetailRow(row: RawRecord): DetailRow {
  return {
    taskId: asString(row["taskId"], "taskId"),
    taskVersion: asDate(row["taskVersion"], "taskVersion"),
    title: asNullableString(row["title"]),
    dueAt: asNullableDate(row["dueAt"]),
    attempt: Math.max(asInteger(row["attempt"], "attempt"), 1),
    campaign: asNullableString(row["campaign"]),
    lastDisposition: asNullableString(row["lastDisposition"]),
    company: asNullableString(row["company"]),
    noteSnippet: asNullableString(row["noteSnippet"]),
    startedAt: asNullableDate(row["startedAt"]),
    assignedTo: asString(row["assignedTo"], "assignedTo"),
    createdAt: asDate(row["createdAt"], "createdAt"),
    contactId: asString(row["contactId"], "contactId"),
    contactName: asString(row["contactName"], "contactName"),
    contactEmail: asNullableString(row["contactEmail"]),
    contactPhone: asNullableString(row["contactPhone"]),
    contactSource: asNullableString(row["contactSource"]),
    contactDoNotContact: asBoolean(row["contactDoNotContact"]),
    contactDoNotContactAt: asNullableDate(row["contactDoNotContactAt"]),
    contactDoNotContactReason: asNullableString(
      row["contactDoNotContactReason"],
    ),
    accountKey: asString(row["accountKey"], "accountKey"),
    accountId: asString(row["accountId"], "accountId"),
    accountName: asString(row["accountName"], "accountName"),
    accountStatus: asNullableString(row["accountStatus"]),
    accountSegment: asNullableString(row["accountSegment"]),
    accountPortalFit: asNullableString(row["accountPortalFit"]),
    accountFitScore: asNullableNumber(row["accountFitScore"]),
    accountLastTouchAt: asNullableDate(row["accountLastTouchAt"]),
    accountNextTouchAt: asNullableDate(row["accountNextTouchAt"]),
  };
}

function accountFromRows(input: {
  pageAccount: PageAccountRow;
  rows: DetailRow[];
  snapshotAt: Date;
}): OutboundQueueAccount {
  const primary =
    input.rows.find((row) => row.taskId === input.pageAccount.primaryTaskId) ??
    input.rows[0];
  if (!primary) {
    throw new Error("Outbound queue account has no open task details.");
  }
  const dueAt = primary.dueAt?.toISOString() ?? null;
  const dueMs = primary.dueAt?.getTime() ?? null;
  const contacts = new Map<string, OutboundQueueAccount["contacts"][number]>();
  for (const row of input.rows) {
    if (!contacts.has(row.contactId)) {
      contacts.set(row.contactId, {
        id: row.contactId,
        name: row.contactName,
        email: row.contactEmail,
        phone: row.contactPhone,
        source: row.contactSource,
        doNotContact: row.contactDoNotContact,
        doNotContactAt: row.contactDoNotContactAt?.toISOString() ?? null,
        doNotContactReason: row.contactDoNotContactReason,
      });
    }
  }

  return {
    id: primary.accountId,
    key: primary.accountKey,
    name: primary.accountName,
    status: primary.accountStatus,
    segment: primary.accountSegment,
    portalFit: primary.accountPortalFit,
    fitScore: primary.accountFitScore,
    campaign: primary.campaign,
    primaryTaskId: primary.taskId,
    primaryTaskVersion: primary.taskVersion.toISOString(),
    primaryContactId: primary.contactId,
    title: primary.title,
    dueAt,
    overdue: dueMs !== null && dueMs < input.snapshotAt.getTime(),
    minutesUntilDue:
      dueMs === null
        ? null
        : Math.round((dueMs - input.snapshotAt.getTime()) / 60_000),
    attempt: primary.attempt,
    lastDisposition: primary.lastDisposition,
    company: primary.company,
    noteSnippet: primary.noteSnippet,
    startedAt: primary.startedAt?.toISOString() ?? null,
    reminderAt: null,
    assignedToMemberId: primary.assignedTo,
    lastTouchAt: primary.accountLastTouchAt?.toISOString() ?? null,
    nextTouchAt: primary.accountNextTouchAt?.toISOString() ?? null,
    contacts: Array.from(contacts.values()),
    tasks: input.rows.map((row) => ({
      id: row.taskId,
      version: row.taskVersion.toISOString(),
      title: row.title,
      dueAt: row.dueAt?.toISOString() ?? null,
      attempt: row.attempt,
      lastDisposition: row.lastDisposition,
      contactId: row.contactId,
      contactName: row.contactName,
      doNotContact: row.contactDoNotContact,
    })),
    taskIds: input.rows.map((row) => row.taskId),
  };
}

export async function loadOutboundQueuePage(
  db: OutboundQueueExecutor,
  query: OutboundQueueRequest,
): Promise<OutboundQueueQueryResult> {
  const metadataSql = sql`
    ${matchingTasksCte(query)}
    SELECT
      count(*)::integer AS "total",
      count(*) FILTER (WHERE "primaryDueAt" <= ${timestamptzParam(query.snapshotAt)})::integer AS "dueNow",
      count(*) FILTER (WHERE "primaryDueAt" < ${timestamptzParam(query.snapshotAt)})::integer AS "overdue",
      count(*) FILTER (WHERE "primaryDueAt" IS NULL)::integer AS "notStarted",
      count(*) FILTER (WHERE "callbackToday")::integer AS "callbacksToday",
      coalesce((
        SELECT array_agg(facet."value" ORDER BY lower(facet."value"))
        FROM (
          SELECT min("campaign") AS "value"
          FROM "base_tasks"
          WHERE nullif(btrim("campaign"), '') IS NOT NULL
          GROUP BY lower("campaign")
          LIMIT ${MAX_FACET_VALUES + 1}
        ) AS facet
      ), ARRAY[]::text[]) AS "campaigns",
      coalesce((
        SELECT array_agg(facet."value" ORDER BY facet."value")
        FROM (
          SELECT DISTINCT lower("lastDisposition") AS "value"
          FROM "base_tasks"
          WHERE nullif(btrim("lastDisposition"), '') IS NOT NULL
          LIMIT ${MAX_FACET_VALUES + 1}
        ) AS facet
      ), ARRAY[]::text[]) AS "dispositions",
      coalesce((
        SELECT array_agg(facet."value"::text ORDER BY facet."value")
        FROM (
          SELECT DISTINCT "attempt" AS "value"
          FROM "base_tasks"
          LIMIT ${MAX_FACET_VALUES + 1}
        ) AS facet
      ), ARRAY[]::text[]) AS "attempts"
    FROM "account_rollup"
  `;

  const cursorCondition = query.cursor
    ? query.direction === "previous"
      ? sql`("accountCreatedAt", "accountKey") < (${timestamptzParam(query.cursor.accountCreatedAt)}, ${query.cursor.accountKey})`
      : sql`("accountCreatedAt", "accountKey") > (${timestamptzParam(query.cursor.accountCreatedAt)}, ${query.cursor.accountKey})`
    : null;
  const pageSql = sql`
    ${matchingTasksCte(query)}
    SELECT "accountKey", "accountCreatedAt", "primaryTaskId"
    FROM "account_rollup"
    ${cursorCondition ? sql`WHERE ${cursorCondition}` : sql``}
    ORDER BY
      "accountCreatedAt" ${query.direction === "previous" ? sql`DESC` : sql`ASC`},
      "accountKey" ${query.direction === "previous" ? sql`DESC` : sql`ASC`}
    LIMIT ${query.limit + 1}
  `;

  const campaignScoreCondition = query.filters.campaign
    ? sql`AND lower(coalesce("source_campaign", '')) = ${query.filters.campaign}`
    : sql``;
  const scoreboardSql = sql`
    SELECT
      count(*) FILTER (WHERE "last_touch_at" IS NOT NULL)::integer AS "accountsTouched",
      count(*) FILTER (WHERE "status" IN (
        'conversation_active', 'qualified_partner', 'trial_partner',
        'active_partner', 'portal_partner', 'managed_partner'
      ))::integer AS "conversationsStarted",
      count(*) FILTER (WHERE "status" IN (
        'qualified_partner', 'trial_partner', 'active_partner',
        'portal_partner', 'managed_partner'
      ))::integer AS "qualifiedPartners",
      count(*) FILTER (WHERE "status" IN (
        'active_partner', 'portal_partner', 'managed_partner'
      ))::integer AS "activePartners",
      round(avg("fit_score"))::integer AS "avgFitScore",
      count(*) FILTER (WHERE lower(coalesce("portal_fit", '')) = 'portal_first')::integer AS "portalFirst",
      count(*) FILTER (WHERE lower(coalesce("portal_fit", '')) = 'managed_direct')::integer AS "managedDirect",
      count(*) FILTER (WHERE lower(coalesce("portal_fit", '')) = 'hybrid')::integer AS "hybrid",
      count(*) FILTER (WHERE lower(coalesce("portal_fit", '')) = 'not_a_fit')::integer AS "notAFit"
    FROM "partner_accounts"
    WHERE "owner_member_id" = ${query.memberId}::uuid
      AND "created_at" <= ${timestamptzParam(query.snapshotAt)}
      AND (
        lower(coalesce("source", '')) LIKE 'outbound:%'
        OR "source_campaign" IS NOT NULL
      )
      ${campaignScoreCondition}
  `;

  const [metadataResult, pageResult, scoreboardResult] = await Promise.all([
    db.execute(metadataSql),
    db.execute(pageSql),
    db.execute(scoreboardSql),
  ]);
  const metadataRows = asRecordArray(metadataResult);
  const metadata = metadataRows[0];
  if (!metadata) {
    throw new Error("Outbound queue metadata query returned no row.");
  }
  const campaigns = asStringArray(metadata["campaigns"], "campaigns");
  const dispositions = asStringArray(metadata["dispositions"], "dispositions");
  const attempts = asStringArray(metadata["attempts"], "attempts");
  if (
    campaigns.length > MAX_FACET_VALUES ||
    dispositions.length > MAX_FACET_VALUES ||
    attempts.length > MAX_FACET_VALUES
  ) {
    throw new OutboundQueueDataLimitError(
      "Outbound filter values exceed the supported bound. Consolidate legacy campaign or disposition labels before retrying; no queue rows were hidden.",
    );
  }

  let pageRows = asRecordArray(pageResult).map(parsePageAccount);
  if (pageRows.length > query.limit) pageRows = pageRows.slice(0, query.limit);
  if (query.direction === "previous") pageRows.reverse();

  let detailRows: DetailRow[] = [];
  if (pageRows.length > 0) {
    const pageKeyList = sql.join(
      pageRows.map((row) => sql`${row.accountKey}`),
      sql`, `,
    );
    const detailsResult = await db.execute(sql`
      ${baseTasksCte(query)}
      SELECT *
      FROM "base_tasks"
      WHERE "accountKey" IN (${pageKeyList})
      ORDER BY
        "accountKey",
        ("dueAt" IS NULL),
        "dueAt",
        "createdAt" DESC,
        "taskId"
      LIMIT ${MAX_PAGE_TASK_ROWS + 1}
    `);
    detailRows = asRecordArray(detailsResult).map(parseDetailRow);
    if (detailRows.length > MAX_PAGE_TASK_ROWS) {
      throw new OutboundQueueDataLimitError(
        `This page contains more than ${MAX_PAGE_TASK_ROWS} open outbound tasks. Resolve duplicate/open-task buildup before retrying; the API did not return a partial account.`,
      );
    }
  }

  const detailsByAccount = new Map<string, DetailRow[]>();
  for (const row of detailRows) {
    const rows = detailsByAccount.get(row.accountKey) ?? [];
    rows.push(row);
    detailsByAccount.set(row.accountKey, rows);
  }
  const items = pageRows.map((pageAccount) =>
    accountFromRows({
      pageAccount,
      rows: detailsByAccount.get(pageAccount.accountKey) ?? [],
      snapshotAt: query.snapshotAt,
    }),
  );

  const total = asInteger(metadata["total"], "total");
  const nextOffset =
    query.offset + items.length < total ? query.offset + items.length : null;
  const fingerprint = outboundQueueFilterFingerprint({
    memberId: query.memberId,
    filters: query.filters,
  });
  const firstPageRow = pageRows[0] ?? null;
  const lastPageRow = pageRows.at(-1) ?? null;
  const nextCursor =
    nextOffset !== null && lastPageRow
      ? encodeOutboundQueueCursor({
          memberId: query.memberId,
          filterFingerprint: fingerprint,
          snapshotAt: query.snapshotAt.toISOString(),
          accountCreatedAt: lastPageRow.accountCreatedAt.toISOString(),
          accountKey: lastPageRow.accountKey,
          pageSize: query.limit,
          position: nextOffset,
        })
      : null;
  const previousCursor =
    query.offset > 0 && firstPageRow
      ? encodeOutboundQueueCursor({
          memberId: query.memberId,
          filterFingerprint: fingerprint,
          snapshotAt: query.snapshotAt.toISOString(),
          accountCreatedAt: firstPageRow.accountCreatedAt.toISOString(),
          accountKey: firstPageRow.accountKey,
          pageSize: query.limit,
          position: Math.max(query.offset - query.limit, 0),
        })
      : null;

  const scoreboardRows = asRecordArray(scoreboardResult);
  const scoreboard = scoreboardRows[0] ?? {};
  return {
    snapshotAt: query.snapshotAt.toISOString(),
    total,
    offset: query.offset,
    limit: query.limit,
    nextOffset,
    nextCursor,
    previousCursor,
    summary: {
      dueNow: asInteger(metadata["dueNow"], "dueNow"),
      overdue: asInteger(metadata["overdue"], "overdue"),
      callbacksToday: asInteger(metadata["callbacksToday"], "callbacksToday"),
      notStarted: asInteger(metadata["notStarted"], "notStarted"),
      scoreboard: {
        accountsTouched: asInteger(
          scoreboard["accountsTouched"] ?? 0,
          "accountsTouched",
        ),
        conversationsStarted: asInteger(
          scoreboard["conversationsStarted"] ?? 0,
          "conversationsStarted",
        ),
        qualifiedPartners: asInteger(
          scoreboard["qualifiedPartners"] ?? 0,
          "qualifiedPartners",
        ),
        activePartners: asInteger(
          scoreboard["activePartners"] ?? 0,
          "activePartners",
        ),
        avgFitScore: asNullableNumber(scoreboard["avgFitScore"]),
        partnerPathMix: {
          portalFirst: asInteger(scoreboard["portalFirst"] ?? 0, "portalFirst"),
          managedDirect: asInteger(
            scoreboard["managedDirect"] ?? 0,
            "managedDirect",
          ),
          hybrid: asInteger(scoreboard["hybrid"] ?? 0, "hybrid"),
          notAFit: asInteger(scoreboard["notAFit"] ?? 0, "notAFit"),
        },
      },
    },
    facets: { campaigns, dispositions, attempts },
    items,
  };
}
