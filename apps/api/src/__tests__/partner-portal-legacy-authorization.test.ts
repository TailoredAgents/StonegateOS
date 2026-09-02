import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function route(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("legacy partner route containment", () => {
  it.each([
    ["me", "app/api/portal/me/route.ts", "../v2/session/route"],
    ["properties", "app/api/portal/properties/route.ts", "../v2/locations/route"],
    ["bookings", "app/api/portal/bookings/route.ts", "../v2/jobs/route"],
    ["rates", "app/api/portal/rates/route.ts", "../v2/service-catalog/route"],
  ])(
    "%s delegates reads to the canonical account-scoped V2 projection",
    (_label, path, successor) => {
      const source = route(path);
      expect(source).toContain(successor);
      expect(source).not.toContain("adaptPartnerPrincipalToLegacySession");
      expect(source).not.toContain("orgContactId");
    },
  );

  it.each([
    "app/api/portal/bookings/route.ts",
    "app/api/portal/bookings/[appointmentId]/cancel/route.ts",
    "app/api/portal/properties/route.ts",
  ])("permanently retires the V1 writer in %s", (path) => {
    const source = route(path);
    expect(source).toContain('error: "legacy_route_retired"');
    expect(source).toContain("status: 410");
    expect(source).not.toContain("queueSystemOutboundMessage");
    expect(source).not.toContain("partnerUsers.phoneE164");
  });

  it("permanently retires the unbounded contact-authorized password writer", () => {
    const source = route("app/api/portal/password/route.ts");
    expect(source).toContain('error: "legacy_route_retired"');
    expect(source).toContain('status: 410');
    expect(source).toContain("/api/portal/v2/security/password");
    expect(source).not.toContain("setPartnerPassword");
  });
});
