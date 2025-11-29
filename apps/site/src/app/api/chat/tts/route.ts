import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const runtime = "edge";

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

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "tts-1",
      voice: "alloy",
      input: text
    })
  });

  if (!response.ok) {
    const err = await response.text().catch(() => "");
    return NextResponse.json({ error: "tts_failed", detail: err.slice(0, 300) }, { status: 502 });
  }

  const audioBuffer = await response.arrayBuffer();
  return new NextResponse(Buffer.from(audioBuffer), {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg"
    }
  });
}
