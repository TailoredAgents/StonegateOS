import { NextResponse } from "next/server";
import {
  hasMobilePermission,
  resolveMobileSessionFromCookies,
} from "@/app/mobile/lib/session";
import { callAdminApi } from "@/app/team/lib/api";

type ProxyOptions = {
  permission: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
};

export async function proxyMobileAppointmentRequest(
  request: Request,
  apiPath: string,
  options: ProxyOptions,
): Promise<Response> {
  const session = await resolveMobileSessionFromCookies();
  if (!session) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }
  if (
    !hasMobilePermission(session.teamMember.permissions, options.permission)
  ) {
    return NextResponse.json(
      { ok: false, error: "forbidden" },
      { status: 403 },
    );
  }

  const method = options.method ?? "GET";
  const body =
    method === "GET" || method === "DELETE" ? undefined : await request.text();
  const upstream = await callAdminApi(apiPath, {
    method,
    ...(body ? { body } : {}),
    headers: {
      "x-actor-type": "human",
      "x-actor-id": session.teamMember.id,
      "x-actor-label": session.teamMember.name,
      ...(session.teamMember.roleSlug
        ? { "x-actor-role": session.teamMember.roleSlug }
        : {}),
    },
  });
  const responseBody = await upstream.arrayBuffer();
  const contentType =
    upstream.headers.get("content-type") ?? "application/json; charset=utf-8";

  return new Response(responseBody, {
    status: upstream.status,
    headers: {
      "content-type": contentType,
      "cache-control": "no-store",
    },
  });
}

export function encodeRouteId(value: string): string {
  return encodeURIComponent(value.trim());
}
