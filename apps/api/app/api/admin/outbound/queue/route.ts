import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { isAdminRequest } from "../../../web/admin";
import { requirePermission } from "@/lib/permissions";
import {
  applyOutboundReminderDates,
  loadOutboundSelectedEnrichment,
} from "@/lib/outbound-queue-enrichment";
import {
  OutboundQueueDataLimitError,
  loadOutboundQueuePage,
  resolveOutboundSelectedTaskMemberId,
} from "@/lib/outbound-queue-query";
import {
  parseOutboundQueueRequest,
  parseOutboundQueueSelection,
} from "@/lib/outbound-queue-pagination";
import { getSalesScorecardConfig } from "@/lib/sales-scorecard";

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "outbound.read");
  if (permissionError) return permissionError;

  const db = getDb();
  const config = await getSalesScorecardConfig(db);
  const url = new URL(request.url);
  const selected = parseOutboundQueueSelection(url.searchParams);
  if (!selected.ok) {
    return NextResponse.json(
      {
        error: "invalid_outbound_queue_query",
        field: selected.field,
        message: selected.message,
      },
      { status: 400 },
    );
  }
  const selectedMemberId =
    !url.searchParams.has("memberId") && selected.selection.taskId
      ? await resolveOutboundSelectedTaskMemberId(db, {
          taskId: selected.selection.taskId,
          accountId: selected.selection.accountId,
        })
      : null;
  const parsed = parseOutboundQueueRequest({
    searchParams: url.searchParams,
    defaultMemberId: selectedMemberId ?? config.defaultAssigneeMemberId,
  });
  if (!parsed.ok) {
    const status = parsed.field === "memberId" ? 422 : 400;
    return NextResponse.json(
      {
        error:
          parsed.field === "memberId"
            ? "outbound_assignee_required"
            : "invalid_outbound_queue_query",
        field: parsed.field,
        message: parsed.message,
      },
      { status },
    );
  }

  try {
    const queue = await db.transaction(
      (tx) => loadOutboundQueuePage(tx, parsed.query),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    await applyOutboundReminderDates(db, queue.items);
    const enrichment = await loadOutboundSelectedEnrichment({
      db,
      items: queue.items,
      selectedAccountId: selected.selection.accountId ?? "",
      selectedTaskId: selected.selection.taskId ?? "",
    });

    return NextResponse.json({
      ok: true,
      memberId: parsed.query.memberId,
      timezone: "America/New_York",
      q: parsed.query.filters.q,
      snapshotAt: queue.snapshotAt,
      scope: {
        facets: "assignee_snapshot",
        summary: "filtered_account_snapshot",
        scoreboard: "assignee_campaign_snapshot",
      },
      total: queue.total,
      // Retained for rolling Site compatibility. The new query is exact and
      // never presents a partial scan as a complete queue.
      truncated: false,
      scanLimit: queue.total,
      offset: queue.offset,
      limit: queue.limit,
      nextOffset: queue.nextOffset,
      nextCursor: queue.nextCursor,
      previousCursor: queue.previousCursor,
      summary: queue.summary,
      facets: queue.facets,
      items: queue.items.map((item) => ({
        id: item.id,
        title: item.title,
        dueAt: item.dueAt,
        overdue: item.overdue,
        minutesUntilDue: item.minutesUntilDue,
        attempt: item.attempt,
        campaign: item.campaign,
        lastDisposition: item.lastDisposition,
        company: item.company,
        noteSnippet: item.noteSnippet,
        startedAt: item.startedAt,
        reminderAt: item.reminderAt,
        assignedToMemberId: item.assignedToMemberId,
        primaryTaskId: item.primaryTaskId,
        primaryTaskVersion: item.primaryTaskVersion,
        primaryContactId: item.primaryContactId,
        taskIds: item.taskIds,
        contactCount: item.contacts.length,
        dncContactCount: item.contacts.filter((contact) => contact.doNotContact)
          .length,
        openTaskCount: item.tasks.length,
        contacts: item.contacts,
        tasks: item.tasks,
        account: {
          id: item.id,
          name: item.name,
          status: item.status,
          segment: item.segment,
          portalFit: item.portalFit,
          fitScore: item.fitScore,
          lastTouchAt: item.lastTouchAt,
          nextTouchAt: item.nextTouchAt,
          brief: enrichment?.accountId === item.id ? enrichment.brief : null,
          history: enrichment?.accountId === item.id ? enrichment.history : [],
        },
      })),
    });
  } catch (error) {
    if (error instanceof OutboundQueueDataLimitError) {
      return NextResponse.json(
        {
          error: error.code,
          message: error.message,
          retryable: false,
        },
        { status: 409 },
      );
    }
    console.error("[outbound-queue] query_failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      {
        error: "outbound_queue_failed",
        message:
          "Outbound could not be loaded. No records or totals are being shown as complete.",
        retryable: true,
      },
      { status: 500 },
    );
  }
}
