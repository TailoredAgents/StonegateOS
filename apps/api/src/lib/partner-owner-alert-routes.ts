import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import {
  readBoundedJsonRequest,
  BoundedJsonRequestError,
} from "@/lib/bounded-json-request";
import { permissionMatches, resolvePermissionContext } from "@/lib/permissions";
import {
  beginTeamMutation,
  TeamMutationFailure,
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  teamMutationIdempotencyReplayResponse,
  type TeamMutationIdempotencyClaim,
} from "@/lib/team-mutation-idempotency";
import {
  changeOwnerAlertSettings,
  markOwnerAlertOpened,
  ownerAlertSettingsDto,
  queueOwnerAlertTest,
} from "@/lib/partner-owner-alerts";

const headers = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
};
const settingsInput = z
  .object({
    enabled: z.boolean(),
    ownerTeamMemberId: z.string().uuid().nullable(),
  })
  .strict();
const emptyInput = z.object({}).strict();
export async function readOwnerAlertSettings(
  request: NextRequest,
): Promise<Response> {
  try {
    const context = await resolvePermissionContext(request);
    if (!context.authenticated)
      return NextResponse.json(
        { ok: false, error: "unauthorized" },
        { status: 401, headers },
      );
    if (
      context.source !== "team_session" ||
      !["partners.accounts.read", "appointments.read"].every((p) =>
        context.permissions.some((v) => permissionMatches(v, p)),
      )
    )
      return NextResponse.json(
        { ok: false, error: "forbidden" },
        { status: 403, headers },
      );
    const data = await ownerAlertSettingsDto(context.role === "owner");
    return NextResponse.json(data, {
      headers: { ...headers, ETag: `"${data.settings.revision}"` },
    });
  } catch (error) {
    console.error("[partner.owner_alerts] settings_read_failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { ok: false, error: "temporarily_unavailable" },
      { status: 503, headers },
    );
  }
}

export async function mutateOwnerAlerts(
  request: NextRequest,
  action: "settings" | "test" | "group_opened" | "request_opened",
  id?: string,
): Promise<Response> {
  const opened = action.endsWith("_opened");
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["partners.accounts.read", "appointments.read"],
    risk: action === "test" ? "external" : "normal",
    requiresIdempotency: !opened,
    auditAction: `partner_owner_alert.${action}`,
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;
  if (mutation.actor.role !== "owner")
    return teamMutationErrorResponse(
      "forbidden",
      "Only an owner can change owner alerts.",
      { correlationId: mutation.correlationId },
    );
  if (opened && !z.string().uuid().safeParse(id).success)
    return teamMutationErrorResponse(
      "invalid",
      "Choose a valid request or alert group.",
      { correlationId: mutation.correlationId },
    );
  if (
    !opened &&
    (!mutation.expectedVersion || mutation.expectedVersion === "*")
  )
    return teamMutationErrorResponse(
      "invalid",
      "Reload the latest alert settings before continuing.",
      { correlationId: mutation.correlationId },
    );
  let claim: TeamMutationIdempotencyClaim | null = null;
  const db = getDb();
  try {
    const raw = await readBoundedJsonRequest(request, {
      maximumBytes: 2048,
      deadlineMs: 10_000,
      rejectDuplicateObjectKeys: true,
    });
    const parsed = (
      action === "settings" ? settingsInput : emptyInput
    ).safeParse(raw);
    if (!parsed.success)
      throw new TeamMutationFailure(
        "invalid",
        "Review the alert settings and try again.",
      );
    if (opened) {
      const data = await db.transaction(async (tx) => {
        const result = await markOwnerAlertOpened(tx, {
          ownerId: mutation.actor.id!,
          ...(action === "group_opened"
            ? { groupId: id! }
            : { bookingId: id! }),
        });
        await mutation.audit.insertSuccess(tx, {
          entityType:
            action === "group_opened"
              ? "partner_owner_group"
              : "partner_booking",
          entityId: id!,
          after: { opened: result.opened },
        });
        return result;
      });
      return NextResponse.json({ ok: true, ...data }, { headers });
    }
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: `${request.method} /api/admin/partner-management/v1/owner-alerts/${action}`,
      entityType: "partner_owner_alert_settings",
      entityId: "owner",
      payload: parsed.data,
    });
    if (claimed.kind === "replay")
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    claim = claimed.claim;
    const result = await db.transaction(async (tx) => {
      const changed =
        action === "settings"
          ? await changeOwnerAlertSettings(tx, {
              ...settingsInput.parse(parsed.data),
              expectedVersion: mutation.expectedVersion!,
            })
          : null;
      const data = changed
        ? await ownerAlertSettingsDto(true, tx)
        : await queueOwnerAlertTest(
            tx,
            mutation.actor.id!,
            mutation.expectedVersion!,
          );
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "partner_owner_alert_settings",
        before: changed?.before ?? null,
        after: changed?.after ?? { testQueued: true },
      });
      const result = teamMutationSuccessResult(mutation, data, {
        ...audit,
        entityType: "partner_owner_alert_settings",
        entityId: "owner",
        version: String(changed?.after.revision ?? mutation.expectedVersion),
      });
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        result,
        200,
      );
      return result;
    });
    return teamMutationResultResponse(result, 200, mutation.correlationId, {
      ...headers,
      ETag: `"${result.receipt.version}"`,
    });
  } catch (error) {
    if (claim)
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch {
        console.error("[partner.owner_alerts] idempotency_settlement_failed", {
          correlationId: mutation.correlationId,
        });
      }
    return teamMutationExceptionResponse(
      error instanceof BoundedJsonRequestError
        ? new TeamMutationFailure("invalid", "The request body is invalid.", {
            status: error.status,
          })
        : error,
      mutation,
    );
  }
}
