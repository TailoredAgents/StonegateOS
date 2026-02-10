import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireTeamRole } from "@/app/api/team/auth";

export const runtime = "nodejs";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

function buildPrompt(): string {
  return [
    "You are transcribing internal CRM voice messages for a junk removal company in Georgia.",
    "Use natural punctuation. Keep numbers as digits when clear.",
    "Prefer these proper nouns when relevant: Stonegate, Woodstock, Acworth, Kennesaw, Alpharetta, Milton, Johns Creek, Holly Springs.",
    "Common terms: trailer, quarter load, half load, three quarter load, full load, mattress, couch, sectional, appliance, debris, estimate, quote, appointment."
  ].join("\n");
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireTeamRole(req, {
    returnJson: true,
    roles: ["owner", "office", "crew"],
    flashError: "Please sign in again to use voice input."
  });
  if (!auth.ok) return auth.response as NextResponse;

  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    return NextResponse.json({ error: "openai_not_configured" }, { status: 503 });
  }

  const formData = await req.formData();
  const file = formData.get("audio");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing_audio" }, { status: 400 });
  }
  if (file.size <= 0) return NextResponse.json({ error: "empty_audio" }, { status: 400 });
  if (file.size > MAX_AUDIO_BYTES) {
    return NextResponse.json({ error: "audio_too_large" }, { status: 413 });
  }

  const outForm = new FormData();
  outForm.set("model", "gpt-4o-mini-transcribe");
  outForm.set("language", "en");
  outForm.set("prompt", buildPrompt());
  outForm.set("file", file, file.name || "audio.webm");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: outForm
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return NextResponse.json({ error: "stt_failed", detail: text.slice(0, 300) }, { status: 502 });
  }

  const data = (await response.json().catch(() => null)) as { text?: string } | null;
  const transcript = data?.text?.trim() ?? "";
  if (!transcript) {
    return NextResponse.json({ error: "empty_transcript" }, { status: 502 });
  }

  return NextResponse.json({ ok: true, transcript });
}
