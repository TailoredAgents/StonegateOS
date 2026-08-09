"use server";

import type { Route } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  ADMIN_SESSION_COOKIE,
  adminSessionMatches,
  adminSessionCookieOptions,
  getAdminSessionSecret,
} from "@/lib/admin-session";

export type LoginFormState = {
  error?: string;
};

export async function loginAction(
  _prevState: LoginFormState | undefined,
  formData: FormData,
): Promise<LoginFormState> {
  const sessionSecret = getAdminSessionSecret();
  if (!sessionSecret) {
    return { error: "ADMIN_SESSION_SECRET is not configured." };
  }

  const submittedKey = formData.get("key");
  const redirectTo = (
    typeof formData.get("redirectTo") === "string"
      ? formData.get("redirectTo")
      : "/admin/quotes"
  ) as string;

  if (typeof submittedKey !== "string" || submittedKey.trim().length === 0) {
    return { error: "Enter your admin key." };
  }

  if (!adminSessionMatches(submittedKey.trim())) {
    return { error: "Invalid admin key." };
  }

  (await cookies()).set(
    ADMIN_SESSION_COOKIE,
    sessionSecret,
    adminSessionCookieOptions(),
  );
  redirect(redirectTo as Route);
}
