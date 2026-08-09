import { spawn } from "node:child_process";
import { resolve } from "node:path";
import {
  resetEmailProviderTransportForTests,
  sendEmailThroughProvider,
} from "@/lib/email-provider";

const ROOT = resolve(process.cwd(), "../..");
const smtpPort = 50_200 + (process.pid % 500);
const httpPort = 50_700 + (process.pid % 500);
const controlOrigin = `http://127.0.0.1:${httpPort}`;
const environment = {
  NODE_ENV: "test",
  SMTP_HOST: "127.0.0.1",
  SMTP_PORT: String(smtpPort),
  SMTP_USER: "email-fake-user",
  SMTP_PASS: "email-fake-password",
  SMTP_FROM: "Stonegate <ops@stonegate.test>",
  SMTP_TIMEOUT_MS: "500",
};
let server: ReturnType<typeof spawn>;
let stdout = "";
let stderr = "";

async function waitUntilReady(): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`Email fake exited early: ${stderr}`);
    }
    try {
      const response = await fetch(`${controlOrigin}/healthz`);
      if (response.ok) return;
    } catch {
      // The loopback listeners may still be binding.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`Email fake did not become ready: ${stderr}`);
}

async function setScenario(
  scenario: string,
  options: { repeat?: number; delayMs?: number } = {},
): Promise<void> {
  const response = await fetch(`${controlOrigin}/__control/scenario`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation: "send_email", scenario, ...options }),
  });
  expect(response.status).toBe(200);
}

function send(
  overrides: Partial<Parameters<typeof sendEmailThroughProvider>[0]> = {},
  environmentOverrides: Record<string, string> = {},
) {
  return sendEmailThroughProvider(
    {
      to: "recipient@stonegate.test",
      subject: "Deterministic email",
      text: "Metadata-only provider contract.",
      idempotencyKey: "email-provider-runtime-attempt",
      ...overrides,
    },
    { ...environment, ...environmentOverrides },
  );
}

beforeAll(async () => {
  server = spawn(
    process.execPath,
    [resolve(ROOT, "devops/email-fake/server.mjs")],
    {
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        HTTP_PORT: String(httpPort),
        SMTP_PORT: String(smtpPort),
        EMAIL_FAKE_FORWARD_SMTP_HOST: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout?.on("data", (chunk: Buffer) => {
    stdout = `${stdout}${chunk.toString("utf8")}`.slice(-10_000);
  });
  server.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-10_000);
  });
  await waitUntilReady();
}, 10_000);

afterAll(async () => {
  resetEmailProviderTransportForTests();
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
  resetEmailProviderTransportForTests();
  expect(
    (await fetch(`${controlOrigin}/__control/reset`, { method: "POST" })).ok,
  ).toBe(true);
});

describe("deterministic email fake runtime", () => {
  it("reports complete provider acceptance without claiming mailbox delivery", async () => {
    const result = await send();
    expect(result).toMatchObject({
      ok: true,
      deliveryCertainty: "accepted",
      acceptedRecipientCount: 1,
      rejectedRecipientCount: 0,
      detail: null,
    });
    expect(result.providerMessageId).toMatch(
      /^<[a-f0-9]{64}@dispatch\.stonegate\.local>$/u,
    );
  });

  it.each([
    ["temporary_rejection", "email_rejected:temporary"],
    ["permanent_rejection", "email_rejected:permanent"],
    ["data_temporary_error", "email_rejected:temporary"],
    ["data_permanent_error", "email_rejected:permanent"],
  ])(
    "classifies explicit SMTP rejection %s as known non-delivery",
    async (scenario, detail) => {
      await setScenario(scenario);
      await expect(send()).resolves.toMatchObject({
        ok: false,
        deliveryCertainty: "rejected",
        detail,
      });
    },
  );

  it("quarantines mixed-recipient acceptance as ambiguous", async () => {
    await setScenario("partial_acceptance");
    await expect(
      send({
        to: ["first@stonegate.test", "second@stonegate.test"],
      }),
    ).resolves.toMatchObject({
      ok: false,
      deliveryCertainty: "ambiguous",
      acceptedRecipientCount: 1,
      rejectedRecipientCount: 1,
      detail: "email_partial_acceptance",
    });
  });

  it.each(["disconnect_after_send", "timeout", "malformed_response"])(
    "quarantines %s after DATA as ambiguous",
    async (scenario) => {
      await setScenario(
        scenario,
        scenario === "timeout" ? { delayMs: 300 } : {},
      );
      await expect(send({}, { SMTP_TIMEOUT_MS: "100" })).resolves.toMatchObject(
        {
          ok: false,
          deliveryCertainty: "ambiguous",
          detail: "email_delivery_ambiguous",
        },
      );
    },
  );

  it("supports reset and deterministic one-shot recovery", async () => {
    await setScenario("permanent_rejection", { repeat: 1 });
    expect((await send()).deliveryCertainty).toBe("rejected");
    expect((await send()).deliveryCertainty).toBe("accepted");

    await setScenario("temporary_rejection");
    await fetch(`${controlOrigin}/__control/reset`, { method: "POST" });
    expect((await send()).deliveryCertainty).toBe("accepted");
  });

  it("reset destroys and generation-isolates in-flight SMTP work", async () => {
    await setScenario("timeout", { delayMs: 300 });
    const inFlight = send({}, { SMTP_TIMEOUT_MS: "1000" });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    await fetch(`${controlOrigin}/__control/reset`, { method: "POST" });
    expect((await inFlight).deliveryCertainty).toBe("ambiguous");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 350));
    const evidence = await fetch(`${controlOrigin}/__control/requests`).then(
      (response) => response.json() as Promise<{ requests: Array<unknown> }>,
    );
    expect(evidence.requests).toEqual([]);
  });

  it("accepts a near-limit message and rejects estimated MIME overflow", async () => {
    await expect(send({ text: "x".repeat(160 * 1024) })).resolves.toMatchObject(
      {
        ok: true,
        deliveryCertainty: "accepted",
      },
    );
    await expect(send({ text: "x".repeat(175 * 1024) })).resolves.toMatchObject(
      {
        ok: false,
        deliveryCertainty: "rejected",
        detail: "email_request_invalid",
      },
    );
  });

  it("fails startup before an arbitrary SMTP relay can be used", async () => {
    const rogue = spawn(
      process.execPath,
      [resolve(ROOT, "devops/email-fake/server.mjs")],
      {
        env: {
          ...process.env,
          HOST: "127.0.0.1",
          HTTP_PORT: String(httpPort + 2_000),
          SMTP_PORT: String(smtpPort + 2_000),
          EMAIL_FAKE_FORWARD_SMTP_HOST: "smtp.live.example",
          EMAIL_FAKE_FORWARD_SMTP_PORT: "587",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let rogueError = "";
    rogue.stderr?.on("data", (chunk: Buffer) => {
      rogueError += chunk.toString("utf8");
    });
    const code = await new Promise<number | null>((resolveExit) => {
      rogue.once("exit", resolveExit);
    });
    expect(code).not.toBe(0);
    expect(rogueError).toContain("approved local MailHog target");
    expect(rogueError).not.toContain("smtp.live.example");
  });

  it("retains bounded metadata without private message values", async () => {
    const privateValues = [
      "private-recipient@stonegate.test",
      "Private operational subject",
      "https://stonegate.test/private/token-value",
      "private-dispatch-identifier-suffix-1234",
      "email-fake-password",
    ];
    const result = await send({
      to: privateValues[0],
      subject: privateValues[1],
      text: privateValues[2],
      idempotencyKey: privateValues[3],
      attachments: [
        {
          filename: "appointment.ics",
          content: "BEGIN:VCALENDAR\r\nEND:VCALENDAR",
          contentType: "text/calendar; charset=utf-8",
        },
      ],
    });
    expect(result.deliveryCertainty).toBe("accepted");

    const response = await fetch(`${controlOrigin}/__control/requests`);
    const evidence = (await response.json()) as {
      requests: Array<Record<string, unknown>>;
      retained: number;
      limit: number;
    };
    expect(evidence.limit).toBe(100);
    expect(evidence.retained).toBe(1);
    expect(evidence.requests[0]).toMatchObject({
      operation: "send_email",
      recipientCount: 1,
      acceptedRecipientCount: 1,
      subjectHeaderPresent: true,
      messageIdHeaderPresent: true,
      dispatchHeaderPresent: true,
      attachmentHeaderPresent: true,
      outcome: "accepted",
    });
    const observable = `${JSON.stringify(evidence)}\n${stdout}\n${stderr}`;
    for (const privateValue of privateValues) {
      expect(observable).not.toContain(privateValue);
    }
  });

  it("rejects unsafe message inputs before contacting SMTP", async () => {
    for (const overrides of [
      { to: "victim@stonegate.test\r\nBcc: other@stonegate.test" },
      { subject: "subject\r\nBcc: other@stonegate.test" },
      { text: "x".repeat(256 * 1024 + 1) },
      {
        attachments: [
          {
            filename: "../../secret.txt",
            content: "secret",
            contentType: "text/plain",
          },
        ],
      },
      { idempotencyKey: "unsafe key with spaces" },
    ]) {
      await expect(send(overrides)).resolves.toMatchObject({
        ok: false,
        deliveryCertainty: "rejected",
        detail: "email_request_invalid",
      });
    }
    const evidence = await fetch(`${controlOrigin}/__control/requests`).then(
      (response) => response.json() as Promise<{ requests: Array<unknown> }>,
    );
    expect(evidence.requests).toEqual([]);
  });
});
