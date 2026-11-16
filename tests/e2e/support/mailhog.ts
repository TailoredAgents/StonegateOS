import { getOptionalEnvVar } from "./env";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { decodeMailBody } from "./mailhog-body";

const mailhogBase = (
  getOptionalEnvVar("MAILHOG_UI", "http://localhost:8025") ??
  "http://localhost:8025"
).replace(/\/$/, "");

type MailHogItem = {
  ID: string;
  Content: {
    Headers: Record<string, string[]>;
    Body: string;
  };
};

type MailHogResponse = {
  total: number;
  count: number;
  start: number;
  items: MailHogItem[];
};

function decodedMessage(item: MailHogItem): MailHogItem {
  return {
    ...item,
    Content: {
      ...item.Content,
      Body: decodeMailBody(item.Content.Body, item.Content.Headers),
    },
  };
}

export async function fetchLatestMail(): Promise<MailHogItem | null> {
  const response = await fetch(`${mailhogBase}/api/v2/messages`);
  if (!response.ok) {
    throw new Error(`Failed to read MailHog messages (${response.status})`);
  }
  const body = (await response.json()) as MailHogResponse;
  return body.items[0] ? decodedMessage(body.items[0]) : null;
}

export async function clearMailhog(): Promise<void> {
  const response = await fetch(`${mailhogBase}/api/v1/messages`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error(`Failed to clear MailHog messages (${response.status})`);
  }
}

export async function waitForMailhogMessage(
  matcher: (item: MailHogItem) => boolean,
  {
    timeoutMs = 15_000,
    intervalMs = 500,
  }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<MailHogItem> {
  const start = Date.now();
  let lastMessages: MailHogResponse | null = null;
  while (Date.now() - start < timeoutMs) {
    const response = await fetch(`${mailhogBase}/api/v2/messages`);
    if (response.ok) {
      const body = (await response.json()) as MailHogResponse;
      lastMessages = body;
      // Check ALL messages, not just the latest
      for (const item of body.items) {
        const decoded = decodedMessage(item);
        if (matcher(decoded)) {
          return decoded;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  // E2E runtime safety requires local provider fakes. Keep diagnostic mail in
  // test artifacts so a MIME mismatch can be distinguished from no delivery.
  await mkdir("artifacts/e2e/mailhog", { recursive: true });
  await writeFile(
    `artifacts/e2e/mailhog/timeout-${randomUUID()}.json`,
    JSON.stringify(lastMessages, null, 2),
    { mode: 0o600 },
  );
  throw new Error("Timed out waiting for MailHog message");
}
