import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const API_BASE_URL =
  process.env["API_BASE_URL"] ??
  process.env["NEXT_PUBLIC_API_BASE_URL"] ??
  "http://localhost:3001";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params;
  if (!token) {
    return NextResponse.json({ error: "missing_token" }, { status: 400 });
  }

  const response = await fetch(`${API_BASE_URL.replace(/\/$/, "")}/api/public/quotes/${encodeURIComponent(token)}/pdf`, {
    method: "GET",
    headers: {
      "user-agent": request.headers.get("user-agent") ?? "",
      "x-forwarded-for": request.headers.get("x-forwarded-for") ?? "",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    return NextResponse.json({ error: "pdf_unavailable" }, { status: response.status });
  }

  const body = await response.arrayBuffer();
  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/pdf",
      "content-disposition": response.headers.get("content-disposition") ?? `attachment; filename="stonegate-quote.pdf"`,
      "cache-control": "no-store",
    },
  });
}
