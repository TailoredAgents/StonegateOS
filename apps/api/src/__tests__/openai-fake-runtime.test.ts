import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { ExpenseReceiptExtractionSchema } from "@/lib/expense-receipt-domain";
import { EXPENSE_RECEIPT_EXTRACTION_JSON_SCHEMA } from "@/lib/expense-receipt-openai";

const REPOSITORY_ROOT = resolve(process.cwd(), "../..");
const port = 43_200 + (process.pid % 1_000);
const origin = `http://127.0.0.1:${port}`;
let server: ReturnType<typeof spawn>;
let stderr = "";
let stdout = "";

async function waitUntilReady(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`OpenAI fake exited early: ${stderr}`);
    }
    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.ok) return;
    } catch {
      // The process may still be binding its loopback socket.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`OpenAI fake did not become ready: ${stderr}`);
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

beforeAll(async () => {
  server = spawn(
    process.execPath,
    [resolve(REPOSITORY_ROOT, "devops/openai-fake/server.mjs")],
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

describe("local OpenAI fake runtime", () => {
  it("returns a valid strict receipt extraction without retaining image data", async () => {
    const imageMarker = "private-receipt-image-must-not-be-captured";
    const response = await fetch(`${origin}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-e2e",
        store: false,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_image",
                image_url: `data:image/jpeg;base64,${imageMarker}`,
              },
            ],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "expense_receipt_extraction",
            strict: true,
            schema: EXPENSE_RECEIPT_EXTRACTION_JSON_SCHEMA,
          },
        },
      }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { output_text: string };
    expect(
      ExpenseReceiptExtractionSchema.safeParse(
        JSON.parse(payload.output_text) as unknown,
      ).success,
    ).toBe(true);

    const captures = await fetch(`${origin}/__control/requests`).then(
      (result) => result.json() as Promise<{ requests: unknown[] }>,
    );
    expect(JSON.stringify(captures)).not.toContain(imageMarker);
    expect(stdout).not.toContain(imageMarker);
  });

  it("returns Responses API text and schema-shaped output without capturing prompts or secrets", async () => {
    const secret = "sk-this-must-never-be-captured";
    const prompt = "customer-private-prompt-must-not-be-captured";
    const response = await fetch(`${origin}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-e2e",
        input: [{ role: "user", content: prompt }],
        text: {
          format: {
            type: "json_schema",
            name: "e2e_result",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                summary: { type: "string", minLength: 20 },
                confidence: { type: "number", minimum: 0, maximum: 1 },
              },
              required: ["summary", "confidence"],
            },
          },
        },
      }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      output_text: string;
      output: Array<{ content: Array<{ type: string; text: string }> }>;
    };
    const output: unknown = JSON.parse(payload.output_text);
    expect(typeof output).toBe("object");
    expect(output).not.toBeNull();
    const outputRecord = output as Record<string, unknown>;
    expect(outputRecord["confidence"]).toBe(0.75);
    expect(outputRecord["summary"]).toEqual(expect.any(String));
    expect(outputRecord["summary"]).toMatch(/Deterministic E2E/u);
    expect(payload.output[0]?.content[0]?.type).toBe("output_text");

    const captures = await fetch(`${origin}/__control/requests`).then(
      (result) => result.json() as Promise<{ requests: unknown[] }>,
    );
    const serialized = JSON.stringify(captures);
    expect(serialized).toContain('"authorization":"bearer"');
    expect(serialized).toContain('"schemaName":"e2e_result"');
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(prompt);
    expect(stdout).not.toContain(secret);
    expect(stdout).not.toContain(prompt);
  });

  it("honors every SEO brief length and outline cardinality constraint", async () => {
    const response = await fetch(`${origin}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-e2e",
        input: [],
        text: {
          format: {
            type: "json_schema",
            name: "blog_brief",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: { type: "string", minLength: 10, maxLength: 90 },
                metaDescription: {
                  type: "string",
                  minLength: 50,
                  maxLength: 170,
                },
                excerpt: { type: "string", minLength: 40, maxLength: 240 },
                outline: {
                  type: "array",
                  minItems: 4,
                  maxItems: 10,
                  items: { type: "string", minLength: 3, maxLength: 80 },
                },
              },
              required: ["title", "metaDescription", "excerpt", "outline"],
            },
          },
        },
      }),
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { output_text: string };
    const brief = JSON.parse(payload.output_text) as {
      title: string;
      metaDescription: string;
      excerpt: string;
      outline: string[];
    };
    expect(brief.title.length).toBeGreaterThanOrEqual(10);
    expect(brief.title.length).toBeLessThanOrEqual(90);
    expect(brief.metaDescription.length).toBeGreaterThanOrEqual(50);
    expect(brief.metaDescription.length).toBeLessThanOrEqual(170);
    expect(brief.excerpt.length).toBeGreaterThanOrEqual(40);
    expect(brief.excerpt.length).toBeLessThanOrEqual(240);
    expect(brief.outline).toHaveLength(4);
    expect(
      brief.outline.every((item) => item.length >= 3 && item.length <= 80),
    ).toBe(true);
  });

  it("supports deterministic one-shot provider errors and automatic recovery", async () => {
    const configured = await setScenario({
      endpoint: "responses",
      scenario: "rate_limited",
      repeat: 1,
    });
    expect(configured.status).toBe(200);

    const first = await fetch(`${origin}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-e2e", input: [] }),
    });
    expect(first.status).toBe(429);
    expect(await first.json()).toMatchObject({
      error: { code: "rate_limit_exceeded" },
    });

    const second = await fetch(`${origin}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-e2e", input: [] }),
    });
    expect(second.status).toBe(200);

    await setScenario({
      endpoint: "responses",
      scenario: "provider_error",
    });
    const providerFailure = await fetch(`${origin}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-e2e", input: [] }),
    });
    expect(providerFailure.status).toBe(500);
    expect(await providerFailure.json()).toMatchObject({
      error: { code: "provider_error" },
    });
  });

  it("supports malformed responses and transcription success without retaining audio", async () => {
    await setScenario({
      endpoint: "responses",
      scenario: "malformed_json",
    });
    const malformed = await fetch(`${origin}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-e2e", input: [] }),
    });
    expect(malformed.status).toBe(200);
    expect(await malformed.text()).toBe("{malformed-json");

    const audioMarker = "private-audio-marker-must-not-be-captured";
    const form = new FormData();
    form.set("model", "gpt-4o-mini-transcribe");
    form.set("prompt", "private transcription prompt");
    form.set(
      "file",
      new Blob([audioMarker], { type: "audio/webm" }),
      "note.webm",
    );
    const transcription = await fetch(`${origin}/v1/audio/transcriptions`, {
      method: "POST",
      body: form,
    });
    expect(transcription.status).toBe(200);
    expect(await transcription.json()).toMatchObject({
      text: "Deterministic local transcription.",
    });

    const captures = await fetch(`${origin}/__control/requests`).then(
      (result) => result.json() as Promise<{ requests: unknown[] }>,
    );
    const serialized = JSON.stringify(captures);
    expect(serialized).toContain('"multipart":true');
    expect(serialized).not.toContain(audioMarker);
    expect(serialized).not.toContain("private transcription prompt");
    expect(stdout).not.toContain(audioMarker);
    expect(stdout).not.toContain("private transcription prompt");
  });

  it("bounds retained request metadata and reset clears all state", async () => {
    for (let batch = 0; batch < 11; batch += 1) {
      await Promise.all(
        Array.from({ length: 10 }, () =>
          fetch(`${origin}/v1/responses`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: "gpt-e2e", input: [] }),
          }),
        ),
      );
    }

    const beforeReset = await fetch(`${origin}/__control/requests`).then(
      (result) =>
        result.json() as Promise<{
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
      (result) => result.json() as Promise<{ requests: unknown[] }>,
    );
    expect(afterReset.requests).toEqual([]);
  });
});
