"use server";

import {
  hasTeamPermission,
  requireCurrentTeamPrincipal,
} from "@/lib/team-principal";
import { callAdminApiAs } from "./lib/api";
import type {
  ContactNoteSummary,
  ContactReminderSummary,
} from "./components/contacts.types";

export async function loadInboxContactTasksAction(
  contactId: string,
  kind: "notes" | "reminders",
): Promise<
  | {
      ok: true;
      notes: ContactNoteSummary[];
      reminders: ContactReminderSummary[];
    }
  | { ok: false; error: string }
> {
  const principal = await requireCurrentTeamPrincipal();
  if (!hasTeamPermission(principal, "contacts.read"))
    return { ok: false, error: "You do not have access to customer details." };
  if (
    !/^[0-9a-f-]{36}$/i.test(contactId) ||
    !["notes", "reminders"].includes(kind)
  )
    return { ok: false, error: "Choose a customer and try again." };
  try {
    const res = await callAdminApiAs(
      principal,
      `/api/admin/crm/tasks?contactId=${encodeURIComponent(contactId)}&status=${kind === "notes" ? "completed" : "open"}`,
    );
    const data = (await res.json()) as { tasks?: unknown[] } | null;
    if (!res.ok || !Array.isArray(data?.tasks)) throw new Error();
    const notes: ContactNoteSummary[] = [];
    const reminders: ContactReminderSummary[] = [];
    for (const value of data.tasks) {
      if (!value || typeof value !== "object") throw new Error();
      const t = value as Record<string, unknown>;
      if (
        typeof t["id"] !== "string" ||
        typeof t["createdAt"] !== "string" ||
        typeof t["updatedAt"] !== "string"
      )
        throw new Error();
      const body = typeof t["notes"] === "string" ? t["notes"] : null;
      if (kind === "notes" && body?.trim())
        notes.push({
          id: t["id"],
          body,
          createdAt: t["createdAt"],
          updatedAt: t["updatedAt"],
        });
      if (
        kind === "reminders" &&
        typeof t["title"] === "string" &&
        t["status"] === "open" &&
        !/^auto:/i.test(t["title"]) &&
        !/kind=(speed_to_lead|follow_up)|\[auto\]/i.test(body ?? "")
      ) {
        reminders.push({
          id: t["id"],
          title: t["title"],
          notes: body,
          dueAt: typeof t["dueAt"] === "string" ? t["dueAt"] : null,
          assignedTo:
            typeof t["assignedTo"] === "string" ? t["assignedTo"] : null,
          status: "open",
          createdAt: t["createdAt"],
          updatedAt: t["updatedAt"],
        });
      }
    }
    return { ok: true, notes, reminders };
  } catch {
    return {
      ok: false,
      error: `${kind === "notes" ? "Notes" : "Reminders"} could not be loaded. Please retry.`,
    };
  }
}

export async function loadInboxDiagnosticsAction(): Promise<
  | {
      ok: true;
      providers: Array<{
        provider: string;
        status: string;
        lastFailureDetail: string | null;
      }>;
    }
  | { ok: false; error: string }
> {
  const principal = await requireCurrentTeamPrincipal();
  if (!hasTeamPermission(principal, "access.manage"))
    return { ok: false, error: "You do not have access to diagnostics." };
  try {
    const res = await callAdminApiAs(principal, "/api/admin/providers/health");
    const data = (await res.json()) as {
      providers?: Array<{
        provider: string;
        status: string;
        lastFailureDetail: string | null;
      }>;
    } | null;
    if (!res.ok || !Array.isArray(data?.providers)) throw new Error();
    return { ok: true, providers: data.providers };
  } catch {
    return {
      ok: false,
      error: "Diagnostics could not be loaded. Please retry.",
    };
  }
}
