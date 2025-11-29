import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

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

  const arrayBuffer = await file.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  const format = (file.name.split(".").pop() || "wav").toLowerCase();

  const body = {
    model: "gpt-audio-mini",
    modalities: ["text"],
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_audio",
            input_audio: {
              data: base64,
              format
            }
          }
        ]
      }
    ]
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return NextResponse.json({ error: "stt_failed", detail: text.slice(0, 300) }, { status: 502 });
  }

  const data = (await response.json()) as { output_text?: string };
  const transcript = data.output_text?.trim() ?? "";
  if (!transcript) {
    return NextResponse.json({ error: "empty_transcript" }, { status: 502 });
  }

  return NextResponse.json({ ok: true, transcript });
}
