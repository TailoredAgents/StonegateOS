'use server';

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { callAdminApi } from "../lib/api";

export async function addApptAttachmentAction(formData: FormData) {
  const appointmentId = formData.get("appointmentId");
  const url = formData.get("url");
  const filename = formData.get("filename");
  const contentType = formData.get("contentType");

  if (typeof appointmentId !== "string" || !appointmentId.trim()) return;
  if (typeof url !== "string" || !url.trim() || typeof filename !== "string" || !filename.trim()) return;

  await callAdminApi(`/api/appointments/${appointmentId}/attachments`, {
    method: "POST",
    body: JSON.stringify({
      url: url.trim(),
      filename: filename.trim(),
      contentType: typeof contentType === "string" && contentType.trim() ? contentType.trim() : undefined
    })
  });

  const jar = await cookies();
  jar.set({ name: "myst-flash", value: "Attachment added", path: "/" });
  revalidatePath("/team");
}
