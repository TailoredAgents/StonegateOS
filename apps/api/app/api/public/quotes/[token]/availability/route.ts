import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  getQuoteAvailability,
  loadPublicQuoteForScheduling,
  quoteIsExpired,
} from "@/lib/quote-scheduling";
import { maybeHandleQuoteV2Availability } from "@/lib/quote-v2-scheduling-route";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params;
  if (!token) {
    return NextResponse.json({ error: "missing_token" }, { status: 400 });
  }

  const quoteV2 = await maybeHandleQuoteV2Availability(request, token);
  if (quoteV2.handled) return quoteV2.response;

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
