"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ADMIN_SESSION_COOKIE, adminSessionCookieOptions, getAdminKey } from "@/lib/admin-session";

export type LoginFormState = {
  error?: string;
};

export async function loginAction(
  _prevState: LoginFormState | undefined,
  formData: FormData
): Promise<LoginFormState> {

  const adminKey = getAdminKey();
  if (!adminKey) {
    return { error: "ADMIN_API_KEY is not configured." };
  }

  const submittedKey = formData.get("key");
  const redirectTo = (typeof formData.get("redirectTo") === "string" ? formData.get("redirectTo") : "/admin/quotes") as string;

  if (typeof submittedKey !== "string" || submittedKey.trim().length === 0) {
    return { error: "Enter your admin key." };
  }

  if (submittedKey.trim() !== adminKey) {
    return { error: "Invalid admin key." };
  }

  (await cookies()).set(ADMIN_SESSION_COOKIE, adminKey, adminSessionCookieOptions());
  redirect(redirectTo as Parameters<typeof redirect>[0]);
}
