import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApiAs } from "@/app/team/lib/api";
import { requireTeamPrincipal } from "../../auth";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await requireTeamPrincipal(request, {
    permissions: "sales.write",
    returnJson: true,
  });
  if (!auth.ok) return auth.response;

  const payload = (await request.json().catch(() => null)) as {
    contactId?: string;
    disposition?: string;
  } | null;
  const contactId =
    typeof payload?.contactId === "string" ? payload.contactId.trim() : "";
  const disposition =
    typeof payload?.disposition === "string" ? payload.disposition.trim() : "";
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!contactId) {
    return NextResponse.json(
      { ok: false, message: "Missing contact id." },
      { status: 400 },
    );
  }
  if (!disposition) {
    return NextResponse.json(
      { ok: false, message: "Missing disposition." },
      { status: 400 },
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u.test(idempotencyKey)) {
    return NextResponse.json(
      {
        ok: false,
        code: "invalid",
        message: "The disposition request key is missing or invalid.",
        retryable: false,
      },
      { status: 422 },
    );
  }

  const response = await callAdminApiAs(
    auth.principal,
    "/api/admin/sales/disposition",
    {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ contactId, disposition }),
    },
  );

  const responseBody = (await response.json().catch(() => null)) as unknown;
  if (!responseBody || typeof responseBody !== "object") {
    return NextResponse.json(
      {
        ok: false,
        code: "internal",
        message: response.ok
          ? "The disposition service returned an unreadable success receipt."
          : "Unable to update disposition.",
        retryable: true,
      },
      { status: response.ok ? 502 : response.status },
    );
  }

  return NextResponse.json(responseBody, {
    status: response.status,
    headers: {
      ...(response.headers.get("x-correlation-id")
        ? {
            "x-correlation-id": response.headers.get("x-correlation-id") ?? "",
          }
        : {}),
      ...(response.headers.get("idempotency-replayed")
        ? { "idempotency-replayed": "true" }
        : {}),
    },
  });
}
