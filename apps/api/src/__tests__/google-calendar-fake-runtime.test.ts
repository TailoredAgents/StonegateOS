import { spawn } from "node:child_process";
import { resolve } from "node:path";

const REPOSITORY_ROOT = resolve(process.cwd(), "../..");
const port = 44_200 + (process.pid % 1_000);
const origin = `http://127.0.0.1:${port}`;
const calendarId = "private-calendar@example.test";
const eventsUrl = `${origin}/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
let server: ReturnType<typeof spawn>;
let stderr = "";
let stdout = "";

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
  options: { repeat?: number; delayMs?: number; status?: number } = {},
): Promise<Response> {
  return fetch(`${origin}/__control/scenario`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation, scenario, ...options }),
  });
}

function providerFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      Authorization: "Bearer google-calendar-test-access",
      ...(init.headers ?? {}),
    },
  });
}

beforeAll(async () => {
  server = spawn(
    process.execPath,
    [resolve(REPOSITORY_ROOT, "devops/google-calendar-fake/server.mjs")],
    {
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout?.on("data", (chunk: Buffer) => {
    stdout = `${stdout}${chunk.toString("utf8")}`.slice(-30_000);
  });
  server.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-5_000);
  });
  await waitUntilReady();
}, 10_000);

afterAll(async () => {
  if (!server || server.exitCode !== null) return;
  await new Promise<void>((resolveExit) => {
    server.once("exit", () => resolveExit());
    server.kill("SIGTERM");
    setTimeout(resolveExit, 1_000).unref();
  });
});

beforeEach(async () => {
  stdout = "";
  stderr = "";
  const response = await fetch(`${origin}/__control/reset`, { method: "POST" });
  expect(response.ok).toBe(true);
});

describe("local Google Calendar fake runtime", () => {
  it("supports token refresh and the production create/list/get/update/delete/watch contract without retaining private fields", async () => {
    const clientSecret = "private-client-secret-must-not-be-captured";
    const refreshToken = "private-refresh-token-must-not-be-captured";
    const authorization = "private-authorization-token-must-not-be-captured";
    const description = "private-event-description-must-not-be-captured";
    const attendee = "private-attendee@example.test";
    const address = "123 Private Address Must Not Be Captured";

    const tokenResponse = await fetch(`${origin}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: "google-calendar-e2e-client",
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    expect(tokenResponse.status).toBe(200);
    expect(await tokenResponse.json()).toMatchObject({
      access_token: "google-calendar-e2e-access-token",
      expires_in: 3600,
    });

    const created = await fetch(eventsUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authorization}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        summary: "Private customer appointment",
        description,
        attendees: [{ email: attendee }],
        location: address,
      }),
    });
    expect(created.status).toBe(200);
    const createdEvent = (await created.json()) as { id: string };
    expect(createdEvent.id).toMatch(/^google-calendar-e2e-/u);

    const listed = await providerFetch(
      `${eventsUrl}?timeMin=2026-08-08T00%3A00%3A00.000Z&showDeleted=true`,
    );
    expect(listed.status).toBe(200);
    const listedPayload = (await listed.json()) as {
      items: Array<{ id: string }>;
      nextSyncToken: string;
    };
    expect(listedPayload.nextSyncToken).toBe("sync-e2e-next");
    expect(listedPayload.items.map((event) => event.id)).toContain(
      createdEvent.id,
    );

    const eventUrl = `${eventsUrl}/${createdEvent.id}`;
    expect((await providerFetch(eventUrl)).status).toBe(200);
    expect(
      (
        await providerFetch(eventUrl, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ description, location: address }),
        })
      ).status,
    ).toBe(200);
    const watched = await providerFetch(`${eventsUrl}/watch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, token: authorization }),
    });
    expect(watched.status).toBe(200);
    expect(await watched.json()).toMatchObject({
      resourceId: "google-calendar-e2e-resource",
    });
    expect((await providerFetch(eventUrl, { method: "DELETE" })).status).toBe(
      204,
    );
    expect((await providerFetch(eventUrl)).status).toBe(404);

    const evidence = await fetch(`${origin}/__control/requests`).then(
      (response) =>
        response.json() as Promise<{
          requests: Array<Record<string, unknown>>;
        }>,
    );
    expect(evidence.requests.map((entry) => entry["operation"])).toEqual(
      expect.arrayContaining([
        "token",
        "create",
        "list",
        "get",
        "update",
        "delete",
        "watch",
      ]),
    );
    expect(
      evidence.requests.find((entry) => entry["operation"] === "list"),
    ).toMatchObject({ queryKeys: ["showDeleted", "timeMin"] });
    const serialized = JSON.stringify(evidence);
    for (const privateValue of [
      clientSecret,
      refreshToken,
      authorization,
      description,
      attendee,
      address,
      calendarId,
      createdEvent.id,
    ]) {
      expect(serialized).not.toContain(privateValue);
      expect(stdout).not.toContain(privateValue);
      expect(stderr).not.toContain(privateValue);
    }
  });

  it("covers 401, 403, 404, 409, 429, and configurable 5xx responses", async () => {
    const cases = [
      { operation: "token", scenario: "unauthorized", status: 401 },
      { operation: "create", scenario: "forbidden", status: 403 },
      { operation: "get", scenario: "not_found", status: 404 },
      { operation: "update", scenario: "conflict", status: 409 },
      { operation: "list", scenario: "rate_limited", status: 429 },
    ] as const;

    for (const entry of cases) {
      expect((await setScenario(entry.operation, entry.scenario)).status).toBe(
        200,
      );
      const response =
        entry.operation === "token"
          ? await fetch(`${origin}/token`, { method: "POST" })
          : entry.operation === "create"
            ? await providerFetch(eventsUrl, { method: "POST" })
            : entry.operation === "list"
              ? await providerFetch(eventsUrl)
              : await providerFetch(
                  `${eventsUrl}/google-calendar-e2e-seeded`,
                  entry.operation === "update" ? { method: "PATCH" } : {},
                );
      expect(response.status).toBe(entry.status);
    }

    expect(
      (await setScenario("watch", "provider_error", { status: 503 })).status,
    ).toBe(200);
    expect(
      (
        await providerFetch(`${eventsUrl}/watch`, {
          method: "POST",
        })
      ).status,
    ).toBe(503);
    expect(
      (await setScenario("delete", "provider_error", { status: 502 })).status,
    ).toBe(200);
    expect(
      (
        await providerFetch(`${eventsUrl}/google-calendar-e2e-seeded`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(502);
  });

  it("supports malformed, empty, timeout, and one-shot recovery scenarios", async () => {
    await setScenario("token", "malformed_json");
    const malformed = await fetch(`${origin}/token`, { method: "POST" });
    expect(malformed.status).toBe(200);
    expect(await malformed.text()).toBe("{malformed-json");

    await setScenario("list", "empty_success");
    const empty = await providerFetch(eventsUrl);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({
      items: [],
      nextSyncToken: "sync-e2e-empty",
    });

    await setScenario("get", "timeout", { delayMs: 200 });
    await expect(
      providerFetch(`${eventsUrl}/google-calendar-e2e-seeded`, {
        signal: AbortSignal.timeout(25),
      }),
    ).rejects.toThrow();

    await setScenario("create", "conflict", { repeat: 1 });
    expect((await providerFetch(eventsUrl, { method: "POST" })).status).toBe(
      409,
    );
    expect((await providerFetch(eventsUrl, { method: "POST" })).status).toBe(
      200,
    );
  });

  it("bounds retained evidence and reset clears requests, scenarios, and event state", async () => {
    for (let batch = 0; batch < 11; batch += 1) {
      await Promise.all(
        Array.from({ length: 10 }, () => providerFetch(eventsUrl)),
      );
    }

    const beforeReset = await fetch(`${origin}/__control/requests`).then(
      (response) =>
        response.json() as Promise<{
          requests: unknown[];
          retained: number;
          limit: number;
        }>,
    );
    expect(beforeReset.limit).toBe(100);
    expect(beforeReset.retained).toBe(100);
    expect(beforeReset.requests).toHaveLength(100);

    await setScenario("list", "provider_error");
    await providerFetch(eventsUrl, { method: "POST" });
    await fetch(`${origin}/__control/reset`, { method: "POST" });

    const afterReset = await fetch(`${origin}/__control/requests`).then(
      (response) => response.json() as Promise<{ requests: unknown[] }>,
    );
    expect(afterReset.requests).toEqual([]);
    expect((await providerFetch(eventsUrl)).status).toBe(200);
    const events = (await providerFetch(eventsUrl).then((response) =>
      response.json(),
    )) as { items: Array<{ id: string }> };
    expect(events.items.map((event) => event.id)).toEqual([
      "google-calendar-e2e-seeded",
    ]);
  });
});
