import { sql, type SQL } from "drizzle-orm";
import {
  PARTNER_REQUEST_KINDS,
  PARTNER_REQUEST_STAGES,
  type PartnerRequestKind,
  type PartnerRequestStage,
  type PartnerRequestInboxItem,
  type PartnerRequestInboxCounts,
  type PartnerRequestInboxResponse,
} from "@myst-os/sdk";
import { getDb } from "@/db";
import { permissionMatches, type PermissionContext } from "./permissions";
import {
  encodePortalV2Cursor,
  parsePortalV2Pagination,
} from "./portal-v2-contract";
import { readPartnerJobLocationSnapshot } from "./partner-job-location";
import { listPartnerManagementResource } from "./partner-management-directory";
import type { PartnerManagementResource } from "./partner-management-list";

export const INBOX_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const READ: Record<PartnerRequestKind, string[]> = {
  service: ["partners.accounts.read", "appointments.read"],
  reschedule: ["partners.accounts.read", "appointments.read"],
  cancellation: ["partners.cancellation_requests.read"],
  change: ["partners.change_requests.read"],
  billing: ["partners.billing_disputes.read"],
  address: ["partners.accounts.read"],
};
const WRITE: Record<PartnerRequestKind, string> = {
  service: "appointments.update",
  reschedule: "appointments.update",
  cancellation: "partners.cancellation_requests.decide",
  change: "partners.change_requests.decide",
  billing: "partners.billing_disputes.decide",
  address: "partners.accounts.manage",
};
const VIEWS: Record<PartnerRequestKind, string> = {
  service: "requests",
  reschedule: "operations",
  cancellation: "cancellation-requests",
  change: "change-requests",
  billing: "billing-disputes",
  address: "location-reviews",
};
export function partnerInboxCanRead(
  context: PermissionContext,
  kind: PartnerRequestKind,
): boolean {
  return (
    context.authenticated &&
    READ[kind].every((permission) =>
      context.permissions.some((grant) => permissionMatches(grant, permission)),
    )
  );
}
export function partnerInboxCanAct(
  context: PermissionContext,
  kind: PartnerRequestKind,
): boolean {
  return (
    partnerInboxCanRead(context, kind) &&
    context.permissions.some((grant) => permissionMatches(grant, WRITE[kind]))
  );
}
export class PartnerRequestInboxError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
type RawRow = {
  id: string;
  kind: PartnerRequestKind;
  account_id: string;
  account_name: string;
  job_id: string | null;
  service: string;
  description: string;
  scope: unknown;
  preferred_windows: unknown;
  requester_name: string;
  created_at: string | Date;
  state: string;
  stage: PartnerRequestStage;
  group_id?: string | null;
  opened_at?: string | Date | null;
  can_acknowledge?: boolean;
};
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown, max = 2000): string =>
  typeof value === "string" ? value.slice(0, max) : "";
const iso = (value: string | Date): string => new Date(value).toISOString();

export function partnerInboxItem(
  row: RawRow,
  context: PermissionContext,
): PartnerRequestInboxItem {
  const scope = obj(row.scope),
    location = readPartnerJobLocationSnapshot(scope);
  const preferredWindows = Array.isArray(row.preferred_windows)
    ? row.preferred_windows.slice(0, 3).flatMap((value) => {
        const window = obj(value),
          localDate = text(window["localDate"], 10);
        return /^\d{4}-\d{2}-\d{2}$/u.test(localDate)
          ? [
              {
                localDate,
                timeOfDay: text(window["timeOfDay"], 30),
                timezone:
                  text(window["timezone"], 80) ||
                  location?.timezone ||
                  "America/New_York",
              },
            ]
          : [];
      })
    : [];
  const key = `${row.kind}:${row.id}`;
  const params = new URLSearchParams({
    p_admin: "requests",
    p_request: key,
    p_company: row.account_id,
  });
  return {
    id: row.id,
    key,
    kind: row.kind,
    accountId: row.account_id,
    accountName: row.account_name,
    jobId: row.job_id,
    service: row.service,
    description: text(row.description),
    siteName: location?.name || "",
    address: location
      ? [
          location.address.line1,
          location.address.line2,
          location.address.city,
          location.address.state,
          location.address.postalCode,
        ]
          .filter(Boolean)
          .join(", ")
      : "",
    requesterName: text(row.requester_name, 200),
    preferredWindows,
    receivedAt: iso(row.created_at),
    state: row.state,
    stage: row.stage,
    statusLabel:
      row.stage === "waiting_on_client"
        ? "Waiting on client"
        : row.stage === "needs_attention"
          ? "Needs attention"
          : row.state.replaceAll("_", " "),
    detailHref: `/team/partners?${params}`,
    canAct:
      row.stage === "needs_attention" && partnerInboxCanAct(context, row.kind),
    alertGroupId: row.group_id ?? null,
    canAcknowledge:
      row.kind === "service" &&
      context.source === "team_session" &&
      context.role === "owner" &&
      row.can_acknowledge === true,
    isNew:
      row.stage === "needs_attention" &&
      row.kind === "service" &&
      !row.opened_at &&
      row.can_acknowledge === true,
  };
}

/** Each branch joins both account and resource identity. No customer secrets or financial amounts leave this reader. */
function sourceSql(context: PermissionContext): SQL {
  const branches: SQL[] = [];
  if (partnerInboxCanRead(context, "service"))
    branches.push(sql`
    select b.id,'service'::text kind,b.partner_account_id account_id,a.name account_name,b.id job_id,
      coalesce(nullif(b.scope_snapshot->>'serviceLabel',''),sc.label,replace(b.service_key,'_',' '),'Service request') service,
      coalesce(b.scope_snapshot->>'description','') description,b.scope_snapshot scope,
      coalesce(b.scope_snapshot->'preferredWindows','[]'::jsonb) preferred_windows,
      coalesce(u.name,'') requester_name,b.created_at,b.public_status state,
      case when ap.status <> 'requested' or ap.start_at is not null or b.public_status in ('canceled','declined','completed') then 'handled'
        when b.model_version=2 and b.quoted_total_cents is null then 'needs_attention'
        when b.public_status='approval_needed' or exists(select 1 from partner_approval_requests ar where ar.partner_account_id=b.partner_account_id and ar.partner_booking_id=b.id and ar.state='pending') then 'waiting_on_client'
        when b.model_version=2 and exists(select 1 from partner_booking_service_lines line where line.partner_account_id=b.partner_account_id and line.partner_booking_id=b.id and line.status not in ('completed','canceled') and not exists(select 1 from partner_booking_visit_lines covered join partner_booking_visits visit on visit.id=covered.visit_id and visit.partner_account_id=covered.partner_account_id and visit.partner_booking_id=covered.partner_booking_id where covered.partner_account_id=b.partner_account_id and covered.partner_booking_id=b.id and covered.service_line_id=line.id and visit.status in ('scheduled','in_progress'))) then 'needs_attention'
        when b.public_status in ('requested','requested_review','under_review','partially_scheduled') and not exists(select 1 from partner_approval_requests ar where ar.partner_account_id=b.partner_account_id and ar.partner_booking_id=b.id and ar.state in ('declined','expired')) then 'needs_attention'
        else 'handled' end stage
    from partner_bookings b join partner_accounts a on a.id=b.partner_account_id
    left join appointments ap on ap.id=b.appointment_id and ap.partner_account_id=b.partner_account_id
    left join partner_service_catalog sc on sc.key=b.service_key
    left join partner_account_memberships m on m.id=b.requested_by_membership_id and m.partner_account_id=b.partner_account_id
    left join partner_users u on u.id=m.partner_user_id
  `);
  for (const [kind, table, member, description, states, preferred] of [
    [
      "reschedule",
      "partner_reschedule_requests",
      "created_by_membership_id",
      "'Schedule change request'",
      "('pending')",
      "r.preferred_windows",
    ],
    [
      "cancellation",
      "partner_cancellation_requests",
      "requested_by_membership_id",
      "r.reason",
      "('pending')",
      "b.scope_snapshot->'preferredWindows'",
    ],
    [
      "change",
      "partner_job_change_requests",
      "requested_by_membership_id",
      "r.reason",
      "('pending')",
      "b.scope_snapshot->'preferredWindows'",
    ],
    [
      "billing",
      "partner_billing_dispute_requests",
      "requested_by_membership_id",
      "r.reason",
      "('pending')",
      "b.scope_snapshot->'preferredWindows'",
    ],
  ] as const) {
    if (!partnerInboxCanRead(context, kind)) continue;
    // All identifiers here come from this fixed, compile-time list, never request input.
    branches.push(sql`
      select r.id,${kind}::text kind,r.partner_account_id account_id,a.name account_name,r.partner_booking_id job_id,
        coalesce(sc.label,replace(b.service_key,'_',' '),${kind === "billing" ? "Billing question" : "Service request"}) service,
        ${sql.raw(description)} description,coalesce(b.scope_snapshot,'{}'::jsonb) scope,
        coalesce(${sql.raw(preferred)},'[]'::jsonb) preferred_windows,coalesce(u.name,'') requester_name,r.created_at,r.state,
        case when r.state in ${sql.raw(states)} then 'needs_attention' else 'handled' end stage
      from ${sql.raw(table)} r join partner_accounts a on a.id=r.partner_account_id
      ${sql.raw(kind === "billing" ? "left" : "inner")} join partner_bookings b on b.id=r.partner_booking_id and b.partner_account_id=r.partner_account_id
      left join partner_service_catalog sc on sc.key=b.service_key
      left join partner_account_memberships m on m.id=${sql.raw(`r.${member}`)} and m.partner_account_id=r.partner_account_id
      left join partner_users u on u.id=m.partner_user_id
    `);
  }
  if (partnerInboxCanRead(context, "address"))
    branches.push(sql`
    select r.id,'address'::text kind,r.partner_account_id account_id,a.name account_name,null::uuid job_id,
      'Address review'::text service,replace(r.reason_code,'_',' ') description,
      jsonb_build_object('locationSnapshot',jsonb_build_object('id',l.id,'name',l.site_name,'timezone',l.timezone,'address',jsonb_build_object('line1',l.address_line1,'line2',l.address_line2,'city',l.city,'state',l.state,'postalCode',l.postal_code))) scope,
      '[]'::jsonb preferred_windows,coalesce(u.name,'') requester_name,r.created_at,r.state,
      case when r.state='pending' then 'needs_attention' when r.state='correction_required' then 'waiting_on_client' else 'handled' end stage
    from partner_location_address_reviews r join partner_accounts a on a.id=r.partner_account_id
    join partner_account_locations l on l.id=r.location_id and l.partner_account_id=r.partner_account_id
    left join partner_account_memberships m on m.id=r.requested_by_membership_id and m.partner_account_id=r.partner_account_id
    left join partner_users u on u.id=m.partner_user_id
  `);
  if (!branches.length) throw new PartnerRequestInboxError(403, "forbidden");
  return sql.join(branches, sql` union all `);
}

type InboxCursor = {
  createdAt: string;
  id: string;
  kind: PartnerRequestKind;
  filters: string;
};
export function parsePartnerInboxQuery(params: URLSearchParams) {
  const keys = new Set([
    "accountId",
    "q",
    "status",
    "kind",
    "alertGroupId",
    "limit",
    "cursor",
  ]);
  for (const key of params.keys())
    if (!keys.has(key) || params.getAll(key).length !== 1)
      throw new PartnerRequestInboxError(422, "invalid_fields");
  const accountId = params.get("accountId") || "",
    q = (params.get("q") || "").trim(),
    status = params.get("status") || "needs_attention",
    kind = params.get("kind") || "",
    alertGroupId = params.get("alertGroupId") || "";
  if (
    (accountId && !INBOX_UUID.test(accountId)) ||
    (alertGroupId && !INBOX_UUID.test(alertGroupId)) ||
    q.length > 100 ||
    !PARTNER_REQUEST_STAGES.includes(status as PartnerRequestStage) ||
    (kind && !PARTNER_REQUEST_KINDS.includes(kind as PartnerRequestKind))
  )
    throw new PartnerRequestInboxError(422, "invalid_fields");
  const filters = JSON.stringify([accountId, q, status, kind, alertGroupId]);
  const pagination = parsePortalV2Pagination(params, {
    cursorKind: "staff_partner_request_inbox",
    allowedQueryKeys: new Set([
      "accountId",
      "q",
      "status",
      "kind",
      "alertGroupId",
    ]),
    validateCursorPayload(value: unknown): value is InboxCursor {
      const c = obj(value);
      return (
        c["filters"] === filters &&
        typeof c["id"] === "string" &&
        INBOX_UUID.test(c["id"]) &&
        PARTNER_REQUEST_KINDS.includes(c["kind"] as PartnerRequestKind) &&
        typeof c["createdAt"] === "string" &&
        Number.isFinite(Date.parse(c["createdAt"]))
      );
    },
  });
  if (!pagination.ok) throw new PartnerRequestInboxError(422, "invalid_cursor");
  return {
    accountId,
    q,
    status: status as PartnerRequestStage,
    kind: kind as PartnerRequestKind | "",
    alertGroupId,
    filters,
    pagination,
  };
}

function scopeFilter(query: ReturnType<typeof parsePartnerInboxQuery>): SQL {
  return sql`true ${query.accountId ? sql`and s.account_id=${query.accountId}::uuid` : sql``}
    ${query.q ? sql`and s.account_name ilike ${"%" + query.q.replace(/[\\%_]/gu, "\\$&") + "%"}` : sql``}
    ${query.alertGroupId ? sql`and s.kind='service' and exists(select 1 from partner_owner_alert_members gm where gm.group_id=${query.alertGroupId}::uuid and gm.partner_booking_id=s.job_id and gm.partner_account_id=s.account_id)` : sql``}`;
}
function alertJoin(context: PermissionContext): SQL {
  return sql`left join partner_owner_alert_members am on s.kind='service' and am.partner_booking_id=s.job_id and am.partner_account_id=s.account_id and am.owner_team_member_id=${context.principalId}::uuid and am.stage=(select case when b.model_version=2 and b.quoted_total_cents is null then 'pricing_review' else 'ready_to_schedule' end from partner_bookings b where b.id=s.job_id) left join partner_owner_request_opens ro on s.kind='service' and ro.partner_booking_id=s.job_id and ro.partner_account_id=s.account_id and ro.owner_team_member_id=${context.principalId}::uuid and ro.stage=(select case when b.model_version=2 and b.quoted_total_cents is null then 'pricing_review' else 'ready_to_schedule' end from partner_bookings b where b.id=s.job_id)`;
}
function blankCounts(): PartnerRequestInboxCounts {
  return {
    needsAttention: 0,
    waitingOnClient: 0,
    handled: 0,
    byKind: {
      service: 0,
      reschedule: 0,
      cancellation: 0,
      change: 0,
      billing: 0,
      address: 0,
    },
    byCompany: {},
  };
}
export async function listPartnerRequestInbox(
  params: URLSearchParams,
  context: PermissionContext,
): Promise<PartnerRequestInboxResponse> {
  const query = parsePartnerInboxQuery(params),
    source = sourceSql(context);
  if (query.kind && !partnerInboxCanRead(context, query.kind))
    throw new PartnerRequestInboxError(403, "forbidden");
  if (query.alertGroupId && !partnerInboxCanRead(context, "service"))
    throw new PartnerRequestInboxError(403, "forbidden");
  const db = getDb();
  // A repeatable read makes the badge and the page describe the same snapshot.
  return db.transaction(
    async (tx) => {
      let group: PartnerRequestInboxResponse["group"] = null;
      if (query.alertGroupId) {
        const groups = await tx.execute(
          sql`select g.id,g.partner_account_id,g.bulk_import_id,g.owner_team_member_id,g.created_at,g.opened_at,count(m.partner_booking_id)::int member_count from partner_owner_alert_groups g join partner_owner_alert_members m on m.group_id=g.id and m.partner_account_id=g.partner_account_id where g.id=${query.alertGroupId}::uuid ${query.accountId ? sql`and g.partner_account_id=${query.accountId}::uuid` : sql``} group by g.id`,
        );
        const g = groups[0];
        if (!g) throw new PartnerRequestInboxError(404, "not_found");
        group = {
          id: String(g["id"]),
          accountId: String(g["partner_account_id"]),
          bulkImportId:
            typeof g["bulk_import_id"] === "string"
              ? g["bulk_import_id"]
              : null,
          createdAt: iso(g["created_at"] as string),
          openedAt: g["opened_at"] ? iso(g["opened_at"] as string) : null,
          memberCount: Number(g["member_count"]),
          canAcknowledge: g["owner_team_member_id"] === context.principalId,
        };
      }
      const cursor = query.pagination.cursor?.payload;
      const rows =
        await tx.execute(sql`with source as (${source}) select s.*,am.group_id,coalesce(ro.opened_at,am.opened_at) opened_at,exists(select 1 from partner_owner_alert_settings os where os.owner_team_member_id=${context.principalId}::uuid) can_acknowledge from source s ${alertJoin(context)} where ${scopeFilter(query)} ${query.alertGroupId ? sql`` : sql`and s.stage=${query.status}`}
      ${query.kind ? sql`and s.kind=${query.kind}` : sql``}
      ${cursor ? sql`and (s.created_at,s.kind,s.id)<(${cursor.createdAt}::timestamptz,${cursor.kind},${cursor.id}::uuid)` : sql``}
      order by s.created_at desc,s.kind desc,s.id desc limit ${query.pagination.limit + 1}`);
      const totals = await tx.execute(
        sql`with source as (${source}) select s.stage,s.kind,s.account_id,count(*)::int total from source s where ${scopeFilter(query)} group by s.stage,s.kind,s.account_id`,
      );
      const counts = blankCounts();
      for (const item of totals) {
        const stage = item["stage"] as PartnerRequestStage,
          kind = item["kind"] as PartnerRequestKind,
          n = Number(item["total"]),
          account = String(item["account_id"]);
        if (!query.kind || query.kind === kind) {
          counts[
            stage === "needs_attention"
              ? "needsAttention"
              : stage === "waiting_on_client"
                ? "waitingOnClient"
                : "handled"
          ] += n;
          if (stage === "needs_attention")
            counts.byCompany[account] = (counts.byCompany[account] ?? 0) + n;
        }
        if (stage === "needs_attention") counts.byKind[kind] += n;
      }
      const page = rows
          .slice(0, query.pagination.limit)
          .map((row) => partnerInboxItem(row as unknown as RawRow, context)),
        last = page.at(-1);
      return {
        ok: true,
        requests: page,
        counts,
        group,
        generatedAt: new Date().toISOString(),
        page: {
          nextCursor:
            rows.length > query.pagination.limit && last
              ? encodePortalV2Cursor({
                  kind: "staff_partner_request_inbox",
                  limit: query.pagination.limit,
                  payload: {
                    createdAt: last.receivedAt,
                    id: last.id,
                    kind: last.kind,
                    filters: query.filters,
                  },
                })
              : null,
        },
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export async function getPartnerRequestInboxItem(
  kind: PartnerRequestKind,
  id: string,
  accountId: string,
  context: PermissionContext,
) {
  if (!INBOX_UUID.test(id) || (accountId && !INBOX_UUID.test(accountId)))
    throw new PartnerRequestInboxError(404, "not_found");
  if (!partnerInboxCanRead(context, kind))
    throw new PartnerRequestInboxError(403, "forbidden");
  const rows = await getDb().execute(
    sql`with source as (${sourceSql(context)}) select s.*,am.group_id,coalesce(ro.opened_at,am.opened_at) opened_at,exists(select 1 from partner_owner_alert_settings os where os.owner_team_member_id=${context.principalId}::uuid) can_acknowledge from source s ${alertJoin(context)} where s.id=${id}::uuid ${accountId ? sql`and s.account_id=${accountId}::uuid` : sql``} and s.kind=${kind} limit 1`,
  );
  if (!rows[0]) throw new PartnerRequestInboxError(404, "not_found");
  let record: Record<string, unknown> | null = null;
  if (!["service", "reschedule"].includes(kind)) {
    const data = await listPartnerManagementResource(
      VIEWS[kind] as PartnerManagementResource,
      {
        resource: VIEWS[kind] as PartnerManagementResource,
        accountId: String(rows[0]["account_id"]),
        id,
        cursor: null,
        filterHash: "",
        limit: 1,
        q: null,
        status: null,
        userId: null,
      },
    );
    record = data.items[0] ?? null;
  }
  return {
    ok: true as const,
    request: partnerInboxItem(rows[0] as unknown as RawRow, context),
    record,
  };
}
