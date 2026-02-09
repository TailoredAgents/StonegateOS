import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireTeamRole } from "../auth";

export const runtime = "nodejs";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

function buildPrompt(): string {
  return [
    "You are transcribing internal CRM voice notes for a junk removal company in Georgia.",
    "Use natural punctuation. Keep numbers as digits when clear.",
    "Prefer these proper nouns when relevant: Stonegate, Woodstock, Acworth, Kennesaw, Alpharetta, Milton, Johns Creek, Holly Springs.",
    "Common terms: trailer, quarter load, half load, three quarter load, full load, mattress, couch, sectional, appliance, debris, estimate, quote, appointment."
  ].join("\n");
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await requireTeamRole(request, { returnJson: true, flashError: "Please sign in again to use voice input." });
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) return NextResponse.json({ error: "openai_not_configured" }, { status: 503 });

  const formData = await request.formData();
  const audio = formData.get("audio");
  if (!(audio instanceof File)) {
    return NextResponse.json({ error: "missing_audio" }, { status: 400 });
  }

  if (audio.size <= 0) return NextResponse.json({ error: "empty_audio" }, { status: 400 });
  if (audio.size > MAX_AUDIO_BYTES) {
    return NextResponse.json({ error: "audio_too_large" }, { status: 413 });
  }

  const upstream = new FormData();
  upstream.append("model", "gpt-4o-mini-transcribe");
  upstream.append("language", "en");
  upstream.append("prompt", buildPrompt());
  upstream.append("file", audio, audio.name || "audio.webm");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: upstream
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return NextResponse.json({ error: "stt_failed", detail: text.slice(0, 300) }, { status: 502 });
  }

  const payload = (await response.json().catch(() => null)) as { text?: string } | null;
  const transcript = payload?.text?.trim() ?? "";
  if (!transcript) return NextResponse.json({ error: "empty_transcript" }, { status: 502 });

  return NextResponse.json({ ok: true, transcript });
}

