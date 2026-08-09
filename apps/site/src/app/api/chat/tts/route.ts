import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { resolveOpenAiApiEndpoint } from "@myst-os/sdk";
import { requireTeamRequestPrincipal } from "@/app/api/team/auth";

export const runtime = "nodejs";

const MAX_TEXT_CHARACTERS = 5_000;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireTeamRequestPrincipal(req, {
    returnJson: true,
    permissions: "messages.read",
    flashError: "Please sign in again to use spoken responses.",
  });
  if (!auth.ok) return auth.response as NextResponse;

  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    return NextResponse.json(
      { error: "openai_not_configured" },
      { status: 503 },
    );
  }

  const body: unknown = await req.json().catch(() => null);
  const bodyRecord =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  const text =
    typeof bodyRecord?.["text"] === "string" ? bodyRecord["text"].trim() : "";
  if (!text) {
    return NextResponse.json({ error: "missing_text" }, { status: 400 });
  }
  if (text.length > MAX_TEXT_CHARACTERS) {
    return NextResponse.json({ error: "text_too_large" }, { status: 413 });
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
            text,
          },
        ],
      },
    ],
    audio: {
      voice: "alloy",
      format: "mp3",
    },
  };

  const response = await fetch(
    resolveOpenAiApiEndpoint("responses", process.env),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );

  if (!response.ok) {
    const err = await response.text().catch(() => "");
    return NextResponse.json(
      { error: "tts_failed", detail: err.slice(0, 300) },
      { status: 502 },
    );
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
      "Content-Type": "audio/mpeg",
    },
  });
}
