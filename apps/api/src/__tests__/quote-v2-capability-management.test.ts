import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "../..");

function source(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

describe("Quote V2 capability management", () => {
  it("makes the previous signer link read-only and persists only the new hash", () => {
    const service = source(
      "apps/api/src/lib/quote-v2-capability-management.ts",
    );
    expect(service).toContain('status: "superseded"');
    expect(service).toContain('allowedActions: ["view", "pdf"]');
    expect(service).toContain("tokenHash: capability.tokenHash");
    expect(service).toContain("rawToken: capability.token");
    expect(service).not.toContain("rawToken: capability.tokenHash");
    expect(service).toContain('eventType: "quote.capability_replaced"');
  });

  it("stores an idempotent receipt without the one-time bearer URL", () => {
    const route = source("apps/api/src/lib/quote-v2-capability-route.ts");
    const storedStart = route.indexOf("const storedResult");
    const completion = route.indexOf(
      "await completeTeamMutationIdempotency",
      storedStart,
    );
    const rawStart = route.indexOf("const href = new URL", completion);
    expect(storedStart).toBeGreaterThan(0);
    expect(completion).toBeGreaterThan(storedStart);
    expect(rawStart).toBeGreaterThan(completion);
    expect(route.slice(storedStart, completion)).toContain(
      "oneTimeLinkAvailable: false",
    );
    expect(route.slice(storedStart, completion)).not.toContain("rawToken");
    expect(route).toContain('requiredPermissions: ["quotes.send"]');
    expect(route).toContain("requiresIdempotency: true");
  });

  it("allows the authenticated site bridge to forward only the expected replacement link shape", () => {
    const bff = source(
      "apps/site/src/app/api/team/quotes/v2/[...segments]/route.ts",
    );
    expect(bff).toContain('allowsOneTimeCapability: action === "replace"');
    expect(bff).toContain("isExpectedOneTimeCapabilityResponse(payload)");
    expect(bff).toContain('oneTimeLink["recipientRole"] !== "signer"');
    expect(bff).toContain("containsCustomerSecret(valueWithoutLink)");
    expect(bff).toContain('permission: "quotes.send"');
  });

  it("keeps staff detail useful without exposing hashes, URLs, or raw tokens", () => {
    const management = source("apps/api/src/lib/quote-v2-management.ts");
    expect(management).toContain("capabilities: capabilities.map");
    for (const forbidden of [
      "tokenHash: quoteCapabilities",
      "recipientAddressHash:",
    ]) {
      expect(management).not.toContain(forbidden);
    }
  });
});
