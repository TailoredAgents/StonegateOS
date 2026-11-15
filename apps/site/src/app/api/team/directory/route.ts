import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireTeamPrincipal } from "@/app/api/team/auth";
import { callAdminApiAs } from "@/app/team/lib/api";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const auth = await requireTeamPrincipal(request, {
    permissions: "appointments.read",
    returnJson: true,
  });
  if (!auth.ok) return auth.response;
  const headers = { "cache-control": "private, no-store" };
  try {
    const response = await callAdminApiAs(
      auth.principal,
      "/api/admin/team/directory",
      {
        timeoutMs: 10000,
      },
    );
    if (!response.ok) {
      return NextResponse.json(
        { ok: false },
        {
          status: response.status === 403 ? 403 : 502,
          headers,
        },
      );
    }
    const data: unknown = await response.json();
    if (
      !data ||
      typeof data !== "object" ||
      !("members" in data) ||
      !Array.isArray(data.members)
    ) {
      throw new Error("Invalid team directory");
    }
    const members = data.members.map((member: unknown) => {
      if (
        !member ||
        typeof member !== "object" ||
        !("id" in member) ||
        !("name" in member) ||
        typeof member.id !== "string" ||
        typeof member.name !== "string"
      ) {
        throw new Error("Invalid team member");
      }
      return { id: member.id, name: member.name };
    });
    return NextResponse.json({ ok: true, members }, { headers });
  } catch {
    return NextResponse.json({ ok: false }, { status: 502, headers });
  }
}
