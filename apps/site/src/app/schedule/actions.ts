"use server";

import { redirect } from "next/navigation";

export type RescheduleState = {
  ok?: boolean;
  error?: string;
  appointmentId?: string;
  startAt?: string | null;
  preferredDate?: string | null;
  timeWindow?: string | null;
};

const API_BASE_URL =
  process.env["API_BASE_URL"] ??
  process.env["NEXT_PUBLIC_API_BASE_URL"] ??
  "http://localhost:3001";

export async function rescheduleAction(
  _prev: RescheduleState | undefined,
  formData: FormData
): Promise<RescheduleState> {
  const appointmentId = formData.get("appointmentId");
  const token = formData.get("token");
  const preferredDate = formData.get("preferredDate");
  const timeWindow = formData.get("timeWindow");
  const startTime = formData.get("startTime");
  const next = formData.get("next");

  if (typeof appointmentId !== "string" || appointmentId.trim().length === 0) {
    return { error: "Missing appointment." };
  }
  if (typeof token !== "string" || token.trim().length === 0) {
    return { error: "Missing token." };
  }
  if (typeof preferredDate !== "string" || preferredDate.trim().length === 0) {
    return { error: "Pick a date." };
  }

  const body: Record<string, unknown> = { rescheduleToken: token };

  if (typeof startTime === "string" && startTime.trim().length > 0) {
    body["preferredDate"] = preferredDate;
    body["startTime"] = startTime.trim();
  } else {
    body["preferredDate"] = preferredDate;
    body["timeWindow"] = typeof timeWindow === "string" && timeWindow ? timeWindow : undefined;
  }

  const base = API_BASE_URL.replace(/\/$/, "");
  const response = await fetch(`${base}/api/web/appointments/${encodeURIComponent(appointmentId)}/reschedule`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store"
  });

  if (!response.ok) {
    let message = `Failed to reschedule (status ${response.status}).`;
    try {
      const err = (await response.json()) as { error?: string };
      if (err?.error) message = err.error;
    } catch {}
    return { error: message };
  }

  const data = (await response.json()) as {
    ok: boolean;
    appointmentId: string;
    startAt: string | null;
    preferredDate?: string | null;
    timeWindow?: string | null;
  };

  if (typeof next === "string" && next.startsWith("/")) {
    redirect(next as any);
  }

  return {
    ok: true,
    appointmentId: data.appointmentId,
    startAt: data.startAt,
    preferredDate: data.preferredDate ?? (typeof preferredDate === "string" ? preferredDate : null),
    timeWindow: data.timeWindow ?? (typeof timeWindow === "string" ? timeWindow : null)
  };
}

