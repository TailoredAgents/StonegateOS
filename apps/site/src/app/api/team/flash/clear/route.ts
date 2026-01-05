import { NextResponse } from "next/server";

function clearFlashCookies(response: NextResponse) {
  response.cookies.set({ name: "myst-flash", value: "", path: "/", maxAge: 0 });
  response.cookies.set({ name: "myst-flash-error", value: "", path: "/", maxAge: 0 });
  return response;
}

export async function POST(): Promise<Response> {
  return clearFlashCookies(NextResponse.json({ ok: true }));
}

export async function GET(): Promise<Response> {
  return POST();
}

