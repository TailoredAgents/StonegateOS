import { requireTeamPrincipal } from "@/app/api/team/auth";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

function clearFlashCookies(response: NextResponse) {
  response.cookies.set({ name: "myst-flash", value: "", path: "/", maxAge: 0 });
  response.cookies.set({
    name: "myst-flash-error",
    value: "",
    path: "/",
    maxAge: 0,
  });
  return response;
}

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await requireTeamPrincipal(request, { returnJson: true });
  if (!auth.ok) return auth.response;

  return clearFlashCookies(NextResponse.json({ ok: true }));
}

export async function GET(request: NextRequest): Promise<Response> {
  return POST(request);
}
