import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  getQuoteAvailability,
  loadPublicQuoteForScheduling,
  quoteIsExpired,
} from "@/lib/quote-scheduling";

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params;
  if (!token) {
    return NextResponse.json({ error: "missing_token" }, { status: 400 });
  }

  const quote = await loadPublicQuoteForScheduling(token);
  if (!quote) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (quoteIsExpired(quote)) {
    return NextResponse.json({ error: "expired" }, { status: 410 });
  }
  if (quote.status !== "accepted" && quote.status !== "sent") {
    return NextResponse.json({ error: "quote_not_accepted" }, { status: 409 });
  }
  if (quote.acceptedAppointmentId) {
    return NextResponse.json({
      days: [],
      suggestions: [],
      appointmentId: quote.acceptedAppointmentId,
      booked: true,
    });
  }

  const availability = await getQuoteAvailability(quote);
  return NextResponse.json({ ok: true, ...availability });
}
