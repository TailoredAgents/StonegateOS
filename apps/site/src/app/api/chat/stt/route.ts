import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const runtime = "edge";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    return NextResponse.json({ error: "openai_not_configured" }, { status: 503 });
  }

  const formData = await req.formData();
  const file = formData.get("audio");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing_audio" }, { status: 400 });
  }

  const payload = new FormData();
  payload.set("file", file);
  payload.set("model", "whisper-1");
  payload.set("response_format", "text");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: payload
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return NextResponse.json({ error: "stt_failed", detail: text.slice(0, 300) }, { status: 502 });
  }

  const transcript = await response.text();
  return NextResponse.json({ ok: true, transcript: transcript.trim() });
}
