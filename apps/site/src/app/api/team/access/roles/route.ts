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

const ROLE_CREATE_FORM_KEYS = new Set([
  "idempotencyKey",
  "name",
  "permissions",
  "slug",
]);
const ROLE_SLUG_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function buildRedirect(request: NextRequest): URL {
  return getSafeRedirectUrl(request, "/team/admin/access#roles");
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

export async function POST(request: NextRequest): Promise<Response> {
  if (!isSameOriginAccessFormRequest(request)) {
    return NextResponse.json(
      {
        ok: false,
        code: "forbidden",
        message: "The role creation origin could not be verified.",
        retryable: false,
      },
      { status: 403 },
    );
  }
  const auth = await requireTeamPrincipal(request, {
    permissions: "access.manage",
    redirectTo: new URL("/team/admin/access#roles", request.url),
  });
  if (!auth.ok) return auth.response;

  const redirectTo = buildRedirect(request);
  const form = await readBoundedAccessForm(request, ROLE_CREATE_FORM_KEYS);
  if (!form) {
    const response = NextResponse.redirect(redirectTo, 303);
    setFlash(
      response,
      "error",
      "The role form was invalid, too large, or timed out. Review it and try again.",
    );
    return response;
  }
  const name =
    singleAccessFormValue(form, "name")?.normalize("NFKC").trim() ?? "";
  const slug =
    singleAccessFormValue(form, "slug")
      ?.normalize("NFKC")
      .trim()
      .toLowerCase() ?? "";
  const idempotencyKey =
    singleAccessFormValue(form, "idempotencyKey")?.normalize("NFKC").trim() ??
    "";
  const permissionInputs = form.getAll("permissions");

  if (!name || name.length > 120) {
    const response = NextResponse.redirect(redirectTo, 303);
    setFlash(response, "error", "Enter a valid role name");
    return response;
  }
  if (!ROLE_SLUG_PATTERN.test(slug)) {
    const response = NextResponse.redirect(redirectTo, 303);
    setFlash(response, "error", "Enter a valid unique role slug");
    return response;
  }
  if (!isAccessIdempotencyKey(idempotencyKey)) {
    const response = NextResponse.redirect(redirectTo, 303);
    setFlash(
      response,
      "error",
      "This role creation cannot be retried safely. Refresh before saving.",
    );
    return response;
  }

  const permissions = permissionInputs.map((entry) => entry.trim());
  if (
    permissions.length > 100 ||
    new Set(permissions).size !== permissions.length ||
    permissions.some(
      (permission, index) =>
        permission !== permissionInputs[index] ||
        !isAssignableTeamPermission(permission),
    )
  ) {
    const response = NextResponse.redirect(redirectTo, 303);
    setFlash(response, "error", "One or more permissions are not supported");
    return response;
  }

  let apiResponse: Response;
  try {
    apiResponse = await callAdminMutationWithSafeReplay(
      auth.principal,
      "/api/admin/roles",
      {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ name, slug, permissions }),
      },
    );
  } catch {
    const response = NextResponse.redirect(redirectTo, 303);
    setFlash(
      response,
      "error",
      "Role creation could not be confirmed. Your input was not reported as saved; refresh before retrying.",
    );
    return response;
  }

  if (!apiResponse.ok) {
    const response = NextResponse.redirect(redirectTo, 303);
    setFlash(
      response,
      "error",
      await readTeamMutationError(apiResponse, "Unable to create role"),
    );
    return response;
  }

  const result = await readTeamMutationSuccess<{
    role?: {
      id?: unknown;
      name?: unknown;
      slug?: unknown;
      permissions?: unknown;
      updatedAt?: unknown;
    };
  }>(apiResponse);
  const role = result?.data.role;
  const returnedPermissions = Array.isArray(role?.permissions)
    ? role.permissions.filter(
        (permission): permission is string => typeof permission === "string",
      )
    : null;
  const returnedPermissionCount = Array.isArray(role?.permissions)
    ? role.permissions.length
    : null;
  const expectedPermissions = [...permissions].sort();
  if (
    !result ||
    !role ||
    typeof role.id !== "string" ||
    !UUID_PATTERN.test(role.id) ||
    role.name !== name ||
    role.slug !== slug ||
    !returnedPermissions ||
    returnedPermissions.length !== returnedPermissionCount ||
    returnedPermissions.length !== expectedPermissions.length ||
    [...returnedPermissions]
      .sort()
      .some((permission, index) => permission !== expectedPermissions[index]) ||
    typeof role.updatedAt !== "string" ||
    result.receipt.actorId !== auth.principal.memberId ||
    result.receipt.entityType !== "team_role" ||
    result.receipt.entityId !== role.id ||
    result.receipt.version !== role.updatedAt
  ) {
    const response = NextResponse.redirect(redirectTo, 303);
    setFlash(
      response,
      "error",
      "The Access service returned an unreadable role receipt, so no success is being claimed. Refresh before retrying.",
    );
    return response;
  }

  const response = NextResponse.redirect(redirectTo, 303);
  setFlash(response, "ok", "Role created");
  return response;
}
