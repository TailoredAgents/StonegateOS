"use client";

import React from "react";
import { Mic, Loader2 } from "lucide-react";

type Status = "idle" | "recording" | "transcribing" | "error";

function supportsAudioRecording(): boolean {
  if (typeof window === "undefined") return false;
  const hasMediaDevices = typeof navigator.mediaDevices?.getUserMedia === "function";
  const hasMediaRecorder = typeof (window as any).MediaRecorder === "function";
  return hasMediaDevices && hasMediaRecorder;
}

function extensionForMime(mime: string): string {
  const lower = mime.toLowerCase();
  if (lower.includes("mp4")) return "m4a";
  if (lower.includes("mpeg")) return "mp3";
  if (lower.includes("wav")) return "wav";
  if (lower.includes("webm")) return "webm";
  return "webm";
}

export function InboxSpeechToTextButtonClient({
  textareaId,
  endpoint = "/api/team/stt"
}: {
  textareaId: string;
  endpoint?: string;
}): React.ReactElement | null {
  const [status, setStatus] = React.useState<Status>("idle");
  const [supported, setSupported] = React.useState(false);
  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const streamRef = React.useRef<MediaStream | null>(null);
  const stopTimeoutRef = React.useRef<number | null>(null);
  const startedAtRef = React.useRef<number>(0);

  React.useEffect(() => {
    setSupported(supportsAudioRecording());
  }, []);

  const cleanup = React.useCallback(() => {
    if (stopTimeoutRef.current) {
      window.clearTimeout(stopTimeoutRef.current);
      stopTimeoutRef.current = null;
    }
    if (recorderRef.current) {
      recorderRef.current.ondataavailable = null;
      recorderRef.current.onstop = null;
      recorderRef.current.onerror = null;
      recorderRef.current = null;
    }
    if (streamRef.current) {
      try {
        streamRef.current.getTracks().forEach((t) => t.stop());
      } catch {
        // ignore
      }
      streamRef.current = null;
    }
    chunksRef.current = [];
  }, []);

  const appendTranscript = React.useCallback(
    (transcript: string) => {
      const textarea = document.getElementById(textareaId) as HTMLTextAreaElement | null;
      if (!textarea) return;
      const trimmed = transcript.trim();
      if (!trimmed) return;
      const prefix = textarea.value.trim().length > 0 ? "\n" : "";
      textarea.value = `${textarea.value}${prefix}${trimmed}`.trimStart();
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      try {
        textarea.focus();
        textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
      } catch {
        // ignore
      }
    },
    [textareaId]
  );

  const upload = React.useCallback(
    async (blob: Blob, mimeType: string) => {
      setStatus("transcribing");
      try {
        const form = new FormData();
        const ext = extensionForMime(mimeType || blob.type || "audio/webm");
        form.append("audio", blob, `speech.${ext}`);
        const res = await fetch(endpoint, { method: "POST", body: form });
        if (!res.ok) throw new Error(`stt_failed:${res.status}`);
        const data = (await res.json().catch(() => null)) as { transcript?: string } | null;
        const transcript = data?.transcript?.trim() ?? "";
        if (transcript) appendTranscript(transcript);
        setStatus("idle");
      } catch {
        setStatus("error");
        window.setTimeout(() => setStatus("idle"), 1200);
      }
    },
    [appendTranscript, endpoint]
  );

  const stopRecording = React.useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    if (recorder.state === "inactive") return;
    try {
      recorder.stop();
    } catch {
      cleanup();
      setStatus("idle");
    }
  }, [cleanup]);

  const startRecording = React.useCallback(async () => {
    if (!supported) return;
    if (status !== "idle") return;
    setStatus("recording");
    try {
      startedAtRef.current = Date.now();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        cleanup();
        setStatus("error");
        window.setTimeout(() => setStatus("idle"), 1200);
      };
      recorder.onstop = () => {
        const mimeType = recorder.mimeType || chunksRef.current[0]?.type || "audio/webm";
        const blob = new Blob(chunksRef.current, { type: mimeType });
        cleanup();
        const durationMs = Date.now() - startedAtRef.current;
        const isTooShort = durationMs < 250;
        const isTooSmall = blob.size < 1024;
        if (isTooShort || isTooSmall) {
          setStatus("idle");
          return;
        }
        void upload(blob, mimeType);
      };

      recorder.start();
      stopTimeoutRef.current = window.setTimeout(() => stopRecording(), 60_000);
    } catch {
      cleanup();
      setStatus("error");
      window.setTimeout(() => setStatus("idle"), 1200);
    }
  }, [cleanup, status, stopRecording, supported, upload]);

  if (!supported) return null;

  const isRecording = status === "recording";
  const isBusy = status === "recording" || status === "transcribing";

  return (
    <button
      type="button"
      aria-label={isRecording ? "Recording voice message" : "Press and hold to speak"}
      title={isRecording ? "Recording..." : "Press and hold to speak"}
      className={`inline-flex h-9 w-9 items-center justify-center rounded-full border text-slate-600 shadow-sm transition ${
        isRecording
          ? "border-rose-200 bg-rose-50 text-rose-700"
          : "border-slate-200 bg-white hover:border-primary-300 hover:text-primary-700"
      } ${isBusy ? "cursor-not-allowed" : ""}`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        if (status !== "idle") return;
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // ignore
        }
        event.preventDefault();
        void startRecording();
      }}
      onPointerUp={(event) => {
        event.preventDefault();
        stopRecording();
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
          // ignore
        }
      }}
      onPointerCancel={() => {
        stopRecording();
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {status === "transcribing" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mic className="h-4 w-4" />}
    </button>
  );
}
