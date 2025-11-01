import { NextRequest, NextResponse } from "next/server";

type ChatHistoryEntry = {
  role: "user" | "assistant";
  content: string;
};

type AssistantResult = {
  reply: string;
  actionNote?: string;
};

type ContactSummary = {
  id: string;
  name: string;
  pipelineStage?: string;
  stats?: { quotes?: number; tasks?: number };
};

const API_BASE_URL =
  process.env["API_BASE_URL"] ??
  process.env["NEXT_PUBLIC_API_BASE_URL"] ??
  "http://localhost:3001";
const ADMIN_API_KEY = process.env["ADMIN_API_KEY"];
const OPENAI_API_KEY = process.env["OPENAI_API_KEY"];
const OPENAI_MODEL = process.env["OPENAI_MODEL"] ?? "gpt-5-mini";

const HISTORY_COOKIE = "myst-team-chat-history";
const HISTORY_LIMIT = 6;

function readHistory(request: NextRequest): ChatHistoryEntry[] {
  const raw = request.cookies.get(HISTORY_COOKIE)?.value;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as ChatHistoryEntry[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is ChatHistoryEntry =>
        typeof entry === "object" &&
        (entry?.role === "user" || entry?.role === "assistant") &&
        typeof entry?.content === "string"
    );
  } catch {
    return [];
  }
}

function persistHistory(history: ChatHistoryEntry[], response: NextResponse) {
  response.cookies.set({
    name: HISTORY_COOKIE,
    value: JSON.stringify(history.slice(-HISTORY_LIMIT * 2)),
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 3 // 3 days
  });
}

async function callAdminApi(path: string, init?: RequestInit): Promise<Response> {
  if (!ADMIN_API_KEY) {
    throw new Error("ADMIN_API_KEY must be set");
  }
  const base = API_BASE_URL.replace(/\/$/, "");
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ADMIN_API_KEY,
      ...(init?.headers ?? {})
    },
    cache: "no-store"
  });
}

async function fetchContactsSummary(): Promise<{
  text: string;
  contacts: ContactSummary[];
}> {
  try {
    const res = await callAdminApi("/api/admin/contacts?limit=6");
    if (!res.ok) throw new Error("contacts");
    const data = (await res.json()) as {
      contacts?: Array<{
        id: string;
        name: string;
        stats?: { quotes?: number; tasks?: number };
        pipeline?: { stage: string };
      }>;
    };
    const contacts = (data?.contacts ?? []).map((contact) => ({
      id: contact.id,
      name: contact.name,
      pipelineStage: contact.pipeline?.stage,
      stats: contact.stats
    }));
    if (!contacts.length) {
      return { text: "No saved contacts yet.", contacts: [] };
    }
    const lines = contacts.map(
      (contact) =>
        `- ${contact.name} (id: ${contact.id}, stage: ${contact.pipelineStage ?? "unknown"}, quotes: ${
          contact.stats?.quotes ?? 0
        }, open tasks: ${contact.stats?.tasks ?? 0})`
    );
    return { text: lines.join("\n"), contacts };
  } catch {
    return { text: "Contacts unavailable.", contacts: [] };
  }
}

async function fetchPipelineSummary(): Promise<string> {
  try {
    const res = await callAdminApi("/api/admin/crm/pipeline");
    if (!res.ok) throw new Error("pipeline");
    const data = (await res.json()) as {
      stages: string[];
      lanes: Array<{ stage: string; contacts: Array<{ id: string }> }>;
    };
    if (!data?.lanes?.length) return "Pipeline empty.";
    const lines = data.lanes.map(
      (lane) => `${lane.stage}: ${lane.contacts.length} contact(s)`
    );
    return lines.join("\n");
  } catch {
    return "Pipeline summary unavailable.";
  }
}

async function fetchScheduleSummary(): Promise<string> {
  try {
    const res = await callAdminApi("/api/appointments?status=confirmed");
    if (!res.ok) throw new Error("appointments");
    const data = (await res.json()) as {
      data?: Array<{
        id: string;
        startAt: string | null;
        contact: { name: string };
        services: string[];
      }>;
    };
    const appointments = data?.data ?? [];
    if (!appointments.length) {
      return "No confirmed appointments scheduled.";
    }
    const lines = appointments.slice(0, 4).map((appt) => {
      const when = appt.startAt ? new Date(appt.startAt).toLocaleString("en-US") : "Date TBD";
      return `- ${when}: ${appt.contact.name} (${appt.services.join(", ")})`;
    });
    return lines.join("\n");
  } catch {
    return "Schedule unavailable.";
  }
}

async function fetchTaskSummary(): Promise<string> {
  try {
    const res = await callAdminApi("/api/admin/crm/tasks?limit=5");
    if (!res.ok) throw new Error("tasks");
    const data = (await res.json()) as {
      tasks?: Array<{
        id: string;
        title: string;
        status: string;
        contact?: { id: string; name: string };
        dueAt?: string | null;
      }>;
    };
    const tasks = data?.tasks ?? [];
    if (!tasks.length) return "No assigned tasks.";
    const lines = tasks.map((task) => {
      const due =
        task.dueAt && !Number.isNaN(Date.parse(task.dueAt))
          ? new Date(task.dueAt).toLocaleDateString("en-US")
          : "no due date";
      return `- ${task.title} (status: ${task.status}, contact: ${task.contact?.name ?? "N/A"}, due: ${due})`;
    });
    return lines.join("\n");
  } catch {
    return "Tasks unavailable.";
  }
}

async function buildContext(): Promise<{
  systemPrompt: string;
  contacts: ContactSummary[];
  scheduleText: string;
  pipelineText: string;
  tasksText: string;
}> {
  const [contactsResult, pipeline, schedule, tasks] = await Promise.all([
    fetchContactsSummary(),
    fetchPipelineSummary(),
    fetchScheduleSummary(),
    fetchTaskSummary()
  ]);

  const systemPrompt = `
You are Stonegate Assist, the internal assistant for the Stonegate junk removal team. Provide concise, actionable guidance.

Current context:
Contacts:
${contactsResult.text}

Pipeline summary:
${pipeline}

Confirmed appointments:
${schedule}

Open tasks:
${tasks}

Always use the information above. When asked about the schedule or upcoming jobs, summarize using the "Confirmed appointments" section exactly. When asked about tasks, use the "Open tasks" section. Do not tell the user to check another tool unless the data is unavailable.

If you recommend creating a task, use the format:
[[ACTION:create_task|contactId=<id>|title=<title>]]
Include ONLY one action block per response, and ensure the contactId is from the list above. Provide a helpful natural-language response before the action block. If you cannot perform the action, explain why.
`.trim();

  return {
    systemPrompt,
    contacts: contactsResult.contacts,
    scheduleText: schedule,
    pipelineText: pipeline,
    tasksText: tasks
  };
}

async function callOpenAI(
  history: ChatHistoryEntry[],
  userMessage: string,
  systemPrompt: string
): Promise<string | null> {
  if (!OPENAI_API_KEY) return null;
  try {
  const messages = [
    { role: "system" as const, content: systemPrompt },
    ...history.map((entry) => ({
      role: entry.role,
      content: entry.content
    })),
    { role: "user" as const, content: userMessage }
  ];

  const payload = {
    model: OPENAI_MODEL,
    input: messages,
    reasoning: {
      effort: "low"
    },
    text: {
      verbosity: "medium"
    },
    max_output_tokens: 600
  } as const;

  console.debug("[chat] openai payload", {
    model: payload.model,
    reasoning: payload.reasoning,
    text: payload.text,
    max_output_tokens: payload.max_output_tokens
  });

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    console.error("OpenAI error", await response.text());
    return null;
  }
  const responseBody = (await response.json()) as {
    output?: Array<{
      content?: Array<{ text?: string }>;
    }>;
    output_text?: string;
  };

  if (Array.isArray(responseBody.output)) {
    const combined = responseBody.output
      .flatMap((item) => item?.content ?? [])
      .map((chunk) => chunk?.text ?? "")
      .filter((chunk) => chunk && chunk.trim().length > 0)
      .join("\n")
      .trim();
    if (combined.length > 0) {
      return combined;
    }
  }
  if (typeof responseBody.output_text === "string" && responseBody.output_text.trim().length > 0) {
    return responseBody.output_text.trim();
  }

  return null;
  } catch (error) {
    console.error("OpenAI request failed", error);
    return null;
  }
}

async function handleActionBlock(text: string): Promise<{
  cleanedText: string;
  actionNote?: string;
}> {
  const actionRegex = /\[\[ACTION:(create_task)\|([^]+?)\]\]/i;
  const match = text.match(actionRegex);
  if (!match) {
    return { cleanedText: text };
  }

  const [, actionType, params] = match;
  if (!params) {
    return { cleanedText: text.replace(actionRegex, "").trim() };
  }
  const paramPairs = params.split("|").map((pair) => pair.trim());
  const paramMap = new Map<string, string>();
  for (const pair of paramPairs) {
    const [key, value] = pair.split("=").map((part) => part?.trim());
    if (key && value) {
      paramMap.set(key.toLowerCase(), value);
    }
  }

  if (actionType === "create_task") {
    const contactId = paramMap.get("contactid");
    const title = paramMap.get("title");
    if (contactId && title) {
      try {
        const res = await callAdminApi("/api/admin/crm/tasks", {
          method: "POST",
          body: JSON.stringify({
            contactId,
            title
          })
        });
        if (res.ok) {
          return {
            cleanedText: text.replace(actionRegex, "").trim(),
            actionNote: `Task created for contact ${contactId}: "${title}".`
          };
        }
        const errorText = await res.text();
        return {
          cleanedText: text.replace(actionRegex, "").trim(),
          actionNote: `Unable to create task (API error): ${errorText}`
        };
      } catch (error) {
        return {
          cleanedText: text.replace(actionRegex, "").trim(),
          actionNote: `Task creation failed: ${(error as Error).message}`
        };
      }
    }
    return {
      cleanedText: text.replace(actionRegex, "").trim(),
      actionNote: "Task action ignored: missing contactId or title."
    };
  }

  return { cleanedText: text.replace(actionRegex, "").trim() };
}

function fallbackReply(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("schedule")) {
    return "Keep an eye on the confirmed appointments section and update the pipeline after each visit.";
  }
  if (m.includes("follow-up") || m.includes("text")) {
    return "Reminder: send a friendly follow-up within 24 hours, and attach the quote link if available.";
  }
  if (m.includes("pricing")) {
    return "Pricing shifts with square footage and staining—reference the quote builder for exact totals.";
  }
  if (m.includes("task")) {
    return "Jot down tasks with clear titles, link them to the contact, and set due dates when possible.";
  }
  return "Great question! Share context like contact names or stages so we can act quickly.";
}

export async function POST(request: NextRequest): Promise<Response> {
  const { message } = (await request.json()) as { message?: string };
  const userMessage = typeof message === "string" ? message.trim() : "";
  if (!userMessage) {
    return NextResponse.json({ reply: "Please share a message to get started." }, { status: 400 });
  }

  const history = readHistory(request);
  const context = await buildContext();

  const aiReply =
    (await callOpenAI(history, userMessage, context.systemPrompt)) ?? fallbackReply(userMessage);

  const { cleanedText, actionNote } = await handleActionBlock(aiReply);

  const responseBody: AssistantResult = {
    reply: cleanedText.length ? cleanedText : fallbackReply(userMessage),
    ...(actionNote ? { actionNote } : {})
  };

  const lowerMessage = userMessage.toLowerCase();
  const wantsSchedule =
    lowerMessage.includes("schedule") ||
    lowerMessage.includes("appoint") ||
    lowerMessage.includes("job") ||
    lowerMessage.includes("crew visit") ||
    lowerMessage.includes("run sheet");
  const scheduleAvailable =
    context.scheduleText && !/unavailable/i.test(context.scheduleText) && context.scheduleText.trim().length > 0;

  let finalReply = responseBody.reply;
  if (actionNote) {
    finalReply = `${finalReply}\n\n${actionNote}`.trim();
  }
  if (wantsSchedule && scheduleAvailable) {
    finalReply = `${finalReply}\n\nToday's confirmed appointments:\n${context.scheduleText}`.trim();
  }
  responseBody.reply = finalReply;

  const updatedHistory: ChatHistoryEntry[] = [...history, { role: "user", content: userMessage }];
  if (responseBody.reply) {
    updatedHistory.push({ role: "assistant", content: responseBody.reply });
  }

  const response = NextResponse.json(responseBody);
  persistHistory(updatedHistory, response);
  return response;
}
