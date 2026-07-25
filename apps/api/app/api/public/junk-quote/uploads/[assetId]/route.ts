import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  PublicQuoteMediaError,
  resolvePublicInstantQuoteMediaRead,
} from "@/lib/public-instant-quote-media";

type RouteContext = { params: Promise<{ assetId?: string }> };

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "private, no-store",
  };
}

async function resolveRead(
  request: NextRequest,
  context: RouteContext,
): Promise<
  | {
      url: string;
      contentType: string;
      byteLength: number | null;
    }
  | Response
> {
  const { assetId } = await context.params;
  const token = request.nextUrl.searchParams.get("token")?.trim() ?? "";
  if (!assetId || !token) {
    return NextResponse.json(
      { error: !assetId ? "asset_id_required" : "token_required" },
      { status: !assetId ? 400 : 401, headers: corsHeaders() },
    );
  }
  try {
    return await resolvePublicInstantQuoteMediaRead({ assetId, token });
  } catch (error) {
    if (error instanceof PublicQuoteMediaError) {
      return NextResponse.json(
        { error: error.code },
        { status: error.status, headers: corsHeaders() },
      );
    }
    console.error("[public-quote-media] read_failed", {
      assetId,
      error: String(error),
    });
    return NextResponse.json(
      { error: "media_read_failed" },
      { status: 502, headers: corsHeaders() },
    );
  }
}

export function OPTIONS(): Response {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function HEAD(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const resolved = await resolveRead(request, context);
  if (resolved instanceof Response) return resolved;
  return new NextResponse(null, {
    status: 200,
    headers: {
      ...corsHeaders(),
      "Content-Type": resolved.contentType,
      ...(resolved.byteLength === null
        ? {}
        : { "Content-Length": String(resolved.byteLength) }),
    },
  });
}

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const resolved = await resolveRead(request, context);
  if (resolved instanceof Response) return resolved;
  return NextResponse.redirect(resolved.url, {
    status: 307,
    headers: corsHeaders(),
  });
}
