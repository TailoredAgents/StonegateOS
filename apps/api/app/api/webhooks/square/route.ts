import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  completeSquareProviderEvent,
  processSquareWebhookEvent,
  reserveSquareProviderEvent,
  type SquareWebhookEvent,
} from "@/lib/square-payments";
import { verifySquareWebhookSignature } from "@/lib/square-pos";

export const dynamic = "force-dynamic";

function parseEvent(rawBody: string): SquareWebhookEvent | null {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as SquareWebhookEvent)
      : null;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const rawBody = await request.text();
  const signatureKey =
    process.env["SQUARE_WEBHOOK_SIGNATURE_KEY"]?.trim() ?? "";
  const notificationUrl =
    process.env["SQUARE_WEBHOOK_NOTIFICATION_URL"]?.trim() ?? "";
  const signature = request.headers.get(
    "x-square-hmacsha256-signature",
  );
  if (!signatureKey || !notificationUrl) {
    return NextResponse.json(
      { error: "square_webhook_not_configured" },
      { status: 503 },
    );
  }
  if (
    !verifySquareWebhookSignature({
      rawBody,
      signature,
      signatureKey,
      notificationUrl,
    })
  ) {
    return NextResponse.json(
      { error: "invalid_signature" },
      { status: 401 },
    );
  }

  const event = parseEvent(rawBody);
  if (!event?.event_id || !event.type) {
    return NextResponse.json(
      { error: "invalid_square_event" },
      { status: 400 },
    );
  }

  const reservation = await reserveSquareProviderEvent(event);
  if (reservation.duplicate) {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  try {
    const result = await processSquareWebhookEvent(event);
    const completed = await completeSquareProviderEvent({
      eventId: reservation.id,
      leaseId: reservation.leaseId,
      status:
        result.status === "needs_review" ? "needs_review" : "processed",
      paymentId: result.paymentId,
      paymentAttemptId: result.paymentAttemptId,
    });
    if (!completed) {
      return NextResponse.json({
        ok: true,
        duplicate: true,
        leaseLost: true,
      });
    }
    return NextResponse.json({
      ok: true,
      eventId: event.event_id,
      status: result.status,
    });
  } catch (error) {
    const detail =
      error instanceof Error
        ? error.message.slice(0, 1_000)
        : "square_webhook_processing_failed";
    const failureRecorded = await completeSquareProviderEvent({
      eventId: reservation.id,
      leaseId: reservation.leaseId,
      status: "failed",
      error: detail,
    });
    if (!failureRecorded) {
      return NextResponse.json({
        ok: true,
        duplicate: true,
        leaseLost: true,
      });
    }
    console.error("[square][webhook] processing failed", {
      eventId: event.event_id,
      eventType: event.type,
      error: detail,
    });
    return NextResponse.json(
      { error: "square_webhook_processing_failed" },
      { status: 500 },
    );
  }
}
