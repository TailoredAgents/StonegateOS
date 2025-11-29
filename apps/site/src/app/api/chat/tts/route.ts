import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    return NextResponse.json({ error: "openai_not_configured" }, { status: 503 });
  }

  const body = (await req.json().catch(() => null)) as { text?: string } | null;
  const text = body?.text?.trim();
  if (!text) {
    return NextResponse.json({ error: "missing_text" }, { status: 400 });
  }

  const payload = {
    model: "gpt-audio-mini",
    modalities: ["audio"],
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text
          }
        ]
      }
    ],
    audio: {
      voice: "alloy",
      format: "mp3"
    }
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const err = await response.text().catch(() => "");
    return NextResponse.json({ error: "tts_failed", detail: err.slice(0, 300) }, { status: 502 });
  }

  const data = (await response.json()) as { output_audio?: { data?: string } };
  const base64 = data.output_audio?.data;
  if (!base64) {
    return NextResponse.json({ error: "tts_empty" }, { status: 502 });
  }

  const audioBuffer = Buffer.from(base64, "base64");
  return new NextResponse(audioBuffer, {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg"
    }
  });
}
