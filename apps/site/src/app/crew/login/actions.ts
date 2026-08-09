"use server";

import type { Route } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  CREW_SESSION_COOKIE,
  crewSessionCookieOptions,
  getCrewKey,
} from "@/lib/crew-session";
import { legacySessionSecretMatches } from "@/lib/legacy-session-secret";

export type CrewLoginFormState = {
  error?: string;
};

export async function crewLoginAction(
  _prev: CrewLoginFormState | undefined,
  formData: FormData,
): Promise<CrewLoginFormState> {
  const submitted = formData.get("key");
  const redirectTo = (
    typeof formData.get("redirectTo") === "string"
      ? formData.get("redirectTo")
      : "/crew"
  ) as string;

  if (typeof submitted !== "string" || submitted.trim().length === 0) {
    return { error: "Enter the crew key." };
  }

  const crewKey = getCrewKey();
  if (!legacySessionSecretMatches(submitted.trim(), crewKey)) {
    return { error: "Invalid crew key." };
  }

  (await cookies()).set(
    CREW_SESSION_COOKIE,
    crewKey!,
    crewSessionCookieOptions(),
  );
  redirect(redirectTo as Route);
}
