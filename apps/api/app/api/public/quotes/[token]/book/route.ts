import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  bookAcceptedQuote,
  loadPublicQuoteForScheduling,
  quoteIsExpired,
} from "@/lib/quote-scheduling";

const BookSchema = z.object({
  startAt: z.string().datetime(),
  holdId: z.string().uuid(),
});

function errorStatus(code: string): number {
  if (code === "hold_invalid") return 409;
  if (code === "invalid_start_at") return 400;
  if (code === "appointment_create_failed") return 500;
  return 500;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params;
  if (!token) {
    return NextResponse.json({ error: "missing_token" }, { status: 400 });
  }
  const parsed = BookSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const quote = await loadPublicQuoteForScheduling(token);
  if (!quote) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (quoteIsExpired(quote)) {
    return NextResponse.json({ error: "expired" }, { status: 410 });
  }
  if (quote.status !== "accepted") {
    return NextResponse.json({ error: "quote_not_accepted" }, { status: 409 });
  }

  try {
    const booking = await bookAcceptedQuote({
      quote,
      holdId: parsed.data.holdId,
      startAtIso: parsed.data.startAt,
    });
    return NextResponse.json({ ok: true, ...booking });
  } catch (error) {
    const code = error instanceof Error ? error.message : "booking_failed";
    return NextResponse.json({ error: code }, { status: errorStatus(code) });
  }
}
