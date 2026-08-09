import { spawn } from "node:child_process";
import { resolve } from "node:path";

const REPOSITORY_ROOT = resolve(process.cwd(), "../..");
const port = 44_200 + (process.pid % 1_000);
const origin = `http://127.0.0.1:${port}`;
let server: ReturnType<typeof spawn>;
let stderr = "";
let stdout = "";

async function waitUntilReady(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`Meta fake exited early: ${stderr}`);
    }
    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.ok) return;
    } catch {
      // The process may still be binding its loopback socket.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`Meta fake did not become ready: ${stderr}`);
}

async function setScenario(
  payload: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${origin}/__control/scenario`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function sendMessenger(
  body: Record<string, unknown>,
  token = "private-meta-token-must-not-be-captured",
): Promise<Response> {
  return fetch(`${origin}/v24.0/me/messages?access_token=${token}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Stonegate-Dispatch-Id": "private-dispatch-id",
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  server = spawn(
    process.execPath,
    [resolve(REPOSITORY_ROOT, "devops/meta-fake/server.mjs")],
    {
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout?.on("data", (chunk: Buffer) => {
    stdout = `${stdout}${chunk.toString("utf8")}`.slice(-20_000);
  });
  server.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2_000);
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
  const response = await fetch(`${origin}/__control/reset`, { method: "POST" });
  expect(response.ok).toBe(true);
});

describe("local Meta Graph fake runtime", () => {
  it("implements every active Graph operation without retaining private request data", async () => {
    const recipientId = "psid-private-recipient-987654321";
    const messageBody = "private customer message must never be captured";
    const mediaUrl = "https://customer.example/private-photo.jpg?secret=yes";
    const token = "private-meta-token-must-not-be-captured";

    expect(
      (
        await sendMessenger(
          { recipient: { id: recipientId }, message: { text: messageBody } },
          token,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await sendMessenger({
          recipient: { id: recipientId },
          sender_action: "typing_on",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await sendMessenger({
          recipient: { id: recipientId },
          message: {
            attachment: {
              type: "image",
              payload: { url: mediaUrl, is_reusable: true },
            },
          },
        })
      ).status,
    ).toBe(200);

    const pageToken = await fetch(
      `${origin}/v24.0/page-private-123456?fields=id,name,access_token&access_token=${token}`,
    );
    expect(await pageToken.json()).toMatchObject({
      access_token: "e2e-meta-page-token",
    });
    expect(
      (
        await fetch(
          `${origin}/v24.0/sender-private-123456?fields=id,name,first_name,last_name&access_token=${token}`,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(
          `${origin}/v24.0/lead-private-123456?fields=created_time,field_data,form_id&access_token=${token}`,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(
          `${origin}/debug_token?input_token=${token}&access_token=private-app-secret`,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(
          `${origin}/v24.0/page-private-123456/subscribed_apps?access_token=${token}`,
        )
      ).status,
    ).toBe(200);

    const insights = await fetch(
      `${origin}/v24.0/act_000000000000001/insights?access_token=${token}`,
    );
    const firstPage = (await insights.json()) as {
      data: unknown[];
      paging?: { next?: string };
    };
    expect(firstPage.data).toHaveLength(1);
    expect(firstPage.paging?.next).toContain(`${origin}/v24.0/act_`);
    expect((await fetch(firstPage.paging?.next ?? "")).status).toBe(200);

    const conversions = await fetch(
      `${origin}/v24.0/dataset-private-123456/events?access_token=${token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          data: [{ event_name: "Lead", customer_name: "Private Customer" }],
        }),
      },
    );
    expect(await conversions.json()).toMatchObject({ events_received: 1 });

    const evidence = await fetch(`${origin}/__control/requests`).then(
      (response) =>
        response.json() as Promise<{
          requests: Array<Record<string, unknown>>;
        }>,
    );
    expect(evidence.requests.map((item) => item["operation"])).toEqual(
      expect.arrayContaining([
        "messenger.message",
        "messenger.typing",
        "messenger.media",
        "page_token.lookup",
        "identity.lookup",
        "lead.lookup",
        "token.debug",
        "page.subscriptions",
        "ads.insights",
        "conversions.events",
      ]),
    );
    const serialized = JSON.stringify(evidence);
    for (const privateValue of [
      recipientId,
      messageBody,
      mediaUrl,
      token,
      "private-app-secret",
      "Private Customer",
      "private-dispatch-id",
    ]) {
      expect(serialized).not.toContain(privateValue);
      expect(stdout).not.toContain(privateValue);
      expect(stderr).not.toContain(privateValue);
    }
    expect(serialized).not.toContain("recipientIdSuffix");
    expect(serialized).not.toContain("targetIdSuffix");
    expect(serialized).toContain('"hasMediaUrl":true');
    expect(serialized).toContain('"credentialLocation":"query"');
  });

  it.each([
    ["oauth_denied", 401],
    ["permission_denied", 403],
    ["not_found", 404],
    ["conflict", 409],
    ["rate_limited", 429],
    ["provider_error", 503],
  ])("serves deterministic %s failures", async (name, expectedStatus) => {
    const configured = await setScenario({
      name,
      operation: "messenger.message",
    });
    expect(configured.status).toBe(200);
    const response = await sendMessenger({
      recipient: { id: "recipient-e2e" },
      message: { text: "E2E" },
    });
    expect(response.status).toBe(expectedStatus);
    expect(await response.json()).toMatchObject({
      error: { fbtrace_id: "meta-e2e-trace" },
    });
  });

  it("supports one-shot recovery, malformed, empty, and timeout responses", async () => {
    await setScenario({
      name: "rate_limited",
      operation: "messenger.message",
      repeat: 1,
    });
    const payload = {
      recipient: { id: "recipient-e2e" },
      message: { text: "E2E" },
    };
    expect((await sendMessenger(payload)).status).toBe(429);
    expect((await sendMessenger(payload)).status).toBe(200);

    await setScenario({
      name: "malformed_json",
      operation: "page_token.lookup",
    });
    const malformed = await fetch(
      `${origin}/v24.0/page-e2e?fields=access_token&access_token=e2e`,
    );
    expect(malformed.status).toBe(200);
    expect(await malformed.text()).toBe("{malformed-json");

    await setScenario({
      name: "empty_success",
      operation: "messenger.message",
    });
    expect(await (await sendMessenger(payload)).json()).toEqual({});

    await setScenario({
      name: "timeout",
      operation: "messenger.message",
      delayMs: 10,
    });
    await expect(sendMessenger(payload)).rejects.toThrow();
  });

  it("models a partial media fan-out and recovers after the selected item", async () => {
    await setScenario({
      name: "media_partial_failure",
      operation: "messenger.media",
      mediaFailureAt: 2,
    });
    const media = (index: number) => ({
      recipient: { id: "recipient-e2e" },
      message: {
        attachment: {
          type: "image",
          payload: {
            url: `https://example.test/private-${index}.jpg`,
            is_reusable: true,
          },
        },
      },
    });

    expect((await sendMessenger(media(1))).status).toBe(200);
    expect((await sendMessenger(media(2))).status).toBe(503);
    expect((await sendMessenger(media(3))).status).toBe(200);
  });

  it("bounds evidence and reset clears all retained state", async () => {
    for (let batch = 0; batch < 11; batch += 1) {
      await Promise.all(
        Array.from({ length: 10 }, () =>
          fetch(`${origin}/v24.0/sender-e2e?fields=id,name&access_token=e2e`),
        ),
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

    await fetch(`${origin}/__control/reset`, { method: "POST" });
    const afterReset = await fetch(`${origin}/__control/requests`).then(
      (response) => response.json() as Promise<{ requests: unknown[] }>,
    );
    expect(afterReset.requests).toEqual([]);
  });
});
