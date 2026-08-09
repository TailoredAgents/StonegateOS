import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isAssignableTeamPermission } from "@myst-os/sdk";
import { requireTeamPrincipal } from "@/app/api/team/auth";
import { getSafeRedirectUrl } from "@/app/api/team/redirects";
import {
  isAccessIdempotencyKey,
  isSameOriginAccessFormRequest,
  readBoundedAccessForm,
  singleAccessFormValue,
} from "@/app/team/access-form-boundary";
import { callAdminMutationWithSafeReplay } from "@/app/team/lib/team-mutation-transport";
import {
  readTeamMutationError,
  readTeamMutationSuccess,
} from "@/app/team/lib/mutation-feedback";

export const dynamic = "force-dynamic";

const MEMBER_UPDATE_FORM_KEYS = new Set([
  "active",
  "defaultCrewSplitPercent",
  "email",
  "expectedUpdatedAt",
  "idempotencyKey",
  "memberId",
  "name",
  "permissionsDeny",
  "permissionsDeny_present",
  "permissionsGrant",
  "permissionsGrant_present",
  "phone",
  "roleId",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function buildRedirect(request: NextRequest): URL {
  return getSafeRedirectUrl(request, "/team/admin/access#members");
}

function setFlash(
  response: NextResponse,
  kind: "ok" | "error",
  message: string,
) {
  response.cookies.set({
    name: kind === "ok" ? "myst-flash" : "myst-flash-error",
    value: message,
    path: "/",
  });
}

function readFormPermissions(
  form: URLSearchParams,
  key: string,
): { ok: true; permissions: string[] } | { ok: false } {
  const raw = form.getAll(key);
  const permissions = raw.map((value) => value.trim());
  if (
    permissions.length > 100 ||
    new Set(permissions).size !== permissions.length ||
    permissions.some(
      (permission, index) =>
        permission !== raw[index] || !isAssignableTeamPermission(permission),
    )
  ) {
    return { ok: false };
  }
  return { ok: true, permissions: [...permissions].sort() };
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ memberId: string }> },
): Promise<Response> {
  if (!isSameOriginAccessFormRequest(request)) {
    return NextResponse.json(
      {
        ok: false,
        code: "forbidden",
        message: "The member update origin could not be verified.",
        retryable: false,
      },
      { status: 403 },
    );
  }
  const auth = await requireTeamPrincipal(request, {
    permissions: "access.manage",
    redirectTo: new URL("/team/admin/access#members", request.url),
  });
  if (!auth.ok) return auth.response;

  const redirectTo = buildRedirect(request);
  const { memberId } = await context.params;
  if (!UUID_PATTERN.test(memberId)) {
    const response = NextResponse.redirect(redirectTo, 303);
    setFlash(response, "error", "Member ID missing");
    return response;
  }

  const form = await readBoundedAccessForm(request, MEMBER_UPDATE_FORM_KEYS);
  if (!form) {
    const response = NextResponse.redirect(redirectTo, 303);
    setFlash(
      response,
      "error",
      "The member form was invalid, too large, or timed out. Review it and try again.",
    );
    return response;
  }
  const submittedMemberId = singleAccessFormValue(form, "memberId")?.trim();
  const name = singleAccessFormValue(form, "name")?.normalize("NFKC").trim() ?? "";
  const email = singleAccessFormValue(form, "email")?.trim().toLowerCase() ?? "";
  const roleId = singleAccessFormValue(form, "roleId")?.trim() ?? "";
  const phone = singleAccessFormValue(form, "phone")?.trim() ?? "";
  const expectedUpdatedAt =
    singleAccessFormValue(form, "expectedUpdatedAt")?.trim() ?? "";
  const idempotencyKey =
    singleAccessFormValue(form, "idempotencyKey")
      ?.normalize("NFKC")
      .trim() ?? "";
  const activeValues = form.getAll("active");
  const active = activeValues[0] === "on";
  const defaultCrewSplitPercent =
    singleAccessFormValue(form, "defaultCrewSplitPercent")?.trim() ?? "";

  if (
    submittedMemberId !== memberId ||
    activeValues.length > 1 ||
    (activeValues.length === 1 && activeValues[0] !== "on")
  ) {
    const response = NextResponse.redirect(redirectTo, 303);
    setFlash(response, "error", "The member form target is invalid");
    return response;
  }

  const grantPresent =
    singleAccessFormValue(form, "permissionsGrant_present") === "1";
  const denyPresent =
    singleAccessFormValue(form, "permissionsDeny_present") === "1";

  const permissionsGrant = grantPresent
    ? readFormPermissions(form, "permissionsGrant")
    : null;

  const permissionsDeny = denyPresent
    ? readFormPermissions(form, "permissionsDeny")
    : null;

  if (!name || name.length > 120) {
    const response = NextResponse.redirect(redirectTo, 303);
    setFlash(response, "error", "Name is required");
    return response;
  }
  if (roleId && !UUID_PATTERN.test(roleId)) {
    const response = NextResponse.redirect(redirectTo, 303);
    setFlash(response, "error", "Choose a valid role");
    return response;
  }
  const parsedUpdatedAt = new Date(expectedUpdatedAt);
  if (
    expectedUpdatedAt.length > 40 ||
    Number.isNaN(parsedUpdatedAt.getTime()) ||
    parsedUpdatedAt.toISOString() !== expectedUpdatedAt
  ) {
    const response = NextResponse.redirect(redirectTo, 303);
    setFlash(response, "error", "This member version is invalid. Refresh first.");
    return response;
  }
  if (!isAccessIdempotencyKey(idempotencyKey)) {
    const response = NextResponse.redirect(redirectTo, 303);
    setFlash(
      response,
      "error",
      "This member update cannot be retried safely. Refresh before saving.",
    );
    return response;
  }
  if (permissionsGrant && !permissionsGrant.ok) {
    const response = NextResponse.redirect(redirectTo, 303);
    setFlash(
      response,
      "error",
      "One or more permission grants are not supported",
    );
    return response;
  }
  if (permissionsDeny && !permissionsDeny.ok) {
    const response = NextResponse.redirect(redirectTo, 303);
    setFlash(
      response,
      "error",
      "One or more permission denies are not supported",
    );
    return response;
  }

  const payload: Record<string, unknown> = {
    expectedUpdatedAt,
    name,
    active,
  };

  payload["email"] = email.length > 0 ? email : null;
  payload["roleId"] = roleId.length > 0 ? roleId : null;
  payload["phone"] = phone.length > 0 ? phone : null;
  if (permissionsGrant !== null) {
    payload["permissionsGrant"] = permissionsGrant.permissions;
  }
  if (permissionsDeny !== null) {
    payload["permissionsDeny"] = permissionsDeny.permissions;
  }

  if (defaultCrewSplitPercent.length === 0) {
    payload["defaultCrewSplitBps"] = null;
  } else {
    const parsed = Number(defaultCrewSplitPercent);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
      const response = NextResponse.redirect(redirectTo, 303);
      setFlash(response, "error", "Crew split % must be between 0 and 100");
      return response;
    }
    payload["defaultCrewSplitBps"] = Math.round(parsed * 100);
  }

  let apiResponse: Response;
  try {
    apiResponse = await callAdminMutationWithSafeReplay(
      auth.principal,
      `/api/admin/team/members/${encodeURIComponent(memberId)}`,
      {
        method: "PATCH",
        headers: {
          "Idempotency-Key": idempotencyKey,
          "If-Match": expectedUpdatedAt,
        },
        body: JSON.stringify(payload),
      },
    );
  } catch {
    const response = NextResponse.redirect(redirectTo, 303);
    setFlash(
      response,
      "error",
      "Member update could not be confirmed. Your input was not reported as saved; refresh before retrying.",
    );
    return response;
  }

  if (!apiResponse.ok) {
    const response = NextResponse.redirect(redirectTo, 303);
    setFlash(
      response,
      "error",
      await readTeamMutationError(apiResponse, "Unable to update member"),
    );
    return response;
  }

  const result = await readTeamMutationSuccess<{
    member?: {
      id?: unknown;
      name?: unknown;
      email?: unknown;
      roleId?: unknown;
      active?: unknown;
      updatedAt?: unknown;
    };
    revokedSessionCount?: unknown;
  }>(apiResponse);
  const member = result?.data.member;
  if (
    !result ||
    !member ||
    member.id !== memberId ||
    member.name !== name ||
    member.email !== (email || null) ||
    member.roleId !== (roleId || null) ||
    member.active !== active ||
    typeof member.updatedAt !== "string" ||
    !Number.isSafeInteger(result.data.revokedSessionCount) ||
    result.receipt.actorId !== auth.principal.memberId ||
    result.receipt.entityType !== "team_member" ||
    result.receipt.entityId !== memberId ||
    result.receipt.version !== member.updatedAt
  ) {
    const response = NextResponse.redirect(redirectTo, 303);
    setFlash(
      response,
      "error",
      "The Access service returned an unreadable member receipt, so no success is being claimed. Refresh before retrying.",
    );
    return response;
  }

  const response = NextResponse.redirect(redirectTo, 303);
  setFlash(response, "ok", "Member updated");
  return response;
}
