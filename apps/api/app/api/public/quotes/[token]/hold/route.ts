import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createQuoteAppointmentHold,
  loadPublicQuoteForScheduling,
  quoteIsExpired,
} from "@/lib/quote-scheduling";

const HoldSchema = z.object({
  startAt: z.string().datetime(),
});

function errorStatus(code: string): number {
  if (code === "slot_full") return 409;
  if (code === "outside_business_hours") return 400;
  if (code === "invalid_start_at") return 400;
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
  const parsed = HoldSchema.safeParse(await request.json().catch(() => ({})));
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
  if (quote.acceptedAppointmentId) {
    return NextResponse.json({ error: "already_booked", appointmentId: quote.acceptedAppointmentId }, { status: 409 });
  }

  try {
    const hold = await createQuoteAppointmentHold(quote, parsed.data.startAt);
    return NextResponse.json({ ok: true, ...hold });
  } catch (error) {
    const code = error instanceof Error ? error.message : "hold_failed";
    return NextResponse.json({ error: code }, { status: errorStatus(code) });
  }
}
