export type CustomerWorkspaceIntent =
  | "quote"
  | "booking"
  | "reschedule"
  | "missing_info"
  | "none";

export type CustomerWorkspaceProperty = {
  id: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string;
  postalCode: string;
};

export type CustomerWorkspaceContact = {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  phoneE164: string | null;
  salespersonMemberId: string | null;
  pipeline: { stage: string | null; notes: string | null };
  stats: { appointments: number; quotes: number };
  notesCount: number;
  remindersCount: number;
  lastActivityAt: string | null;
};

export type CustomerWorkspaceAppointment = {
  id: string;
  status: string | null;
  startAt: string | null;
  durationMinutes: number | null;
  travelBufferMinutes: number | null;
  appointmentType: string | null;
  rescheduleToken: string | null;
  property: CustomerWorkspaceProperty | null;
};

export type CustomerWorkspaceQuote = {
  id: string;
  status: string;
  displayStatus: string | null;
  quoteNumber: string | null;
  total: number | null;
  shareToken: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  sentAt: string | null;
  pdfDownloadCount: number;
  lastPdfDownloadedAt: string | null;
  changeRequestCount: number;
  latestChangeRequest: {
    reason: string | null;
    message: string | null;
    createdAt: string | null;
  } | null;
  property: Pick<CustomerWorkspaceProperty, "addressLine1" | "city" | "state" | "postalCode"> | null;
};

export type CustomerWorkspaceMissingField =
  | "name"
  | "phone_or_email"
  | "address";

export type CustomerWorkspace = {
  ok: true;
  contact: CustomerWorkspaceContact;
  properties: CustomerWorkspaceProperty[];
  upcomingAppointments: CustomerWorkspaceAppointment[];
  quotes: CustomerWorkspaceQuote[];
  missingFields: CustomerWorkspaceMissingField[];
  recommendedIntent: CustomerWorkspaceIntent;
};

export type CustomerWorkspaceResult =
  | CustomerWorkspace
  | { ok: false; message: string };

export function detectCustomerIntent(
  latestInboundBody: string | null | undefined,
  aiActionType?: string | null,
): CustomerWorkspaceIntent {
  const ai = (aiActionType ?? "").trim().toLowerCase();
  if (ai.includes("reschedule")) return "reschedule";
  if (ai.includes("book") || ai.includes("schedule")) return "booking";
  if (ai.includes("quote") || ai.includes("estimate")) return "quote";
  if (ai.includes("missing") || ai.includes("collect")) return "missing_info";

  const text = (latestInboundBody ?? "").toLowerCase();
  if (!text.trim()) return "none";

  if (
    /\b(reschedule|re[-\s]?schedule|change|move|different time|different day|can't make|cannot make|need to change)\b/.test(text) &&
    /\b(appointment|appt|booking|schedule|visit|time|day)\b/.test(text)
  ) {
    return "reschedule";
  }

  if (/\b(quote|estimate|proposal|price|pricing|how much|cost)\b/.test(text)) {
    return "quote";
  }

  if (
    /\b(schedule|scheduled|book|booking|appointment|appt|get on|come out|pickup|pick up|visit)\b/.test(text)
  ) {
    return "booking";
  }

  if (
    /\b(address|phone|email|name|photos?|pictures?|details?)\b/.test(text) &&
    /\b(need|missing|send|provide|what|where)\b/.test(text)
  ) {
    return "missing_info";
  }

  return "none";
}
