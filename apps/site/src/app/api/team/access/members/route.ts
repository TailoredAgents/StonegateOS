import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
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

const MEMBER_CREATE_FORM_KEYS = new Set([
  "active",
  "email",
  "idempotencyKey",
  "name",
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

export async function POST(request: NextRequest): Promise<Response> {
  if (!isSameOriginAccessFormRequest(request)) {
    return NextResponse.json(
      {
        ok: false,
        code: "forbidden",
        message: "The member creation origin could not be verified.",
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
  const form = await readBoundedAccessForm(request, MEMBER_CREATE_FORM_KEYS);
  if (!form) {
    const response = NextResponse.redirect(redirectTo, 303);
    setFlash(
      response,
      "error",
      "The member form was invalid, too large, or timed out. Review it and try again.",
    );
    return response;
  }
  const name = singleAccessFormValue(form, "name")?.normalize("NFKC").trim() ?? "";
  const email = singleAccessFormValue(form, "email")?.trim().toLowerCase() ?? "";
  const phone = singleAccessFormValue(form, "phone")?.trim() ?? "";
  const roleId = singleAccessFormValue(form, "roleId")?.trim() ?? "";
  const idempotencyKey =
    singleAccessFormValue(form, "idempotencyKey")
      ?.normalize("NFKC")
      .trim() ?? "";
  const activeValues = form.getAll("active");
  if (
    activeValues.length > 1 ||
    (activeValues.length === 1 && activeValues[0] !== "on")
  ) {
    const response = NextResponse.redirect(redirectTo, 303);
    setFlash(response, "error", "Choose a valid activation state");
    return response;
  }
  const active = activeValues[0] === "on";

  if (!name || name.length > 120) {
    const response = NextResponse.redirect(redirectTo, 303);
    setFlash(response, "error", "Enter a valid member name");
    return response;
  }
  if (roleId && !UUID_PATTERN.test(roleId)) {
    const response = NextResponse.redirect(redirectTo, 303);
    setFlash(response, "error", "Choose a valid role");
    return response;
  }
  if (!isAccessIdempotencyKey(idempotencyKey)) {
    const response = NextResponse.redirect(redirectTo, 303);
    setFlash(
      response,
      "error",
      "This member creation cannot be retried safely. Refresh before saving.",
    );
    return response;
  }

  const payload = {
    name,
    email: email || null,
    phone: phone || null,
    roleId: roleId || null,
    active,
  };

  let apiResponse: Response;
  try {
    apiResponse = await callAdminMutationWithSafeReplay(
      auth.principal,
      "/api/admin/team/members",
      {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(payload),
      },
    );
  } catch {
    const response = NextResponse.redirect(redirectTo, 303);
    setFlash(
      response,
      "error",
      "Member creation could not be confirmed. Your input was not reported as saved; refresh before retrying.",
    );
    return response;
  }

  if (!apiResponse.ok) {
    const response = NextResponse.redirect(redirectTo, 303);
    setFlash(
      response,
      "error",
      await readTeamMutationError(apiResponse, "Unable to create member"),
    );
    return response;
  }

  const result = await readTeamMutationSuccess<{
    member?: {
      id?: unknown;
      name?: unknown;
      email?: unknown;
      phone?: unknown;
      roleId?: unknown;
      active?: unknown;
      updatedAt?: unknown;
    };
  }>(apiResponse);
  const member = result?.data.member;
  if (
    !result ||
    !member ||
    typeof member.id !== "string" ||
    !UUID_PATTERN.test(member.id) ||
    member.name !== name ||
    member.email !== payload.email ||
    member.roleId !== payload.roleId ||
    member.active !== active ||
    typeof member.updatedAt !== "string" ||
    result.receipt.actorId !== auth.principal.memberId ||
    result.receipt.entityType !== "team_member" ||
    result.receipt.entityId !== member.id ||
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
  setFlash(response, "ok", "Team member added");
  return response;
}
