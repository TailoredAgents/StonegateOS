import React from "react";
import {
  hasTeamPermission,
  requireCurrentTeamPrincipal,
} from "@/lib/team-principal";
import { callAdminApiAs } from "../lib/api";
import { CalendarViewer } from "./CalendarViewer";
import {
  formatCalendarDayKey,
  getCalendarUtcRange,
  normalizeCalendarDayKey,
  resolveCalendarDefaultView,
  type CalendarView,
} from "../lib/calendar-time";

type CalendarEvent = {
  id: string;
  title: string;
  source: "db" | "google";
  start: string;
  end: string;
  appointmentId?: string;
  appointmentType?: string | null;
  rescheduleToken?: string | null;
  contactName?: string | null;
  address?: string | null;
  status?: string | null;
  quotedTotalCents?: number | null;
  finalTotalCents?: number | null;
  version?: string | null;
  notes?: Array<{ id: string; body: string; createdAt: string }>;
  crewMemberIds?: string[];
  crewNames?: string[];
};

type CalendarFeedResponse = {
  ok: boolean;
  appointments: CalendarEvent[];
  externalEvents: CalendarEvent[];
  conflicts: Array<{ a: string; b: string }>;
  googleCalendarState?: "disabled" | "loaded" | "unavailable";
};

type TeamMember = {
  id: string;
  name: string;
  active?: boolean;
};

export async function CalendarSection({
  searchParams,
}: {
  searchParams?: {
    addr?: string;
    city?: string;
    state?: string;
    zip?: string;
    calView?: string;
    cal?: string;
    contactId?: string;
    propertyId?: string;
    calStatus?: string;
    calCrew?: string;
    calSource?: string;
    calConflict?: string;
  };
}): Promise<React.ReactElement> {
  const principal = await requireCurrentTeamPrincipal();
  const defaultView = resolveCalendarDefaultView(principal.roleSlug);
  const view: CalendarView =
    searchParams?.calView === "month" ||
    searchParams?.calView === "day" ||
    searchParams?.calView === "week"
      ? searchParams.calView
      : defaultView;
  const anchorDay =
    normalizeCalendarDayKey(searchParams?.cal) ??
    formatCalendarDayKey(new Date());
  const range = getCalendarUtcRange(anchorDay, view);
  if (!range) throw new Error("Unable to resolve the calendar date range");
  const canUpdateAppointments = hasTeamPermission(
    principal,
    "appointments.update",
  );
  const canCollectPayments = hasTeamPermission(principal, "payments.collect");
  const canSendCustomerMessages = hasTeamPermission(principal, "messages.send");
  const canOverrideScheduleConflicts = hasTeamPermission(
    principal,
    "appointments.override_conflicts",
  );

  const [feedRes, membersRes] = await Promise.all([
    callAdminApiAs(
      principal,
      `/api/admin/calendar/feed?start=${encodeURIComponent(range.start.toISOString())}&end=${encodeURIComponent(range.end.toISOString())}`,
    ),
    callAdminApiAs(principal, "/api/admin/team/directory"),
  ]);

  if (!feedRes.ok) {
    throw new Error("Failed to load calendar feed");
  }

  const feed = (await feedRes.json()) as CalendarFeedResponse;
  const memberPayload = membersRes?.ok
    ? ((await membersRes.json()) as { members?: TeamMember[] })
    : null;
  const teamMembers = (memberPayload?.members ?? []).filter(
    (member) => member.active !== false,
  );
  const allEvents = [...feed.appointments, ...feed.externalEvents].map(
    (event) => {
      const existingIds = new Set(event.crewMemberIds ?? []);
      const normalizedCrewNames = new Set(
        (event.crewNames ?? []).map((name) => name.trim().toLowerCase()),
      );
      for (const member of teamMembers) {
        if (normalizedCrewNames.has(member.name.trim().toLowerCase())) {
          existingIds.add(member.id);
        }
      }
      return { ...event, crewMemberIds: Array.from(existingIds) };
    },
  );

  return (
    <section className="space-y-4">
      <CalendarViewer
        initialView={view}
        initialAnchor={anchorDay}
        events={allEvents}
        conflicts={feed.conflicts}
        teamMembers={teamMembers}
        canUpdateAppointments={canUpdateAppointments}
        canCollectPayments={canCollectPayments}
        canSendCustomerMessages={canSendCustomerMessages}
        canOverrideScheduleConflicts={canOverrideScheduleConflicts}
        googleCalendarState={feed.googleCalendarState ?? "disabled"}
      />
    </section>
  );
}
