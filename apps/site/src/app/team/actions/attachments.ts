'use server';

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { callAdminApi } from "../lib/api";

export async function addApptAttachmentAction(formData: FormData) {
  const appointmentId = formData.get("appointmentId");
  const file = formData.get("file");
  const nameOverride = formData.get("filename");

  if (typeof appointmentId !== "string" || !appointmentId.trim()) return;
  if (!(file instanceof File)) return;

  const buf = Buffer.from(await file.arrayBuffer());
  const contentType = file.type || "application/octet-stream";
  const base64 = buf.toString("base64");
  const dataUrl = `data:${contentType};base64,${base64}`;

  await callAdminApi(`/api/appointments/${appointmentId}/attachments`, {
    method: "POST",
    body: JSON.stringify({
      url: dataUrl,
      filename: typeof nameOverride === "string" && nameOverride.trim().length ? nameOverride.trim() : file.name,
      contentType
    })
  });

  const jar = await cookies();
  jar.set({ name: "myst-flash", value: "Attachment added", path: "/" });
  revalidatePath("/team");
}
