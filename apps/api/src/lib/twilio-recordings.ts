type TwilioRecording = {
  sid: string;
  durationSec: number | null;
  dateCreated: string | null;
  uri: string | null;
};

export type TwilioRecordingDownloadResult =
  | {
      ok: true;
      buffer: Buffer;
      contentType: string;
      filename: string;
    }
  | {
      ok: false;
      retryable: boolean;
      status: number | null;
    };

function getTwilioConfig():
  | { sid: string; token: string; baseUrl: string }
  | { sid: null; token: null; baseUrl: string } {
  const sid = process.env["TWILIO_ACCOUNT_SID"] ?? null;
  const token = process.env["TWILIO_AUTH_TOKEN"] ?? null;
  const baseUrl = (process.env["TWILIO_API_BASE_URL"] ?? "https://api.twilio.com").replace(/\/$/, "");
  return sid && token ? { sid, token, baseUrl } : { sid: null, token: null, baseUrl };
}

function authHeader(sid: string, token: string): string {
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  return `Basic ${auth}`;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export async function listTwilioRecordingsForCall(callSid: string): Promise<TwilioRecording[]> {
  const config = getTwilioConfig();
  if (!config.sid || !config.token) {
    return [];
  }

  const url = `${config.baseUrl}/2010-04-01/Accounts/${config.sid}/Calls/${encodeURIComponent(callSid)}/Recordings.json`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: authHeader(config.sid, config.token)
    }
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.warn("[twilio.recordings] list_failed", { callSid, status: response.status, text: text.slice(0, 240) });
    return [];
  }

  const payload = (await response.json().catch(() => null)) as
    | { recordings?: unknown[] }
    | null;
  const raw = Array.isArray(payload?.recordings) ? payload!.recordings : [];

  const recordings: TwilioRecording[] = [];
  for (const item of raw) {
    const record = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : null;
    const sid = readString(record?.["sid"]);
    if (!sid) continue;
    recordings.push({
      sid,
      durationSec: readNumber(record?.["duration"]),
      dateCreated: readString(record?.["date_created"]),
      uri: readString(record?.["uri"])
    });
  }

  return recordings;
}

export async function downloadTwilioRecordingAudio(recordingSid: string): Promise<TwilioRecordingDownloadResult> {
  const config = getTwilioConfig();
  if (!config.sid || !config.token) {
    return { ok: false, retryable: false, status: null };
  }

  const candidates = [
    { ext: "wav", contentType: "audio/wav", filename: "call.wav" },
    { ext: "mp3", contentType: "audio/mpeg", filename: "call.mp3" }
  ] as const;

  for (const candidate of candidates) {
    const url = `${config.baseUrl}/2010-04-01/Accounts/${config.sid}/Recordings/${encodeURIComponent(recordingSid)}.${candidate.ext}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: authHeader(config.sid, config.token)
      }
    });

    if (response.ok) {
      const arrayBuffer = await response.arrayBuffer();
      return {
        ok: true,
        buffer: Buffer.from(arrayBuffer),
        contentType: candidate.contentType,
        filename: candidate.filename
      };
    }

    const status = response.status;
    const text = await response.text().catch(() => "");
    console.warn("[twilio.recordings] download_failed", {
      recordingSid,
      status,
      ext: candidate.ext,
      text: text.slice(0, 240)
    });

    if (status === 404) {
      continue;
    }

    const retryable = status >= 500 || status === 429;
    return { ok: false, retryable, status };
  }

  return { ok: false, retryable: true, status: 404 };
}

export async function deleteTwilioRecording(recordingSid: string): Promise<boolean> {
  const config = getTwilioConfig();
  if (!config.sid || !config.token) {
    return false;
  }

  const url = `${config.baseUrl}/2010-04-01/Accounts/${config.sid}/Recordings/${encodeURIComponent(recordingSid)}.json`;
  const response = await fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: authHeader(config.sid, config.token)
    }
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.warn("[twilio.recordings] delete_failed", { recordingSid, status: response.status, text: text.slice(0, 240) });
    return false;
  }

  return true;
}
