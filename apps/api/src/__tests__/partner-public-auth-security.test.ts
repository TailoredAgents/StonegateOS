import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "../..");

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

describe("public partner authentication containment", () => {
  it("bounds and strictly parses every public partner authentication body", () => {
    for (const route of ["request-link", "login-password", "exchange"]) {
      const source = read(`apps/api/app/api/public/partners/${route}/route.ts`);
      expect(source).toContain("readBoundedJsonRequest(request");
      expect(source).toContain('"Cache-Control": "no-store"');
      expect(source).not.toContain("await request.json()");
    }
  });

  it("rate-limits link and password attempts by durable IP and identity buckets", () => {
    const limiter = read("apps/api/src/lib/team-auth-rate-limit.ts");
    const requestLink = read(
      "apps/api/app/api/public/partners/request-link/route.ts",
    );
    const password = read(
      "apps/api/app/api/public/partners/login-password/route.ts",
    );
    expect(limiter).toContain("partner_request_link: {");
    expect(limiter).toContain("partner_password_login: {");
    expect(requestLink).toContain('action: "partner_request_link"');
    expect(password).toContain('action: "partner_password_login"');
    expect(requestLink).toContain('error: "rate_limited"');
    expect(password).toContain('error: "rate_limited"');
  });

  it("does not send acknowledgement messages to unrecognized recipients", () => {
    const source = read(
      "apps/api/app/api/public/partners/request-link/route.ts",
    );
    expect(source).not.toContain("Partner Portal request received");
    expect(source).not.toContain("Stonegate: request received");
    expect(source).not.toContain("sendEmailMessage(email,");
    expect(source).not.toContain("sendSmsMessage(phoneE164,");
    expect(source).toContain("sendEmailMessage(prepared!.user.email");
    expect(source).toContain("idempotencyKey:");
  });

  it("uses the shared durable access-link ledger before calling providers", () => {
    const source = read(
      "apps/api/app/api/public/partners/request-link/route.ts",
    );
    const prepare = source.indexOf("preparePublicPartnerLoginLink(");
    const dispatched = source.indexOf("markPublicPartnerLoginLinkDispatched(");
    const email = source.indexOf("sendEmailMessage(prepared!.user.email");
    expect(prepare).toBeGreaterThan(-1);
    expect(dispatched).toBeGreaterThan(prepare);
    expect(email).toBeGreaterThan(dispatched);
    expect(source).toContain('operationKind: "public_login_link"');
    expect(source).toContain('initiatorType: "public_request"');
    expect(source).toContain(
      "isPartnerInviteUnresolvedState(unresolved.state)",
    );
    expect(source).toContain("planPartnerInviteTerminal(");
    expect(source).toContain('getTeamOperationKillSwitchForRisk("external")');
  });
});
