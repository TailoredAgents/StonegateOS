"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireCurrentTeamPrincipal } from "@/lib/team-principal";
import { callAdminApiAs } from "../lib/api";
import { resolveTeamMutationFeedback } from "../lib/mutation-feedback";

async function setTaskFeedback(message: string, ok: boolean): Promise<void> {
  const jar = await cookies();
  jar.set({
    name: ok ? "myst-flash" : "myst-flash-error",
    value: message,
    path: "/",
  });
}

export async function addApptTaskAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const appointmentId = formData.get("appointmentId");
  const title = formData.get("title");
  if (
    typeof appointmentId !== "string" ||
    !appointmentId.trim() ||
    typeof title !== "string" ||
    !title.trim()
  ) {
    await setTaskFeedback("Appointment and task title are required.", false);
    return;
  }

  const feedback = await resolveTeamMutationFeedback(
    callAdminApiAs(
      principal,
      `/api/appointments/${encodeURIComponent(appointmentId.trim())}/tasks`,
      {
        method: "POST",
        body: JSON.stringify({ title: title.trim() }),
      },
    ),
    {
      success: "Task added",
      failure: "Unable to add task",
    },
  );

  await setTaskFeedback(feedback.message, feedback.ok);
  revalidatePath("/team");
}

export async function updateApptTaskStatusAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const appointmentId = formData.get("appointmentId");
  const taskId = formData.get("taskId");
  const status = formData.get("status");
  if (
    typeof appointmentId !== "string" ||
    !appointmentId.trim() ||
    typeof taskId !== "string" ||
    !taskId.trim() ||
    (status !== "open" && status !== "done")
  ) {
    await setTaskFeedback(
      "A valid appointment, task, and status are required.",
      false,
    );
    return;
  }

  const feedback = await resolveTeamMutationFeedback(
    callAdminApiAs(
      principal,
      `/api/appointments/${encodeURIComponent(appointmentId.trim())}/tasks`,
      {
        method: "PATCH",
        body: JSON.stringify({ taskId, status }),
      },
    ),
    {
      success: "Task updated",
      failure: "Unable to update task",
    },
  );

  await setTaskFeedback(feedback.message, feedback.ok);
  revalidatePath("/team");
}
