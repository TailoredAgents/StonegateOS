export type ScorecardPayload = {
  ok: true;
  memberId: string;
  rangeDays: number;
  config?: {
    trackingStartAt?: string | null;
    weights?: {
      speedToLead?: number;
      followupCompliance?: number;
      conversion?: number;
      callQuality?: number;
      responseTime?: number;
    };
  };
  score: {
    total: number;
    speedToLead: number;
    followupCompliance: number;
    conversion: number;
    callQuality?: number;
    responseTime?: number;
  };
  metrics: {
    speedToLead: { totalLeads: number; met: number; missed: number };
    followups: { totalDue: number; completedOnTime: number; completedLate: number; stillOpen: number };
    conversion: { totalLeads: number; booked: number; won: number };
    callQuality?: { avgScore: number | null; effectiveAvg: number; counted: boolean; count: number };
  };
};

export type QueuePayload = {
  ok: true;
  memberId: string;
  now: string;
  items: Array<{
    id: string;
    leadId: string | null;
    contact: {
      id: string;
      name: string;
      phone: string | null;
      postalCode: string | null;
      serviceAreaStatus: "unknown" | "ok" | "potentially_out_of_area";
    };
    title: string;
    dueAt: string | null;
    overdue: boolean;
    minutesUntilDue: number | null;
    kind: "speed_to_lead" | "follow_up";
  }>;
};

export type TeamMemberPayload = {
  members?: Array<{ id: string; name: string; active: boolean }>;
};

export type CallCoachingPayload = {
  ok: true;
  memberId: string;
  rangeDays: number;
  since: string;
  summary: {
    inbound: { avgScore: number | null; count: number };
    outbound: { avgScore: number | null; count: number };
  };
  items: Array<{
    callRecordId: string;
    createdAt: string;
    durationSec: number | null;
    summary?: string | null;
    note?: { title: string | null; body: string } | null;
    contact: { id: string | null; name: string; source: string | null };
    primaryRubric: "inbound" | "outbound";
    primary: { rubric: "inbound" | "outbound"; scoreOverall: number; wins: string[]; improvements: string[] } | null;
    secondary: { rubric: "inbound" | "outbound"; scoreOverall: number; wins: string[]; improvements: string[] } | null;
  }>;
};

