import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const REPOSITORY_ROOT = resolve(process.cwd(), "../..");
const WEBHOOK_ROOT = join(REPOSITORY_ROOT, "apps/api/app/api/webhooks/twilio");

function read(relativePath: string): string {
  return readFileSync(join(REPOSITORY_ROOT, relativePath), "utf8");
}

function exportedMethodBody(source: string, method: "GET" | "POST"): string {
  const marker = `export async function ${method}`;
  const start = source.indexOf(marker);
  if (start < 0) return "";
  const nextExport = source.indexOf(
    "export async function ",
    start + marker.length,
  );
  return source.slice(start, nextExport < 0 ? source.length : nextExport);
}

describe("Twilio webhook route authentication manifest", () => {
  const expected = {
    "call-status": ["POST"],
    connect: ["GET", "POST"],
    "dial-action": ["POST"],
    escalate: ["GET", "POST"],
    notice: ["GET", "POST"],
    sms: ["POST"],
    voice: ["POST"],
  } as const;

  it("accounts for every Twilio route and every exported HTTP method", () => {
    const routeNames = readdirSync(WEBHOOK_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(routeNames).toEqual(Object.keys(expected).sort());

    for (const [routeName, methods] of Object.entries(expected)) {
      const source = read(
        `apps/api/app/api/webhooks/twilio/${routeName}/route.ts`,
      );
      const exported = [
        ...source.matchAll(/export async function (GET|POST)/gu),
      ]
        .map((match) => match[1])
        .sort();
      expect(exported).toEqual([...methods].sort());
    }
  });

  it("verifies every method before it can call a route handler or inspect data", () => {
    for (const [routeName, methods] of Object.entries(expected)) {
      const source = read(
        `apps/api/app/api/webhooks/twilio/${routeName}/route.ts`,
      );
      expect(source).toContain("verifyTwilioWebhookRequest");
      expect(source).toContain('from "@/lib/twilio-webhook-auth"');

      for (const method of methods) {
        const body = exportedMethodBody(source, method);
        const verification = body.indexOf(
          "await verifyTwilioWebhookRequest(request)",
        );
        const failureReturn = body.indexOf(
          "if (!verified.ok) return verified.response",
        );
        expect(verification).toBeGreaterThanOrEqual(0);
        expect(failureReturn).toBeGreaterThan(verification);

        for (const sideEffectMarker of [
          "handleVerifiedRequest(",
          "request.nextUrl",
          "getDb(",
          "recordInboundMessage(",
          "getCompanyProfilePolicy(",
        ]) {
          const sideEffect = body.indexOf(sideEffectMarker);
          if (sideEffect >= 0)
            expect(sideEffect).toBeGreaterThan(failureReturn);
        }
      }
    }
  });

  it("centralizes body parsing and never trusts request host headers", () => {
    const routes = Object.keys(expected).map((routeName) =>
      read(`apps/api/app/api/webhooks/twilio/${routeName}/route.ts`),
    );
    const combined = routes.join("\n");

    expect(combined).not.toContain("request.formData(");
    expect(combined).not.toContain("x-forwarded-host");
    expect(combined).not.toContain('headers.get("host")');
    expect(combined).not.toContain("resolveFallbackOrigin");
  });

  it("parses a strictly bounded signed media count before SMS persistence", () => {
    const sms = read("apps/api/app/api/webhooks/twilio/sms/route.ts");
    const verified = sms.indexOf("if (!verified.ok) return verified.response");
    const boundedMedia = sms.indexOf("parseTwilioInboundMedia(formData)");
    const persistence = sms.indexOf("recordInboundMessage({");
    expect(verified).toBeGreaterThan(-1);
    expect(boundedMedia).toBeGreaterThan(verified);
    expect(persistence).toBeGreaterThan(boundedMedia);
    expect(sms).not.toContain("index < numMedia");
  });

  it("uses one XML 1.0-aware encoder for every dynamic TwiML value", () => {
    for (const routeName of ["connect", "dial-action", "escalate", "notice"]) {
      const route = read(
        `apps/api/app/api/webhooks/twilio/${routeName}/route.ts`,
      );
      expect(route).toContain('from "@/lib/twilio-xml"');
      expect(route).toContain("escapeTwilioXmlText(");
      expect(route).not.toContain("function escapeXml(");
    }
  });

  it("uses the same exact public base for generated callbacks and readiness", () => {
    const startCall = read("apps/api/app/api/admin/calls/start/route.ts");
    const outbox = read("apps/api/src/lib/outbox-processor.ts");
    const readiness = read("apps/api/src/lib/readiness.ts");
    const runtimeSafety = read("tests/e2e/audit/runtime-safety.ts");
    const e2eEnvironment = read(".env.e2e");
    const render = read("render.yaml");

    expect(startCall).toContain("getTwilioWebhookPublicBaseUrl()");
    expect(outbox).toContain("getTwilioWebhookPublicBaseUrl()");
    expect(readiness).toContain("getTwilioWebhookPublicBaseUrl(environment)");
    expect(readiness).toContain(
      "inspectTwilioProviderConfiguration(environment)",
    );
    expect(runtimeSafety).toContain('"TWILIO_WEBHOOK_PUBLIC_BASE_URL"');
    expect(e2eEnvironment).toContain(
      "TWILIO_WEBHOOK_PUBLIC_BASE_URL=http://localhost:3001",
    );
    expect(render.match(/key: TWILIO_WEBHOOK_PUBLIC_BASE_URL/gu)).toHaveLength(
      2,
    );
  });

  it("keeps unauthenticated rejection evidence privacy-safe", () => {
    const auth = read("apps/api/src/lib/twilio-webhook-auth.ts");
    const rejection = auth.slice(
      auth.indexOf("function rejectionResponse"),
      auth.indexOf("function exactExternalUrl"),
    );
    expect(rejection).toContain("safeRoutePath(request)");
    expect(rejection).not.toContain("request.url,");
    expect(rejection).not.toContain("request.headers");
    expect(rejection).not.toContain("formData");
    expect(rejection).not.toContain("authToken");
  });
});
