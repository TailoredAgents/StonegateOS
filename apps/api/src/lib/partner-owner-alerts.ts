import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  getDb,
  auditLogs,
  outboxEvents,
  partnerOwnerAlertSettings,
  partnerOwnerAlertGroups,
  partnerOwnerAlertMembers,
  partnerOwnerRequestOpens,
  staffNotificationOperations,
  teamMembers,
  teamRoles,
} from "@/db";
import {
  computeEffectivePermissions,
  getDefaultPermissionsForRole,
  permissionMatches,
} from "@/lib/permissions";
import {
  TeamMutationFailure,
  assertTeamMutationExpectedVersion,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";
import { resolvePublicSiteBaseUrlOrThrow } from "@/lib/public-site-url";

export const OWNER_ALERT_EVALUATE_EVENT = "partner.owner_alert.evaluate";
export const OWNER_ALERT_REMINDER_EVENT = "partner.owner_alert.reminder";
export const OWNER_ALERT_REMINDER_MS = 30 * 60_000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PHONE = /^\+[1-9][0-9]{9,14}$/u;
type Tx = Pick<
  TeamMutationTransaction,
  "select" | "insert" | "update" | "execute"
>;
type Settings = typeof partnerOwnerAlertSettings.$inferSelect;
type Operation = typeof staffNotificationOperations.$inferSelect;
type Candidate = {
  id: string;
  accountId?: string;
  openedAt?: Date | null;
  accountName: string;
  serviceKey: string | null;
  requesterName?: string | null;
  serviceLabel?: string | null;
  scopeSnapshot: unknown;
};
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const text = (v: unknown, max = 160): string =>
  typeof v === "string"
    ? Array.from(v, (char) => {
        const code = char.codePointAt(0)!;
        return code < 32 || code === 127 ? " " : char;
      })
        .join("")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, max)
    : "";

export async function loadOwnerAlertSettings(tx: Tx = getDb()) {
  const [row] = await tx
    .select()
    .from(partnerOwnerAlertSettings)
    .where(eq(partnerOwnerAlertSettings.id, "owner"))
    .limit(1);
  if (!row) throw new Error("owner_alert_settings_missing");
  return row;
}
async function owners(tx: Tx) {
  const rows = await tx
    .select({
      id: teamMembers.id,
      name: teamMembers.name,
      phone: teamMembers.phoneE164,
      active: teamMembers.active,
      role: teamRoles.slug,
      permissions: teamRoles.permissions,
      grant: teamMembers.permissionsGrant,
      deny: teamMembers.permissionsDeny,
    })
    .from(teamMembers)
    .innerJoin(teamRoles, eq(teamRoles.id, teamMembers.roleId))
    .where(and(eq(teamRoles.slug, "owner"), eq(teamMembers.active, true)));
  return rows.map((row) => {
    const permissions = computeEffectivePermissions({
      rolePermissions:
        row.permissions ?? getDefaultPermissionsForRole(row.role),
      grant: row.grant,
      deny: row.deny,
    });
    const allowed = ["partners.accounts.read", "appointments.read"].every((p) =>
      permissions.some((grant) => permissionMatches(grant, p)),
    );
    return { ...row, ready: allowed && PHONE.test(row.phone ?? "") };
  });
}
async function recipient(tx: Tx, settings: Settings) {
  const owner = (await owners(tx)).find(
    (row) => row.id === settings.ownerTeamMemberId,
  );
  return owner?.ready && owner.phone === settings.phoneSnapshot ? owner : null;
}
export async function ownerAlertSettingsDto(
  canManage: boolean,
  tx: Tx = getDb(),
) {
  const settings = await loadOwnerAlertSettings(tx);
  const choices = await owners(tx);
  const owner = choices.find((row) => row.id === settings.ownerTeamMemberId);
  const problems = canManage
    ? await tx
        .select({
          id: staffNotificationOperations.id,
          kind: staffNotificationOperations.kind,
          state: staffNotificationOperations.state,
          detail: staffNotificationOperations.failureCode,
          createdAt: staffNotificationOperations.createdAt,
        })
        .from(staffNotificationOperations)
        .where(
          and(
            inArray(staffNotificationOperations.subjectType, [
              "partner_owner_group",
              "partner_owner_test",
            ]),
            or(
              inArray(staffNotificationOperations.state, [
                "failed",
                "reconciliation_required",
              ]),
              and(
                eq(staffNotificationOperations.state, "suppressed"),
                eq(
                  staffNotificationOperations.failureCode,
                  "owner_or_phone_changed",
                ),
              ),
            ),
          ),
        )
        .orderBy(desc(staffNotificationOperations.createdAt))
        .limit(10)
    : [];
  return {
    ok: true as const,
    settings: {
      enabled: settings.enabled,
      ownerTeamMemberId: settings.ownerTeamMemberId,
      ownerName: owner?.name ?? null,
      phoneLastFour: settings.phoneSnapshot?.slice(-4) ?? null,
      ready: Boolean(owner?.ready && owner.phone === settings.phoneSnapshot),
      revision: settings.revision,
      enabledSince: settings.enabledSince?.toISOString() ?? null,
    },
    canManage,
    owners: canManage
      ? choices.map((row) => ({
          id: row.id,
          name: row.name,
          phoneLastFour: row.phone?.slice(-4) ?? null,
          ready: row.ready,
        }))
      : [],
    deliveryProblems: problems.map((p) => ({
      ...p,
      createdAt: p.createdAt.toISOString(),
    })),
  };
}
export async function changeOwnerAlertSettings(
  tx: Tx,
  input: {
    enabled: boolean;
    ownerTeamMemberId: string | null;
    expectedVersion: string;
    now?: Date;
  },
) {
  const [current] = await tx
    .select()
    .from(partnerOwnerAlertSettings)
    .where(eq(partnerOwnerAlertSettings.id, "owner"))
    .for("update");
  if (!current) throw new Error("owner_alert_settings_missing");
  assertTeamMutationExpectedVersion(
    { expectedVersion: input.expectedVersion },
    current.revision,
  );
  const owner = (await owners(tx)).find(
    (row) => row.id === input.ownerTeamMemberId,
  );
  if (input.enabled && !owner?.ready)
    throw new TeamMutationFailure(
      "invalid",
      "Choose an active owner with a valid CRM SMS phone and request access.",
    );
  if (input.ownerTeamMemberId && !owner)
    throw new TeamMutationFailure("invalid", "Choose an active owner.");
  const phone = owner?.phone ?? null,
    now = input.now ?? new Date();
  const changed =
    current.enabled !== input.enabled ||
    current.ownerTeamMemberId !== input.ownerTeamMemberId ||
    current.phoneSnapshot !== phone;
  if (changed)
    await tx
      .update(partnerOwnerAlertSettings)
      .set({
        enabled: input.enabled,
        ownerTeamMemberId: input.ownerTeamMemberId,
        phoneSnapshot: phone,
        enabledSince: input.enabled ? now : null,
        revision: current.revision + 1,
        updatedAt: now,
      })
      .where(eq(partnerOwnerAlertSettings.id, "owner"));
  return {
    before: {
      enabled: current.enabled,
      ownerTeamMemberId: current.ownerTeamMemberId,
      revision: current.revision,
    },
    after: (await ownerAlertSettingsDto(true, tx)).settings,
  };
}

/** Transactional wake-up; bulk jobs are identified through the already bound draft. */
export async function enqueueOwnerAlertEvaluation(
  tx: Tx,
  input: {
    accountId: string;
    bookingId?: string;
    bulkImportId?: string;
    afterApproval?: boolean;
    now?: Date;
  },
) {
  let bulkImportId = input.bulkImportId ?? null;
  if (!bulkImportId && input.bookingId) {
    const rows = await tx.execute(
      sql`select r.partner_bulk_import_id as id from partner_bulk_import_rows r join partner_bookings b on b.booking_draft_id=r.booking_draft_id and b.partner_account_id=r.partner_account_id where b.id=${input.bookingId}::uuid and b.partner_account_id=${input.accountId}::uuid limit 1`,
    );
    bulkImportId = typeof rows[0]?.["id"] === "string" ? rows[0]["id"] : null;
  }
  await tx.insert(outboxEvents).values({
    type: OWNER_ALERT_EVALUATE_EVENT,
    payload: {
      accountId: input.accountId,
      bookingId: bulkImportId ? null : (input.bookingId ?? null),
      bulkImportId,
    },
    nextAttemptAt: new Date(
      (input.now ?? new Date()).getTime() +
        (input.afterApproval && bulkImportId ? 60_000 : 0),
    ),
  });
}
const actionable = sql`b.public_status IN ('requested','under_review') AND a.status='requested' AND a.start_at IS NULL AND NOT EXISTS (select 1 from partner_approval_requests ar where ar.partner_account_id=b.partner_account_id and ar.partner_booking_id=b.id and ar.state IN ('pending','declined','expired'))`;
/** A final company approval after activation is newly ready work, even for an older draft. */
async function readyJobs(
  tx: Tx,
  input: {
    accountId: string;
    ownerId: string;
    since: Date;
    bookingId?: string | null;
    bulkImportId?: string | null;
    groupId?: string;
    unopened?: boolean;
  },
): Promise<Candidate[]> {
  const rows = await tx.execute(
    sql`select b.id, b.partner_account_id as "accountId", opened.opened_at as "openedAt", c.name as "accountName", b.service_key as "serviceKey", sc.label as "serviceLabel", u.name as "requesterName", b.scope_snapshot as "scopeSnapshot" from partner_bookings b join appointments a on a.id=b.appointment_id and a.partner_account_id=b.partner_account_id join partner_accounts c on c.id=b.partner_account_id left join partner_account_memberships m on m.id=b.requested_by_membership_id and m.partner_account_id=b.partner_account_id left join partner_users u on u.id=m.partner_user_id left join partner_service_catalog sc on sc.key=b.service_key left join partner_owner_request_opens opened on opened.partner_booking_id=b.id and opened.partner_account_id=b.partner_account_id and opened.owner_team_member_id=${input.ownerId}::uuid where b.partner_account_id=${input.accountId}::uuid AND ${actionable} AND (b.created_at>=${input.since.toISOString()}::timestamptz OR exists(select 1 from partner_approval_requests ready_approval where ready_approval.partner_account_id=b.partner_account_id and ready_approval.partner_booking_id=b.id and ready_approval.state='approved_needs_reschedule' and ready_approval.updated_at>=${input.since.toISOString()}::timestamptz)) AND ${input.groupId ? sql`exists(select 1 from partner_owner_alert_members m where m.group_id=${input.groupId}::uuid and m.partner_booking_id=b.id and m.partner_account_id=b.partner_account_id ${input.unopened ? sql`and m.opened_at is null and opened.opened_at is null` : sql``})` : sql`not exists(select 1 from partner_owner_alert_members m where m.partner_booking_id=b.id and m.owner_team_member_id=${input.ownerId}::uuid)`} AND ${input.bulkImportId ? sql`exists(select 1 from partner_bulk_import_rows r where r.partner_account_id=b.partner_account_id and r.partner_bulk_import_id=${input.bulkImportId}::uuid and r.booking_draft_id=b.booking_draft_id)` : input.bookingId ? sql`b.id=${input.bookingId}::uuid` : sql`true`} order by b.created_at,b.id limit 501`,
  );
  return Array.from(rows).map((row) => ({
    ...row,
    openedAt: row["openedAt"]
      ? new Date(
          row["openedAt"] instanceof Date
            ? row["openedAt"].getTime()
            : typeof row["openedAt"] === "string"
              ? row["openedAt"]
              : NaN,
        )
      : null,
  })) as unknown as Candidate[];
}
export function ownerRequestSms(input: {
  jobs: Candidate[];
  groupId: string;
  reminder: boolean;
  bulk?: boolean;
  baseUrl: string;
}): string {
  const company = text(input.jobs[0]?.accountName, 100);
  const lines = [
    `${input.reminder ? "Reminder: " : "New "}Partner service request${input.jobs.length === 1 ? "" : "s"}: ${company} (${input.jobs.length}).`,
  ];
  for (const job of input.jobs.slice(0, 3)) {
    const snapshot = record(job.scopeSnapshot),
      location = record(snapshot["locationSnapshot"]),
      address = record(location["address"]);
    const windows = Array.isArray(snapshot["preferredWindows"])
      ? snapshot["preferredWindows"].map(record)
      : [];
    const window = windows[0] ?? {};
    lines.push(`Who: ${text(job.requesterName, 80) || company}`);
    lines.push(
      `What: ${text(snapshot["serviceLabel"] ?? job.serviceLabel ?? job.serviceKey, 80) || "Service request"}: ${text(snapshot["description"], 120) || "Details in request"}`,
    );
    lines.push(
      `When: ${window["localDate"] ? `${text(window["localDate"], 20)} ${text(window["timeOfDay"], 20)} ${text(window["timezone"] ?? location["timezone"], 45)}` : "Timing to be arranged"}. Awaiting Stonegate confirmation.`,
    );
    lines.push(
      `Where: ${
        [address["line1"], address["city"], address["state"]]
          .map((v) => text(v, 85))
          .filter(Boolean)
          .join(", ") || "Location in request"
      }`,
    );
  }
  if (input.jobs.length > 3)
    lines.push(`Plus ${input.jobs.length - 3} more requests.`);
  const url = new URL("/team/partners", input.baseUrl);
  url.searchParams.set("p_admin", "requests");
  url.searchParams.set("p_alert", input.groupId);
  const only =
    input.jobs.length === 1 && !input.bulk ? input.jobs[0] : undefined;
  if (only?.accountId && UUID.test(only.accountId) && UUID.test(only.id)) {
    url.searchParams.set("p_request", `service:${only.id}`);
    url.searchParams.set("p_company", only.accountId);
  }
  return `${lines.join("\n").slice(0, 1200)}\nReview: ${url.toString()}`;
}
export async function queueOwnerSubjectSms(
  tx: Tx,
  input: {
    subjectType: "partner_owner_group" | "partner_owner_test";
    subjectId: string;
    ownerId: string;
    phone: string;
    kind:
      | "partner_request_initial"
      | "partner_request_reminder"
      | "partner_request_test";
    body: string;
    now: Date;
  },
) {
  const [created] = await tx
    .insert(staffNotificationOperations)
    .values({
      appointmentId: null,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      recipientTeamMemberId: input.ownerId,
      recipientAddress: input.phone,
      kind: input.kind,
      channel: "sms",
      body: input.body,
      state: "requested",
      providerRequestKey: `owner:${input.subjectId}:${input.kind}:${input.ownerId}`,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ id: staffNotificationOperations.id });
  if (created) {
    await tx.insert(outboxEvents).values({
      type: "staff_notification.dispatch",
      payload: { operationId: created.id },
      createdAt: input.now,
    });
    await tx.insert(auditLogs).values({
      actorType: "worker",
      actorRole: "owner-alert-coordinator",
      actorLabel: "owner-alert-coordinator",
      authMethod: "service",
      outcome: "succeeded",
      action: "partner_owner_alert.queued",
      entityType: input.subjectType,
      entityId: input.subjectId,
      meta: {
        operationId: created.id,
        kind: input.kind,
        recipientTeamMemberId: input.ownerId,
      },
      createdAt: input.now,
    });
  }
  return created?.id ?? null;
}
export async function evaluateOwnerAlert(payload: unknown, now = new Date()) {
  const p = record(payload),
    accountId = p["accountId"],
    bookingId = p["bookingId"],
    bulkImportId = p["bulkImportId"];
  if (
    typeof accountId !== "string" ||
    !UUID.test(accountId) ||
    (bookingId != null &&
      (typeof bookingId !== "string" || !UUID.test(bookingId))) ||
    (bulkImportId != null &&
      (typeof bulkImportId !== "string" || !UUID.test(bulkImportId))) ||
    Boolean(bookingId) === Boolean(bulkImportId)
  )
    throw new Error("owner_alert_payload_invalid");
  return getDb().transaction(async (tx) => {
    const settings = await loadOwnerAlertSettings(tx);
    if (
      !settings.enabled ||
      !settings.enabledSince ||
      !settings.ownerTeamMemberId
    )
      return;
    const owner = await recipient(tx, settings);
    if (!owner?.phone) return;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`owner-alert:${accountId}:${bulkImportId ?? bookingId}:${owner.id}`},0))`,
    );
    if (bulkImportId) {
      const rows = await tx.execute(
        sql`select id from partner_bulk_imports where id=${bulkImportId}::uuid and partner_account_id=${accountId}::uuid and dry_run=false and completed_at is not null and state in ('completed','failed') and not exists(select 1 from partner_bulk_import_rows r where r.partner_bulk_import_id=${bulkImportId}::uuid and r.state in ('pending','processing'))`,
      );
      if (!rows.length) return;
    }
    const jobs = await readyJobs(tx, {
      accountId,
      ownerId: owner.id,
      since: settings.enabledSince,
      bookingId: bookingId as string | null,
      bulkImportId: bulkImportId as string | null,
    });
    if (!jobs.length) return;
    if (jobs.length > 500) throw new Error("owner_alert_group_too_large");
    const groupId = randomUUID();
    await tx.insert(partnerOwnerAlertGroups).values({
      id: groupId,
      partnerAccountId: accountId,
      bulkImportId: bulkImportId as string | null,
      ownerTeamMemberId: owner.id,
      settingsRevision: settings.revision,
      memberCount: jobs.length,
      openedAt: jobs.every((job) => job.openedAt) ? now : null,
      createdAt: now,
    });
    await tx.insert(partnerOwnerAlertMembers).values(
      jobs.map((job) => ({
        groupId,
        partnerAccountId: accountId,
        partnerBookingId: job.id,
        ownerTeamMemberId: owner.id,
        openedAt: job.openedAt ?? null,
      })),
    );
    await queueOwnerSubjectSms(tx, {
      subjectType: "partner_owner_group",
      subjectId: groupId,
      ownerId: owner.id,
      phone: owner.phone,
      kind: "partner_request_initial",
      body: ownerRequestSms({
        jobs,
        groupId,
        reminder: false,
        bulk: Boolean(bulkImportId),
        baseUrl: resolvePublicSiteBaseUrlOrThrow(),
      }),
      now,
    });
  });
}

/** Runs inside the delivery claim transaction; unknown or revoked routing fails closed. */
export async function ownerAlertDispatchGuard(
  tx: Tx,
  operation: Operation,
  now: Date,
): Promise<{ allowed: boolean; reason?: string; body?: string }> {
  const settings = await loadOwnerAlertSettings(tx);
  const owner = await recipient(tx, settings);
  if (
    !owner ||
    owner.id !== operation.recipientTeamMemberId ||
    owner.phone !== operation.recipientAddress
  )
    return { allowed: false, reason: "owner_or_phone_changed" };
  if (operation.subjectType === "partner_owner_test") return { allowed: true };
  if (!settings.enabled || !settings.enabledSince)
    return { allowed: false, reason: "alerts_disabled" };
  const [group] = await tx
    .select()
    .from(partnerOwnerAlertGroups)
    .where(eq(partnerOwnerAlertGroups.id, operation.subjectId!))
    .for("update");
  if (
    !group ||
    group.ownerTeamMemberId !== owner.id ||
    group.settingsRevision !== settings.revision
  )
    return { allowed: false, reason: "alert_settings_changed" };
  const reminder = operation.kind === "partner_request_reminder";
  if (
    reminder &&
    (group.openedAt ||
      !group.initialAcceptedAt ||
      !group.reminderDueAt ||
      group.reminderDueAt > now)
  )
    return { allowed: false, reason: "reminder_not_needed" };
  const jobs = await readyJobs(tx, {
    accountId: group.partnerAccountId,
    ownerId: owner.id,
    since: settings.enabledSince,
    groupId: group.id,
    unopened: reminder,
  });
  if (!jobs.length)
    return { allowed: false, reason: "request_no_longer_needs_attention" };
  return {
    allowed: true,
    body: ownerRequestSms({
      jobs,
      groupId: group.id,
      reminder,
      bulk: Boolean(group.bulkImportId),
      baseUrl: resolvePublicSiteBaseUrlOrThrow(),
    }),
  };
}
/** Receipt and delayed reminder are committed together. Uncertain sends never enter here. */
export async function ownerAlertInitialAccepted(
  tx: Tx,
  operation: Operation,
  now: Date,
) {
  if (
    operation.subjectType !== "partner_owner_group" ||
    operation.kind !== "partner_request_initial" ||
    !operation.subjectId
  )
    return;
  const due = new Date(now.getTime() + OWNER_ALERT_REMINDER_MS);
  const rows = await tx
    .update(partnerOwnerAlertGroups)
    .set({ initialAcceptedAt: now, reminderDueAt: due })
    .where(
      and(
        eq(partnerOwnerAlertGroups.id, operation.subjectId),
        sql`${partnerOwnerAlertGroups.initialAcceptedAt} is null`,
      ),
    )
    .returning({ id: partnerOwnerAlertGroups.id });
  if (rows.length)
    await tx.insert(outboxEvents).values({
      type: OWNER_ALERT_REMINDER_EVENT,
      payload: { groupId: operation.subjectId },
      nextAttemptAt: due,
      createdAt: now,
    });
}
export async function processOwnerAlertReminder(
  payload: unknown,
  now = new Date(),
) {
  const groupId = record(payload)["groupId"];
  if (typeof groupId !== "string" || !UUID.test(groupId))
    throw new Error("owner_alert_group_invalid");
  await getDb().transaction(async (tx) => {
    const [group] = await tx
      .select()
      .from(partnerOwnerAlertGroups)
      .where(eq(partnerOwnerAlertGroups.id, groupId))
      .for("update");
    if (
      !group ||
      group.openedAt ||
      !group.initialAcceptedAt ||
      !group.reminderDueAt ||
      group.reminderDueAt > now
    )
      return;
    const settings = await loadOwnerAlertSettings(tx),
      owner = await recipient(tx, settings);
    if (
      !settings.enabled ||
      !settings.enabledSince ||
      !owner?.phone ||
      group.ownerTeamMemberId !== owner.id ||
      group.settingsRevision !== settings.revision
    )
      return;
    const jobs = await readyJobs(tx, {
      accountId: group.partnerAccountId,
      ownerId: owner.id,
      since: settings.enabledSince,
      groupId,
      unopened: true,
    });
    if (!jobs.length) return;
    await queueOwnerSubjectSms(tx, {
      subjectType: "partner_owner_group",
      subjectId: groupId,
      ownerId: owner.id,
      phone: owner.phone,
      kind: "partner_request_reminder",
      body: ownerRequestSms({
        jobs,
        groupId,
        reminder: true,
        bulk: Boolean(group.bulkImportId),
        baseUrl: resolvePublicSiteBaseUrlOrThrow(),
      }),
      now,
    });
  });
}
export async function markOwnerAlertOpened(
  tx: Tx,
  input: { ownerId: string; groupId?: string; bookingId?: string; now?: Date },
) {
  const settings = await loadOwnerAlertSettings(tx);
  const owner = (await owners(tx)).find(
    (candidate) =>
      candidate.id === settings.ownerTeamMemberId &&
      candidate.id === input.ownerId,
  );
  if (!owner?.ready)
    throw new TeamMutationFailure(
      "forbidden",
      "Only the configured owner can mark this alert opened.",
    );
  const now = input.now ?? new Date();
  const members = await tx
    .select()
    .from(partnerOwnerAlertMembers)
    .where(
      and(
        eq(partnerOwnerAlertMembers.ownerTeamMemberId, owner.id),
        input.groupId
          ? eq(partnerOwnerAlertMembers.groupId, input.groupId)
          : eq(partnerOwnerAlertMembers.partnerBookingId, input.bookingId!),
      ),
    );
  let openedJobs: Array<{ partnerAccountId: string; partnerBookingId: string }>;
  if (input.groupId) {
    if (!members.length)
      throw new TeamMutationFailure(
        "invalid",
        "This alert group is not available.",
        { status: 404 },
      );
    openedJobs = members;
  } else {
    const rows = await tx.execute(
      sql`select id,partner_account_id from partner_bookings where id=${input.bookingId}::uuid AND partner_account_id IS NOT NULL`,
    );
    if (!rows[0])
      throw new TeamMutationFailure(
        "invalid",
        "This service request is not available.",
        { status: 404 },
      );
    openedJobs = [
      {
        partnerAccountId: String(rows[0]["partner_account_id"]),
        partnerBookingId: input.bookingId!,
      },
    ];
  }
  await tx
    .insert(partnerOwnerRequestOpens)
    .values(
      openedJobs.map((job) => ({
        ...job,
        ownerTeamMemberId: owner.id,
        openedAt: now,
      })),
    )
    .onConflictDoNothing();
  if (members.length) {
    const groupId = members[0]!.groupId;
    await tx
      .select({ id: partnerOwnerAlertGroups.id })
      .from(partnerOwnerAlertGroups)
      .where(eq(partnerOwnerAlertGroups.id, groupId))
      .for("update");
    await tx
      .update(partnerOwnerAlertMembers)
      .set({
        openedAt: sql`coalesce(${partnerOwnerAlertMembers.openedAt},${now.toISOString()}::timestamptz)`,
      })
      .where(
        and(
          eq(partnerOwnerAlertMembers.groupId, groupId),
          input.bookingId
            ? eq(partnerOwnerAlertMembers.partnerBookingId, input.bookingId)
            : undefined,
        ),
      );
    await tx
      .update(partnerOwnerAlertGroups)
      .set({
        openedAt: sql`coalesce(${partnerOwnerAlertGroups.openedAt},${now.toISOString()}::timestamptz)`,
      })
      .where(
        and(
          eq(partnerOwnerAlertGroups.id, groupId),
          sql`not exists(select 1 from partner_owner_alert_members m where m.group_id=${groupId}::uuid and m.opened_at is null and not exists(select 1 from partner_owner_request_opens o where o.partner_booking_id=m.partner_booking_id and o.owner_team_member_id=m.owner_team_member_id))`,
        ),
      );
  }
  return { opened: true };
}
export async function queueOwnerAlertTest(
  tx: Tx,
  ownerId: string,
  expectedVersion: string,
  now = new Date(),
) {
  const settings = await loadOwnerAlertSettings(tx);
  assertTeamMutationExpectedVersion({ expectedVersion }, settings.revision);
  const owner = await recipient(tx, settings);
  if (!owner || owner.id !== ownerId || !owner.phone)
    throw new TeamMutationFailure(
      "forbidden",
      "Save this owner and CRM phone before sending the test.",
    );
  const subjectId = randomUUID();
  const operationId = await queueOwnerSubjectSms(tx, {
    subjectType: "partner_owner_test",
    subjectId,
    ownerId,
    phone: owner.phone,
    kind: "partner_request_test",
    body: "TEST — Stonegate Partner request alerts. This is a test message only; no service request was created or confirmed.",
    now,
  });
  return { operationId, state: "queued" as const };
}
