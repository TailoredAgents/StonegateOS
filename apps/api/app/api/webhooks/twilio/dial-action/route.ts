import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function readString(value: FormDataEntryValue | null): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: FormDataEntryValue | null): number | null {
  const raw = readString(value);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function POST(request: NextRequest): Promise<Response> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "invalid_form" }, { status: 400 });
  }

  const leg = request.nextUrl.searchParams.get("leg")?.trim() || "unknown";

  const payload = {
    leg,
    callSid: readString(formData.get("CallSid")),
    parentCallSid: readString(formData.get("ParentCallSid")),
    callStatus: readString(formData.get("CallStatus")),
    from: readString(formData.get("From")),
    to: readString(formData.get("To")),
    dialCallSid: readString(formData.get("DialCallSid")),
    dialCallStatus: readString(formData.get("DialCallStatus")),
    dialCallDuration: readNumber(formData.get("DialCallDuration")),
    dialBridged: readString(formData.get("DialBridged")),
    dialSipResponseCode: readString(formData.get("DialSipResponseCode")),
    dialHangupCause: readString(formData.get("DialHangupCause")),
    dialCallQuality: readString(formData.get("DialCallQuality"))
  };

  console.info("[twilio.dial_action]", payload);

  return new NextResponse("ok", { status: 200 });
}

