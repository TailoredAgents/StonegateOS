import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { quotePublicProxyNetworkHeaders } from "@/lib/quote-public-proxy-network";

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

  const target = new URL(
    `/api/public/quotes/${encodeURIComponent(token)}/pdf`,
    API_BASE_URL.replace(/\/$/u, ""),
  );
  let upstreamHeaders: Record<string, string>;
  try {
    upstreamHeaders = quotePublicProxyNetworkHeaders(request, target);
  } catch {
    return NextResponse.json(
      { error: "pdf_unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  const response = await fetch(target, {
    method: "GET",
    headers: upstreamHeaders,
    cache: "no-store",
  });

  if (!response.ok) {
    const headers = new Headers({ "cache-control": "no-store" });
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) headers.set("retry-after", retryAfter);
    return NextResponse.json(
      { error: "pdf_unavailable" },
      { status: response.status, headers },
    );
  }

  const body = await response.arrayBuffer();
  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/pdf",
      "content-disposition":
        response.headers.get("content-disposition") ??
        `attachment; filename="stonegate-quote.pdf"`,
      "cache-control": "no-store",
    },
  });
}
