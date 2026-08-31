import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "../..");

describe("partner portal session validation", () => {
  it("throttles last-seen writes while preserving a lock-safe revocation check", () => {
    const source = readFileSync(
      join(ROOT, "apps/api/src/lib/partner-portal-auth.ts"),
      "utf8",
    );

    expect(source).toContain(
      "const PARTNER_SESSION_LAST_SEEN_TOUCH_MS = 5 * 60 * 1000",
    );
    expect(source).toContain("const shouldTouchLastSeen =");
    expect(source).toContain('.for("share")');
    expect(source).toContain(
      "eq(partnerSessions.securityVersion, userRow.securityVersion)",
    );
    expect(source).not.toContain(
      '.where(eq(partnerUsers.id, sessionHint.partnerUserId))\n      .for("update")',
    );
  });
});
