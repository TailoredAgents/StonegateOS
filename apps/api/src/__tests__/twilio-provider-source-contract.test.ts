import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const REPOSITORY_ROOT = resolve(process.cwd(), "../..");

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

function read(relativePath: string): string {
  return readFileSync(join(REPOSITORY_ROOT, relativePath), "utf8");
}

describe("Twilio provider source and E2E contracts", () => {
  it("makes every production Twilio HTTP caller configurable", () => {
    const roots = ["apps/api", "apps/site", "scripts"].map((directory) =>
      join(REPOSITORY_ROOT, directory),
    );
    const productionSources = roots
      .flatMap(sourceFiles)
      .filter((file) => !file.includes("/__tests__/"));
    const callers = productionSources.filter((file) =>
      readFileSync(file, "utf8").includes("https://api.twilio.com"),
    );

    expect(
      callers.map((file) => file.replace(`${REPOSITORY_ROOT}/`, "")),
    ).toEqual([]);

    for (const relativePath of [
      "apps/api/src/lib/messaging.ts",
      "apps/api/src/lib/twilio-calls.ts",
      "apps/api/src/lib/twilio-recordings.ts",
      "apps/api/src/lib/outbox-processor.ts",
    ]) {
      const source = read(relativePath);
      expect(source).not.toContain('process.env["TWILIO_API_BASE_URL"]');
      expect(source).not.toContain("https://api.twilio.com");
    }
    expect(read("packages/sdk/src/index.ts")).toContain(
      'export * from "./twilio-provider"',
    );
  });

  it("wires the loopback-only fake and its readiness control into E2E", () => {
    const compose = read("devops/docker-compose.yml");
    expect(compose).toContain("twilio-mock:");
    expect(compose).toContain("context: ./twilio-mock");
    expect(compose).toContain("HOST=0.0.0.0");
    expect(compose).toContain('"127.0.0.1:${TWILIO_HTTP_PORT:-4010}:4010"');

    for (const envFile of [".env.e2e", "apps/api/.env.e2e.local"]) {
      const environment = read(envFile);
      expect(environment).toContain(
        "TWILIO_API_BASE_URL=http://localhost:4010",
      );
      expect(environment).toContain(
        "TWILIO_FAKE_CONTROL_URL=http://localhost:4010",
      );
    }

    const waitScript = read("scripts/wait-for-e2e-services.ts");
    expect(waitScript).toContain("waitForTwilioFake");
    expect(waitScript).toContain("controlBase.origin !== providerBase.origin");
    expect(waitScript).toContain("assertSafeAuditRuntimeEnvironment");
    expect(read(".env.example")).toContain("TWILIO_FAKE_CONTROL_URL=");
    expect(read("devops/twilio-mock/README.md")).toContain(
      "Request evidence is capped at 100 entries",
    );

    const e2eSupport = read("tests/e2e/support/twilio.ts");
    expect(e2eSupport).toContain("setTwilioFakeScenario");
    expect(e2eSupport).toContain("/__control/reset");
    expect(e2eSupport).toContain("/__control/requests");
  });

  it("keeps fake request evidence bounded and privacy-safe", () => {
    const fake = read("devops/twilio-mock/server.mjs");
    expect(fake).toContain("MAX_CAPTURED_REQUESTS = 100");
    expect(fake).toContain('const host = process.env["HOST"] === "0.0.0.0"');
    expect(fake).toContain("authorization:");
    expect(fake).toContain(
      'request.headers.authorization.startsWith("Basic ")',
    );
    expect(fake).toContain("messageLength:");
    expect(fake).toContain("accountSidHash:");
    expect(fake).toContain("toHash:");
    expect(fake).toContain("fromHash:");
    expect(fake).not.toContain("accountSidSuffix:");
    expect(fake).not.toContain("toSuffix:");
    expect(fake).not.toContain("fromSuffix:");
    const captureSection = fake.slice(
      fake.indexOf("function captureProviderRequest"),
      fake.indexOf("async function readJsonControl"),
    );
    expect(captureSection).not.toContain("body: form");
    expect(fake).not.toContain("console.info(rawBody");
    expect(fake).not.toContain("console.info(form");
    expect(fake).not.toContain('{ sid, status: "queued" }');
    expect(read("tests/e2e/support/twilio.ts")).toContain(
      "signTwilioWebhookRequest",
    );
  });

  it("keeps recording unavailability distinct and never logs provider identifiers or raw bodies", () => {
    const provider = read("apps/api/src/lib/twilio-provider.ts");
    const recordings = read("apps/api/src/lib/twilio-recordings.ts");
    const outbox = read("apps/api/src/lib/outbox-processor.ts");
    const persistence = read("apps/api/src/lib/call-recording-persistence.ts");
    const deleteStart = outbox.indexOf('case "call.recording.delete"');
    const deleteEnd = outbox.indexOf('case "message.received"', deleteStart);
    const deleteBranch = outbox.slice(deleteStart, deleteEnd);
    const processStart = outbox.indexOf('case "call.recording.process"');
    const processEnd = outbox.indexOf('case "call.recording.delete"');
    const processBranch = outbox.slice(processStart, processEnd);

    expect(provider).not.toContain("console.");
    expect(recordings).not.toContain("console.");
    expect(recordings).not.toContain("return []");
    expect(provider).not.toContain("response.text(");
    expect(provider).not.toContain("response.json(");
    expect(provider).not.toContain("response.arrayBuffer(");
    expect(processBranch).toContain("if (!recordingList.ok)");
    expect(processBranch).toContain("claimRecordingProcessingLease({");
    expect(
      processBranch.indexOf("claimRecordingProcessingLease({"),
    ).toBeLessThan(processBranch.indexOf("listTwilioRecordingsForCall("));
    expect(processBranch).toContain("deferRecordingProcessingLease({");
    expect(processBranch).toContain(
      'error: "recording_processing_lease_active"',
    );
    expect(processBranch).toContain("recordVerifiedEmptyRecordingPoll({");
    expect(processBranch).toContain("leaseToken");
    expect(processBranch).toContain("skipFinalization: true");
    expect(processBranch).toContain("persistSkippedRecordingProcessing({");
    expect(processBranch).toContain("persistAnalyzedRecording({");
    expect(persistence).toContain('action: "call.recording.absent"');
    expect(persistence).toContain("nextVerifiedRecordingPollAt(now)");
    expect(persistence).toContain("recordingProcessingLeaseToken");
    expect(persistence).toContain("lockRecordingProcessingLease(");
    expect(persistence).toContain("completeRecordingProcessingEvent(");
    expect(persistence).toContain(
      'action: "call.recording.processing_skipped"',
    );
    expect(processBranch).toContain('reason: "transcription_not_configured"');
    expect(persistence).toContain("deletionQueued: true");
    expect(processBranch).toContain(
      'deferLease("recording_list_inconsistent")',
    );
    expect(deleteBranch).toContain("if (!deletion.ok)");
    expect(persistence).toContain("recordingDeleteIdentityMatches(");
    expect(persistence).toContain("recording_delete_identity_conflict");
    expect(persistence).not.toContain("expectedUpdatedAt");
    expect(persistence).not.toContain("eq(callRecords.updatedAt, input.target");
    expect(deleteBranch).not.toContain("attempts >=");
    expect(deleteBranch).not.toContain("call.recording.delete.failed");
    expect(outbox).toContain('event.type.startsWith("call.recording.")');
    for (const model of [
      read("apps/api/src/lib/call-analysis.ts"),
      read("apps/api/src/lib/call-coaching.ts"),
    ]) {
      expect(model).toContain(
        "AbortSignal.timeout(CALL_AI_REQUEST_TIMEOUT_MS)",
      );
    }
  });

  it("keeps Twilio credentials and browser media handling inside bounded adapters", () => {
    const appointmentMedia = read("apps/api/src/lib/appointment-media.ts");
    const inboxMedia = read(
      "apps/api/app/api/admin/inbox/messages/[messageId]/media/[index]/route.ts",
    );
    const siteProxy = read(
      "apps/site/src/app/api/team/inbox/media/[messageId]/[index]/route.ts",
    );
    expect(appointmentMedia).toContain("fetchTwilioProviderMedia(");
    expect(appointmentMedia).not.toContain('process.env["TWILIO_AUTH_TOKEN"]');
    expect(inboxMedia).toContain("fetchTwilioProviderMedia(");
    expect(inboxMedia).toContain("buildSafeBrowserMediaResponse(");
    expect(inboxMedia).not.toContain("Authorization");
    expect(inboxMedia).not.toContain("upstream.text(");
    expect(siteProxy).toContain('"content-disposition"');
    expect(siteProxy).toContain('"x-content-type-options"');
  });

  it("keeps new legacy-escalation callback URLs opaque and logs only bounded state", () => {
    const outbox = read("apps/api/src/lib/outbox-processor.ts");
    const start = outbox.indexOf('case "sales.escalation.call"');
    const end = outbox.indexOf('case "sales.queue.nudge.sms"', start);
    const branch = outbox.slice(start, end);
    expect(branch).toContain('searchParams.set("eventKey", event.id)');
    expect(branch).toContain('"operationKey"');
    expect(branch).toContain("prepared.operation.providerRequestKey");
    for (const key of ["to", "taskId", "contactId", "name"]) {
      expect(branch).not.toContain(`searchParams.set("${key}"`);
    }
    expect(branch).not.toContain("response.text(");
    expect(branch).not.toContain("detail: result.detail");
  });
});
