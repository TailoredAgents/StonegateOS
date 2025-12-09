'use server';

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { callAdminApi } from "../lib/api";

export async function addApptTaskAction(formData: FormData) {
  const appointmentId = formData.get("appointmentId");
  const title = formData.get("title");
  if (typeof appointmentId !== "string" || !appointmentId.trim() || typeof title !== "string" || !title.trim()) return;

  await callAdminApi(`/api/appointments/${appointmentId}/tasks`, {
    method: "POST",
    body: JSON.stringify({ title: title.trim() })
  });

  const jar = await cookies();
  jar.set({ name: "myst-flash", value: "Task added", path: "/" });
  revalidatePath("/team");
}

export async function updateApptTaskStatusAction(formData: FormData) {
  const appointmentId = formData.get("appointmentId");
  const taskId = formData.get("taskId");
  const status = formData.get("status");
  if (typeof appointmentId !== "string" || !appointmentId.trim() || typeof taskId !== "string" || !taskId.trim()) return;
  if (status !== "open" && status !== "done") return;

  await callAdminApi(`/api/appointments/${appointmentId}/tasks`, {
    method: "PATCH",
    body: JSON.stringify({ taskId, status })
  });

  const jar = await cookies();
  jar.set({ name: "myst-flash", value: "Task updated", path: "/" });
  revalidatePath("/team");
}
