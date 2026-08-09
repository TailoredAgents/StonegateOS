import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  isAssignableTeamPermission,
  TEAM_OWNER_ONLY_PERMISSION_CATALOG,
  type MutationResult,
} from "@myst-os/sdk";
import { requireTeamPrincipal } from "@/app/api/team/auth";
import { getSafeRedirectUrl } from "@/app/api/team/redirects";
import {
  parseAccessRoleUpdateMutationResult,
  readBoundedAccessRoleMutationPayload,
  type AccessRoleUpdateMutationResult,
} from "@/app/team/access-role-page";
import { callAdminApiAs } from "@/app/team/lib/api";

export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ROLE_SLUG_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u;
const URL_ENCODED_CONTENT_TYPE_PATTERN =
  /^application\/x-www-form-urlencoded(?:\s*;|$)/u;
const MAXIMUM_FORM_BYTES = 32 * 1024;
const FORM_DEADLINE_MS = 5_000;
const MAXIMUM_UPSTREAM_ATTEMPTS = 2;
const ALLOWED_FORM_KEYS = new Set([
  "expectedUpdatedAt",
  "idempotencyKey",
  "name",
  "permissions",
  "slug",
]);

function setFlash(
  response: NextResponse,
  kind: "ok" | "error",
  message: string,
): void {
  response.cookies.set({
    name: kind === "ok" ? "myst-flash" : "myst-flash-error",
    value: message,
    path: "/",
  });
}

function redirectWithFlash(
  request: NextRequest,
  kind: "ok" | "error",
  message: string,
): NextResponse {
  const response = NextResponse.redirect(
    getSafeRedirectUrl(request, "/team/admin/access#roles"),
    303,
  );
  setFlash(response, kind, message);
  return response;
}

function exactInstant(value: string): string | null {
  if (value.length > 40) return null;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
    ? value
    : null;
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function singleValue(form: URLSearchParams, key: string): string | null {
  const values = form.getAll(key);
  return values.length === 1 ? (values[0] ?? null) : null;
}

function isSameOriginRoleUpdateRequest(request: NextRequest): boolean {
  const rawOrigin = request.headers.get("origin")?.trim() ?? "";
  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (!rawOrigin || rawOrigin === "null") return false;
  if (fetchSite && fetchSite !== "same-origin") return false;
  try {
    const origin = new URL(rawOrigin);
    const target = new URL(request.url);
    return (
      !origin.username &&
      !origin.password &&
      origin.pathname === "/" &&
      !origin.search &&
      !origin.hash &&
      (origin.protocol === "http:" || origin.protocol === "https:") &&
      origin.origin.toLowerCase() === target.origin.toLowerCase()
    );
  } catch {
    return false;
  }
}

async function readBoundedRoleForm(
  request: NextRequest,
): Promise<URLSearchParams | null> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!URL_ENCODED_CONTENT_TYPE_PATTERN.test(contentType)) return null;
  const contentEncoding =
    request.headers.get("content-encoding")?.trim().toLowerCase() ?? "";
  if (contentEncoding && contentEncoding !== "identity") return null;
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d{1,10}$/u.test(declaredLength) ||
      Number(declaredLength) > MAXIMUM_FORM_BYTES)
  ) {
    return null;
  }
  if (!request.body) return null;

  const reader = request.body.getReader();
  const deadlineAt = Date.now() + FORM_DEADLINE_MS;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) return null;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        reader.read(),
        new Promise<"timeout">((resolve) => {
          timeout = setTimeout(() => resolve("timeout"), remaining);
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
      if (next === "timeout") return null;
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAXIMUM_FORM_BYTES) return null;
      chunks.push(next.value);
    }
  } catch {
    return null;
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return new URLSearchParams(text);
  } catch {
    return null;
  }
}

function errorMessage(
  result: Extract<AccessRoleUpdateMutationResult, { ok: false }>,
): string {
  const firstFieldError = result.fieldErrors
    ? Object.values(result.fieldErrors)[0]
    : null;
  return firstFieldError
    ? `${result.message} ${firstFieldError}`
    : result.message;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ roleId: string }> },
): Promise<Response> {
  if (!isSameOriginRoleUpdateRequest(request)) {
    return NextResponse.json(
      {
        ok: false,
        code: "forbidden",
        message:
          "The role update origin could not be verified. Nothing was changed.",
        retryable: false,
      } satisfies MutationResult<never>,
      {
        status: 403,
        headers: { "Cache-Control": "private, no-store, max-age=0" },
      },
    );
  }
  const auth = await requireTeamPrincipal(request, {
    permissions: "access.manage",
    redirectTo: new URL("/team/admin/access#roles", request.url),
  });
  if (!auth.ok) return auth.response;

  const { roleId } = await context.params;
  if (!UUID_PATTERN.test(roleId)) {
    return redirectWithFlash(
      request,
      "error",
      "Choose a valid role to update.",
    );
  }

  const form = await readBoundedRoleForm(request);
  if (!form) {
    return redirectWithFlash(
      request,
      "error",
      "The role form was invalid, too large, or timed out. Refresh and try again.",
    );
  }
  const receivedFormKeys = new Set(Array.from(form.keys()));
  if (Array.from(receivedFormKeys).some((key) => !ALLOWED_FORM_KEYS.has(key))) {
    return redirectWithFlash(
      request,
      "error",
      "The role form contains unsupported fields. Refresh and try again.",
    );
  }

  const rawName = singleValue(form, "name");
  const rawSlug = singleValue(form, "slug");
  const rawExpectedUpdatedAt = singleValue(form, "expectedUpdatedAt");
  const rawIdempotencyKey = singleValue(form, "idempotencyKey");
  const name = rawName?.normalize("NFKC").trim() ?? "";
  const slug = rawSlug?.normalize("NFKC").trim().toLowerCase() ?? "";
  const expectedUpdatedAt = exactInstant(
    rawExpectedUpdatedAt?.normalize("NFKC").trim() ?? "",
  );
  const idempotencyKey = rawIdempotencyKey?.normalize("NFKC").trim() ?? "";
  if (
    rawName === null ||
    !name ||
    name.length > 120 ||
    containsControlCharacter(name)
  ) {
    return redirectWithFlash(request, "error", "Enter a valid role name.");
  }
  if (rawSlug === null || !ROLE_SLUG_PATTERN.test(slug)) {
    return redirectWithFlash(
      request,
      "error",
      "Use a 2–64 character role slug that starts with a letter.",
    );
  }
  if (!expectedUpdatedAt) {
    return redirectWithFlash(
      request,
      "error",
      "This role version is invalid. Refresh before saving.",
    );
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return redirectWithFlash(
      request,
      "error",
      "This role update cannot be retried safely. Refresh before saving.",
    );
  }

  const rawPermissions = form.getAll("permissions");
  if (
    rawPermissions.length > 100 ||
    new Set(rawPermissions).size !== rawPermissions.length ||
    rawPermissions.some(
      (permission) =>
        permission !== permission.trim() ||
        !isAssignableTeamPermission(permission),
    )
  ) {
    return redirectWithFlash(
      request,
      "error",
      "One or more role permissions are duplicated or unsupported.",
    );
  }
  const permissions = [...rawPermissions].sort();
  const expectedPermissions =
    slug === "owner"
      ? [
          ...new Set([...permissions, ...TEAM_OWNER_ONLY_PERMISSION_CATALOG]),
        ].sort()
      : permissions;
  const body = JSON.stringify({
    expectedUpdatedAt,
    name,
    permissions,
    slug,
  });
  const headers = {
    "Idempotency-Key": idempotencyKey,
    "If-Match": expectedUpdatedAt,
  } as const;

  let parsed: AccessRoleUpdateMutationResult | null = null;
  for (let attempt = 0; attempt < MAXIMUM_UPSTREAM_ATTEMPTS; attempt += 1) {
    try {
      const apiResponse = await callAdminApiAs(
        auth.principal,
        `/api/admin/roles/${encodeURIComponent(roleId)}`,
        { method: "PATCH", headers, body },
      );
      const payload = await readBoundedAccessRoleMutationPayload(apiResponse);
      const candidate = parseAccessRoleUpdateMutationResult(
        payload,
        apiResponse.headers,
        {
          id: roleId,
          name,
          slug,
          permissions: expectedPermissions,
          expectedUpdatedAt,
          actorId: auth.principal.memberId,
        },
      );
      if (!candidate || candidate.ok !== apiResponse.ok) {
        continue;
      }
      parsed = candidate;
      break;
    } catch {
      // An acknowledgement can be lost after the API commits. The one bounded
      // replay below uses the exact same key, version, actor, and body.
    }
  }

  if (!parsed) {
    return redirectWithFlash(
      request,
      "error",
      "The role service returned no valid, correlated mutation receipt. The update was not confirmed. Refresh before deciding whether to retry.",
    );
  }
  if (!parsed.ok) {
    return redirectWithFlash(request, "error", errorMessage(parsed));
  }

  return redirectWithFlash(
    request,
    "ok",
    parsed.data.revokedSessionCount > 0
      ? `Role updated. ${parsed.data.revokedSessionCount.toLocaleString("en-US")} active session${parsed.data.revokedSessionCount === 1 ? " was" : "s were"} revoked.`
      : "Role updated. No active sessions required revocation.",
  );
}
