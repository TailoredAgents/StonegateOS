import { spawn } from "node:child_process";
import { resolve } from "node:path";
import {
  buildGoogleCalendarEventId,
  createCalendarEvent,
  deleteCalendarEvent,
  updateCalendarEvent,
  type AppointmentCalendarPayload,
} from "@/lib/calendar";

const REPOSITORY_ROOT = resolve(process.cwd(), "../..");
const port = 45_200 + (process.pid % 1_000);
const origin = `http://127.0.0.1:${port}`;
let server: ReturnType<typeof spawn>;
let stderr = "";

const originalEnvironment = {
  E2E_RUN_ID: process.env["E2E_RUN_ID"],
  GOOGLE_CALENDAR_ENABLED: process.env["GOOGLE_CALENDAR_ENABLED"],
  GOOGLE_CLIENT_ID: process.env["GOOGLE_CLIENT_ID"],
  GOOGLE_CLIENT_SECRET: process.env["GOOGLE_CLIENT_SECRET"],
  GOOGLE_REFRESH_TOKEN: process.env["GOOGLE_REFRESH_TOKEN"],
  GOOGLE_CALENDAR_ID: process.env["GOOGLE_CALENDAR_ID"],
  GOOGLE_CALENDAR_API_BASE_URL: process.env["GOOGLE_CALENDAR_API_BASE_URL"],
  GOOGLE_CALENDAR_TOKEN_URL: process.env["GOOGLE_CALENDAR_TOKEN_URL"],
};

const payload: AppointmentCalendarPayload = {
  appointmentId: "00000000-0000-4000-8000-000000000099",
  startAt: new Date("2026-08-08T15:00:00.000Z"),
  durationMinutes: 90,
  travelBufferMinutes: 15,
  services: ["Deterministic E2E service"],
  notes: "Private adapter note",
  contact: {
    name: "Private Adapter Customer",
    email: "private-adapter@example.test",
    phone: "+15555550123",
  },
  property: {
    addressLine1: "123 Private Adapter Street",
    city: "Test City",
    state: "NY",
    postalCode: "10001",
  },
};

async function waitUntilReady(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`Google Calendar fake exited early: ${stderr}`);
    }
    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.ok) return;
    } catch {
      // The process may still be binding its loopback socket.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`Google Calendar fake did not become ready: ${stderr}`);
}

async function setScenario(
  operation: string,
  scenario: string,
  repeat?: number,
): Promise<void> {
  const response = await fetch(`${origin}/__control/scenario`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation, scenario, repeat }),
  });
  expect(response.status).toBe(200);
}

beforeAll(async () => {
  process.env["E2E_RUN_ID"] = "calendar-production-adapter";
  process.env["GOOGLE_CALENDAR_ENABLED"] = "1";
  process.env["GOOGLE_CLIENT_ID"] = "google-calendar-e2e-client";
  process.env["GOOGLE_CLIENT_SECRET"] = "google-calendar-e2e-client-secret";
  process.env["GOOGLE_REFRESH_TOKEN"] = "google-calendar-e2e-refresh-token";
  process.env["GOOGLE_CALENDAR_ID"] = "google-calendar-e2e-calendar";
  process.env["GOOGLE_CALENDAR_API_BASE_URL"] = `${origin}/calendar/v3`;
  process.env["GOOGLE_CALENDAR_TOKEN_URL"] = `${origin}/token`;

  server = spawn(
    process.execPath,
    [resolve(REPOSITORY_ROOT, "devops/google-calendar-fake/server.mjs")],
    {
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  server.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-5_000);
  });
  await waitUntilReady();
}, 10_000);

afterAll(async () => {
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  if (!server || server.exitCode !== null) return;
  await new Promise<void>((resolveExit) => {
    server.once("exit", () => resolveExit());
    server.kill("SIGTERM");
    setTimeout(resolveExit, 1_000).unref();
  });
});

describe("production Google Calendar adapter against deterministic provider", () => {
  it("refreshes a token and routes create, update, delete, and retry outcomes through the configured boundary", async () => {
    await setScenario("token", "rate_limited", 1);
    expect(await createCalendarEvent(payload)).toBeNull();

    const eventId = await createCalendarEvent(payload);
    expect(eventId).toBe(buildGoogleCalendarEventId(payload.appointmentId));

    // Repeating a create after a lost response converges on the same event.
    expect(await createCalendarEvent(payload)).toBe(eventId);

    await setScenario("create", "empty_success", 1);
    expect(await createCalendarEvent(payload)).toBeNull();

    process.env["GOOGLE_CALENDAR_TOKEN_URL"] =
      "https://oauth2.googleapis.com/token";
    expect(await createCalendarEvent(payload)).toBeNull();
    process.env["GOOGLE_CALENDAR_TOKEN_URL"] = `${origin}/token`;

    expect(await updateCalendarEvent(eventId!, payload)).toBe(true);

    await setScenario("update", "empty_success", 1);
    expect(await updateCalendarEvent(eventId!, payload)).toBe(false);

    await setScenario("update", "conflict", 1);
    expect(await updateCalendarEvent(eventId!, payload)).toBe(false);
    expect(await updateCalendarEvent(eventId!, payload)).toBe(true);

    expect(await deleteCalendarEvent(eventId!)).toBe(true);
    expect(await updateCalendarEvent(eventId!, payload)).toBe(false);
    expect(await deleteCalendarEvent(eventId!)).toBe(true);

    const evidence = await fetch(`${origin}/__control/requests`).then(
      (response) =>
        response.json() as Promise<{
          requests: Array<{ operation: string }>;
        }>,
    );
    expect(evidence.requests.map((request) => request.operation)).toEqual(
      expect.arrayContaining(["token", "create", "update", "delete"]),
    );
    expect(
      evidence.requests.filter((request) => request.operation === "token"),
    ).toHaveLength(2);
  });
});
