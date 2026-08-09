import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(process.cwd(), "../..");

function source(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

function sourceFiles(directory: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(directory)) {
    if ([".next", "dist", "node_modules"].includes(entry)) continue;
    const absolute = join(directory, entry);
    if (statSync(absolute).isDirectory()) {
      results.push(...sourceFiles(absolute));
    } else if (/\.(?:js|mjs|ts|tsx)$/u.test(entry)) {
      results.push(absolute);
    }
  }
  return results;
}

describe("email provider source and E2E contracts", () => {
  it("routes every active server-side Nodemailer call through one boundary", () => {
    const active = sourceFiles(join(ROOT, "apps/api")).filter(
      (file) => !file.includes("/src/__tests__/"),
    );
    const providerFile = join(ROOT, "apps/api/src/lib/email-provider.ts");
    const nodemailerUsers = active.filter((file) =>
      /(?:from ["']nodemailer["']|createTransport\()/u.test(
        readFileSync(file, "utf8"),
      ),
    );
    expect(nodemailerUsers).toEqual([providerFile]);

    const messaging = source("apps/api/src/lib/messaging.ts");
    const notifications = source("apps/api/src/lib/notifications.ts");
    expect(messaging).toContain("sendEmailThroughProvider(");
    expect(notifications).toContain('from "@/lib/messaging"');
    expect(notifications).toContain("sendEmailMessage(");
    expect(notifications).toContain("sendSmsMessage(");
    expect(notifications).not.toMatch(/nodemailer|createTransport|sendMail\(/u);
    expect(notifications).not.toContain('process.env["TWILIO_API_BASE_URL"]');
    expect(notifications).not.toMatch(
      /console\.(?:info|warn|error)\([^)]*\{[^}]*(?:\bto\b|\bbody\b|\btext\b|\.\.\.context)/su,
    );
  });

  it("bounds config, messages, recipients, attachments, time, and delivery certainty", () => {
    const provider = source("apps/api/src/lib/email-provider.ts");
    for (const contract of [
      "MAX_RECIPIENTS = 10",
      "MAX_SUBJECT_BYTES = 998",
      "MAX_TEXT_BYTES = 256 * 1024",
      "MAX_ATTACHMENT_COUNT = 4",
      "MAX_ESTIMATED_WIRE_BYTES = 512 * 1024",
      "Math.ceil(contentBytes / 3) * 4",
      "MAX_TIMEOUT_MS = 30_000",
      "connectionTimeout: configuration.timeoutMs",
      "greetingTimeout: configuration.timeoutMs",
      "socketTimeout: configuration.timeoutMs",
      "disableFileAccess: true",
      "disableUrlAccess: true",
      'deliveryCertainty: "ambiguous"',
      'detail: "email_partial_acceptance"',
      'Buffer.byteLength(value, "utf8") > 512',
      "sanitizeEmailProviderMessageId(info.messageId)",
      "accepted.length > 0",
    ]) {
      expect(provider).toContain(contract);
    }
  });

  it("wires the loopback fake, health/reset, and safe E2E configuration", () => {
    const compose = source("devops/docker-compose.yml");
    expect(compose).toContain("email-fake:");
    expect(compose).toContain("context: ./email-fake");
    expect(compose).toContain('"127.0.0.1:${EMAIL_FAKE_HTTP_PORT:-4016}:4016"');
    expect(source("devops/email-fake/Dockerfile")).toContain("USER node");
    for (const environmentFile of [
      ".env.e2e",
      "apps/api/.env.e2e.local",
      "apps/site/.env.e2e.local",
    ]) {
      expect(source(environmentFile)).toContain(
        "EMAIL_FAKE_CONTROL_URL=http://127.0.0.1:4016",
      );
    }
    expect(source("tests/e2e/global-setup.ts")).toContain("resetEmailFake()");
    expect(source("tests/e2e/audit/global-setup.ts")).toContain(
      "resetEmailFake()",
    );
    expect(source("scripts/wait-for-e2e-services.ts")).toContain(
      "waitForEmailFake()",
    );
  });

  it("retains only bounded metadata and never emits sensitive email data", () => {
    const fake = source("devops/email-fake/server.mjs");
    expect(fake).toContain("MAX_CAPTURED_REQUESTS = 100");
    expect(fake).toContain("MAX_MESSAGE_BYTES = 512 * 1024");
    expect(fake).toContain("resetGeneration += 1");
    expect(fake).toContain(
      "for (const socket of openSockets) socket.destroy()",
    );
    expect(fake).toContain('process.env["EMAIL_FAKE_FORWARD_SMTP_HOST"]');
    expect(fake).toContain("isApprovedForwardHost(forwardHost)");
    expect(fake).not.toMatch(
      /capturedRequests\.(?:push|unshift)\([^)]*(?:message|subject|recipient|sender|token|url|suffix)/isu,
    );
    expect(fake).not.toMatch(/console\.(?:log|info|warn|error)/u);
    expect(fake).not.toContain("request.headers.authorization");
  });

  it("prevents legacy outbox retries after ambiguous email delivery", () => {
    const outbox = source("apps/api/src/lib/outbox-processor.ts");
    expect(outbox).toContain("buildLegacyOutboxProviderRequestKey({");
    expect(outbox).toContain("idempotencyKey: legacyProviderRequestKey");
    expect(outbox).toContain("SMTP is not exactly-once");
    expect(outbox).toContain('result.deliveryCertainty !== "uncertain" &&');
  });
});
