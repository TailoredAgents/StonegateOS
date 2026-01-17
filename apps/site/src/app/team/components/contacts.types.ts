export type PropertySummary = {
  id: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string;
  postalCode: string;
  createdAt: string;
};

export type ContactNoteSummary = {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

export type ContactReminderSummary = {
  id: string;
  title: string;
  notes: string | null;
  dueAt: string | null;
  assignedTo: string | null;
  status: "open" | "completed";
  createdAt: string;
  updatedAt: string;
};

export type PipelineSummary = {
  stage: string;
  notes: string | null;
  updatedAt: string | null;
};

export type ContactSummary = {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  phoneE164: string | null;
  salespersonMemberId: string | null;
  source: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string | null;
  pipeline: PipelineSummary;
  properties: PropertySummary[];
  notes: ContactNoteSummary[];
  notesCount: number;
  reminders: ContactReminderSummary[];
  remindersCount: number;
  stats: {
    appointments: number;
    quotes: number;
  };
};

export type PaginationInfo = {
  limit: number;
  offset: number;
  total: number;
  nextOffset: number | null;
};
